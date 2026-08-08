import { createServer, type Server } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { pool } from '../db/pool.js';

/**
 * Codex sign-in: Authorization Code + PKCE against ChatGPT, initiated by an operator.
 *
 * ================================================================================================
 * What this replaces, and what it does not
 * ================================================================================================
 *
 * Before this module the only way to reach Codex was to install the Codex CLI, run `codex login`,
 * open `~/.codex/auth.json`, copy an access token into `CODEX_API_KEY` and restart the container —
 * and to repeat all of it every time the token expired, which is hours. This module performs the
 * same OAuth exchange the CLI performs, stores the result in `codex_credentials` and refreshes it
 * on use. It does not change what the token is *for*: `ANALYTICS_NARRATIVE_ENABLED` still decides
 * whether a model is called, `CODEX_BASE_URL` and `CODEX_MODEL` still decide where and which, and
 * the narrative still falls back to deterministic prose when any of that is missing.
 *
 * ================================================================================================
 * Why the callback is loopback, and what that costs
 * ================================================================================================
 *
 * The registered redirect for the Codex client is `http://localhost:<port>/auth/callback`. That is
 * not a preference we can override: an authorisation server rejects a redirect_uri it does not
 * recognise, and we have no client of our own registered with OpenAI. So the browser that finishes
 * the sign-in and the process that receives the code must agree on what `localhost` means.
 *
 *   * `docker compose` on the operator's own machine, port 1455 published — works.
 *   * `npm run dev` on the operator's own machine — works.
 *   * the app on a remote host behind Caddy, operator's browser elsewhere — the callback goes to
 *     the *operator's* machine, where nothing is listening, and the sign-in never completes.
 *
 * The third case is a precondition, not a failure to fix here; `/ops/codex` states it plainly so
 * nobody spends an evening debugging a redirect that was never going to arrive.
 *
 * ================================================================================================
 * One sign-in at a time
 * ================================================================================================
 *
 * A pending login owns a PKCE verifier, a state value and a bound port. Allowing two would mean two
 * verifiers for one port and a callback that has to guess which one it belongs to. Starting a new
 * sign-in therefore cancels the previous one, which is also what an operator who clicked twice
 * expects.
 */

const CALLBACK_PATH = '/auth/callback';
/** Refresh this long before the token actually expires, so a slow request cannot straddle expiry. */
const REFRESH_SKEW_SECONDS = 120;

export interface CodexCredentials {
  accessToken: string;
  accountId: string | null;
}

export interface CodexStatus {
  connected: boolean;
  accountId: string | null;
  expiresAt: string | null;
  obtainedAt: string | null;
  refreshedAt: string | null;
  expired: boolean;
  canRefresh: boolean;
  lastError: string | null;
  pendingLogin: { expiresAt: string } | null;
  redirectUri: string;
  /** Preconditions the console shows beside the button, so "connected but silent" is never a mystery. */
  narrativeEnabled: boolean;
  baseUrlConfigured: boolean;
  modelConfigured: boolean;
  envTokenConfigured: boolean;
}

interface PendingLogin {
  state: string;
  verifier: string;
  server: Server;
  timer: NodeJS.Timeout;
  expiresAt: Date;
}

interface CredentialRow {
  account_id: string | null;
  access_token: string;
  refresh_token: string | null;
  scope: string | null;
  expires_at: Date | null;
  obtained_at: Date;
  refreshed_at: Date | null;
  last_error: string | null;
}

let pending: PendingLogin | null = null;
/** Serialises refreshes: two concurrent narrative runs must not both spend the refresh token. */
let refreshInFlight: Promise<CodexCredentials | null> | null = null;

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function redirectUri(): string {
  return `http://${config.CODEX_OAUTH_REDIRECT_HOST}:${config.CODEX_OAUTH_REDIRECT_PORT}${CALLBACK_PATH}`;
}

/**
 * The ChatGPT account the token belongs to, read out of the id_token.
 *
 * Read, not trusted: the value only ever becomes a `ChatGPT-Account-Id` header on a request that
 * already carries the access token, so a forged claim would buy an attacker who could already
 * forge the token nothing. No signature check is therefore performed, and none should be inferred.
 */
export function accountIdFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const auth = claims?.['https://api.openai.com/auth'];
    const id = auth?.chatgpt_account_id ?? auth?.organization_id ?? claims?.chatgpt_account_id;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

/**
 * The PKCE pair and the authorisation URL, separated from the sign-in so they can be asserted
 * without binding a port or reaching the network. Getting either wrong fails in a way that looks
 * like a server problem — an opaque `invalid_grant` at the token endpoint — so they are exactly the
 * parts worth pinning down in a test.
 */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(64));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

