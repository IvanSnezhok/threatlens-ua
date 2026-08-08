import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

/**
 * Covers the event-driven reconciliation path in `src/services/ingestion.ts`, which every Tier A
 * alert Telegram channel uses — the national https://t.me/air_alert_ua and the oblast and city
 * military administrations registered by migration 013.
 *
 * The rule under test is the one that separates these sources from the polled adapters: they publish
 * *events*, so a message about one raion must leave every other raion of the same source exactly as
 * it was. Running them through `persistOfficialAlertSnapshot` instead would clear the whole country
 * every time one oblast reported an alert.
 *
 * Message texts are verbatim captures from the live channels. Nothing here touches the network.
 */

const NIKOPOL = 'test-raion-nikopol';
const PAVLOHRAD = 'test-raion-pavlohrad';
const KUPIANSK = 'test-raion-kupiansk';
const KHARKIV_CITY = 'ua-city-kharkiv';
const BUCHA = 'test-raion-bucha';
const VINNYTSIA = 'test-raion-vinnytsia';

const AIR_ALERT_UA = 'air-alert-ua';
const KYIV_ODA = 'gov-kyiv-oblast-oda';
const VINNYTSIA_ODA = 'gov-vinnytsia-oda';

/**
 * Telegram publication times. The clock printed inside a message is deliberately never used.
 * Relative to the run's wall clock: absolute dates armed themselves as "stuck" alerts once the
 * suite outlived ALERT_CHANNEL_MAX_ALERT_SECONDS, and expireStuckAlertChannelAlerts() started
 * clearing fixtures the assertions considered fresh.
 */
const T0_BASE = Date.now() - 60 * 60 * 1000;
const T0 = new Date(T0_BASE).toISOString();
const T1 = new Date(T0_BASE + 5 * 60 * 1000).toISOString();
const T2 = new Date(T0_BASE + 40 * 60 * 1000).toISOString();

interface ChannelPost { id: string; at: string; text: string }

async function ingestFrom(sourceId: string, posts: ChannelPost[]) {
  const { ingestAlertChannelMessages } = await import('../../src/services/ingestion.js');
  return ingestAlertChannelMessages(
    sourceId,
    posts.map((post) => ({ externalId: post.id, publishedAt: new Date(post.at), text: post.text })),
    { warn: () => undefined }
  );
}

