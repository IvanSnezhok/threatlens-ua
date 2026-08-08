import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { hasValidOpsAuth } from './ops-auth.js';
import { beginCodexLogin, cancelPendingLogin, codexStatus, disconnectCodex } from '../services/codex-auth.js';

function authorised(request: FastifyRequest): boolean {
  return hasValidOpsAuth(request.headers.authorization);
}

function unauthorized(reply: FastifyReply) {
  return reply.header('WWW-Authenticate', 'Basic realm="ThreatLens Ops"').code(401).send({ error: 'unauthorized' });
}

/**
 * Operator-only Codex sign-in.
 *
 * Every route here is behind the same Basic auth as the rest of `/ops`, and none of them ever
 * returns a token. `GET` answers "is there a session, whose is it, and when does it die"; that is
 * what an operator needs to decide whether to press the button, and it is all a compromised ops
 * password would yield beyond what it already yields.
 *
 * The OAuth callback itself is deliberately *not* a route on this server. It arrives on the
 * loopback listener that `beginCodexLogin` binds, because the redirect must be
 * `http://localhost:<port>/auth/callback` and this app is reached through Caddy on another port
 * entirely. Putting it here would mean registering a path that the authorisation server will never
 * call.
 */
const opsCodexRoutes: FastifyPluginAsync = async (app) => {
  app.get('/ops/codex', async (request, reply) => {
    if (!authorised(request)) return unauthorized(reply);
    return codexStatus();
  });

  /**
   * POST because it mutates: it binds a port and creates a single-use verifier, cancelling any
   * sign-in already in progress. The response is the URL to open — the server cannot open a browser
   * on the operator's machine, and should not pretend it can by redirecting.
   */
  app.post('/ops/codex/login', async (request, reply) => {
    if (!authorised(request)) return unauthorized(reply);
    try {
      const started = await beginCodexLogin();
      return { ...started, redirectUri: (await codexStatus()).redirectUri };
    } catch (error) {
      request.log.error({ error }, 'codex login could not start');
      return reply.code(503).send({ error: 'login_unavailable', reason: String(error) });
    }
  });

  app.delete('/ops/codex/login', async (request, reply) => {
    if (!authorised(request)) return unauthorized(reply);
    cancelPendingLogin();
    return { cancelled: true };
  });

  app.delete('/ops/codex', async (request, reply) => {
    if (!authorised(request)) return unauthorized(reply);
    return { disconnected: await disconnectCodex() };
  });
};

export default opsCodexRoutes;
export { opsCodexRoutes };
