import { resolve } from 'node:path';
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
  'source_enabled_audit', 'telegram_delivery_decisions', 'notification_deliveries', 'notification_outbox', 'notification_state', 'nightly_digest_runs',
  'risk_assessment_signals', 'risk_assessments', 'risk_signals',
  'event_updates', 'event_evidence', 'threat_event_locations', 'threat_events',
  'alert_source_states', 'alert_periods',
  'source_message_revisions', 'source_messages',
  'subscriptions', 'telegram_users',
  'system_event_log', 'worker_state', 'ai_runs',
  'reference_dataset_syncs', 'occupation_snapshots',
  // Append-only and per-test: every save an ops test performs leaves rows here, and the newest-20
  // assertions would otherwise read another file's history.
  'runtime_settings_audit',
  // Both truncated, unlike `runtime_settings`: migration 030 seeds NOTHING, and an absent row is a
  // meaningful state — «this key is whatever .env says». Resetting by UPDATE would be resetting a
  // row that is not supposed to exist. Truncating the overrides without truncating their trail would
  // leave the newest-20 assertion reading another file's history, so both go, parent last.
  'app_settings_audit', 'app_settings',
  // Child before parent. TRUNCATE … CASCADE would reach the events anyway, but naming them in this
  // order keeps the statement honest about what it destroys and does not depend on the cascade.
  'deployment_run_events', 'deployment_runs',
  // Per-source catch-up telemetry. `deployment_state` is deliberately NOT here — it is a
  // migration-seeded singleton and is reset by UPDATE below, exactly like `runtime_settings`.
  'source_backfill_state',
  // Operator research (migration 035), children first. The requests table is the one that matters:
  // the daily cap and the per-oblast cooldown are counted FROM it, so a file that left its rows
  // behind would spend the next file's allowance and refuse its first request with
  // `refused_cooldown` — a failure that reads as a bug in the governance rather than as leakage
  // between test files.
  'ops_attack_research_classes', 'ops_attack_research_memos', 'ops_attack_research_requests',
  // Public channel publication (migration 044), children first. `channel_published_events` would be
  // swept by the CASCADE anyway — it references three tables above — but `publication_channels`
  // references nothing volatile, so a file that enabled a channel would leave it enabled for every
  // file after it, and their model events would silently start queueing posts.
  'channel_published_events', 'publication_channels'
];

/**
 * Truncating alone is not enough for a suite that reads module state.
 *
 * `resetDatabase()` clears the tables; it cannot clear the in-process caches, cursors and guards
 * that outlive a TRUNCATE. Every integration file that touches publication, the event hub or the
 * analytics recompute needs this `beforeEach`, in this order:
 *
 * ```ts
 * beforeEach(async () => {
 *   await resetDatabase();
 *   resetRuntimeSettingsCache();   // src/services/runtime-settings.ts
 *   resetEventHubCursor();         // src/services/sse.ts — REQUIRED: TRUNCATE … RESTART IDENTITY
 *                                  // restarts `version` at 1 while the hub's cursor keeps its
 *                                  // value, so without this every `version > cursor` after the
 *                                  // first test selects nothing and the suite hangs on `waitFor`.
 *   resetAnalyticsScheduler();     // src/services/analytics-scheduler.ts
 *   resetRiskRunGuard();           // src/services/risk.ts
 *   resetAnalyticsNarrativeMemo(); // src/services/analytics-narrative.ts
 *   resetAppSettingsCache();       // src/services/app-settings.ts — REQUIRED for any file that
 *                                  // writes app_settings: the TRUNCATE above removes the rows, but
 *                                  // the rows were applied by `Object.assign(config, next)` and
 *                                  // TRUNCATE cannot undo that. The integration project runs every
 *                                  // file in ONE fork, so a settings test that raised
 *                                  // AI_TIMEOUT_MS would leave it raised for every file after it.
 *                                  // The seam restores `config` from the boot snapshot, which is
 *                                  // the exact inverse of the only mutation that module performs.
 * });
 * ```
 *
 * A sixth exists but is needed only by files that read the deployment gauges:
 * `resetDeploymentMetricsMemo()` (`src/services/deployment.ts`) clears a ten-second memo in front of
 * the two statements those gauges share. It is not in the list above because nothing else observes
 * it — a stale reading there affects `/metrics` and no assertion about behaviour.
 */
