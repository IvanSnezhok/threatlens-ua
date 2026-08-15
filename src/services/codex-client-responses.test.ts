import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The Responses-API transport, which is what the real ChatGPT Codex backend speaks.
 *
 * A separate file from `codex-client.test.ts` for one mechanical reason: the transport is chosen
 * from `CODEX_BASE_URL`, which is parsed into `config` at import time, and vitest gives each test
 * file its own module graph. This file boots the client against the ChatGPT-shaped base URL; the
 * sibling file keeps the OpenAI-compatible one, so both transports stay exercised.
 */

process.env.CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
process.env.CODEX_API_KEY = '';
process.env.CODEX_MODEL = '';

const { codexChat, listCodexModels } = await import('./codex-client.js');
type AiRunRecord = Parameters<NonNullable<Parameters<typeof codexChat>[1]['audit']>>[0];

const TOKEN = 'sk-super-secret-access-token';

const credentials = async () => ({ accessToken: TOKEN, accountId: 'acct-42' });
const settings = async () => ({
  model: 'gpt-5.2' as string | null,
  effort: 'medium' as const,
  serviceTier: 'priority' as const,
  features: { narrative: true, digest: true, attacks: true },
  updatedAt: null,
  effectiveModel: 'gpt-5.2' as string | null,
  modelSource: 'stored' as const
});

let runs: AiRunRecord[] = [];
const audit = async (row: AiRunRecord) => { runs.push(row); };
beforeEach(() => { runs = []; });

