import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

/**
 * Two writers of official alert state at the same time — the case every other alert file avoids by
 * awaiting one poll before the next.
 *
 * ## Why this file exists
 *
 * The scheduler runs each alert source as its own leg, so the mirror (every 4 s) and alerts.in.ua
 * (every 7 s) overlap routinely. Each snapshot pass is one transaction that re-reconciles every
 * location its source has ever held, and every reconcile takes `FOR UPDATE` on that location's
 * active `alert_periods` row, in the order the source's own rows come back. Two sources that share
 * active periods therefore took the same row locks in different orders: on 22.09.2026 a scratch
 * reproduction of exactly that — twenty-five oblasts, the two sources' rows in opposite orders — lost
 * one pass to `deadlock detected` in twenty-five rounds out of twenty-five, and the losing source
 * went to `health_status='error'`. The same overlap let two passes each open their own period for
 * one new alert, because neither could see the other's uncommitted INSERT.
 *
 * `ALERT_STATE_LOCK` (`src/services/ingestion.ts`) serialises every such transaction. These tests
 * drive the real adapters — the mirror in its oblast-only mode and alerts.in.ua — through their
 * exported `sync*` entry points with `fetch` stubbed, the way `alert-reconciliation.test.ts` and
 * `aerial-mirror.test.ts` do, and assert on what the table holds afterwards.
 *
 * ## Why the mirror runs oblast-only here
 *
 * `AERIAL_MIRROR_RAW_SOURCE=''` makes the mirror read the aggregated `states` object: twenty-five
 * oblast rows, no raion catalogue to seed, and the same `persistOfficialAlertSnapshot` →
 * `runSnapshotPass` path the granular feed takes. The contention is on `alert_periods` rows, and
 * oblasts are rows both sources name.
 */

const MIRROR_URL = 'https://ubilling.net.ua/aerialalerts/';
const ALERTS_IN_UA_URL = 'https://api.alerts.in.ua/v1/alerts/active.json';
const MIRROR = 'aerial-alerts-mirror';
const ALERTS_IN_UA = 'alerts-in-ua';

/** The twenty-five region labels the aggregated feed prints, taken from a real capture. */
const REGION_NAMES = Object.keys((JSON.parse(
  readFileSync(new URL('../fixtures/aerial-mirror-snapshot.json', import.meta.url), 'utf8')
) as { states: Record<string, unknown> }).states);

