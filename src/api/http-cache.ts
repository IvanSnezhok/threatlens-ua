import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

// ------------------------------------------------------------------------------------------------
// HTTP caching for the public read routes
// ------------------------------------------------------------------------------------------------

/**
 * The one response cache of this server, in a module of its own.
 *
 * It was born inside `./server.ts` and serves `/api/v1/snapshot` and `/api/v1/locations` from there;
 * `./vector-routes.ts` needs exactly the same machinery for `/api/v1/vectors`, and it may not import
 * it from `./server.ts`. That is not taste, it is a proof: `src/api/vector-isolation.test.ts` walks
 * the module graph out of every module that builds a public payload and fails if any of them can
 * reach `./ops-vector-routes.js` or `../services/vector-projection.js`. `server.ts` is the
 * composition root and registers the ops plugins, so one import of it from a public route plugin
 * would put the operator-only extrapolation one refactor away from a public response. This module
 * has no relative imports at all, so it cannot carry that edge — and a second, parallel copy of the
 * helper inside `vector-routes.ts` would be the other way to lose the property, by letting the two
 * copies drift on what `no-store` means.
 */

/**
 * Per-reply override for the server-wide `Cache-Control: no-store`.
 *
 * `occupation-routes.ts` and `attack-analytics-routes.ts` solve the same problem with a child `onSend`
 * hook, because they are encapsulated plugins and a child hook runs after the inherited one. The
 * snapshot and locations routes are declared directly on the root instance, where that trick is
 * unavailable — a root hook has nothing to run after. So the root hook itself reads the override, and
 * every route that does not set it keeps `no-store`, byte for byte as before.
 */
const CACHE_CONTROL = Symbol('cacheControl');

/**
 * What {@link sendCached} asked for on this reply, for the one `onSend` hook that applies it.
 *
 * The symbol stays private to this module so the override cannot be set by anything but the helper
 * that also emits the matching `ETag`.
 */
export function cacheControlOverride(reply: FastifyReply): string | undefined {
  return (reply as unknown as Record<symbol, string | undefined>)[CACHE_CONTROL];
}

/** RFC 9110 §8.8.3.2 weak comparison — the only comparison `If-None-Match` is defined to use. */
function etagMatches(header: string, etag: string): boolean {
  if (header.trim() === '*') return true;
  const normalize = (value: string) => value.trim().replace(/^W\//, '');
  const wanted = normalize(etag);
  return header.split(',').some((candidate) => normalize(candidate) === wanted);
}

function ifNoneMatch(request: FastifyRequest, etag: string): boolean {
  const header = request.headers['if-none-match'];
  const value = Array.isArray(header) ? header[0] : header;
  return Boolean(value) && etagMatches(value, etag);
}

/**
 * A body already committed to bytes, with everything a conditional GET needs.
 *
 * The SERIALISED body is what is held, never the row objects: these routes answer with megabytes,
 * and caching the rows would still pay `JSON.stringify` per request and would still let the
 * old-space high-water mark grow with every coinciding request.
 *
 * A `Buffer`, not a string, and that is the difference between the memo bounding memory and merely
 * bounding CPU. `socket.write(string)` ENCODES, so a cached string is copied to fresh bytes once per
 * reader; `socket.write(buffer)` queues the buffer by reference, so every reader of a burst shares
 * the one allocation. Measured with `scripts/memory-benchmark.ts` against a 31 000-row catalogue
 * (3.84 MiB body): 100 coinciding readers took the old-space high-water mark to 815 MiB as strings
 * — past `--max-old-space-size=640` and fatal — against 39 MiB as a buffer. The route was safe for
 * many concurrent readers in statements long before it was safe in bytes.
 */
export interface CachedBody {
  body: Buffer;
  /** Strong validator: the bytes are hashed, so equality really is byte equality. */
  etag: string;
  expiresAt: number;
  cacheControl: string;
}

export function strongEtag(body: Buffer): string {
  return `"${createHash('sha1').update(body).digest('base64url')}"`;
}

/**
 * A memo that is also a single flight.
 *
 * The single flight is the half that matters for «безпечно для багатьох одночасних читачів»: without
 * it, N readers arriving inside one computation each run the whole computation, so a refresh burst
 * multiplies the pool load by N exactly when the pool is least able to absorb it. With it, at most
 * one computation is ever in the air and the N−1 late arrivals await the same promise — which is
 * sound here because every body is a pure function of database state read at a single instant, and
 * the publication cutoff is monotonic (`GREATEST(now() - delay, mode_changed_at)`), so a shared
 * answer is always an EARLIER valid slice, never a later one. Serving something slightly older can
 * never publish held material; only serving something newer could, and nothing here can.
 *
 * `keyOf` is what makes that argument survive a publication MODE flip, which is the one event that
 * moves the cutoff backward (live→delayed retracts the hold). A caller whose body depends on the
 * mode returns it from `keyOf`; a key change is then a miss for the memo AND for the flight, so a
 * body computed under a LATER cutoff can never be handed to a reader entitled only to an EARLIER
 * one. Exactly one body and one flight are held — a flip EVICTS rather than accumulating a slot per
 * key, which also keeps the buffer high-water mark at one body per route.
 *
 * A rejected load is not cached and does not stick: the flight is cleared in `finally`, so the next
 * request retries rather than inheriting a failure for the length of the TTL.
 */
export function cachedBody<A = void>(
  load: (argument: A) => Promise<CachedBody>,
  keyOf: (argument: A) => unknown = () => undefined
): (argument: A) => Promise<CachedBody> {
  let cached: { key: unknown; view: CachedBody } | null = null;
  let inFlight: { key: unknown; promise: Promise<CachedBody> } | null = null;
  return (argument: A) => {
    const key = keyOf(argument);
    if (cached && cached.key === key && Date.now() < cached.view.expiresAt) return Promise.resolve(cached.view);
    if (inFlight && inFlight.key === key) return inFlight.promise;
    const flight = load(argument).then((view) => { cached = { key, view }; return view; });
    inFlight = { key, promise: flight };
    // `catch` before `finally` so this bookkeeping chain can never surface as an unhandled rejection;
    // the rejection itself still reaches every caller through `flight`.
    void flight.catch(() => undefined).finally(() => { if (inFlight?.promise === flight) inFlight = null; });
    return flight;
  };
}

/** 304 when the client already holds these bytes, the bytes themselves otherwise. */
export function sendCached(request: FastifyRequest, reply: FastifyReply, view: CachedBody) {
  (reply as unknown as Record<symbol, string>)[CACHE_CONTROL] = view.cacheControl;
  reply.header('ETag', view.etag);
  reply.header('Vary', 'Accept-Encoding');
  if (ifNoneMatch(request, view.etag)) return reply.code(304).send();
  return reply.type('application/json; charset=utf-8').send(view.body);
}
