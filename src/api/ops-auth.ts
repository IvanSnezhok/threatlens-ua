import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

/**
 * Who counts as an operator — one definition, shared by every protected surface.
 *
 * This lives in its own module rather than being exported from `server.ts` because `server.ts`
 * imports the route plugins that need it, so exporting it from there would close an import cycle.
 * It briefly existed as three byte-identical copies, one per plugin, which is the shape of bug that
 * gets noticed only when one copy is fixed and the others are not.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hasValidOpsAuth(authorization?: string): boolean {
  if (!authorization?.startsWith('Basic ')) return false;
  const [user, password] = Buffer.from(authorization.slice(6), 'base64').toString().split(':');
  return safeEqual(user ?? '', config.OPS_USER) && safeEqual(password ?? '', config.OPS_PASSWORD);
}

const OPS_CHALLENGE = 'Basic realm="ThreatLens Ops"';

/**
 * The header the console's own `fetch` sets on every `/ops/*` request — see `opsFetch` in
 * `web/app.js`, which is the single place it is added.
 */
const SPA_MARKER = 'xmlhttprequest';

/**
 * Does this caller want the *browser* to ask for the password?
 *
 * `WWW-Authenticate: Basic` is not access control — the 401 already is. It is a one-line instruction
 * to the user agent: «open your own credential dialog». For `curl` that instruction is inert, which
 * is why every recipe in `docs/OPERATIONS.md` keeps working. For Chrome it is binding even when the
 * 401 answers a `fetch()` rather than a navigation: the browser parks on its native prompt, the
 * rejected promise never reaches the SPA, and the console's own login form — the one that renders
 * the 401 into `<form class="ops-login">` — never gets drawn. A direct load of `/ops` served the
 * page and then hid it behind an OS-grey box the application could not fill in, style or dismiss.
 *
 * So the challenge is emitted for everything *except* the console's own fetches, marked by
 * `X-Requested-With: XMLHttpRequest`. Chosen over the `Sec-Fetch-Mode: cors|same-origin` reading of
 * the same fact for two reasons, both about what happens when the header is *missing*:
 *
 *  - Fetch-metadata headers are attached only for potentially trustworthy origins — HTTPS, plus
 *    `localhost`. An ops console reached over plain HTTP at a LAN address (the compose file's
 *    default before a certificate exists) sends no `Sec-Fetch-*` at all, so the guard would fall
 *    back to challenging exactly the browser it was written for. It would pass every test on
 *    localhost and fail on the box the operator actually uses — silently, and with no way to tell
 *    that 401 apart from any other.
 *  - Absence of `Sec-Fetch-Mode` conflates «not a browser» with «a browser we cannot read»;
 *    `X-Requested-With` is a positive mark this repository sets itself, in one function. Absence
 *    means one thing: the caller is not the console, so let the user agent do what it likes.
 *
 * It is deliberately forgeable, and that costs nothing: the status, the body and the credentials
 * required are identical either way. The header only decides who draws the login box.
 *
 * (The console is same-origin with the API, so the custom header provokes no CORS preflight. A
 * cross-origin ops console would need `Access-Control-Allow-Headers` before this worked.)
 */
function wantsBrowserPrompt(request: FastifyRequest): boolean {
  const requestedWith = request.headers['x-requested-with'];
  const value = Array.isArray(requestedWith) ? requestedWith[0] : requestedWith;
  return value?.toLowerCase() !== SPA_MARKER;
}

/**
 * The one refusal every `/ops/*` surface returns. It briefly existed as nine byte-identical copies,
 * one per route plugin, which is how the console came to be unreachable in a browser while every
 * `curl` recipe in the runbook stayed green.
 */
export function opsUnauthorized(request: FastifyRequest, reply: FastifyReply) {
  if (wantsBrowserPrompt(request)) reply.header('WWW-Authenticate', OPS_CHALLENGE);
  return reply.code(401).send({ error: 'unauthorized' });
}