/** «YYYY-MM-DD HH:MM:SS» on the Kyiv wall clock — the format the mirror prints. */
function kyivStamp(at: Date): string {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Kyiv', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(at)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** Every region alight since `startedAt`, under a `cachedat` of now so the staleness gate passes. */
function mirrorBody(startedAt: Date): unknown {
  return {
    source: 'integration',
    cachedat: kyivStamp(new Date()),
    states: Object.fromEntries(REGION_NAMES.map((name) => [name, { alertnow: true, changed: kyivStamp(startedAt) }]))
  };
}

interface Region { id: string; name: string }

/** alerts.in.ua's body, rows in exactly the order given — the order is the point of these tests. */
function alertsInUaBody(regions: Region[], startedAt: Date): unknown {
  return {
    alerts: regions.map((region) => ({
      region_id: region.id, region_name: region.name, alert_type: 'air_raid',
      status: 'active', started_at: startedAt.toISOString()
    }))
  };
}

const responses = new Map<string, unknown>();

async function pollMirror(body: unknown): Promise<void> {
  responses.set(MIRROR_URL, body);
  const { syncAerialMirror } = await import('../../src/services/ingestion.js');
  await syncAerialMirror();
}

async function pollAlertsInUa(body: unknown): Promise<void> {
  responses.set(ALERTS_IN_UA_URL, body);
  const { syncAlertsInUa } = await import('../../src/services/ingestion.js');
  await syncAlertsInUa();
}

/**
 * The locations one source holds, in the order its snapshot pass will reconcile them.
 *
 * `runSnapshotPass` walks the rows `SELECT … WHERE source_id=$1` returns, which on a table nobody
 * has updated is physical order — `ctid`. That is what makes «opposite order» something a test can
 * construct instead of something it hopes for.
 */
async function reconcileOrder(sourceId: string): Promise<Region[]> {
  const rows = await sql<Region>(
    `SELECT s.location_id AS id,l.name_uk AS name
       FROM alert_source_states s JOIN locations l ON l.id=s.location_id
      WHERE s.source_id=$1 ORDER BY s.ctid`,
    [sourceId]
  );
  return rows.rows;
}

async function activePeriodsPerLocation(): Promise<Map<string, number>> {
  const rows = await sql<{ location_id: string; n: number }>(
    `SELECT location_id,count(*)::int AS n FROM alert_periods WHERE status='active' GROUP BY location_id`
  );
  return new Map(rows.rows.map((row) => [row.location_id, row.n]));
}

async function eventCount(eventType: string): Promise<number> {
  const rows = await sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM system_event_log WHERE event_type=$1`, [eventType]
  );
  return rows.rows[0]!.n;
}

async function health(sourceId: string): Promise<{ health_status: string; last_error: string | null }> {
  const rows = await sql<{ health_status: string; last_error: string | null }>(
    `SELECT health_status,last_error FROM sources WHERE id=$1`, [sourceId]
  );
  return rows.rows[0]!;
}

/** Why a settled pass failed, or null when it did not. */
function failures(results: PromiseSettledResult<void>[]): string[] {
  return results.flatMap((result) => result.status === 'rejected'
    ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
}

/**
 * Runs `body` with the application pool's sessions under a short `statement_timeout`.
 *
 * The pool sets `statement_timeout: 15_000` on every connection, and that is the bound on how long a
 * writer waits for `ALERT_STATE_LOCK`. Waiting fifteen real seconds per test would prove nothing a
 * shorter wait does not, so the same session setting is lowered on both connections the test pool
 * has (`max: 2` under `NODE_ENV=test`) and put back afterwards. The mechanism under test is the
 * production one; only the number is smaller.
 */
async function withAppStatementTimeout<T>(ms: number, body: () => Promise<T>): Promise<T> {
  const { pool } = await import('../../src/db/pool.js');
  const set = async (value: string): Promise<void> => {
    const clients = await Promise.all([pool.connect(), pool.connect()]);
    try {
      for (const client of clients) await client.query(`SELECT set_config('statement_timeout',$1,false)`, [value]);
    } finally {
      for (const client of clients) client.release();
    }
  };
  const original = (await pool.query<{ statement_timeout: string }>('SHOW statement_timeout')).rows[0]!.statement_timeout;
  await set(`${ms}ms`);
  try {
    return await body();
  } finally {
    await set(original);
  }
}

describe.skipIf(!integrationDatabaseAvailable)('alert state writers are serialised', () => {
  beforeAll(ensureMigrated);

  let restoreConfig: () => void = () => undefined;

  beforeEach(async () => {
    await resetDatabase();
    responses.clear();
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      if (!responses.has(url)) throw new Error(`unexpected fetch: ${url}`);
      return { ok: true, status: 200, json: async () => responses.get(url) };
    });
    const { config } = await import('../../src/config.js');
    const mutable = config as unknown as Record<string, unknown>;
    const saved = { AERIAL_MIRROR_RAW_SOURCE: mutable.AERIAL_MIRROR_RAW_SOURCE };
    mutable.AERIAL_MIRROR_RAW_SOURCE = '';
    restoreConfig = () => { Object.assign(mutable, saved); };
  });

  afterEach(() => {
    restoreConfig();
    vi.unstubAllGlobals();
  });

  it('two snapshot sources re-reconciling the same active periods in opposite orders both succeed', async () => {
    const startedAt = new Date(Math.floor((Date.now() - 600_000) / 1000) * 1000);
    await pollMirror(mirrorBody(startedAt));
    const mirrorOrder = await reconcileOrder(MIRROR);
    expect(mirrorOrder).toHaveLength(REGION_NAMES.length);
    // alerts.in.ua first lists them backwards, so its rows — and therefore its locks — run the other
    // way round for the rest of the test.
    const reversed = alertsInUaBody([...mirrorOrder].reverse(), startedAt);
    await pollAlertsInUa(reversed);
    expect((await reconcileOrder(ALERTS_IN_UA)).map((region) => region.id))
      .toEqual([...mirrorOrder].reverse().map((region) => region.id));

    const failed: string[] = [];
    for (let round = 0; round < 5; round += 1) {
      failed.push(...failures(await Promise.allSettled([
        pollMirror(mirrorBody(startedAt)),
        pollAlertsInUa(reversed)
      ])));
    }

    expect(failed).toEqual([]);
    expect(await health(MIRROR)).toEqual({ health_status: 'current', last_error: null });
    expect(await health(ALERTS_IN_UA)).toEqual({ health_status: 'current', last_error: null });
    const perLocation = await activePeriodsPerLocation();
    expect(perLocation.size).toBe(mirrorOrder.length);
    expect([...perLocation.values()].every((n) => n === 1)).toBe(true);
    expect(await eventCount('alert.started')).toBe(mirrorOrder.length);
    expect(await eventCount('alert.ended')).toBe(0);
  });

  it('two sources raising the same new alerts at once open exactly one period per location', async () => {
    // Learn the catalogue ids the mirror's labels resolve to, then start from an empty table again.
    await pollMirror(mirrorBody(new Date(Date.now() - 600_000)));
    const regions = await reconcileOrder(MIRROR);
    await resetDatabase();

    // Starts four seconds apart, as two providers stamp one alert: different `started_at` values
    // do not collide on `UNIQUE (location_id, alert_type, started_at)`, so nothing but the lock
    // stops each pass from opening its own period.
    const mirrorStart = new Date(Math.floor((Date.now() - 300_000) / 1000) * 1000);
    const alertsInUaStart = new Date(mirrorStart.getTime() + 4_000);
    const results = await Promise.allSettled([
      pollMirror(mirrorBody(mirrorStart)),
      pollAlertsInUa(alertsInUaBody([...regions].reverse(), alertsInUaStart))
    ]);

    expect(failures(results)).toEqual([]);
    const perLocation = await activePeriodsPerLocation();
    expect(perLocation.size).toBe(regions.length);
    expect([...perLocation.entries()].filter(([, n]) => n !== 1)).toEqual([]);
    expect(await eventCount('alert.started')).toBe(regions.length);
  });

  it('a writer that cannot take the lock fails as a source error and leaves alert state untouched', async () => {
    const { ALERT_STATE_LOCK } = await import('../../src/services/ingestion.js');
    const startedAt = new Date(Math.floor((Date.now() - 600_000) / 1000) * 1000);
    await pollMirror(mirrorBody(startedAt));
    const regions = await reconcileOrder(MIRROR);

    // A holder that never lets go — the shape of a wedged writer.
    const holder = await db().connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1)', [ALERT_STATE_LOCK]);
      const waitedFrom = Date.now();
      const outcome = await withAppStatementTimeout(1_000, () =>
        pollAlertsInUa(alertsInUaBody(regions, startedAt)).then(() => null, (error: unknown) => error));
      const waited = Date.now() - waitedFrom;

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/alert state lock/);
      // Bounded by the timeout, not by the holder: the holder is still holding.
      expect(waited).toBeLessThan(10_000);
      const source = await health(ALERTS_IN_UA);
      expect(source.health_status).toBe('error');
      expect(source.last_error).toMatch(/alert state lock/);
      // The pass rolled back: alerts.in.ua holds nothing, and the mirror's periods are as they were.
      expect(await reconcileOrder(ALERTS_IN_UA)).toEqual([]);
      expect((await activePeriodsPerLocation()).size).toBe(regions.length);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }

    // The holder is gone; the next pass goes through as normal.
    await pollAlertsInUa(alertsInUaBody(regions, startedAt));
    expect(await health(ALERTS_IN_UA)).toEqual({ health_status: 'current', last_error: null });
    expect(await reconcileOrder(ALERTS_IN_UA)).toHaveLength(regions.length);
  });
});

/**
 * The lock serialises only the transactions that take it, so the property worth pinning is that
 * every one of them does — including a fourth writer nobody has written yet.
 *
 * Source text rather than behaviour, deliberately, and in the style of the `publication-mode` check
 * on `UPDATE alert_periods`: a writer that forgot the lock behaves exactly like one that took it
 * until two of them overlap, which no single-threaded test will ever arrange.
 */
describe('alert state writers all take the lock', () => {
  const ingestion = readFileSync(new URL('../../src/services/ingestion.ts', import.meta.url), 'utf8');

  it('every transaction that reconciles an alert opens through beginAlertStateTransaction', () => {
    const functions = ingestion.split(/\n(?=(?:export )?async function )/);
    const reconcilers = functions.filter((body) => /reconcileAggregateAlert\(client,/.test(body));
    // runSnapshotPass, applyAlertChannelStates, expireStuckAlertChannelAlerts.
    expect(reconcilers).toHaveLength(3);
    for (const body of reconcilers) {
      const name = /async function (\w+)/.exec(body)?.[1];
      expect({ name, locked: body.includes('await beginAlertStateTransaction(client)') })
        .toEqual({ name, locked: true });
      expect({ name, rawBegin: body.includes(`client.query('BEGIN')`) }).toEqual({ name, rawBegin: false });
    }
  });

  it('nothing outside ingestion.ts writes alert_periods or alert_source_states', async () => {
    const { readdir } = await import('node:fs/promises');
    const root = new URL('../../src/', import.meta.url);
    const files = (await readdir(root, { recursive: true }))
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'));
    const writers = files.filter((file) => {
      const text = readFileSync(new URL(file, root), 'utf8');
      return /(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+(TABLE\s+)?alert_(periods|source_states)\b/i.test(text);
    });
    expect(writers.map((file) => file.replaceAll('\\', '/'))).toEqual(['services/ingestion.ts']);
  });
});
