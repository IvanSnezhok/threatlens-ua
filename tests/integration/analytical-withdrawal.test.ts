import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  OBLAST, OTHER_OBLAST, count, ensureMigrated, integrationDatabaseAvailable, resetDatabase, seedThreatEvent, sql
} from '../helpers/db.js';

/**
 * The early exit for analytical events, against a real database and against the tables it must never
 * reach.
 *
 * The unit suite beside `src/repositories/events.ts` proves the guard is in the SQL. This file proves
 * the three things a fake client cannot: that `analytical_withdrawals` exists with the constraints
 * migration 042 declares, that the guarded UPDATE really matches nothing when the event is
 * deterministic, and — the assertion this whole capability turns on — that a withdrawal leaves the
 * official surfaces byte-identical.
 *
 * `CONTEXT.md` §Межі безпеки: офіційні сигнали завжди мають пріоритет над аналітикою. An operator
 * removing a model's guess is the least dangerous write this system has, right up until the moment it
 * shares a code path with something that can end an official alert. The «official tables» block below
 * exists so that sharing shows up as a failing test rather than as an all-clear nobody sent.
 */

const ERADAR = 'osint-eradar';
const OPS = `Basic ${Buffer.from('operator:change-me').toString('base64')}`;
const UNKNOWN_EVENT = '00000000-0000-4000-8000-000000000000';

let app: FastifyInstance;
let baseUrl: string;
let sequence = 0;

/**
 * One ingested message, deterministic or promoted. The location is a parameter for the same reason
 * `threat-origin.test.ts` makes it one: `ingestThreat` merges into any live event of the same class
 * over the same place inside thirty minutes, so two independent events need two places.
 */
async function ingest(options: { model?: boolean; locationId?: string } = {}) {
  const { ingestThreat } = await import('../../src/repositories/events.js');
  sequence += 1;
  return ingestThreat(
    {
      sourceId: ERADAR,
      externalId: `withdrawal-${sequence}`,
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
      title: 'Ударні БпЛА',
      summary: 'Група БпЛА в напрямку області.'
    },
    options.model ? { modelPromotion: { model: 'test-model', confidence: 0.93 } } : {}
  );
}

async function eventRow(id: string) {
  const rows = await sql<{ status: string; origin: string; ended_at: Date | null; evidence_level: string }>(
    `SELECT status,origin,ended_at,evidence_level FROM threat_events WHERE id=$1`, [id]
  );
  return rows.rows[0]!;
}

/**
 * Everything the official surfaces hold, as one comparable value. Read before and after so that a
 * future edit which quietly adds an official write to this path fails here instead of on a map.
 */
async function officialSnapshot() {
  const [periods, states] = await Promise.all([
    sql(`SELECT * FROM alert_periods ORDER BY location_id,alert_type,started_at`),
    sql(`SELECT * FROM alert_source_states ORDER BY source_id,location_id,alert_type`)
  ]);
  return JSON.stringify({ periods: periods.rows, states: states.rows });
}

async function seedOfficialAlert(): Promise<void> {
  await sql(
    `INSERT INTO alert_periods(location_id,alert_type,status,started_at,external_id)
     VALUES ($1,'air_raid','active',now()-interval '10 minutes','official-1')`,
    [OBLAST]
  );
  await sql(
    `INSERT INTO alert_source_states(source_id,location_id,alert_type,active,provider_started_at,external_id)
     VALUES ('alerts-in-ua',$1,'air_raid',true,now()-interval '10 minutes','official-1')`,
    [OBLAST]
  );
}

