import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Registry } from 'prom-client';
import {
  OBLAST, ensureMigrated, fakeBot, integrationDatabaseAvailable,
  resetDatabase, runDelivery, seedThreatEvent, seedUser, sql
} from '../helpers/db.js';
import { config } from '../../src/config.js';
import {
  claimDeliveryBatch, deliveryClass, registerDeliveryGovernorMetrics, telegramDeliveryGovernorStatus
} from '../../src/bot/delivery-governor.js';

/**
 * Covers `reclaimStuckSending` and the delivery state machine in `src/bot/outbox.ts`.
 *
 * Both are module-private, so they are driven through `startNotificationWorkers`, which calls
 * `reclaimStuckSending()` as the first statement of every `deliverBatch` pass.
 */

const RECLAIM_THRESHOLD_SECONDS = 300;
const MAX_ATTEMPTS = 8;

interface OutboxSeed {
  chatId: number;
  eventId: string;
  status: string;
  attempts: number;
  /** How long ago `updated_at` was set, in seconds. */
  updatedSecondsAgo?: number;
  priority?: number;
  payload?: Record<string, unknown>;
}

let seedCounter = 0;

async function seedOutbox(seed: OutboxSeed): Promise<string> {
  seedCounter += 1;
  const row = await sql<{ id: string }>(
    `INSERT INTO notification_outbox(event_id,chat_id,notification_type,idempotency_key,priority,payload,
       status,attempts,next_attempt_at,created_at,updated_at)
     VALUES ($1,$2,'threat_update',$3,$4,$5,$6,$7,
       now()-($8||' seconds')::interval, now()-($8||' seconds')::interval, now()-($8||' seconds')::interval)
     RETURNING id`,
    [
      seed.eventId, seed.chatId, `${seed.eventId}:${seed.chatId}:threat_update:${seedCounter}`,
      seed.priority ?? 3,
      JSON.stringify(seed.payload
        ?? { locationName: 'Київська область', threatType: 'uav', evidenceLevel: 'monitoring', summary: 's' }),
      seed.status, seed.attempts, String(seed.updatedSecondsAgo ?? 0)
    ]
  );
  return row.rows[0]!.id;
}

async function statusOf(id: string): Promise<{ status: string; attempts: number }> {
  const row = await sql<{ status: string; attempts: number }>(
    `SELECT status,attempts FROM notification_outbox WHERE id=$1`, [id]
  );
  return { status: row.rows[0]!.status, attempts: Number(row.rows[0]!.attempts) };
}

/** Telegram-shaped rejection, matching what grammy surfaces to `deliverBatch`. */
function telegramError(code: number, retryAfter?: number): Error {
  const error = new Error(`Telegram ${code}`) as Error & { error: unknown };
  error.error = { error_code: code, parameters: retryAfter ? { retry_after: retryAfter } : undefined };
  return error;
}

