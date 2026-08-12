import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { count, ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

/**
 * Covers the liveness condition in `reconcileAggregateAlert` (`src/services/ingestion.ts`).
 *
 * ## The incident this exists for
 *
 * On 2026-08-12 the MTProto collector stopped receiving updates while remaining subscribed and
 * connected. Its `alert_source_states` row for Kyiv stayed `active=true`, frozen at 09:53 UTC. The
 * independent HTTP mirror — a different adapter polling the same executive-authority state — cleared
 * Kyiv at 11:33 UTC, correctly and on time. At 16:23 the map still showed an air-raid alert over
 * Kyiv, because `bool_or(holds)` weighed a row nobody had touched in five hours exactly as heavily
 * as one written a minute earlier.
 *
 * The rule now requires a source to be ALIVE — `sources.last_success_at` inside
 * `ALERT_SOURCE_LIVENESS_SECONDS` — before its row is allowed to hold an alert.
 *
 * ## Why the aggregate is driven directly here
 *
 * `reconcileAggregateAlert` is module-private and every public entry point into it either polls an
 * HTTP adapter or parses a channel message, both of which would put the thing under test behind a
 * parser this file is not about. `ingestAlertChannelMessages` is the narrowest public door: one
 * message, one location, and it runs the real aggregate in the real transaction.
 *
 * The dead source is aged directly because there is no way to *produce* a five-hour-old row from
 * the outside in a test — which is precisely the state the incident consisted of.
 *
 * Note what every scenario below has in common: a SECOND, live source. That is not incidental
 * framing. The rule discounts a dead row only while some source for the same location is alive; if
 * everything is silent it switches off and the aggregate behaves exactly as it did before. The
 * `all sources dead` case has its own test at the end.
 */

const ALERT_TYPE = 'air_raid';
/**
 * A raion, not an oblast, and seeded under the `test-` prefix like every other alert-channel
 * fixture. The channel publishes by raion — «Повітряна тривога в Нікопольський район» — and the
 * parser resolves what the channel actually writes; an oblast name reaches no location at all,
 * which the first draft of this file discovered the hard way by asserting against a map that was
 * never lit.
 *
 * The name is invented rather than borrowed from a real raion for the same class of reason: a real
 * name also exists in the KATOTTG import, the parser resolves it to THAT id, and the period lands
 * on a location this file never looks at — a second way to assert against a map that was never lit.
 */
const RAION = 'test-raion-liveness';
/** A Telegram alert channel: publishes events, and only decides when no API is reachable. */
const CHANNEL = 'air-alert-ua';
/** An alert API: publishes snapshots, and decides whenever it is reachable. */
const API = 'aerial-alerts-mirror';
/** A second alert channel, for the cases that are about two peers rather than about precedence. */
const SECOND_CHANNEL = 'gov-kyiv-oblast-oda';
/** Every adapter the precedence rule treats as an API, so a test can silence all of them at once. */
const API_SOURCES = "adapter_type IN ('alerts_in_ua','ukraine_alarm','aerial_alerts_mirror')";

async function loadIngestion() {
  return import('../../src/services/ingestion.js');
}

/** Seeds one source row with an explicit liveness age, in minutes ago. */
async function seedSourceLiveness(id: string, minutesAgo: number | null): Promise<void> {
  await sql(
    `UPDATE sources SET last_success_at = CASE WHEN $2::int IS NULL THEN NULL
                                          ELSE now() - ($2::int * interval '1 minute') END
      WHERE id=$1`,
    [id, minutesAgo]
  );
}

/**
 * Raises a real alert over Kyiv oblast from `source`, through the production path.
 *
 * Deliberately NOT a hand-written `alert_source_states` row. The first draft of this file seeded the
 * state directly and never created an `alert_periods` row at all, so «no active period» was true
 * before the assertion ran and two of the four tests passed without exercising anything. Publishing
 * the alert the way the channel publishes it means the period exists because the code put it there.
 */
async function raiseAlert(source: string, externalId: string): Promise<void> {
  const { ingestAlertChannelMessages } = await loadIngestion();
  await ingestAlertChannelMessages(source, [{
    externalId, publishedAt: new Date(),
    text: '🔴 12:29 Повітряна тривога в Тестолуцький район\nСлідкуйте за подальшими повідомленнями.'
  }]);
}

/** Publishes an all-clear for the same location from `source`. */
async function clearAlert(source: string, externalId: string): Promise<void> {
  const { ingestAlertChannelMessages } = await loadIngestion();
  await ingestAlertChannelMessages(source, [{
    externalId, publishedAt: new Date(),
    text: '🟢 12:18 Відбій тривоги в Тестолуцький район.\nСлідкуйте за подальшими повідомленнями.'
  }]);
}

/**
 * `count` from the harness, not a hand-rolled query: `sql()` resolves to a pg `QueryResult`, and the
 * first draft of this file read `rows[0]` off that object rather than off `.rows`. Every assertion
 * then saw `undefined`, reported zero active periods, and three tests failed while the rule under
 * test was working correctly all along.
 */
async function activePeriods(location: string): Promise<number> {
  return count('alert_periods', `location_id=$1 AND alert_type=$2 AND status='active'`, [location, ALERT_TYPE]);
}

describe.skipIf(!integrationDatabaseAvailable)('alert aggregate liveness', () => {
  beforeAll(async () => { await ensureMigrated(); });
  beforeEach(async () => {
    await resetDatabase();
    // The raion row the KATOTTG import provides in production. `test-` prefixed so `resetDatabase`
    // removes it again.
    await sql(
      `INSERT INTO locations(id,parent_id,type,name_uk,aliases)
       VALUES ($1,'ua-32','raion','Тестолуцький район','{}') ON CONFLICT (id) DO NOTHING`,
      [RAION]
    );
  });

  it('raises a real alert first, so every assertion below starts from a lit map', async () => {
    // The guard against the mistake this file was rewritten to fix: if publishing an alert did not
    // actually create a period, «the alert ended» would be indistinguishable from «there was never
    // an alert», and the two tests that assert zero would pass without exercising anything.
    await seedSourceLiveness(CHANNEL, 0);
    await raiseAlert(CHANNEL, 'raise-only');
    expect(await activePeriods(RAION)).toBe(1);
  });

  it('lets a live source clear a location a dead source is still holding', async () => {
    // The incident, reproduced. The alert is raised while the source is healthy…
    await seedSourceLiveness(CHANNEL, 0);
    await raiseAlert(CHANNEL, '1a');
    expect(await activePeriods(RAION)).toBe(1);
    // …and then that source freezes: still `active=true` in its state row, no sign of life for five
    // hours. This is exactly what the collector looked like on 2026-08-12 while reporting ready.
    await seedSourceLiveness(CHANNEL, 300);
    // A second, healthy source publishes the all-clear. Before the liveness rule this changed
    // nothing: `bool_or` stayed true on the frozen row and Kyiv kept its polygon for hours.
    await seedSourceLiveness(API, 0);
    await clearAlert(API, '1b');
    expect(await activePeriods(RAION)).toBe(0);
  });

  it('keeps the alert while the holding source is alive', async () => {
    // Same shape, one difference: the holder stays healthy. Its `active` is then real evidence, and
    // another source disagreeing must NOT end the alert — that is the two-source rule, and the
    // liveness condition is not allowed to weaken it.
    //
    // Both sources here are CHANNELS, and the APIs are silenced first. That is not incidental: once
    // an API is reachable it decides alone, so the two-source rule is only observable among peers.
    // Written with an API on one side, this test would be asserting the opposite of the precedence
    // rule — which is exactly what it did before that rule existed, and why it failed the moment the
    // rule landed.
    await sql(`UPDATE sources SET last_success_at=NULL WHERE ${API_SOURCES}`);
    await seedSourceLiveness(CHANNEL, 0);
    await raiseAlert(CHANNEL, '2a');
    expect(await activePeriods(RAION)).toBe(1);
    await seedSourceLiveness(SECOND_CHANNEL, 0);
    await clearAlert(SECOND_CHANNEL, '2b');
    expect(await activePeriods(RAION)).toBe(1);
  });

  it('treats a source that has never reported success as not alive', async () => {
    // NULL `last_success_at` is «no evidence of life», not «alive by default». A row that has never
    // once connected must not be able to pin a location under alert.
    await seedSourceLiveness(CHANNEL, 0);
    await raiseAlert(CHANNEL, '3a');
    await seedSourceLiveness(CHANNEL, null);
    await seedSourceLiveness(API, 0);
    await clearAlert(API, '3b');
    expect(await activePeriods(RAION)).toBe(0);
  });

  it('changes nothing when every source is dead', async () => {
    // The safety condition, and the reason the first version of this rule was wrong. `resetDatabase`
    // nulls `last_success_at` on every row, so this is also the exact state that turned twenty-one
    // existing alert tests red before `any_alive` was added.
    //
    // Losing contact with everything must not read as everyone publishing an all-clear: during an
    // outage nobody can correct a map that clears itself, and «we do not know» has to keep showing
    // the last thing we did know.
    await seedSourceLiveness(CHANNEL, 0);
    await raiseAlert(CHANNEL, '5a');
    expect(await activePeriods(RAION)).toBe(1);
    await sql('UPDATE sources SET last_success_at=NULL');
    // Nothing is alive now, including the source publishing this all-clear — so the aggregate falls
    // back to its pre-liveness behaviour, where an explicit 🟢 from one source still ends its own
    // hold. What must NOT happen is the OTHER source's row being discounted for being dead.
    const { expireStuckAlertChannelAlerts } = await loadIngestion();
    await expireStuckAlertChannelAlerts({ warn: () => undefined });
    expect(await activePeriods(RAION)).toBe(1);
  });

  it('lets a live API overrule a channel that is still holding', async () => {
    // The rule the owner asked for, and the one that resolves the incident directly: an alert is
    // declared from an API whenever an API is reachable. Here the channel is not stale, not frozen
    // and not wrong about anything it can know — it simply does not get the vote.
    await seedSourceLiveness(CHANNEL, 0);
    await raiseAlert(CHANNEL, 'p1');
    expect(await activePeriods(RAION)).toBe(1);
    // The API is alive and does not report this location. For a snapshot source that is not silence,
    // it is a statement: there is no alert here.
    await seedSourceLiveness(API, 0);
    await sql(
      `UPDATE alert_source_states SET active=false,missing_since=NULL,last_seen_at=now()
        WHERE source_id=$1`, [API]
    );
    await clearAlert(API, 'p2');
    expect(await activePeriods(RAION)).toBe(0);
  });

  it('hands the decision back to the channels when no API is reachable', async () => {
    // The fallback, and the reason the rule is safe to state so bluntly. With every API dead or
    // switched off, a channel is the only thing that knows anything — so it decides again, exactly
    // as it did before this rule existed.
    await sql(`UPDATE sources SET last_success_at=NULL WHERE ${API_SOURCES}`);
    await seedSourceLiveness(CHANNEL, 0);
    await raiseAlert(CHANNEL, 'f1');
    expect(await activePeriods(RAION)).toBe(1);
  });

  it('does not let a dead API silence the channels', async () => {
    // Precedence is conditional on the API being ALIVE, not on it existing. An API row that stopped
    // polling hours ago must not keep outvoting a channel that is still reporting — that would be
    // the original failure with the sources swapped.
    await sql(`UPDATE sources SET last_success_at=now()-interval '5 hours' WHERE ${API_SOURCES}`);
    await seedSourceLiveness(CHANNEL, 0);
    await raiseAlert(CHANNEL, 'd1');
    expect(await activePeriods(RAION)).toBe(1);
  });

  it('counts every discounted row so the trade-off is visible', async () => {
    const { registerAlertChannelMetrics } = await loadIngestion();
    const { Registry } = await import('prom-client');
    const registry = new Registry();
    registerAlertChannelMetrics(registry);
    await seedSourceLiveness(CHANNEL, 0);
    await raiseAlert(CHANNEL, '4a');
    await seedSourceLiveness(CHANNEL, 300);
    await seedSourceLiveness(API, 0);
    await clearAlert(API, '4b');
    // Silence here would be the worst outcome: the aggregate would simply come out different and
    // nothing anywhere would say a row had been discounted.
    const dump = await registry.metrics();
    const lines = dump.split('\n').filter((row) => row.startsWith('threatlens_alert_stale_sources_ignored_total{'));
    expect(lines.length).toBeGreaterThan(0);
    const total = lines.reduce((sum, row) => sum + Number(row.split(' ').pop()), 0);
    expect(total).toBeGreaterThan(0);
  });
});

/**
 * Covers `alertBackfillGap` in `src/sources/telegram.ts`.
 *
 * The reconnect backfill reads a bounded window, and when a bound bites it simply stops — leaving
 * messages between the newest post already stored and the oldest post just fetched that nobody will
 * ever read. On 2026-08-12 that hole was twenty-three minutes wide and held the all-clear for Kyiv.
 * Nothing reported it: the backfill logged what it HAD read and said nothing about what it had not.
 */
describe.skipIf(!integrationDatabaseAvailable)('alert backfill gap detection', () => {
  beforeAll(async () => { await ensureMigrated(); });
  beforeEach(async () => { await resetDatabase(); });

  async function storeMessage(externalId: string): Promise<void> {
    await sql(
      `INSERT INTO source_messages(source_id,external_id,published_at,raw_text,raw_payload,
         content_hash,processing_status)
       VALUES ($1,$2,now(),'seed','{}',md5($2),'alert')
       ON CONFLICT DO NOTHING`,
      [CHANNEL, externalId]
    );
  }

  it('reports the hole between the archive and the window', async () => {
    const { alertBackfillGap } = await import('../../src/sources/telegram.js');
    await storeMessage('1000');
    // The window began at 1024: ids 1001..1023 were never read by anyone and never will be, because
    // the live stream starts after them.
    const gap = await alertBackfillGap(CHANNEL, [{ externalId: '1024' }, { externalId: '1030' }]);
    expect(gap).toEqual({ missing: 23, storedThrough: 1000, windowFrom: 1024 });
  });

  it('reports nothing when the window overlaps the archive', async () => {
    const { alertBackfillGap } = await import('../../src/sources/telegram.js');
    await storeMessage('1000');
    // Reaching back past what we already had is the healthy case and must stay silent, or the WARN
    // becomes noise on every single reconnect and stops being read.
    expect(await alertBackfillGap(CHANNEL, [{ externalId: '995' }, { externalId: '1010' }])).toBeNull();
  });

  it('reports nothing on a first run, when there is no archive to be discontinuous with', async () => {
    const { alertBackfillGap } = await import('../../src/sources/telegram.js');
    expect(await alertBackfillGap(CHANNEL, [{ externalId: '1024' }])).toBeNull();
  });

  it('treats consecutive ids as no gap at all', async () => {
    const { alertBackfillGap } = await import('../../src/sources/telegram.js');
    await storeMessage('1000');
    // 1001 directly follows 1000: nothing is missing, and an off-by-one here would fire a WARN on
    // every clean reconnect.
    expect(await alertBackfillGap(CHANNEL, [{ externalId: '1001' }])).toBeNull();
  });
});
