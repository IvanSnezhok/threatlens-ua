import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hasValidOpsAuth } from './ops-auth.js';
import { beginCodexLogin, cancelPendingLogin, codexStatus, disconnectCodex } from '../services/codex-auth.js';
import { listCodexModels } from '../services/codex-client.js';
import { readCodexSettings, resolveSettings, saveCodexSettings } from '../services/codex-settings.js';

function authorised(request: FastifyRequest): boolean {
  return hasValidOpsAuth(request.headers.authorization);
}

function unauthorized(reply: FastifyReply) {
  return reply.header('WWW-Authenticate', 'Basic realm="ThreatLens Ops"').code(401).send({ error: 'unauthorized' });
}

/**
 * Operator-only Codex sign-in and model settings.
 *
 * Every route here is behind the same Basic auth as the rest of `/ops`, and none of them ever
 * returns a token. `GET` answers "is there a session, whose is it, and when does it die"; that is
 * what an operator needs to decide whether to press the button, and it is all a compromised ops
 * password would yield beyond what it already yields. `/ops/codex/settings` adds the other half —
 * which model, and for which of the three surfaces — and holds nothing secret at all.
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

  /**
   * Everything the settings form needs, in one request.
   *
   * Catalogue, current choice *and* session status together, because they are only meaningful
   * together: a model list is useless without knowing whether a call can be made at all, and a
   * switch set to "on" beside a dead session is the single most confusing state this feature can be
   * in. Fetching them separately would let the console render three views of three different
   * moments.
   *
   * The catalogue is asked of the service on every read rather than cached. It is one small request
   * behind an operator-only route that a human opens by hand, and a cache here would exist purely to
   * serve an operator a stale list at the exact moment they came to change something.
   */
  app.get('/ops/codex/settings', async (request, reply) => {
    if (!authorised(request)) return unauthorized(reply);
    const [stored, catalogue, status] = await Promise.all([
      readCodexSettings(), listCodexModels(), codexStatus()
    ]);
    return {
      settings: resolveSettings(stored),
      availableModels: catalogue.models,
      modelsSource: catalogue.source,
      modelsError: catalogue.error,
      status
    };
  });

  /**
   * PUT, not PATCH, because the console sends the whole form — but the body is validated as a patch
   * so that a curl that only wants to switch one feature off does not have to restate the model. An
   * empty or absent `model` means "defer to CODEX_MODEL", which is a real choice and not a mistake.
   */
  const settingsBody = z.object({
    model: z.string().max(120).nullish(),
    features: z.object({
      narrative: z.boolean(),
      digest: z.boolean(),
      attacks: z.boolean()
    }).partial().optional()
  });

  app.put('/ops/codex/settings', async (request, reply) => {
    if (!authorised(request)) return unauthorized(reply);
    const parsed = settingsBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_settings', issues: parsed.error.issues.map((issue) => issue.path.join('.')) });
    }
    const saved = await saveCodexSettings(parsed.data);
    return { settings: resolveSettings(saved) };
  });
};

export default opsCodexRoutes;
export { opsCodexRoutes };
