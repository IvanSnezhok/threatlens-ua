import pg from 'pg';

/**
 * Integration harness for the live-PostgreSQL suite.
 *
 * Everything here talks to the database through its own pool. The application pool
 * (`src/db/pool.ts`) is capped at two connections under `NODE_ENV=test`, and the workers under
 * test hold one of them for the length of a transaction — the harness must not compete for those
 * two slots.
 */

export const integrationDatabaseAvailable = process.env.TL_INTEGRATION_DB === '1';

let harnessPool: pg.Pool | null = null;

export function db(): pg.Pool {
  if (!harnessPool) {
    harnessPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 4,
      application_name: 'threatlens-integration-harness'
    });
  }
  return harnessPool;
}

export async function closeHarnessPool(): Promise<void> {
  if (!harnessPool) return;
  const closing = harnessPool;
  harnessPool = null;
  await closing.end().catch(() => undefined);
}

export async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<pg.QueryResult<T>> {
  return db().query<T>(text, params);
}

export async function count(table: string, where = 'true', params: unknown[] = []): Promise<number> {
  const result = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`, params);
  return Number(result.rows[0]!.n);
}

/** Tables holding per-test state. Reference data seeded by the migrations is preserved. */
const VOLATILE_TABLES = [
  'notification_deliveries', 'notification_outbox', 'nightly_digest_runs',
  'risk_assessment_signals', 'risk_assessments', 'risk_signals',
  'event_updates', 'event_evidence', 'threat_event_locations', 'threat_events',
  'alert_source_states', 'alert_periods',
  'source_message_revisions', 'source_messages',
  'subscriptions', 'telegram_users',
  'system_event_log', 'worker_state', 'ai_runs',
  'reference_dataset_syncs', 'occupation_snapshots'
];

export async function resetDatabase(): Promise<void> {
  await sql(`TRUNCATE ${VOLATILE_TABLES.join(',')} RESTART IDENTITY CASCADE`);
  await sql(`DELETE FROM locations WHERE id LIKE 'test-%'`);
  await sql(`UPDATE sources SET last_success_at=NULL,last_error_at=NULL,last_error=NULL,health_status='unknown'`);
}

/**
 * Applies `migrations/001…008` when the schema is not already current.
 *
 * The state is read from the database rather than cached in a module variable on purpose: the
 * migration test drops and recreates `public`, and file ordering inside the project is not
 * something the suite should have to depend on. The probe is the newest migration, the same one
 * `/health/ready` gates on, so a database left at an older revision is migrated rather than used.
 */
export async function ensureMigrated(): Promise<void> {
  const applied = await sql(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='schema_migrations'`
  );
  if (applied.rowCount) {
    const current = await sql(`SELECT 1 FROM schema_migrations WHERE filename='008_alert_end_debounce.sql'`);
    if (current.rowCount) return;
  }
  const { migrate } = await import('../../src/db/migrate.js');
  await migrate();
}

