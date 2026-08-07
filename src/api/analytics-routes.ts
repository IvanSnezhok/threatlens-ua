import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import {
  AnalyticsInputError,
  archiveCoverage,
  classifierVersionComparison,
  geographyShift,
  lossPoints,
  resolveWindow,
  sourcePerformance,
  strategicOverview,
  strikeComposition,
  threatTypeDynamics,
  type AnalyticsWindow
} from '../services/analytics-archive.js';
import { narrateOverview } from '../services/analytics-narrative.js';

/**
 * Operator-only analytics over the classification archive.
 *
 * A separate plugin rather than more routes in `src/api/server.ts`, for the same reason
 * `occupation-routes.ts` is one: this is a self-contained surface with its own auth check, its own
 * error mapping and its own cache policy, and it has no business widening the file every other
 * feature also has to touch.
 *
 * Register it from `buildServer()` with a single line, next to the occupation plugin:
 *
 * ```ts
 * import analyticsRoutes from './analytics-routes.js';
 * await app.register(analyticsRoutes);
 * ```
 *
 * ## Why the auth check is duplicated
 *
 * `hasValidOpsAuth` in `src/api/server.ts` is module-private and this plugin must not be the reason
 * that file changes. The check below is the same one, character for character: constant-time
 * comparison of both halves of the Basic credential against `OPS_USER`/`OPS_PASSWORD`. If the
 * server-side helper is ever exported, delete this copy and import it — there should be exactly one
 * definition of who an operator is, and today there are two.
 *
 * Everything here is behind that check without exception. The archive contains the raw decisions of
 * the classifier over every message from every monitored channel, including the ones it got wrong;
 * that is an internal diagnostic surface, not a public dataset.
 */

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function hasValidOpsAuth(authorization?: string) {
  if (!authorization?.startsWith('Basic ')) return false;
  const [user, password] = Buffer.from(authorization.slice(6), 'base64').toString().split(':');
  return safeEqual(user ?? '', config.OPS_USER) && safeEqual(password ?? '', config.OPS_PASSWORD);
}

interface AnalyticsQuery {
  from?: string;
  to?: string;
  bucket?: string;
  /** Repeatable, or comma-separated. Absent means "every version, still broken out per version". */
  version?: string | string[];
  threatType?: string;
  oblast?: string;
  limit?: string;
  baseline?: string;
  candidate?: string;
}

function versions(query: AnalyticsQuery): string[] | null {
  const raw = query.version;
  if (raw == null) return null;
  const values = (Array.isArray(raw) ? raw : [raw]).flatMap((value) => value.split(','))
    .map((value) => value.trim()).filter(Boolean);
  return values.length ? values : null;
}

function windowFrom(query: AnalyticsQuery): AnalyticsWindow {
  return resolveWindow({
    from: query.from ?? null,
    to: query.to ?? null,
    bucket: query.bucket ?? null,
    classifierVersions: versions(query),
    threatType: query.threatType ?? null,
    oblastId: query.oblast ?? null,
    limit: query.limit == null ? null : Number(query.limit)
  });
}

type Handler = (window: AnalyticsWindow, query: AnalyticsQuery) => Promise<unknown>;

const analyticsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (hasValidOpsAuth(request.headers.authorization)) return;
    return reply.header('WWW-Authenticate', 'Basic realm="ThreatLens Ops"').code(401).send({ error: 'unauthorized' });
  });

  /**
   * One wrapper for every slice.
   *
   * `AnalyticsInputError` is the only error class the service raises for a caller's mistake, and it
   * carries its own code, so a rejected window comes back as a 400 naming the reason instead of a
   * 500 the operator has to go and read logs about. Anything else is a real failure and is left to
   * the server's error handler.
   */
  const slice = (path: string, handler: Handler) => {
    app.get<{ Querystring: AnalyticsQuery }>(path, async (request, reply) => {
      let window: AnalyticsWindow;
      try {
        window = windowFrom(request.query);
      } catch (error) {
        if (error instanceof AnalyticsInputError) return reply.code(400).send({ error: error.code, message: error.message });
        throw error;
      }
      try {
        return await handler(window, request.query);
      } catch (error) {
        if (error instanceof AnalyticsInputError) return reply.code(400).send({ error: error.code, message: error.message });
        throw error;
      }
    });
  };

  /** Which classifier versions exist, over what span. Ask this before choosing a window. */
  app.get('/ops/api/analytics/coverage', async () => archiveCoverage());

  /** Strike classes over time, overall and per oblast. */
  slice('/ops/api/analytics/threat-dynamics', (window) => threatTypeDynamics(window));

  /** Which oblasts are rising and which are falling against the immediately preceding window. */
  slice('/ops/api/analytics/geography-shift', (window) => geographyShift(window));

  /** Where threats stop: withdrawals by oblast, source and class, plus the interception rate. */
  slice('/ops/api/analytics/loss-points', (window) => lossPoints(window));

  /** Who reports first, who repeats, whose messages this project fails to read. */
  slice('/ops/api/analytics/sources', (window) => sourcePerformance(window));

  /** What waves are made of, and what the launch-side indicators are doing. */
  slice('/ops/api/analytics/strike-composition', (window) => strikeComposition(window));

  /** Two classifier versions over the messages they both judged. */
  slice('/ops/api/analytics/classifier-versions', (window, query) => {
    if (!query.baseline || !query.candidate) {
      throw new AnalyticsInputError('missing_versions', 'baseline and candidate query parameters are required');
    }
    return classifierVersionComparison(window, query.baseline, query.candidate);
  });

  /** Every slice for one window. */
  slice('/ops/api/analytics/overview', (window) => strategicOverview(window));

  /**
   * The overview with a written conclusion on top.
   *
   * The numbers are identical to `/overview` — the narrative is an extra field, never a substitute.
   * With `ANALYTICS_NARRATIVE_ENABLED=false`, or with no provider configured, or when the model
   * misses its timeout, returns invalid JSON or states a number the aggregates do not support, the
   * response still carries the full overview and a deterministic narrative whose `generatedBy` says
   * `deterministic`.
   */
  slice('/ops/api/analytics/narrative', async (window) => {
    const overview = await strategicOverview(window);
    return { ...overview, narrative: await narrateOverview(overview) };
  });
};

export default analyticsRoutes;
export { analyticsRoutes };
