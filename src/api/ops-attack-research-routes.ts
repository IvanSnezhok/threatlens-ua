import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { hasValidOpsAuth, opsUnauthorized } from './ops-auth.js';
import { codexFeatureEnabled } from '../services/codex-settings.js';
import {
  RESEARCH_BANDS,
  RESEARCH_FRAMING,
  RESEARCH_HISTORY_DAYS,
  RESEARCH_METHODOLOGY_VERSION,
  RESEARCH_NOTICE,
  RESEARCH_WINDOWS,
  isResearchWindow,
  recentResearch,
  researchCaps,
  researchMemoById,
  researchOblasts,
  runAttackResearch
} from '../services/attack-research.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function authorised(request: FastifyRequest): boolean {
  return hasValidOpsAuth(request.headers.authorization);
}

const WINDOW_LABELS: Record<string, string> = {
  night: 'Ніч (22:00–06:00)',
  day: 'День (06:00–22:00)',
  next12h: 'Найближчі 12 годин'
};

/**
 * Operator-only oblast research.
 *
 * A separate plugin, a separate service and a separate family of tables, for the same reason
 * `./ops-vector-routes.ts` is all three: everything under this path answers a question the public
 * product refuses to answer, and the boundary has to be somewhere a refactor cannot quietly erase.
 * `src/api/vector-isolation.test.ts` walks the import graph and the file contents on every run and
 * fails the build if any module that builds a public response can reach this one.
 *
 * Three routes, and the shape of the middle one is the whole design:
 *
 *   * `GET  /ops/attack-research`      — what may be asked, what today's allowance is, the framing
 *                                        sentence, and the last twenty requests INCLUDING refusals.
 *   * `POST /ops/attack-research`      — one memo, or a refusal that is also a recorded row.
 *   * `GET  /ops/attack-research/:id`  — one memo with the whole evidence pack it was written from.
 *
 * A memo is never produced by a timer, a leg or a scheduler. It exists because somebody pressed a
 * button, and the row that records the press is what the daily cap and the cooldown are counted
 * from — so a restart cannot hand anybody a fresh allowance.
 */
const opsAttackResearchRoutes: FastifyPluginAsync = async (app) => {
  app.get('/ops/attack-research', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    const [oblasts, caps, recent, featureEnabled] = await Promise.all([
      researchOblasts(), researchCaps(), recentResearch(20), codexFeatureEnabled('attack_research')
    ]);
    return {
      dataNature: 'calculated',
      methodologyVersion: RESEARCH_METHODOLOGY_VERSION,
      framing: RESEARCH_FRAMING,
      notice: RESEARCH_NOTICE,
      historyDays: RESEARCH_HISTORY_DAYS,
      bands: RESEARCH_BANDS,
      oblasts,
      windows: RESEARCH_WINDOWS.map((window) => ({ id: window, label: WINDOW_LABELS[window]! })),
      feature: { enabled: featureEnabled },
      caps: {
        perDay: caps.perDay,
        usedToday: caps.usedToday,
        cooldownSeconds: caps.cooldownSeconds
      },
      recent
    };
  });

  /**
   * POST because it appends a row whichever way it ends.
   *
   * `409` for the switch and `429` for either quota are two different sentences: one says «оператор
   * вимкнув цю поверхню», which nobody can wait out, and the other says «зачекайте», which carries a
   * number of seconds. Collapsing them into one status would make the console offer a countdown for
   * a state that no amount of waiting changes.
   */
  app.post<{ Body: { oblastId?: unknown; window?: unknown } }>(
    '/ops/attack-research',
    async (request, reply) => {
      if (!authorised(request)) return opsUnauthorized(request, reply);
      const oblastId = request.body?.oblastId;
      const window = request.body?.window;
      if (typeof oblastId !== 'string' || !oblastId.trim()) {
        return reply.code(400).send({ error: 'invalid_oblast' });
      }
      if (!isResearchWindow(window)) return reply.code(400).send({ error: 'invalid_window' });
      // Membership is checked here rather than in the service because a location that does not exist
      // cannot have a request row written against it — the foreign key would refuse — so this is a
      // malformed request rather than a refused one, and the two must not be logged as the same thing.
      const oblasts = await researchOblasts();
      if (!oblasts.some((oblast) => oblast.id === oblastId)) {
        return reply.code(400).send({ error: 'invalid_oblast' });
      }

      const result = await runAttackResearch({ oblastId, window });
      if (result.ok) return result.memo;
      if (result.status === 'refused_disabled') {
        return reply.code(409).send({ error: result.status, detail: result.detail });
      }
      if (result.status === 'failed') {
        return reply.code(500).send({ error: result.status, detail: result.detail });
      }
      if (result.retryAfterSeconds != null) reply.header('retry-after', String(result.retryAfterSeconds));
      return reply.code(429).send({
        error: result.status, detail: result.detail, retryAfterSeconds: result.retryAfterSeconds
      });
    }
  );

  app.get<{ Params: { id: string } }>('/ops/attack-research/:id', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    if (!uuidPattern.test(request.params.id)) return reply.code(400).send({ error: 'invalid_id' });
    const memo = await researchMemoById(request.params.id);
    return memo ?? reply.code(404).send({ error: 'no_memo' });
  });
};

export default opsAttackResearchRoutes;
export { opsAttackResearchRoutes };
