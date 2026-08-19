import { Counter, Gauge, type Registry } from 'prom-client';
import { config } from '../config.js';
import { pool } from '../db/pool.js';

export type DeliveryClass = 'protected' | 'standard' | 'soft' | 'analytics' | 'channel';

/**
 * Which budget a queued message competes in.
 *
 * ## Why `channel_publication` is a class of its own, and why it is tested FIRST
 *
 * The public channel (migration 044) posts model estimates. Its rows share this queue, this worker
 * and this Telegram account with the air-raid notifications, and the whole point of the governor is
 * that ONE aggregate rate limit has to be arbitrated — so the arbitration is where the safety
 * argument has to be made, not in a second queue.
 *
 * Landing in `protected` would be the serious failure: `claimDeliveryBatch` sorts
 * `CASE WHEN class='protected' THEN 0 ELSE 1 END` first, so a channel row in that bucket would be
 * drawn from the same head-of-queue position as «Повітряна тривога» and would spend, during a mass
 * attack, tokens that subscribers are waiting for. It cannot reach that branch by notification type
 * — `channel_publication` is not `alert_start`, `alert_end` or `threat_update` — but the protected
 * branch also keys on PAYLOAD fields (`evidenceLevel`, `updateKind`), and a payload is a jsonb blob
 * that a future caller can shape freely. Testing this type before anything else makes the exclusion
 * structural rather than a property of which keys somebody happened not to set, exactly as the alert
 * branches sit above the delta path in `formatMessage`.
 *
 * Not folded into `analytics` either, although both are "не тривога". Those two labels answer
 * different operational questions. `analytics` rows are per-subscriber, so their backlog scales with
 * the audience and a spike there means the fan-out produced a lot of assessments; a channel backlog
 * is one row per event and any sustained value means the public channel itself is stuck — usually
 * because the bot lost its administrator rights, which is a different incident with a different fix.
 * A shared label would hide the second inside the first.
 *
 * The volume behind this class is bounded upstream rather than here: at most
 * `ANALYTICAL_PROMOTIONS_MAX_PER_HOUR` events (default 12) can be promoted per hour, each producing
 * one row per enabled channel, against a budget of `TELEGRAM_DELIVERY_RATE_PER_SECOND` (default 25)
 * per second. There is no attack shape in which this class can crowd anything out; the ordering
 * above is what guarantees it cannot even try.
 */
export function deliveryClass(row: any): DeliveryClass {
  const payload = row?.payload ?? {};
  if (row?.notification_type === 'channel_publication') return 'channel';
  // Очікувана загроза (міграція 049: timing ≠ now) — ніколи не `protected`, хоч би яким було джерело:
  // «увечері може бути» не має права стояти в черзі попереду «тривога зараз». Перевіряється ПЕРЕД
  // гілкою protected саме тому.
  const expected = row?.notification_type === 'threat_update'
    && typeof payload.timing === 'string' && payload.timing !== 'now';
  if (expected) return 'soft';
  if (row?.notification_type === 'alert_start' || row?.notification_type === 'alert_end'
    || (row?.notification_type === 'threat_update'
      && (payload.evidenceLevel === 'official' || payload.updateKind === 'escalation'))) return 'protected';
  if (row?.notification_type === 'assessment_update' || row?.notification_type === 'nightly_digest') {
    return 'analytics';
  }
  if (row?.notification_type === 'threat_update' && payload.updateKind === 'soft') return 'soft';
  return 'standard';
}

/** The same decision in SQL, in the same order and for the same reason. */
const classSql = `CASE
  WHEN notification_type='channel_publication' THEN 'channel'
  WHEN notification_type='threat_update' AND payload->>'timing' IS NOT NULL AND payload->>'timing'<>'now' THEN 'soft'
  WHEN notification_type IN ('alert_start','alert_end')
    OR (notification_type='threat_update'
      AND (payload->>'evidenceLevel'='official' OR payload->>'updateKind'='escalation')) THEN 'protected'
  WHEN notification_type IN ('assessment_update','nightly_digest') THEN 'analytics'
  WHEN notification_type='threat_update' AND payload->>'updateKind'='soft' THEN 'soft'
  ELSE 'standard' END`;