export async function resetDatabase(): Promise<void> {
  await sql(`TRUNCATE ${VOLATILE_TABLES.join(',')} RESTART IDENTITY CASCADE`);
  await sql(`DELETE FROM locations WHERE id LIKE 'test-%'`);
  await sql(`UPDATE sources SET last_success_at=NULL,last_error_at=NULL,last_error=NULL,health_status='unknown'`);
  // `runtime_settings` is not truncated: the row is migration-seeded and a read must never be "no
  // row, therefore unknown". It is reset by UPDATE so every integration file starts in `live`,
  // which is what makes "the delayed behaviour" a thing a test has to ask for explicitly.
  //
  // `mode_changed_at` is backdated an hour, not set to now(): the cutoff is
  // GREATEST(now() - delay, mode_changed_at), so a fresh `mode_changed_at` would clamp every
  // delayed-mode assertion in the suite to "no hold at all" and the tests would pass for the
  // wrong reason. An hour is longer than any window a test backdates into.
  await sql(`UPDATE runtime_settings SET publication_mode='live', analytics_event_driven=true,
             analytics_debounce_ms=20000, analytics_max_delay_ms=120000,
             analytics_min_pass_interval_ms=60000, codex_cooldown_ms=900000,
             mode_changed_at=now() - interval '1 hour',
             updated_at=now(), updated_by='system'`);
  // Same argument as `runtime_settings`: the row is seeded by migration 023 and a read must never
  // be "no row, therefore unknown". Reset to the never-checked state so every file starts with an
  // ops card that says «перевірки ще не було» rather than with another file's observation.
  await sql(`UPDATE deployment_state SET remote_url=NULL, remote_commit=NULL,
             working_tree_commit=NULL, working_tree_dirty=false, last_checked_at=NULL,
             last_check_ok=NULL, last_check_error=NULL, runner_version=NULL, updated_at=now()`);
  // Third singleton, same argument as the two above, and the first one whose stale value can change
  // what the code under test DOES rather than what it reports. Every switch is off by default; a
  // file that turned one on to exercise a model path would leave it on for every file after it, and
  // those files would start calling `codexChat` on surfaces they never opted into. The row is
  // seeded-or-absent by migration 018 rather than truncated, because «no row» already means «all
  // switches off» and truncating would be resetting a row that is not supposed to exist.
  await sql(`UPDATE codex_settings SET model=NULL, narrative_enabled=false, digest_enabled=false,
             attacks_enabled=false, shadow_enabled=false, analytical_threats_enabled=false,
             retrospective_gate_enabled=false,
             tactics_enabled=false, attack_research_enabled=false, updated_at=now()
             WHERE singleton`);
  await sql(`UPDATE telegram_delivery_governor SET tokens=25,last_refill_at=now(),blocked_until=NULL,updated_at=now()
             WHERE singleton`);
}

/**
 * Applies the migration set when the schema is not already current.
 *
 * The state is read from the database rather than cached in a module variable on purpose: the
 * migration test drops and recreates `public`, and file ordering inside the project is not
 * something the suite should have to depend on. The probe is the newest migration *on disk* rather
 * than a hard-coded filename, so adding a migration cannot leave a reused database silently one
 * revision behind — which is exactly the failure the previous hard-coded probe produced.
 */
export async function ensureMigrated(): Promise<void> {
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(resolve(process.cwd(), 'migrations')))
    .filter((file) => file.endsWith('.sql')).sort();
  const newest = files.at(-1);
  const applied = await sql(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='schema_migrations'`
  );
  if (applied.rowCount && newest) {
    const current = await sql(`SELECT 1 FROM schema_migrations WHERE filename=$1`, [newest]);
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

/**
 * One fanout pass, when the cursor is expected NOT to reach the newest version.
 *
 * `runFanout` waits for the cursor to catch up to `max(version)`, which is the right completion
 * signal only while every version below the head is deliverable. A test that deliberately holds a
 * write transaction open has a head the cursor MUST stop short of — the fanout takes only the
 * contiguous run, see `src/services/event-log-cursor.ts` — so that wait would time out by design and
 * the timeout would look like a regression instead of the behaviour being asserted.
 *
 * There is no cursor value to wait for here (the assertion is that it does not move) and no other
 * observable the worker leaves behind on an empty pass, so completion is a settling window instead:
 * `startNotificationWorkers` runs `fanoutRun()` synchronously on start and again every second, so a
 * window longer than one tick guarantees at least one completed pass. Bounded and generous rather
 * than tight, because the assertion it supports is negative.
 */
export async function runFanoutSettling(settleMs = 1_500): Promise<void> {
  const { startNotificationWorkers } = await import('../../src/bot/outbox.js');
  const errors: unknown[] = [];
  const stop = startNotificationWorkers(null, { warn: () => undefined, error: (e: unknown) => errors.push(e) });
  try {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  } finally {
    stop();
  }
  if (errors.length) throw errors[0];
}

export interface FakeBotCall { chatId: string; text: string; options: Record<string, unknown> }
export interface FakeBotEdit { chatId: string; messageId: number; text: string }

export interface FakeBot {
  calls: FakeBotCall[];
  edits: FakeBotEdit[];
  warnings: Array<Record<string, unknown>>;
  bot: unknown;
}

export interface FakeBotBehaviour {
  onSend?: (call: FakeBotCall) => void;
  onEdit?: (edit: FakeBotEdit) => void;
}

/**
 * Minimal stand-in for the grammy bot. `sendMessage` and `editMessageText` either record the call or
 * throw a Telegram-shaped error, so the outbox retry, failure and edit-fallback branches can all be
 * exercised without a network.
 */
export function fakeBot(
  behaviour: ((call: FakeBotCall) => void) | FakeBotBehaviour = () => undefined
): FakeBot {
  const hooks: FakeBotBehaviour = typeof behaviour === 'function' ? { onSend: behaviour } : behaviour;
  const calls: FakeBotCall[] = [];
  const edits: FakeBotEdit[] = [];
  const warnings: Array<Record<string, unknown>> = [];
  let messageId = 1;
  return {
    calls,
    edits,
    warnings,
    bot: {
      api: {
        async sendMessage(chatId: string, text: string, options: Record<string, unknown>) {
          const call = { chatId, text, options };
          calls.push(call);
          hooks.onSend?.(call);
          return { message_id: messageId++ };
        },
        async editMessageText(chatId: string, editedMessageId: number, text: string) {
          const edit = { chatId, messageId: editedMessageId, text };
          edits.push(edit);
          hooks.onEdit?.(edit);
          return { message_id: editedMessageId };
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