describe.skipIf(!integrationDatabaseAvailable)('analytical event withdrawal', () => {
  beforeAll(async () => {
    await ensureMigrated();
    const { buildServer } = await import('../../src/api/server.js');
    app = await buildServer();
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => { await app?.close(); });

  beforeEach(resetDatabase);

  describe('schema', () => {
    it('refuses an audit row without a real reason', async () => {
      // The lower bound is the point of the column. A reason field that accepts «ні» produces an
      // audit log that documents nothing, and this capability is only acceptable because it is
      // reviewable.
      const id = await seedThreatEvent({ locationIds: [OTHER_OBLAST] });
      await expect(sql(
        `INSERT INTO analytical_withdrawals(event_id,previous_status,reason,withdrawn_by,mode)
         VALUES ($1,'observed','ні','operator','operator')`, [id]
      )).rejects.toThrow();
    });

    it('refuses an unnamed actor and an invented mode', async () => {
      const id = await seedThreatEvent({ locationIds: [OTHER_OBLAST] });
      await expect(sql(
        `INSERT INTO analytical_withdrawals(event_id,previous_status,reason,withdrawn_by,mode)
         VALUES ($1,'observed','достатньо довга причина','   ','operator')`, [id]
      )).rejects.toThrow();
      await expect(sql(
        `INSERT INTO analytical_withdrawals(event_id,previous_status,reason,withdrawn_by,mode)
         VALUES ($1,'observed','достатньо довга причина','operator','because_i_said')`, [id]
      )).rejects.toThrow();
    });

    it('records one decision per event', async () => {
      // `withdrawn` is terminal, so a second row would read as a second decision that never happened
      // — a double-clicked button or a retried request.
      const id = await seedThreatEvent({ locationIds: [OTHER_OBLAST] });
      await sql(
        `INSERT INTO analytical_withdrawals(event_id,previous_status,reason,withdrawn_by,mode)
         VALUES ($1,'observed','достатньо довга причина','operator','operator')`, [id]
      );
      await expect(sql(
        `INSERT INTO analytical_withdrawals(event_id,previous_status,reason,withdrawn_by,mode)
         VALUES ($1,'observed','ще одна довга причина','operator','operator')`, [id]
      )).rejects.toThrow();
    });
  });

  describe('withdrawAnalyticalEvent', () => {
    it('ends a model event and leaves the trail three consumers read', async () => {
      const { withdrawAnalyticalEvent } = await import('../../src/repositories/events.js');
      const promoted = await ingest({ model: true });

      const result = await withdrawAnalyticalEvent(promoted.id, {
        reason: 'модель прочитала ретроспективу як живу загрозу', withdrawnBy: 'operator'
      });

      expect(result.outcome).toBe('withdrawn');
      const row = await eventRow(promoted.id);
      expect(row.status).toBe('withdrawn');
      expect(row.ended_at).not.toBeNull();
      // State and evidence are different axes: taking a claim back does not change how well
      // corroborated it was while it stood.
      expect(row.evidence_level).toBe('unverified');

      const audit = await sql<{ reason: string; withdrawn_by: string; mode: string; previous_status: string }>(
        `SELECT reason,withdrawn_by,mode,previous_status FROM analytical_withdrawals WHERE event_id=$1`,
        [promoted.id]
      );
      expect(audit.rows[0]).toMatchObject({
        withdrawn_by: 'operator', mode: 'operator', previous_status: 'observed'
      });

      expect(await count('event_updates', `event_id=$1 AND new_status='withdrawn'`, [promoted.id])).toBe(1);
      // THE SEAM. Without this row the map keeps drawing the pin until the next full snapshot.
      const logged = await sql<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM system_event_log WHERE event_type='threat.withdrawn'`
      );
      expect(logged.rows).toHaveLength(1);
      expect(logged.rows[0]!.payload).toEqual({
        eventId: promoted.id, reason: 'operator_withdrew_analytical_event'
      });
    });

    /**
     * THE test. A deterministic event is what every human report and every official mirror is, so
     * this one case stands for "the operator button cannot reach anything a person wrote" — and it
     * is asserted against a real UPDATE rather than against a branch in TypeScript.
     */
    it('cannot reach a deterministic event even when handed its id', async () => {
      const { withdrawAnalyticalEvent } = await import('../../src/repositories/events.js');
      const ordinary = await ingest();
      const before = await eventRow(ordinary.id);
      const versionBefore = await count('system_event_log');

      const result = await withdrawAnalyticalEvent(ordinary.id, {
        reason: 'спроба відкликати людську подію', withdrawnBy: 'operator'
      });

      expect(result.outcome).toBe('not_model');
      expect(await eventRow(ordinary.id)).toEqual(before);
      expect(await count('analytical_withdrawals')).toBe(0);
      expect(await count('event_updates', `event_id=$1 AND new_status='withdrawn'`, [ordinary.id])).toBe(0);
      // No SSE frame either: a refusal that still announced something would have removed the pin
      // from every open map while the row stayed live.
      expect(await count('system_event_log')).toBe(versionBefore);
    });

    it('leaves the official tables untouched', async () => {
      const { withdrawAnalyticalEvent } = await import('../../src/repositories/events.js');
      await seedOfficialAlert();
      const promoted = await ingest({ model: true });
      const before = await officialSnapshot();

      await withdrawAnalyticalEvent(promoted.id, {
        reason: 'прибрано оператором під час активної офіційної тривоги', withdrawnBy: 'operator'
      });

      expect(await officialSnapshot()).toBe(before);
    });

    /**
     * The source's own assertion rows are a HUMAN channel's statements — the model only classified
     * the message. Removing the model's reading of a post does not make the post unsaid, and the
     * event cannot come back regardless: the merge lookup in `ingestThreat` matches live statuses
     * only, so a later message opens a new event instead of reviving this one.
     */
    it('leaves the source assertions standing', async () => {
      const { withdrawAnalyticalEvent } = await import('../../src/repositories/events.js');
      const promoted = await ingest({ model: true });
      const before = await count('threat_assertions', `event_id=$1 AND withdrawn_at IS NULL`, [promoted.id]);
      expect(before).toBeGreaterThan(0);

      await withdrawAnalyticalEvent(promoted.id, {
        reason: 'помилкова аналітична подія', withdrawnBy: 'operator'
      });

      expect(await count('threat_assertions', `event_id=$1 AND withdrawn_at IS NULL`, [promoted.id])).toBe(before);
    });

    it('refuses a second withdrawal of the same event', async () => {
      const { withdrawAnalyticalEvent } = await import('../../src/repositories/events.js');
      const promoted = await ingest({ model: true });
      await withdrawAnalyticalEvent(promoted.id, { reason: 'перше відкликання', withdrawnBy: 'operator' });

      const again = await withdrawAnalyticalEvent(promoted.id, {
        reason: 'друге відкликання', withdrawnBy: 'operator'
      });

      expect(again.outcome).toBe('not_live');
      expect(await count('analytical_withdrawals')).toBe(1);
    });

    it('disappears from the public map once it is withdrawn', async () => {
      const { withdrawAnalyticalEvent } = await import('../../src/repositories/events.js');
      const promoted = await ingest({ model: true });
      const live = await (await fetch(`${baseUrl}/api/v1/threats`)).json();
      expect(live.some((item: { id: string }) => item.id === promoted.id)).toBe(true);

      await withdrawAnalyticalEvent(promoted.id, { reason: 'прибрано з карти', withdrawnBy: 'operator' });

      const after = await (await fetch(`${baseUrl}/api/v1/threats`)).json();
      expect(after.some((item: { id: string }) => item.id === promoted.id)).toBe(false);
    });
  });

  describe('POST /ops/analytical-threats/:eventId/withdraw', () => {
    const withdraw = (id: string, body: unknown, authorization = OPS) => fetch(
      `${baseUrl}/ops/analytical-threats/${id}/withdraw`,
      { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body) }
    );

    it('is closed to anonymous callers', async () => {
      const promoted = await ingest({ model: true });
      const response = await withdraw(promoted.id, { reason: 'без авторизації' }, 'Basic bm9wZTpub3Bl');
      expect(response.status).toBe(401);
      expect((await eventRow(promoted.id)).status).toBe('observed');
    });

    it('refuses a reason too short to be a reason', async () => {
      const promoted = await ingest({ model: true });
      const response = await withdraw(promoted.id, { reason: 'ні' });
      expect(response.status).toBe(400);
      expect(await count('analytical_withdrawals')).toBe(0);
    });

    it('answers 409 for a deterministic event and says why', async () => {
      const ordinary = await ingest();
      const response = await withdraw(ordinary.id, { reason: 'спроба через ops-роут' });
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe('not_a_model_event');
      expect(body.origin).toBe('deterministic');
      expect((await eventRow(ordinary.id)).status).toBe('observed');
    });

    it('answers 404 for an id that does not exist', async () => {
      const response = await withdraw(UNKNOWN_EVENT, { reason: 'неіснуючий ідентифікатор' });
      expect(response.status).toBe(404);
    });

    it('withdraws a model event and names the operator in the audit', async () => {
      const promoted = await ingest({ model: true });

      const response = await withdraw(promoted.id, { reason: 'очевидно хибна аналітична подія' });

      expect(response.status).toBe(200);
      expect((await response.json()).withdrawn).toBe(true);
      const audit = await sql<{ withdrawn_by: string; mode: string }>(
        `SELECT withdrawn_by,mode FROM analytical_withdrawals WHERE event_id=$1`, [promoted.id]
      );
      // The name comes from the verified Basic credentials, never from the body.
      expect(audit.rows[0]).toEqual({ withdrawn_by: 'operator', mode: 'operator' });
    });
  });

  describe('withdrawUnconfirmedAnalyticalEvents', () => {
    /** Ages an event past the sweep threshold; `created_at` is the clock the sweep reads. */
    async function backdate(id: string, minutes: number): Promise<void> {
      await sql(
        `UPDATE threat_events SET created_at=now()-($2::text || ' minutes')::interval WHERE id=$1`,
        [id, String(minutes)]
      );
    }

    it('does nothing while the threshold is zero', async () => {
      const { withdrawUnconfirmedAnalyticalEvents } = await import('../../src/repositories/events.js');
      const promoted = await ingest({ model: true });
      await backdate(promoted.id, 60);

      expect(await withdrawUnconfirmedAnalyticalEvents(0)).toEqual([]);
      expect((await eventRow(promoted.id)).status).toBe('observed');
    });

    it('closes a model event that stood its time with nothing corroborating it', async () => {
      const { withdrawUnconfirmedAnalyticalEvents } = await import('../../src/repositories/events.js');
      const promoted = await ingest({ model: true });
      await backdate(promoted.id, 20);

      const results = await withdrawUnconfirmedAnalyticalEvents(10);

      expect(results.map((result) => result.outcome)).toEqual(['withdrawn']);
      expect((await eventRow(promoted.id)).status).toBe('withdrawn');
      const audit = await sql<{ withdrawn_by: string; mode: string }>(
        `SELECT withdrawn_by,mode FROM analytical_withdrawals WHERE event_id=$1`, [promoted.id]
      );
      expect(audit.rows[0]).toEqual({ withdrawn_by: 'system', mode: 'auto_unconfirmed' });
    });

    it('spares a model event a deterministic message has since corroborated', async () => {
      const { withdrawUnconfirmedAnalyticalEvents } = await import('../../src/repositories/events.js');
      const promoted = await ingest({ model: true });
      // The same place and class inside the merge window: `ingestThreat` attaches this message to the
      // model's event with a non-`model:` evidence role, which IS corroboration.
      const merged = await ingest();
      expect(merged.id).toBe(promoted.id);
      await backdate(promoted.id, 20);

      expect(await withdrawUnconfirmedAnalyticalEvents(10)).toEqual([]);
      expect((await eventRow(promoted.id)).status).toBe('observed');
    });

    it('never selects a deterministic event, however long it has stood', async () => {
      const { withdrawUnconfirmedAnalyticalEvents } = await import('../../src/repositories/events.js');
      const ordinary = await ingest();
      await backdate(ordinary.id, 25);

      expect(await withdrawUnconfirmedAnalyticalEvents(5)).toEqual([]);
      expect((await eventRow(ordinary.id)).status).toBe('observed');
    });

    it('leaves a young model event alone', async () => {
      const { withdrawUnconfirmedAnalyticalEvents } = await import('../../src/repositories/events.js');
      const promoted = await ingest({ model: true });

      expect(await withdrawUnconfirmedAnalyticalEvents(10)).toEqual([]);
      expect((await eventRow(promoted.id)).status).toBe('observed');
    });

    it('leaves the official tables untouched', async () => {
      const { withdrawUnconfirmedAnalyticalEvents } = await import('../../src/repositories/events.js');
      await seedOfficialAlert();
      const promoted = await ingest({ model: true });
      await backdate(promoted.id, 20);
      const before = await officialSnapshot();

      await withdrawUnconfirmedAnalyticalEvents(10);

      expect((await eventRow(promoted.id)).status).toBe('withdrawn');
      expect(await officialSnapshot()).toBe(before);
    });
  });
});
