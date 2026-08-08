import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  count, ensureMigrated, integrationDatabaseAvailable, resetDatabase, runFanout, seedSubscription,
  seedUser, sql
} from '../helpers/db.js';
import type {
  BackfillLimits, BackfillPort, BackfillRawMessage
} from '../../src/services/source-backfill.js';

/**
 * The catch-up backfill of issue #3, end to end against a live PostgreSQL.
 *
 * Three properties are worth a live database rather than a unit test, and this file exists for them:
 *
 *  1. **Stale history is archive, not news.** A three-hour-old post replayed today must land in
 *     `source_messages`, `message_classifications` and `threat_events` with its original timestamps,
 *     and must reach NOTHING else — no `system_event_log` row, therefore no SSE frame and no Telegram
 *     notification, no `risk_signals`, and no place on the live map. A ten-minute-old post from the
 *     SAME window must behave exactly as it would have live. The seam is the window, not blanket
 *     silence, and only a real ingest through the real repository can show that.
 *  2. **Replaying is free.** Running the same window twice changes no count in any of the six tables
 *     a replay can touch. Proven twice over: once at the port (the derived cursor makes the second
 *     window empty before a single history request) and once at the storage model (the identical
 *     message pushed through `processMessage` twice writes nothing the second time).
 *  3. **The official alert contour is untouched.** `alert_periods` and `alert_source_states` are
 *     byte-identical across a monitor backfill, and an alert-channel source offered to the sweep by
 *     a misbehaving port is refused by the source predicate rather than by convention.
 *
 * Nothing here touches the network: MTProto is consumed through {@link BackfillPort}, and the fake
 * below is the whole of it.
 */

const ERADAR = 'osint-eradar';
const WAR_MONITOR = 'osint-war-monitor';
const AERIS = 'osint-aeris-rimor';
const ALERT_CHANNEL = 'air-alert-ua';
const POLTAVA_OBLAST = 'ua-53';
const KHARKIV_OBLAST = 'ua-63';

const MINUTE = 60_000;

/**
 * Bounds every test in this file runs under.
 *
 * The production defaults, except `sourceDelayMs: 0` — the 1.5 s pause between sources is a Telegram
 * courtesy and has nothing to test — and `checkIntervalSeconds: 0`, so no sweep is ever scheduled
 * behind the one a test asked for.
 */
const LIMITS: BackfillLimits = {
  enabled: true,
  minGapSeconds: 3600,
  maxAgeSeconds: 21_600,
  maxMessages: 300,
  maxPages: 5,
  pageSize: 100,
  maxSourcesPerSweep: 10,
  sourceDelayMs: 0,
  minRerunSeconds: 3600,
  checkIntervalSeconds: 0
};

interface FakeChannel {
  sourceId: string;
  username: string;
  adapterType: string;
  /** Newest-first order is imposed by the fake, so a fixture may be written chronologically. */
  messages: BackfillRawMessage[];
  /** When set, `history` rejects with it — the per-source failure isolation case. */
  failWith?: Error;
}

interface FakePort {
  port: BackfillPort;
  calls: Array<{ username: string; limit: number; offsetId: number }>;
}

/**
 * The MTProto history API, reduced to what the port promises: newest first, `offsetId` exclusive.
 *
 * `offsetId` semantics are Telegram's own — the answer holds messages with a STRICTLY smaller id —
 * and getting that wrong in the fake would hide an off-by-one that loops forever in production.
 */
function fakePort(channels: FakeChannel[]): FakePort {
  const calls: Array<{ username: string; limit: number; offsetId: number }> = [];
  return {
    calls,
    port: {
      routes: () => channels.map(({ sourceId, username, adapterType }) => ({ sourceId, username, adapterType })),
      history: async (username, page) => {
        calls.push({ username, limit: page.limit, offsetId: page.offsetId });
        const channel = channels.find((candidate) => candidate.username === username);
        if (!channel) return [];
        if (channel.failWith) throw channel.failWith;
        const newestFirst = [...channel.messages].sort((left, right) => right.id - left.id);
        const afterOffset = page.offsetId
          ? newestFirst.filter((message) => message.id < page.offsetId)
          : newestFirst;
        return afterOffset.slice(0, page.limit);
      }
    }
  };
}

/** A Telegram message published `minutesAgo` minutes before now, in whole seconds as Telegram sends. */
function post(id: number, minutesAgo: number, text: string | null): BackfillRawMessage {
  return { id, date: Math.floor((Date.now() - minutesAgo * MINUTE) / 1000), message: text };
}

/**
 * Puts one row in the archive so the source has a cursor, without going through the classifier.
 *
 * The content hash is computed the way `src/repositories/events.ts` computes it — sha256 of the UTF-8
 * text — so the duplicate probe sees exactly what the application would have written.
 */