const governorDecisions = new Counter({
  name: 'threatlens_telegram_delivery_governor_decisions_total',
  help: 'Aggregate Telegram delivery governor decisions by outcome and notification class',
  labelNames: ['decision', 'class'], registers: []
});
const deliveryBacklog = new Gauge({
  name: 'threatlens_telegram_delivery_backlog',
  help: 'Telegram outbox rows currently waiting, by notification class',
  labelNames: ['class'], registers: [],
  async collect() {
    this.reset();
    const rows = await pool.query<{ notification_class: DeliveryClass; count: string }>(
      `SELECT ${classSql} AS notification_class,count(*)::text AS count
       FROM notification_outbox WHERE status IN ('pending','retry','sending') GROUP BY 1`
    );
    for (const row of rows.rows) this.set({ class: row.notification_class }, Number(row.count));
  }
});
const deliveryOldest = new Gauge({
  name: 'threatlens_telegram_delivery_oldest_seconds',
  help: 'Age of the oldest waiting Telegram notification, by notification class',
  labelNames: ['class'], registers: [],
  async collect() {
    this.reset();
    const rows = await pool.query<{ notification_class: DeliveryClass; age: string }>(
      `SELECT ${classSql} AS notification_class,
              extract(epoch FROM now()-min(created_at))::text AS age
       FROM notification_outbox WHERE status IN ('pending','retry','sending') GROUP BY 1`
    );
    for (const row of rows.rows) this.set({ class: row.notification_class }, Math.max(0, Number(row.age)));
  }
});
const deliveryBlocked = new Gauge({
  name: 'threatlens_telegram_delivery_blocked_seconds',
  help: 'Seconds remaining in the Telegram provider retry-after pause', registers: [],
  async collect() {
    const result = await pool.query<{ seconds: string }>(
      `SELECT GREATEST(0,extract(epoch FROM COALESCE(blocked_until,now())-now()))::text AS seconds
       FROM telegram_delivery_governor WHERE singleton`
    );
    this.set(Number(result.rows[0]?.seconds ?? 0));
  }
});

export function registerDeliveryGovernorMetrics(registry: Registry): void {
  for (const [name, metric] of [
    ['threatlens_telegram_delivery_governor_decisions_total', governorDecisions],
    ['threatlens_telegram_delivery_backlog', deliveryBacklog],
    ['threatlens_telegram_delivery_oldest_seconds', deliveryOldest],
    ['threatlens_telegram_delivery_blocked_seconds', deliveryBlocked]
  ] as const) {
    if (!registry.getSingleMetric(name)) registry.registerMetric(metric);
  }
}

async function journal(client: any, decision: string, notificationClass: DeliveryClass, reason: string,
  outboxId: string | null = null, dedupe = false): Promise<boolean> {
  if (dedupe) {
    const inserted = await client.query(
      `INSERT INTO telegram_delivery_decisions(outbox_id,decision,notification_class,reason)
       SELECT $1::uuid,$2,$3,$4 WHERE NOT EXISTS (
         SELECT 1 FROM telegram_delivery_decisions
         WHERE decision=$2 AND notification_class=$3 AND reason=$4
           AND created_at > now()-interval '5 seconds')`,
      [outboxId, decision, notificationClass, reason]
    );
    return Boolean(inserted.rowCount);
  } else {
    await client.query(
      `INSERT INTO telegram_delivery_decisions(outbox_id,decision,notification_class,reason)
       VALUES ($1::uuid,$2,$3,$4)`, [outboxId, decision, notificationClass, reason]
    );
    return true;
  }
}

