import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { backfillLimits, backfillSweepRunning, readBackfillProgress } from '../services/source-backfill.js';
import { hasValidOpsAuth } from './ops-auth.js';

function authorised(request: FastifyRequest): boolean {
  return hasValidOpsAuth(request.headers.authorization);
}

function unauthorized(reply: FastifyReply) {
  return reply.header('WWW-Authenticate', 'Basic realm="ThreatLens Ops"').code(401).send({ error: 'unauthorized' });
}

/**
 * The sentence that keeps the two contours apart on the page itself.
 *
 * An operator looking at a backfill table with fifty channels in it will ask where the official
 * alert channels are. They are backfilled by `src/sources/telegram.ts` on reconnect, through a
 * completely separate window that folds to one terminal state per location, and nothing on this page
 * describes them. Saying so here costs one line and prevents the conclusion that alert channels are
 * silently not being caught up.
 */
const NOTICE = 'Офіційні alert-канали дозбираються окремим контуром і сюди не входять.';

/**
 * Read-only operator view of the catch-up backfill.
 *
 * A separate plugin registered without `fastify-plugin`, exactly like `./ops-runtime-routes.ts`: the
 * Basic-auth guard belongs to these routes and has no business leaking onto every response the
 * server sends. The path starts with `/ops/` including the slash, because `setNotFoundHandler` in
 * `server.ts` JSON-404s only `/api/`, `/health/` and `/ops/`.
 *
 * **There is deliberately no manual trigger.** The obvious button — «дозібрати зараз» — is the exact
 * request shape that earns a flood wait: an operator pressing it during an incident fires a history
 * burst down the same connection the live stream is arriving on, and an operator who does not see an
 * immediate change presses it again. The sweep re-checks every `CHECK_INTERVAL_SECONDS` on its own,
 * the thresholds that decide are on this response, and a gap that deserves a backfill will get one
 * without anybody clicking. Read-only is the feature.
 */
const opsBackfillRoutes: FastifyPluginAsync = async (app) => {
  app.get('/ops/api/backfill', async (request, reply) => {
    if (!authorised(request)) return unauthorized(reply);
    const limits = backfillLimits();
    const sources = await readBackfillProgress();
    return {
      // The thresholds ride with the rows for the same reason the trust methodology rides with the
      // trust scores: «розрив 42 хв, пропущено» is a number an operator can only accept or reject,
      // and «поріг 60 хв» turns it into a claim they can check.
      thresholds: {
        enabled: limits.enabled,
        minGapSeconds: limits.minGapSeconds,
        maxAgeSeconds: limits.maxAgeSeconds,
        maxMessages: limits.maxMessages,
        maxPages: limits.maxPages,
        pageSize: limits.pageSize,
        maxSourcesPerSweep: limits.maxSourcesPerSweep,
        minRerunSeconds: limits.minRerunSeconds,
        checkIntervalSeconds: limits.checkIntervalSeconds
      },
      sources,
      // «Обмежено» is not «помилка», and the console must not colour it as one: truncation means the
      // configured bounds did their job, and the run that reports it succeeded.
      sweep: {
        lastAt: sources.reduce<string | null>(
          (newest, source) => (source.lastCheckedAt && (!newest || source.lastCheckedAt > newest)
            ? source.lastCheckedAt : newest),
          null
        ),
        running: backfillSweepRunning()
      },
      notice: NOTICE
    };
  });
};

export default opsBackfillRoutes;
export { opsBackfillRoutes };
