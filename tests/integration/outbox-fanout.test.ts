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

    it('matches exactly one level of hierarchy, never a grandparent', async () => {
      // Pins a real constraint of the query: it compares `parent_id` directly, so it walks one edge
      // and no further. The shipped catalogue is exactly two levels deep (oblast -> city, KATOTTG
      // imports attach cities straight to their oblast), so this is sufficient today — but a future
      // raion or hromada tier inserted between oblast and city would silently break oblast
      // subscribers, and this test is what would catch it.
      await sql(
        `INSERT INTO locations(id,parent_id,type,name_uk) VALUES
           ('test-oblast',NULL,'oblast','Тест-область'),
           ('test-raion','test-oblast','raion','Тест-район'),
           ('test-city','test-raion','city','Тест-місто')`
      );
      await seedUser(9005);
      await seedUser(9006);
      await seedSubscription({ chatId: 9005, locationId: 'test-oblast' });
      await seedSubscription({ chatId: 9006, locationId: 'test-raion' });
      const eventId = await seedThreatEvent({ locationIds: ['test-city'] });
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      expect(await chatsNotified()).toEqual([9006]);
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
        `${eventId}:9503:threat_update:${firstVersion}`,
        `${eventId}:9503:threat_update:${secondVersion}`
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

  describe('payload', () => {
    it('carries the resolved location name and a deep link into the outbox payload', async () => {
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
        mapUrl: `http://localhost:3000/?event=${eventId}`
      });
    });
  });
});
