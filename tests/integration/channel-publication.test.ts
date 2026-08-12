import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OBLAST, OTHER_OBLAST, appendSystemEvent, count, ensureMigrated, fakeBot,
  integrationDatabaseAvailable, resetDatabase, runDelivery, runFanout, seedSubscription,
  seedThreatEvent, seedUser, sql
} from '../helpers/db.js';
import { config } from '../../src/config.js';
import { telegramDeliveryGovernorStatus } from '../../src/bot/delivery-governor.js';

/**
 * Publication to the project's own Telegram channel (migration 044, `src/bot/outbox.ts`).
 *
 * The guarantee this file exists for is the one that cannot be proved against a pure function: **one
 * event, one post**. Every other deduplication in this worker is per chat and per event-log version
 * — `notification_state` is keyed by `chat_id` and `idempotency_key` carries the version, so a live
 * threat legitimately produces a second message when it escalates. A channel must not: a reader
 * seeing the same estimate twice reads two threats. The rule is enforced by the primary key on
 * `channel_published_events(channel_id, event_id)` inside the fan-out's data-modifying CTE, so it
 * has to be exercised against the real statement, the real fan-out cursor and a real replay.
 *
 * The negative cases carry the same weight as the positive one. Nothing but `origin='model'` may go
 * out through this path — an official alert reaching a channel whose every post begins «Оцінка
 * моделі. Не підтверджено джерелом» would be the CONTEXT.md ordering inverted in the one place a
 * reader applies it.
 */

const ERADAR = 'osint-eradar';
const CHANNEL_CHAT_ID = -1001234567890;

let sequence = 0;

async function seedChannel(options: { enabled?: boolean; chatId?: number } = {}): Promise<string> {
  const row = await sql<{ id: string }>(
    `INSERT INTO publication_channels(chat_id,title,enabled) VALUES ($1,$2,$3) RETURNING id`,
    [options.chatId ?? CHANNEL_CHAT_ID, 'ThreatLens UA — аналітика', options.enabled ?? true]
  );
  return row.rows[0]!.id;
}

/** A promoted model verdict, through the writer that actually promotes one. */
async function ingestModelEvent(locationId = OBLAST): Promise<string> {
  const { ingestThreat } = await import('../../src/repositories/events.js');
  sequence += 1;
  const event = await ingestThreat(
    {
      sourceId: ERADAR, externalId: `channel-${sequence}`, publishedAt: new Date(),
      text: 'Шахед курсом на Полтавщину.',
      rawPayload: { channel: ERADAR, analyticalThreat: { model: 'test-model', confidence: 0.94 } }
    },
    {
      intent: 'threat', threatType: 'uav', signalThreatTypes: ['uav'],
      locations: [{ id: locationId, name: 'Полтавська область', relationType: 'explicit_threat' }],
      nationalScope: false, indicators: ['model_analytical_threat'],
      title: 'Аналітична загроза: Полтавська область',
      summary: 'Неперевірена оцінка моделі щодо ударних БпЛА для Полтавської області.'
    },
    { modelPromotion: { model: 'test-model', confidence: 0.94 } }
  );
  return event.id;
}

async function channelRows(): Promise<Array<Record<string, any>>> {
  const rows = await sql(
    `SELECT * FROM notification_outbox WHERE notification_type='channel_publication'
     ORDER BY created_at,id`
  );
  return rows.rows as Array<Record<string, any>>;
}

