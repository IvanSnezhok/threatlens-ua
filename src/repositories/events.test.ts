import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassifiedMessage, NormalizedMessage } from '../types.js';

/**
 * Authorship of a threat event, at the only place that writes it.
 *
 * These tests do not go near a database, and that is the point rather than a compromise. What is
 * under test is a decision — "which word does this INSERT carry in `origin`" — and the decision is
 * taken from `options.modelPromotion` alone, three lines above the statement. Driving it through
 * live PostgreSQL would prove the same branch through a truncate, a catalogue and a migration run,
 * and would prove it only where an integration database exists; the fake client below asserts the
 * parameter list `ingestThreat` actually hands to node-pg, which is the artefact the column is
 * written from.
 *
 * The one thing a fake client cannot check is that `threat_events` HAS an `origin` column and that
 * PostgreSQL accepts the value — that belongs to `migrations/041_threat_event_origin.sql` and to the
 * integration suite that applies it, and the CHECK constraint there is what makes a third word
 * impossible rather than merely unwritten.
 *
 * `sources` deliberately returns no row, so `sourceRow` falls back to Tier C. Both cases below then
 * land on the SAME `evidence_level` — `unverified` — which is exactly the collision this column
 * exists to resolve: a Tier C human report and a model promotion are indistinguishable by evidence
 * and must not be indistinguishable by authorship.
 */

interface RecordedQuery { text: string; params: unknown[] }

const queries: RecordedQuery[] = [];

/**
 * Answers only the four statements whose result `ingestThreat` reads back; everything else is an
 * empty result set, which drives the transaction down the plain "new event, nothing existing"
 * path. Matching on the statement text rather than on call order is what keeps this fake from
 * breaking every time an unrelated query is added to the middle of the transaction.
 */
function respond(text: string): { rows: unknown[]; rowCount: number } {
  if (/INSERT INTO source_messages/.test(text)) return { rows: [{ id: 'source-message-1' }], rowCount: 1 };
  if (/INSERT INTO threat_events/.test(text)) return { rows: [{ id: 'event-1' }], rowCount: 1 };
  if (/INSERT INTO system_event_log/.test(text)) return { rows: [{ version: '42' }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}

const record = async (text: string, params: unknown[] = []) => {
  queries.push({ text, params });
  return respond(text);
};

const client = { query: vi.fn(record), release: vi.fn() };

vi.mock('../db/pool.js', () => ({
  pool: {
    connect: async () => client,
    query: async () => ({ rows: [{ version: '42' }], rowCount: 1 })
  }
}));

const { ingestThreat } = await import('./events.js');

const message = (): NormalizedMessage => ({
  sourceId: 'source-1',
  externalId: 'ext-1',
  publishedAt: new Date(),
  text: 'Шахед курсом на Полтавщину.',
  rawPayload: {}
});

const classified = (over: Partial<ClassifiedMessage> = {}): ClassifiedMessage => ({
  intent: 'threat',
  threatType: 'uav',
  signalThreatTypes: ['uav'],
  locations: [{ id: 'ua-53', name: 'Полтавська область', relationType: 'explicit_threat' }],
  nationalScope: false,
  indicators: [],
  title: 'Ударні БпЛА',
  summary: 'Група БпЛА в напрямку області.',
  ...over
});

/** The INSERT that creates the event, with the parameter list as node-pg received it. */
function eventInsert(): RecordedQuery {
  const insert = queries.find((query) => /INSERT INTO threat_events\(/.test(query.text));
  expect(insert, 'ingestThreat did not insert a threat event').toBeDefined();
  return insert!;
}

/** Reads a column out of the INSERT by its position in the column list, not by a hard-coded index. */
function inserted(column: string): unknown {
  const insert = eventInsert();
  const columns = insert.text.match(/INSERT INTO threat_events\(([^)]+)\)/)![1]!.split(',');
  const position = columns.indexOf(column);
  expect(position, `threat_events INSERT does not name ${column}`).toBeGreaterThanOrEqual(0);
  // Column N of the list is written by whatever `$k` sits at position N of the VALUES list.
  const values = insert.text.match(/VALUES \(([\s\S]+?)\) RETURNING id/)![1]!.split(',');
  const placeholder = values[position]!.match(/\$(\d+)/);
  expect(placeholder, `column ${column} is not written from a bound parameter`).not.toBeNull();
  return insert.params[Number(placeholder![1]) - 1];
}

describe('ingestThreat: event origin', () => {
  beforeEach(() => {
    queries.length = 0;
    // The default implementation is restored, not merely cleared: the merge case below replaces it,
    // and a test that inherited that replacement would silently be testing the merge branch.
    client.query.mockReset();
    client.query.mockImplementation(record);
  });

  it('records a model promotion as origin=model', async () => {
    await ingestThreat(message(), classified({ indicators: ['model_analytical_threat'] }), {
      modelPromotion: { model: 'test-model', confidence: 0.82 }
    });

    expect(inserted('origin')).toBe('model');
  });

  it('records an ordinary source message as origin=deterministic', async () => {
    await ingestThreat(message(), classified());

    expect(inserted('origin')).toBe('deterministic');
  });

  it('leaves the promotion on unverified evidence, which is what makes origin necessary', async () => {
    // Both paths write the same evidence level here, and both are correct: neither claim is
    // corroborated. If this assertion ever fails because a promotion started writing something
    // stronger, `origin` has stopped being a disclosure and started being a second severity.
    await ingestThreat(message(), classified(), { modelPromotion: { model: 'test-model', confidence: 0.9 } });
    const promoted = inserted('evidence_level');
    queries.length = 0;

    await ingestThreat(message(), classified());

    expect(promoted).toBe('unverified');
    expect(inserted('evidence_level')).toBe('unverified');
  });

  it('writes exactly one of the two permitted words, never a third', async () => {
    // The CHECK in migration 041 is the real guard; this asserts the application never leans on it.
    for (const options of [{}, { modelPromotion: { model: 'test-model', confidence: 0.7 } }]) {
      queries.length = 0;
      await ingestThreat(message(), classified(), options);
      expect(['deterministic', 'model']).toContain(inserted('origin'));
    }
  });

  it('does not touch origin when a message merges into an existing event', async () => {
    // The merge branch is reached by answering the "is there a live event here already" SELECT with
    // a row. A human message joining an event the model created must raise corroboration without
    // quietly relabelling the event as rule-authored — the disclosure has to survive the merge.
    client.query.mockImplementation(async (text: string, params: unknown[] = []) => {
      queries.push({ text, params });
      if (/FROM threat_events e\s+JOIN threat_event_locations/.test(text)) {
        return { rows: [{ id: 'event-1', evidence_level: 'unverified', status: 'observed' }], rowCount: 1 };
      }
      return respond(text);
    });

    await ingestThreat(message(), classified());

    const update = queries.find((query) => /UPDATE threat_events SET\s+summary=/.test(query.text));
    expect(update, 'the merge branch did not run').toBeDefined();
    expect(update!.text).not.toMatch(/\borigin\s*=/);
    expect(queries.some((query) => /INSERT INTO threat_events\(/.test(query.text))).toBe(false);
  });
});
