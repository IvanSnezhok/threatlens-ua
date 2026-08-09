import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { codexCredentials, type CodexCredentials } from './codex-auth.js';
import {
  FALLBACK_CODEX_MODELS, mergeModelCatalogue, resolveCodexSettings, type ResolvedCodexSettings
} from './codex-settings.js';

/**
 * The one place that talks to the Codex chat endpoint.
 *
 * ================================================================================================
 * Why a client at all, when two callers already had their own fetch
 * ================================================================================================
 *
 * `analytics-narrative.ts` and `vector-projection.ts` each grew their own request, their own
 * timeout, their own `ai_runs` insert and their own idea of what a failure looks like. Three copies
 * of an audit write is the shape of bug where two of them get a new column and the third does not,
 * and the column that matters here is the one that says what the model was asked. Everything that
 * reaches Codex now goes through {@link codexChat}, so "every model call is recorded" is a property
 * of one function rather than a habit spread over a codebase.
 *
 * ================================================================================================
 * The token never appears in anything this module produces
 * ================================================================================================
 *
 * The access token is read here, put into an `Authorization` header, and forgotten. It is not in
 * the `ai_runs` row — `input` carries the prompt, never the headers — it is not in the returned
 * failure reason, and it is not in anything the routes serialise. Failure reasons are therefore
 * deliberately coarse: `endpoint 401`, not the response body, because a body is attacker-influenced
 * text that ends up in an operator's browser and in a database column that is read back out.
 *
 * ================================================================================================
 * Nothing here throws
 * ================================================================================================
 *
 * Every caller is a surface that is complete without a model. A refused call, an expired session,
 * an unreachable host and a malformed reply are all the same event from their point of view — "no
 * model text this time" — and each of them returns {@link CodexChatFailure} rather than raising.
 * The distinction that *is* preserved is the reason, because that is what an operator reads in the
 * console when the prose quietly stops appearing.
 */

export type CodexFailureReason =
  /** `CODEX_BASE_URL` is empty: a token with nowhere to send it. */
  | 'not_configured'
  /** Neither the settings nor `CODEX_MODEL` name a model. */
  | 'model_not_selected'
  /** No stored OAuth session and no `CODEX_API_KEY` — an operator has to sign in. */
  | 'no_session'
  /** The endpoint rejected the credential: the session died between the flag check and the call. */
  | 'session_expired'
  /** The endpoint answered, but not with something usable. */
  | 'endpoint_error'
  /** Timed out, DNS failed, connection refused. */
  | 'transport_error';

export interface CodexChatSuccess {
  ok: true;
  content: string;
  model: string;
  durationMs: number;
}

export interface CodexChatFailure {
  ok: false;
  reason: CodexFailureReason;
  /** Human-readable detail, safe to show an operator. Never contains a credential. */
  detail: string;
  model: string | null;
  durationMs: number;
}

export type CodexChatResult = CodexChatSuccess | CodexChatFailure;

export interface CodexChatRequest {
  /** Goes into `ai_runs.prompt_version`; it is what tells three callers apart in the audit log. */
  promptVersion: string;
  /**
   * Which feature spent this call.
   *
   * Required, not optional, on purpose. `prompt_version` is the transport-level discriminator and
   * has already drifted from the feature it names, and a nullable column filled in by three of four
   * writers is precisely the bug shape this file's header warns about: the fourth writer is the one
   * an operator goes looking for. Making the field required means every construction site moves in
   * the same commit or the build does not pass.
   */
  surface: 'narrative' | 'digest' | 'attacks' | 'shadow' | 'risk' | 'retrospective_gate';
  /** Recorded as `ai_runs.classifier_version` when the caller knows which rules produced its input. */
  classifierVersion?: string;
  system: string;
  user: string;
  /** Ask for a JSON object back. Callers that parse the reply should always set this. */
  json?: boolean;
  model?: string;
  timeoutMs?: number;
  /**
   * What to record as `ai_runs.input` instead of the raw messages.
   *
   * The callers already hold a structured digest of exactly the facts they put in the prompt, and
   * that digest is far more useful to read back than the serialised prompt string it was rendered
   * into. When omitted the messages themselves are recorded — never nothing.
   */
  auditInput?: unknown;
}

/**
 * Everything this module reaches outside itself, in one injectable bag.
 *
 * Not a testing convenience bolted on afterwards: the three things named here are the network, the
 * credential store and the database, which are exactly the three things a unit test must not touch
 * and exactly the three whose failure modes this module exists to absorb. Making them parameters
 * means the failure paths can be exercised deliberately rather than only in production.
 */
