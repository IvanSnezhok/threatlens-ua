import { beforeEach, describe, expect, it } from 'vitest';
import {
  OBLAST, OTHER_OBLAST, count, ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql
} from '../helpers/db.js';

/**
 * The enrichment path against a real database, where the guarantees are enforced by more than a
 * regular expression over the SQL.
 *
 * `src/services/analytical-enrichment.test.ts` proves what the module is *capable of issuing*: one
 * INSERT into one table, with no `UPDATE`, no `valid_until` and no `system_event_log`. That is the
 * check that runs everywhere and fails in review. This file proves the other half — that the row it
 * writes lands under the constraints migration 045 declares, that the trigger refuses what the
 * writer's own WHERE clause also refuses, and, above all, that the event being annotated comes out of
 * the operation byte-identical.
 *
 * The last one is the assertion this whole feature turns on. `CONTEXT.md` §Межі безпеки puts official
 * signals above analysis and forbids analysis from moving what a source vouched for; a remark that
 * quietly extended a validity window, raised an evidence level or added a district would break that
 * without any test noticing, because every one of those changes is legal SQL against a table this
 * code already has permission to read.
 */

const ERADAR = 'osint-eradar';
let sequence = 0;

/** One ingested message and the event it raised, through the ordinary production path. */
async function ingest(options: { model?: boolean; locationId?: string; direction?: string } = {}) {
  const { ingestThreat } = await import('../../src/repositories/events.js');
  sequence += 1;
  return ingestThreat(
    {
      sourceId: ERADAR,
      externalId: `enrichment-${sequence}`,
      publishedAt: new Date(),
      text: 'Шахед курсом на Полтавщину.',
      rawPayload: { channel: ERADAR, test: true }
    },
    {
      intent: 'threat',
      threatType: 'uav',
      signalThreatTypes: ['uav'],
      locations: [{
        id: options.locationId ?? OTHER_OBLAST, name: options.locationId ?? OTHER_OBLAST,
        relationType: 'explicit_threat'
      }],
      nationalScope: false,
      indicators: options.model ? ['model_analytical_threat'] : [],
      ...(options.direction ? { directionText: options.direction } : {}),
      title: 'Ударні БпЛА',
      summary: 'Група БпЛА в напрямку області.'
    },
    options.model ? { modelPromotion: { model: 'test-model', confidence: 0.93 } } : {}
  );
}

function target(eventId: string, sourceMessageId: string) {
  return { eventId, sourceMessageId, classifierVersion: 'v5', model: 'test-model', confidence: 0.96 };
}

const DRAFTS = [
  { kind: 'direction' as const, locationId: null, threatType: null, directionText: 'курс на Кременчук' },
  { kind: 'additional_location' as const, locationId: OBLAST, threatType: null, directionText: null },
  { kind: 'threat_class' as const, locationId: null, threatType: 'ballistic_missile', directionText: null }
];

/** Everything about the event a reader can perceive, as one comparable value. */
async function eventSnapshot(id: string): Promise<string> {
  const [event, locations] = await Promise.all([
    sql(`SELECT * FROM threat_events WHERE id=$1`, [id]),
    sql(`SELECT location_id,relation_type FROM threat_event_locations
          WHERE event_id=$1 ORDER BY location_id`, [id])
  ]);
  return JSON.stringify({ event: event.rows, locations: locations.rows });
}

/** The official surfaces, which no path from this feature may reach. */
async function officialSnapshot(): Promise<string> {
  const [periods, states] = await Promise.all([
    sql(`SELECT * FROM alert_periods ORDER BY location_id,alert_type,started_at`),
    sql(`SELECT * FROM alert_source_states ORDER BY source_id,location_id,alert_type`)
  ]);
  return JSON.stringify({ periods: periods.rows, states: states.rows });
}

async function insertEnrichment(values: Record<string, unknown>): Promise<void> {
  const row = {
    classifier_version: 'v5', model: 'test-model', confidence: 0.96,
    location_id: null, threat_type: null, direction_text: null,
    // What the seeded channel actually produces: `osint-eradar` is a Tier B monitoring source, so
    // the event it raises is `monitoring`, not `unverified`. The snapshot columns have to match the
    // event exactly or the trigger refuses the row — which is a test of its own below.
    event_threat_type: 'uav', event_evidence_level: 'monitoring', ...values
  };
  const columns = Object.keys(row);
  await sql(
    `INSERT INTO analytical_enrichments(${columns.join(',')})
     VALUES (${columns.map((_column, index) => `$${index + 1}`).join(',')})`,
    columns.map((column) => row[column])
  );
}

