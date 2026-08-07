import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

/**
 * Covers the OSINT monitoring channels added by `migrations/011_osint_monitor_sources.sql` and the
 * data-driven registry in `src/services/ingestion.ts`.
 *
 * The load-bearing assertion in this file is the isolation one. These channels are Tier B and C
 * publishers with no state mandate, and the guarantee the whole design rests on is that nothing they
 * publish can start or end an official air-raid alert — not even a message that says "Повітряна
 * тривога" and "Відбій тривоги" in those words. That is asserted directly against
 * `alert_source_states` and `alert_periods` rather than inferred from the routing code.
 *
 * Message texts are realistic captures from the live feeds. Nothing here touches the network.
 */

const WAR_MONITOR = 'osint-war-monitor';
const ERADAR = 'osint-eradar';
const AERIS = 'osint-aeris-rimor';
const KYIV_NEBO = 'osint-kyiv-nebo';
const SK = 'osint-sk';
const VANEK = 'osint-vanek-nikolaev';
const POLTAVA_OBLAST = 'ua-53';

/**
 * The thirteen monitoring rows migration 011 owns.
 *
 * Everything in this file is scoped to them by id rather than by `adapter_type`, because the
 * catalogue in migration 013 adds thirty-seven more rows with the same adapter type and a
 * deliberately different grouping policy — see `source-catalog.test.ts`. Selecting by adapter type
 * would silently pull those in and turn assertions about *these* channels into assertions about
 * whatever the catalogue happens to contain.
 */
const FIRST_WAVE_MONITORS = [
  WAR_MONITOR, ERADAR, AERIS, 'osint-rynda', 'osint-molfar', 'osint-kyiv-airdef',
  KYIV_NEBO, SK, 'osint-zhenyok', 'osint-raccoon', 'osint-radar-raketaa',
  'osint-trivoga-map', VANEK
];

let sequence = 0;

async function ingest(sourceId: string, text: string, monitor = true) {
  const { processMessage } = await import('../../src/services/ingestion.js');
  sequence += 1;
  return processMessage({
    sourceId,
    externalId: `test-${sourceId}-${sequence}`,
    publishedAt: new Date(),
    text,
    rawPayload: { channel: sourceId, test: true }
  }, { monitor });
}

async function resetCoalescing() {
  const { resetMonitorCoalescing } = await import('../../src/services/ingestion.js');
  resetMonitorCoalescing();
}

async function eventsFor(threatType: string) {
  const rows = await sql<{ id: string; status: string; evidence_level: string }>(
    `SELECT id,status,evidence_level FROM threat_events WHERE threat_type=$1 ORDER BY created_at`,
    [threatType]
  );
  return rows.rows;
}

async function messageStatuses(sourceId: string): Promise<string[]> {
  const rows = await sql<{ processing_status: string }>(
    `SELECT processing_status FROM source_messages WHERE source_id=$1 ORDER BY received_at`, [sourceId]
  );
  return rows.rows.map((row) => row.processing_status);
}