export interface CodexClientDeps {
  fetchImpl?: typeof fetch;
  /** The audit sink. Defaults to the `ai_runs` insert. */
  audit?: (row: AiRunRecord) => Promise<void>;
  credentials?: () => Promise<CodexCredentials | null>;
  settings?: () => Promise<ResolvedCodexSettings>;
}

export interface AiRunRecord {
  model: string;
  promptVersion: string;
  input: unknown;
  output: unknown;
  status: 'success' | 'failed';
  error: string | null;
  durationMs: number;
  /** The feature that spent the call, from {@link CodexChatRequest.surface}. */
  surface: string;
  classifierVersion: string | null;
  /**
   * `'skipped'` on every row this module writes: a transport makes no claim about whether the
   * answer's numbers were grounded. The caller writes its own `'rejected'` row when it refuses one.
   */
  validationStatus: 'passed' | 'rejected' | 'skipped' | null;
  fallbackReason: string | null;
}

/**
 * Records one attempt, and never lets the recording cost the caller its result.
 *
 * The insert is best-effort by design: the narrative that was just written is correct whether or not
 * its audit row lands, and failing the call because the log failed would turn a bookkeeping problem
 * into an outage on a path whose whole purpose is to degrade quietly.
 */
async function writeAiRun(row: AiRunRecord): Promise<void> {
  await pool.query(
    `INSERT INTO ai_runs(model,prompt_version,input,output,status,error,duration_ms,
                         surface,classifier_version,validation_status,fallback_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      row.model, row.promptVersion, JSON.stringify(row.input),
      row.output == null ? null : JSON.stringify(row.output),
      row.status, row.error == null ? null : row.error.slice(0, 800), row.durationMs,
      row.surface, row.classifierVersion, row.validationStatus, row.fallbackReason
    ]
  ).catch(() => undefined);
}

function endpoint(path: string): string {
  return `${config.CODEX_BASE_URL.replace(/\/$/, '')}${path}`;
}

/**
 * Which request shape the endpoint behind `CODEX_BASE_URL` expects.
 *
 * The ChatGPT Codex backend (`chatgpt.com/backend-api/codex`) accepts only the Responses API and
 * only as an SSE stream — a `chat/completions` POST there is a 404. An OpenAI-compatible proxy is
 * the mirror image. Neither side advertises which it is, so `auto` keys off the base URL, which is
 * the one fact the operator has already supplied.
 */
function transportFor(): 'chat' | 'responses' {
  if (config.CODEX_API_STYLE !== 'auto') return config.CODEX_API_STYLE;
  return config.CODEX_BASE_URL.includes('chatgpt.com/backend-api') ? 'responses' : 'chat';
}

/** Appended to the instructions on the Responses transport, which has no `response_format` knob. */
const JSON_ONLY_NOTE = 'Відповідай виключно одним валідним JSON-обʼєктом, без жодного тексту до або після нього.';

/**
 * Extracts the assistant text from a completed Responses-API response object.
 *
 * Reasoning models put `reasoning` items in `output` alongside the `message`; only the message
 * carries text meant for the caller, so everything else is skipped rather than concatenated.
 */
function responseOutputText(response: unknown): string {
  const output = (response as { output?: unknown })?.output;
  if (!Array.isArray(output)) return '';
  return output
    .filter((item): item is { type: string; content?: unknown } => (item as { type?: unknown })?.type === 'message')
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .filter((part): part is { type: string; text: string } =>
      (part as { type?: unknown })?.type === 'output_text' && typeof (part as { text?: unknown })?.text === 'string')
    .map((part) => part.text)
    .join('');
}

/**
 * Reads an SSE stream from the Codex backend down to one string.
 *
 * The whole body is buffered first: a narrative reply is a paragraph, not a transcript, and the
 * fetch-level `AbortSignal` already bounds how long the buffering may take. The final
 * `response.completed` object is preferred over the accumulated deltas because it is the server's
 * own statement of what the reply was; deltas are the fallback for a stream that died after the
 * text but before the summary event.
 */
async function readSseReply(response: Response): Promise<{ ok: true; content: string } | { ok: false; detail: string }> {
  const raw = await response.text();
  let deltas = '';
  let completed: string | null = null;
  let failure: string | null = null;
  let sawEvent = false;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let event: { type?: string; delta?: unknown; response?: unknown };
    try {
      event = JSON.parse(payload) as typeof event;
    } catch {
      continue;
    }
    sawEvent = true;
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') deltas += event.delta;
    if (event.type === 'response.completed') completed = responseOutputText(event.response);
    if (event.type === 'response.failed') {
      const message = (event.response as { error?: { message?: unknown } })?.error?.message;
      failure = typeof message === 'string' ? message.slice(0, 200) : 'модель повідомила про помилку';
    }
  }
  if (failure) return { ok: false, detail: `Codex перервав відповідь: ${failure}` };
  const content = completed || deltas;
  if (!sawEvent) return { ok: false, detail: 'відповідь не містить SSE-подій Responses API' };
  if (!content) return { ok: false, detail: 'Codex повернув порожню відповідь' };
  return { ok: true, content };
}

function authHeaders(session: CodexCredentials | null): Record<string, string> | null {
  // The stored session outranks `CODEX_API_KEY` for the same reason the narrative already preferred
  // it: both are bearer tokens for the same account, but only one of them can be renewed without a
  // human editing `.env`, so preferring the environment would mean going quiet at the first expiry
  // the refresh path exists to survive.
  const token = session?.accessToken || config.CODEX_API_KEY;
  if (!token) return null;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
  const accountId = session?.accountId || config.CODEX_ACCOUNT_ID;
  if (accountId) headers['ChatGPT-Account-Id'] = accountId;
  return headers;
}

/**
 * One chat completion, audited whatever happens.
 *
 * The pre-flight failures — not configured, no model, no session — are recorded too, under the model
 * name we would have used or `unconfigured`. That is on purpose: "the prose stopped three days ago"
 * is answered by the audit log or it is answered by guesswork, and a run that never left the process
 * is exactly the case an operator cannot otherwise see.
 */
export async function codexChat(request: CodexChatRequest, deps: CodexClientDeps = {}): Promise<CodexChatResult> {
  const started = Date.now();
  const audit = deps.audit ?? writeAiRun;
  const auditInput = request.auditInput ?? { system: request.system, user: request.user };

  const fail = async (reason: CodexFailureReason, detail: string, model: string | null): Promise<CodexChatFailure> => {
    const durationMs = Date.now() - started;
    await audit({
      model: model ?? 'unconfigured', promptVersion: request.promptVersion, input: auditInput,
      output: null, status: 'failed', error: `${reason}: ${detail}`, durationMs,
      surface: request.surface, classifierVersion: request.classifierVersion ?? null,
      // The same string the `error` column already carries, now in a column an operator can filter
      // on: «покажи все, що впало через таймаут» is a WHERE clause or it is a text search.
      validationStatus: 'skipped', fallbackReason: `${reason}: ${detail}`
    }).catch(() => undefined);
    return { ok: false, reason, detail, model, durationMs };
  };

  if (!config.CODEX_BASE_URL) {
    return fail('not_configured', 'CODEX_BASE_URL не задано', request.model ?? null);
  }

  let model = request.model?.trim() ?? '';
  if (!model) {
    const settings = await (deps.settings ?? resolveCodexSettings)();
    model = settings.effectiveModel ?? '';
  }
  if (!model) return fail('model_not_selected', 'Модель не обрано ні в /ops, ні в CODEX_MODEL', null);

  const session = await (deps.credentials ?? codexCredentials)().catch(() => null);
  const headers = authHeaders(session);
  if (!headers) return fail('no_session', 'Немає збереженої сесії Codex — потрібен вхід через /ops', model);

  const transport = transportFor();
  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    if (transport === 'responses') {
      // The shape the Codex CLI sends, minus the tooling: the backend requires `stream: true` and
      // answers SSE only, rejects sampling knobs like `temperature`, and has no `response_format` —
      // the JSON contract travels in the instructions instead. `originator` and `OpenAI-Beta` are
      // part of the same borrowed identity as `CODEX_OAUTH_CLIENT_ID`: this is the client the
      // service knows, so we speak as it does.
      response = await doFetch(endpoint('/responses'), {
        method: 'POST',
        headers: { ...headers, Accept: 'text/event-stream', 'OpenAI-Beta': 'responses=experimental', originator: 'codex_cli_rs' },
        body: JSON.stringify({
          model,
          instructions: request.json ? `${request.system}\n\n${JSON_ONLY_NOTE}` : request.system,
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: request.user }] }],
          tools: [],
          tool_choice: 'auto',
          parallel_tool_calls: false,
          store: false,
          stream: true,
          include: []
        }),
        signal: AbortSignal.timeout(request.timeoutMs ?? config.AI_TIMEOUT_MS)
      });
    } else {
      response = await doFetch(endpoint('/chat/completions'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          temperature: 0,
          ...(request.json ? { response_format: { type: 'json_object' } } : {}),
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user }
          ]
        }),
        signal: AbortSignal.timeout(request.timeoutMs ?? config.AI_TIMEOUT_MS)
      });
    }
  } catch (error) {
    // `String(error)` here is our own AbortError or an undici network error; neither carries the
    // request headers, so nothing credential-shaped can reach the audit row through this path.
    return fail('transport_error', String(error).slice(0, 300), model);
  }

  if (response.status === 401 || response.status === 403) {
    return fail('session_expired', `Codex відхилив облікові дані (${response.status})`, model);
  }
  if (!response.ok) {
    return fail('endpoint_error', `Codex відповів ${response.status}`, model);
  }

  let content: string | undefined;
  if (transport === 'responses') {
    // The stream is consumed inside the same try-shape as the JSON path: a connection that dies
    // mid-body surfaces as a rejected `text()`, which is a transport fault, not a model refusal.
    let reply: Awaited<ReturnType<typeof readSseReply>>;
    try {
      reply = await readSseReply(response);
    } catch (error) {
      return fail('transport_error', String(error).slice(0, 300), model);
    }
    if (!reply.ok) return fail('endpoint_error', reply.detail, model);
    content = reply.content;
  } else {
    try {
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      content = body.choices?.[0]?.message?.content ?? undefined;
    } catch (error) {
      return fail('endpoint_error', `Відповідь не є JSON: ${String(error).slice(0, 200)}`, model);
    }
    if (!content) return fail('endpoint_error', 'Codex повернув порожню відповідь', model);
  }

  const durationMs = Date.now() - started;
  await audit({
    model, promptVersion: request.promptVersion, input: auditInput, output: { content },
    status: 'success', error: null, durationMs,
    surface: request.surface, classifierVersion: request.classifierVersion ?? null,
    validationStatus: 'skipped', fallbackReason: null
  }).catch(() => undefined);
  return { ok: true, content, model, durationMs };
}

export interface CodexModelCatalogue {
  models: string[];
  source: 'api' | 'fallback';
  /** Why the service list was not used. Null when it was. */
  error: string | null;
}

/**
 * The models this installation may choose from.
 *
 * Asked of the service first, because a hard-coded list of model names starts rotting the day it is
 * written and an operator staring at a dropdown has no way to tell a stale entry from a live one.
 * When the service will not answer — no session yet, endpoint down, a shape we do not recognise —
 * the static list stands in and says so, so the console can show "перелік із запасного списку"
 * rather than silently offering four names as though they had been confirmed.
 */
export async function listCodexModels(deps: CodexClientDeps = {}): Promise<CodexModelCatalogue> {
  const settings = await (deps.settings ?? resolveCodexSettings)();
  const fallback = (error: string | null): CodexModelCatalogue => ({
    models: mergeModelCatalogue([], settings.model, config.CODEX_MODEL),
    source: 'fallback',
    error
  });

  if (!config.CODEX_BASE_URL) return fallback('CODEX_BASE_URL не задано');
  // The ChatGPT Codex backend has no `/models` catalogue; asking would 404 on every settings read.
  // The static list plus whatever is already selected is the entire truth available there.
  if (transportFor() === 'responses') return fallback('бекенд Codex не публікує перелік моделей');
  const session = await (deps.credentials ?? codexCredentials)().catch(() => null);
  const headers = authHeaders(session);
  if (!headers) return fallback('немає збереженої сесії Codex');

  try {
    const doFetch = deps.fetchImpl ?? fetch;
    const response = await doFetch(endpoint('/models'), {
      method: 'GET', headers, signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) return fallback(`Codex відповів ${response.status}`);
    const body = await response.json() as { data?: Array<{ id?: unknown }> };
    const ids = (body.data ?? [])
      .map((item) => item?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (!ids.length) return fallback('перелік моделей порожній');
    return { models: mergeModelCatalogue(ids, settings.model, config.CODEX_MODEL), source: 'api', error: null };
  } catch (error) {
    return fallback(String(error).slice(0, 200));
  }
}

export { FALLBACK_CODEX_MODELS };
