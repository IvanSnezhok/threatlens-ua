import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The client that stands between the analytics and a model that may not answer.
 *
 * Two properties are worth this much test code, and neither is visible by reading the happy path:
 *
 *  1. **Nothing throws.** Every caller — the narrative, the digest, the extrapolation note — is a
 *     surface that must finish without a model. A rejected promise anywhere here turns a missing
 *     paragraph into a failed analytics request, and the failure would arrive at three in the
 *     morning through a Telegram queue.
 *  2. **The token never leaves.** It goes into one header and nowhere else: not into the `ai_runs`
 *     row an operator later reads in the browser, not into the failure reason, not into the
 *     returned object. `ai_runs.input` is rendered verbatim in `/ops`, so a token that leaked into
 *     it would be a credential printed on a page.
 *
 * `CODEX_BASE_URL` has to exist before `../config.js` is parsed, which happens at import time, so
 * the module under test is imported dynamically after the environment is set. Every external edge
 * — network, credential store, settings row, audit sink — is injected, so this file touches neither
 * a socket nor PostgreSQL.
 */

process.env.CODEX_BASE_URL = 'https://codex.test/v1';
process.env.CODEX_API_KEY = '';
process.env.CODEX_MODEL = '';

const { codexChat, listCodexModels } = await import('./codex-client.js');
type AiRunRecord = Parameters<NonNullable<Parameters<typeof codexChat>[1]['audit']>>[0];

const TOKEN = 'sk-super-secret-access-token';

const credentials = async () => ({ accessToken: TOKEN, accountId: 'acct-42' });
const settings = async () => ({
  model: 'gpt-5.2' as string | null,
  features: { narrative: true, digest: true, attacks: true },
  updatedAt: null,
  effectiveModel: 'gpt-5.2' as string | null,
  modelSource: 'stored' as const
});

let runs: AiRunRecord[] = [];
const audit = async (row: AiRunRecord) => { runs.push(row); };
beforeEach(() => { runs = []; });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function completion(content: string): Response {
  return jsonResponse({ choices: [{ message: { content } }] });
}

const request = {
  promptVersion: 'test-v1',
  surface: 'narrative' as const,
  system: 'system prompt',
  user: '{"facts":1}',
  json: true
};

