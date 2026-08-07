import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

/**
 * Covers the event-driven reconciliation path in `src/services/ingestion.ts`, which the official
 * alert channel https://t.me/air_alert_ua uses.
 *
 * The rule under test is the one that separates this source from the polled adapters: the channel
 * publishes *events*, so a message about one raion must leave every other raion of the same source
 * exactly as it was. Running it through `persistOfficialAlertSnapshot` instead would clear the whole
 * country every time one oblast reported an alert.
 *
 * Message texts are verbatim captures from the live channel. Nothing here touches the network.
 */

const NIKOPOL = 'test-raion-nikopol';
const PAVLOHRAD = 'test-raion-pavlohrad';
const KUPIANSK = 'test-raion-kupiansk';
const KHARKIV_CITY = 'ua-city-kharkiv';

/** Telegram publication times. The clock printed inside a message is deliberately never used. */
const T0 = '2026-08-07T09:00:00.000Z';
const T1 = '2026-08-07T09:05:00.000Z';
const T2 = '2026-08-07T09:40:00.000Z';

interface ChannelPost { id: string; at: string; text: string }

async function ingest(posts: ChannelPost[]) {
  const { ingestAlertChannelMessages } = await import('../../src/services/ingestion.js');
  return ingestAlertChannelMessages(
    posts.map((post) => ({ externalId: post.id, publishedAt: new Date(post.at), text: post.text })),
    { warn: () => undefined }
  );
}

async function expireStuck() {
  const { expireStuckAlertChannelAlerts } = await import('../../src/services/ingestion.js');
  return expireStuckAlertChannelAlerts({ warn: () => undefined });
}

async function alertPeriods(): Promise<Array<{ location_id: string; status: string; ended_at: string | null }>> {
  const rows = await sql<{ location_id: string; status: string; ended_at: string | null }>(
    `SELECT location_id,status,ended_at::text FROM alert_periods ORDER BY location_id`
  );
  return rows.rows;
}

async function channelStates(): Promise<Array<{ location_id: string; active: boolean; missing_since: string | null }>> {
  const rows = await sql<{ location_id: string; active: boolean; missing_since: string | null }>(
    `SELECT location_id,active,missing_since::text FROM alert_source_states
     WHERE source_id='air-alert-ua' ORDER BY location_id`
  );
  return rows.rows;
}

async function alertEvents(): Promise<string[]> {
  const rows = await sql<{ event_type: string }>(
    `SELECT event_type FROM system_event_log WHERE event_type LIKE 'alert.%' ORDER BY version`
  );
  return rows.rows.map((row) => row.event_type);
}

/**
 * Ages a running alert past `ALERT_CHANNEL_MAX_ALERT_SECONDS`.
 *
 * The bound is wall-clock and evaluated inside PostgreSQL, and its production value is a day, so
 * backdating the start the reconciler itself wrote is the only practical way to reach it. The
 * decision that reads it stays entirely inside `expireStuckAlertChannelAlerts`.
 */
async function ageAlertPastMaximumDuration(): Promise<void> {
  await sql(
    `UPDATE alert_source_states SET provider_started_at=now()-interval '3 days'
     WHERE source_id='air-alert-ua' AND active=true`
  );
}

const startNikopol = (id: string, at: string): ChannelPost => ({
  id, at,
  text: '🔴 12:29 Повітряна тривога в Нікопольський район\n'
    + 'Слідкуйте за подальшими повідомленнями.\n#Нікопольський_район'
});

const endNikopol = (id: string, at: string): ChannelPost => ({
  id, at,
  text: '🟢 12:18 Відбій тривоги в Нікопольський район.\n'
    + 'Слідкуйте за подальшими повідомленнями.\n#Нікопольський_район'
});

