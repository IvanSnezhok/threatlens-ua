import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

/**
 * Threat vectors, end to end, against a live PostgreSQL.
 *
 * Two things are being proved, and the second is the reason the file exists.
 *
 *  1. **The chain is assembled from what sources actually said.** Three monitoring channels lead one
 *     ballistic threat from Sumy through Poltava to Kharkiv over eight minutes, and the resulting
 *     chain reproduces that with the right evidence on every leg — `reported_transit` where a single
 *     message stated the move ("повз Полтаву на Харків"), a collapsed node where a channel merely
 *     restated a place, and the corroboration that three independent groups produce.
 *
 *  2. **The operator-only extrapolation cannot be observed from outside.** A projection is computed
 *     and stamped with a marker string, and then every public surface the product has — the
 *     snapshot, the threat list, the threat detail, the history, the location timeline, the public
 *     vector endpoints and a live SSE connection including its replay backfill — is read and searched
 *     for it. `src/api/vector-isolation.test.ts` proves the *code* cannot reach the projection; this
 *     proves the *responses* do not contain it, which is the property a reader actually depends on.
 *
 * Nothing here touches the network. Message texts are the shapes the monitoring channels publish.
 */

const AERIS = 'osint-aeris-rimor';
const WAR_MONITOR = 'osint-war-monitor';
const ERADAR = 'osint-eradar';
const SUMY_CITY = 'ua-city-sumy';
const POLTAVA_CITY = 'ua-city-poltava';
const KHARKIV_CITY = 'ua-city-kharkiv';

/** Planted into the stored projection so a leak is a string match rather than a judgement call. */
const MARKER = 'PROJECTION-LEAK-CANARY-8f2c41';

let sequence = 0;

async function ingest(sourceId: string, text: string, publishedAt: Date) {
  const { processMessage } = await import('../../src/services/ingestion.js');
  sequence += 1;
  return processMessage({
    sourceId,
    externalId: `vector-${sourceId}-${sequence}`,
    publishedAt,
    text,
    rawPayload: { channel: sourceId, test: true }
  }, { monitor: true });
}

async function resetCoalescing() {
  const { resetMonitorCoalescing } = await import('../../src/services/ingestion.js');
  resetMonitorCoalescing();
}

/**
 * "Три джерела за вісім хвилин вели ціль від Сум через Полтаву до Харкова."
 *
 * Message two merges into the event message one raised, because it names Poltava and the event
 * already covers it — which is exactly how a chain grows in production.
 */
async function seedChain(): Promise<string> {
  const now = Date.now();
  await ingest(AERIS, 'Балістика повз Суми на Полтаву.', new Date(now - 8 * 60_000));
  await ingest(WAR_MONITOR, 'Балістика повз Полтаву на Харків.', new Date(now - 4 * 60_000));
  await ingest(ERADAR, 'Балістична загроза для Харкова.', new Date(now));
  const events = await sql<{ id: string }>(`SELECT id FROM threat_events ORDER BY created_at`);
  expect(events.rowCount, 'the three messages must land on one event').toBe(1);
  return events.rows[0]!.id;
}

