import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import { publicationSlice, type PublicationSlice } from '../services/publication.js';
import {
  REPORTED_VECTOR_DISCLAIMER,
  reportedVectorForEvent,
  reportedVectorsForLiveEvents,
  threatEventExists
} from '../services/threat-vectors.js';
import { cachedBody, sendCached, strongEtag } from './http-cache.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * How long one already-built chain payload may be reused.
 *
 * One second is the cadence of `EventHub`'s own poll, and the same ceiling `/api/v1/snapshot`
 * holds itself to, so a reader can never be handed a chain staler than the feed that told them to
 * refetch in the first place.
 *
 * Zero under `NODE_ENV=test`, exactly as `snapshotMemoMs` is and for exactly the same reason: the
 * integration harness truncates between tests and re-seeds with direct INSERTs that append nothing
 * to `system_event_log`, so NO key derivable from the publication slice changes between one test's
 * data and the next's — an across-request TTL then hands the following test the previous test's
 * chains whenever the two land inside the same second, which is most of them. The single flight is
 * untouched and stays on everywhere; it is the half that collapses the thundering herd, and the
 * only half that has to be true of a running deployment.
 */
const VECTORS_MEMO_MS = config.NODE_ENV === 'test' ? 0 : 1_000;

/**
 * Public threat vectors: the chain of reported observations for live threat events.
 *
 * Nothing reachable from this file reaches `../services/vector-projection.js`. The chains come from
 * `../services/threat-vectors.js`, which reaches only the classification archive; the cutoff comes
 * from `../services/publication.js`; the response cache comes from `./http-cache.js`, which has no
 * relative imports at all and is its own module for exactly this reason — the same helper lives on
 * `./server.ts`'s routes, and importing it FROM there would drag the composition root, and with it
 * `./ops-vector-routes.js`, into this file's import graph. `src/api/vector-isolation.test.ts` walks
 * that graph on every run to prove the property. The operator-only extrapolation is registered by a
 * different plugin, `./ops-vector-routes.js`, which is the only file in the project allowed to name
 * the `ops_` tables.
 *
 * Registered without `fastify-plugin`, matching `./occupation-routes.ts`: the encapsulation keeps
 * anything added here from reaching the rest of the server. The list route is still served
 * `no-store` — the server-wide JSON policy, now said out loud by `sendCached` instead of inherited,
 * and still correct: a chain changes the moment another source reports. The one-second
 * single-flight memo inside it coalesces the thundering herd of map clients that refetch on the
 * same SSE event, and hands every one of them the same bytes.
 */
const vectorRoutes: FastifyPluginAsync = async (app) => {
  /**
   * A one-second single-flight memo for the chain payload, keyed on the publication mode.
   *
   * The map refetches this on every SSE event, so N clients inside one event each ran the whole
   * per-live-event chain query — the same thundering herd the snapshot route already collapses.
   * The memo coalesces them into one query per second, and what it holds is the SERIALISED body:
   * memoising the item objects still paid a `JSON.stringify` over every chain per reader and still
   * let the old-space high-water mark grow with every coinciding request — the exact failure
   * `cachedBody` was written for on the snapshot route, where it measured 815 MiB against 39 MiB
   * for 100 coinciding readers. `generatedAt` is minted INSIDE the memo for the same reason: built
   * per request it would change the bytes, and therefore the strong ETag, on every single request,
   * which is the one thing a validator that claims byte equality may not do.
   *
   * The key is the MODE, not the wall clock and not the cutoff. Within a mode the cutoff is
   * monotonic (`GREATEST(now() - delay, mode_changed_at)` only advances), so a shared answer is
   * always an EARLIER valid slice — the same guarantee the snapshot route relies on. A mode flip
   * is the one thing that moves the cutoff backward (live→delayed retracts the hold), and a body
   * computed under a LATER cutoff must never be served for an EARLIER one, or held material leaks.
   * Keying on the mode makes a flip a cache miss (recompute under the new mode's cutoff) while a
   * forward tick within the same mode still coalesces. A rejected load is not cached: the flight
   * is cleared in `finally`, so the next request retries rather than inheriting a failure.
   */
  const liveView = cachedBody(async (slice: PublicationSlice) => {
    const body = Buffer.from(JSON.stringify({
      generatedAt: new Date().toISOString(),
      disclaimer: REPORTED_VECTOR_DISCLAIMER,
      items: await reportedVectorsForLiveEvents(slice.cutoffAt)
    }));
    // `no-store` in BOTH modes, which is what this route already inherited from the server-wide
    // JSON policy — stated explicitly here because `sendCached` sets the header itself. In
    // `delayed_15s` it is load-bearing: a held chain must not be written down anywhere it could
    // outlive the hold. In `live` it is the honest answer for a payload that changes the moment
    // another source reports, and the map fetches it with `cache: 'no-store'` regardless. The ETag
    // still ships, so a client that does revalidate is answered with 304 instead of megabytes.
    return { body, etag: strongEtag(body), expiresAt: Date.now() + VECTORS_MEMO_MS, cacheControl: 'no-store' };
  }, (slice) => slice.mode);
  /** Every live chain, in one request. This is what the map layer consumes. */
  app.get('/api/v1/vectors', async (request, reply) => {
    try {
      // Inside the try on purpose: a failed slice must degrade to "no chains" exactly as a failed
      // chain query does, never to a 500 the map has to special-case.
      const slice = await publicationSlice();
      return sendCached(request, reply, await liveView(slice));
    } catch (error) {
      // The chain is an explanatory overlay on top of markers the map already draws. A failure here
      // must degrade to "no chains", never to a broken map, and never to a 500 the client has to
      // special-case.
      request.log.error({ error: String(error) }, 'reported vectors unavailable, serving empty list');
      return reply.send({ generatedAt: new Date().toISOString(), disclaimer: REPORTED_VECTOR_DISCLAIMER, items: [] });
    }
  });

  app.get<{ Params: { id: string } }>('/api/v1/threats/:id/vector', async (request, reply) => {
    if (!uuidPattern.test(request.params.id)) return reply.code(400).send({ error: 'invalid_id' });
    // Visibility is decided FIRST, before any chain is computed. An event created after the cutoff
    // must 404 exactly as `/api/v1/threats/:id` does, and computing its chain before deciding that
    // would be work done only to throw away — on the same pool the snapshot is competing for.
    const slice = await publicationSlice();
    if (!(await threatEventExists(request.params.id, slice.cutoffAt))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    // The SAME slice the visibility check above used, threaded into the chain: `threatEventExists`
    // only decides whether the event may be seen at all, and without this the chain of a published
    // event still grows nodes and segments out of classifications recorded after the cutoff.
    const vector = await reportedVectorForEvent(request.params.id, slice.cutoffAt);
    if (vector) return vector;
    // "This event has no chain" and "this event does not exist" are different answers, and the
    // client renders them differently: the first is an ordinary single-message threat.
    //
    // `threatType` is null here for the same reason `strongestBasis` is: this envelope describes a
    // chain that does not exist, and every field of it that describes one is empty. The class of the
    // EVENT is not missing — it is on `/api/v1/threats/:id`, which is the payload that owns it.
    return reply.send({
      eventId: request.params.id,
      kind: 'reported_observation_chain',
      threatType: null,
      disclaimer: REPORTED_VECTOR_DISCLAIMER,
      nodes: [], segments: [],
      span: {
        from: null, to: null, elapsedSeconds: 0, sourceCount: 0,
        independenceGroupCount: 0, drawableSegments: 0, strongestBasis: null
      }
    });
  });
};

export default vectorRoutes;
export { vectorRoutes };
