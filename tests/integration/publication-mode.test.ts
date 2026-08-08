import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  OBLAST, appendSystemEvent, delay, ensureMigrated, integrationDatabaseAvailable,
  outboxRows, resetDatabase, runFanout, seedSubscription, seedUser, sql, waitFor
} from '../helpers/db.js';

/**
 * The acceptance criterion for «У live подія потрапляє в публічний SSE одразу після обробки; у
 * delayed_15s — не раніше 15 секунд і без повторів» and «Перемикання режиму під навантаженням не
 * губить і не переставляє події».
 *
 * Everything the hold touches is read here through the surfaces a reader actually uses — the
 * snapshot, the stream, `/alerts`, `/threats`, `/threats/:id`, `/assessments`, `/methodology` and the
 * public attack analytics — and everything it must NOT touch is read through the paths that bypass
 * it: `runFanout()` for Telegram, `processMessage` for ingestion, `syncOfficialAlerts` for the
 * official reconciler. A hold that quietly delayed a notification, or quietly dropped a message,
 * would pass a test that only looked at the public side.
 *
 * **Harness (a) of CONTRACT §12 wave 3.** `/api/v1/snapshot`, `/api/v1/stream`, `/api/v1/alerts`,
 * `/api/v1/threats/:id`, `/api/v1/history`, `/api/v1/methodology` and
 * `/api/v1/locations/:id/timeline` are declared inline inside `buildServer()`; there is no plugin to
 * register onto a bare instance, and `app.inject()` cannot consume an SSE stream against
 * `reply.hijack()`. So the server is built once, listened on an ephemeral port, and read with a real
 * `fetch` and an `AbortController` — the shape copied from `tests/integration/threat-vector.test.ts`.
 *
 * **Wall clock is exercised by backdating the column the code itself wrote, never by fake timers.**
 * Every ordering decision under test is taken inside PostgreSQL `now()`, which vitest cannot move;
 * `UPDATE system_event_log SET created_at = created_at - …` is the same thing as waiting, without
 * the wait.
 */

const UKRAINE_ALARM_URL = 'https://api.ukrainealarm.com/api/v3/alerts';
const WAR_MONITOR = 'osint-war-monitor';
const ALERT_START = '2026-02-01T20:00:00.000Z';

let app: FastifyInstance;
let baseUrl = '';

// ------------------------------------------------------------------------------------------------
// Reading the server
// ------------------------------------------------------------------------------------------------

