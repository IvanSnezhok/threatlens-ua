import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';
// Read rather than hard-coded: this file asserts that the archive stamps *the current* version on
// every decision, and a literal here would have to be edited on every classifier release — which is
// exactly when the assertion is worth having.
import { CLASSIFIER_VERSION } from '../../src/domain/classifier.js';

/**
 * Covers `message_classifications` from `migrations/012_threat_assertions_and_classification_log.sql`
 * and the archive writes in `src/services/ingestion.ts`.
 *
 * `source_messages` kept the raw text and one status word, and everything the classifier concluded
 * was computed in memory and discarded — "why was this message ignored?" had no answer anywhere in
 * the system. This file pins the two properties that make the archive worth keeping:
 *
 *  * a row is written for **every** decision, including the decisions to do nothing, because the
 *    questions the archive exists for live mostly in the discarded majority;
 *  * `classifier_version` is on every row, so a change in this project's own rules can be told apart
 *    from a change in enemy behaviour.
 *
 * The last describe block is the acceptance criterion, executed rather than asserted on faith: three
 * analytical questions, one SQL statement each, run against ingested data.
 */

const WAR_MONITOR = 'osint-war-monitor';
const ERADAR = 'osint-eradar';
const AERIS = 'osint-aeris-rimor';
const POLTAVA_OBLAST = 'ua-53';
const KHARKIV_OBLAST = 'ua-63';
const KHARKIV_CITY = 'ua-city-kharkiv';
const POLTAVA_CITY = 'ua-city-poltava';

let sequence = 0;

async function ingest(sourceId: string, text: string, externalId?: string) {
  const { processMessage } = await import('../../src/services/ingestion.js');
  sequence += 1;
  return processMessage({
    sourceId,
    externalId: externalId ?? `archive-${sourceId}-${sequence}`,
    publishedAt: new Date(),
    text,
    rawPayload: { channel: sourceId, test: true }
  }, { monitor: true });
}

async function resetCoalescing() {
  const { resetMonitorCoalescing } = await import('../../src/services/ingestion.js');
  resetMonitorCoalescing();
}

interface ClassificationRow {
  source_id: string;
  classifier_version: string;
  decision: string;
  intent: string;
  created_event: boolean;
  ignored_reason: string | null;
  threat_type: string | null;
  candidate_threat_types: string[];
  indicators: string[];
  national_scope: boolean;
  event_id: string | null;
  retraction_coverage: string | null;
  retracted_threat_types: string[] | null;
  withdrawn_assertions: number | null;
  last_assertion_at: string | null;
  decayed_risk_signals: number | null;
}

async function classifications(): Promise<ClassificationRow[]> {
  const rows = await sql<ClassificationRow>(
    `SELECT source_id,classifier_version,decision,intent,created_event,ignored_reason,threat_type,
            candidate_threat_types,indicators,national_scope,event_id,retraction_coverage,
            retracted_threat_types,withdrawn_assertions,last_assertion_at::text,decayed_risk_signals
     FROM message_classifications ORDER BY classified_at,id`
  );
  return rows.rows;
}

async function classificationLocations(decision: string) {
  const rows = await sql<{ location_id: string; role: string; relation_type: string | null }>(
    `SELECT cl.location_id,cl.role,cl.relation_type
     FROM message_classification_locations cl
     JOIN message_classifications mc ON mc.id=cl.classification_id
     WHERE mc.decision=$1 ORDER BY cl.role,cl.location_id`, [decision]
  );
  return rows.rows;
}

// ------------------------------------------------------------------------------------------------
// The three questions the schema has to answer in one statement each
// ------------------------------------------------------------------------------------------------

/**
 * 1. Threat events per threat class, per oblast, per month, split by classifier version.
 *
 * The roll-up is a bounded recursive walk of `parent_id` rather than a single edge, because a city
 * hangs off a raion once the KATOTTG raion tier is imported and a one-edge join would silently drop
 * every city event from its oblast's row. `special_city` and `country` are terminal alongside
 * `oblast` so Kyiv and country-wide warnings are counted rather than vanishing.
 */