async function seedArchivedMessage(
  sourceId: string, externalId: string, minutesAgo: number, text = 'архівне повідомлення'
): Promise<void> {
  await sql(
    `INSERT INTO source_messages(source_id,external_id,published_at,raw_text,raw_payload,
       content_hash,processing_status)
     VALUES ($1,$2,now() - ($3::int * interval '1 minute'),$4,'{}'::jsonb,
       encode(sha256(convert_to($4,'UTF8')),'hex'),'ignored')`,
    [sourceId, externalId, minutesAgo, text]
  );
}

async function runSweep(port: BackfillPort, limits: BackfillLimits = LIMITS) {
  const { runBackfillSweep } = await import('../../src/services/source-backfill.js');
  return runBackfillSweep(port, {}, limits);
}

async function resetCoalescing(): Promise<void> {
  (await import('../../src/services/ingestion.js')).resetMonitorCoalescing();
}

async function ingest(
  sourceId: string, text: string, publishedAt: Date, externalId: string,
  options: { monitor?: boolean; historical?: boolean } = { monitor: true }
) {
  const { processMessage } = await import('../../src/services/ingestion.js');
  return processMessage({
    sourceId, externalId, publishedAt, text, rawPayload: { channel: sourceId, test: true }
  }, options);
}

async function backfillState(sourceId: string) {
  const result = await sql<Record<string, any>>(
    `SELECT * FROM source_backfill_state WHERE source_id=$1`, [sourceId]
  );
  return result.rows[0] ?? null;
}

async function eventRow(eventId: string) {
  const result = await sql<{
    status: string; started_at: string; last_observed_at: string; valid_until: string;
    ended_at: string | null; summary: string;
  }>(
    `SELECT status,started_at::text,last_observed_at::text,valid_until::text,ended_at::text,summary
       FROM threat_events WHERE id=$1`, [eventId]
  );
  return result.rows[0]!;
}

/** The six tables a replay can touch, in one snapshot. §B5 asserts equality over exactly these. */
async function replayFootprint() {
  return {
    systemEvents: await count('system_event_log'),
    outbox: await count('notification_outbox'),
    threatEvents: await count('threat_events'),
    classifications: await count('message_classifications'),
    sourceMessages: await count('source_messages'),
    riskSignals: await count('risk_signals')
  };
}

