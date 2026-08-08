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
    `INSERT INTO ai_runs(model,prompt_version,input,output,status,error,duration_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      row.model, row.promptVersion, JSON.stringify(row.input),
      row.output == null ? null : JSON.stringify(row.output),
      row.status, row.error == null ? null : row.error.slice(0, 800), row.durationMs
    ]
  ).catch(() => undefined);
}

function endpoint(path: string): string {
  return `${config.CODEX_BASE_URL.replace(/\/$/, '')}${path}`;
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
      output: null, status: 'failed', error: `${reason}: ${detail}`, durationMs
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

  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
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
  try {
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    content = body.choices?.[0]?.message?.content ?? undefined;
  } catch (error) {
    return fail('endpoint_error', `Відповідь не є JSON: ${String(error).slice(0, 200)}`, model);
  }
  if (!content) return fail('endpoint_error', 'Codex повернув порожню відповідь', model);

  const durationMs = Date.now() - started;
  await audit({
    model, promptVersion: request.promptVersion, input: auditInput, output: { content },
    status: 'success', error: null, durationMs
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