const EVENTS_BY_OBLAST_AND_VERSION = `
WITH RECURSIVE ancestry(location_id,node_id,node_type,depth,path) AS (
    SELECT l.id,l.id,l.type,0,ARRAY[l.id] FROM locations l
  UNION ALL
    SELECT a.location_id,parent.id,parent.type,a.depth+1,a.path||parent.id
    FROM ancestry a
    JOIN locations child ON child.id=a.node_id
    JOIN locations parent ON parent.id=child.parent_id
    WHERE a.depth<8 AND NOT (parent.id=ANY(a.path))
)
SELECT date_trunc('month',e.started_at AT TIME ZONE 'Europe/Kyiv')::date::text AS month,
       oblast.node_id AS oblast_id,
       e.threat_type,
       mc.classifier_version,
       count(DISTINCT e.id)::int AS events
FROM message_classifications mc
JOIN threat_events e ON e.id=mc.event_id
JOIN threat_event_locations el ON el.event_id=e.id
JOIN ancestry oblast ON oblast.location_id=el.location_id
                    AND oblast.node_type IN ('oblast','special_city','country')
GROUP BY 1,2,3,4
ORDER BY 1,2,3,4`;

/**
 * 2. "Where are threats lost?" — for every threat that ended in a withdrawal rather than in the
 *    validity timer: where it was last asserted, where it was withdrawn, and how long it stood.
 *
 * Both sides come from `threat_assertions`, which is the only table that records a claim and its
 * retraction as one row, so the elapsed time is a subtraction rather than a correlation over the
 * message log.
 */
const WHERE_THREATS_ARE_LOST = `
SELECT e.threat_type,
       e.evidence_level,
       last_assertion.source_id   AS last_asserted_by,
       last_assertion.location_id AS last_asserted_for,
       withdrawal.source_id       AS withdrawn_by,
       withdrawal.location_id     AS withdrawn_for,
       withdrawal.withdrawal_reason,
       withdrawal.withdrawn_at - last_assertion.asserted_at AS held_for
FROM threat_events e
CROSS JOIN LATERAL (
  SELECT ta.source_id,ta.location_id,ta.asserted_at FROM threat_assertions ta
  WHERE ta.event_id=e.id ORDER BY ta.asserted_at DESC,ta.id LIMIT 1
) AS last_assertion
CROSS JOIN LATERAL (
  SELECT ta.source_id,ta.location_id,ta.withdrawn_at,ta.withdrawal_reason FROM threat_assertions ta
  WHERE ta.event_id=e.id AND ta.withdrawn_at IS NOT NULL
  ORDER BY ta.withdrawn_at DESC,ta.id LIMIT 1
) AS withdrawal
WHERE e.status='withdrawn'
ORDER BY withdrawal.withdrawn_at DESC`;

/** 3. Messages per source per day that raised nothing, and the reason each time. */
const IGNORED_BY_SOURCE_AND_DAY = `
SELECT date_trunc('day',mc.published_at AT TIME ZONE 'Europe/Kyiv')::date::text AS day,
       mc.source_id,
       mc.decision,
       COALESCE(mc.ignored_reason,'(none)') AS reason,
       count(*)::int AS messages
FROM message_classifications mc
WHERE mc.decision IN ('ignored','unrecognized','coalesced')
GROUP BY 1,2,3,4
ORDER BY 1,2,3,4`;

async function kyivMonth(): Promise<string> {
  const row = await sql<{ month: string }>(
    `SELECT date_trunc('month',now() AT TIME ZONE 'Europe/Kyiv')::date::text AS month`
  );
  return row.rows[0]!.month;
}

async function kyivDay(): Promise<string> {
  const row = await sql<{ day: string }>(
    `SELECT date_trunc('day',now() AT TIME ZONE 'Europe/Kyiv')::date::text AS day`
  );
  return row.rows[0]!.day;
}

