import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { accountIdFromIdToken, buildAuthorizeUrl, pkcePair } from './codex-auth.js';
import { config } from '../config.js';

/**
 * The parts of the sign-in that fail silently when they are wrong.
 *
 * A bad PKCE challenge, a redirect that differs from the registered one by a character, or a
 * missing account claim all surface the same way: an opaque rejection from the authorisation
 * server, hours after somebody changed something unrelated. None of it needs a database, a port or
 * a network, so all of it belongs here rather than in the integration suite.
 *
 * What is deliberately *not* asserted is that the client id and issuer are correct. They are the
 * Codex CLI's, we cannot verify them without an account, and a test that restated the constant
 * would only prove the constant had not been edited.
 */

function base64urlOf(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function idTokenWith(claims: unknown): string {
  const payload = base64urlOf(Buffer.from(JSON.stringify(claims), 'utf8'));
  return `header.${payload}.signature`;
}

describe('PKCE', () => {
  it('derives the challenge as the base64url SHA-256 of the verifier', () => {
    const { verifier, challenge } = pkcePair();
    expect(challenge).toBe(base64urlOf(createHash('sha256').update(verifier).digest()));
  });

  it('emits url-safe values with no padding', () => {
    const { verifier, challenge } = pkcePair();
    // '+', '/' and '=' survive a URL only when escaped, and an authorisation server that compares
    // the raw parameter would then see a different string than the one that was hashed.
    for (const value of [verifier, challenge]) expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never repeats a verifier', () => {
    const seen = new Set(Array.from({ length: 50 }, () => pkcePair().verifier));
    expect(seen.size).toBe(50);
  });
});

describe('authorisation URL', () => {
  const url = new URL(buildAuthorizeUrl('challenge-value', 'state-value'));

  it('asks for a code with S256, not plain', () => {
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(url.searchParams.get('state')).toBe('state-value');
  });

  it('sends the loopback redirect the Codex client accepts, and nothing else', () => {
    // The port belongs to the redirect the browser is told to return to, which is not the port this
    // application is served on. Reusing the app port here is the mistake this test exists to catch.
    expect(url.searchParams.get('redirect_uri'))
      .toBe(`http://${config.CODEX_OAUTH_REDIRECT_HOST}:${config.CODEX_OAUTH_REDIRECT_PORT}/auth/callback`);
  });

  it('requests offline access, so the session can outlive the first token', () => {
    expect(url.searchParams.get('scope')).toContain('offline_access');
  });

  it('asks for the organisation claim the account header is read from', () => {
    expect(url.searchParams.get('id_token_add_organizations')).toBe('true');
  });
});

describe('account id from the id_token', () => {
  it('reads the ChatGPT account claim', () => {
    const token = idTokenWith({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-42' } });
    expect(accountIdFromIdToken(token)).toBe('acct-42');
  });

  it('falls back to the organisation claim when the account one is absent', () => {
    const token = idTokenWith({ 'https://api.openai.com/auth': { organization_id: 'org-7' } });
    expect(accountIdFromIdToken(token)).toBe('org-7');
  });

  it('decodes payloads that use the url-safe alphabet', () => {
    // A payload whose base64 contains '-' and '_' is decoded only if the alphabet is translated
    // back; otherwise this returns null and the account header silently goes out empty.
    const token = idTokenWith({ 'https://api.openai.com/auth': { chatgpt_account_id: 'a?~b>>c' } });
    expect(token.split('.')[1]).toMatch(/[-_]/);
    expect(accountIdFromIdToken(token)).toBe('a?~b>>c');
  });

  it('returns null rather than throwing on anything unusable', () => {
    for (const token of [undefined, '', 'not-a-jwt', 'header..signature', `header.${base64urlOf(Buffer.from('{'))}.sig`]) {
      expect(accountIdFromIdToken(token)).toBeNull();
    }
  });

  it('returns null when the claim is present but not a string', () => {
    const token = idTokenWith({ 'https://api.openai.com/auth': { chatgpt_account_id: { nested: true } } });
    expect(accountIdFromIdToken(token)).toBeNull();
  });
});
