import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CITY_IN_OBLAST, OBLAST, OTHER_OBLAST,
  appendSystemEvent, count, ensureMigrated, integrationDatabaseAvailable,
  resetDatabase, runFanout, seedSubscription, seedThreatEvent, seedUser, sql
} from '../helpers/db.js';

/**
 * Covers the eight-parameter fanout query in `src/bot/outbox.ts`.
 *
 * The query is driven through the exported `startNotificationWorkers` entry point rather than a
 * copy of the SQL, so what is asserted here is the statement that actually runs in production.
 */

async function chatsNotifiedFor(eventId: string): Promise<number[]> {
  const rows = await sql<{ chat_id: string }>(
    `SELECT chat_id FROM notification_outbox WHERE event_id=$1 ORDER BY chat_id`, [eventId]
  );
  return rows.rows.map((row) => Number(row.chat_id));
}

async function chatsNotified(): Promise<number[]> {
  const rows = await sql<{ chat_id: string }>(`SELECT chat_id FROM notification_outbox ORDER BY chat_id`);
  return rows.rows.map((row) => Number(row.chat_id));
}

interface Branch { oblast: string; raion: string; city: string }

/**
 * A synthetic `oblast -> raion -> city` branch: the shape the catalogue takes once raions are
 * imported from KATOTTG, where oblast and city are two `parent_id` edges apart.
 *
 * Ids are prefixed `test-` because `resetDatabase` clears exactly that prefix from `locations`;
 * reference rows seeded by the migrations are left alone.
 */
async function seedBranch(name: string): Promise<Branch> {
  const branch: Branch = { oblast: `test-${name}-oblast`, raion: `test-${name}-raion`, city: `test-${name}-city` };
  await sql(
    `INSERT INTO locations(id,parent_id,type,name_uk) VALUES
       ($1,NULL,'oblast',$1),($2,$1,'raion',$2),($3,$2,'city',$3)`,
    [branch.oblast, branch.raion, branch.city]
  );
  return branch;
}