describe.skipIf(!integrationDatabaseAvailable)('classification archive', () => {
  beforeAll(async () => { await ensureMigrated(); });
  beforeEach(async () => {
    await resetDatabase();
    await resetCoalescing();
    await sql(`UPDATE sources SET enabled=true WHERE adapter_type='mtproto_monitor'`);
  });

  describe('every decision is recorded, including the decisions to do nothing', () => {
    it('records a created event with its indicators, candidates and located relations', async () => {
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.');

      const rows = await classifications();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        source_id: WAR_MONITOR, classifier_version: CLASSIFIER_VERSION, decision: 'event_created',
        intent: 'threat', created_event: true, ignored_reason: null, threat_type: 'uav',
        candidate_threat_types: ['uav'], national_scope: false, retraction_coverage: null
      });
      expect(rows[0]!.event_id).not.toBeNull();
      expect(await classificationLocations('event_created')).toEqual([
        { location_id: POLTAVA_OBLAST, role: 'asserted', relation_type: 'reported_direction' }
      ]);
    });

    it('distinguishes a merge from a creation', async () => {
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.');
      await ingest(ERADAR, 'БпЛА на Полтавщині.');

      const rows = await classifications();
      expect(rows.map((row) => row.decision)).toEqual(['event_created', 'event_merged']);
      expect(rows[1]!.created_event).toBe(false);
      // Both decisions point at the same event, which is what makes "how many messages produced
      // this event" answerable at all.
      expect(rows[1]!.event_id).toBe(rows[0]!.event_id);
    });

    it('separates "recognised nothing" from "recognised something that is nowhere"', async () => {
      await ingest(WAR_MONITOR, 'Підбірка мемів про шахед на вечір 😂');
      await ingest(ERADAR, 'Шахед.');

      const rows = await classifications();
      expect(rows).toEqual([
        expect.objectContaining({
          source_id: WAR_MONITOR, decision: 'unrecognized', intent: 'none',
          ignored_reason: 'not_an_assertion', event_id: null
        }),
        expect.objectContaining({
          source_id: ERADAR, decision: 'ignored', intent: 'threat',
          ignored_reason: 'no_location', threat_type: 'uav', event_id: null
        })
      ]);
    });

    it('records a burst restatement as coalesced rather than dropping it', async () => {
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.');
      await ingest(WAR_MONITOR, 'БпЛА над Полтавщиною, рухаються далі.');

      const rows = await classifications();
      expect(rows.map((row) => row.decision)).toEqual(['event_created', 'coalesced']);
      expect(rows[1]).toMatchObject({
        ignored_reason: 'restated_within_coalesce_window', event_id: null, intent: 'threat'
      });
    });

    it('records a retrospective refusal as its own decision, with the markers that produced it', async () => {
      // `v5`. The message names a weapon AND a place, so it passes every condition `v4` had and was
      // published as a live threat; what refuses it is the tense it is written in. That makes it the
      // only refusal in this table where something threat-shaped was recognised in a place that
      // exists, which is why it gets a decision word of its own rather than joining `ignored`.
      await ingest(ERADAR, 'Вчора ворог атакував Полтавщину ударними БпЛА. Наслідки уточнюються.');

      const rows = await classifications();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        source_id: ERADAR, classifier_version: CLASSIFIER_VERSION,
        decision: 'ignored_retrospective', intent: 'none', ignored_reason: 'retrospective',
        created_event: false, event_id: null
      });
      // The markers travel into `indicators`, so "why was this ignored?" is answerable from the row.
      expect(rows[0]!.indicators).toContain('ретроспектива: вчорашній день');
      // …and the class it would have been filed under survives as a candidate, so the archive can
      // still answer what the refusal suppressed.
      expect(rows[0]!.candidate_threat_types).toContain('uav');
      // Nothing was raised and nowhere was named: a refused message must not put Poltava oblast into
      // the location analytics the refusal exists to keep it out of.
      expect(await classificationLocations('ignored_retrospective')).toEqual([]);
      expect(await sql('SELECT 1 FROM threat_events')).toMatchObject({ rowCount: 0 });
    });

    it('never lets a retrospective reach the official alert tables', async () => {
      // The isolation rule, restated for the new decision. An OSINT monitor cannot start or end an
      // official alert under any classification, and a refusal is no exception — `alert_periods` and
      // `alert_source_states` are reconciled from Tier A sources alone.
      await ingest(ERADAR, 'Вчора ворог атакував Полтавщину ударними БпЛА. Наслідки уточнюються.');
      await ingest(WAR_MONITOR, 'Підсумки ночі: балістика по Полтавщині.');

      expect(await sql('SELECT 1 FROM alert_periods')).toMatchObject({ rowCount: 0 });
      expect(await sql('SELECT 1 FROM alert_source_states')).toMatchObject({ rowCount: 0 });
      expect((await classifications()).map((row) => row.decision))
        .toEqual(['ignored_retrospective', 'ignored_retrospective']);
    });

    it('records what a withdrawal took back, and the last claim that preceded it', async () => {
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.');
      const asserted = await sql<{ asserted_at: string }>(
        `SELECT asserted_at::text FROM threat_assertions WHERE source_id=$1`, [WAR_MONITOR]
      );

      await ingest(WAR_MONITOR, 'Полтавщина — відбій загрози ударних БпЛА.');

      const rows = await classifications();
      expect(rows[1]).toMatchObject({
        decision: 'de_escalation', intent: 'de_escalation',
        retraction_coverage: 'located', retracted_threat_types: ['uav'],
        withdrawn_assertions: 1
      });
      expect(rows[1]!.last_assertion_at).toBe(asserted.rows[0]!.asserted_at);
      expect(rows[1]!.decayed_risk_signals).toBeGreaterThan(0);
      // The withdrawal names its places under their own role, so a redirect can name the same
      // message's locations on both sides without the two collapsing into one another.
      expect(await classificationLocations('de_escalation')).toEqual([
        { location_id: POLTAVA_OBLAST, role: 'retracted', relation_type: null }
      ]);
    });

    it('records a source withdrawing something it never asserted as exactly that', async () => {
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.');
      await ingest(AERIS, 'Полтавщина — відбій загрози ударних БпЛА.');

      const rows = await classifications();
      expect(rows[1]).toMatchObject({
        source_id: AERIS, decision: 'de_escalation', withdrawn_assertions: 0,
        last_assertion_at: null, decayed_risk_signals: 0
      });
    });

    it('records a redirect with both roles of the places it names', async () => {
      await ingest(AERIS, 'Балістика повз Полтаву на Харків.');

      const rows = await classifications();
      expect(rows[0]).toMatchObject({
        decision: 'redirect', intent: 'redirect', created_event: true,
        threat_type: 'ballistic_missile', retraction_coverage: 'located',
        retracted_threat_types: ['ballistic_missile']
      });
      expect(await classificationLocations('redirect')).toEqual([
        { location_id: KHARKIV_CITY, role: 'asserted', relation_type: 'reported_direction' },
        { location_id: POLTAVA_CITY, role: 'asserted', relation_type: 'mentioned' },
        { location_id: POLTAVA_CITY, role: 'retracted', relation_type: null }
      ]);
    });

    it('records a country-wide warning as national rather than inventing a place', async () => {
      await ingest(WAR_MONITOR, 'Загроза застосування балістичного озброєння.');

      const rows = await classifications();
      expect(rows[0]).toMatchObject({
        decision: 'event_created', national_scope: true, threat_type: 'ballistic_missile'
      });
      expect(await classificationLocations('event_created')).toEqual([]);
    });
  });

  describe('classifier version', () => {
    it('keeps one row per message per version, so a replay compares instead of overwriting', async () => {
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.', 'replay-1');
      const first = await classifications();
      expect(first).toHaveLength(1);

      // A replay of the same Telegram message under the same rules is a no-op…
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.', 'replay-1');
      expect(await classifications()).toHaveLength(1);

      // …while the same message re-judged by a newer classifier lands beside the old verdict. This
      // is what makes the archive a golden corpus rather than a running total.
      await sql(
        `INSERT INTO message_classifications(source_message_id,source_id,classifier_version,
           published_at,decision,intent,created_event,threat_type,candidate_threat_types,event_id)
         SELECT source_message_id,source_id,'v99',published_at,decision,intent,created_event,
                'combined',ARRAY['uav','ballistic_missile'],event_id
         FROM message_classifications WHERE classifier_version=$1`,
        [CLASSIFIER_VERSION]
      );
      const versions = await sql<{ classifier_version: string; threat_type: string }>(
        `SELECT classifier_version,threat_type FROM message_classifications ORDER BY classifier_version`
      );
      expect(versions.rows).toEqual([
        { classifier_version: CLASSIFIER_VERSION, threat_type: 'uav' },
        { classifier_version: 'v99', threat_type: 'combined' }
      ]);
    });
  });

  describe('acceptance: one SQL statement per analytical question', () => {
    /**
     * A short night, ingested through the production path.
     *
     * Poltava oblast is reported by two monitors and then stood down by both, so it ends in a
     * withdrawal; Kharkiv city is reported once and stays live; three messages raise nothing, each
     * for a different reason.
     */
    async function seedNight(): Promise<void> {
      await ingest(WAR_MONITOR, 'Шахед курсом на Полтавщину.');
      await ingest(ERADAR, 'БпЛА на Полтавщині.');
      await ingest(WAR_MONITOR, 'БпЛА над Полтавщиною, рухаються далі.');
      await ingest(ERADAR, 'Балістика на Харків.');
      await ingest(AERIS, 'Підбірка мемів про шахед на вечір 😂');
      await ingest(AERIS, 'Шахед.');
      await ingest(WAR_MONITOR, 'Полтавщина — відбій загрози ударних БпЛА.');
      await ingest(ERADAR, 'Полтавщина — відбій загрози ударних БпЛА.');
    }

    it('1. counts events per threat class, per oblast, per month, per classifier version', async () => {
      await seedNight();
      const month = await kyivMonth();

      const result = await sql<{ month: string; oblast_id: string; threat_type: string; classifier_version: string; events: number }>(
        EVENTS_BY_OBLAST_AND_VERSION
      );
      expect(result.rows).toEqual([
        { month, oblast_id: POLTAVA_OBLAST, threat_type: 'uav', classifier_version: CLASSIFIER_VERSION, events: 1 },
        { month, oblast_id: KHARKIV_OBLAST, threat_type: 'ballistic_missile', classifier_version: CLASSIFIER_VERSION, events: 1 }
      ]);
      // The Kharkiv event is filed against a *city*; it appears under its oblast only because the
      // roll-up walks the hierarchy.
      const filed = await sql<{ location_id: string }>(
        `SELECT DISTINCT el.location_id FROM threat_event_locations el
         JOIN threat_events e ON e.id=el.event_id WHERE e.threat_type='ballistic_missile'`
      );
      expect(filed.rows).toEqual([{ location_id: KHARKIV_CITY }]);
    });

    it('2. shows where a threat was last asserted, where it was withdrawn, and how long it stood', async () => {
      await seedNight();

      const result = await sql<{
        threat_type: string; evidence_level: string; last_asserted_by: string;
        last_asserted_for: string; withdrawn_by: string; withdrawn_for: string;
        withdrawal_reason: string; held_for: unknown;
      }>(WHERE_THREATS_ARE_LOST);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        threat_type: 'uav',
        evidence_level: 'confirmed',
        last_asserted_for: POLTAVA_OBLAST,
        withdrawn_for: POLTAVA_OBLAST,
        withdrawal_reason: 'de_escalation'
      });
      expect([WAR_MONITOR, ERADAR]).toContain(result.rows[0]!.last_asserted_by);
      expect(result.rows[0]!.withdrawn_by).toBe(ERADAR);
      expect(result.rows[0]!.held_for).not.toBeNull();
      // The live Kharkiv event is absent because it was never withdrawn — the question is about
      // threats that ended in a stand-down, not about threats that ended.
      const live = await sql<{ n: string }>(
        `SELECT count(*)::text AS n FROM threat_events WHERE status<>'withdrawn'`
      );
      expect(Number(live.rows[0]!.n)).toBe(1);
    });

    it('3. counts what each source published that raised nothing, and why', async () => {
      await seedNight();
      const day = await kyivDay();

      const result = await sql<{ day: string; source_id: string; decision: string; reason: string; messages: number }>(
        IGNORED_BY_SOURCE_AND_DAY
      );
      expect(result.rows).toEqual([
        { day, source_id: AERIS, decision: 'ignored', reason: 'no_location', messages: 1 },
        { day, source_id: AERIS, decision: 'unrecognized', reason: 'not_an_assertion', messages: 1 },
        { day, source_id: WAR_MONITOR, decision: 'coalesced', reason: 'restated_within_coalesce_window', messages: 1 }
      ]);
    });
  });
});