describe.skipIf(!integrationDatabaseAvailable)('official alert channel reconciliation', () => {
  beforeAll(ensureMigrated);

  beforeEach(async () => {
    await resetDatabase();
    // Raion rows the parallel KATOTTG import will provide in production. Seeded under the `test-`
    // prefix so `resetDatabase` removes them again.
    await sql(
      `INSERT INTO locations(id,parent_id,type,name_uk,aliases) VALUES
         ($1,'ua-12','raion','Нікопольський район','{}'),
         ($2,'ua-12','raion','Павлоградський район','{}'),
         ($3,'ua-63','raion','Куп''янський район','{}')
       ON CONFLICT (id) DO NOTHING`,
      [NIKOPOL, PAVLOHRAD, KUPIANSK]
    );
  });

  it('starts an alert only in the raion the message names', async () => {
    await ingest([startNikopol('1', T0)]);

    expect(await channelStates()).toEqual([{ location_id: NIKOPOL, active: true, missing_since: null }]);
    expect(await alertPeriods()).toEqual([{ location_id: NIKOPOL, status: 'active', ended_at: null }]);
    expect(await alertEvents()).toEqual(['alert.started']);
  });

  it('does not clear another raion when a second raion goes under alert', async () => {
    // The whole reason this path exists. Under the snapshot model the second message would clear
    // every state this source holds, so Nikopol would be silently taken off the map.
    await ingest([startNikopol('1', T0)]);
    await ingest([{
      id: '2', at: T1,
      text: '🔴 12:31 Повітряна тривога в Павлоградський район\n#Павлоградський_район'
    }]);

    expect(await channelStates()).toEqual([
      { location_id: NIKOPOL, active: true, missing_since: null },
      { location_id: PAVLOHRAD, active: true, missing_since: null }
    ]);
    expect(await alertPeriods()).toEqual([
      { location_id: NIKOPOL, status: 'active', ended_at: null },
      { location_id: PAVLOHRAD, status: 'active', ended_at: null }
    ]);
    expect(await alertEvents()).toEqual(['alert.started', 'alert.started']);
  });

  it('ends only the raion its all-clear names', async () => {
    await ingest([startNikopol('1', T0)]);
    await ingest([{ id: '2', at: T1, text: '🔴 12:31 Повітряна тривога в Павлоградський район' }]);

    await ingest([endNikopol('3', T2)]);

    expect(await alertPeriods()).toEqual([
      { location_id: NIKOPOL, status: 'ended', ended_at: expect.any(String) },
      { location_id: PAVLOHRAD, status: 'active', ended_at: null }
    ]);
    expect(await channelStates()).toEqual([
      { location_id: NIKOPOL, active: false, missing_since: null },
      { location_id: PAVLOHRAD, active: true, missing_since: null }
    ]);
    expect(await alertEvents()).toEqual(['alert.started', 'alert.started', 'alert.ended']);
  });

  it('does not inherit the snapshot end debounce for an explicit all-clear', async () => {
    // ALERT_END_DEBOUNCE_SECONDS exists for polled sources that stop mentioning an alert. An
    // explicit 🟢 is a statement, not a silence: delaying it by a debounce window would hold every
    // genuine all-clear this channel publishes.
    await ingest([startNikopol('1', T0)]);
    await ingest([endNikopol('2', T1)]);

    expect((await alertPeriods())[0]).toMatchObject({ status: 'ended' });
    // `missing_since` is what the debounce reads; the event path must never set it.
    expect((await channelStates())[0]!.missing_since).toBeNull();
  });

  it('clears every raion of a bullet-list all-clear and nothing else', async () => {
    await ingest([{
      id: '1', at: T0,
      text: '🔴 21:54 Повітряна тривога в \n• Нікопольський район\n• Павлоградський район\n'
        + '• Куп’янський район\nСлідкуйте за подальшими повідомленнями.'
    }]);
    expect(await alertPeriods()).toHaveLength(3);

    await ingest([{
      id: '2', at: T1,
      text: '🟢 22:41 Відбій тривоги в \n• Нікопольський район\n• Павлоградський район\n'
        + 'Слідкуйте за подальшими повідомленнями.'
    }]);

    expect(await alertPeriods()).toEqual([
      { location_id: KUPIANSK, status: 'active', ended_at: null },
      { location_id: NIKOPOL, status: 'ended', ended_at: expect.any(String) },
      { location_id: PAVLOHRAD, status: 'ended', ended_at: expect.any(String) }
    ]);
  });

  it('refuses a partial all-clear that repeats the same raion as still under alert', async () => {
    await ingest([{
      id: '1', at: T0, text: '🔴 12:29 Повітряна тривога в Куп’янський район'
    }]);

    const summary = await ingest([{
      id: '2', at: T1,
      text: '🟡 14:04 Відбій тривоги в Куп’янський район.\n'
        + 'Зверніть увагу, тривога ще триває у:\n- Куп’янський район\n#Купянський_район'
    }]);

    expect(summary).toMatchObject({ events: 0, ignored: 1 });
    expect(await alertPeriods()).toEqual([{ location_id: KUPIANSK, status: 'active', ended_at: null }]);
  });

  it('resolves a raion whose apostrophe differs from the catalogue spelling', async () => {
    // The channel prints U+2019; the catalogue row is seeded with the ASCII apostrophe. Without
    // folding, every Куп'янський / Кам'янський / Слов'янський message would be an unmapped location.
    const summary = await ingest([{
      id: '1', at: T0, text: '🔴 12:29 Повітряна тривога в Куп’янський район'
    }]);
    expect(summary.unresolved).toEqual([]);
    expect(await alertPeriods()).toEqual([{ location_id: KUPIANSK, status: 'active', ended_at: null }]);
  });

  it('resolves the city-plus-hromada label to the city, not the oblast around it', async () => {
    await ingest([{
      id: '1', at: T0,
      text: '🔴 12:50 Повітряна тривога в м. Харків та Харківська територіальна громада\n'
        + 'Слідкуйте за подальшими повідомленнями.'
    }]);
    expect(await alertPeriods()).toEqual([{ location_id: KHARKIV_CITY, status: 'active', ended_at: null }]);
  });

  it('rejects an out-of-order all-clear instead of taking an alert off the map', async () => {
    await ingest([startNikopol('2', T2)]);
    // A message published before the alert, delivered after it: normal after a reconnect.
    const summary = await ingest([endNikopol('1', T0)]);

    expect(summary).toMatchObject({ events: 1, applied: 0, skippedStale: 1 });
    expect(await alertPeriods()).toEqual([{ location_id: NIKOPOL, status: 'active', ended_at: null }]);
    expect(await alertEvents()).toEqual(['alert.started']);
  });

  it('folds a replayed backlog to its terminal state instead of re-emitting old events', async () => {
    // Reconnect case: the alert both started and ended while the collector was down. Replaying the
    // window must leave the map correct and the subscribers untouched.
    const summary = await ingest([startNikopol('1', T0), endNikopol('2', T1)]);

    expect(summary).toMatchObject({ events: 2, applied: 1 });
    expect(await alertPeriods()).toEqual([]);
    expect(await alertEvents()).toEqual([]);
    expect(await channelStates()).toEqual([{ location_id: NIKOPOL, active: false, missing_since: null }]);
  });

  it('carries a backlog alert that is still running into a live alert period', async () => {
    const summary = await ingest([
      endNikopol('1', T0),
      startNikopol('2', T1),
      { id: '3', at: T2, text: '🟠 12:45 УВАГА!!!\nЗагроза застосування керованих авіаційних бомб (КАБів).' }
    ]);

    expect(summary).toMatchObject({ events: 2, ignored: 1, applied: 1 });
    expect(await alertPeriods()).toEqual([{ location_id: NIKOPOL, status: 'active', ended_at: null }]);
    expect(await alertEvents()).toEqual(['alert.started']);
  });

  it('clears an alert that outlived the maximum duration and leaves a fresh one alone', async () => {
    await ingest([startNikopol('1', T0)]);
    await ingest([{ id: '2', at: T1, text: '🔴 12:31 Повітряна тривога в Павлоградський район' }]);
    // Only the older alert is aged; a guard that fired on both would be indistinguishable from one
    // that fires on schedule rather than on evidence.
    await sql(
      `UPDATE alert_source_states SET provider_started_at=now()-interval '3 days'
       WHERE source_id='air-alert-ua' AND location_id=$1`, [NIKOPOL]
    );

    expect(await expireStuck()).toBe(1);

    expect(await alertPeriods()).toEqual([
      { location_id: NIKOPOL, status: 'ended', ended_at: expect.any(String) },
      { location_id: PAVLOHRAD, status: 'active', ended_at: null }
    ]);
    expect(await channelStates()).toEqual([
      { location_id: NIKOPOL, active: false, missing_since: null },
      { location_id: PAVLOHRAD, active: true, missing_since: null }
    ]);
    expect(await alertEvents()).toEqual(['alert.started', 'alert.started', 'alert.ended']);
  });

  it('does nothing when no alert has outlived the maximum duration', async () => {
    await ingest([startNikopol('1', T0)]);
    expect(await expireStuck()).toBe(0);
    expect(await alertPeriods()).toEqual([{ location_id: NIKOPOL, status: 'active', ended_at: null }]);
  });

  it('re-raises an alert normally after the guard cleared it', async () => {
    await ingest([startNikopol('1', T0)]);
    await ageAlertPastMaximumDuration();
    await expireStuck();

    await ingest([startNikopol('2', new Date().toISOString())]);

    // The guard closes a period, it does not poison the location: the next 🔴 opens a new one with
    // its own start timestamp, exactly as a polled provider re-reporting an alert would.
    const periods = await sql<{ status: string }>(
      `SELECT status FROM alert_periods WHERE location_id=$1 ORDER BY started_at`, [NIKOPOL]
    );
    expect(periods.rows.map((row) => row.status)).toEqual(['ended', 'active']);
    expect(await alertEvents()).toEqual(['alert.started', 'alert.ended', 'alert.started']);
  });

  it('reports an unmapped raion without failing the source or the rest of the message', async () => {
    const summary = await ingest([{
      id: '1', at: T0,
      text: '🔴 12:29 Повітряна тривога в \n• Нікопольський район\n• Неіснуючий район\n'
    }]);

    expect(summary.unresolved).toEqual(['Неіснуючий район']);
    expect(await alertPeriods()).toEqual([{ location_id: NIKOPOL, status: 'active', ended_at: null }]);
    const source = await sql<{ health_status: string }>(
      `SELECT health_status FROM sources WHERE id='air-alert-ua'`
    );
    // A catalogue gap is not a source outage; the source must not be pushed into `error`.
    expect(source.rows[0]!.health_status).not.toBe('error');

    const { unresolvedLocationReports } = await import('../../src/services/ingestion.js');
    expect(unresolvedLocationReports().find((report) => report.sourceId === 'air-alert-ua'))
      .toMatchObject({ samples: ['Неіснуючий район'] });
  });

  it('records every message it reads, including the ones it refuses to act on', async () => {
    await ingest([
      startNikopol('1', T0),
      { id: '2', at: T1, text: '🟠 12:31 УВАГА!!!\nЗагроза застосування керованих авіаційних бомб (КАБів).' },
      { id: '3', at: T2, text: '🔴 12:40 Нова невідома фраза каналу' }
    ]);

    const rows = await sql<{ external_id: string; processing_status: string }>(
      `SELECT external_id,processing_status FROM source_messages WHERE source_id='air-alert-ua'
       ORDER BY external_id`
    );
    expect(rows.rows).toEqual([
      { external_id: '1', processing_status: 'alert' },
      { external_id: '2', processing_status: 'ignored' },
      { external_id: '3', processing_status: 'unrecognized' }
    ]);
  });

  it('keeps an edited message as a separate revision under the same Telegram id', async () => {
    await ingest([startNikopol('7', T0)]);
    await ingest([{
      id: '7', at: T0,
      text: '🔴 12:29 Повітряна тривога в \n• Нікопольський район\n• Павлоградський район\n'
    }]);

    const rows = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM source_messages WHERE source_id='air-alert-ua' AND external_id='7'`
    );
    expect(Number(rows.rows[0]!.n)).toBe(2);
    // The correction adds a raion; it never removes one, because absence is not an all-clear here.
    expect(await alertPeriods()).toEqual([
      { location_id: NIKOPOL, status: 'active', ended_at: null },
      { location_id: PAVLOHRAD, status: 'active', ended_at: null }
    ]);
  });

  it('leaves the channel state untouched when a polled adapter reconciles its own snapshot', async () => {
    // The two models coexist: the snapshot path clears only rows carrying its own `source_id`, so a
    // Ukraine Alarm poll that says nothing about Nikopol raion cannot take it off the map.
    await ingest([startNikopol('1', T0)]);
    await sql(
      `INSERT INTO alert_source_states(source_id,location_id,alert_type,active,provider_started_at)
       VALUES ('ukraine-alarm','ua-32','air_raid',true,now())`
    );

    await ingest([{ id: '2', at: T1, text: '🔴 12:31 Повітряна тривога в Павлоградський район' }]);

    const rows = await sql<{ source_id: string; active: boolean }>(
      `SELECT source_id,active FROM alert_source_states WHERE source_id='ukraine-alarm'`
    );
    expect(rows.rows).toEqual([{ source_id: 'ukraine-alarm', active: true }]);
    expect(await channelStates()).toHaveLength(2);
  });
});