export function buildAuthorizeUrl(challenge: string, state: string): string {
  const authorize = new URL(`${config.CODEX_OAUTH_ISSUER}/oauth/authorize`);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', config.CODEX_OAUTH_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', redirectUri());
  authorize.searchParams.set('scope', config.CODEX_OAUTH_SCOPE);
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('state', state);
  // Both flags are what the Codex CLI sends; without them the consent screen can return an
  // id_token that carries no account claim, and the ChatGPT-Account-Id header would go out empty.
  authorize.searchParams.set('id_token_add_organizations', 'true');
  authorize.searchParams.set('codex_cli_simplified_flow', 'true');
  return authorize.toString();
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// ------------------------------------------------------------------------------------------------
// Storage
// ------------------------------------------------------------------------------------------------

async function readRow(): Promise<CredentialRow | null> {
  const result = await pool.query<CredentialRow>(
    `SELECT account_id,access_token,refresh_token,scope,expires_at,obtained_at,refreshed_at,last_error
       FROM codex_credentials WHERE singleton`
  );
  return result.rows[0] ?? null;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function storeTokens(tokens: TokenResponse, previous: CredentialRow | null): Promise<void> {
  if (!tokens.access_token) throw new Error('token response carried no access_token');
  const expiresAt = typeof tokens.expires_in === 'number'
    ? new Date(Date.now() + tokens.expires_in * 1000)
    : null;
  const accountId = accountIdFromIdToken(tokens.id_token) ?? previous?.account_id ?? null;
  // A refresh response is allowed to omit refresh_token; dropping the old one would end the session
  // at the next expiry for no reason.
  const refreshToken = tokens.refresh_token ?? previous?.refresh_token ?? null;
  await pool.query(
    `INSERT INTO codex_credentials
       (singleton,account_id,access_token,refresh_token,id_token,scope,expires_at,obtained_at,refreshed_at,last_error,updated_at)
     VALUES (true,$1,$2,$3,$4,$5,$6,now(),CASE WHEN $7::boolean THEN now() ELSE NULL END,NULL,now())
     ON CONFLICT (singleton) DO UPDATE SET
       account_id=EXCLUDED.account_id, access_token=EXCLUDED.access_token,
       refresh_token=EXCLUDED.refresh_token, id_token=EXCLUDED.id_token, scope=EXCLUDED.scope,
       expires_at=EXCLUDED.expires_at, refreshed_at=EXCLUDED.refreshed_at,
       last_error=NULL, updated_at=now()`,
    [accountId, tokens.access_token, refreshToken, tokens.id_token ?? null, tokens.scope ?? null, expiresAt, previous != null]
  );
}

async function recordFailure(reason: string): Promise<void> {
  await pool.query(
    `UPDATE codex_credentials SET last_error=$1, updated_at=now() WHERE singleton`, [reason.slice(0, 500)]
  ).catch(() => undefined);
}

export async function disconnectCodex(): Promise<boolean> {
  cancelPendingLogin();
  const result = await pool.query(`DELETE FROM codex_credentials WHERE singleton`);
  return (result.rowCount ?? 0) > 0;
}

// ------------------------------------------------------------------------------------------------
// Token endpoint
// ------------------------------------------------------------------------------------------------

async function postToken(body: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<TokenResponse> {
  const response = await fetchImpl(`${config.CODEX_OAUTH_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(20_000)
  });
  const payload = await response.json().catch(() => ({})) as TokenResponse;
  if (!response.ok) {
    throw new Error(`token endpoint ${response.status}: ${payload.error_description ?? payload.error ?? 'no detail'}`);
  }
  return payload;
}

// ------------------------------------------------------------------------------------------------
// The sign-in itself
// ------------------------------------------------------------------------------------------------

export function cancelPendingLogin(): void {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.server.close();
  pending = null;
}

function callbackPage(title: string, message: string): string {
  // Rendered in the operator's browser after the redirect. Static text only — nothing from the
  // query string reaches this page, so there is nothing here to escape.
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8">
<title>${title}</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0c10;color:#e9e7e0;
font:400 15px/1.6 system-ui,sans-serif}
div{max-width:34rem;padding:2.5rem;border:1px solid rgba(233,231,224,.17)}
h1{margin:0 0 .75rem;font-size:1.35rem;letter-spacing:-.02em}
p{margin:0;color:#b6bbc2}</style></head>
<body><div><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

/**
 * Starts a sign-in and returns the URL the operator must open.
 *
 * The listener is bound *before* the URL is handed out. Binding can fail — the Codex CLI itself
 * holds this port while it is running — and discovering that after the operator has already
 * authenticated would mean losing the code with no way to replay it.
 */
export async function beginCodexLogin(): Promise<{ authorizeUrl: string; expiresAt: string }> {
  cancelPendingLogin();

  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(32));

  const server = createServer((request, response) => {
    void handleCallback(request.url ?? '', response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'EADDRINUSE'
        ? new Error(`port ${config.CODEX_OAUTH_REDIRECT_PORT} is already in use — stop the Codex CLI, or set CODEX_OAUTH_REDIRECT_PORT`)
        : error);
    });
    server.listen(config.CODEX_OAUTH_REDIRECT_PORT, config.CODEX_OAUTH_BIND_ADDRESS, resolve);
  });

  const expiresAt = new Date(Date.now() + config.CODEX_OAUTH_LOGIN_TIMEOUT_SECONDS * 1000);
  const timer = setTimeout(cancelPendingLogin, config.CODEX_OAUTH_LOGIN_TIMEOUT_SECONDS * 1000);
  timer.unref();
  pending = { state, verifier, server, timer, expiresAt };

  return { authorizeUrl: buildAuthorizeUrl(challenge, state), expiresAt: expiresAt.toISOString() };
}

async function handleCallback(rawUrl: string, response: import('node:http').ServerResponse): Promise<void> {
  const send = (status: number, html: string) => {
    response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(html);
  };

  const url = new URL(rawUrl, `http://${config.CODEX_OAUTH_REDIRECT_HOST}`);
  if (url.pathname !== CALLBACK_PATH) {
    return send(404, callbackPage('Не той шлях', 'Ця адреса приймає лише відповідь від ChatGPT.'));
  }
  const active = pending;
  if (!active) {
    return send(410, callbackPage('Вхід уже не активний', 'Сеанс входу завершився або був скасований. Почніть його заново в операційній консолі.'));
  }

  const error = url.searchParams.get('error');
  if (error) {
    cancelPendingLogin();
    await recordFailure(`authorisation refused: ${error}`);
    return send(400, callbackPage('Доступ не надано', 'ChatGPT відхилив запит на авторизацію. Нічого не збережено.'));
  }

  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  if (!constantTimeEquals(state, active.state)) {
    return send(400, callbackPage('Невідповідність state', 'Відповідь не належить цьому сеансу входу. Нічого не збережено.'));
  }
  if (!code) {
    return send(400, callbackPage('Немає коду', 'ChatGPT не повернув код авторизації. Нічого не збережено.'));
  }

  // The verifier is consumed here whatever happens next: a code is single-use, so a failed
  // exchange has to be restarted from the console rather than retried against the same listener.
  const verifier = active.verifier;
  cancelPendingLogin();

  try {
    const tokens = await postToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      client_id: config.CODEX_OAUTH_CLIENT_ID,
      code_verifier: verifier
    });
    await storeTokens(tokens, await readRow());
    send(200, callbackPage('Codex підключено', 'Токен збережено на сервері. Цю вкладку можна закрити й повернутися до операційної консолі.'));
  } catch (failure) {
    await recordFailure(String(failure));
    send(502, callbackPage('Обмін коду не вдався', 'ChatGPT прийняв вхід, але обмін коду на токен не завершився. Подробиці — в операційній консолі.'));
  }
}

// ------------------------------------------------------------------------------------------------
// Use
// ------------------------------------------------------------------------------------------------

function needsRefresh(row: CredentialRow): boolean {
  if (!row.expires_at) return true;
  return row.expires_at.getTime() - Date.now() < REFRESH_SKEW_SECONDS * 1000;
}

async function refresh(row: CredentialRow): Promise<CodexCredentials | null> {
  if (!row.refresh_token) {
    await recordFailure('access token expired and no refresh token is stored — sign in again');
    return null;
  }
  try {
    const tokens = await postToken({
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token,
      client_id: config.CODEX_OAUTH_CLIENT_ID,
      scope: config.CODEX_OAUTH_SCOPE
    });
    await storeTokens(tokens, row);
    return {
      accessToken: tokens.access_token!,
      accountId: accountIdFromIdToken(tokens.id_token) ?? row.account_id
    };
  } catch (failure) {
    await recordFailure(String(failure));
    return null;
  }
}

/**
 * The stored session, refreshed if it is at or near expiry.
 *
 * Returns null rather than throwing for every failure mode. The caller is the analytics narrative,
 * whose contract is that the numbers are complete without a model at all; an expired Codex session
 * must degrade to deterministic prose, never to a failed analytics request.
 */
export async function codexCredentials(): Promise<CodexCredentials | null> {
  if (refreshInFlight) return refreshInFlight;
  const row = await readRow().catch(() => null);
  if (!row) return null;
  if (!needsRefresh(row)) return { accessToken: row.access_token, accountId: row.account_id };

  refreshInFlight = refresh(row).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

export async function codexStatus(): Promise<CodexStatus> {
  const row = await readRow().catch(() => null);
  const expiresAt = row?.expires_at ?? null;
  return {
    connected: Boolean(row),
    accountId: row?.account_id ?? null,
    expiresAt: expiresAt?.toISOString() ?? null,
    obtainedAt: row?.obtained_at?.toISOString() ?? null,
    refreshedAt: row?.refreshed_at?.toISOString() ?? null,
    expired: Boolean(row) && (!expiresAt || expiresAt.getTime() <= Date.now()),
    canRefresh: Boolean(row?.refresh_token),
    lastError: row?.last_error ?? null,
    pendingLogin: pending ? { expiresAt: pending.expiresAt.toISOString() } : null,
    redirectUri: redirectUri(),
    narrativeEnabled: config.ANALYTICS_NARRATIVE_ENABLED,
    baseUrlConfigured: Boolean(config.CODEX_BASE_URL),
    modelConfigured: Boolean(config.CODEX_MODEL),
    envTokenConfigured: Boolean(config.CODEX_API_KEY)
  };
}