export async function waitFor(
  predicate: () => Promise<boolean>,
  label: string,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------------------------------------------
// Seeding
// ------------------------------------------------------------------------------------------------

export const OBLAST = 'ua-32';                       // Київська область
export const CITY_IN_OBLAST = 'ua-city-bila-tserkva'; // Біла Церква, parent_id = ua-32
export const OTHER_OBLAST = 'ua-53';                 // Полтавська область

export async function seedUser(chatId: number, enabled = true): Promise<void> {
  await sql(
    `INSERT INTO telegram_users(chat_id,username,enabled) VALUES ($1,$2,$3)
     ON CONFLICT (chat_id) DO UPDATE SET enabled=EXCLUDED.enabled`,
    [chatId, `user${chatId}`, enabled]
  );
}

export interface SubscriptionSeed {
  chatId: number;
  locationId: string;
  threatType?: string;
  minimumEvidenceLevel?: string;
  notifyAlertStart?: boolean;
  notifyAlertEnd?: boolean;
  notifyThreats?: boolean;
  notifyAnalytics?: boolean;
  enabled?: boolean;
}

export async function seedSubscription(seed: SubscriptionSeed): Promise<void> {
  await sql(
    `INSERT INTO subscriptions(chat_id,location_id,threat_type,minimum_evidence_level,
       notify_alert_start,notify_alert_end,notify_threats,notify_analytics,enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      seed.chatId, seed.locationId, seed.threatType ?? '*', seed.minimumEvidenceLevel ?? 'unverified',
      seed.notifyAlertStart ?? true, seed.notifyAlertEnd ?? true,
      seed.notifyThreats ?? true, seed.notifyAnalytics ?? true, seed.enabled ?? true
    ]
  );
}

export interface ThreatSeed {
  locationIds: string[];
  threatType?: string;
  evidenceLevel?: string;
  status?: string;
}

export async function seedThreatEvent(seed: ThreatSeed): Promise<string> {
  const inserted = await sql<{ id: string }>(
    `INSERT INTO threat_events(threat_type,status,evidence_level,title,summary,started_at,last_observed_at,valid_until)
     VALUES ($1,$2,$3,$4,$5,now(),now(),now()+interval '2 hours') RETURNING id`,
    [
      seed.threatType ?? 'uav', seed.status ?? 'observed', seed.evidenceLevel ?? 'monitoring',
      'Integration threat', 'Integration threat summary'
    ]
  );
  const id = inserted.rows[0]!.id;
  for (const locationId of seed.locationIds) {
    await sql(
      `INSERT INTO threat_event_locations(event_id,location_id,relation_type) VALUES ($1,$2,'explicit_threat')`,
      [id, locationId]
    );
  }
  return id;
}

export async function appendSystemEvent(eventType: string, payload: Record<string, unknown>): Promise<number> {
  const result = await sql<{ version: string }>(
    `INSERT INTO system_event_log(event_type,payload) VALUES ($1,$2) RETURNING version`,
    [eventType, JSON.stringify(payload)]
  );
  return Number(result.rows[0]!.version);
}

export async function outboxRows(): Promise<Array<Record<string, unknown>>> {
  const result = await sql(`SELECT * FROM notification_outbox ORDER BY chat_id,idempotency_key`);
  return result.rows;
}

// ------------------------------------------------------------------------------------------------
// Driving the production workers
// ------------------------------------------------------------------------------------------------

/**
 * `fanoutNewEvents` is module-private, so the fanout is driven through the exported
 * `startNotificationWorkers` entry point — the same path production uses. Completion is detected by
 * the worker's own cursor reaching the newest `system_event_log` version, which makes negative
 * assertions ("this user received nothing") safe rather than racy.
 */
export async function runFanout(): Promise<void> {
  const { startNotificationWorkers } = await import('../../src/bot/outbox.js');
  const head = await sql<{ v: string }>(`SELECT COALESCE(max(version),0)::text AS v FROM system_event_log`);
  const target = Number(head.rows[0]!.v);
  const errors: unknown[] = [];
  const stop = startNotificationWorkers(null, { warn: () => undefined, error: (e: unknown) => errors.push(e) });
  try {
    await waitFor(async () => {
      if (errors.length) return true;
      const state = await sql<{ cursor_value: string }>(
        `SELECT cursor_value FROM worker_state WHERE worker_name='notification-fanout'`
      );
      return state.rowCount > 0 && Number(state.rows[0]!.cursor_value) >= target;
    }, `notification fanout cursor to reach version ${target}`);
  } finally {
    stop();
  }
  if (errors.length) throw errors[0];
}

export interface FakeBotCall { chatId: string; text: string; options: Record<string, unknown> }

export interface FakeBot {
  calls: FakeBotCall[];
  warnings: Array<Record<string, unknown>>;
  bot: unknown;
}

/**
 * Minimal stand-in for the grammy bot. `sendMessage` either records the call or throws a
 * Telegram-shaped error so the outbox retry/failure branches can be exercised.
 */
export function fakeBot(behaviour: (call: FakeBotCall) => void = () => undefined): FakeBot {
  const calls: FakeBotCall[] = [];
  const warnings: Array<Record<string, unknown>> = [];
  let messageId = 1;
  return {
    calls,
    warnings,
    bot: {
      api: {
        async sendMessage(chatId: string, text: string, options: Record<string, unknown>) {
          const call = { chatId, text, options };
          calls.push(call);
          behaviour(call);
          return { message_id: messageId++ };
        }
      }
    }
  };
}

export async function runDelivery(
  stub: FakeBot,
  until: () => Promise<boolean>,
  label: string
): Promise<void> {
  const { startNotificationWorkers } = await import('../../src/bot/outbox.js');
  const errors: unknown[] = [];
  const stop = startNotificationWorkers(stub.bot as never, {
    warn: (fields: Record<string, unknown>) => stub.warnings.push(fields),
    error: (e: unknown) => errors.push(e)
  });
  try {
    await waitFor(async () => (errors.length ? true : until()), label);
  } finally {
    stop();
  }
  if (errors.length) throw errors[0];
}