describe.skipIf(!integrationDatabaseAvailable)('publication to the Telegram channel', () => {
  beforeAll(ensureMigrated);

  beforeEach(async () => {
    await resetDatabase();
    // The deployment-level switch ships off (src/config.ts). Every case here that expects a post has
    // to turn it on explicitly, and the two cases that expect silence turn it back off.
    config.PUBLICATION_CHANNEL_ENABLED = true;
  });

  afterEach(() => { config.PUBLICATION_CHANNEL_ENABLED = false; });

  describe('one event, one post', () => {
    it('queues exactly one message per enabled channel for a model event', async () => {
      const channelId = await seedChannel();
      const eventId = await ingestModelEvent();

      await runFanout();

      const rows = await channelRows();
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.chat_id)).toBe(CHANNEL_CHAT_ID);
      expect(rows[0]!.publication_channel_id).toBe(channelId);
      expect(rows[0]!.event_id).toBe(eventId);
      // Below the soft threat update (4), and therefore below the `disable_notification` threshold
      // the delivery worker applies at 3: a model estimate must not buzz a channel audience.
      expect(Number(rows[0]!.priority)).toBe(5);

      const claim = await sql<{ outbox_id: string }>(
        `SELECT outbox_id FROM channel_published_events WHERE channel_id=$1 AND event_id=$2`,
        [channelId, eventId]
      );
      expect(claim.rows[0]!.outbox_id).toBe(rows[0]!.id);
    });

    it('does not publish the same event again when the event log moves', async () => {
      // A live threat re-emits `threat.updated` on every message that lands on it. Subscribers may
      // get a delta out of that; the channel gets nothing, because the event is the unit.
      await seedChannel();
      const eventId = await ingestModelEvent();
      await runFanout();

      await appendSystemEvent('threat.updated', { eventId });
      await appendSystemEvent('threat.updated', { eventId });
      await runFanout();

      expect(await channelRows()).toHaveLength(1);
      expect(await count('channel_published_events')).toBe(1);
    });

    it('does not publish it again after the fan-out cursor is replayed from zero', async () => {
      // The crash case: the worker advanced its cursor but the process died before anything was
      // sent, and the whole window is read a second time. `idempotency_key` alone would not save
      // this if the version differed; the claim is what does.
      await seedChannel();
      await ingestModelEvent();
      await runFanout();

      await sql(`UPDATE worker_state SET cursor_value=0 WHERE worker_name='notification-fanout'`);
      await runFanout();

      expect(await channelRows()).toHaveLength(1);
    });

    it('publishes one message to each enabled channel and none to a disabled one', async () => {
      const enabled = await seedChannel({ chatId: -1001111111111 });
      const alsoEnabled = await seedChannel({ chatId: -1002222222222 });
      await seedChannel({ chatId: -1003333333333, enabled: false });
      await ingestModelEvent();

      await runFanout();

      const rows = await channelRows();
      expect(rows.map((row) => row.publication_channel_id).sort())
        .toEqual([enabled, alsoEnabled].sort());
    });
  });

  describe('what may never reach the channel', () => {
    it('never publishes a deterministic threat event', async () => {
      // The residue of what the rules refused is what this channel carries. An event the rules
      // themselves produced is an ordinary warning, and it reaches people through their own
      // subscriptions, filtered by the territory and the evidence threshold they chose.
      await seedChannel();
      await seedUser(7701);
      await seedSubscription({ chatId: 7701, locationId: OBLAST, minimumEvidenceLevel: 'unverified' });
      const eventId = await seedThreatEvent({ locationIds: [OBLAST] });
      await appendSystemEvent('threat.created', { eventId });

      await runFanout();

      expect(await channelRows()).toHaveLength(0);
      // …and the subscriber path is untouched by any of this.
      expect(await count('notification_outbox', `chat_id=7701`)).toBe(1);
    });

    it('never publishes an official alert', async () => {
      await seedChannel();
      const alert = await sql<{ id: string }>(
        `INSERT INTO alert_periods(location_id,alert_type,status,started_at)
         VALUES ($1,'air_raid','active',now()) RETURNING id`, [OBLAST]
      );
      await appendSystemEvent('alert.started', { alertId: alert.rows[0]!.id, locationId: OBLAST });

      await runFanout();

      expect(await channelRows()).toHaveLength(0);
    });

    it('stops publishing a model event once a human source corroborates it', async () => {
      // `origin` stays `model` after a merge while `evidence_level` rises (migration 041). At that
      // point the format — which opens by calling itself an unconfirmed model estimate — would be
      // describing the event incorrectly, so it is not published rather than published wrongly.
      await seedChannel();
      const eventId = await ingestModelEvent(OTHER_OBLAST);
      await sql(`UPDATE threat_events SET evidence_level='monitoring' WHERE id=$1`, [eventId]);
      await appendSystemEvent('threat.updated', { eventId });

      await runFanout();

      expect(await channelRows()).toHaveLength(0);
    });

    it('publishes nothing at all while the deployment switch is off', async () => {
      config.PUBLICATION_CHANNEL_ENABLED = false;
      await seedChannel();
      await ingestModelEvent();

      await runFanout();

      expect(await channelRows()).toHaveLength(0);
      expect(await count('channel_published_events')).toBe(0);
    });

    it('publishes nothing when no channel exists, which is every installation by default', async () => {
      await ingestModelEvent();
      await runFanout();
      expect(await channelRows()).toHaveLength(0);
    });
  });

  describe('delivery', () => {
    it('sends the post, records the message id and keeps its own delivery class', async () => {
      const channelId = await seedChannel();
      const eventId = await ingestModelEvent();
      await runFanout();

      // The class the governor's SQL assigns, read before the row is drained.
      const status = await telegramDeliveryGovernorStatus() as { backlog: Array<{ notification_class: string }> };
      expect(status.backlog.map((row) => row.notification_class)).toContain('channel');

      const stub = fakeBot();
      await runDelivery(stub, async () => stub.calls.length > 0, 'the channel post to be sent');

      expect(stub.calls[0]!.chatId).toBe(String(CHANNEL_CHAT_ID));
      expect(stub.calls[0]!.text).toContain('Оцінка моделі. Не підтверджено джерелом.');
      expect(stub.calls[0]!.options.disable_notification).toBe(true);

      const claim = await sql<{ telegram_message_id: string; published_at: Date | null }>(
        `SELECT telegram_message_id,published_at FROM channel_published_events
         WHERE channel_id=$1 AND event_id=$2`, [channelId, eventId]
      );
      expect(Number(claim.rows[0]!.telegram_message_id)).toBeGreaterThan(0);
      expect(claim.rows[0]!.published_at).not.toBeNull();
    });

    it('disables the channel when Telegram says the bot may no longer post there', async () => {
      // 403 for a channel is the bot losing its administrator rights. Leaving the row enabled would
      // turn every later promotion into another failed post nobody reads.
      const channelId = await seedChannel();
      await ingestModelEvent();
      await runFanout();

      const stub = fakeBot(() => {
        throw Object.assign(new Error('forbidden'), { error_code: 403 });
      });
      await runDelivery(
        stub,
        async () => (await count('notification_outbox', `status='failed'`)) > 0,
        'the channel post to fail'
      );

      const channel = await sql<{ enabled: boolean }>(
        `SELECT enabled FROM publication_channels WHERE id=$1`, [channelId]
      );
      expect(channel.rows[0]!.enabled).toBe(false);
    });
  });

  describe('the foreign key migration 044 replaced', () => {
    it('still empties a deleted user\'s queue, and leaves channel rows alone', async () => {
      // `notification_outbox.chat_id` stopped being an FK to `telegram_users` so that a channel
      // could be addressed at all; `/delete_me` promises «черга повідомлень … видалені», and the
      // trigger in migration 044 is what keeps that promise. A queued message that outlived the
      // account would still be DELIVERED to it.
      await seedChannel();
      await seedUser(7702);
      await seedSubscription({ chatId: 7702, locationId: OBLAST, minimumEvidenceLevel: 'unverified' });
      await ingestModelEvent();
      await runFanout();

      expect(await count('notification_outbox', `chat_id=7702`)).toBe(1);

      await sql(`DELETE FROM telegram_users WHERE chat_id=7702`);

      expect(await count('notification_outbox', `chat_id=7702`)).toBe(0);
      expect(await channelRows()).toHaveLength(1);
    });
  });
});
