import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { pool } from '../db/pool.js';
import { hasValidOpsAuth, opsUnauthorized } from './ops-auth.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The same closed list the `surface` column's writers use. Validated rather than passed through so
 * a typo comes back as a named 400 instead of an empty page an operator reads as "no model calls".
 */
const SURFACES = [
  'narrative', 'digest', 'attacks', 'shadow', 'risk', 'retrospective_gate', 'tactics',
  'attack_research', 'movement_summary', 'attack_stats', 'classifier', 'context_compaction'
];

function authorised(request: FastifyRequest): boolean {
  return hasValidOpsAuth(request.headers.authorization);
}

/**
 * The model audit log, readable without psql.
 *
 * `ai_runs` is the only place that records what a model was actually asked and what it actually
 * answered — `risk.ts`, `analytics-narrative.ts` and `vector-projection.ts` all write here. Until
 * now `/ops/api` exposed six metadata columns of the last twenty rows, buried in a JSON dump, and
 * `input`/`output` were reachable only from a database shell. That is the wrong way round: the
 * columns that answer "what did the model do" were the two that were hidden.
 *
 * Split into list and detail on purpose. A risk assessment's `input` carries every contributing
 * signal and a narrative's carries a whole aggregate digest, so a list that embedded them would
 * grow without bound and be slow exactly when something has gone wrong and an operator needs it.
 * The list therefore reports the *size* of each payload instead, which is also the number that
 * tells you whether opening one is a good idea.
 */
const opsAiRunsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { limit?: string; status?: string; model?: string; surface?: string } }>('/ops/ai-runs', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);

    const requestedLimit = Number(request.query.limit ?? 50);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) return reply.code(400).send({ error: 'invalid_limit' });
    const limit = Math.min(200, requestedLimit);

    const status = request.query.status ?? null;
    if (status !== null && status !== 'success' && status !== 'failed') {
      return reply.code(400).send({ error: 'invalid_status' });
    }
    const model = request.query.model || null;
    const surface = request.query.surface || null;
    if (surface !== null && !SURFACES.includes(surface)) {
      return reply.code(400).send({ error: 'invalid_surface' });
    }

    const [rows, totals] = await Promise.all([
      // `surface` leads the projection because it is the discriminator an operator actually reasons
      // in — "the narrative stopped", not "prompt version analytics-narrative-v1 stopped".
      // `created_at DESC` is index-served by `ai_runs_created_idx` (migration 022).
      pool.query(
        `SELECT id,model,prompt_version,surface,classifier_version,validation_status,fallback_reason,
                status,error,duration_ms,created_at,
                length(input::text)  AS input_bytes,
                length(output::text) AS output_bytes
           FROM ai_runs
          WHERE ($1::text IS NULL OR status=$1) AND ($2::text IS NULL OR model=$2)
            AND ($3::text IS NULL OR surface=$3)
          ORDER BY created_at DESC LIMIT $4`,
        [status, model, surface, limit]
      ),
      // Counted over the whole table, not the page: "0 of 0" and "0 of 12 000" mean opposite
      // things, and the console has to be able to tell them apart.
      pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status='failed')::int AS failed,
                min(created_at) AS first_at, max(created_at) AS last_at
           FROM ai_runs`
      )
    ]);

    const models = await pool.query(`SELECT DISTINCT model FROM ai_runs ORDER BY model`);
    return { items: rows.rows, totals: totals.rows[0], models: models.rows.map((row) => row.model), limit };
  });

  app.get<{ Params: { id: string } }>('/ops/ai-runs/:id', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    if (!uuidPattern.test(request.params.id)) return reply.code(400).send({ error: 'invalid_id' });
    const result = await pool.query(
      `SELECT id,model,prompt_version,surface,classifier_version,validation_status,fallback_reason,
              status,error,duration_ms,created_at,input,output
         FROM ai_runs WHERE id=$1`, [request.params.id]
    );
    return result.rows[0] ?? reply.code(404).send({ error: 'not_found' });
  });
};

export default opsAiRunsRoutes;
export { opsAiRunsRoutes };