describe.skipIf(!integrationDatabaseAvailable)('classifier catch-up backfill', () => {
  beforeAll(async () => { await ensureMigrated(); });

  // The five in-process seams documented in `tests/helpers/db.ts`, plus the coalescing window: this
  // file ingests the same source and threat type several times inside one wall-clock second, and a
  // window left over from the previous test would swallow the second ingest of the next one.
  beforeEach(async () => {
    await resetDatabase();
    await resetCoalescing();
    (await import('../../src/services/runtime-settings.js')).resetRuntimeSettingsCache();
    (await import('../../src/services/sse.js')).resetEventHubCursor();
    (await import('../../src/services/analytics-scheduler.js')).resetAnalyticsScheduler();
    (await import('../../src/services/risk.js')).resetRiskRunGuard();
    (await import('../../src/services/analytics-narrative.js')).resetAnalyticsNarrativeMemo();
  });

  // ----------------------------------------------------------------------------------------------
  // The gap decision, against real rows
  // ----------------------------------------------------------------------------------------------

  describe('the 60-minute threshold', () => {
    it('never asks Telegram for history when the gap is 59 minutes', async () => {
      await seedArchivedMessage(ERADAR, '900', 59);
      const fake = fakePort([{
        sourceId: ERADAR, username: 'eRadarrua', adapterType: 'mtproto_monitor',
        messages: [post(901, 10, 'Шахед курсом на Полтавщину.')]
      }]);

      const summary = await runSweep(fake.port);

      // The whole point of the threshold: a supervisor restarting the process every half hour must
      // not turn every restart into a history burst.
      expect(fake.calls).toEqual([]);
      expect(summary.outcomes[0]!.status).toBe('skipped_small_gap');
      expect(summary.outcomes[0]!.decision.gapSeconds).toBeGreaterThanOrEqual(59 * 60);
      expect(summary.outcomes[0]!.decision.gapSeconds).toBeLessThan(60 * 60);
      const state = await backfillState(ERADAR);
      expect(state!.last_run_status).toBe('skipped_small_gap');
      // A skip is not an attempt: `last_run_at` stays null, so the rerun guard cannot lock a source
      // out of the backfill it never had.
      expect(state!.last_run_at).toBeNull();
      expect(await count('source_messages', `source_id=$1`, [ERADAR])).toBe(1);
    });

    it('reads history at 61 minutes and replays only what is newer than the cursor', async () => {
      await seedArchivedMessage(ERADAR, '900', 61);
      const fake = fakePort([{
        sourceId: ERADAR, username: 'eRadarrua', adapterType: 'mtproto_monitor',
        messages: [
          post(880, 90, 'Шахед курсом на Полтавщину.'),   // older than the cursor — must not be read back
          post(901, 45, 'Балістика на Харків.'),
          post(902, 10, 'БпЛА на Полтавщині.')
        ]
      }]);

      const summary = await runSweep(fake.port);

      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]).toEqual({ username: 'eRadarrua', limit: 100, offsetId: 0 });
      expect(summary.outcomes[0]!.status).toBe('ok');
      const replayed = await sql<{ external_id: string }>(
        `SELECT external_id FROM source_messages WHERE source_id=$1 ORDER BY external_id`, [ERADAR]
      );
      expect(replayed.rows.map((row) => row.external_id)).toEqual(['900', '901', '902']);

      const state = await backfillState(ERADAR);
      expect(state!.last_run_status).toBe('ok');
      expect(state!.messages_read).toBe(3);
      expect(state!.pages_read).toBe(1);
      expect(state!.truncated_reason).toBeNull();
      expect(state!.consecutive_failures).toBe(0);
      // The cursor is copied from the archive after the run, for the operator card.
      expect(state!.cursor_external_id).toBe('902');
    });

    it('pages until the window ends, threading Telegram\'s exclusive offsetId', async () => {
      // The paging loop is the one part of the read that a pure test cannot pin: `offsetId` is
      // exclusive, so an off-by-one either re-reads the same page forever or skips one message per
      // page. Five messages at a page size of two must cost exactly three requests.
      await seedArchivedMessage(ERADAR, '800', 300);
      const fake = fakePort([{
        sourceId: ERADAR, username: 'eRadarrua', adapterType: 'mtproto_monitor',
        messages: [
          post(801, 250, 'Шахед курсом на Полтавщину.'),
          post(802, 240, 'БпЛА на Полтавщині.'),
          post(803, 230, 'Балістика на Харків.'),
          post(804, 220, 'Підбірка мемів про шахед на вечір 😂'),
          post(805, 210, 'Шахед курсом на Полтавщину.')
        ]
      }]);

      const summary = await runSweep(fake.port, { ...LIMITS, pageSize: 2 });

      expect(fake.calls.map((call) => call.offsetId)).toEqual([0, 804, 802]);
      expect(summary.outcomes[0]!.status).toBe('ok');
      // Five messages over three pages; the third comes back short, which is the natural end of the
      // channel and not a truncation.
      expect(summary.outcomes[0]!.counters).toMatchObject({ read: 5, pages: 3, failed: 0 });
      expect(summary.outcomes[0]!.window!.truncatedReason).toBeNull();
      const replayed = await sql<{ external_id: string }>(
        `SELECT external_id FROM source_messages WHERE source_id=$1 AND external_id<>'800'
         ORDER BY external_id`, [ERADAR]
      );
      expect(replayed.rows.map((row) => row.external_id)).toEqual(['801', '802', '803', '804', '805']);
    });

    it('never throws into the collector, and hands back a stop closure', async () => {
      const { startClassifierBackfill } = await import('../../src/services/source-backfill.js');
      await seedArchivedMessage(ERADAR, '90', 400);
      const fake = fakePort([{
        sourceId: ERADAR, username: 'eRadarrua', adapterType: 'mtproto_monitor',
        messages: [], failWith: new Error('AUTH_KEY_UNREGISTERED')
      }]);
      const errors: unknown[] = [];

      const stop = startClassifierBackfill(fake.port, { error: (fields: unknown) => errors.push(fields) },
        { ...LIMITS, checkIntervalSeconds: 0 });
      await new Promise((resolve) => setTimeout(resolve, 250));
      stop();

      // The failure is logged and recorded, and the caller — `src/sources/telegram.ts`, which does
      // not await this — sees nothing that could take the live stream down.
      expect(errors.length).toBeGreaterThan(0);
      expect((await backfillState(ERADAR))!.last_run_status).toBe('failed');
      expect(typeof stop).toBe('function');
    });
  });

  // ----------------------------------------------------------------------------------------------
  // Stale history is archive, not news — the pair from the test plan
  // ----------------------------------------------------------------------------------------------

  describe('a replayed window containing both stale and current messages', () => {
    it('archives the three-hour-old message and publishes the ten-minute-old one', async () => {
      await seedUser(6001);
      await seedSubscription({ chatId: 6001, locationId: POLTAVA_OBLAST });
      await seedSubscription({ chatId: 6001, locationId: KHARKIV_OBLAST });
      await seedArchivedMessage(ERADAR, '500', 240);
      const fake = fakePort([{
        sourceId: ERADAR, username: 'eRadarrua', adapterType: 'mtproto_monitor',
        messages: [
          post(501, 180, 'Шахед курсом на Полтавщину.'),
          post(502, 10, 'Балістика на Харків.')
        ]
      }]);

      const summary = await runSweep(fake.port);
      await runFanout();

      expect(summary.outcomes[0]!.status).toBe('ok');
      expect(summary.outcomes[0]!.counters).toMatchObject({ replayed: 1, stale: 1, duplicate: 0, failed: 0 });

      // -- provenance ---------------------------------------------------------------------------
      const stored = await sql<{ external_id: string; published_at: string; raw_payload: any; processing_status: string }>(
        `SELECT external_id,published_at::text,raw_payload,processing_status
           FROM source_messages WHERE source_id=$1 AND external_id IN ('501','502') ORDER BY external_id`,
        [ERADAR]
      );
      expect(stored.rows).toHaveLength(2);
      expect(stored.rows.every((row) => row.raw_payload.backfill === true)).toBe(true);
      // The publisher's own time, not ours: an archive stamped with the replay instant is an archive
      // that cannot answer any of the questions it exists for.
      const staleAge = Date.now() - new Date(stored.rows[0]!.published_at).getTime();
      expect(staleAge).toBeGreaterThan(170 * MINUTE);
      expect(await count('message_classifications', `source_id=$1`, [ERADAR])).toBe(2);

      // -- the stale one is archive only ---------------------------------------------------------
      const stale = await sql<{ id: string; status: string; valid_until: string; ended_at: string }>(
        `SELECT id,status,valid_until::text,ended_at::text FROM threat_events WHERE threat_type='uav'`
      );
      expect(stale.rows).toHaveLength(1);
      expect(stale.rows[0]!.status).toBe('expired');
      // `ended_at = valid_until`, so the delayed-mode branch of `liveThreats` (`ended_at > cutoff`)
      // cannot surface it either — the event is unreachable from the map in BOTH publication modes.
      expect(stale.rows[0]!.ended_at).toBe(stale.rows[0]!.valid_until);
      const staleEventId = stale.rows[0]!.id;
      expect(await count('system_event_log', `payload->>'eventId'=$1`, [staleEventId])).toBe(0);
      expect(await count('risk_signals',
        `source_message_id IN (SELECT id FROM source_messages WHERE source_id=$1 AND external_id='501')`,
        [ERADAR])).toBe(0);

      const { liveThreats } = await import('../../src/repositories/events.js');
      const live = await liveThreats(new Date());
      expect(live.map((event) => event.id)).not.toContain(staleEventId);

      // …and it IS in the archive a reader can page through. `/api/v1/history` filters on
      // `created_at <= cutoff` and on nothing else, so a terminal status is not a reason to hide it.
      expect(await count('threat_events', `id=$1 AND created_at<=now()`, [staleEventId])).toBe(1);

      // -- the ten-minute-old one behaves exactly as it would have live ---------------------------
      const current = await sql<{ id: string; status: string }>(
        `SELECT id,status FROM threat_events WHERE threat_type='ballistic_missile'`
      );
      expect(current.rows).toHaveLength(1);
      expect(current.rows[0]!.status).toBe('observed');
      const currentEventId = current.rows[0]!.id;
      const logged = await sql<{ event_type: string }>(
        `SELECT event_type FROM system_event_log WHERE payload->>'eventId'=$1`, [currentEventId]
      );
      expect(logged.rows.map((row) => row.event_type)).toEqual(['threat.created']);
      expect(live.map((event) => event.id)).toContain(currentEventId);
      expect(await count('risk_signals',
        `source_message_id IN (SELECT id FROM source_messages WHERE source_id=$1 AND external_id='502')`,
        [ERADAR])).toBeGreaterThan(0);

      // -- and the notification is the one-line summary of all of it -----------------------------
      const queued = await sql<{ event_id: string }>(`SELECT event_id FROM notification_outbox`);
      expect(queued.rows.map((row) => row.event_id)).toEqual([currentEventId]);
    });

    it('does not attach a stale message\'s district or evidence promotion to a live event', async () => {
      // The dangerous merge: a live threat over Полтавщина, and an hour-old post from a SECOND
      // monitor naming Полтавщина and Харківщина. Attaching the new district would grow the polygon
      // and `decideThreatNotification` would read it as `geography_changed`; the second independent
      // group would promote the event to `confirmed` and send that as an escalation. Neither may
      // happen from a message that stopped applying an hour ago.
      await seedUser(6002);
      await seedSubscription({ chatId: 6002, locationId: POLTAVA_OBLAST });
      const live = await ingest(ERADAR, 'Шахед курсом на Полтавщину.', new Date(), 'live-1');
      await runFanout();
      const eventId = (live as { id: string }).id;
      const before = await eventRow(eventId);
      const outboxBefore = await count('notification_outbox');
      await resetCoalescing();

      await ingest(
        WAR_MONITOR, 'Шахед курсом на Полтавщину та Харківщину.',
        new Date(Date.now() - 90 * MINUTE), 'stale-merge-1', { monitor: true, historical: true }
      );
      await runFanout();

      const after = await eventRow(eventId);
      expect(after.status).toBe(before.status);
      expect(after.summary).toBe(before.summary);
      expect(after.last_observed_at).toBe(before.last_observed_at);
      expect(after.valid_until).toBe(before.valid_until);
      expect(await count('threat_event_locations', `event_id=$1`, [eventId])).toBe(1);
      expect(await count('notification_outbox')).toBe(outboxBefore);
      // The evidence link IS written: it is provenance, it is what makes a rerun of the window a
      // no-op, and on its own it publishes nothing.
      expect(await count('event_evidence', `event_id=$1`, [eventId])).toBe(2);
    });
  });

  // ----------------------------------------------------------------------------------------------
  // §B5 — replaying is free
  // ----------------------------------------------------------------------------------------------

  describe('idempotency of a replayed window', () => {
    it('leaves every one of the six tables unchanged when the same window is swept twice', async () => {
      await seedUser(6003);
      await seedSubscription({ chatId: 6003, locationId: POLTAVA_OBLAST });
      await seedSubscription({ chatId: 6003, locationId: KHARKIV_OBLAST });
      // A live event from OUTSIDE the backfill, so `notification_outbox` and `system_event_log` are
      // non-empty in the footprint: an equality that holds only because both sides are zero proves
      // nothing about a table.
      await ingest(AERIS, 'Балістика на Харків.', new Date(), 'anchor-1');
      await seedArchivedMessage(ERADAR, '700', 200);
      await resetCoalescing();
      // Every message stays comfortably older than an hour, so the gap AFTER the replay is still
      // wide enough for the second sweep to genuinely run rather than be answered by the threshold.
      const fake = fakePort([{
        sourceId: ERADAR, username: 'eRadarrua', adapterType: 'mtproto_monitor',
        messages: [
          post(701, 150, 'Шахед курсом на Полтавщину.'),              // classified
          post(702, 140, 'Підбірка мемів про шахед на вечір 😂'),      // ignored
          post(703, 130, 'Полтавщина — відбій загрози ударних БпЛА.'), // de-escalation
          post(704, 70, 'Балістика на Харків.')                        // classified, second event
        ]
      }]);

      await runSweep(fake.port);
      await runFanout();
      const first = await replayFootprint();
      expect(first.sourceMessages).toBe(6);
      expect(first.classifications).toBe(5);
      expect(first.outbox).toBeGreaterThan(0);
      const requestsAfterFirst = fake.calls.length;

      // The rerun guard would otherwise answer this for us, and it is not the property under test:
      // clearing `last_run_at` is what a restart inside the rerun window looks like.
      await sql(`UPDATE source_backfill_state SET last_run_at=NULL WHERE source_id=$1`, [ERADAR]);
      await runSweep(fake.port);
      await runFanout();

      expect(await replayFootprint()).toEqual(first);
      // The second sweep really did run — it asked Telegram again — and came back with nothing,
      // because the cursor is DERIVED from the archive. The guarantee holds before a single message
      // is touched, not after a constraint swallowed a duplicate write.
      expect(fake.calls.length).toBeGreaterThan(requestsAfterFirst);
      const state = await backfillState(ERADAR);
      expect(state!.last_run_status).toBe('ok');
      expect(state!.messages_replayed).toBe(0);
      expect(state!.messages_stale).toBe(0);
      expect(state!.messages_duplicate).toBe(0);
    });

    it('writes nothing on the second pass of a byte-identical message, branch by branch', async () => {
      // The storage-model half of the same proof, with the cursor taken out of the picture: every
      // decision branch pushed through `processMessage` twice with identical input. Coalescing is
      // reset between the passes ON PURPOSE — it would otherwise short-circuit the classified branch
      // before `ingestThreat`, and the duplicate short-circuit is precisely what is under test.
      await seedUser(6004);
      await seedSubscription({ chatId: 6004, locationId: POLTAVA_OBLAST });
      const publishedAt = new Date(Date.now() - 3 * MINUTE);
      const pass = async () => {
        await ingest(ERADAR, 'Шахед курсом на Полтавщину.', publishedAt, 'idem-1');
        await ingest(ERADAR, 'Підбірка мемів про шахед на вечір 😂', publishedAt, 'idem-2');
        await ingest(AERIS, 'Полтавщина — відбій загрози ударних БпЛА.', publishedAt, 'idem-3');
        await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.',
          new Date(Date.now() - 200 * MINUTE), 'idem-4', { monitor: true, historical: true });
      };

      await pass();
      await runFanout();
      const first = await replayFootprint();

      await resetCoalescing();
      await pass();
      await runFanout();

      expect(await replayFootprint()).toEqual(first);
    });
  });

  // ----------------------------------------------------------------------------------------------
  // Failure isolation
  // ----------------------------------------------------------------------------------------------

  describe('failure isolation', () => {
    it('records the failing source and keeps sweeping the others', async () => {
      await seedArchivedMessage(WAR_MONITOR, '10', 400);
      await seedArchivedMessage(ERADAR, '20', 120);
      const fake = fakePort([
        {
          sourceId: WAR_MONITOR, username: 'war_monitor', adapterType: 'mtproto_monitor',
          messages: [], failWith: new Error('CHANNEL_PRIVATE')
        },
        {
          sourceId: ERADAR, username: 'eRadarrua', adapterType: 'mtproto_monitor',
          messages: [post(21, 30, 'Балістика на Харків.')]
        }
      ]);

      const summary = await runSweep(fake.port);

      // Widest gap first, so the order is deterministic and the failure comes before the success.
      expect(summary.outcomes.map((outcome) => [outcome.sourceId, outcome.status])).toEqual([
        [WAR_MONITOR, 'failed'], [ERADAR, 'ok']
      ]);
      const failed = await backfillState(WAR_MONITOR);
      expect(failed!.last_run_status).toBe('failed');
      expect(failed!.consecutive_failures).toBe(1);
      expect(failed!.last_error).toContain('CHANNEL_PRIVATE');
      // The channel is still being read live; reporting a source outage here would send an operator
      // after a collector that is working.
      const health = await sql<{ last_error: string | null }>(
        `SELECT last_error FROM sources WHERE id=$1`, [WAR_MONITOR]
      );
      expect(health.rows[0]!.last_error).toBeNull();
      expect(await count('source_messages', `source_id=$1 AND external_id='21'`, [ERADAR])).toBe(1);
    });

    it('holds a repeatedly failing source off for MIN_RERUN_SECONDS × 2^failures', async () => {
      await seedArchivedMessage(ERADAR, '30', 400);
      const fake = fakePort([{
        sourceId: ERADAR, username: 'eRadarrua', adapterType: 'mtproto_monitor',
        messages: [], failWith: new Error('FLOOD_WAIT_600')
      }]);

      await runSweep(fake.port);
      const attempts = fake.calls.length;
      await runSweep(fake.port);

      expect(fake.calls).toHaveLength(attempts);
      const state = await backfillState(ERADAR);
      expect(state!.last_run_status).toBe('skipped_recent');
      // The failure count survives the skip: a skip is not evidence that the source can be read.
      expect(state!.consecutive_failures).toBe(1);
    });
  });

  // ----------------------------------------------------------------------------------------------
  // The official alert contour
  // ----------------------------------------------------------------------------------------------

  describe('official alerts stay in their own contour', () => {
    it('leaves alert_periods and alert_source_states byte-identical across a monitor backfill', async () => {
      const { ingestAlertChannelMessages } = await import('../../src/services/ingestion.js');
      await ingestAlertChannelMessages(ALERT_CHANNEL, [{
        externalId: 'alert-1',
        publishedAt: new Date(Date.now() - 20 * MINUTE),
        text: '🔴 03:12 Повітряна тривога в м. Київ\nСлідкуйте за подальшими повідомленнями.'
      }], { warn: () => undefined });
      const snapshot = async () => ({
        periods: (await sql(`SELECT * FROM alert_periods ORDER BY id`)).rows,
        states: (await sql(`SELECT * FROM alert_source_states ORDER BY source_id,location_id,alert_type`)).rows
      });
      const before = await snapshot();
      expect(before.periods.length).toBeGreaterThan(0);

      await seedArchivedMessage(ERADAR, '40', 300);
      const fake = fakePort([{
        sourceId: ERADAR, username: 'eRadarrua', adapterType: 'mtproto_monitor',
        messages: [post(41, 200, 'Шахед курсом на Полтавщину.'), post(42, 5, 'Балістика на Харків.')]
      }]);
      await runSweep(fake.port);

      expect(await snapshot()).toEqual(before);
    });

    it('refuses an alert channel offered to the sweep by a misbehaving port', async () => {
      // `routes()` is contracted to yield classifier routes only. This asserts the property does not
      // depend on that contract being honoured: the source predicate this module runs every decision
      // through does not match `mtproto_alert_channel`, so the answer is a refusal, not a read.
      await seedArchivedMessage(ALERT_CHANNEL, '1', 400);
      const fake = fakePort([{
        sourceId: ALERT_CHANNEL, username: 'air_alert_ua', adapterType: 'mtproto_alert_channel',
        messages: [post(2, 100, '🟢 Полтавська область\nВідбій тривоги')]
      }]);

      const summary = await runSweep(fake.port);

      expect(summary.outcomes[0]!.status).toBe('skipped_disabled');
      expect(fake.calls).toEqual([]);
    });

    it('never lists an alert channel in the operator progress view', async () => {
      const { readBackfillProgress } = await import('../../src/services/source-backfill.js');
      const rows = await readBackfillProgress();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((row) => row.sourceId === ALERT_CHANNEL)).toBe(false);
      expect(rows.every((row) => row.adapterType !== 'mtproto_alert_channel')).toBe(true);
      // Widest gap first — the ordering the console renders and the one an operator scans.
      const gaps = rows.map((row) => row.gapSeconds ?? -1);
      expect([...gaps].sort((left, right) => right - left)).toEqual(gaps);
    });
  });

  // ----------------------------------------------------------------------------------------------
  // The three unconditional ordering fixes in src/repositories/events.ts
  // ----------------------------------------------------------------------------------------------

  describe('ordering fixes that apply to every message, replayed or live', () => {
    it('never lets a later-arriving older message move an event\'s window backwards', async () => {
      const first = await ingest(ERADAR, 'Шахед курсом на Полтавщину.', new Date(Date.now() - 5 * MINUTE), 'ord-1');
      const eventId = (first as { id: string }).id;
      const before = await eventRow(eventId);
      await resetCoalescing();

      const merged = await ingest(
        ERADAR, 'БпЛА над Полтавщиною, рухаються далі.', new Date(Date.now() - 20 * MINUTE), 'ord-2'
      );

      expect((merged as { created: boolean }).created).toBe(false);
      const after = await eventRow(eventId);
      // Both timestamps are maxima now. Before this fix the older message reset `last_observed_at`
      // to its own value and recomputed `valid_until` from it, retiring a live threat early.
      expect(after.last_observed_at).toBe(before.last_observed_at);
      expect(after.valid_until).toBe(before.valid_until);
      // …and the prose stayed the newer message's, because a summary is not a maximum of anything.
      expect(after.summary).toBe(before.summary);
    });

    it('lets a newer message move the window forwards, exactly as before', async () => {
      const first = await ingest(ERADAR, 'Шахед курсом на Полтавщину.', new Date(Date.now() - 20 * MINUTE), 'ord-3');
      const eventId = (first as { id: string }).id;
      const before = await eventRow(eventId);
      await resetCoalescing();

      await ingest(ERADAR, 'БпЛА над Полтавщиною, рухаються далі.', new Date(Date.now() - 2 * MINUTE), 'ord-4');

      const after = await eventRow(eventId);
      expect(new Date(after.last_observed_at).getTime()).toBeGreaterThan(new Date(before.last_observed_at).getTime());
      expect(new Date(after.valid_until).getTime()).toBeGreaterThan(new Date(before.valid_until).getTime());
      expect(after.summary).not.toBe(before.summary);
    });

    it('retracts only what was standing when the stand-down was published', async () => {
      const asserted = await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.', new Date(Date.now() - 5 * MINUTE), 'ret-1');
      const eventId = (asserted as { id: string }).id;
      const liveSignals = await count('risk_signals', `expires_at > now()`);
      await resetCoalescing();

      const stood = await ingest(
        WAR_MONITOR, 'Полтавщина — відбій загрози ударних БпЛА.', new Date(Date.now() - 20 * MINUTE), 'ret-2'
      );

      // An all-clear published twenty minutes ago says nothing about a report published five minutes
      // ago. Replaying one out of a channel's history must not end a threat that came after it.
      expect((stood as { withdrawal: { withdrawnAssertions: number } }).withdrawal.withdrawnAssertions).toBe(0);
      expect(await count('threat_assertions', `withdrawn_at IS NOT NULL`)).toBe(0);
      expect((await eventRow(eventId)).status).toBe('observed');
      expect(await count('risk_signals', `expires_at > now()`)).toBe(liveSignals);
    });

    it('still retracts what the stand-down actually covers', async () => {
      const asserted = await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.', new Date(Date.now() - 20 * MINUTE), 'ret-3');
      const eventId = (asserted as { id: string }).id;
      await resetCoalescing();

      const stood = await ingest(
        WAR_MONITOR, 'Полтавщина — відбій загрози ударних БпЛА.', new Date(Date.now() - 2 * MINUTE), 'ret-4'
      );

      expect((stood as { withdrawal: { withdrawnAssertions: number } }).withdrawal.withdrawnAssertions).toBeGreaterThan(0);
      expect((await eventRow(eventId)).status).toBe('withdrawn');
    });

    it('does not let an older assertion revive a withdrawal a newer message wrote', async () => {
      // The event is kept alive by a second monitor throughout, so the withdrawn assertion row stays
      // attached to a LIVE event — which is the only shape in which the conflict branch of
      // `assertThreat` is ever reached with a non-null `withdrawn_at`.
      await ingest(ERADAR, 'БпЛА на Полтавщині.', new Date(Date.now() - 25 * MINUTE), 'rev-1');
      await resetCoalescing();
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.', new Date(Date.now() - 20 * MINUTE), 'rev-2');
      await resetCoalescing();
      await ingest(WAR_MONITOR, 'Полтавщина — відбій загрози ударних БпЛА.', new Date(Date.now() - 10 * MINUTE), 'rev-3');
      const withdrawnAt = (await sql<{ withdrawn_at: string }>(
        `SELECT withdrawn_at::text FROM threat_assertions WHERE source_id=$1 AND withdrawn_at IS NOT NULL`,
        [WAR_MONITOR]
      )).rows[0]!.withdrawn_at;
      await resetCoalescing();

      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.', new Date(Date.now() - 15 * MINUTE), 'rev-4');

      const stillWithdrawn = await sql<{ withdrawn_at: string | null }>(
        `SELECT withdrawn_at::text FROM threat_assertions WHERE source_id=$1`, [WAR_MONITOR]
      );
      expect(stillWithdrawn.rows.every((row) => row.withdrawn_at === withdrawnAt)).toBe(true);

      // The positive control: a message published AFTER the stand-down is a genuine re-assertion and
      // still clears it. The rule is ordering, not a blanket refusal.
      await resetCoalescing();
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.', new Date(Date.now() - 1 * MINUTE), 'rev-5');
      const revived = await sql<{ withdrawn_at: string | null }>(
        `SELECT withdrawn_at::text FROM threat_assertions WHERE source_id=$1`, [WAR_MONITOR]
      );
      expect(revived.rows.some((row) => row.withdrawn_at === null)).toBe(true);
    });

    it('suppresses a notification for a threat whose validity window has already passed', async () => {
      // Defence in depth in `src/bot/outbox.ts`: the fan-out reads `system_event_log` through its own
      // cursor, and a cursor far enough behind would otherwise send a warning whose deadline passed
      // while it sat in the queue.
      await seedUser(6005);
      await seedSubscription({ chatId: 6005, locationId: POLTAVA_OBLAST });
      const created = await ingest(ERADAR, 'Шахед курсом на Полтавщину.', new Date(), 'exp-1');
      const eventId = (created as { id: string }).id;
      await sql(`UPDATE threat_events SET valid_until=now() - interval '1 minute' WHERE id=$1`, [eventId]);

      await runFanout();

      expect(await count('notification_outbox')).toBe(0);
    });
  });

  // ----------------------------------------------------------------------------------------------
  // The operator surface
  // ----------------------------------------------------------------------------------------------

  describe('GET /ops/api/backfill', () => {
    const OPS = `Basic ${Buffer.from('operator:change-me').toString('base64')}`;

    async function buildApp(): Promise<FastifyInstance> {
      const Fastify = (await import('fastify')).default;
      const opsBackfillRoutes = (await import('../../src/api/ops-backfill-routes.js')).default;
      const app = Fastify({ logger: false });
      await app.register(opsBackfillRoutes);
      await app.ready();
      return app;
    }

    it('is closed without operator credentials and read-only with them', async () => {
      const app = await buildApp();
      try {
        const anonymous = await app.inject({ method: 'GET', url: '/ops/api/backfill' });
        expect(anonymous.statusCode).toBe(401);
        expect(anonymous.headers['www-authenticate']).toBe('Basic realm="ThreatLens Ops"');

        // There is deliberately no manual trigger: an operator-fired history burst is the request
        // shape the flood-wait policy exists to avoid, and a button nobody can press cannot be
        // pressed twice during an incident.
        const write = await app.inject({
          method: 'POST', url: '/ops/api/backfill', headers: { authorization: OPS }, payload: {}
        });
        expect(write.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('returns the thresholds beside the rows they explain', async () => {
      // The cursor is 400 minutes back and MAX_AGE is 360, so the window loses its tail before a
      // single request is made: the run succeeds, reports itself `truncated` with reason `age`, and
      // the console shows «дозбір обмежено: віком» rather than an error.
      await seedArchivedMessage(ERADAR, '60', 400);
      const fake = fakePort([{
        sourceId: ERADAR, username: 'eRadarrua', adapterType: 'mtproto_monitor',
        messages: [post(61, 100, 'Шахед курсом на Полтавщину.')]
      }]);
      await runSweep(fake.port);

      const app = await buildApp();
      try {
        const response = await app.inject({
          method: 'GET', url: '/ops/api/backfill', headers: { authorization: OPS }
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.thresholds).toMatchObject({
          enabled: true, minGapSeconds: 3600, maxAgeSeconds: 21_600, maxMessages: 300
        });
        expect(body.sweep.running).toBe(false);
        expect(body.notice).toContain('Офіційні alert-канали');
        const row = body.sources.find((source: { sourceId: string }) => source.sourceId === ERADAR);
        expect(row).toMatchObject({
          lastRunStatus: 'truncated', truncatedReason: 'age',
          messagesReplayed: 0, messagesStale: 1, pagesRead: 1, consecutiveFailures: 0
        });
        expect(row.lastError).toBeNull();
      } finally {
        await app.close();
      }
    });
  });
});