/**
 * Supersede only self-contained analytics and soft edits that have never begun delivery.
 *
 * The newest assessment is rewritten as a complete assessment (no unseen "previous level"), while
 * the newest soft threat row already contains the complete current validity deadline. Official,
 * escalation and ordinary threat changes never enter this query.
 */
async function coalesceQueued(client: any): Promise<void> {
  const result = await client.query(
    `WITH ranked AS (
       SELECT id,notification_type,
              first_value(id) OVER (PARTITION BY chat_id,notification_type,
                payload#>>'{state,kind}',payload#>>'{state,key}' ORDER BY created_at DESC,id DESC) keeper,
              row_number() OVER (PARTITION BY chat_id,notification_type,
                payload#>>'{state,kind}',payload#>>'{state,key}' ORDER BY created_at DESC,id DESC) position
       FROM notification_outbox
       WHERE status IN ('pending','retry')
         AND (notification_type='assessment_update'
           OR (notification_type='threat_update' AND payload->>'updateKind'='soft'))
         AND payload#>>'{state,key}' IS NOT NULL
     ), changed AS (
       UPDATE notification_outbox o SET status='coalesced',coalesced_into=r.keeper,updated_at=now()
       FROM ranked r WHERE o.id=r.id AND r.position>1
       RETURNING o.id,o.notification_type,r.keeper
     ) SELECT * FROM changed`
  );
  for (const row of result.rows) {
    const notificationClass: DeliveryClass = row.notification_type === 'assessment_update' ? 'analytics' : 'soft';
    await journal(client, 'coalesced', notificationClass, 'superseded_by_newer_queued_state', row.id);
    governorDecisions.inc({ decision: 'coalesced', class: notificationClass });
  }
  if (result.rows.some((row: any) => row.notification_type === 'assessment_update')) {
    const keepers = result.rows.filter((row: any) => row.notification_type === 'assessment_update')
      .map((row: any) => row.keeper);
    await client.query(
      `UPDATE notification_outbox SET payload=payload ||
         '{"updateKind":"initial","previousLevel":null,"previousScore":null}'::jsonb,updated_at=now()
       WHERE id=ANY($1::uuid[])`, [keepers]
    );
  }
}