describe.skipIf(!integrationDatabaseAvailable)('threat vectors', () => {
  beforeAll(async () => { await ensureMigrated(); });
  beforeEach(async () => { await resetDatabase(); resetCoalescing(); });

  describe('the reported chain', () => {
    it('leads a target through three sources, and grades every leg by what was actually said', async () => {
      const eventId = await seedChain();
      const { reportedVectorForEvent } = await import('../../src/services/threat-vectors.js');
      const vector = (await reportedVectorForEvent(eventId))!;

      expect(vector.nodes.map((node) => node.locationId)).toEqual([SUMY_CITY, POLTAVA_CITY, KHARKIV_CITY]);
      expect(vector.segments.map((segment) => segment.basis)).toEqual(['reported_transit', 'reported_transit']);
      // Both legs come from a `redirect`: one message named the place being passed and the place
      // being approached, so the movement itself is attested rather than inferred.
      expect(vector.segments[0]!.source.id).toBe(AERIS);
      expect(vector.segments[1]!.source.id).toBe(WAR_MONITOR);
      // The third message only restated Kharkiv, so it strengthens the node instead of extending it.
      expect(vector.nodes[2]!.reports.map((report) => report.source.id)).toEqual([WAR_MONITOR, ERADAR]);
      expect(vector.span).toMatchObject({ sourceCount: 3, independenceGroupCount: 3, drawableSegments: 2 });
      expect(vector.span.elapsedSeconds).toBeGreaterThanOrEqual(8 * 60 - 2);
      expect(vector.disclaimer).toContain('не траєкторія');
    });

    /**
     * The class travels with the chain, and this is the only place the SQL that fetches it runs.
     *
     * `buildReportedVector` is pure and is pinned without a database, so a wrong column alias or a
     * dropped join in `CHAIN_QUERY` would leave every unit test green and publish a chain that says
     * where without saying what. Both halves are asserted: `threat_events.threat_type` on the
     * envelope, `message_classifications.threat_type` on each leg.
     */
    it('names the class that is moving, on the envelope and on every leg', async () => {
      const eventId = await seedChain();
      const { reportedVectorForEvent } = await import('../../src/services/threat-vectors.js');
      const vector = (await reportedVectorForEvent(eventId))!;
      expect(vector.threatType).toBe('ballistic_missile');
      expect(vector.segments.map((segment) => segment.threatType))
        .toEqual(['ballistic_missile', 'ballistic_missile']);
      // Additive: everything the payload published before is still published, unchanged.
      expect(vector.kind).toBe('reported_observation_chain');
      expect(vector.segments.map((segment) => segment.basis)).toEqual(['reported_transit', 'reported_transit']);
    });

    it('is a projection of the classification archive, not a second copy of it', async () => {
      const eventId = await seedChain();
      const { reportedVectorForEvent } = await import('../../src/services/threat-vectors.js');
      const before = await reportedVectorForEvent(eventId);
      expect(before!.segments).toHaveLength(2);

      // Deleting the archive rows removes the chain outright. Nothing else stores it, so nothing
      // else can disagree with the messages it claims to summarise.
      await sql(`DELETE FROM message_classification_locations`);
      expect(await reportedVectorForEvent(eventId)).toBeNull();
    });

    it('keeps a node whose place has no coordinate, and refuses to draw that leg', async () => {
      const eventId = await seedChain();
      // `locations` is reference data seeded by the migrations, so `resetDatabase()` does not restore
      // it. Blanking a coordinate has to be undone here or every later file inherits the damage.
      const original = await sql<{ latitude: number; longitude: number }>(
        `SELECT latitude,longitude FROM locations WHERE id=$1`, [POLTAVA_CITY]
      );
      try {
        await sql(`UPDATE locations SET latitude=NULL,longitude=NULL WHERE id=$1`, [POLTAVA_CITY]);
        const { reportedVectorForEvent } = await import('../../src/services/threat-vectors.js');
        const vector = (await reportedVectorForEvent(eventId))!;

        expect(vector.nodes[1]!.coordinates).toBeNull();
        expect(vector.nodes[1]!.coordinatePrecision).toBe('unavailable');
        expect(vector.segments).toHaveLength(2);
        expect(vector.segments.every((segment) => segment.drawable)).toBe(false);
        expect(vector.span.drawableSegments).toBe(0);

        // And the extrapolation refuses rather than guessing a position for the missing end.
        const { projectEventVector } = await import('../../src/services/vector-projection.js');
        expect(await projectEventVector(eventId)).toMatchObject({ available: false, reason: 'no_drawable_leg' });
      } finally {
        await sql(`UPDATE locations SET latitude=$2,longitude=$3 WHERE id=$1`,
          [POLTAVA_CITY, original.rows[0]!.latitude, original.rows[0]!.longitude]);
      }
    });
  });

  describe('the operator-only extrapolation', () => {
    it('stores every row as a calculation, by constraint rather than by caption', async () => {
      const eventId = await seedChain();
      const { projectEventVector } = await import('../../src/services/vector-projection.js');
      const result = await projectEventVector(eventId, { horizonMinutes: 15 });
      expect(result.available, `projection unavailable: ${result.available ? '' : result.reason}`).toBe(true);
      if (!result.available) return;

      const stored = await sql<{ data_nature: string; confidence: string; narrative_origin: string; radius_km_at_horizon: string }>(
        `SELECT data_nature,confidence,narrative_origin,radius_km_at_horizon FROM ops_threat_vector_projections`
      );
      expect(stored.rowCount).toBe(1);
      expect(stored.rows[0]!.data_nature).toBe('calculated');
      expect(['low', 'medium']).toContain(stored.rows[0]!.confidence);
      expect(Number(stored.rows[0]!.radius_km_at_horizon)).toBeGreaterThan(0);
      // No model is configured in the test environment, so the wording is the generated one.
      expect(stored.rows[0]!.narrative_origin).toBe('deterministic');

      await expect(
        sql(`UPDATE ops_threat_vector_projections SET data_nature='observed'`)
      ).rejects.toThrow();
      await expect(
        sql(`UPDATE ops_threat_vector_projections SET confidence='high'`)
      ).rejects.toThrow();
    });

    it('never writes to the public event, its geometry or the system event log', async () => {
      const eventId = await seedChain();
      const before = await sql<{ geometry: unknown; geometry_semantics: string | null; updated_at: string }>(
        `SELECT geometry,geometry_semantics,updated_at::text FROM threat_events WHERE id=$1`, [eventId]
      );
      const versionsBefore = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM system_event_log`);

      const { projectEventVector } = await import('../../src/services/vector-projection.js');
      await projectEventVector(eventId, { horizonMinutes: 15 });

      const after = await sql<{ geometry: unknown; geometry_semantics: string | null; updated_at: string }>(
        `SELECT geometry,geometry_semantics,updated_at::text FROM threat_events WHERE id=$1`, [eventId]
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
      const versionsAfter = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM system_event_log`);
      expect(versionsAfter.rows[0]!.n).toBe(versionsBefore.rows[0]!.n);
    });
  });

  describe('public surfaces', () => {
    let app: FastifyInstance;
    let baseUrl = '';

    beforeAll(async () => {
      // buildServer() registers both vector plugins itself. Registering them again here — which this
      // test did while server.ts was off-limits — throws FST_ERR_DUPLICATED_ROUTE in beforeAll, and
      // Vitest reports the suite as skipped rather than failed. That silently disarmed the two
      // assertions that matter most in this file, so the server is taken exactly as it ships.
      const { buildServer } = await import('../../src/api/server.js');
      app = await buildServer();
      baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
    });

    afterAll(async () => { await app?.close(); });

    /** Reads whatever the stream emits, including the replay backfill, then hangs up. */
    async function readStream(millis: number): Promise<string> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), millis);
      try {
        const response = await fetch(`${baseUrl}/api/v1/stream`, {
          headers: { 'Last-Event-ID': '1' },
          signal: controller.signal
        });
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let text = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
          }
        } catch { /* the abort above is the exit condition */ }
        return text;
      } catch {
        return '';
      } finally {
        clearTimeout(timer);
      }
    }

    it('never repeat the extrapolation, on any of them', async () => {
      const eventId = await seedChain();
      const { projectEventVector } = await import('../../src/services/vector-projection.js');
      const result = await projectEventVector(eventId, { horizonMinutes: 15 });
      if (!result.available) throw new Error(`projection unavailable: ${result.reason}`);
      // A marker inside the stored row: if any payload below reproduces the projection in any shape,
      // it reproduces this string with it.
      await sql(`UPDATE ops_threat_vector_projections SET narrative = narrative || $1`, [` ${MARKER}`]);
      const projectionId = result.projection.id!;
      const projectedPoint = result.projection.geometry.centerline.coordinates[1]!;

      const publicPaths = [
        '/api/v1/snapshot',
        '/api/v1/threats',
        `/api/v1/threats/${eventId}`,
        `/api/v1/threats/${eventId}/vector`,
        '/api/v1/vectors',
        '/api/v1/history?limit=100',
        `/api/v1/locations/${KHARKIV_CITY}/timeline`,
        '/api/v1/alerts',
        '/api/v1/assessments',
        '/api/v1/config',
        '/api/v1/methodology'
      ];
      const bodies: Array<[string, string]> = [];
      for (const path of publicPaths) {
        const response = await app.inject({ method: 'GET', url: path });
        expect(response.statusCode, `${path} answered ${response.statusCode}`).toBe(200);
        bodies.push([path, response.body]);
      }
      bodies.push(['sse', await readStream(1200)]);

      for (const [label, body] of bodies) {
        expect(body, `${label} leaked the marker`).not.toContain(MARKER);
        expect(body, `${label} leaked the projection id`).not.toContain(projectionId);
        // Field names and vocabulary that only the extrapolation uses.
        for (const token of ['calculated', 'bearingDegrees', 'groundSpeedKmh', 'horizonMinutes', 'narrative', 'uncertainty', 'candidates', 'centerline', 'cone']) {
          expect(body, `${label} leaked "${token}"`).not.toContain(token);
        }
        // The projected coordinate itself, to six decimals, in case a payload carried the geometry
        // without any of the field names above.
        expect(body, `${label} leaked the projected longitude`).not.toContain(projectedPoint[0]!.toFixed(6));
      }
    });

    it('serves the chain publicly while refusing the extrapolation without operator credentials', async () => {
      const eventId = await seedChain();
      const { projectEventVector } = await import('../../src/services/vector-projection.js');
      const projected = await projectEventVector(eventId, { horizonMinutes: 15 });
      expect(projected.available).toBe(true);
      await sql(`UPDATE ops_threat_vector_projections SET narrative = narrative || $1`, [` ${MARKER}`]);

      const chain = await app.inject({ method: 'GET', url: `/api/v1/threats/${eventId}/vector` });
      expect(chain.statusCode).toBe(200);
      expect(chain.json().segments).toHaveLength(2);
      // The class reaches the wire, not only the service: this is what the map draws its chip from.
      expect(chain.json().threatType).toBe('ballistic_missile');

      for (const path of [`/ops/threats/${eventId}/vector-projection`, '/ops/vectors']) {
        expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(401);
      }
      expect((await app.inject({ method: 'POST', url: `/ops/threats/${eventId}/vector-projection` })).statusCode).toBe(401);
      expect(
        (await app.inject({
          method: 'GET',
          url: `/ops/threats/${eventId}/vector-projection`,
          headers: { authorization: `Basic ${Buffer.from('operator:wrong-password').toString('base64')}` }
        })).statusCode
      ).toBe(401);

      const authorization = `Basic ${Buffer.from('operator:change-me').toString('base64')}`;
      const authorised = await app.inject({
        method: 'GET', url: `/ops/threats/${eventId}/vector-projection`, headers: { authorization }
      });
      expect(authorised.statusCode).toBe(200);
      // The data exists, and this is the only door it comes through.
      expect(authorised.body).toContain(MARKER);
      expect(authorised.json().projection.data_nature).toBe('calculated');
    });
  });
});
