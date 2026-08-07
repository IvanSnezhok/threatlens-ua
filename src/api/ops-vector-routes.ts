import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { latestStoredProjection, projectEventVector, recentProjections } from '../services/vector-projection.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Same rule as `hasValidOpsAuth` in `./server.ts`, restated here.
 *
 * The original is module-private and `server.ts` is owned by other work in flight, so it cannot be
 * exported right now. Nine duplicated lines are the cheaper mistake: the alternative is loosening the
 * ops boundary — exporting the check, or registering the extrapolation route inside the public
 * plugin — to save them. When `server.ts` is next touched, exporting `hasValidOpsAuth` and deleting
 * this copy is a mechanical change.
 */
function hasValidOpsAuth(authorization?: string): boolean {
  if (!authorization?.startsWith('Basic ')) return false;
  const [user, password] = Buffer.from(authorization.slice(6), 'base64').toString().split(':');
  return safeEqual(user ?? '', config.OPS_USER) && safeEqual(password ?? '', config.OPS_PASSWORD);
}

function authorised(request: FastifyRequest): boolean {
  return hasValidOpsAuth(request.headers.authorization);
}

function unauthorized(reply: FastifyReply) {
  return reply.header('WWW-Authenticate', 'Basic realm="ThreatLens Ops"').code(401).send({ error: 'unauthorized' });
}

/**
 * Operator-only threat vector extrapolation.
 *
 * Separate plugin, separate file, separate service, separate tables. Everything under this path
 * answers a question the public product refuses to answer — "where would this go next" — so the
 * boundary is drawn where a refactor cannot quietly erase it:
 *
 *   * the public plugin `./vector-routes.ts` does not import this file or the service under it;
 *   * `../services/threat-vectors.ts`, which builds every public payload, does not import
 *     `../services/vector-projection.ts` either — the arrow points ops → public and never back;
 *   * the results live in `ops_threat_vector_projections`, which no public query names;
 *   * `./vector-isolation.test.ts` walks the module graph and the file contents on every run.
 *
 * `server.ts` registers both plugins. That is the composition root's job and does not weaken
 * anything: it already hosts `/ops/api`, `/ops/channels` and `/ops/run-assessment` beside the public
 * routes, and what keeps the two apart is that no public *response builder* can reach the ops code.
 */
const opsVectorRoutes: FastifyPluginAsync = async (app) => {
  /** Live events that have a chain worth extrapolating, so the console does not have to guess. */
  app.get('/ops/vectors', async (request, reply) => {
    if (!authorised(request)) return unauthorized(reply);
    const events = await pool.query(
      `SELECT e.id,e.title,e.threat_type,e.evidence_level,e.last_observed_at,
              count(DISTINCT mc.id)::int AS classifications
         FROM threat_events e
         JOIN message_classifications mc ON mc.event_id=e.id
        WHERE e.status IN ('observed','confirmed','active')
          AND e.last_observed_at > now() - interval '12 hours'
        GROUP BY e.id ORDER BY e.last_observed_at DESC LIMIT 50`
    );
    return {
      dataNature: 'calculated',
      notice: 'Екстраполяція — внутрішній розрахунок. Вона не публікується на карті, у знімку, у потоці подій і в боті.',
      events: events.rows,
      recent: await recentProjections(20)
    };
  });

  /** Compute, record and return. POST because it writes a row an operator can later be shown. */
  app.post<{ Params: { id: string }; Querystring: { horizonMinutes?: string } }>(
    '/ops/threats/:id/vector-projection',
    async (request, reply) => {
      if (!authorised(request)) return unauthorized(reply);
      if (!uuidPattern.test(request.params.id)) return reply.code(400).send({ error: 'invalid_id' });
      const requested = request.query.horizonMinutes === undefined ? undefined : Number(request.query.horizonMinutes);
      if (requested !== undefined && (!Number.isFinite(requested) || requested < 1 || requested > 60)) {
        return reply.code(400).send({ error: 'invalid_horizon' });
      }
      const result = await projectEventVector(request.params.id, { horizonMinutes: requested });
      if (!result.available) return reply.code(422).send({ error: 'projection_unavailable', reason: result.reason });
      return result.projection;
    }
  );

  app.get<{ Params: { id: string } }>('/ops/threats/:id/vector-projection', async (request, reply) => {
    if (!authorised(request)) return unauthorized(reply);
    if (!uuidPattern.test(request.params.id)) return reply.code(400).send({ error: 'invalid_id' });
    const stored = await latestStoredProjection(request.params.id);
    return stored ?? reply.code(404).send({ error: 'no_projection' });
  });
};

export default opsVectorRoutes;
export { opsVectorRoutes };