async function ingest(posts: ChannelPost[]) {
  return ingestFrom(AIR_ALERT_UA, posts);
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
         ($3,'ua-63','raion','Куп''янський район','{}'),
         ($4,'ua-32','raion','Бучанський район','{}'),
         ($5,'ua-05','raion','Вінницький район','{}')
       ON CONFLICT (id) DO NOTHING`,
      [NIKOPOL, PAVLOHRAD, KUPIANSK, BUCHA, VINNYTSIA]
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

  /**
   * Several administrations reading the same event path at once.
   *
   * `alert_source_states` has always been keyed on `(source_id, location_id, alert_type)`, so this
   * is the storage model doing what it was built for rather than a new mode. What is new is that a
   * second and a third body now write to it, and every assertion here is about the boundary between
   * them: one administration's all-clear is a statement about its own oblast and about nothing else.
   */
  describe('several alert channels at once', () => {
    it('lets two administrations hold alerts over their own raions independently', async () => {
      await ingestFrom(KYIV_ODA, [{ id: '1', at: T0, text: '🔴 Бучанський район - повітряна тривога!' }]);
      await ingestFrom(VINNYTSIA_ODA, [{ id: '1', at: T0, text: '🔴 Вінницький район - повітряна тривога!' }]);

      const states = await sql<{ source_id: string; location_id: string; active: boolean }>(
        `SELECT source_id,location_id,active FROM alert_source_states ORDER BY source_id`
      );
      expect(states.rows).toEqual([
        { source_id: KYIV_ODA, location_id: BUCHA, active: true },
        { source_id: VINNYTSIA_ODA, location_id: VINNYTSIA, active: true }
      ]);
      expect(await alertPeriods()).toEqual([
        { location_id: BUCHA, status: 'active', ended_at: null },
        { location_id: VINNYTSIA, status: 'active', ended_at: null }
      ]);
    });

    it('does not let one administration\'s all-clear end another administration\'s alert', async () => {
      // The failure the per-source key exists to prevent, and the one a shared `ALERT_CHANNEL_SOURCE_ID`
      // would have produced the moment a second channel was routed: Vinnytsia standing down would
      // take Bucha off the map, on an oblast Vinnytsia has no mandate over.
      await ingestFrom(KYIV_ODA, [{ id: '1', at: T0, text: '🔴 Бучанський район - повітряна тривога!' }]);
      await ingestFrom(VINNYTSIA_ODA, [{ id: '1', at: T0, text: '🔴 Вінницький район - повітряна тривога!' }]);

      await ingestFrom(VINNYTSIA_ODA, [{
        id: '2', at: T1, text: '🟢 Вінницький район - відбій повітряної тривоги!'
      }]);

      expect(await alertPeriods()).toEqual([
        { location_id: BUCHA, status: 'active', ended_at: null },
        { location_id: VINNYTSIA, status: 'ended', ended_at: expect.any(String) }
      ]);
    });

    it('keeps an alert up while any one source still holds it', async () => {
      // Two bodies over one raion is the two-source rule's normal case, not a conflict: the national
      // channel and the oblast administration both cover Bucha, and `bool_or` is what decides.
      await ingestFrom(KYIV_ODA, [{ id: '1', at: T0, text: '🔴 Бучанський район - повітряна тривога!' }]);
      await ingestFrom(AIR_ALERT_UA, [{
        id: '1', at: T0, text: '🔴 21:54 Повітряна тривога в Бучанський район'
      }]);

      await ingestFrom(KYIV_ODA, [{
        id: '2', at: T1, text: '🟢 Бучанський район - відбій повітряної тривоги!'
      }]);
      expect(await alertPeriods()).toEqual([{ location_id: BUCHA, status: 'active', ended_at: null }]);

      await ingestFrom(AIR_ALERT_UA, [{ id: '2', at: T2, text: '🟢 22:41 Відбій тривоги в Бучанський район.' }]);
      expect(await alertPeriods()).toEqual([
        { location_id: BUCHA, status: 'ended', ended_at: expect.any(String) }
      ]);
    });

    it('files each channel\'s messages against its own source row', async () => {
      await ingestFrom(KYIV_ODA, [{ id: '9', at: T0, text: '🔴 Бучанський район - повітряна тривога!' }]);
      await ingestFrom(VINNYTSIA_ODA, [{ id: '9', at: T0, text: '🔴 Вінницький район - повітряна тривога!' }]);

      const rows = await sql<{ source_id: string; external_id: string }>(
        `SELECT source_id,external_id FROM source_messages ORDER BY source_id`
      );
      // The same Telegram message id on two channels is two rows, not one collision: provenance is
      // per source, and the alert-state external id carries the source id for the same reason.
      expect(rows.rows).toEqual([
        { source_id: KYIV_ODA, external_id: '9' },
        { source_id: VINNYTSIA_ODA, external_id: '9' }
      ]);
      const states = await sql<{ external_id: string }>(
        `SELECT external_id FROM alert_source_states ORDER BY source_id`
      );
      expect(states.rows.map((row) => row.external_id))
        .toEqual([`${KYIV_ODA}:9`, `${VINNYTSIA_ODA}:9`]);
    });

    it('clears a stuck alert on every alert channel, not only the national one', async () => {
      // The backstop used to scan one hard-coded source id. Every row it did not scan would hold its
      // locations on the map forever the first time an all-clear went missing.
      await ingestFrom(KYIV_ODA, [{ id: '1', at: T0, text: '🔴 Бучанський район - повітряна тривога!' }]);
      await ingestFrom(VINNYTSIA_ODA, [{ id: '1', at: T0, text: '🔴 Вінницький район - повітряна тривога!' }]);
      await ingest([startNikopol('1', T0)]);
      await sql(`UPDATE alert_source_states SET provider_started_at=now()-interval '3 days'`);

      expect(await expireStuck()).toBe(3);

      const periods = await alertPeriods();
      expect(periods.map((row) => row.status)).toEqual(['ended', 'ended', 'ended']);
    });

    it('releases the alerts of a channel that has since been switched off', async () => {
      // Disabling a row stops it being read; it does not withdraw what it was holding. Without the
      // backstop sweeping disabled rows too, the raion would stay under alert with no collector left
      // that could ever clear it.
      await ingestFrom(VINNYTSIA_ODA, [{ id: '1', at: T0, text: '🔴 Вінницький район - повітряна тривога!' }]);
      await sql(`UPDATE sources SET enabled=false WHERE id=$1`, [VINNYTSIA_ODA]);
      await sql(`UPDATE alert_source_states SET provider_started_at=now()-interval '3 days'`);

      try {
        expect(await expireStuck()).toBe(1);
        expect(await alertPeriods()).toEqual([
          { location_id: VINNYTSIA, status: 'ended', ended_at: expect.any(String) }
        ]);
      } finally {
        // `resetDatabase` restores per-test rows, not catalogue flags.
        await sql(`UPDATE sources SET enabled=true WHERE id=$1`, [VINNYTSIA_ODA]);
      }
    });
  });
});
