import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  OBLAST, appendSystemEvent, delay, ensureMigrated, integrationDatabaseAvailable,
  resetDatabase, seedThreatEvent, sql
} from '../helpers/db.js';

/**
 * What the read path in front of `/api/v1/snapshot` and `/api/v1/locations` is allowed to do, and
 * what it may never do.
 *
 * Three separate claims are under test here, and they are not the same claim:
 *
 *  1. **The single flight bounds pool load by the computation, not by the reader count.** A burst of
 *     readers must cost one batch of statements, not one batch each. This is the property that makes
 *     the endpoint safe for «багато одночасних читачів»; it is on in every environment, including
 *     this one.
 *  2. **The memo may only ever hand back an EARLIER slice.** The publication cutoff is monotonic, so
 *     a body computed a moment ago can be stale but can never contain held material. The delayed-mode
 *     cases below are the ones that would catch a memo that had somehow inverted that.
 *  3. **Caching is expressed honestly over HTTP.** `no-store` while the hold is on, `no-cache` (store
 *     permitted, revalidation mandatory) in live, and a real `public, max-age` only for the location
 *     catalogue, which has no publication semantics at all.
 *
 * Two servers, deliberately. `app` is built exactly as production builds it — under `NODE_ENV=test`
 * the memo TTL defaults to zero, because the harness seeds `threat_events` and `alert_periods` with
 * direct INSERTs that append nothing to `system_event_log`, so nothing derivable from the slice
 * changes between one test's data and the next's. `memoApp` passes the TTL explicitly, which is the
 * only way the memo itself gets covered rather than merely configured.
 *
 * **Harness (a) of CONTRACT §12 wave 3**: both routes are declared inline inside `buildServer()`, and
 * `app.inject()` cannot observe the header interplay between the server-wide `onSend` and a 304 — so
 * the servers are listened on ephemeral ports and read with a real `fetch`.
 */

/** The ceiling `buildServer()` clamps to, restated here so a change to it has to be deliberate. */
const MEMO_MS = 1000;

let app: FastifyInstance;
let baseUrl = '';
let memoApp: FastifyInstance;
let memoBaseUrl = '';

async function setMode(mode: 'live' | 'delayed_15s'): Promise<void> {
  // `mode_changed_at` an hour back so the monotonic `GREATEST(now() - delay, mode_changed_at)` clamp
  // is not what decides the cutoff — the hold is.
  await sql(
    `UPDATE runtime_settings SET publication_mode=$1, mode_changed_at=now() - interval '1 hour', updated_at=now()`,
    [mode]
  );
  (await import('../../src/services/runtime-settings.js')).resetRuntimeSettingsCache();
}

/** Past the memo ceiling, so the next read of `memoApp` is a fresh computation rather than a leftover. */
const pastTheMemo = () => delay(MEMO_MS + 150);

interface QueryTally { count: () => number; stop: () => void }

/**
 * Counts statements the APPLICATION pool issues. The harness has its own pool (`tests/helpers/db.ts`),
 * so seeding and assertions never show up in this number.
 */
async function tallyQueries(): Promise<QueryTally> {
  const { pool } = await import('../../src/db/pool.js');
  const spy = vi.spyOn(pool, 'query');
  return { count: () => spy.mock.calls.length, stop: () => spy.mockRestore() };
}