export async function claimDeliveryBatch(): Promise<any[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await coalesceQueued(client);
    const state = await client.query<{
      tokens: string; last_refill_at: Date; blocked_until: Date | null; database_now: Date;
    }>(
      `SELECT tokens::text,last_refill_at,blocked_until,now() AS database_now
       FROM telegram_delivery_governor WHERE singleton FOR UPDATE`
    );
    const row = state.rows[0]!;
    const now = row.database_now;
    if (row.blocked_until && row.blocked_until.getTime() > now.getTime()) {
      const waiting = await client.query<{ notification_class: DeliveryClass }>(
        `SELECT ${classSql} AS notification_class FROM notification_outbox
         WHERE status IN ('pending','retry') AND next_attempt_at<=now()
         ORDER BY CASE WHEN ${classSql}='protected' THEN 0 ELSE 1 END,priority LIMIT 1`
      );
      if (waiting.rowCount) {
        const notificationClass = waiting.rows[0]!.notification_class;
        if (await journal(client, 'deferred', notificationClass, 'provider_retry_after', null, true)) {
          governorDecisions.inc({ decision: 'deferred', class: notificationClass });
        }
      }
      await client.query('COMMIT');
      return [];
    }
    if (row.blocked_until) {
      await journal(client, 'recovered', 'protected', 'provider_retry_after_elapsed');
      governorDecisions.inc({ decision: 'recovered', class: 'protected' });
    }
    const elapsed = Math.max(0, (now.getTime() - row.last_refill_at.getTime()) / 1000);
    const tokens = Math.min(config.TELEGRAM_DELIVERY_BURST,
      Number(row.tokens) + elapsed * config.TELEGRAM_DELIVERY_RATE_PER_SECOND);
    const allowance = Math.min(25, Math.floor(tokens));
    const batch = allowance > 0 ? await client.query(
      `SELECT * FROM notification_outbox WHERE status IN ('pending','retry') AND next_attempt_at<=now()
       ORDER BY CASE WHEN ${classSql}='protected' THEN 0 ELSE 1 END,priority,created_at
       LIMIT $1 FOR UPDATE SKIP LOCKED`, [allowance]
    ) : { rows: [] as any[] };
    for (const item of batch.rows) {
      await client.query(
        `UPDATE notification_outbox SET status='sending',attempts=attempts+1,updated_at=now() WHERE id=$1`,
        [item.id]
      );
    }
    if (!batch.rows.length) {
      const waiting = await client.query<{ notification_class: DeliveryClass }>(
        `SELECT ${classSql} AS notification_class FROM notification_outbox
         WHERE status IN ('pending','retry') AND next_attempt_at<=now()
         ORDER BY CASE WHEN ${classSql}='protected' THEN 0 ELSE 1 END,priority LIMIT 1`
      );
      if (waiting.rowCount) {
        const notificationClass = waiting.rows[0]!.notification_class;
        if (await journal(client, 'deferred', notificationClass, 'aggregate_rate_budget', null, true)) {
          governorDecisions.inc({ decision: 'deferred', class: notificationClass });
        }
      }
    }
    await client.query(
      `UPDATE telegram_delivery_governor SET tokens=$1,last_refill_at=$2,blocked_until=NULL,updated_at=now()
       WHERE singleton`, [Math.max(0, tokens - batch.rows.length), now]
    );
    await client.query(
      `DELETE FROM telegram_delivery_decisions WHERE created_at < now()-interval '7 days'`
    );
    await client.query('COMMIT');
    return batch.rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function recordProviderBackoff(outboxId: string, notificationClass: DeliveryClass,
  retryAfterSeconds: number, untouchedIds: string[]): Promise<void> {
  const seconds = Math.max(1, Math.min(3600, Math.ceil(retryAfterSeconds)));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE telegram_delivery_governor SET blocked_until=GREATEST(
         COALESCE(blocked_until,'-infinity'::timestamptz),now()+($1||' seconds')::interval),updated_at=now()
       WHERE singleton`, [seconds]
    );
    if (untouchedIds.length) {
      await client.query(
        `UPDATE notification_outbox SET status='retry',attempts=GREATEST(0,attempts-1),
           next_attempt_at=now()+($2||' seconds')::interval,updated_at=now()
         WHERE id=ANY($1::uuid[]) AND status='sending'`, [untouchedIds, seconds]
      );
    }
    await journal(client, 'provider_backoff', notificationClass, `telegram_429_${seconds}s`, outboxId);
    await client.query('COMMIT');
    governorDecisions.inc({ decision: 'provider_backoff', class: notificationClass });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function telegramDeliveryGovernorStatus(): Promise<Record<string, unknown>> {
  const [state, backlog, decisions] = await Promise.all([
    pool.query(
      `SELECT tokens,last_refill_at,blocked_until,
              GREATEST(0,extract(epoch FROM COALESCE(blocked_until,now())-now()))::integer AS blocked_seconds
       FROM telegram_delivery_governor WHERE singleton`
    ),
    pool.query(
      `SELECT ${classSql} AS notification_class,status,count(*)::integer,
              extract(epoch FROM now()-min(created_at))::integer AS oldest_seconds
       FROM notification_outbox WHERE status IN ('pending','retry','sending') GROUP BY 1,status ORDER BY 1,status`
    ),
    pool.query(
      `SELECT decision,notification_class,reason,outbox_id,created_at
       FROM telegram_delivery_decisions ORDER BY created_at DESC LIMIT 20`
    )
  ]);
  return {
    ratePerSecond: config.TELEGRAM_DELIVERY_RATE_PER_SECOND,
    burst: config.TELEGRAM_DELIVERY_BURST,
    ...state.rows[0], backlog: backlog.rows, decisions: decisions.rows
  };
}
