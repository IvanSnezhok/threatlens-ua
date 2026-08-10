import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { hasValidOpsAuth, opsUnauthorized } from './ops-auth.js';
import {
  LAG_REFERENCE_SECONDS,
  MIN_SAMPLE_SIZE,
  NEUTRAL_TRUST,
  TRUST_HALF_LIFE_DAYS,
  TRUST_HIGH_FROM,
  TRUST_METHODOLOGY_VERSION,
  TRUST_MODIFIER_CEILING,
  TRUST_MODIFIER_FLOOR,
  TRUST_REDUCED_TO,
  TRUST_WEIGHTS,
  TRUST_WINDOW_DAYS,
  listSourceTrust,
  recalculateSourceTrust,
  sourceTrustHistory
} from '../services/source-trust.js';

const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function authorised(request: FastifyRequest): boolean {
  return hasValidOpsAuth(request.headers.authorization);
}

/**
 * Operator-only view of dynamic source trust.
 *
 * Behind the same Basic auth as the rest of `/ops`, and a separate plugin for the same reason
 * `./analytics-routes.ts` is one: this is a self-contained surface and has no business widening
 * `server.ts`.
 *
 * The response carries the methodology alongside the rows, not in documentation somewhere. A trust
 * score without its weights, its window and its thresholds is a number an operator can only accept
 * or reject; with them it is a claim they can check. The public map never sees any of this — it gets
 * one word per source, from `trustLabel`, and the arithmetic stays here.
 */
const opsSourceTrustRoutes: FastifyPluginAsync = async (app) => {
  app.get('/ops/api/source-trust', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    const sources = await listSourceTrust();
    return {
      methodology: {
        version: TRUST_METHODOLOGY_VERSION,
        windowDays: TRUST_WINDOW_DAYS,
        halfLifeDays: TRUST_HALF_LIFE_DAYS,
        neutralTrust: NEUTRAL_TRUST,
        minSampleSize: MIN_SAMPLE_SIZE,
        lagReferenceSeconds: LAG_REFERENCE_SECONDS,
        weights: TRUST_WEIGHTS,
        modifier: { floor: TRUST_MODIFIER_FLOOR, ceiling: TRUST_MODIFIER_CEILING, neutral: 1 },
        labels: { highFrom: TRUST_HIGH_FROM, reducedTo: TRUST_REDUCED_TO },
        notice: 'Довіра не змінює рівень джерела (tier). Обмеження індексу за рівнями лишаються '
          + 'незмінними: довіра лише модулює внесок сигналу в межах 0.6–1.2.'
      },
      measuredAt: sources.find((source) => source.computedAt)?.computedAt ?? null,
      sources
    };
  });

  /** The series behind one source's current value. The append-only table exists to answer this. */
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/ops/api/source-trust/:id',
    async (request, reply) => {
      if (!authorised(request)) return opsUnauthorized(request, reply);
      if (!SOURCE_ID.test(request.params.id)) return reply.code(400).send({ error: 'invalid_source_id' });
      const limit = request.query.limit == null ? 60 : Number(request.query.limit);
      if (!Number.isFinite(limit) || limit < 1 || limit > 365) return reply.code(400).send({ error: 'invalid_limit' });
      return { sourceId: request.params.id, history: await sourceTrustHistory(request.params.id, limit) };
    }
  );

  /**
   * Recompute now. POST because it appends a run; the worker's daily pass is unaffected and the two
   * are indistinguishable in the table, which is the point — an operator's run is a real run.
   */
  app.post('/ops/api/source-trust/recalculate', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    return recalculateSourceTrust();
  });
};

export default opsSourceTrustRoutes;
export { opsSourceTrustRoutes };