describe('a successful completion', () => {
  it('returns the content and records one successful run', async () => {
    const result = await codexChat(request, {
      credentials, settings, audit, fetchImpl: async () => completion('{"ok":true}')
    });

    expect(result).toMatchObject({ ok: true, content: '{"ok":true}', model: 'gpt-5.2' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'success', promptVersion: 'test-v1', model: 'gpt-5.2', error: null });
  });

  it('sends the bearer token and the account header, and asks for JSON when told to', async () => {
    let seen: RequestInit | undefined;
    let url = '';
    await codexChat(request, {
      credentials, settings, audit,
      fetchImpl: async (input, init) => { url = String(input); seen = init; return completion('{}'); }
    });

    expect(url).toBe('https://codex.test/v1/chat/completions');
    const headers = seen?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['ChatGPT-Account-Id']).toBe('acct-42');
    expect(JSON.parse(String(seen?.body)).response_format).toEqual({ type: 'json_object' });
  });

  it('omits response_format when the caller did not ask for JSON', async () => {
    let body = '';
    await codexChat({ ...request, json: false }, {
      credentials, settings, audit,
      fetchImpl: async (_input, init) => { body = String(init?.body); return completion('plain text'); }
    });
    expect(JSON.parse(body).response_format).toBeUndefined();
  });

  it('writes the caller-supplied digest to the audit log instead of the raw prompt', async () => {
    await codexChat({ ...request, auditInput: { totals: { events: 3 } } }, {
      credentials, settings, audit, fetchImpl: async () => completion('{}')
    });
    expect(runs[0]!.input).toEqual({ totals: { events: 3 } });
  });

  it('never puts the token anywhere an operator can read it', async () => {
    const result = await codexChat(request, {
      credentials, settings, audit, fetchImpl: async () => completion('{"ok":true}')
    });
    // The audit row is rendered verbatim in /ops and the result is passed on to callers; both are
    // serialised whole here so that a future field carrying the token fails this test rather than
    // appearing on a page.
    expect(JSON.stringify(runs)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe('failures, none of which throw', () => {
  it('names an expired session as such when the endpoint rejects the credential', async () => {
    const result = await codexChat(request, {
      credentials, settings, audit, fetchImpl: async () => jsonResponse({ error: 'invalid_token' }, 401)
    });
    expect(result).toMatchObject({ ok: false, reason: 'session_expired', model: 'gpt-5.2' });
    expect(runs[0]!.status).toBe('failed');
  });

  it('separates a server-side error from a dead session', async () => {
    const result = await codexChat(request, {
      credentials, settings, audit, fetchImpl: async () => jsonResponse({ error: 'boom' }, 500)
    });
    expect(result).toMatchObject({ ok: false, reason: 'endpoint_error' });
  });

  it('reports a network failure as transport, not as a model refusal', async () => {
    const result = await codexChat(request, {
      credentials, settings, audit,
      fetchImpl: async () => { throw new Error('fetch failed'); }
    });
    expect(result).toMatchObject({ ok: false, reason: 'transport_error' });
    expect(result.ok).toBe(false);
  });

  it('treats an empty completion as a failure rather than as empty prose', async () => {
    const result = await codexChat(request, {
      credentials, settings, audit, fetchImpl: async () => jsonResponse({ choices: [{ message: {} }] })
    });
    expect(result).toMatchObject({ ok: false, reason: 'endpoint_error' });
  });

  it('does not reach the network at all when there is no session', async () => {
    let called = false;
    const result = await codexChat(request, {
      credentials: async () => null, settings, audit,
      fetchImpl: async () => { called = true; return completion('{}'); }
    });
    expect(result).toMatchObject({ ok: false, reason: 'no_session' });
    expect(called).toBe(false);
    // Recorded even though nothing left the process: "the prose stopped three days ago" has to be
    // answerable from the audit log, and a call that never happened is the case that is otherwise
    // invisible.
    expect(runs).toHaveLength(1);
    expect(runs[0]!.model).toBe('gpt-5.2');
  });

  it('refuses to call when no model is selected anywhere', async () => {
    const result = await codexChat(request, {
      credentials, audit,
      settings: async () => ({
        model: null, features: { narrative: false, digest: false, attacks: false }, updatedAt: null,
        effectiveModel: null, modelSource: 'none' as const
      }),
      fetchImpl: async () => completion('{}')
    });
    expect(result).toMatchObject({ ok: false, reason: 'model_not_selected', model: null });
    expect(runs[0]!.model).toBe('unconfigured');
  });

  it('survives an audit sink that is itself broken', async () => {
    // The narrative that was just written is correct whether or not its audit row lands.
    const result = await codexChat(request, {
      credentials, settings, fetchImpl: async () => completion('{"ok":true}'),
      audit: async () => { throw new Error('database is down'); }
    });
    expect(result).toMatchObject({ ok: true, content: '{"ok":true}' });
  });

  it('honours an explicit model over the stored one', async () => {
    let body = '';
    await codexChat({ ...request, model: 'o5-mini' }, {
      credentials, settings, audit,
      fetchImpl: async (_input, init) => { body = String(init?.body); return completion('{}'); }
    });
    expect(JSON.parse(body).model).toBe('o5-mini');
  });
});

describe('the model catalogue', () => {
  it('reads the ids the service reports', async () => {
    const catalogue = await listCodexModels({
      credentials, settings,
      fetchImpl: async () => jsonResponse({ data: [{ id: 'gpt-5.2' }, { id: 'o5' }] })
    });
    expect(catalogue.source).toBe('api');
    expect(catalogue.models).toEqual(['gpt-5.2', 'o5']);
    expect(catalogue.error).toBeNull();
  });

  it('falls back to the static list, and says so, when the service will not answer', async () => {
    const catalogue = await listCodexModels({
      credentials, settings, fetchImpl: async () => jsonResponse({ error: 'nope' }, 503)
    });
    expect(catalogue.source).toBe('fallback');
    expect(catalogue.models).toContain('gpt-5.2');
    // The stored selection survives a failed catalogue read; a dropdown that lost it would read as
    // "your model is gone" rather than "the list could not be fetched".
    expect(catalogue.models).toContain('gpt-5.2');
    expect(catalogue.error).toContain('503');
  });

  it('falls back rather than throwing when the transport fails', async () => {
    const catalogue = await listCodexModels({
      credentials, settings, fetchImpl: async () => { throw new Error('ENOTFOUND'); }
    });
    expect(catalogue.source).toBe('fallback');
    expect(catalogue.error).toContain('ENOTFOUND');
  });

  it('falls back without a session instead of sending an unauthenticated request', async () => {
    let called = false;
    const catalogue = await listCodexModels({
      credentials: async () => null, settings,
      fetchImpl: async () => { called = true; return jsonResponse({ data: [] }); }
    });
    expect(called).toBe(false);
    expect(catalogue.source).toBe('fallback');
  });

  it('ignores entries that are not string ids', async () => {
    const catalogue = await listCodexModels({
      credentials, settings,
      fetchImpl: async () => jsonResponse({ data: [{ id: 42 }, { id: 'o5-mini' }, {}] })
    });
    expect(catalogue.models).toEqual(['o5-mini', 'gpt-5.2']);
  });
});
