import { Counter, Gauge, type Registry } from 'prom-client';
import { z } from 'zod';
import { APP_SETTINGS, type AppConfig, type SettingMeta, config, parseAppConfig } from '../config.js';
import { pool } from '../db/pool.js';

/**
 * Operator overrides for `src/config.ts`, resolved once at boot and written one transaction at a
 * time.
 *
 * ================================================================================================
 * The resolution, in one sentence
 * ================================================================================================
 *
 * `process.env` is the base, the `app_settings` rows are overlaid on top of it, and the RESULT is
 * fed through `parseAppConfig` — the same function that has always decided whether this deployment
 * may boot. Nothing is ever half-parsed: there is no per-key coercion here, no second copy of a
 * bound, no `Number(row.value)`. A stored value is a string in exactly the form it would have taken
 * in `.env`, and zod turns the whole overlay into an `AppConfig` or refuses it.
 *
 * That is what makes the store safe to hold arbitrary text. `migrations/030_app_settings.sql`
 * deliberately has no CHECK constraints; this module is the reason it does not need any.
 *
 * ================================================================================================
 * Failing OPEN, and counting it
 * ================================================================================================
 *
 * `loadAppSettings()` runs between `migrate()` and `buildServer()`. If the read fails — the table is
 * missing, the connection drops, the statement times out — the environment's configuration stands
 * and the process boots anyway. The alternative is a container that will not start because a
 * *convenience* feature could not read its table, which would turn every settings-related fault into
 * an outage. Every failure increments `threatlens_app_settings_read_failures_total`, which
 * `docs/OPERATIONS.md` names as an incident condition, so "quietly running on .env forever" is not a
 * state this can reach unobserved.
 *
 * The same direction applies one key at a time. A stored row that does not survive the parse does
 * not poison the other ninety-three: {@link parseWithDegrade} drops exactly the keys zod complained
 * about, parses again, and reports them as `rejected` on the settings page. A hand-edited row can
 * therefore make one setting fall back to `.env`; it cannot make the deployment unbootable.
 *
 * ================================================================================================
 * Two independent gates against an `env`-scoped row
 * ================================================================================================
 *
 * A row named `OPS_PASSWORD` must never become the ops password, and "the write API refuses it" is
 * not enough — the row could arrive from a hand-edited database, a restored dump, or a future
 * migration that meant well. So:
 *
 *   1. {@link candidateEnv} filters on `APP_SETTINGS[key].scope !== 'env'` while BUILDING the
 *      overlay. This is the gate that matters: it is on the read path, it runs at every boot, and a
 *      row it drops has never been anywhere near `config`.
 *   2. {@link saveAppSettings} refuses the key before it issues a statement, so the row cannot be
 *      created through the API in the first place.
 *
 * Neither gate is load-bearing for the other. Gate 1 alone would let the table fill with rows that
 * do nothing; gate 2 alone would trust every row that already exists.
 *
 * ================================================================================================
 * No cache, no TTL, no polling
 * ================================================================================================
 *
 * There is one writer (`PUT /ops/api/settings`) and it lives in the same process as every reader.
 * `applyAppSettings` mutates the exported `config` object in place after the COMMIT, and every
 * consumer that reads `config.KEY` at call time sees it immediately — which is precisely why
 * `APP_SETTINGS[key].apply` had to be derived from actual consumption rather than assumed. A TTL
 * would add a recurring statement to a pool the ingestion tick and every snapshot share, to learn
 * something this process already knows. This is the single-replica assumption `runtime-settings.ts`,
 * `shadow-classifier.ts` and `ingestion.ts` all state; it is the first thing to revisit if a second
 * replica is ever run.
 */

/**
 * Distinct from `migrate()`'s 841005211 by one. Both are transaction-scoped serialisation points for
 * "there must be one writer at a time"; a shared number would make a settings save wait behind a
 * migration for no reason, and a boot migration wait behind a settings save for a worse one.
 */
export const APP_SETTINGS_LOCK = 841005212;

/** What the audit trail writes instead of a credential. Never the value, not even the previous one. */
export const SECRET_AUDIT_REPLACED = '«замінено»';
/** Also used for a non-secret reset: `new_value` is NOT NULL, exactly as in migration 022. */
export const SECRET_AUDIT_CLEARED = '«знято»';

export const appSettingsReadFailures = new Counter({
  name: 'threatlens_app_settings_read_failures_total',
  help: 'Reads of app_settings that fell back to the environment',
  registers: []
});

