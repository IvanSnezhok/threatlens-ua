import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

/**
 * Covers the state axis added by `migrations/012_threat_assertions_and_classification_log.sql`:
 * a threat event now ends when the last source that asserted it takes its assertion back, instead of
 * only when the 30-minute validity timer runs out.
 *
 * The assertion this whole file exists for is the isolation one. A withdrawal is scoped to the
 * publisher that issued it — `WHERE source_id = …` in `applyRetraction` — so one channel, or one
 * mis-read joke, can never clear a threat two other channels are still reporting. Every case below
 * is written against the database rather than against the repository's return value, because the
 * guarantee is a property of the rows, not of the code path that happened to be taken.
 *
 * The second guarantee, asserted directly rather than inferred from routing: nothing on this path
 * touches `alert_source_states` or `alert_periods`. An OSINT channel saying "нічого не летить" is
 * not an "Офіційний відбій" and must have no route to becoming one.
 *
 * Message texts are realistic captures from the live feeds. Nothing here touches the network.
 */

const WAR_MONITOR = 'osint-war-monitor';
const ERADAR = 'osint-eradar';
const AERIS = 'osint-aeris-rimor';
const POLTAVA_OBLAST = 'ua-53';
const KHARKIV_OBLAST = 'ua-63';
const POLTAVA_CITY = 'ua-city-poltava';
const KHARKIV_CITY = 'ua-city-kharkiv';

let sequence = 0;

async function ingest(sourceId: string, text: string, publishedAt = new Date()) {
  const { processMessage } = await import('../../src/services/ingestion.js');
  sequence += 1;
  return processMessage({
    sourceId,
    externalId: `withdrawal-${sourceId}-${sequence}`,
    publishedAt,
    text,
    rawPayload: { channel: sourceId, test: true }
  }, { monitor: true });
}

async function resetCoalescing() {
  const { resetMonitorCoalescing } = await import('../../src/services/ingestion.js');
  resetMonitorCoalescing();
}

interface AssertionRow {
  source_id: string;
  location_id: string;
  threat_type: string;
  withdrawn_at: string | null;
  withdrawal_reason: string | null;
  valid_until: string;
}

async function assertions(): Promise<AssertionRow[]> {
  const rows = await sql<AssertionRow>(
    `SELECT source_id,location_id,threat_type,withdrawn_at::text,withdrawal_reason,valid_until::text
     FROM threat_assertions ORDER BY source_id,location_id,threat_type`
  );
  return rows.rows;
}

async function eventStatuses(): Promise<Array<{ id: string; status: string; evidence_level: string }>> {
  const rows = await sql<{ id: string; status: string; evidence_level: string }>(
    `SELECT id,status,evidence_level FROM threat_events ORDER BY created_at,id`
  );
  return rows.rows;
}

async function systemEvents(prefix: string): Promise<string[]> {
  const rows = await sql<{ event_type: string }>(
    `SELECT event_type FROM system_event_log WHERE event_type LIKE $1 ORDER BY version`, [`${prefix}%`]
  );
  return rows.rows.map((row) => row.event_type);
}

async function liveSignalsBySource(): Promise<Record<string, number>> {
  const rows = await sql<{ source_id: string; n: string }>(
    `SELECT sm.source_id,count(*)::text AS n FROM risk_signals rs
     JOIN source_messages sm ON sm.id=rs.source_message_id
     WHERE rs.expires_at > now() GROUP BY sm.source_id ORDER BY sm.source_id`
  );
  return Object.fromEntries(rows.rows.map((row) => [row.source_id, Number(row.n)]));
}

/**
 * The official alert domain, captured so it can be compared before and after.
 *
 * `updated_at` is included deliberately: a reconciler that touched these rows and left them
 * logically identical would still be a violation of the rule that OSINT sources have no access to
 * official alert state.
 */