describe.skipIf(!integrationDatabaseAvailable)('subscription fanout', () => {
  beforeAll(ensureMigrated);
  beforeEach(resetDatabase);

  describe('bidirectional location hierarchy', () => {
    it('delivers a city-level threat to a subscriber of the parent oblast', async () => {
      await seedUser(9001);
      await seedSubscription({ chatId: 9001, locationId: OBLAST });
      const eventId = await seedThreatEvent({ locationIds: [CITY_IN_OBLAST] });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      expect(await chatsNotifiedFor(eventId)).toEqual([9001]);
    });

    it('delivers an oblast-level threat to a subscriber of a city inside it', async () => {
      await seedUser(9002);
      await seedSubscription({ chatId: 9002, locationId: CITY_IN_OBLAST });
      const eventId = await seedThreatEvent({ locationIds: [OBLAST] });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      expect(await chatsNotifiedFor(eventId)).toEqual([9002]);
    });

    it('delivers an exact-location threat without needing the hierarchy', async () => {
      await seedUser(9003);
      await seedSubscription({ chatId: 9003, locationId: CITY_IN_OBLAST });
      const eventId = await seedThreatEvent({ locationIds: [CITY_IN_OBLAST] });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      expect(await chatsNotifiedFor(eventId)).toEqual([9003]);
    });

    it('does not reach outside the subscribed branch of the hierarchy', async () => {
      await seedUser(9004);
      await seedSubscription({ chatId: 9004, locationId: OTHER_OBLAST });
      const eventId = await seedThreatEvent({ locationIds: [CITY_IN_OBLAST] });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      expect(await chatsNotified()).toEqual([]);
    });

    it('reaches every tier of an oblast -> raion -> city chain from a city event', async () => {
      // The regression this guards is silent under-delivery: with `parent_id` compared directly the
      // query walked one edge, so inserting a raion between oblast and city stopped oblast
      // subscribers from ever hearing about that city.
      const branch = await seedBranch('kyiv');
      for (const chatId of [9005, 9006, 9007]) await seedUser(chatId);
      await seedSubscription({ chatId: 9005, locationId: branch.oblast });
      await seedSubscription({ chatId: 9006, locationId: branch.raion });
      await seedSubscription({ chatId: 9007, locationId: branch.city });
      const eventId = await seedThreatEvent({ locationIds: [branch.city] });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      expect(await chatsNotifiedFor(eventId)).toEqual([9005, 9006, 9007]);
    });

    it('reaches every tier of an oblast -> raion -> city chain from an oblast event', async () => {
      const branch = await seedBranch('kyiv');
      for (const chatId of [9008, 9009, 9010]) await seedUser(chatId);
      await seedSubscription({ chatId: 9008, locationId: branch.oblast });
      await seedSubscription({ chatId: 9009, locationId: branch.raion });
      await seedSubscription({ chatId: 9010, locationId: branch.city });
      const eventId = await seedThreatEvent({ locationIds: [branch.oblast] });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      expect(await chatsNotifiedFor(eventId)).toEqual([9008, 9009, 9010]);
    });

    it('delivers a raion event both up to the oblast and down to the city', async () => {
      const branch = await seedBranch('kyiv');
      for (const chatId of [9011, 9012]) await seedUser(chatId);
      await seedSubscription({ chatId: 9011, locationId: branch.oblast });
      await seedSubscription({ chatId: 9012, locationId: branch.city });
      const eventId = await seedThreatEvent({ locationIds: [branch.raion] });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      expect(await chatsNotifiedFor(eventId)).toEqual([9011, 9012]);
    });

    it('does not leak into a sibling branch of the same depth', async () => {
      const subscribed = await seedBranch('kyiv');
      const other = await seedBranch('lviv');
      for (const chatId of [9013, 9014, 9015]) await seedUser(chatId);
      await seedSubscription({ chatId: 9013, locationId: other.oblast });
      await seedSubscription({ chatId: 9014, locationId: other.raion });
      await seedSubscription({ chatId: 9015, locationId: other.city });
      const eventId = await seedThreatEvent({ locationIds: [subscribed.city] });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      expect(await chatsNotified()).toEqual([]);
    });

    it('does not leak sideways between two raions of the same oblast', async () => {
      const branch = await seedBranch('kyiv');
      await sql(
        `INSERT INTO locations(id,parent_id,type,name_uk) VALUES
           ('test-kyiv-raion-2',$1,'raion','test-kyiv-raion-2'),
           ('test-kyiv-city-2','test-kyiv-raion-2','city','test-kyiv-city-2')`,
        [branch.oblast]
      );
      await seedUser(9016);
      await seedSubscription({ chatId: 9016, locationId: 'test-kyiv-raion-2' });
      const eventId = await seedThreatEvent({ locationIds: [branch.city] });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      expect(await chatsNotified()).toEqual([]);
    });

    it('emits exactly one notification for a chat subscribed to all three tiers of one chain', async () => {
      // Three matching subscription rows for one chat. `SELECT DISTINCT` collapses them before the
      // insert and `ON CONFLICT (idempotency_key) DO NOTHING` is the second line of defence, so the
      // subscriber is told about the raid once rather than three times.
      const branch = await seedBranch('kyiv');
      await seedUser(9017);
      await seedSubscription({ chatId: 9017, locationId: branch.oblast, threatType: '*' });
      await seedSubscription({ chatId: 9017, locationId: branch.raion, threatType: '*' });
      await seedSubscription({ chatId: 9017, locationId: branch.city, threatType: '*' });
      const eventId = await seedThreatEvent({ locationIds: [branch.city] });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      expect(await chatsNotifiedFor(eventId)).toEqual([9017]);
      expect(await count('notification_outbox')).toBe(1);
    });

    it('emits exactly one notification when the event is attached to all three tiers at once', async () => {
      const branch = await seedBranch('kyiv');
      await seedUser(9018);
      await seedSubscription({ chatId: 9018, locationId: branch.raion });
      const eventId = await seedThreatEvent({ locationIds: [branch.oblast, branch.raion, branch.city] });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      expect(await chatsNotifiedFor(eventId)).toEqual([9018]);
      expect(await count('notification_outbox')).toBe(1);
    });

    it('terminates and still delivers when parent_id contains a cycle', async () => {
      // KATOTTG is an external feed, so `parent_id` is not trusted to be acyclic. The walk carries
      // its visited path and is depth-capped, so a cycle costs a bounded amount of work instead of
      // spinning the fanout worker forever.
      const branch = await seedBranch('kyiv');
      await sql(`UPDATE locations SET parent_id=$1 WHERE id=$2`, [branch.city, branch.oblast]);
      for (const chatId of [9019, 9020]) await seedUser(chatId);
      await seedSubscription({ chatId: 9019, locationId: branch.oblast });
      await seedSubscription({ chatId: 9020, locationId: branch.city });
      const eventId = await seedThreatEvent({ locationIds: [branch.raion] });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      expect(await chatsNotifiedFor(eventId)).toEqual([9019, 9020]);
    });

    it('emits exactly one notification when a chat subscribes to both the oblast and the city', async () => {
      await seedUser(9006);
      await seedSubscription({ chatId: 9006, locationId: OBLAST });
      await seedSubscription({ chatId: 9006, locationId: CITY_IN_OBLAST });
      const eventId = await seedThreatEvent({ locationIds: [CITY_IN_OBLAST] });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      expect(await chatsNotifiedFor(eventId)).toEqual([9006]);
    });

    it('emits exactly one notification when one event is attached to several matching locations', async () => {
      await seedUser(9007);
      await seedSubscription({ chatId: 9007, locationId: OBLAST });
      const eventId = await seedThreatEvent({ locationIds: [OBLAST, CITY_IN_OBLAST] });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      expect(await chatsNotifiedFor(eventId)).toEqual([9007]);
    });
  });

  describe('minimum evidence level', () => {
    const thresholds: Array<[number, string]> = [
      [9110, 'official'], [9111, 'confirmed'], [9112, 'monitoring'], [9113, 'unverified']
    ];

    it('drops events weaker than the subscribed threshold and keeps the rest', async () => {
      for (const [chatId, level] of thresholds) {
        await seedUser(chatId);
        await seedSubscription({ chatId, locationId: OBLAST, minimumEvidenceLevel: level });
      }
      const eventId = await seedThreatEvent({ locationIds: [OBLAST], evidenceLevel: 'confirmed' });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      // 'confirmed' ranks 2: it clears confirmed/monitoring/unverified but not official.
      expect(await chatsNotifiedFor(eventId)).toEqual([9111, 9112, 9113]);
    });

    it('lets an official event through every threshold', async () => {
      for (const [chatId, level] of thresholds) {
        await seedUser(chatId);
        await seedSubscription({ chatId, locationId: OBLAST, minimumEvidenceLevel: level });
      }
      const eventId = await seedThreatEvent({ locationIds: [OBLAST], evidenceLevel: 'official' });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      expect(await chatsNotifiedFor(eventId)).toEqual([9110, 9111, 9112, 9113]);
    });

    it('drops an unverified event for every threshold above the floor', async () => {
      for (const [chatId, level] of thresholds) {
        await seedUser(chatId);
        await seedSubscription({ chatId, locationId: OBLAST, minimumEvidenceLevel: level });
      }
      const eventId = await seedThreatEvent({ locationIds: [OBLAST], evidenceLevel: 'unverified' });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      expect(await chatsNotifiedFor(eventId)).toEqual([9113]);
    });
  });

  describe('threat type filter', () => {
    it("matches the wildcard '*' and the exact type, and drops everything else", async () => {
      await seedUser(9201);
      await seedUser(9202);
      await seedUser(9203);
      await seedSubscription({ chatId: 9201, locationId: OBLAST, threatType: '*' });
      await seedSubscription({ chatId: 9202, locationId: OBLAST, threatType: 'uav' });
      await seedSubscription({ chatId: 9203, locationId: OBLAST, threatType: 'ballistic_missile' });
      const eventId = await seedThreatEvent({ locationIds: [OBLAST], threatType: 'uav' });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      expect(await chatsNotifiedFor(eventId)).toEqual([9201, 9202]);
    });
  });

  describe('opt-out switches', () => {
    it('skips a disabled telegram user even when the subscription is enabled', async () => {
      await seedUser(9301, false);
      await seedSubscription({ chatId: 9301, locationId: OBLAST, enabled: true });
      await seedUser(9302, true);
      await seedSubscription({ chatId: 9302, locationId: OBLAST, enabled: true });
      const eventId = await seedThreatEvent({ locationIds: [OBLAST] });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      expect(await chatsNotifiedFor(eventId)).toEqual([9302]);
    });

    it('skips a disabled subscription of an enabled user', async () => {
      await seedUser(9303);
      await seedSubscription({ chatId: 9303, locationId: OBLAST, enabled: false });
      const eventId = await seedThreatEvent({ locationIds: [OBLAST] });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      expect(await chatsNotified()).toEqual([]);
    });

    it('honours notify_threats independently of the alert switches', async () => {
      await seedUser(9304);
      await seedSubscription({ chatId: 9304, locationId: OBLAST, notifyThreats: false, notifyAlertStart: true });
      const eventId = await seedThreatEvent({ locationIds: [OBLAST] });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      expect(await chatsNotified()).toEqual([]);
    });
  });

  describe('alert notifications', () => {
    async function seedAlertPeriod(locationId: string): Promise<string> {
      const row = await sql<{ id: string }>(
        `INSERT INTO alert_periods(location_id,alert_type,status,started_at) VALUES ($1,'air_raid','active',now())
         RETURNING id`, [locationId]
      );
      return row.rows[0]!.id;
    }

    it('routes alert_start through the hierarchy and respects notify_alert_start', async () => {
      await seedUser(9401);
      await seedUser(9402);
      await seedSubscription({ chatId: 9401, locationId: CITY_IN_OBLAST, notifyAlertStart: true });
      await seedSubscription({ chatId: 9402, locationId: CITY_IN_OBLAST, notifyAlertStart: false });
      const alertId = await seedAlertPeriod(OBLAST);
      await appendSystemEvent('alert.started', { alertId, locationId: OBLAST });

      await runFanout();

      const rows = await sql<{ chat_id: string; notification_type: string; priority: number }>(
        `SELECT chat_id,notification_type,priority FROM notification_outbox WHERE alert_period_id=$1`, [alertId]
      );
      expect(rows.rows.map((row) => Number(row.chat_id))).toEqual([9401]);
      expect(rows.rows[0]!.notification_type).toBe('alert_start');
      expect(rows.rows[0]!.priority).toBe(0);
    });

    it('routes alert_end and respects notify_alert_end', async () => {
      await seedUser(9403);
      await seedUser(9404);
      await seedSubscription({ chatId: 9403, locationId: OBLAST, notifyAlertEnd: true });
      await seedSubscription({ chatId: 9404, locationId: OBLAST, notifyAlertEnd: false });
      const alertId = await seedAlertPeriod(CITY_IN_OBLAST);
      await appendSystemEvent('alert.ended', { alertId, locationId: CITY_IN_OBLAST });

      await runFanout();

      const rows = await sql<{ chat_id: string; notification_type: string }>(
        `SELECT chat_id,notification_type FROM notification_outbox WHERE alert_period_id=$1`, [alertId]
      );
      expect(rows.rows.map((row) => Number(row.chat_id))).toEqual([9403]);
      expect(rows.rows[0]!.notification_type).toBe('alert_end');
    });

    it('routes a raion-level air raid up to the oblast and down to the city', async () => {
      // This is the shape the official alert channel actually publishes in: raion-level periods.
      // Both neighbouring tiers have to hear about it, which is two `parent_id` edges in one case.
      const branch = await seedBranch('kyiv');
      for (const chatId of [9406, 9407, 9408]) await seedUser(chatId);
      await seedSubscription({ chatId: 9406, locationId: branch.oblast });
      await seedSubscription({ chatId: 9407, locationId: branch.raion });
      await seedSubscription({ chatId: 9408, locationId: branch.city });
      const alertId = await seedAlertPeriod(branch.raion);
      await appendSystemEvent('alert.started', { alertId, locationId: branch.raion });

      await runFanout();

      const rows = await sql<{ chat_id: string }>(
        `SELECT chat_id FROM notification_outbox WHERE alert_period_id=$1 ORDER BY chat_id`, [alertId]
      );
      expect(rows.rows.map((row) => Number(row.chat_id))).toEqual([9406, 9407, 9408]);
    });

    it('ignores the evidence threshold and threat-type filter for official alerts', async () => {
      await seedUser(9405);
      await seedSubscription({
        chatId: 9405, locationId: OBLAST, threatType: 'ballistic_missile', minimumEvidenceLevel: 'official'
      });
      const alertId = await seedAlertPeriod(OBLAST);
      await appendSystemEvent('alert.started', { alertId, locationId: OBLAST });

      await runFanout();

      expect(await chatsNotified()).toEqual([9405]);
    });
  });

  describe('idempotency', () => {
    it('does not duplicate rows when the same event version is fanned out again', async () => {
      await seedUser(9501);
      await seedUser(9502);
      await seedSubscription({ chatId: 9501, locationId: OBLAST });
      await seedSubscription({ chatId: 9502, locationId: CITY_IN_OBLAST });
      const eventId = await seedThreatEvent({ locationIds: [OBLAST] });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();
      const afterFirstPass = await count('notification_outbox');
      expect(afterFirstPass).toBe(2);

      // Replaying is exactly what a crashed worker does after restart: rewind the cursor and let
      // ON CONFLICT (idempotency_key) DO NOTHING absorb the repeat.
      await sql(`UPDATE worker_state SET cursor_value=0 WHERE worker_name='notification-fanout'`);
      await runFanout();

      expect(await count('notification_outbox')).toBe(afterFirstPass);
    });

    it('keys idempotency per chat, event and system-event version', async () => {
      // The key still carries the version — that is what keeps the outbox at-least-once. What stops
      // the second, unchanged version from reaching the subscriber is the published-state check one
      // layer above it, so only the first version produces a row here.
      await seedUser(9503);
      await seedSubscription({ chatId: 9503, locationId: OBLAST });
      const eventId = await seedThreatEvent({ locationIds: [OBLAST] });
      const firstVersion = await appendSystemEvent('threat.updated', { eventId });
      await runFanout();
      const secondVersion = await appendSystemEvent('threat.updated', { eventId });
      await runFanout();

      expect(secondVersion).toBeGreaterThan(firstVersion);
      const keys = await sql<{ idempotency_key: string }>(
        `SELECT idempotency_key FROM notification_outbox ORDER BY idempotency_key`
      );
      expect(keys.rows.map((row) => row.idempotency_key)).toEqual([
        `${eventId}:9503:threat_update:${firstVersion}`
      ]);
    });

    it('advances the worker cursor so events are not reprocessed on the next tick', async () => {
      await seedUser(9504);
      await seedSubscription({ chatId: 9504, locationId: OBLAST });
      const eventId = await seedThreatEvent({ locationIds: [OBLAST] });
      const version = await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      const state = await sql<{ cursor_value: string }>(
        `SELECT cursor_value FROM worker_state WHERE worker_name='notification-fanout'`
      );
      expect(Number(state.rows[0]!.cursor_value)).toBe(version);
    });

    it('never enqueues expired threats', async () => {
      await seedUser(9505);
      await seedSubscription({ chatId: 9505, locationId: OBLAST });
      const eventId = await seedThreatEvent({ locationIds: [OBLAST] });
      await appendSystemEvent('threat.expired', { eventId });

      await runFanout();

      expect(await chatsNotified()).toEqual([]);
    });
  });

  describe('repeat suppression', () => {
    /** What `notification_state` remembers having told one chat about one threat. */
    async function publishedState(eventId: string, chatId: number) {
      const row = await sql<{ last_evidence_level: string; telegram_message_id: string | null }>(
        `SELECT last_evidence_level,telegram_message_id FROM notification_state
         WHERE entity_kind='threat' AND entity_key=$1 AND chat_id=$2`, [eventId, chatId]
      );
      return row.rows[0] ?? null;
    }

    it('sends the first message and stays quiet on a plain re-confirmation', async () => {
      await seedUser(9701);
      await seedSubscription({ chatId: 9701, locationId: OBLAST });
      const eventId = await seedThreatEvent({ locationIds: [OBLAST] });
      await appendSystemEvent('threat.updated', { eventId });
      await runFanout();
      expect(await count('notification_outbox')).toBe(1);

      // Three more channel messages landing on the same threat, changing nothing about it.
      for (let repeat = 0; repeat < 3; repeat += 1) {
        await sql(`UPDATE threat_events SET last_observed_at=now(),summary=summary||'.' WHERE id=$1`, [eventId]);
        await appendSystemEvent('threat.updated', { eventId });
        await runFanout();
      }

      expect(await count('notification_outbox')).toBe(1);
      expect((await publishedState(eventId, 9701))!.last_evidence_level).toBe('monitoring');
    });

    it('sends again when the evidence level is raised', async () => {
      await seedUser(9702);
      await seedSubscription({ chatId: 9702, locationId: OBLAST });
      const eventId = await seedThreatEvent({ locationIds: [OBLAST], evidenceLevel: 'monitoring' });
      await appendSystemEvent('threat.updated', { eventId });
      await runFanout();

      await sql(`UPDATE threat_events SET evidence_level='confirmed' WHERE id=$1`, [eventId]);
      await appendSystemEvent('threat.updated', { eventId });
      await runFanout();

      const rows = await sql<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM notification_outbox ORDER BY created_at`
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows[0]!.payload).toMatchObject({ updateKind: 'initial' });
      expect(rows.rows[1]!.payload).toMatchObject({ updateKind: 'escalation', changes: ['evidence_raised'] });
    });

    it('queues a soft update as an edit once the validity window is extended', async () => {
      await seedUser(9703);
      await seedSubscription({ chatId: 9703, locationId: OBLAST });
      const eventId = await seedThreatEvent({ locationIds: [OBLAST] });
      await appendSystemEvent('threat.updated', { eventId });
      await runFanout();
      // Stand in for a delivery: only a message the chat can see is editable.
      await sql(
        `UPDATE notification_state SET telegram_message_id=777,delivered_at=now()
         WHERE entity_kind='threat' AND entity_key=$1 AND chat_id=9703`, [eventId]
      );

      await sql(`UPDATE threat_events SET valid_until=now()+interval '4 hours' WHERE id=$1`, [eventId]);
      await appendSystemEvent('threat.updated', { eventId });
      await runFanout();

      const rows = await sql<{ payload: Record<string, unknown>; priority: number }>(
        `SELECT payload,priority FROM notification_outbox ORDER BY created_at`
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows[1]!.payload).toMatchObject({
        updateKind: 'soft', changes: ['validity_extended'], editMessageId: 777
      });
      expect(rows.rows[1]!.priority).toBe(4);
    });

    it('keeps published state per chat, so a new subscriber still gets the full message', async () => {
      await seedUser(9704);
      await seedSubscription({ chatId: 9704, locationId: OBLAST });
      const eventId = await seedThreatEvent({ locationIds: [OBLAST] });
      await appendSystemEvent('threat.updated', { eventId });
      await runFanout();

      await seedUser(9705);
      await seedSubscription({ chatId: 9705, locationId: OBLAST });
      await appendSystemEvent('threat.updated', { eventId });
      await runFanout();

      const rows = await sql<{ chat_id: string; payload: Record<string, unknown> }>(
        `SELECT chat_id,payload FROM notification_outbox ORDER BY chat_id`
      );
      expect(rows.rows.map((row) => Number(row.chat_id))).toEqual([9704, 9705]);
      expect(rows.rows[1]!.payload).toMatchObject({ updateKind: 'initial' });
    });
  });

  describe('payload', () => {
    it('carries the resolved location name and the published-state marker into the payload', async () => {
      await seedUser(9601);
      await seedSubscription({ chatId: 9601, locationId: OBLAST });
      const eventId = await seedThreatEvent({ locationIds: [CITY_IN_OBLAST], threatType: 'uav' });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      const row = await sql<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM notification_outbox WHERE event_id=$1`, [eventId]
      );
      expect(row.rows[0]!.payload).toMatchObject({
        locationName: 'Біла Церква',
        threatType: 'uav',
        evidenceLevel: 'monitoring',
        updateKind: 'initial',
        // The delivery worker writes the Telegram message id back through this marker, which is what
        // lets the next soft update edit the message instead of pushing a new one.
        state: { kind: 'threat', key: eventId }
      });
    });

    it('names every direction a threat covers in one message rather than one message each', async () => {
      await seedUser(9602);
      await seedSubscription({ chatId: 9602, locationId: OBLAST });
      const eventId = await seedThreatEvent({ locationIds: [OBLAST, CITY_IN_OBLAST], threatType: 'uav' });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      const row = await sql<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM notification_outbox WHERE event_id=$1`, [eventId]
      );
      expect(await count('notification_outbox')).toBe(1);
      expect(String(row.rows[0]!.payload.locationName)).toContain('Київська область');
      expect(String(row.rows[0]!.payload.locationName)).toContain('Біла Церква');
    });
  });
});