export const appSettingsOverrides = new Gauge({
  name: 'threatlens_app_settings_overrides',
  help: 'Settings currently in force from app_settings rather than from the environment',
  registers: []
});

const METRICS: ReadonlyArray<[string, Counter | Gauge]> = [
  ['threatlens_app_settings_read_failures_total', appSettingsReadFailures],
  ['threatlens_app_settings_overrides', appSettingsOverrides]
];

/**
 * Detached at construction and attached here, the shape `registerPublicationMetrics` and
 * `registerBackfillMetrics` already use: importing a service must never mutate a shared registry.
 * Idempotent, so building a second server in a test does not throw.
 */
export function registerAppSettingsMetrics(registry: Registry): void {
  for (const [name, metric] of METRICS) {
    if (!registry.getSingleMetric(name)) registry.registerMetric(metric);
  }
}

// ------------------------------------------------------------------------------------------------
// Pure helpers
// ------------------------------------------------------------------------------------------------

/**
 * The env-string form of a parsed value — the inverse of what the schema's transforms do, to the
 * extent that inverse exists.
 *
 * Booleans are the only shape that needs a decision: the schema reads them as `value === 'true'`, so
 * `'true'`/`'false'` is the only pair that round-trips. Numbers and strings are themselves. This is
 * used for `defaultValue`, for `applied`, and for the `pendingRestart` comparison, all of which have
 * to speak the same dialect as the stored rows or the page would report a difference that is only a
 * difference in formatting.
 */
export function envString(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return value == null ? '' : String(value);
}

/**
 * What the schema produces from an empty environment. Computed once, and never from `process.env` —
 * this is the "за замовчуванням" column, and reading it from the environment would make it agree
 * with `.env` by construction and say nothing.
 *
 * Safe to evaluate unconditionally: `NODE_ENV` defaults to `development`, so the production
 * refinements return early and this parse cannot throw.
 */
export const DEFAULT_CONFIG: AppConfig = parseAppConfig({});

export function settingMeta(key: string): SettingMeta | undefined {
  return (APP_SETTINGS as Record<string, SettingMeta | undefined>)[key];
}

/** Secret-ness is a property of the value, declared once in `APP_SETTINGS`. See `SettingUi`. */
export function isSecretSetting(key: string): boolean {
  return settingMeta(key)?.ui.kind === 'secret';
}

/** Writable through the ops API: known to the registry AND not `env`-scoped. */
export function isWritableSetting(key: string): boolean {
  const meta = settingMeta(key);
  return Boolean(meta) && meta!.scope !== 'env';
}

/**
 * The environment the schema is actually shown: `base`, with every WRITABLE stored key laid over it.
 *
 * Gate 1 of the two described in the module header. An `env`-scoped row and a row for a key the
 * registry has never heard of are both skipped in silence here and reported separately, because
 * silence is the safe behaviour on the read path and a report is the useful behaviour on the page.
 */
export function candidateEnv(
  base: Record<string, string | undefined>,
  store: Record<string, string>
): Record<string, string | undefined> {
  const candidate: Record<string, string | undefined> = { ...base };
  for (const [key, value] of Object.entries(store)) {
    if (!isWritableSetting(key)) continue;
    candidate[key] = value;
  }
  return candidate;
}

/** The keys a `ZodError` blames, de-duplicated, in the order zod reported them. */
function blamedKeys(error: unknown): string[] {
  if (!(error instanceof z.ZodError)) return [];
  return [...new Set(error.issues.map((issue) => String(issue.path[0] ?? '')).filter(Boolean))];
}

export interface DegradeResult {
  config: AppConfig;
  /** Stored keys dropped to make the parse succeed, in the order they were dropped. */
  rejected: string[];
}

/**
 * Parse the overlay, dropping the stored keys zod refuses until it succeeds.
 *
 * The loop terminates because every iteration removes at least one key from `remaining` and refuses
 * to iterate when it cannot: if zod blames only keys that are NOT in the store, the fault is in the
 * environment itself and is re-thrown, because degrading it is not this function's business — the
 * environment is the fallback.
 *
 * That case is currently unreachable by construction, and the reason is worth writing down: every
 * cross-field refinement in `src/config.ts` (`DEPLOY_RUNNER_TOKEN`, `OPS_PASSWORD`, `METRICS_TOKEN`,
 * `PUBLIC_URL`, `DEMO_SOURCE_ENABLED`, `DATABASE_URL`) names an `env`-scoped key, and `candidateEnv`
 * never lets a stored row reach one. A stored row can therefore only ever fail its own field-level
 * check. If a refinement is ever added that spans a writable key, this loop already handles it —
 * that key gets dropped and reported — and the `throw` stays the honest answer for the rest.
 */