function openStream(base: string, path = '/api/v1/stream') {
  const controller = new AbortController();
  let text = '';
  const pump = (async () => {
    try {
      const response = await fetch(`${base}${path}`, { signal: controller.signal });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch { /* the abort below is the exit condition */ }
  })();
  return {
    async close(): Promise<string> {
      controller.abort();
      await pump;
      return text;
    }
  };
}

/** The raw `data:` lines of the non-`connected` frames, uninterpreted — byte comparison is the point. */
function dataLines(text: string): string[] {
  return text.split('\n\n')
    .filter((block) => block.includes('data: ') && !block.includes('event: connected'))
    .map((block) => block.split('\n').find((line) => line.startsWith('data: '))!);
}

describe.skipIf(!integrationDatabaseAvailable)('snapshot and catalogue caching', () => {
  beforeAll(async () => {
    await ensureMigrated();
    const { buildServer } = await import('../../src/api/server.js');
    app = await buildServer();
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    memoApp = await buildServer({ snapshotMemoMs: MEMO_MS });
    memoBaseUrl = await memoApp.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app?.close();
    await memoApp?.close();
  });

  // The five in-process seams of CONTRACT §1.4 beside the TRUNCATE, in the order documented in
  // `tests/helpers/db.ts`.
  beforeEach(async () => {
    await resetDatabase();
    (await import('../../src/services/runtime-settings.js')).resetRuntimeSettingsCache();
    (await import('../../src/services/sse.js')).resetEventHubCursor();
    (await import('../../src/services/analytics-scheduler.js')).resetAnalyticsScheduler();
    (await import('../../src/services/risk.js')).resetRiskRunGuard();
    (await import('../../src/services/analytics-narrative.js')).resetAnalyticsNarrativeMemo();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    (await import('../../src/services/sse.js')).eventHub.stop();
  });

  // ----------------------------------------------------------------------------------------------
  describe('the single flight', () => {
    it('serves a burst of readers with fewer statements than there are readers', async () => {
      // Warm the runtime-settings memo first, so its one statement is not counted as fan-out.
      await fetch(`${baseUrl}/api/v1/snapshot`);

      const tally = await tallyQueries();
      const responses = await Promise.all(
        Array.from({ length: 25 }, () => fetch(`${baseUrl}/api/v1/snapshot`))
      );
      const bodies = await Promise.all(responses.map((response) => response.text()));
      const statements = tally.count();
      tally.stop();

      expect(responses.map((response) => response.status)).toEqual(Array(25).fill(200));
      // One computation is six statements — the slice, the four concurrent reads, the ancestry walk.
      // Without coalescing, twenty-five readers cost at least a hundred and fifty. Comparing against
      // the reader count rather than a magic number is what makes this survive a repository growing
      // a statement: fewer statements than readers is not reachable by any per-request path.
      expect(statements).toBeLessThan(responses.length);
      expect(statements).toBeGreaterThan(0);
      // And they were served one answer, not twenty-five inconsistent ones.
      const versions = new Set(bodies.map((body) => JSON.parse(body).version));
      expect(versions.size).toBe(1);
    });

    it('keeps every reader of a burst on a live pool that is capped at two connections', async () => {
      // The four snapshot reads run concurrently against `max: 2` under NODE_ENV=test. `pool.query()`
      // checks a client out and gives it back, so the surplus queues rather than deadlocking — but
      // "it should queue" is exactly the kind of claim that deserves a test rather than a comment.
      await seedThreatEvent({ locationIds: [OBLAST] });

      const responses = await Promise.all(
        Array.from({ length: 20 }, () => fetch(`${baseUrl}/api/v1/snapshot`))
      );
      const bodies = await Promise.all(responses.map((response) => response.json() as Promise<any>));

      expect(responses.every((response) => response.ok)).toBe(true);
      expect(bodies.every((body) => Array.isArray(body.threats) && body.threats.length === 1)).toBe(true);
      expect(bodies.every((body) => body.territories.length > 0)).toBe(true);
    });

    it('does not cache a failure: the next reader retries', async () => {
      // Every statement, not just the first: `resolveRuntimeSettings` fails OPEN to `live` by design,
      // so a single rejection is absorbed before it ever reaches the slice and the snapshot would
      // answer 200 for the wrong reason.
      const { pool } = await import('../../src/db/pool.js');
      const failing = vi.spyOn(pool, 'query').mockRejectedValue(new Error('pool is having a moment'));

      const broken = await fetch(`${baseUrl}/api/v1/snapshot`);
      expect(broken.status).toBe(500);

      failing.mockRestore();

      // The flight is cleared in `finally`, so the failure is neither remembered nor left in the air
      // for the length of a TTL — the very next reader gets a fresh computation.
      const recovered = await fetch(`${baseUrl}/api/v1/snapshot`);
      expect(recovered.status).toBe(200);
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('the memo', () => {
    it('answers a second reader inside the ceiling without touching the database', async () => {
      await pastTheMemo();
      await fetch(`${memoBaseUrl}/api/v1/snapshot`);

      const tally = await tallyQueries();
      const first = await fetch(`${memoBaseUrl}/api/v1/snapshot`);
      const second = await fetch(`${memoBaseUrl}/api/v1/snapshot`);
      const statements = tally.count();
      tally.stop();

      expect(statements).toBe(0);
      expect(await first.text()).toBe(await second.text());
      expect(first.headers.get('etag')).toBe(second.headers.get('etag'));
    });

    it('recomputes once the ceiling has passed', async () => {
      const first = await fetch(`${memoBaseUrl}/api/v1/snapshot`);
      const firstEtag = first.headers.get('etag');
      const firstBody = await first.json() as any;

      await pastTheMemo();

      const second = await fetch(`${memoBaseUrl}/api/v1/snapshot`);
      const secondBody = await second.json() as any;

      expect(second.headers.get('etag')).not.toBe(firstEtag);
      // `generatedAt` IS the cutoff, so a recomputation is visible as the cutoff having moved on.
      expect(Date.parse(secondBody.generatedAt)).toBeGreaterThan(Date.parse(firstBody.generatedAt));
    });

    it('never hands back a slice newer than the hold allows', async () => {
      await setMode('delayed_15s');
      await pastTheMemo();
      // Fill the memo BEFORE the event exists, then write the event: if the memo were ever consulted
      // in the wrong direction — a later body served for an earlier request — this is where it would
      // show. It cannot be, and the assertion after the ceiling proves the hold is what releases it.
      await fetch(`${memoBaseUrl}/api/v1/snapshot`);
      const version = await appendSystemEvent('threat.created', { eventId: 'memo-held' });

      const held = await fetch(`${memoBaseUrl}/api/v1/snapshot`);
      const body = await held.json() as any;

      expect(body.version).toBeLessThan(version);
      expect(body.publication.mode).toBe('delayed_15s');
      expect(body.publication.behindSeconds).toBeGreaterThanOrEqual(14);

      // And once the row is older than the cutoff it is released — the memo delays release by at most
      // its own ceiling, it does not prevent it.
      await sql(`UPDATE system_event_log SET created_at = created_at - interval '30 seconds' WHERE version=$1`, [version]);
      await pastTheMemo();
      expect(((await (await fetch(`${memoBaseUrl}/api/v1/snapshot`)).json()) as any).version).toBe(version);
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('conditional requests', () => {
    it('answers 304 to a reader that already holds the bytes', async () => {
      await pastTheMemo();
      const first = await fetch(`${memoBaseUrl}/api/v1/snapshot`);
      const etag = first.headers.get('etag');

      expect(etag).toMatch(/^"[\w-]+"$/);

      const second = await fetch(`${memoBaseUrl}/api/v1/snapshot`, { headers: { 'If-None-Match': etag! } });

      expect(second.status).toBe(304);
      expect(await second.text()).toBe('');
      // A 304 must still carry the caching rule, or the client is told to discard what it just
      // revalidated. The server-wide onSend sets `no-store` on JSON and a 304 has no content type,
      // which is exactly the interplay this pins.
      expect(second.headers.get('cache-control')).toBe('no-cache');
      expect(second.headers.get('etag')).toBe(etag);
    });

    it('answers 200 to a reader holding a validator that is no longer current', async () => {
      const response = await fetch(`${memoBaseUrl}/api/v1/snapshot`, {
        headers: { 'If-None-Match': '"not-the-bytes-you-have"' }
      });

      expect(response.status).toBe(200);
      expect(((await response.json()) as any).publication).toBeDefined();
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('what the cache headers promise', () => {
    it('forbids storing the snapshot outright while the hold is on', async () => {
      await setMode('delayed_15s');

      const response = await fetch(`${baseUrl}/api/v1/snapshot`);

      // Unchanged from before this cache layer existed: caching a held payload would make the hold
      // unbounded, and `no-store` is the only header that cannot be worked around by a stale-serving
      // intermediary.
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('etag')).toBeTruthy();
    });

    it('permits storage but demands revalidation in live mode', async () => {
      const response = await fetch(`${baseUrl}/api/v1/snapshot`);

      expect(response.headers.get('cache-control')).toBe('no-cache');
      expect(response.headers.get('vary')).toBe('Accept-Encoding');
    });

    it('leaves every other JSON route on no-store', async () => {
      // The server-wide hook now consults a per-reply override. A route that does not set one must be
      // byte-for-byte as it was, or this change would have quietly made the whole API cacheable.
      // `/api/v1/locations/:id/timeline` is in the list on purpose: it shares a prefix with the one
      // route in this file that IS now cacheable, and it is publication-gated, so a header rule
      // written by path prefix rather than per route would publish held material from a browser cache.
      for (const path of [
        '/api/v1/threats', '/api/v1/alerts', '/api/v1/assessments', '/api/v1/config',
        `/api/v1/locations/${OBLAST}/timeline`
      ]) {
        const response = await fetch(`${baseUrl}${path}`);
        expect(response.headers.get('cache-control'), path).toBe('no-store');
      }
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('the location catalogue', () => {
    it('is cacheable, validated, and unchanged in content', async () => {
      const response = await fetch(`${baseUrl}/api/v1/locations`);
      const rows = await response.json() as Array<Record<string, unknown>>;

      expect(response.headers.get('cache-control')).toBe('public, max-age=900, stale-while-revalidate=3600');
      expect(response.headers.get('etag')).toMatch(/^"[\w-]+"$/);
      expect(response.headers.get('vary')).toBe('Accept-Encoding');
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
      expect(Object.keys(rows[0]!).sort())
        .toEqual(['id', 'latitude', 'longitude', 'name_uk', 'parent_id', 'type']);
    });

    it('answers 304 with the caching rule intact', async () => {
      const first = await fetch(`${baseUrl}/api/v1/locations`);
      const etag = first.headers.get('etag')!;

      const second = await fetch(`${baseUrl}/api/v1/locations`, { headers: { 'If-None-Match': etag } });

      expect(second.status).toBe(304);
      expect(await second.text()).toBe('');
      expect(second.headers.get('cache-control')).toBe('public, max-age=900, stale-while-revalidate=3600');
      // Weak-comparison forms of the same validator are the same validator.
      const weak = await fetch(`${baseUrl}/api/v1/locations`, { headers: { 'If-None-Match': `W/${etag}` } });
      expect(weak.status).toBe(304);
      const wildcard = await fetch(`${baseUrl}/api/v1/locations`, { headers: { 'If-None-Match': '*' } });
      expect(wildcard.status).toBe(304);
    });

    it('reads the catalogue once for a burst of readers', async () => {
      await fetch(`${baseUrl}/api/v1/locations`);

      const tally = await tallyQueries();
      const responses = await Promise.all(
        Array.from({ length: 15 }, () => fetch(`${baseUrl}/api/v1/locations`))
      );
      const statements = tally.count();
      tally.stop();

      expect(responses.every((response) => response.ok)).toBe(true);
      // The fifteen-minute memo was already there; what this pins is that it is now also the thing
      // the ETag is derived from, so a burst costs no statements at all.
      expect(statements).toBe(0);
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('one serialisation per live event', () => {
    it('gives two open streams byte-identical frames for the same event', async () => {
      const { eventHub } = await import('../../src/services/sse.js');
      eventHub.start();
      const left = openStream(baseUrl);
      const right = openStream(baseUrl);
      // Let both connections finish their handshake before the event exists, so both take it from
      // the hub's live emit — which is the path that shares one envelope object between them.
      await delay(300);

      await appendSystemEvent('alert.started', { alertId: 'shared-frame' });
      await delay(1600);

      const leftFrames = dataLines(await left.close());
      const rightFrames = dataLines(await right.close());

      expect(leftFrames.length).toBe(1);
      expect(rightFrames).toEqual(leftFrames);
      const payload = JSON.parse(leftFrames[0]!.slice(6));
      expect(payload.eventType).toBe('alert.started');
      expect(payload.envelopeVersion).toBe(2);
      expect(payload.delayMode).toBe('live');
    });
  });
});
