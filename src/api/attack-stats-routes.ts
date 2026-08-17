import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  attackStatsOverview, latestAttackStatsReport, requestAttackStats
} from '../services/attack-stats.js';

/**
 * Публічна статистика ударів і ймовірності по регіонах — блок на сторінці «Аналіз атак».
 *
 * Окремий плагін з тієї самої причини, що й `attack-analytics-routes.ts`: він публічний, а плагін
 * `analytics-routes.ts` вішає операторський guard на кожен свій маршрут. Тут три маршрути:
 *
 *  * `GET  /api/v1/analytics/attack-stats` — стан усіх регіонів (є звіт? свіжий? у черзі?), щоб
 *    сторінка намалювала селектор і картки; кешується хвилину;
 *  * `GET  /api/v1/analytics/attack-stats/:regionId` — найсвіжіший готовий звіт із зведенням і
 *    текстом; кешується п'ять хвилин;
 *  * `POST /api/v1/analytics/attack-stats/:regionId/requests` — «користувач обрав область»:
 *    записує інтерес і, якщо дозволено й ліміт не вичерпано, ставить один запуск у чергу. Це не
 *    виклик моделі з боку читача: між запитом і моделлю стоять перемикач, денний ліміт, вікно
 *    свіжості й одна черга з одним активним рядком на регіон.
 *
 * Жодного per-client опитування: сторінка дізнається про готовий звіт з `attack_stats.updated` у
 * тому самому SSE-потоці, що й про все інше.
 */

const OVERVIEW_CACHE = 'public, max-age=60, stale-while-revalidate=300';
const REPORT_CACHE = 'public, max-age=300, stale-while-revalidate=3600';
const CACHE_CONTROL = Symbol('attackStatsCacheControl');
const REGION_ID = /^ua-\d{2}$/;

function setCacheControl(reply: FastifyReply, value: string): void {
  (reply as unknown as Record<symbol, string>)[CACHE_CONTROL] = value;
}

const attackStatsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onSend', async (_request, reply, payload) => {
    const value = (reply as unknown as Record<symbol, string | undefined>)[CACHE_CONTROL];
    if (value) reply.header('Cache-Control', value);
    return payload;
  });

  app.get('/api/v1/analytics/attack-stats', async (_request, reply) => {
    const overview = await attackStatsOverview();
    setCacheControl(reply, OVERVIEW_CACHE);
    return overview;
  });

  app.get<{ Params: { regionId: string } }>('/api/v1/analytics/attack-stats/:regionId', async (request, reply) => {
    if (!REGION_ID.test(request.params.regionId)) return reply.code(400).send({ error: 'invalid_region' });
    const report = await latestAttackStatsReport(request.params.regionId);
    if (!report) return reply.code(404).send({ error: 'no_report' });
    setCacheControl(reply, REPORT_CACHE);
    return report;
  });

  app.post<{ Params: { regionId: string } }>('/api/v1/analytics/attack-stats/:regionId/requests', {
    // Тридцять на хвилину з однієї адреси: селектор на сторінці клацають, а не тримають; більше — це
    // скрипт, і йому досить дізнатися стан один раз.
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    if (!REGION_ID.test(request.params.regionId)) return reply.code(400).send({ error: 'invalid_region' });
    const outcome = await requestAttackStats(request.params.regionId, 'public');
    if (outcome.outcome === 'invalid_region') return reply.code(400).send({ error: 'invalid_region' });
    // 202 для черги, 200 для решти — і для відмов теж: відмова тут не помилка клієнта, а стан
    // губернатора, який сторінка показує словами («інтерес записано, порахується завтра»).
    return reply.code(outcome.outcome === 'queued' || outcome.outcome === 'running' ? 202 : 200).send(outcome);
  });
};

export default attackStatsRoutes;
export { attackStatsRoutes };
