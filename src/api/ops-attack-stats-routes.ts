import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { hasValidOpsAuth, opsUnauthorized } from './ops-auth.js';
import {
  attackStatsOverview, attackStatsReportById, recentAttackStatsReports, regionsOfInterest,
  requestAttackStats, runAttackStatsDailyPass
} from '../services/attack-stats.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REGION_ID = /^ua-\d{2}$/;

function authorised(request: FastifyRequest): boolean {
  return hasValidOpsAuth(request.headers.authorization);
}

/**
 * Операторська сторона статистики ударів: та сама черга й ті самі звіти, що й публічно, плюс те, що
 * публіка не бачить — повний текст із JSON-блоком, черга та кандидати планового проходу, кнопки.
 *
 *  * `GET  /ops/attack-stats`             — стан регіонів, ліміти, останні тридцять звітів будь-якого
 *                                           статусу, регіони зацікавленості й налаштування поверхні.
 *  * `POST /ops/attack-stats`             — `{ regionId }`: поставити запуск у чергу, не зважаючи на
 *                                           вікно свіжості. Перемикач і денний ліміт діють як для всіх.
 *  * `POST /ops/attack-stats/daily-pass`  — плановий прохід зараз, поза розкладом.
 *  * `GET  /ops/attack-stats/:id`         — один звіт цілком: зведення, текст, сирий JSON.
 *
 * Це не операторська приватна поверхня на кшталт дослідження області: усе, що тут читається, читає
 * й публічна сторінка, крім сирого JSON і черги. Тому модулі цієї поверхні не в `OPS_ONLY_MODULES`, а
 * навпаки — у переліку публічних входів `vector-isolation.test.ts`.
 */
const opsAttackStatsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/ops/attack-stats', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    const [overview, recent, candidates] = await Promise.all([
      attackStatsOverview(), recentAttackStatsReports(30), regionsOfInterest()
    ]);
    return {
      ...overview,
      recent,
      candidates,
      settings: {
        runTime: config.ATTACK_STATS_RUN_TIME,
        digestTime: config.NIGHTLY_DIGEST_TIME,
        timeoutMs: config.ATTACK_STATS_TIMEOUT_MS,
        maxRegionsPerPass: config.ATTACK_STATS_MAX_REGIONS_PER_PASS,
        webSearchTool: config.ATTACK_STATS_WEB_SEARCH_TOOL || null,
        reasoningEffort: config.ATTACK_STATS_REASONING_EFFORT || null,
        retentionDays: config.ATTACK_STATS_RETENTION_DAYS
      }
    };
  });

  app.post<{ Body: { regionId?: unknown } }>('/ops/attack-stats', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    const regionId = request.body?.regionId;
    if (typeof regionId !== 'string' || !REGION_ID.test(regionId)) return reply.code(400).send({ error: 'invalid_region' });
    const outcome = await requestAttackStats(regionId, 'operator', { force: true });
    if (outcome.outcome === 'invalid_region') return reply.code(400).send({ error: 'invalid_region' });
    if (outcome.outcome === 'refused_disabled') return reply.code(409).send(outcome);
    if (outcome.outcome === 'refused_daily_cap' || outcome.outcome === 'refused_public_closed') return reply.code(429).send(outcome);
    return reply.code(outcome.outcome === 'queued' || outcome.outcome === 'running' ? 202 : 200).send(outcome);
  });

  app.post('/ops/attack-stats/daily-pass', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    const result = await runAttackStatsDailyPass(new Date(), { force: true });
    if (result.refused === 'refused_disabled') return reply.code(409).send(result);
    return reply.code(202).send(result);
  });

  app.get<{ Params: { id: string } }>('/ops/attack-stats/:id', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    if (!uuidPattern.test(request.params.id)) return reply.code(400).send({ error: 'invalid_id' });
    const report = await attackStatsReportById(request.params.id);
    if (!report) return reply.code(404).send({ error: 'no_report' });
    return report;
  });
};

export default opsAttackStatsRoutes;
export { opsAttackStatsRoutes };