describe.skipIf(!integrationDatabaseAvailable)('OSINT monitoring sources', () => {
  beforeAll(async () => { await ensureMigrated(); });
  beforeEach(async () => {
    await resetDatabase();
    await resetCoalescing();
    // Scoped to this migration's rows: the catalogue in migration 013 disables three of its own
    // monitors on purpose, and a blanket UPDATE over `adapter_type` would switch them back on and
    // leave them that way for every file that runs afterwards.
    await sql(
      `UPDATE sources SET enabled=true WHERE id = ANY($1::text[]) AND id<>$2`,
      [FIRST_WAVE_MONITORS, VANEK]
    );
    await sql(`UPDATE sources SET enabled=false WHERE id=$1`, [VANEK]);
  });

  describe('source catalogue', () => {
    it('registers every monitoring channel this migration owns with its own independence group', async () => {
      const rows = await sql<{ id: string; tier: string; official: boolean; independence_group: string; telegram_username: string }>(
        `SELECT id,tier,official,independence_group,telegram_username FROM sources
         WHERE adapter_type='mtproto_monitor' AND id = ANY($1::text[]) ORDER BY id`,
        [FIRST_WAVE_MONITORS]
      );
      expect(rows.rows).toHaveLength(13);
      expect(rows.rows.every((row) => row.official === false)).toBe(true);
      expect(rows.rows.every((row) => row.tier !== 'A')).toBe(true);
      expect(rows.rows.find((row) => row.id === WAR_MONITOR)).toMatchObject({
        tier: 'B', independence_group: 'osint-war-monitor', telegram_username: 'war_monitor'
      });
      expect(rows.rows.find((row) => row.id === KYIV_NEBO)?.tier).toBe('C');
      // 714k subscribers and still Tier C: the channel aggregates other publishers and says so in
      // its own posts, so its agreement is not independent observation.
      expect(rows.rows.find((row) => row.id === 'osint-trivoga-map')?.tier).toBe('C');
      // Every group is distinct except the one repost aggregator, which shares `air-force`.
      const groups = rows.rows.map((row) => row.independence_group);
      expect(new Set(groups).size).toBe(rows.rows.length);
    });

    it('clusters the Tier B channels added later instead of giving each its own group', async () => {
      // One group per channel is the right default and it is what the thirteen rows above get. It is
      // the wrong answer for the national "radar" channels registered by migration 013, and the
      // corroboration rule is what makes the difference matter: two Tier B groups agreeing promotes
      // a threat event to `confirmed` with no official source involved.
      //
      // Those channels draw on the same informal pool of local spotters, who post one sighting into
      // several chats and bots at once. Two channels relaying one spotter is one observation, so
      // giving them seven groups would mean any two of them repeating each other counts as a
      // confirmation. They are therefore split by *how the observation is produced*, into a cluster
      // watching Russian airfields for launches and a cluster tracking what is already in flight —
      // which makes the threshold fire between clusters, or between a cluster and a Tier A source,
      // and never inside one cluster.
      //
      // This is a deliberate replacement of the earlier rule, not an exception to it: a new national
      // monitor belongs in whichever cluster describes its method, and a new group is justified only
      // by a genuinely different way of observing.
      const rows = await sql<{ id: string; independence_group: string }>(
        `SELECT id,independence_group FROM sources
         WHERE adapter_type='mtproto_monitor' AND tier='B' AND NOT (id = ANY($1::text[])) ORDER BY id`,
        [FIRST_WAVE_MONITORS]
      );
      expect(rows.rows).toHaveLength(7);
      const byGroup = new Map<string, string[]>();
      for (const row of rows.rows) byGroup.set(row.independence_group, [...(byGroup.get(row.independence_group) ?? []), row.id]);
      expect([...byGroup.keys()].sort()).toEqual(['osint-flight-tracking', 'osint-launch-detection']);
      expect(byGroup.get('osint-launch-detection')).toEqual([
        'osint-strategic-aviation', 'osint-strategic-control'
      ]);
      expect(byGroup.get('osint-flight-tracking')).toEqual([
        'osint-deraketaua', 'osint-monikppy', 'osint-monitor-ukr', 'osint-operinform',
        'osint-raketa-trevoga'
      ]);
    });

    it('keeps the two similarly named "куди летить" channels apart', async () => {
      // `kudy_letyt` is "Ринда моніторить"; `radar_raketaa` is "Куди летить? | Тривога". Different
      // publishers, so different rows and different independence groups.
      const rows = await sql<{ id: string; telegram_username: string; independence_group: string }>(
        `SELECT id,telegram_username,independence_group FROM sources
         WHERE telegram_username IN ('kudy_letyt','radar_raketaa') ORDER BY id`
      );
      expect(rows.rows).toHaveLength(2);
      expect(new Set(rows.rows.map((row) => row.independence_group)).size).toBe(2);
    });

    it('gives the repost aggregator the group of the source it reposts', async () => {
      // Its own group would let one publisher's statement be counted twice and reach the
      // two-independent-sources threshold on its own.
      const row = await sql<{ independence_group: string; enabled: boolean; tier: string }>(
        `SELECT independence_group,enabled,tier FROM sources WHERE id=$1`, [VANEK]
      );
      expect(row.rows[0]).toMatchObject({ independence_group: 'air-force', enabled: false, tier: 'C' });
    });

    it('refuses a monitoring row that claims to be official or Tier A', async () => {
      await expect(sql(
        `INSERT INTO sources (id,name,source_type,tier,official,adapter_type,independence_group,telegram_username)
         VALUES ('test-bad','Bad','telegram','A',true,'mtproto_monitor','test','test_bad')`
      )).rejects.toThrow(/sources_mtproto_monitor_check/);
    });

    it('refuses two rows claiming the same channel', async () => {
      await expect(sql(
        `INSERT INTO sources (id,name,source_type,tier,official,adapter_type,independence_group,telegram_username)
         VALUES ('test-dup','Dup','telegram','B',false,'mtproto_monitor','test','War_Monitor')`
      )).rejects.toThrow(/sources_telegram_username_uidx/);
    });
  });

  describe('data-driven collector registry', () => {
    it('returns every enabled monitor plus the Air Force channel', async () => {
      const { loadMonitoredTelegramChannels } = await import('../../src/services/ingestion.js');
      const channels = await loadMonitoredTelegramChannels();
      const byUsername = new Map(channels.map((channel) => [channel.username, channel.sourceId]));
      expect(byUsername.get('war_monitor')).toBe(WAR_MONITOR);
      expect(byUsername.get('eradarrua')).toBe(ERADAR);
      expect(byUsername.get('aerisrimor')).toBe(AERIS);
      expect(byUsername.get('kpszsu')).toBe('air-force');
      expect(byUsername.get('radar_raketaa')).toBe('osint-radar-raketaa');
      expect(byUsername.get('povitryanatrivogaaa')).toBe('osint-trivoga-map');
      // Disabled on purpose: Russian-language, and the classifier and catalogue are Ukrainian.
      expect(byUsername.has('vanek_nikolaev')).toBe(false);
    });

    it('never routes the official alert channel through the classifier registry', async () => {
      const { loadMonitoredTelegramChannels } = await import('../../src/services/ingestion.js');
      const channels = await loadMonitoredTelegramChannels();
      expect(channels.some((channel) => channel.username === 'air_alert_ua')).toBe(false);
      expect(channels.some((channel) => channel.sourceId === 'air-alert-ua')).toBe(false);
    });

    it('stops collecting a monitor whose row is disabled', async () => {
      // `enabled` is a real gate on this path, unlike the official adapters where it reports
      // configuration rather than controlling it.
      const { loadMonitoredTelegramChannels } = await import('../../src/services/ingestion.js');
      await sql(`UPDATE sources SET enabled=false WHERE id=$1`, [WAR_MONITOR]);
      const channels = await loadMonitoredTelegramChannels();
      expect(channels.some((channel) => channel.sourceId === WAR_MONITOR)).toBe(false);
      expect(channels.some((channel) => channel.sourceId === ERADAR)).toBe(true);
    });
  });

  describe('isolation from the official alert state', () => {
    it('does not touch alert state for a message that says тривога and відбій', async () => {
      await ingest(WAR_MONITOR, 'Повітряна тривога в Полтавській області! Відбій тривоги оголошено.');
      await ingest(ERADAR, 'УВАГА! Повітряна тривога для Полтавщини. Шахед на Полтавщину.');
      await ingest(AERIS, 'Відбій тривоги в Полтавщині, можна виходити.');

      const states = await sql(`SELECT * FROM alert_source_states`);
      const periods = await sql(`SELECT * FROM alert_periods`);
      const alertEvents = await sql(
        `SELECT event_type FROM system_event_log WHERE event_type LIKE 'alert.%'`
      );
      expect(states.rowCount).toBe(0);
      expect(periods.rowCount).toBe(0);
      expect(alertEvents.rowCount).toBe(0);
    });

    it('still classifies the threat carried by such a message', async () => {
      // The point is not that the message is discarded — the drone report inside it is real. The
      // point is that the alert vocabulary in it moves nothing.
      await ingest(ERADAR, 'Повітряна тривога! Шахед курсом на Полтавщину.');
      const events = await eventsFor('uav');
      expect(events).toHaveLength(1);
      expect(await sql(`SELECT * FROM alert_periods`)).toMatchObject({ rowCount: 0 });
    });
  });

  describe('corroboration between independent monitors', () => {
    it('promotes to confirmed when two independent monitors agree', async () => {
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.');
      await ingest(ERADAR, 'БпЛА на Полтавщині.');
      const events = await eventsFor('uav');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ status: 'confirmed', evidence_level: 'confirmed' });
    });

    it('leaves a single monitor at monitoring level', async () => {
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.');
      const events = await eventsFor('uav');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ status: 'observed', evidence_level: 'monitoring' });
    });

    it('does not let two Tier C monitors confirm anything', async () => {
      await ingest(KYIV_NEBO, 'Шахед курсом на Полтавщину.');
      await ingest(SK, 'БпЛА на Полтавщині.');
      const events = await eventsFor('uav');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ status: 'observed', evidence_level: 'unverified' });
    });

    it('does not let a repost of an official source corroborate that source', async () => {
      // Both rows are in the `air-force` independence group, so the corroboration query counts one.
      await sql(`UPDATE sources SET enabled=true WHERE id=$1`, [VANEK]);
      await ingest('air-force', 'Шахед курсом на Полтавщину.', false);
      await ingest(VANEK, 'БпЛА на Полтавщині.');
      const events = await eventsFor('uav');
      expect(events).toHaveLength(1);
      expect(events[0]?.evidence_level).toBe('official');
      const promotions = await sql(
        `SELECT reason FROM event_updates WHERE reason='two_independent_tier_a_or_b_sources'`
      );
      expect(promotions.rowCount).toBe(0);
    });
  });

  describe('burst coalescing', () => {
    it('suppresses a monitor restating the same threat over the same place', async () => {
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.');
      const first = await sql<{ n: string }>(
        `SELECT count(*)::text AS n FROM system_event_log WHERE event_type LIKE 'threat.%'`
      );
      await ingest(WAR_MONITOR, 'Шахеди все ще на Полтавщині, рухаються далі.');
      const second = await sql<{ n: string }>(
        `SELECT count(*)::text AS n FROM system_event_log WHERE event_type LIKE 'threat.%'`
      );
      expect(second.rows[0]!.n).toBe(first.rows[0]!.n);
      // Suppressed, not discarded: the text is still stored against the source.
      expect(await messageStatuses(WAR_MONITOR)).toEqual(['classified', 'coalesced']);
    });

    it('does not suppress a different place, a different threat or a different source', async () => {
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.');
      await ingest(WAR_MONITOR, 'Шахед курсом на Харківщину.');
      await ingest(WAR_MONITOR, 'Балістика на Полтавщину.');
      await ingest(ERADAR, 'БпЛА на Полтавщині.');
      expect(await messageStatuses(WAR_MONITOR)).toEqual(['classified', 'classified', 'classified']);
      expect(await messageStatuses(ERADAR)).toEqual(['classified']);
    });
  });

  describe('recognised message classes', () => {
    it('records a withdrawal under its own status without raising or changing an event', async () => {
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.');
      const before = await eventsFor('uav');
      const outcome = await ingest(AERIS, 'ТУшки неактивні, у наш бік наразі нічого не летить');
      expect(outcome).toMatchObject({ deEscalation: true });
      expect(await messageStatuses(AERIS)).toEqual(['de_escalation']);
      const after = await eventsFor('uav');
      expect(after).toEqual(before);
    });

    it('ignores a meme without recording a threat', async () => {
      const outcome = await ingest(ERADAR, 'Підбірка мемів про шахед на вечір 😂');
      expect(outcome).toMatchObject({ ignored: true });
      expect(await eventsFor('uav')).toHaveLength(0);
      expect(await messageStatuses(ERADAR)).toEqual(['ignored']);
    });

    it('ignores a report about a Russian city', async () => {
      const outcome = await ingest(ERADAR, 'Брянськ, поки що росія. Над містом дим від пожежі');
      expect(outcome).toMatchObject({ ignored: true });
      const national = await sql(
        `SELECT 1 FROM threat_event_locations WHERE location_id='ua'`
      );
      expect(national.rowCount).toBe(0);
    });

    it('attributes evidence to the channel that published it', async () => {
      await ingest(AERIS, 'Ймовірно вихід балістики з Криму на Полтавщину. Якщо Онікс, є 4 хвилини.');
      const evidence = await sql<{ source_id: string; independence_group: string }>(
        `SELECT sm.source_id,s.independence_group FROM event_evidence ee
         JOIN source_messages sm ON sm.id=ee.source_message_id
         JOIN sources s ON s.id=sm.source_id`
      );
      expect(evidence.rows).toEqual([{ source_id: AERIS, independence_group: 'osint-aeris-rimor' }]);
    });

    it('files risk signals for the reported oblast', async () => {
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.');
      const signals = await sql<{ location_id: string; source_tier: string }>(
        `SELECT location_id,source_tier FROM risk_signals ORDER BY location_id`
      );
      expect(signals.rows.some((row) => row.location_id === POLTAVA_OBLAST)).toBe(true);
      expect(signals.rows.every((row) => row.source_tier === 'B')).toBe(true);
    });
  });
});