describe.skipIf(!integrationDatabaseAvailable)('analytical enrichment', () => {
  beforeEach(async () => {
    await ensureMigrated();
    await resetDatabase();
  });

  describe('schema', () => {
    it('refuses a remark against an official event', async () => {
      // The guarantee, and the one the writer's own WHERE clause cannot provide on its own: it is a
      // property of the table, so a future writer — a script, a psql session, a second service —
      // meets it too. An official alert mirrored into an event is the state speaking.
      const event = await ingest();
      await sql(`UPDATE threat_events SET evidence_level='official' WHERE id=$1`, [event.id]);
      await expect(insertEnrichment({
        event_id: event.id, source_message_id: event.sourceMessageId, kind: 'direction',
        direction_text: 'курс на Кременчук', event_threat_type: 'uav', event_evidence_level: 'official'
      })).rejects.toThrow();
      expect(await count('analytical_enrichments')).toBe(0);
    });

    it('refuses a remark against an event the model itself created', async () => {
      // One opinion cited twice. A model reading stacked on a model event would show in /ops as two
      // independent-looking marks where there is one.
      const promoted = await ingest({ model: true });
      await expect(insertEnrichment({
        event_id: promoted.id, source_message_id: promoted.sourceMessageId, kind: 'direction',
        direction_text: 'курс на Кременчук', event_evidence_level: 'unverified'
      })).rejects.toThrow();
    });

    it('refuses a snapshot that disagrees with the event it claims to describe', async () => {
      // The two copied columns are what an operator reads as «what the rules had published». A row
      // whose snapshot is invented is a plausible-looking lie that no constraint on its own columns
      // could catch, so the trigger re-reads the event.
      const event = await ingest();
      await expect(insertEnrichment({
        event_id: event.id, source_message_id: event.sourceMessageId, kind: 'direction',
        direction_text: 'курс на Кременчук', event_threat_type: 'ballistic_missile'
      })).rejects.toThrow();
    });

    it('refuses a payload that does not match its kind', async () => {
      const event = await ingest();
      await expect(insertEnrichment({
        event_id: event.id, source_message_id: event.sourceMessageId, kind: 'direction',
        direction_text: 'курс на Кременчук', location_id: OBLAST
      })).rejects.toThrow();
    });

    it('keeps one remark of one kind per message and event', async () => {
      // `shadowClassify` is fire-and-forget: a message re-read after a collector restart runs the
      // whole path again, and without the unique index the same remark accumulates a copy per replay.
      const event = await ingest();
      const row = {
        event_id: event.id, source_message_id: event.sourceMessageId, kind: 'direction' as const,
        direction_text: 'курс на Кременчук'
      };
      await insertEnrichment(row);
      await expect(insertEnrichment(row)).rejects.toThrow();
    });
  });

  describe('recordAnalyticalEnrichments', () => {
    it('files every kind of remark beside a live deterministic event', async () => {
      const { recordAnalyticalEnrichments } = await import('../../src/services/analytical-enrichment.js');
      const event = await ingest();
      const result = await recordAnalyticalEnrichments(target(event.id, event.sourceMessageId), DRAFTS);
      expect(result).toEqual({ recorded: 3, refused: 0 });

      const rows = await sql<{ kind: string; event_threat_type: string; event_evidence_level: string }>(
        `SELECT kind,event_threat_type,event_evidence_level FROM analytical_enrichments
          WHERE event_id=$1 ORDER BY kind`, [event.id]
      );
      expect(rows.rows.map((row) => row.kind))
        .toEqual(['additional_location', 'direction', 'threat_class']);
      // The snapshot columns come out of the event row itself, never out of the caller.
      expect(rows.rows[0]).toMatchObject({ event_threat_type: 'uav', event_evidence_level: 'monitoring' });
    });

    it('leaves the event it annotates byte-identical', async () => {
      // PROHIBITIONS 1 and 2, together and in the only form that cannot be argued with. `threat_events`
      // carries `evidence_level`, `valid_until`, `last_observed_at`, `status`, `threat_type`,
      // `direction_text` and `updated_at`; `threat_event_locations` IS the polygon set. All of it is
      // compared before and after.
      const { recordAnalyticalEnrichments } = await import('../../src/services/analytical-enrichment.js');
      const event = await ingest();
      const before = await eventSnapshot(event.id);
      await recordAnalyticalEnrichments(target(event.id, event.sourceMessageId), DRAFTS);
      expect(await eventSnapshot(event.id)).toBe(before);
    });

    it('tells nobody: no lifecycle row, no outbox line, no official write', async () => {
      // PROHIBITION 3. `system_event_log` is the ONLY trigger for the public SSE stream and for the
      // Telegram fan-out, so an unchanged count there is the machine-readable form of «no reader was
      // told anything». The official tables are compared for the reason
      // `analytical-withdrawal.test.ts` compares them: the day this path shares a code path with
      // something that can move an alert, it should fail here rather than on a map.
      const { recordAnalyticalEnrichments } = await import('../../src/services/analytical-enrichment.js');
      const event = await ingest();
      const versions = await count('system_event_log');
      const official = await officialSnapshot();

      await recordAnalyticalEnrichments(target(event.id, event.sourceMessageId), DRAFTS);

      expect(await count('system_event_log')).toBe(versions);
      expect(await count('notification_outbox')).toBe(0);
      expect(await count('event_updates', 'event_id=$1', [event.id])).toBe(0);
      expect(await officialSnapshot()).toBe(official);
    });

    it('refuses an official event without raising, and reports it as refused', async () => {
      // PROHIBITION 4 from the writer's side. The trigger above is the property; this is the
      // behaviour an operator gets: the statement matches no row, nothing is written, and the count
      // says so instead of an exception reaching a caller that would swallow it anyway.
      const { recordAnalyticalEnrichments } = await import('../../src/services/analytical-enrichment.js');
      const event = await ingest();
      await sql(`UPDATE threat_events SET evidence_level='official' WHERE id=$1`, [event.id]);
      const result = await recordAnalyticalEnrichments(target(event.id, event.sourceMessageId), DRAFTS);
      expect(result).toEqual({ recorded: 0, refused: 3 });
      expect(await count('analytical_enrichments')).toBe(0);
    });

    it('refuses a remark against an event the model created', async () => {
      const { recordAnalyticalEnrichments } = await import('../../src/services/analytical-enrichment.js');
      const promoted = await ingest({ model: true });
      expect(await recordAnalyticalEnrichments(target(promoted.id, promoted.sourceMessageId), DRAFTS))
        .toEqual({ recorded: 0, refused: 3 });
    });

    it('refuses an addition the event already has', async () => {
      // The re-check against the event as it STANDS, not as the message read it: the district is the
      // one the event was created with, and the direction is one the rules had already stored.
      const { recordAnalyticalEnrichments } = await import('../../src/services/analytical-enrichment.js');
      const event = await ingest({ direction: 'у напрямку Полтавщини' });
      const result = await recordAnalyticalEnrichments(target(event.id, event.sourceMessageId), [
        { kind: 'direction', locationId: null, threatType: null, directionText: 'курс на Кременчук' },
        { kind: 'additional_location', locationId: OTHER_OBLAST, threatType: null, directionText: null },
        { kind: 'threat_class', locationId: null, threatType: 'uav', directionText: null }
      ]);
      expect(result).toEqual({ recorded: 0, refused: 3 });
    });

    it('refuses a remark against an event that is no longer live', async () => {
      const { recordAnalyticalEnrichments } = await import('../../src/services/analytical-enrichment.js');
      const event = await ingest();
      await sql(`UPDATE threat_events SET status='expired',ended_at=now() WHERE id=$1`, [event.id]);
      expect(await recordAnalyticalEnrichments(target(event.id, event.sourceMessageId), DRAFTS))
        .toEqual({ recorded: 0, refused: 3 });
    });
  });

  describe('what /ops reads', () => {
    it('reports the remarks with the event they annotate and the place they name', async () => {
      const { enrichmentReport, recordAnalyticalEnrichments } =
        await import('../../src/services/analytical-enrichment.js');
      const event = await ingest();
      await recordAnalyticalEnrichments(target(event.id, event.sourceMessageId), DRAFTS);

      const report = await enrichmentReport(24, 10);
      expect(report.total).toBe(3);
      expect(report.byKind.map((row) => row.kind).sort())
        .toEqual(['additional_location', 'direction', 'threat_class']);
      const place = report.recent.find((row) => row.kind === 'additional_location');
      expect(place?.locationId).toBe(OBLAST);
      // Resolved through the catalogue, so the reading list can name the place without trusting the
      // model's spelling of it.
      expect(place?.locationName).toBeTruthy();
      expect(place?.event.evidenceLevel).toBe('monitoring');
      expect(place?.sourceMessageId).toBe(event.sourceMessageId);
    });
  });
});