export function parseWithDegrade(
  base: Record<string, string | undefined>,
  store: Record<string, string>
): DegradeResult {
  const remaining: Record<string, string> = { ...store };
  const rejected: string[] = [];
  for (;;) {
    try {
      return { config: parseAppConfig(candidateEnv(base, remaining)), rejected };
    } catch (error) {
      const offending = blamedKeys(error).filter((key) => key in remaining);
      if (!offending.length) throw error;
      for (const key of offending) {
        delete remaining[key];
        rejected.push(key);
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------
// The boot snapshot
// ------------------------------------------------------------------------------------------------

/**
 * What this process was configured with before any row was applied.
 *
 * Frozen at module load, which is BEFORE `loadAppSettings()` can run — `src/index.ts` awaits it
 * after every import has been resolved — so it is genuinely the environment's answer and not a
 * snapshot of a decision an operator made thirty seconds ago. It is the reference `pendingRestart`
 * is computed against: a `restart`-mode key whose effective value has moved away from this is a key
 * whose consumer is still running on the old one.
 *
 * Never reset. {@link resetAppSettingsCache} restores `config` TO it, which is the only sense in
 * which a test may move the world back.
 */
const BOOT_CONFIG: AppConfig = { ...config };

export function bootConfig(): AppConfig {
  return { ...BOOT_CONFIG };
}

// ------------------------------------------------------------------------------------------------
// State
// ------------------------------------------------------------------------------------------------

export interface AppSettingRow {
  key: string;
  value: string;
  updatedAt: string;
  updatedBy: string;
}

export interface AppSettingsState {
  rows: AppSettingRow[];
  store: Record<string, string>;
  /** Stored keys the schema refused. Their `.env` or default value is what is actually in force. */
  rejected: string[];
  /** Stored keys `APP_SETTINGS` has never heard of — a rename, or a downgrade to an older image. */
  orphans: string[];
  /** Stored keys that are `env`-scoped. Only a hand-edited row can produce one; gate 1 ignores it. */
  blocked: string[];
  loadedAt: string | null;
  /** The read itself failed and the environment stands. Counted, and shown on the page. */
  degraded: boolean;
}

function emptyState(): AppSettingsState {
  return { rows: [], store: {}, rejected: [], orphans: [], blocked: [], loadedAt: null, degraded: false };
}

let state: AppSettingsState = emptyState();

export function appSettingsState(): AppSettingsState {
  return { ...state, rows: [...state.rows], store: { ...state.store } };
}

function storeOf(rows: AppSettingRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function buildState(rows: AppSettingRow[], rejected: string[]): AppSettingsState {
  return {
    rows,
    store: storeOf(rows),
    rejected,
    orphans: rows.filter((row) => !settingMeta(row.key)).map((row) => row.key),
    blocked: rows.filter((row) => settingMeta(row.key)?.scope === 'env').map((row) => row.key),
    loadedAt: new Date().toISOString(),
    degraded: false
  };
}

/** Rows that are actually deciding something: known, writable, and not thrown out by the parse. */
function activeOverrides(current: AppSettingsState): string[] {
  return current.rows
    .map((row) => row.key)
    .filter((key) => isWritableSetting(key) && !current.rejected.includes(key));
}

// ------------------------------------------------------------------------------------------------
// Reads
// ------------------------------------------------------------------------------------------------

interface SettingsQueryRow { key: string; value: string; updated_at: Date; updated_by: string }

interface Queryable {
  query<T extends Record<string, any>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

async function selectRows(client: Queryable): Promise<AppSettingRow[]> {
  const result = await client.query<SettingsQueryRow>(
    'SELECT key,value,updated_at,updated_by FROM app_settings ORDER BY key'
  );
  return result.rows.map((row) => ({
    key: row.key,
    value: row.value,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by
  }));
}

export async function readAppSettingsRows(): Promise<AppSettingRow[]> {
  return selectRows(pool);
}

export interface SettingsLogger {
  warn?: (fields: Record<string, unknown>, message: string) => void;
  error?: (fields: Record<string, unknown>, message: string) => void;
}

/**
 * Read the store and apply it. Called exactly once, from `src/index.ts`, between `migrate()` and
 * `buildServer()` — after the schema exists and before anything is serving.
 */
export async function loadAppSettings(logger?: SettingsLogger): Promise<AppSettingsState> {
  try {
    const rows = await readAppSettingsRows();
    const { config: next, rejected } = parseWithDegrade(process.env, storeOf(rows));
    applyAppSettings(next);
    state = buildState(rows, rejected);
    if (rejected.length) {
      logger?.warn?.({ rejected }, 'stored app settings refused by the schema; the environment stands for them');
    }
  } catch (error) {
    // FAIL OPEN. `config` keeps whatever the environment gave it, which is a working deployment.
    appSettingsReadFailures.inc();
    state = { ...emptyState(), loadedAt: new Date().toISOString(), degraded: true };
    logger?.error?.({ error }, 'app_settings could not be read; running on the environment alone');
  }
  appSettingsOverrides.set(activeOverrides(state).length);
  return appSettingsState();
}

/**
 * The hot application. `config` is a plain object and every consumer reads `config.KEY` at the
 * moment it needs it, so this one assignment is the whole of "applied" for the fifty-four keys
 * classified `hot`. The twenty-seven classified `restart` are exactly the ones for which it is not
 * enough, and `pendingRestartKeys()` is how the page says so.
 *
 * One `hot` key is hot in a way worth naming: `ALERT_POLL_INTERVAL_SECONDS` is read by the
 * scheduler on every tick rather than at the moment of use, so it applies from the NEXT pass rather
 * than instantly. Its `applyNote` says so on the page.
 */
export function applyAppSettings(next: AppConfig): void {
  Object.assign(config, next);
}

/**
 * `restart`-mode keys whose effective value no longer matches the one this process started with.
 *
 * Compared as env-strings rather than as parsed values so that `true`/`'true'` and `15`/`'15'` never
 * read as a difference; the whole point of the banner is that it appears when, and only when, a
 * consumer is running on something stale.
 */
export function pendingRestartKeys(): string[] {
  return Object.entries(APP_SETTINGS)
    .filter(([key, meta]) => meta.apply === 'restart'
      && envString(config[key as keyof AppConfig]) !== envString(BOOT_CONFIG[key as keyof AppConfig]))
    .map(([key]) => key);
}

// ------------------------------------------------------------------------------------------------
// Writes
// ------------------------------------------------------------------------------------------------

/** A key the registry does not know, or one it knows is `env`-scoped. Gate 2. */
export class AppSettingsUnknownKeyError extends Error {
  readonly keys: string[];

  constructor(keys: string[]) {
    super(`unknown or environment-only settings: ${keys.join(', ')}`);
    this.name = 'AppSettingsUnknownKeyError';
    this.keys = keys;
  }
}

/** The authoritative refusal: `parseAppConfig` said no, inside the lock. */
export class AppSettingsValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`invalid settings: ${issues.join(', ')}`);
    this.name = 'AppSettingsValidationError';
    this.issues = issues;
  }
}

export interface AppSettingsChange {
  field: string;
  previousValue: string | null;
  newValue: string;
}

export interface AppSettingsSaveResult {
  state: AppSettingsState;
  changes: AppSettingsChange[];
}

/**
 * One row per changed key, and what a secret writes instead of its value.
 *
 * `null` on the way in is a reset — the row is deleted — and is recorded as «знято» for every key,
 * secret or not, because `new_value` is NOT NULL and a reset is a real event that has to be
 * legible. For a secret the previous value is «замінено» when there was one and NULL when there was
 * not, which is exactly as much as the trail needs to answer «коли змінили».
 */
export function auditChange(key: string, before: string | null, after: string | null): AppSettingsChange {
  const secret = isSecretSetting(key);
  return {
    field: key,
    previousValue: before === null ? null : secret ? SECRET_AUDIT_REPLACED : before,
    newValue: after === null ? SECRET_AUDIT_CLEARED : secret ? SECRET_AUDIT_REPLACED : after
  };
}

/**
 * Apply a patch. `null` resets a key to whatever `.env` or the default says by deleting its row.
 *
 * Everything happens inside one transaction holding `pg_advisory_xact_lock(APP_SETTINGS_LOCK)`: the
 * store is read, the patch is laid over it, and the WHOLE result is put through `parseAppConfig`
 * before a single row is written. That parse is authoritative — not a re-check of something the
 * route already decided, but the only decision. The route runs no schema of its own, precisely
 * because a second schema is a second answer.
 *
 * The read is inside the lock rather than outside it because the patch is a PATCH: two concurrent
 * saves that each read the pre-transaction store would each validate against a store the other is
 * about to change, and the combination is what would reach the operator as a 500. The advisory lock
 * makes that pair sequential; it is transaction-scoped, so a crash releases it.
 *
 * One consequence worth stating: if a hand-edited row is already invalid, every save is refused
 * until it is fixed, naming that row in `issues`. That is deliberate — the alternative is a save
 * that silently drops somebody else's broken row — and it is actionable, because the page shows the
 * key and `null` resets it.
 */
export async function saveAppSettings(
  patch: Record<string, string | null>, changedBy: string
): Promise<AppSettingsSaveResult> {
  const unknown = Object.keys(patch).filter((key) => !isWritableSetting(key));
  if (unknown.length) throw new AppSettingsUnknownKeyError(unknown);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [APP_SETTINGS_LOCK]);
    const before = storeOf(await selectRows(client));
    const next = { ...before };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }

    let parsed: AppConfig;
    try {
      parsed = parseAppConfig(candidateEnv(process.env, next));
    } catch (error) {
      const issues = blamedKeys(error);
      throw new AppSettingsValidationError(issues.length ? issues : ['unknown']);
    }

    const changes: AppSettingsChange[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const previous = before[key] ?? null;
      if (previous === value) continue;
      if (value === null) await client.query('DELETE FROM app_settings WHERE key=$1', [key]);
      else {
        await client.query(
          `INSERT INTO app_settings(key,value,updated_at,updated_by) VALUES ($1,$2,now(),$3)
           ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,
             updated_at=now(), updated_by=EXCLUDED.updated_by`,
          [key, value, changedBy]
        );
      }
      changes.push(auditChange(key, previous, value));
    }
    for (const change of changes) {
      await client.query(
        `INSERT INTO app_settings_audit(changed_by,field,previous_value,new_value,source)
         VALUES ($1,$2,$3,$4,'ops_api')`,
        [changedBy, change.field, change.previousValue, change.newValue]
      );
    }

    // Read back INSIDE the transaction, so the state this process publishes is the state that was
    // committed rather than a reconstruction of what we believe we wrote.
    const rows = await selectRows(client);
    await client.query('COMMIT');
    applyAppSettings(parsed);
    state = buildState(rows, []);
    appSettingsOverrides.set(activeOverrides(state).length);
    return { state: appSettingsState(), changes };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface AppSettingsAuditRow {
  changedAt: string;
  changedBy: string;
  field: string;
  previousValue: string | null;
  newValue: string;
  source: 'ops_api' | 'migration' | 'system';
}

/**
 * `ORDER BY changed_at DESC, id DESC` for the reason migration 022 gives: several keys changed in
 * one save share `now()` to the microsecond, and `id DESC` is what keeps them in a stable order
 * between two reads.
 */
export async function readAppSettingsAudit(
  key: string | null = null, limit = 20
): Promise<AppSettingsAuditRow[]> {
  const result = await pool.query<{
    changed_at: Date; changed_by: string; field: string;
    previous_value: string | null; new_value: string; source: AppSettingsAuditRow['source'];
  }>(
    `SELECT changed_at,changed_by,field,previous_value,new_value,source
       FROM app_settings_audit
      WHERE ($1::text IS NULL OR field=$1)
      ORDER BY changed_at DESC, id DESC LIMIT $2`,
    [key, limit]
  );
  return result.rows.map((row) => ({
    changedAt: row.changed_at.toISOString(),
    changedBy: row.changed_by,
    field: row.field,
    previousValue: row.previous_value,
    newValue: row.new_value,
    source: row.source
  }));
}

/**
 * Test seam, and the only way back.
 *
 * `resetDatabase()` truncates the table; it cannot undo `Object.assign(config, next)`, and the
 * integration project runs every file in ONE fork — so a settings test that raised `AI_TIMEOUT_MS`
 * would leave it raised for every file that ran after it. Restoring `config` from the boot snapshot
 * is exactly the inverse of the only mutation this module performs.
 */
export function resetAppSettingsCache(): void {
  Object.assign(config, BOOT_CONFIG);
  state = emptyState();
  appSettingsOverrides.set(0);
}
