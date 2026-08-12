import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  OBLAST, OTHER_OBLAST, ensureMigrated, integrationDatabaseAvailable, resetDatabase, seedThreatEvent, sql
} from '../helpers/db.js';

/**
 * `threat_events.origin` end to end: the schema that stores it, the writer that sets it, and the
 * three public reads that have to carry it.
 *
 * The gap this closes is a presentational one with a safety edge. A Tier C human report and a
 * promoted model verdict both land on `evidence_level='unverified'`, and until migration 041 the
 * only trace of model authorship lived in `classified.indicators` (consumed inside the ingest
 * transaction) and in `source_messages.raw_payload`. So the map printed «не перевірено» over both
 * and a reader could not tell «людина написала, підтвердження ще немає» from «людина цього не
 * писала — так вирішила модель». The unit suite beside `src/repositories/events.ts` proves the
 * branch; this file proves the column exists, survives the round trip, and reaches the reader.
 *
 * Every case is written against rows and HTTP responses rather than against a repository return
 * value, because the guarantee is about what a public client receives.
 */

const ERADAR = 'osint-eradar';

let app: FastifyInstance;
let baseUrl: string;
let sequence = 0;

/**
 * The location is a parameter because merging is: `ingestThreat` joins a message into any live event
 * of the same class over the same place inside thirty minutes. Two cases below need two separate
 * events and one needs the merge, and the only honest way to ask for either is to choose the place.
 */
async function ingest(options: { model?: boolean; locationId?: string } = {}) {
  const { ingestThreat } = await import('../../src/repositories/events.js');
  const locationId = options.locationId ?? OTHER_OBLAST;
  sequence += 1;
  return ingestThreat(
    {
      sourceId: ERADAR,
      externalId: `origin-${sequence}`,
      publishedAt: new Date(),
      text: 'Шахед курсом на Полтавщину.',
      rawPayload: { channel: ERADAR, test: true }
    },
    {
      intent: 'threat',
      threatType: 'uav',
      signalThreatTypes: ['uav'],
      locations: [{ id: locationId, name: locationId, relationType: 'explicit_threat' }],
      nationalScope: false,
      indicators: options.model ? ['model_analytical_threat'] : [],
      title: 'Ударні БпЛА',
      summary: 'Група БпЛА в напрямку області.'
    },
    options.model ? { modelPromotion: { model: 'test-model', confidence: 0.86 } } : {}
  );
}

async function originOf(eventId: string): Promise<string> {
  const rows = await sql<{ origin: string }>(`SELECT origin FROM threat_events WHERE id=$1`, [eventId]);
  return rows.rows[0]!.origin;
}

describe.skipIf(!integrationDatabaseAvailable)('threat event origin', () => {
  beforeAll(async () => {
    await ensureMigrated();
    const { buildServer } = await import('../../src/api/server.js');
    app = await buildServer();
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => { await app?.close(); });

  beforeEach(resetDatabase);

  describe('schema', () => {
    it('defaults to deterministic for every writer that does not know the column', async () => {
      // `seedThreatEvent` names no origin, exactly as a rolled-back application binary would not.
      // The default is what keeps such a writer producing correct rows instead of NULLs.
      const id = await seedThreatEvent({ locationIds: [OTHER_OBLAST] });
      expect(await originOf(id)).toBe('deterministic');
    });

    it('refuses a third word', async () => {
      // Two values, enforced in the database, for the same reason migration 016 gives about
      // `narrative_origin`: a word that exists in the schema eventually reaches a screen. G3 and G5
      // will both branch on this column, and a third value would make each of them silently
      // incomplete rather than loudly broken.
      const id = await seedThreatEvent({ locationIds: [OTHER_OBLAST] });
      await expect(sql(`UPDATE threat_events SET origin='guess' WHERE id=$1`, [id])).rejects.toThrow();
    });

    it('serves the model events from a partial index rather than a sequential scan', async () => {
      // The index is `WHERE origin='model'` and every consumer asks that way. This asserts the shape
      // that makes it usable, not the planner's choice on an empty table.
      const rows = await sql<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE tablename='threat_events' AND indexname='idx_threat_events_model_origin'`
      );
      expect(rows.rowCount).toBe(1);
      expect(rows.rows[0]!.indexdef).toMatch(/WHERE \(origin = 'model'::text\)/);
    });
  });

  describe('ingestThreat', () => {
    it('labels a model promotion, and labels nothing else', async () => {
      // Two oblasts, so neither message can merge into the other's event and each assertion is
      // about the row its own call created.
      const promoted = await ingest({ model: true, locationId: OBLAST });
      const ordinary = await ingest({ locationId: OTHER_OBLAST });

      expect(promoted.id).not.toBe(ordinary.id);
      expect(await originOf(promoted.id)).toBe('model');
      expect(await originOf(ordinary.id)).toBe('deterministic');
    });

    it('keeps the promotion unverified, which is the whole reason origin is a separate column', async () => {
      const promoted = await ingest({ model: true });
      const rows = await sql<{ evidence_level: string; origin: string }>(
        `SELECT evidence_level,origin FROM threat_events WHERE id=$1`, [promoted.id]
      );
      expect(rows.rows[0]).toEqual({ evidence_level: 'unverified', origin: 'model' });
    });

    it('does not relabel a model event when a human message merges into it', async () => {
      // Corroboration is `evidence_level`; authorship is `origin`. A later human report raises the
      // first and must not erase the second — otherwise the disclosure disappears at the exact
      // moment the event grows, and the reader watches a model guess become an ordinary report.
      const promoted = await ingest({ model: true });
      const merged = await ingest();

      expect(merged.id).toBe(promoted.id);
      expect(merged.created).toBe(false);
      expect(await originOf(promoted.id)).toBe('model');
    });
  });

  describe('public reads', () => {
    it('carries origin on /api/v1/threats, /api/v1/threats/:id and /api/v1/history', async () => {
      const promoted = await ingest({ model: true });

      const live = await (await fetch(`${baseUrl}/api/v1/threats`)).json();
      expect(live.find((item: { id: string }) => item.id === promoted.id)?.origin).toBe('model');

      const details = await (await fetch(`${baseUrl}/api/v1/threats/${promoted.id}`)).json();
      expect(details.origin).toBe('model');

      const history = await (await fetch(`${baseUrl}/api/v1/history`)).json();
      expect(history.items.find((item: { id: string }) => item.id === promoted.id)?.origin).toBe('model');
    });

    it('says deterministic rather than nothing for an ordinary event', async () => {
      // An absent field would be read by `web/app.js` as «походження невідоме», which is not what
      // the database says. Every event has an origin; only one of the two words is printed.
      const ordinary = await ingest();
      const live = await (await fetch(`${baseUrl}/api/v1/threats`)).json();
      expect(live.find((item: { id: string }) => item.id === ordinary.id)?.origin).toBe('deterministic');
    });
  });
});