async function getResponse(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

async function getJson<T = any>(path: string): Promise<T> {
  const response = await getResponse(path);
  return response.json() as Promise<T>;
}

interface Frame { id: number | null; event: string | null; data: any }

/**
 * The wire, parsed back. A `connected` frame carries `retry:`/`event:`/`data:` and no `id:`; a data
 * frame carries all three; a heartbeat is a comment line and has no `data:` at all.
 */
function parseFrames(text: string): Frame[] {
  return text.split('\n\n')
    .filter((block) => block.includes('data: '))
    .map((block) => {
      const lines = block.split('\n');
      const idLine = lines.find((line) => line.startsWith('id: '));
      const eventLine = lines.find((line) => line.startsWith('event: '));
      const dataLine = lines.find((line) => line.startsWith('data: '))!;
      return {
        id: idLine ? Number(idLine.slice(4)) : null,
        event: eventLine ? eventLine.slice(7) : null,
        data: JSON.parse(dataLine.slice(6))
      };
    });
}

const dataFrames = (text: string): Frame[] => parseFrames(text).filter((frame) => frame.event !== 'connected');
const deliveredIds = (text: string): number[] => dataFrames(text).map((frame) => frame.id!);
const connectedFrame = (text: string): Frame | undefined =>
  parseFrames(text).find((frame) => frame.event === 'connected');

/**
 * A live connection whose text can be inspected while it is still open.
 *
 * `readStream()` below is the "open, wait, hang up" form `threat-vector.test.ts` uses; the mode-flip
 * case needs the other one, because the events it asserts on are written *while* the connection is
 * up and the hold is being turned on and off underneath it.
 */
function openStream(path: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  let text = '';
  const pump = (async () => {
    try {
      const response = await fetch(`${baseUrl}${path}`, { headers, signal: controller.signal });
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
    seen: () => text,
    async close(): Promise<string> {
      controller.abort();
      await pump;
      return text;
    }
  };
}

/** Reads whatever the stream emits, including the replay backfill, then hangs up. */
async function readStream(millis: number, headers: Record<string, string> = {}, path = '/api/v1/stream'): Promise<string> {
  const stream = openStream(path, headers);
  await delay(millis);
  return stream.close();
}

// ------------------------------------------------------------------------------------------------
// Moving the clock and the switch
// ------------------------------------------------------------------------------------------------

/** Ages one log row by `seconds`, which is what the cutoff actually reads. */
async function backdate(version: number, seconds: number): Promise<void> {
  await sql(
    `UPDATE system_event_log SET created_at = created_at - make_interval(secs => $2) WHERE version = $1`,
    [version, seconds]
  );
}

async function resetSettingsCache(): Promise<void> {
  (await import('../../src/services/runtime-settings.js')).resetRuntimeSettingsCache();
}

/**
 * Flips the mode with `mode_changed_at` left an hour in the past, so the cutoff is
 * `now() - delaySeconds` and the hold is fully ramped in. This is the state a deployment is in
 * within fifteen seconds of any flip, and the one nearly every assertion below wants.
 */
async function setMode(mode: 'live' | 'delayed_15s'): Promise<void> {
  await sql(
    `UPDATE runtime_settings SET publication_mode=$1, mode_changed_at=now() - interval '1 hour', updated_at=now()`,
    [mode]
  );
  await resetSettingsCache();          // the harness pool is not the application pool
}

/** Flips the mode AT this instant, which is what makes the `GREATEST(…, mode_changed_at)` clamp
 *  observable: for the length of the hold the cutoff is the flip, not `now() - delaySeconds`. */
async function flipModeNow(mode: 'live' | 'delayed_15s'): Promise<void> {
  await sql(`UPDATE runtime_settings SET publication_mode=$1, mode_changed_at=now(), updated_at=now()`, [mode]);
  await resetSettingsCache();
}

// ------------------------------------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------------------------------------

async function seedAlert(fields: {
  locationId?: string; status?: 'active' | 'ended'; publishedAgoSeconds?: number;
  endedAgoSeconds?: number | null;
}): Promise<string> {
  const row = await sql<{ id: string }>(
    // `started_at` is derived from `published_at` so two periods on the same location and type in
    // one test cannot collide on UNIQUE (location_id, alert_type, started_at).
    `INSERT INTO alert_periods(location_id,alert_type,status,started_at,published_at,ended_at,updated_at)
     VALUES ($1,'air_raid',$2, now() - make_interval(secs => $3::int + 1200),
             now() - make_interval(secs => $3::int),
             CASE WHEN $4::int IS NULL THEN NULL ELSE now() - make_interval(secs => $4::int) END,
             now())
     RETURNING id`,
    [fields.locationId ?? OBLAST, fields.status ?? 'active',
      fields.publishedAgoSeconds ?? 0, fields.endedAgoSeconds ?? null]
  );
  return row.rows[0]!.id;
}

async function seedThreat(fields: {
  createdAgoSeconds?: number; status?: string; endedAgoSeconds?: number | null;
}): Promise<string> {
  const row = await sql<{ id: string }>(
    `INSERT INTO threat_events(threat_type,status,evidence_level,title,summary,started_at,
       last_observed_at,valid_until,created_at,updated_at,ended_at)
     VALUES ('uav',$1,'monitoring','Публікаційна перевірка','Публікаційна перевірка',
             now() - interval '10 minutes', now(), now() + interval '2 hours',
             now() - make_interval(secs => $2::int), now(),
             CASE WHEN $3::int IS NULL THEN NULL ELSE now() - make_interval(secs => $3::int) END)
     RETURNING id`,
    [fields.status ?? 'observed', fields.createdAgoSeconds ?? 0, fields.endedAgoSeconds ?? null]
  );
  return row.rows[0]!.id;
}

async function attachLocation(eventId: string, locationId: string, createdAgoSeconds: number): Promise<void> {
  await sql(
    `INSERT INTO threat_event_locations(event_id,location_id,relation_type,created_at)
     VALUES ($1,$2,'explicit_threat', now() - make_interval(secs => $3::int))`,
    [eventId, locationId, createdAgoSeconds]
  );
}

async function seedAssessment(fields: { generatedAgoSeconds: number }): Promise<string> {
  const row = await sql<{ id: string }>(
    `INSERT INTO risk_assessments(location_id,threat_type,horizon_start,horizon_end,risk_score,
       risk_level,assessment_confidence,model_version,generated_at,expires_at,published)
     VALUES ($1,'uav', now() - interval '1 hour', now() + interval '5 hours', 5.0,
             'significant','medium','integration-fixture',
             now() - make_interval(secs => $2::int), now() + interval '1 hour', true)
     RETURNING id`,
    [OBLAST, fields.generatedAgoSeconds]
  );
  return row.rows[0]!.id;
}

interface RegionAlert { regionId: string; regionName: string; types: string[] }

function alarmBody(regions: RegionAlert[]): unknown {
  return regions.map((region) => ({
    regionId: region.regionId,
    regionName: region.regionName,
    activeAlerts: region.types.map((type) => ({ type, lastUpdate: ALERT_START }))
  }));
}

/** Per-URL stub queue. Anything not queued falls through to the real `fetch`, which is what keeps
 *  the HTTP reads of the server under test working while an adapter is being driven. */
const stubbedResponses = new Map<string, unknown>();

function stubFetch(): void {
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: any, init?: any) => {
    const url = String(input);
    if (stubbedResponses.has(url)) {
      return { ok: true, status: 200, json: async () => stubbedResponses.get(url) } as unknown as Response;
    }
    return realFetch(input, init);
  });
}

// ------------------------------------------------------------------------------------------------

describe.skipIf(!integrationDatabaseAvailable)('publication mode', () => {
  beforeAll(async () => {
    await ensureMigrated();
    // buildServer() registers every plugin itself; registering any of them again here throws
    // FST_ERR_DUPLICATED_ROUTE inside beforeAll, and vitest reports the suite as SKIPPED rather than
    // failed — which would silently disarm every assertion in this file. The server is therefore
    // taken exactly as it ships.
    const { buildServer } = await import('../../src/api/server.js');
    app = await buildServer();
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => { await app?.close(); });

  // The five in-process seams of CONTRACT §1.4 beside the TRUNCATE, in the order documented in
  // `tests/helpers/db.ts`. `resetEventHubCursor()` is not optional: `TRUNCATE … RESTART IDENTITY`
  // restarts `version` at 1 while the hub's in-memory cursor keeps its old value, so without it
  // every `version > cursor` from the second test onward selects nothing and this file hangs.
  beforeEach(async () => {
    await resetDatabase();
    (await import('../../src/services/runtime-settings.js')).resetRuntimeSettingsCache();
    (await import('../../src/services/sse.js')).resetEventHubCursor();
    (await import('../../src/services/analytics-scheduler.js')).resetAnalyticsScheduler();
    (await import('../../src/services/risk.js')).resetRiskRunGuard();
    (await import('../../src/services/analytics-narrative.js')).resetAnalyticsNarrativeMemo();
    stubbedResponses.clear();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    (await import('../../src/services/sse.js')).eventHub.stop();
  });

  // ----------------------------------------------------------------------------------------------
  describe('the slice', () => {
    it('publishes an event as soon as it is written, in live mode', async () => {
      const version = await appendSystemEvent('threat.created', { eventId: 'live-1' });

      const snapshot = await getJson('/api/v1/snapshot');

      expect(snapshot.version).toBe(version);
      expect(snapshot.publication).toMatchObject({ mode: 'live', delaySeconds: 0, behindSeconds: 0 });
      expect(snapshot.publication.cutoffVersion).toBe(version);
    });

    it('withholds an event younger than the cutoff in delayed_15s', async () => {
      await setMode('delayed_15s');
      const version = await appendSystemEvent('threat.created', { eventId: 'held-1' });

      const snapshot = await getJson('/api/v1/snapshot');

      expect(snapshot.version).toBeLessThan(version);
      expect(snapshot.publication.mode).toBe('delayed_15s');
      expect(snapshot.publication.delaySeconds).toBe(15);
      expect(snapshot.publication.behindSeconds).toBeGreaterThanOrEqual(14);
      expect(snapshot.publication.behindSeconds).toBeLessThanOrEqual(18);
    });

    it('releases the same event once it is older than the cutoff, once and not twice', async () => {
      await setMode('delayed_15s');
      const version = await appendSystemEvent('threat.created', { eventId: 'released-1' });
      expect((await getJson('/api/v1/snapshot')).version).toBeLessThan(version);

      await backdate(version, 20);

      expect((await getJson('/api/v1/snapshot')).version).toBe(version);
      // Released, not re-released: the cutoff is a bound on a SELECT, so a second read of an
      // unchanged log is the same answer rather than a second delivery.
      expect((await getJson('/api/v1/snapshot')).version).toBe(version);
    });

    it('agrees with the connected frame on one slice', async () => {
      const version = await appendSystemEvent('threat.created', { eventId: 'agree-1' });
      await backdate(version, 30);

      const snapshot = await getJson('/api/v1/snapshot');
      const connected = connectedFrame(await readStream(400));

      expect(connected).toBeDefined();
      expect(connected!.data.version).toBe(snapshot.version);
      expect(snapshot.publication.cutoffVersion).toBe(snapshot.version);
      expect(Date.parse(connected!.data.at)).not.toBeNaN();
    });

    it('reports generatedAt as the cutoff, not the request instant', async () => {
      await setMode('delayed_15s');

      const snapshot = await getJson('/api/v1/snapshot');

      const behindMs = Date.now() - Date.parse(snapshot.generatedAt);
      expect(behindMs).toBeGreaterThan(13_000);
      expect(behindMs).toBeLessThan(19_000);
      expect(snapshot.generatedAt).toBe(snapshot.publication.cutoffAt);
    });

    it('keeps the snapshot no-store while the hold is on', async () => {
      await setMode('delayed_15s');

      const response = await getResponse('/api/v1/snapshot');

      // Caching a held payload for 120 s would make the hold unbounded.
      expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it('serves the slice statement without a sequential scan of system_event_log', async () => {
      // The statement is taken FROM THE SOURCE rather than retyped, so this cannot pass against a
      // plan nobody runs. `publicationSlice()` executes on every snapshot, every stream connection
      // and every GET /ops/api/runtime; the FILTER form it replaced planned as a Seq Scan +
      // Aggregate over a table with no retention.
      const source = await readFile(resolve(process.cwd(), 'src/services/publication.ts'), 'utf8');
      const statement = source.match(/`(WITH bound AS \([\s\S]*?FROM bound b)`/);
      expect(statement, 'publicationSlice() must still hold its statement in one template literal').not.toBeNull();

      await sql(
        `INSERT INTO system_event_log(event_type,payload)
         SELECT 'threat.created', '{}'::jsonb FROM generate_series(1, 3000)`
      );
      await sql('ANALYZE system_event_log');

      const plan = await sql<Record<string, string>>(
        `EXPLAIN ${statement![1]}`, [15, new Date(Date.now() - 3_600_000)]
      );
      const text = plan.rows.map((row) => Object.values(row)[0]).join('\n');

      // Deliberately an ABSENCE assertion and not a named index: the planner legitimately chooses
      // between `Index Scan Backward using system_event_log_pkey` and the `created_at` index plus a
      // Sort depending on how the rows are distributed. What may never come back is the full scan.
      expect(text).not.toContain('Seq Scan on system_event_log');
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('the stream', () => {
    it('loses nothing and reorders nothing across a mode switch under load', async () => {
      const { eventHub } = await import('../../src/services/sse.js');
      eventHub.start();
      const stream = openStream('/api/v1/stream');
      try {
        // One tick for the connection to establish and for the hub to take its first cursor under
        // the mode in force.
        await delay(1200);
        const written: number[] = [];
        for (let index = 0; index < 50; index += 1) {
          written.push(await appendSystemEvent('threat.created', { eventId: `load-${index}` }));
          if (index === 15) await setMode('delayed_15s');
          if (index === 35) await setMode('live');
          await delay(30);
        }

        await waitFor(async () => deliveredIds(stream.seen()).length >= written.length,
          'every version written under the flip to be delivered');

        const delivered = deliveredIds(stream.seen());
        // One assertion covers both halves of the property: identical to the written sequence means
        // strictly increasing, nothing missing, nothing repeated.
        expect(delivered).toEqual(written);
      } finally {
        await stream.close();
        eventHub.stop();
      }
    }, 60_000);

    it('never backfills above the cutoff on reconnect', async () => {
      await setMode('delayed_15s');
      const first = await appendSystemEvent('threat.created', { eventId: 'backfill-0' });
      const released = await appendSystemEvent('threat.created', { eventId: 'backfill-1' });
      const held = await appendSystemEvent('threat.created', { eventId: 'backfill-2' });
      await backdate(first, 40);
      await backdate(released, 30);

      const text = await readStream(500, { 'Last-Event-ID': String(first) });

      expect(connectedFrame(text)!.data.version).toBe(released);
      expect(deliveredIds(text)).toEqual([released]);
      expect(deliveredIds(text)).not.toContain(held);
    });

    it('replays nothing across a live→delayed flip until the hold expires, then each version once', async () => {
      const consumed = await appendSystemEvent('threat.created', { eventId: 'flip-3' });
      await setMode('delayed_15s');
      const afterFlipA = await appendSystemEvent('threat.created', { eventId: 'flip-4' });
      const afterFlipB = await appendSystemEvent('threat.created', { eventId: 'flip-5' });

      expect(dataFrames(await readStream(500, { 'Last-Event-ID': String(consumed) }))).toEqual([]);

      await backdate(afterFlipA, 20);
      await backdate(afterFlipB, 20);

      const released = await readStream(500, { 'Last-Event-ID': String(consumed) });
      expect(deliveredIds(released)).toEqual([afterFlipA, afterFlipB]);
    });

    it('resumes from ?since= exactly as it does from Last-Event-ID', async () => {
      await setMode('delayed_15s');
      const first = await appendSystemEvent('threat.created', { eventId: 'since-0' });
      const second = await appendSystemEvent('threat.created', { eventId: 'since-1' });
      const third = await appendSystemEvent('threat.created', { eventId: 'since-2' });
      const held = await appendSystemEvent('threat.created', { eventId: 'since-3' });
      for (const version of [first, second, third]) await backdate(version, 30);

      const bySince = await readStream(500, {}, `/api/v1/stream?since=${first}`);
      const byHeader = await readStream(500, { 'Last-Event-ID': String(first) });

      expect(deliveredIds(bySince)).toEqual([second, third]);
      expect(deliveredIds(bySince)).toEqual(deliveredIds(byHeader));
      expect(deliveredIds(bySince)).not.toContain(held);
    });

    it('carries envelope v2 on every frame, labelled with the mode in force', async () => {
      await setMode('delayed_15s');
      const first = await appendSystemEvent('alert.started', { alertId: 'envelope-0' });
      const second = await appendSystemEvent('threat.created', { eventId: 'envelope-1' });
      const third = await appendSystemEvent('threat.updated', { eventId: 'envelope-2' });
      for (const version of [first, second, third]) await backdate(version, 25);

      const frames = dataFrames(await readStream(500, { 'Last-Event-ID': String(first) }));

      expect(frames.map((frame) => frame.id)).toEqual([second, third]);
      for (const frame of frames) {
        expect(frame.data.envelopeVersion).toBe(2);
        expect(frame.data.occurredAt).toBe(frame.data.createdAt);
        expect(Date.parse(frame.data.publishedAt)).not.toBeNaN();
        expect(frame.data.delayMode).toBe('delayed_15s');
        // The compatibility contract: these four names and their meanings are unchanged.
        expect(Object.keys(frame.data)).toEqual(expect.arrayContaining([
          'version', 'eventType', 'payload', 'createdAt'
        ]));
      }
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('what the cutoff means for each read path', () => {
    it('still reports an alert that ended inside the cutoff', async () => {
      await seedAlert({ publishedAgoSeconds: 300, status: 'ended', endedAgoSeconds: 0 });

      // In live the cutoff is now, so the all-clear is already true and the alert is gone.
      expect(await getJson('/api/v1/alerts')).toEqual([]);

      await setMode('delayed_15s');
      const alerts = await getJson('/api/v1/alerts');

      expect(alerts).toHaveLength(1);
      // Status AS OF THE CUTOFF. Publishing «Офіційний відбій» before the SSE frame that carries it
      // is an early all-clear; `actual_status` keeps the truth for /ops and for this assertion.
      expect(alerts[0].status).toBe('active');
      expect(alerts[0].actual_status).toBe('ended');
    });

    it('withholds an alert that started inside the cutoff', async () => {
      const alertId = await seedAlert({ publishedAgoSeconds: 0 });

      expect((await getJson('/api/v1/alerts')).map((row: any) => row.id)).toEqual([alertId]);

      await setMode('delayed_15s');

      expect(await getJson('/api/v1/alerts')).toEqual([]);
    });

    it('treats a reopened alert as new for the cutoff', async () => {
      stubFetch();
      const { syncOfficialAlerts } = await import('../../src/services/ingestion.js');
      const kyiv = alarmBody([{ regionId: OBLAST, regionName: 'Київська область', types: ['AIR'] }]);

      stubbedResponses.set(UKRAINE_ALARM_URL, kyiv);
      await syncOfficialAlerts();
      // Old enough to be public in delayed mode, so that the reopen below is the only thing that can
      // change the answer.
      await sql(`UPDATE alert_periods SET published_at = now() - interval '5 minutes'`);
      const before = (await sql<{ at: string }>(`SELECT published_at::text AS at FROM alert_periods`)).rows[0]!.at;

      // End it: the snapshot debounce is keyed on `missing_since`, which is wall-clock inside
      // Postgres, so the marker the reconciler itself wrote is backdated rather than waited out.
      stubbedResponses.set(UKRAINE_ALARM_URL, alarmBody([]));
      await syncOfficialAlerts();
      await sql(`UPDATE alert_source_states SET missing_since = now() - interval '1 hour' WHERE missing_since IS NOT NULL`);
      await syncOfficialAlerts();
      expect((await sql<{ status: string }>(`SELECT status FROM alert_periods`)).rows[0]!.status).toBe('ended');

      // The same provider start, so the unique index takes the ON CONFLICT reopen branch.
      stubbedResponses.set(UKRAINE_ALARM_URL, kyiv);
      await syncOfficialAlerts();

      const rows = await sql<{ status: string; at: string }>(
        `SELECT status, published_at::text AS at FROM alert_periods`
      );
      expect(rows.rowCount).toBe(1);
      expect(rows.rows[0]!.status).toBe('active');
      expect(Date.parse(rows.rows[0]!.at)).toBeGreaterThan(Date.parse(before));

      await setMode('delayed_15s');
      // Without `published_at=now()` on the reopen branch the alert would be instantly older than
      // the cutoff — visible before it happened.
      expect(await getJson('/api/v1/alerts')).toEqual([]);
      await setMode('live');
      expect(await getJson('/api/v1/alerts')).toHaveLength(1);
    });

    it('never resurrects an ended alert when the mode flips', async () => {
      const ended = await seedAlert({ publishedAgoSeconds: 120 });
      await sql(`UPDATE alert_periods SET status='ended', ended_at=now(), updated_at=now() WHERE id=$1`, [ended]);
      expect(await getJson('/api/v1/alerts')).toEqual([]);
      const opened = await seedAlert({ publishedAgoSeconds: 3 });

      // The flip is taken AT this instant, so `GREATEST(now() - 15s, mode_changed_at)` is the flip
      // itself. Without the clamp the cutoff would jump fifteen seconds backwards and put the red
      // polygon back for the length of the hold — a false alert produced by a control-plane action.
      await flipModeNow('delayed_15s');
      const alerts = await getJson('/api/v1/alerts');

      expect(alerts.map((row: any) => row.id)).toEqual([opened]);
    });

    it('still draws a threat that ended inside the cutoff', async () => {
      const eventId = await seedThreat({ createdAgoSeconds: 300, status: 'withdrawn', endedAgoSeconds: 0 });
      await attachLocation(eventId, OBLAST, 300);

      await setMode('delayed_15s');
      const threats = await getJson('/api/v1/threats');

      expect(threats.map((row: any) => row.id)).toEqual([eventId]);
      // `liveThreats` selects `e.*` and then the as-of-cutoff CASE under the same name; node-pg
      // assigns field by field in order, so the later column wins and the public shape carries the
      // projected value. The raw one stays in the row for /ops and is read from the table here.
      expect(threats[0].status).toBe('active');
      const stored = await sql<{ status: string }>(`SELECT status FROM threat_events WHERE id=$1`, [eventId]);
      expect(stored.rows[0]!.status).toBe('withdrawn');
    });

    it('withholds a threat created inside the cutoff, and its vector chain with it', async () => {
      const eventId = await seedThreat({ createdAgoSeconds: 0 });
      await attachLocation(eventId, OBLAST, 0);
      await setMode('delayed_15s');

      const threats = await getJson('/api/v1/threats');
      const vectors = await getJson('/api/v1/vectors');

      expect(threats).toEqual([]);
      expect(JSON.stringify(vectors.items)).not.toContain(eventId);
    });

    it('404s /threats/:id for an event created after the cutoff, and 200s for the same id in live', async () => {
      const eventId = await seedThreat({ createdAgoSeconds: 0 });
      await setMode('delayed_15s');

      // The hold must not be distinguishable from absence, or it becomes a probe for held material.
      expect((await getResponse(`/api/v1/threats/${eventId}`)).status).toBe(404);

      await setMode('live');

      expect((await getResponse(`/api/v1/threats/${eventId}`)).status).toBe(200);
    });

    it('keeps an assessment superseded after the cutoff as the current one', async () => {
      const original = await seedAssessment({ generatedAgoSeconds: 120 });
      const replacement = await seedAssessment({ generatedAgoSeconds: 0 });
      await sql(`UPDATE risk_assessments SET superseded_by=$1 WHERE id=$2`, [replacement, original]);

      await setMode('delayed_15s');
      expect((await getJson('/api/v1/assessments')).map((row: any) => row.id)).toEqual([original]);

      await setMode('live');
      expect((await getJson('/api/v1/assessments')).map((row: any) => row.id)).toEqual([replacement]);
    });

    it('holds a district added to an already-published event for the full cutoff', async () => {
      const eventId = await seedThreat({ createdAgoSeconds: 120 });
      await attachLocation(eventId, OBLAST, 120);
      await attachLocation(eventId, 'ua-53', 0);

      await setMode('delayed_15s');
      const held = await getJson('/api/v1/threats');
      expect(held).toHaveLength(1);
      expect(held[0].locations.map((location: any) => location.id)).toEqual([OBLAST]);

      await setMode('live');
      const live = await getJson('/api/v1/threats');
      expect(live[0].locations.map((location: any) => location.id).sort()).toEqual([OBLAST, 'ua-53'].sort());
    });

    it('ends the attack-analytics window at the cutoff and re-keys the memo on a flip', async () => {
      (await import('../../src/services/attack-analytics.js')).resetAttackAnalyticsCache();
      await setMode('delayed_15s');

      const delayed = await getJson('/api/v1/analytics/attacks?period=day');
      const heldBy = Date.now() - Date.parse(delayed.generatedAt);
      expect(heldBy).toBeGreaterThan(13_000);
      expect(heldBy).toBeLessThan(19_000);

      await setMode('live');
      const live = await getJson('/api/v1/analytics/attacks?period=day');

      // The memo key carries the mode, so the flip is not answered with the other mode's payload for
      // the length of the 120 s TTL.
      expect(live.generatedAt).not.toBe(delayed.generatedAt);
      expect(Date.now() - Date.parse(live.generatedAt)).toBeLessThan(5000);
    });

    it('stops the attacks response being shared-cacheable while the hold is on', async () => {
      (await import('../../src/services/attack-analytics.js')).resetAttackAnalyticsCache();

      const live = await getResponse('/api/v1/analytics/attacks?period=day');
      expect(live.headers.get('cache-control')).toBe('public, max-age=120, stale-while-revalidate=3600');

      await setMode('delayed_15s');
      const held = await getResponse('/api/v1/analytics/attacks?period=day');

      // `no-store`, not `max-age=15`: an already-issued `s-maxage` cannot be expired on a flip, and
      // `stale-while-revalidate` is what makes the hour-long tail possible.
      expect(held.headers.get('cache-control')).toBe('no-store');
    });

    it('states the mode in /methodology and appends the fourth caveat only when delayed', async () => {
      const live = await getJson('/api/v1/methodology');
      expect(live.publication).toEqual({ mode: 'live', delaySeconds: 0 });
      expect(live.caveats).toHaveLength(3);

      await setMode('delayed_15s');
      const delayed = await getJson('/api/v1/methodology');

      expect(delayed.publication).toEqual({ mode: 'delayed_15s', delaySeconds: 15 });
      expect(delayed.caveats).toHaveLength(4);
      // APPENDED, never inserted: a client rendering `caveats[2]` keeps rendering the same sentence.
      expect(delayed.caveats.slice(0, 3)).toEqual(live.caveats);
      expect(delayed.caveats[3]).toContain('Публічний показ затримано');
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('what the cutoff must never touch', () => {
    it('does not delay Telegram', async () => {
      await setMode('delayed_15s');
      await seedUser(9701);
      await seedSubscription({ chatId: 9701, locationId: OBLAST });
      const alertId = await seedAlert({ publishedAgoSeconds: 0 });
      await appendSystemEvent('alert.started', { alertId, locationId: OBLAST });

      await runFanout();

      // `src/bot/outbox.ts` keeps its own durable cursor in `worker_state` and never reads the
      // publication gate; the exemption is the default and requires no code.
      const rows = await sql<{ chat_id: string }>(
        `SELECT chat_id FROM notification_outbox WHERE alert_period_id=$1`, [alertId]
      );
      expect(rows.rows.map((row) => Number(row.chat_id))).toEqual([9701]);
    });

    it('never turns publication.changed or analytics.updated into a notification', async () => {
      await seedUser(9702);
      await seedSubscription({ chatId: 9702, locationId: OBLAST });
      await appendSystemEvent('publication.changed', { mode: 'delayed_15s', delaySeconds: 15 });
      await appendSystemEvent('analytics.updated', { trigger: 'event', durationMs: 12 });

      await runFanout();

      expect(await outboxRows()).toEqual([]);
    });

    it('loses nothing when a series of messages goes through ingestion', async () => {
      const { processMessage, resetMonitorCoalescing } = await import('../../src/services/ingestion.js');
      resetMonitorCoalescing();
      const base = Date.now() - 60 * 60_000;
      const externalIds = Array.from({ length: 25 }, (_, index) => `series-${String(index).padStart(2, '0')}`);

      for (const [index, externalId] of externalIds.entries()) {
        // No try/catch: a swallowed exception is exactly what this pins, so a throw must fail the
        // test rather than be counted.
        const result = await processMessage({
          sourceId: WAR_MONITOR,
          externalId,
          publishedAt: new Date(base + index * 60_000),
          text: `Загроза БпЛА для Полтавщини. Повідомлення номер ${index}.`,
          rawPayload: { series: index }
        });
        expect(result).toBeTruthy();
      }

      const rows = await sql<{ external_id: string }>(
        `SELECT external_id FROM source_messages WHERE source_id=$1 ORDER BY published_at, external_id`,
        [WAR_MONITOR]
      );
      expect(rows.rowCount).toBe(25);
      // Ordering preserved and no gap: the row order by `published_at` is the order they were fed.
      expect(rows.rows.map((row) => row.external_id)).toEqual(externalIds);
    }, 60_000);

    it('refuses a re-entrant official-API tick while a leg is still in flight', async () => {
      // `Promise.all` settles at the FIRST rejection and leaves the other legs running, so the
      // `finally { running = false }` would release the guard with a nationwide snapshot half
      // applied — and a rejection is the NORMAL case, because both sync functions rethrow after
      // `markSourceError`. `Promise.allSettled` is what makes the guard mean anything.
      const alertsInUaUrl = 'https://api.alerts.in.ua/v1/alerts/active.json';
      const calls = { ukraineAlarm: 0, alertsInUa: 0 };
      const pending: { release: (() => void) | null } = { release: null };
      const realFetch = globalThis.fetch;
      vi.stubGlobal('fetch', async (input: any, init?: any) => {
        const url = String(input);
        if (url === UKRAINE_ALARM_URL) {
          calls.ukraineAlarm += 1;
          throw new Error('ukraine-alarm is down');
        }
        if (url === alertsInUaUrl) {
          calls.alertsInUa += 1;
          await new Promise<void>((resolveLeg) => { pending.release = resolveLeg; });
          return { ok: true, status: 200, json: async () => [] } as unknown as Response;
        }
        return realFetch(input, init);
      });

      const { startIngestionScheduler } = await import('../../src/services/ingestion.js');
      const stop = startIngestionScheduler({ info: () => undefined, warn: () => undefined, error: () => undefined });
      try {
        await waitFor(async () => calls.alertsInUa === 1, 'the first tick to reach both legs');
        expect(calls.ukraineAlarm).toBe(1);

        // The scheduler ticks every 15 s. One tick has to actually land while the second leg is
        // still pending, and there is no seam to reach `run()` directly.
        await delay(17_000);

        expect(calls).toEqual({ ukraineAlarm: 1, alertsInUa: 1 });
      } finally {
        stop();
        pending.release?.();
        // The leg has to finish before `afterEach` pulls the stub out from under it and the next
        // test truncates the tables it is writing to.
        await waitFor(async () => {
          const rows = await sql<{ last_success_at: Date | null }>(
            `SELECT last_success_at FROM sources WHERE id='alerts-in-ua'`
          );
          return rows.rows[0]?.last_success_at != null;
        }, 'the in-flight alerts.in.ua leg to settle');
      }
    }, 60_000);
  });
});
