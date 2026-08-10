import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { opsUnauthorized } from './ops-auth.js';

/**
 * The two halves of one refusal.
 *
 * `WWW-Authenticate: Basic` decides *who draws the login box*, and it has exactly two audiences
 * that must be told different things:
 *
 *  - `curl -u …` (every recipe in `docs/OPERATIONS.md`) sends `Authorization` up front and normally
 *    never sees a 401 at all; when it does, the challenge is inert to it and must stay, because a
 *    bare `curl http://…/ops/api` naming the realm is how an operator learns what to authenticate
 *    against.
 *  - the console's own `fetch` must NOT get it. Chrome honours the challenge even on a `fetch()`,
 *    parks on its native credential dialog and never resolves the promise, so `renderOps()` never
 *    reaches the branch that draws `<form class="ops-login">`. A direct browser load of `/ops` was
 *    a blank page behind an OS-grey box.
 *
 * The server half is pinned against a real Fastify instance; the client half is sliced out of the
 * shipped `web/app.js` and executed, so the marker that suppresses the challenge is asserted at
 * both ends of the same wire rather than assumed to match.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const CHALLENGE = 'Basic realm="ThreatLens Ops"';

async function guardedApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const app = Fastify({ logger: false });
  app.get('/ops/probe', async (request, reply) => opsUnauthorized(request, reply));
  await app.ready();
  return app;
}

async function refusal(headers: Record<string, string>) {
  const app = await guardedApp();
  try {
    return await app.inject({ method: 'GET', url: '/ops/probe', headers });
  } finally {
    await app.close();
  }
}

describe('the operator refusal decides who draws the login box', () => {
  it('challenges a bare request, the way a curl user needs', async () => {
    const response = await refusal({});
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe(CHALLENGE);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  });

  it('does not challenge the console fetch, and refuses it identically otherwise', async () => {
    const response = await refusal({ 'x-requested-with': 'XMLHttpRequest' });
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBeUndefined();
    // Same status, same body: the header is a hint to the user agent, never access control. Only
    // who renders the credential form changes.
    expect(response.json()).toEqual({ error: 'unauthorized' });
  });

  it('reads the marker case-insensitively, as a header value should be read', async () => {
    const response = await refusal({ 'x-requested-with': 'xmlhttprequest' });
    expect(response.headers['www-authenticate']).toBeUndefined();
  });

  it('challenges anything that is not that marker', async () => {
    // A client that sets some *other* X-Requested-With is not this console, and gets the default.
    for (const value of ['fetch', 'ThreatLens', '']) {
      const response = await refusal({ 'x-requested-with': value });
      expect(response.headers['www-authenticate'], `x-requested-with: ${value}`).toBe(CHALLENGE);
    }
  });
});

// ------------------------------------------------------------------------------------------------
// One refusal, not eleven
// ------------------------------------------------------------------------------------------------

/**
 * The bug this file exists for was reachable because `WWW-Authenticate` was written out at eleven
 * separate call sites — nine byte-identical `function unauthorized(reply)` copies plus two inline
 * ones in `server.ts`. Fixing the header in one of them would have left the console broken through
 * any of the other ten, and nothing would have said so.
 *
 * So the literal is now allowed in exactly one module. A new ops plugin that copies the old idiom
 * fails here rather than in a browser.
 */
describe('the challenge is written in one place', () => {
  it('appears in no source file but ops-auth.ts', () => {
    const apiDir = resolve(ROOT, 'src/api');
    const offenders = readdirSync(apiDir)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'ops-auth.ts')
      .filter((name) => readFileSync(resolve(apiDir, name), 'utf8').includes('WWW-Authenticate'));
    expect(offenders, 'use opsUnauthorized(request, reply) from ./ops-auth.js instead').toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------
// The client half, executed rather than assumed
// ------------------------------------------------------------------------------------------------

const APP_SOURCE = readFileSync(resolve(ROOT, 'web/app.js'), 'utf8');

/**
 * `opsFetch`, sliced out of the bundle by its terminating brace at column 0.
 *
 * `web/app.js` cannot be imported into a node test — it opens with `import maplibregl`, touches
 * `document` at module scope and ends by calling `boot()`. The slice-and-evaluate technique is the
 * one already used by `vector-isolation.test.ts`: what runs below is the shipped text, so rewriting
 * the helper reruns the rewrite here.
 */
function opsFetchSource(): string {
  const start = APP_SOURCE.indexOf('function opsFetch(');
  if (start === -1) throw new Error('function opsFetch not found in web/app.js');
  const end = APP_SOURCE.indexOf('\n}\n', start);
  if (end === -1) throw new Error('function opsFetch has no terminating brace at column 0');
  return APP_SOURCE.slice(start, end + 2);
}

interface StubCall { url: string; init: { headers: Headers; [key: string]: unknown } }

/** Binds the helper's two free variables — the global `fetch` and the module-level credential. */
function opsFetchWith(opsAuthorization: string) {
  const calls: StubCall[] = [];
  const stub = (url: string, init: StubCall['init']) => { calls.push({ url, init }); return Promise.resolve(null); };
  const build = new Function('fetch', 'opsAuthorization', `${opsFetchSource()}\nreturn opsFetch;`) as
    (fetchImpl: unknown, authorization: string) => (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  return { opsFetch: build(stub, opsAuthorization), calls };
}

describe('the console marks its own fetches', () => {
  it('marks the signed-out probe — the one request that used to raise the browser prompt', async () => {
    const { opsFetch, calls } = opsFetchWith('');
    await opsFetch('/ops/api');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.headers.get('X-Requested-With')).toBe('XMLHttpRequest');
    expect(calls[0]!.init.headers.get('Authorization')).toBeNull();
  });

  it('carries the marker alongside the credential once the operator has signed in', async () => {
    const credential = `Basic ${Buffer.from('operator:change-me').toString('base64')}`;
    const { opsFetch, calls } = opsFetchWith(credential);
    await opsFetch('/ops/api/runtime');
    expect(calls[0]!.init.headers.get('X-Requested-With')).toBe('XMLHttpRequest');
    expect(calls[0]!.init.headers.get('Authorization')).toBe(credential);
  });

  it('adds the marker without disturbing a caller that brings its own headers and body', async () => {
    const { opsFetch, calls } = opsFetchWith('');
    await opsFetch('/ops/channels', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"handle":"@x"}'
    });
    const { init } = calls[0]!;
    expect(init.headers.get('X-Requested-With')).toBe('XMLHttpRequest');
    expect(init.headers.get('Content-Type')).toBe('application/json');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"handle":"@x"}');
  });

  it('is the only door to /ops in the bundle', () => {
    // A literal `fetch('/ops…')` anywhere else would reach the server without the marker and bring
    // the native prompt back on that one screen. The lookbehind is what lets `opsFetch(` through.
    const bare = APP_SOURCE.match(/(?<![\w$])fetch\(\s*[`'"]\/ops/g) ?? [];
    expect(bare, 'route /ops requests through opsFetch()').toEqual([]);
  });
});