describe.skipIf(!integrationDatabaseAvailable)('outbox delivery and stuck-message reclaim', () => {
  beforeAll(ensureMigrated);
  beforeEach(resetDatabase);

  it('reclaims a stale sending row, fails an exhausted one, and leaves a fresh one alone', async () => {
    await seedUser(8101);
    const eventId = await seedThreatEvent({ locationIds: [OBLAST] });

    const stale = await seedOutbox({
      chatId: 8101, eventId, status: 'sending', attempts: 1,
      updatedSecondsAgo: RECLAIM_THRESHOLD_SECONDS + 100
    });
    const exhausted = await seedOutbox({
      chatId: 8101, eventId, status: 'sending', attempts: MAX_ATTEMPTS,
      updatedSecondsAgo: RECLAIM_THRESHOLD_SECONDS + 100
    });
    const fresh = await seedOutbox({
      chatId: 8101, eventId, status: 'sending', attempts: 1, updatedSecondsAgo: 0
    });

    // Reject every send so the reclaimed row cannot immediately be marked 'sent', which would hide
    // the reclaim transition. 429 with a long retry_after also keeps it out of the next batch.
    const stub = fakeBot(() => { throw telegramError(429, 900); });
    await runDelivery(stub, async () => (await statusOf(exhausted)).status === 'failed',
      'the exhausted sending row to be marked failed');

    expect(await statusOf(exhausted)).toEqual({ status: 'failed', attempts: MAX_ATTEMPTS });
    // Reclaimed back to 'retry', then picked up by the same pass and retried once more.
    expect(await statusOf(stale)).toEqual({ status: 'retry', attempts: 2 });
    expect(await statusOf(fresh)).toEqual({ status: 'sending', attempts: 1 });
    expect(stub.warnings).toContainEqual(expect.objectContaining({ reclaimed: 2 }));
    expect(stub.calls).toHaveLength(1);
  });

  it('pushes the reclaimed retry beyond now using the provider retry_after', async () => {
    await seedUser(8102);
    const eventId = await seedThreatEvent({ locationIds: [OBLAST] });
    const stale = await seedOutbox({
      chatId: 8102, eventId, status: 'sending', attempts: 1,
      updatedSecondsAgo: RECLAIM_THRESHOLD_SECONDS + 100
    });

    const stub = fakeBot(() => { throw telegramError(429, 900); });
    await runDelivery(stub, async () => (await statusOf(stale)).attempts === 2, 'the stale row to be retried');

    const row = await sql<{ delta: string }>(
      `SELECT extract(epoch FROM next_attempt_at-now())::text AS delta FROM notification_outbox WHERE id=$1`,
      [stale]
    );
    expect(Number(row.rows[0]!.delta)).toBeGreaterThan(600);
  });

  it('marks a delivered notification sent and records the delivery', async () => {
    await seedUser(8103);
    const eventId = await seedThreatEvent({ locationIds: [OBLAST] });
    const pending = await seedOutbox({ chatId: 8103, eventId, status: 'pending', attempts: 0 });

    const stub = fakeBot();
    await runDelivery(stub, async () => (await statusOf(pending)).status === 'sent', 'the pending row to be sent');

    expect(await statusOf(pending)).toEqual({ status: 'sent', attempts: 1 });
    const deliveries = await sql<{ delivered_status: string; telegram_message_id: string }>(
      `SELECT delivered_status,telegram_message_id FROM notification_deliveries WHERE outbox_id=$1`, [pending]
    );
    expect(deliveries.rows[0]!.delivered_status).toBe('sent');
    expect(stub.calls[0]!.options).toMatchObject({ parse_mode: 'HTML' });
  });

  it('fails permanently and disables the user when Telegram answers 403', async () => {
    await seedUser(8104);
    const eventId = await seedThreatEvent({ locationIds: [OBLAST] });
    const blocked = await seedOutbox({ chatId: 8104, eventId, status: 'pending', attempts: 0 });

    const stub = fakeBot(() => { throw telegramError(403); });
    await runDelivery(stub, async () => (await statusOf(blocked)).status === 'failed', 'the blocked row to fail');

    expect((await statusOf(blocked)).status).toBe('failed');
    const user = await sql<{ enabled: boolean }>(`SELECT enabled FROM telegram_users WHERE chat_id=8104`);
    expect(user.rows[0]!.enabled).toBe(false);
    const deliveries = await sql<{ error_code: string }>(
      `SELECT error_code FROM notification_deliveries WHERE outbox_id=$1`, [blocked]
    );
    expect(deliveries.rows[0]!.error_code).toBe('403');
  });

  it('does not reclaim anything when no row has been sending for longer than the threshold', async () => {
    await seedUser(8105);
    const eventId = await seedThreatEvent({ locationIds: [OBLAST] });
    const fresh = await seedOutbox({
      chatId: 8105, eventId, status: 'sending', attempts: 2,
      updatedSecondsAgo: RECLAIM_THRESHOLD_SECONDS - 60
    });
    const pending = await seedOutbox({ chatId: 8105, eventId, status: 'pending', attempts: 0 });

    const stub = fakeBot();
    await runDelivery(stub, async () => (await statusOf(pending)).status === 'sent', 'the pending row to be sent');

    expect(await statusOf(fresh)).toEqual({ status: 'sending', attempts: 2 });
    expect(stub.warnings.filter((entry) => 'reclaimed' in entry)).toEqual([]);
  });

  describe('soft updates', () => {
    /** Payload of a queued soft update, pointing at a message the chat is already looking at. */
    function softUpdate(eventId: string, editMessageId: number | null) {
      return {
        locationName: 'Київська область', threatType: 'uav', evidenceLevel: 'monitoring',
        validUntil: new Date(Date.now() + 3_600_000).toISOString(),
        updateKind: 'soft', changes: ['validity_extended'], editMessageId,
        state: { kind: 'threat', key: eventId }
      };
    }

    async function seedPublishedState(eventId: string, chatId: number, messageId: number) {
      await sql(
        `INSERT INTO notification_state(entity_kind,entity_key,chat_id,last_evidence_level,
           telegram_message_id,expires_at)
         VALUES ('threat',$1,$2,'monitoring',$3,now()+interval '6 hours')`,
        [eventId, chatId, messageId]
      );
    }

    it('edits the standing message instead of pushing a new one', async () => {
      await seedUser(8107);
      const eventId = await seedThreatEvent({ locationIds: [OBLAST] });
      await seedPublishedState(eventId, 8107, 555);
      const queued = await seedOutbox({
        chatId: 8107, eventId, status: 'pending', attempts: 0, payload: softUpdate(eventId, 555)
      });

      const stub = fakeBot();
      await runDelivery(stub, async () => (await statusOf(queued)).status === 'sent', 'the soft update to be sent');

      expect(stub.calls).toHaveLength(0);
      expect(stub.edits).toEqual([expect.objectContaining({ chatId: '8107', messageId: 555 })]);
      expect(stub.edits[0]!.text).toContain('Загрозу продовжено до');
    });

    it('falls back to a normal send when the message can no longer be edited', async () => {
      // Telegram rejects an edit of a deleted or too-old message. The subscriber has nothing to look
      // at in that case, so the update is worth sending rather than retrying.
      await seedUser(8108);
      const eventId = await seedThreatEvent({ locationIds: [OBLAST] });
      await seedPublishedState(eventId, 8108, 556);
      const queued = await seedOutbox({
        chatId: 8108, eventId, status: 'pending', attempts: 0, payload: softUpdate(eventId, 556)
      });

      const stub = fakeBot({ onEdit: () => { throw telegramError(400); } });
      await runDelivery(stub, async () => (await statusOf(queued)).status === 'sent', 'the fallback send to happen');

      expect(await statusOf(queued)).toEqual({ status: 'sent', attempts: 1 });
      expect(stub.calls).toHaveLength(1);
      const state = await sql<{ telegram_message_id: string }>(
        `SELECT telegram_message_id FROM notification_state WHERE entity_key=$1 AND chat_id=8108`, [eventId]
      );
      // The state now points at the message that actually exists, so the next edit targets it.
      expect(Number(state.rows[0]!.telegram_message_id)).toBe(1);
    });
  });

  it('delivers strictly by priority before creation time', async () => {
    await seedUser(8106);
    const eventId = await seedThreatEvent({ locationIds: [OBLAST] });
    const low = await seedOutbox({ chatId: 8106, eventId, status: 'pending', attempts: 0, priority: 4, updatedSecondsAgo: 60 });
    const high = await seedOutbox({ chatId: 8106, eventId, status: 'pending', attempts: 0, priority: 0, updatedSecondsAgo: 10 });

    const stub = fakeBot();
    await runDelivery(stub, async () =>
      (await statusOf(low)).status === 'sent' && (await statusOf(high)).status === 'sent',
    'both rows to be sent');

    expect(stub.calls).toHaveLength(2);
    // priority 0 is an official alert start; it must precede the analytics-grade row queued earlier.
    const order = await sql<{ id: string }>(
      `SELECT id FROM notification_outbox ORDER BY sent_at,priority`
    );
    expect(order.rows[0]!.id).toBe(high);
    // Silent notifications are reserved for priority >= 3.
    expect(stub.calls[0]!.options.disable_notification).toBe(false);
    expect(stub.calls[1]!.options.disable_notification).toBe(true);
  });

  describe('aggregate delivery governor', () => {
    it('classifies and claims official and escalation rows before discretionary traffic', async () => {
      await seedUser(8201);
      const eventId = await seedThreatEvent({ locationIds: [OBLAST] });
      const analytics = await seedOutbox({
        chatId: 8201, eventId, status: 'pending', attempts: 0, priority: 1,
        payload: { locationName: 'Київ', state: { kind: 'assessment', key: 'a' } }
      });
      await sql(`UPDATE notification_outbox SET notification_type='assessment_update' WHERE id=$1`, [analytics]);
      const escalation = await seedOutbox({
        chatId: 8201, eventId, status: 'pending', attempts: 0, priority: 4,
        payload: { locationName: 'Київ', evidenceLevel: 'confirmed', updateKind: 'escalation' }
      });
      const official = await seedOutbox({
        chatId: 8201, eventId, status: 'pending', attempts: 0, priority: 3,
        payload: { locationName: 'Київ', evidenceLevel: 'official', updateKind: 'initial' }
      });

      const claimed = await claimDeliveryBatch();

      expect(claimed.map((row) => row.id)).toEqual([official, escalation, analytics]);
      expect(claimed.map(deliveryClass)).toEqual(['protected', 'protected', 'analytics']);
    });

    it('coalesces only replaceable rows and makes a retained assessment self-contained', async () => {
      await seedUser(8202);
      const eventId = await seedThreatEvent({ locationIds: [OBLAST] });
      const firstSoft = await seedOutbox({
        chatId: 8202, eventId, status: 'pending', attempts: 0, priority: 4,
        payload: { updateKind: 'soft', validUntil: '2026-08-11T01:00:00Z', state: { kind: 'threat', key: eventId } }
      });
      await sql(`UPDATE notification_outbox SET created_at=now()-interval '2 minutes' WHERE id=$1`, [firstSoft]);
      const latestSoft = await seedOutbox({
        chatId: 8202, eventId, status: 'pending', attempts: 0, priority: 4,
        payload: { updateKind: 'soft', validUntil: '2026-08-11T02:00:00Z', state: { kind: 'threat', key: eventId } }
      });
      const firstAssessment = await seedOutbox({
        chatId: 8202, eventId, status: 'pending', attempts: 0, priority: 4,
        payload: { level: 'elevated', updateKind: 'initial', state: { kind: 'assessment', key: 'ua-32:uav' } }
      });
      await sql(
        `UPDATE notification_outbox SET notification_type='assessment_update',created_at=now()-interval '2 minutes'
         WHERE id=$1`, [firstAssessment]
      );
      const latestAssessment = await seedOutbox({
        chatId: 8202, eventId, status: 'pending', attempts: 0, priority: 4,
        payload: { level: 'high', updateKind: 'escalation', previousLevel: 'elevated', previousScore: 3,
          state: { kind: 'assessment', key: 'ua-32:uav' } }
      });
      await sql(`UPDATE notification_outbox SET notification_type='assessment_update' WHERE id=$1`, [latestAssessment]);

      const claimed = await claimDeliveryBatch();

      expect(claimed.map((row) => row.id)).toContain(latestSoft);
      expect(claimed.map((row) => row.id)).toContain(latestAssessment);
      expect(claimed.map((row) => row.id)).not.toContain(firstSoft);
      expect(claimed.map((row) => row.id)).not.toContain(firstAssessment);
      const old = await sql<{ status: string; coalesced_into: string }>(
        `SELECT status,coalesced_into FROM notification_outbox WHERE id=$1`, [firstSoft]
      );
      expect(old.rows[0]).toEqual({ status: 'coalesced', coalesced_into: latestSoft });
      const decision = await sql<{ decision: string; notification_class: string }>(
        `SELECT decision,notification_class FROM telegram_delivery_decisions WHERE outbox_id=$1`, [firstSoft]
      );
      expect(decision.rows[0]).toEqual({ decision: 'coalesced', notification_class: 'soft' });
      const retained = claimed.find((row) => row.id === latestAssessment)!;
      expect(retained.payload).toMatchObject({ updateKind: 'initial', previousLevel: null, previousScore: null });
    });

    it('enforces one aggregate token across consecutive claimers', async () => {
      const previousRate = config.TELEGRAM_DELIVERY_RATE_PER_SECOND;
      const previousBurst = config.TELEGRAM_DELIVERY_BURST;
      config.TELEGRAM_DELIVERY_RATE_PER_SECOND = 1;
      config.TELEGRAM_DELIVERY_BURST = 1;
      try {
        await seedUser(8203);
        const eventId = await seedThreatEvent({ locationIds: [OBLAST] });
        await seedOutbox({ chatId: 8203, eventId, status: 'pending', attempts: 0 });
        await seedOutbox({ chatId: 8203, eventId, status: 'pending', attempts: 0 });

        expect(await claimDeliveryBatch()).toHaveLength(1);
        expect(await claimDeliveryBatch()).toHaveLength(0);
      } finally {
        config.TELEGRAM_DELIVERY_RATE_PER_SECOND = previousRate;
        config.TELEGRAM_DELIVERY_BURST = previousBurst;
      }
    });

    it('exposes classed backlog and governor state to Ops and Prometheus', async () => {
      await seedUser(8205);
      const eventId = await seedThreatEvent({ locationIds: [OBLAST] });
      await seedOutbox({
        chatId: 8205, eventId, status: 'pending', attempts: 0,
        payload: { evidenceLevel: 'official', updateKind: 'initial' }
      });

      const status = await telegramDeliveryGovernorStatus() as any;
      expect(status).toMatchObject({ ratePerSecond: 25, burst: 25 });
      expect(status.backlog).toContainEqual(expect.objectContaining({
        notification_class: 'protected', status: 'pending', count: 1
      }));

      const registry = new Registry();
      registerDeliveryGovernorMetrics(registry);
      registerDeliveryGovernorMetrics(registry);
      const metrics = await registry.metrics();
      expect(metrics).toContain('threatlens_telegram_delivery_backlog{class="protected"} 1');
      expect(metrics).toContain('threatlens_telegram_delivery_oldest_seconds{class="protected"}');
      expect(metrics).toContain('threatlens_telegram_delivery_blocked_seconds 0');
    });

    it('persists a 429 pause, releases untouched claims, then recovers with protected work first', async () => {
      await seedUser(8204);
      const eventId = await seedThreatEvent({ locationIds: [OBLAST] });
      const first = await seedOutbox({ chatId: 8204, eventId, status: 'pending', attempts: 0, priority: 3 });
      const untouched = await seedOutbox({ chatId: 8204, eventId, status: 'pending', attempts: 0, priority: 4 });
      const limited = fakeBot(() => { throw telegramError(429, 1); });
      await runDelivery(limited, async () => (await statusOf(first)).status === 'retry', 'the aggregate pause to be stored');

      expect(await statusOf(untouched)).toEqual({ status: 'retry', attempts: 0 });
      const blocked = await sql<{ blocked: boolean }>(
        `SELECT blocked_until>now() AS blocked FROM telegram_delivery_governor WHERE singleton`
      );
      expect(blocked.rows[0]!.blocked).toBe(true);

      const protectedRow = await seedOutbox({
        chatId: 8204, eventId, status: 'pending', attempts: 0, priority: 4,
        payload: { locationName: 'Київ', evidenceLevel: 'confirmed', updateKind: 'escalation' }
      });
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const recovered = fakeBot();
      await runDelivery(recovered, async () => (await statusOf(protectedRow)).status === 'sent',
        'protected delivery after retry-after recovery');

      const sentOrder = await sql<{ id: string }>(
        `SELECT id FROM notification_outbox WHERE sent_at IS NOT NULL ORDER BY sent_at,priority`
      );
      expect(sentOrder.rows[0]!.id).toBe(protectedRow);
      expect((await sql(`SELECT 1 FROM telegram_delivery_decisions WHERE decision='recovered'`)).rowCount).toBe(1);
    });
  });
});