async function officialAlertState() {
  const states = await sql(
    `SELECT source_id,location_id,alert_type,active,missing_since::text,last_event_at::text,updated_at::text
     FROM alert_source_states ORDER BY source_id,location_id,alert_type`
  );
  const periods = await sql(
    `SELECT location_id,alert_type,status,started_at::text,ended_at::text,updated_at::text
     FROM alert_periods ORDER BY location_id,alert_type,started_at`
  );
  return { states: states.rows, periods: periods.rows };
}

async function seedOfficialAlert(): Promise<void> {
  await sql(
    `INSERT INTO alert_source_states(source_id,location_id,alert_type,active,provider_started_at,external_id)
     VALUES ('ukraine-alarm',$1,'air_raid',true,now()-interval '20 minutes','seed-1')`, [POLTAVA_OBLAST]
  );
  await sql(
    `INSERT INTO alert_periods(location_id,alert_type,status,started_at,external_id)
     VALUES ($1,'air_raid','active',now()-interval '20 minutes','seed-1')`, [POLTAVA_OBLAST]
  );
}

describe.skipIf(!integrationDatabaseAvailable)('threat de-escalation', () => {
  beforeAll(async () => { await ensureMigrated(); });
  beforeEach(async () => {
    await resetDatabase();
    await resetCoalescing();
    await sql(`UPDATE sources SET enabled=true WHERE adapter_type='mtproto_monitor'`);
  });

  describe('a withdrawal reaches only the source that issued it', () => {
    it('leaves another source\'s assertion standing, and the event alive', async () => {
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.');
      await ingest(ERADAR, 'БпЛА на Полтавщині.');
      const before = await eventStatuses();
      expect(before).toHaveLength(1);

      await ingest(WAR_MONITOR, 'Полтавщина — відбій загрози ударних БпЛА.');

      const rows = await assertions();
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.source_id === WAR_MONITOR)?.withdrawn_at).not.toBeNull();
      expect(rows.find((row) => row.source_id === ERADAR)?.withdrawn_at).toBeNull();
      // The event is still confirmed by two independent groups; only one of them stood down.
      expect(await eventStatuses()).toEqual(before);
      expect(await systemEvents('threat.withdrawn')).toEqual([]);
    });

    it('ends the event when the last assertion is withdrawn, and says so in the event log', async () => {
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.');
      await ingest(ERADAR, 'БпЛА на Полтавщині.');
      await ingest(WAR_MONITOR, 'Полтавщина — відбій загрози ударних БпЛА.');
      await ingest(ERADAR, 'Полтавщина — відбій загрози ударних БпЛА.');

      const events = await eventStatuses();
      expect(events).toHaveLength(1);
      expect(events[0]!.status).toBe('withdrawn');
      // Evidence and state are different axes: a threat two independent monitors confirmed stays a
      // confirmed threat in the record even after both stood it down.
      expect(events[0]!.evidence_level).toBe('confirmed');

      expect(await systemEvents('threat.withdrawn')).toEqual(['threat.withdrawn']);
      const update = await sql<{ previous_status: string; new_status: string; previous_evidence_level: string; new_evidence_level: string; reason: string }>(
        `SELECT previous_status,new_status,previous_evidence_level,new_evidence_level,reason
         FROM event_updates WHERE new_status='withdrawn'`
      );
      expect(update.rows).toEqual([{
        previous_status: 'confirmed', new_status: 'withdrawn',
        previous_evidence_level: 'confirmed', new_evidence_level: 'confirmed',
        reason: 'last_source_assertion_withdrawn'
      }]);
      const ended = await sql<{ n: string }>(
        `SELECT count(*)::text AS n FROM threat_events WHERE status='withdrawn' AND ended_at IS NOT NULL`
      );
      expect(Number(ended.rows[0]!.n)).toBe(1);
    });

    it('changes nothing when a source withdraws something it never asserted', async () => {
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.');
      await ingest(ERADAR, 'БпЛА на Полтавщині.');
      const beforeEvents = await eventStatuses();
      const beforeAssertions = await assertions();
      const beforeSignals = await liveSignalsBySource();

      const outcome = await ingest(AERIS, 'Полтавщина — відбій загрози ударних БпЛА.');

      expect(outcome).toMatchObject({ deEscalation: true });
      expect(await eventStatuses()).toEqual(beforeEvents);
      expect(await assertions()).toEqual(beforeAssertions);
      expect(await liveSignalsBySource()).toEqual(beforeSignals);
      // The message is still archived as a decision — a source standing down something it never
      // reported is itself a finding, not a message to drop on the floor.
      const status = await sql<{ processing_status: string }>(
        `SELECT processing_status FROM source_messages WHERE source_id=$1`, [AERIS]
      );
      expect(status.rows.map((row) => row.processing_status)).toEqual(['de_escalation']);
    });

    it('never shortens the validity window below what the remaining sources support', async () => {
      const older = new Date(Date.now() - 10 * 60_000);
      const newer = new Date(Date.now() - 1 * 60_000);
      await ingest(ERADAR, 'БпЛА на Полтавщині.', older);
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.', newer);

      await ingest(WAR_MONITOR, 'Полтавщина — відбій загрози ударних БпЛА.');

      const supported = await sql<{ valid_until: string }>(
        `SELECT valid_until::text FROM threat_assertions WHERE source_id=$1 AND withdrawn_at IS NULL`,
        [ERADAR]
      );
      const event = await sql<{ status: string; valid_until: string }>(
        `SELECT status,valid_until::text FROM threat_events`
      );
      expect(event.rows[0]!.status).not.toBe('withdrawn');
      // Exactly what the surviving source vouches for: not the longer window the withdrawing source
      // had extended it to, and not a second shorter than the survivor still supports.
      expect(event.rows[0]!.valid_until).toBe(supported.rows[0]!.valid_until);
    });
  });

  describe('an unscoped withdrawal', () => {
    it('closes every claim of its own source and none of anybody else\'s', async () => {
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.');
      await ingest(WAR_MONITOR, 'Шахед курсом на Харківщину.');
      await ingest(ERADAR, 'БпЛА на Полтавщині.');
      expect(await eventStatuses()).toHaveLength(2);

      // No place, no weapon class: the classifier reports `coverage: 'unspecified'` rather than
      // guessing a scope, and the scope it gets is the publisher's own reporting.
      await ingest(WAR_MONITOR, 'ТУшки неактивні, у наш бік наразі нічого не летить');

      const rows = await assertions();
      expect(rows.filter((row) => row.source_id === WAR_MONITOR)).toHaveLength(2);
      expect(rows.filter((row) => row.source_id === WAR_MONITOR)
        .every((row) => row.withdrawn_at !== null)).toBe(true);
      expect(rows.filter((row) => row.source_id === ERADAR)
        .every((row) => row.withdrawn_at === null)).toBe(true);

      const events = await sql<{ status: string; location_id: string }>(
        `SELECT DISTINCT e.status,el.location_id FROM threat_events e
         JOIN threat_event_locations el ON el.event_id=e.id ORDER BY el.location_id`
      );
      // Poltava survives on the other monitor's claim, and keeps the `confirmed` state two
      // independent groups gave it; Kharkiv had only the withdrawing source.
      expect(events.rows).toEqual([
        { status: 'confirmed', location_id: POLTAVA_OBLAST },
        { status: 'withdrawn', location_id: KHARKIV_OBLAST }
      ]);
    });
  });

  describe('a redirect', () => {
    it('withdraws for the place being passed and asserts for the place being approached', async () => {
      await ingest(AERIS, 'Балістика на Полтаву.');
      await ingest(AERIS, 'Балістика повз Полтаву на Харків.');

      const rows = await assertions();
      expect(rows).toEqual([
        expect.objectContaining({
          source_id: AERIS, location_id: KHARKIV_CITY, threat_type: 'ballistic_missile',
          withdrawn_at: null, withdrawal_reason: null
        }),
        expect.objectContaining({
          source_id: AERIS, location_id: POLTAVA_CITY, threat_type: 'ballistic_missile',
          withdrawal_reason: 'redirect'
        })
      ]);
      expect(rows.find((row) => row.location_id === POLTAVA_CITY)?.withdrawn_at).not.toBeNull();
      // The event itself lives: something is still being asserted, just not over Poltava.
      const events = await eventStatuses();
      expect(events).toHaveLength(1);
      expect(events[0]!.status).toBe('observed');
    });
  });

  describe('risk signals', () => {
    it('decays the withdrawing source\'s signals and leaves every other source\'s alone', async () => {
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.');
      await ingest(ERADAR, 'БпЛА на Полтавщині.');
      const before = await liveSignalsBySource();
      expect(before[WAR_MONITOR]).toBeGreaterThan(0);
      expect(before[ERADAR]).toBeGreaterThan(0);

      await ingest(WAR_MONITOR, 'Полтавщина — відбій загрози ударних БпЛА.');

      const after = await liveSignalsBySource();
      expect(after[WAR_MONITOR]).toBeUndefined();
      expect(after[ERADAR]).toBe(before[ERADAR]);
      // Expired, not deleted and not negated: the row stays auditable and the risk engine simply
      // stops reading it. A negative contribution could zero a location that is still under threat.
      const decayed = await sql<{ n: string }>(
        `SELECT count(*)::text AS n FROM risk_signals rs JOIN source_messages sm ON sm.id=rs.source_message_id
         WHERE sm.source_id=$1`, [WAR_MONITOR]
      );
      expect(Number(decayed.rows[0]!.n)).toBe(before[WAR_MONITOR]);
    });

    it('keeps the withdrawn signals out of the risk engine\'s input set', async () => {
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.');
      await ingest(WAR_MONITOR, 'Полтавщина — відбій загрози ударних БпЛА.');
      const { runRiskAssessments } = await import('../../src/services/risk.js');
      await runRiskAssessments();
      const assessments = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM risk_assessments`);
      expect(Number(assessments.rows[0]!.n)).toBe(0);
    });
  });

  describe('official alert isolation', () => {
    it('does not touch alert_source_states or alert_periods', async () => {
      await seedOfficialAlert();
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.');
      await ingest(ERADAR, 'БпЛА на Полтавщині.');
      const before = await officialAlertState();

      await ingest(WAR_MONITOR, 'Полтавщина — відбій загрози ударних БпЛА.');
      await ingest(ERADAR, 'Полтавщина — відбій загрози ударних БпЛА.');
      await ingest(WAR_MONITOR, 'ТУшки неактивні, у наш бік наразі нічого не летить');

      const events = await eventStatuses();
      expect(events[0]!.status).toBe('withdrawn');
      expect(await officialAlertState()).toEqual(before);
      expect(await systemEvents('alert.')).toEqual([]);
    });
  });

  describe('re-assertion', () => {
    it('reopens a claim the same source had withdrawn', async () => {
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.');
      await ingest(WAR_MONITOR, 'Полтавщина — відбій загрози ударних БпЛА.');
      expect((await eventStatuses())[0]!.status).toBe('withdrawn');

      await resetCoalescing();
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину знову.');

      // A withdrawn event is not resurrected — it stays in history — and the renewed report raises a
      // new event with its own open assertion.
      const events = await eventStatuses();
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.status)).toEqual(['withdrawn', 'observed']);
      const open = await sql<{ n: string }>(
        `SELECT count(*)::text AS n FROM threat_assertions WHERE withdrawn_at IS NULL`
      );
      expect(Number(open.rows[0]!.n)).toBe(1);
    });
  });
});