function sse(events: unknown[], status = 200): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n`).join('\n') + '\ndata: [DONE]\n\n';
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

function completedEvent(text: string): unknown {
  return {
    type: 'response.completed',
    response: {
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
      ]
    }
  };
}

const request = {
  promptVersion: 'test-v1',
  surface: 'narrative' as const,
  system: 'system prompt',
  user: '{"facts":1}',
  json: true
};

describe('the request the ChatGPT backend accepts', () => {
  it('POSTs a streamed, stored:false Responses call to /responses', async () => {
    let url = '';
    let init: RequestInit | undefined;
    const result = await codexChat(request, {
      credentials, settings, audit,
      fetchImpl: async (input, requestInit) => { url = String(input); init = requestInit; return sse([completedEvent('{"ok":true}')]); }
    });

    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    const body = JSON.parse(String(init?.body));
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.model).toBe('gpt-5.2');
    expect(body.input).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '{"facts":1}' }] }]);
    // The knobs this backend rejects must not be sent at all.
    expect(body.temperature).toBeUndefined();
    expect(body.response_format).toBeUndefined();
    // Швидкість виклику. `reasoning` вкладене, `service_tier` — верхнього рівня: це не симетрія, а
    // форма, яку приймає бекенд, і саме тому вона перевіряється, а не мається на увазі.
    expect(body.reasoning).toEqual({ effort: 'medium' });
    expect(body.service_tier).toBe('priority');
    expect(result).toMatchObject({ ok: true, content: '{"ok":true}' });
  });

  it('adds bounded image inputs using the Responses vision shape', async () => {
    let body = '';
    await codexChat({ ...request, images: [{ dataUrl: 'data:image/png;base64,AA==', detail: 'high' }] }, {
      credentials, settings, audit,
      fetchImpl: async (_input, init) => { body = String(init?.body); return sse([completedEvent('{}')]); }
    });
    expect(JSON.parse(body).input[0].content).toEqual([
      { type: 'input_text', text: '{"facts":1}' },
      { type: 'input_image', image_url: 'data:image/png;base64,AA==', detail: 'high' }
    ]);
  });

  it('speaks as the client whose id it borrowed', async () => {
    let init: RequestInit | undefined;
    await codexChat(request, {
      credentials, settings, audit,
      fetchImpl: async (_input, requestInit) => { init = requestInit; return sse([completedEvent('{}')]); }
    });
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['ChatGPT-Account-Id']).toBe('acct-42');
    expect(headers['OpenAI-Beta']).toBe('responses=experimental');
    expect(headers.originator).toBe('codex_cli_rs');
    expect(headers.Accept).toBe('text/event-stream');
  });

  it('moves the JSON contract into the instructions, where this backend can honour it', async () => {
    let body = '';
    await codexChat(request, {
      credentials, settings, audit,
      fetchImpl: async (_input, init) => { body = String(init?.body); return sse([completedEvent('{}')]); }
    });
    const instructions = String(JSON.parse(body).instructions);
    expect(instructions).toContain('system prompt');
    expect(instructions).toContain('валідним JSON');

    await codexChat({ ...request, json: false }, {
      credentials, settings, audit,
      fetchImpl: async (_input, init) => { body = String(init?.body); return sse([completedEvent('текст')]); }
    });
    expect(String(JSON.parse(body).instructions)).toBe('system prompt');
  });
});

describe('reading the stream', () => {
  it('prefers the completed response over the deltas and skips reasoning items', async () => {
    const result = await codexChat(request, {
      credentials, settings, audit,
      fetchImpl: async () => sse([
        { type: 'response.output_text.delta', delta: '{"ok":' },
        { type: 'response.output_text.delta', delta: 'true}' },
        completedEvent('{"ok":true,"from":"completed"}')
      ])
    });
    expect(result).toMatchObject({ ok: true, content: '{"ok":true,"from":"completed"}' });
    expect(runs[0]).toMatchObject({ status: 'success', model: 'gpt-5.2' });
  });

  it('falls back to the accumulated deltas when the stream died before the summary event', async () => {
    const result = await codexChat(request, {
      credentials, settings, audit,
      fetchImpl: async () => sse([
        { type: 'response.output_text.delta', delta: 'перша половина, ' },
        { type: 'response.output_text.delta', delta: 'друга половина' }
      ])
    });
    expect(result).toMatchObject({ ok: true, content: 'перша половина, друга половина' });
  });

  it('reports a refused generation as an endpoint error, with the model named in the audit row', async () => {
    const result = await codexChat(request, {
      credentials, settings, audit,
      fetchImpl: async () => sse([{ type: 'response.failed', response: { error: { message: 'quota exceeded' } } }])
    });
    expect(result).toMatchObject({ ok: false, reason: 'endpoint_error' });
    expect(result.ok ? '' : result.detail).toContain('quota exceeded');
    expect(runs[0]).toMatchObject({ status: 'failed', model: 'gpt-5.2' });
  });

  it('treats a body with no SSE events as an endpoint error rather than empty prose', async () => {
    const result = await codexChat(request, {
      credentials, settings, audit,
      fetchImpl: async () => new Response('<html>gateway</html>', { status: 200 })
    });
    expect(result).toMatchObject({ ok: false, reason: 'endpoint_error' });
  });

  it('still names an expired session when the backend rejects the credential', async () => {
    const result = await codexChat(request, {
      credentials, settings, audit,
      fetchImpl: async () => new Response('{"detail":"Unauthorized"}', { status: 401 })
    });
    expect(result).toMatchObject({ ok: false, reason: 'session_expired' });
  });

  it('never puts the token anywhere an operator can read it', async () => {
    const result = await codexChat(request, {
      credentials, settings, audit, fetchImpl: async () => sse([completedEvent('{"ok":true}')])
    });
    expect(JSON.stringify(runs)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe('the model catalogue against this backend', () => {
  it('goes straight to the static list without a network call: there is no /models to ask', async () => {
    let called = false;
    const catalogue = await listCodexModels({
      credentials, settings,
      fetchImpl: async () => { called = true; return new Response('{}', { status: 404 }); }
    });
    expect(called).toBe(false);
    expect(catalogue.source).toBe('fallback');
    expect(catalogue.models).toContain('gpt-5.2');
    expect(catalogue.error).toContain('не публікує');
  });
});

describe('the speed knobs travel with every call', () => {
  it('sends what the operator chose, not what the code defaults to', async () => {
    // `/ops` міняє effort і чергу під час події; якби клієнт брав їх лише тоді, коли модель не
    // задана явно, половина шляхів працювала б на старих значеннях і ніхто б цього не побачив.
    let body = '';
    await codexChat({ ...request, model: 'gpt-5.6-luna' }, {
      credentials, audit,
      settings: async () => ({
        model: 'gpt-5.6-luna' as string | null,
        effort: 'xhigh' as const,
        serviceTier: 'flex' as const,
        features: { narrative: true, digest: true, attacks: true },
        updatedAt: null,
        effectiveModel: 'gpt-5.6-luna' as string | null,
        modelSource: 'stored' as const
      }),
      fetchImpl: async (_input, init) => { body = String(init?.body); return sse([completedEvent('{}')]); }
    });
    const parsed = JSON.parse(body);
    // Модель прийшла від викликача, а швидкість — з налаштувань. Саме ця пара й ламалася раніше.
    expect(parsed.model).toBe('gpt-5.6-luna');
    expect(parsed.reasoning).toEqual({ effort: 'xhigh' });
    expect(parsed.service_tier).toBe('flex');
  });
});
