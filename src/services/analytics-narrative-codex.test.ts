import { describe, expect, it } from 'vitest';

/**
 * Provider selection when a Codex endpoint IS configured — the complement of the gate tests in
 * `analytics-narrative.test.ts`, which run with `CODEX_BASE_URL` empty and prove the switches alone
 * open nothing. A separate file because the base URL is parsed into `config` at import time.
 *
 * The property under test is the shape of the choice: the Codex provider names a model and nothing
 * else. No URL — the transport decision belongs to `codexChat`, which is what let the narrative
 * keep speaking `chat/completions` to a backend that never accepted it — and no headers, so a
 * credential cannot leak by being carried around in a provider object.
 */

process.env.CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
process.env.CODEX_API_KEY = '';
process.env.CODEX_MODEL = '';
process.env.ANALYTICS_NARRATIVE_ENABLED = 'false';

const { narrativeProvider } = await import('./analytics-narrative.js');

const TOKEN = 'sk-super-secret-access-token';

function settingsWith(narrative: boolean) {
  return async () => ({
    model: 'gpt-5.6-luna' as string | null,
    features: { narrative, digest: false, attacks: false },
    updatedAt: null,
    effectiveModel: 'gpt-5.6-luna' as string | null,
    modelSource: 'stored' as const
  });
}

describe('provider selection with a Codex endpoint configured', () => {
  it('offers the Codex provider as a model name and nothing else', async () => {
    const provider = await narrativeProvider({
      settings: settingsWith(true),
      credentials: async () => ({ accessToken: TOKEN, accountId: 'acct-42' })
    });
    expect(provider).toEqual({ kind: 'codex', model: 'gpt-5.6-luna' });
    // No baseUrl, no headers: nothing credential-shaped survives serialisation.
    expect(JSON.stringify(provider)).not.toContain(TOKEN);
    expect(JSON.stringify(provider)).not.toContain('http');
  });

  it('reads the switch as permission, and a missing session as absence of capability', async () => {
    const provider = await narrativeProvider({
      settings: settingsWith(true),
      credentials: async () => null
    });
    // `AI_*` is unset and `ANALYTICS_NARRATIVE_ENABLED` is off, so there is no second provider to
    // fall through to: the narrative stays deterministic rather than failing later at the endpoint.
    expect(provider).toBeNull();
  });

  it('offers nothing when the operator has not switched the narrative on', async () => {
    const provider = await narrativeProvider({
      settings: settingsWith(false),
      credentials: async () => ({ accessToken: TOKEN, accountId: 'acct-42' })
    });
    expect(provider).toBeNull();
  });

  it('survives a credential store that throws, as an absent session rather than an error', async () => {
    const provider = await narrativeProvider({
      settings: settingsWith(true),
      credentials: async () => { throw new Error('database is down'); }
    });
    expect(provider).toBeNull();
  });
});
