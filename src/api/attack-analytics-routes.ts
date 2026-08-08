import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { ATTACK_PERIODS, attackAnalytics, isAttackPeriod } from '../services/attack-analytics.js';

/**
 * The public «Аналіз атак» endpoint.
 *
 * A separate plugin, and not another route inside `analytics-routes.ts`, for one decisive reason:
 * that file installs an `onRequest` hook that demands operator credentials for *every* route it
 * owns. Adding a public route there would mean either weakening that guard or special-casing one
 * path inside it, and both are how an operator-only archive ends up published by accident. A
 * separate encapsulated plugin cannot make that mistake — the guard and this route never share a
 * scope.
 *
 * Registered from `buildServer()` next to the other plugins, without fastify-plugin, so the cache
 * hook below stays on this route instead of leaking onto every response.
 */

/**
 * Two minutes public, an hour of stale-while-revalidate.
 *
 * The service memoises the same window for the same two minutes, so this header does not make a
 * reader see anything staler than the origin would have served them anyway; what it buys is that a
 * CDN or the browser absorbs a refresh burst instead of the archive doing so. The long
 * `stale-while-revalidate` is deliberate: an aggregate over the last month that is an hour old is
 * still a true statement about the last month, and this page is not, and must never be mistaken
 * for, an alerting surface where staleness is dangerous.
 */
const CACHEABLE = 'public, max-age=120, stale-while-revalidate=3600';
const CACHE_CONTROL = Symbol('attackAnalyticsCacheControl');

function setCacheControl(reply: FastifyReply, value: string): void {
  (reply as unknown as Record<symbol, string>)[CACHE_CONTROL] = value;
}

interface AttacksQuery {
  period?: string;
}

const attackAnalyticsRoutes: FastifyPluginAsync = async (app) => {
  // The server-wide onSend hook forces `Cache-Control: no-store` on every JSON response. Child hooks
  // run after inherited ones, which is what lets this one put the header back for this route only.
  app.addHook('onSend', async (_request, reply, payload) => {
    const value = (reply as unknown as Record<symbol, string | undefined>)[CACHE_CONTROL];
    if (value) reply.header('Cache-Control', value);
    return payload;
  });

  app.get<{ Querystring: AttacksQuery }>('/api/v1/analytics/attacks', async (request, reply) => {
    const period = request.query.period ?? 'day';
    if (!isAttackPeriod(period)) {
      return reply.code(400).send({ error: 'invalid_period', expected: ATTACK_PERIODS });
    }
    const payload = await attackAnalytics(period);
    setCacheControl(reply, CACHEABLE);
    return payload;
  });
};

export default attackAnalyticsRoutes;
export { attackAnalyticsRoutes };
