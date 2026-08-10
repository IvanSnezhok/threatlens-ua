import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hasValidOpsAuth, opsUnauthorized } from './ops-auth.js';
import { beginCodexLogin, cancelPendingLogin, codexStatus, disconnectCodex } from '../services/codex-auth.js';
import { listCodexModels } from '../services/codex-client.js';
import { readCodexSettings, resolveSettings, saveCodexSettings } from '../services/codex-settings.js';
import { shadowAgreement } from '../services/shadow-classifier.js';

function authorised(request: FastifyRequest): boolean {
  return hasValidOpsAuth(request.headers.authorization);
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
    if (!authorised(request)) return opsUnauthorized(request, reply);
    return codexStatus();
  });

  /**
   * POST because it mutates: it binds a port and creates a single-use verifier, cancelling any
   * sign-in already in progress. The response is the URL to open — the server cannot open a browser
   * on the operator's machine, and should not pretend it can by redirecting.
   */
  app.post('/ops/codex/login', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    try {
      const started = await beginCodexLogin();
      return { ...started, redirectUri: (await codexStatus()).redirectUri };
    } catch (error) {
      request.log.error({ error }, 'codex login could not start');
      return reply.code(503).send({ error: 'login_unavailable', reason: String(error) });
    }
  });

  app.delete('/ops/codex/login', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    cancelPendingLogin();
    return { cancelled: true };
  });

  app.delete('/ops/codex', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
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
    if (!authorised(request)) return opsUnauthorized(request, reply);
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
      attacks: z.boolean(),
      // The shadow classifier, off by default. Listed here like the rest rather than behind its own
      // route: an operator switching model use on and off wants one form, and a switch reachable
      // only by a different path is a switch nobody finds when the quota runs out.
      shadow: z.boolean(),
      // The retrospective gate (migration 025), off by default and the only switch on this form that
      // grants a model any authority over the pipeline: with it on, a model may convert a threat the
      // rules would have published into an archive-only row, and may do nothing else. It belongs on
      // the same form for the same reason as `shadow` — the operator turning model use off in a
      // hurry must find every switch in one place — and its blast radius is documented beside it in
      // `src/services/retrospective-gate.ts`.
      retrospective_gate: z.boolean()
    }).partial().optional()
  });

  app.put('/ops/codex/settings', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    const parsed = settingsBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_settings', issues: parsed.error.issues.map((issue) => issue.path.join('.')) });
    }
    const saved = await saveCodexSettings(parsed.data);
    return { settings: resolveSettings(saved) };
  });

  /**
   * How often the shadow classifier and the rules agree, and the newest cases where they did not.
   *
   * This is the whole point of the shadow feature made readable: the disagreements are the messages
   * worth a human's attention, and the percentage is the only honest way to say whether the rules
   * have started drifting from the language the channels actually use. Nothing here can be acted on
   * automatically — the output is a reading list, and the action it leads to is somebody writing a
   * pattern and a test.
   *
   * The window is bounded at a month and the sample at a hundred because both numbers reach a
   * sequential scan over a table that grows with every ingested message, behind a route an operator
   * refreshes by hand.
   */
  const agreementQuery = z.object({
    hours: z.coerce.number().int().min(1).max(720).default(24),
    examples: z.coerce.number().int().min(1).max(100).default(10)
  });

  app.get('/ops/shadow-classifier', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    const parsed = agreementQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    return shadowAgreement(parsed.data.hours, parsed.data.examples);
  });
};

export default opsCodexRoutes;
export { opsCodexRoutes };
