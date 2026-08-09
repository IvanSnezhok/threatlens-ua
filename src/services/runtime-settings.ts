import { Counter } from 'prom-client';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { PUBLICATION_MODES, type PublicationMode } from '../types.js';

/**
 * Runtime knobs an operator changes while watching the output.
 *
 * ================================================================================================
 * Failure is `live`, never an exception
 * ================================================================================================
 *
 * This read sits in front of the SSE hub's one-second tick and in front of every snapshot request.
 * It must not throw, and — more sharply — it must not fail *closed*. Failing closed means a database
 * hiccup silently stops warning people, which is the one direction this project treats as
 * unrecoverable (`docs/ARCHITECTURE.md` §Consistency rules). Failing open publishes a few seconds
 * early, which has never been a harm here. Every fallback increments
 * `threatlens_publication_settings_read_failures_total`, which `docs/OPERATIONS.md` names as an
 * incident condition, so "quietly live forever" is not a state this can reach unobserved.
 *
 * The memo is in-process and therefore per-replica. The deployment is single-replica and every other
 * in-process guard in this repo (`shadow-classifier.ts`, `attack-analytics.ts`, `ingestion.ts`)
 * states the same assumption.
 *
 * The file splits the same way `codex-settings.ts` does: pure helpers first, unit-tested with no
 * database, then the reads and the one transaction that writes.
 */

export interface RuntimeSettings {
  publicationMode: PublicationMode;
  /** ISO. The instant the mode last changed — the clamp the publication cutoff is taken against. */
  modeChangedAt: string;
  analyticsEventDriven: boolean;
  analyticsDebounceMs: number;
  analyticsMaxDelayMs: number;
  /**
   * Minimum gap between two COMPLETED analytics passes. The storm guard, and — since migration 028 —
   * operator-owned rather than compiled into `analytics-scheduler.ts`. It is what makes
   * `analyticsDebounceMs: 0` a safe thing to ask for.
   */
  analyticsMinPassIntervalMs: number;
  codexCooldownMs: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface RuntimeSettingsAuditRow {
  changedAt: string;
  changedBy: string;
  field: string;
  previousValue: string | null;
  newValue: string;
  source: 'ops_api' | 'migration' | 'system';
}

export interface RuntimeSettingsChange {
  field: string;
  previousValue: string | null;
  newValue: string;
}

/**
 * What a reader sees when the row cannot be read at all.
 *
 * `modeChangedAt` is the Unix epoch rather than "now": the cutoff is
 * `GREATEST(now() - delay, mode_changed_at)`, so a fresh instant here would clamp the cutoff to the
 * moment of the failure and pin the public view to that second for as long as the failure lasts.
 * An epoch value makes the clamp inert, which is the same "degrade toward `live`" direction the rest
 * of this module takes.
 */
export const RUNTIME_SETTINGS_DEFAULTS: RuntimeSettings = {
  publicationMode: 'live',
  modeChangedAt: new Date(0).toISOString(),
  analyticsEventDriven: true,
  analyticsDebounceMs: 20_000,
  analyticsMaxDelayMs: 120_000,
  analyticsMinPassIntervalMs: 60_000,
  codexCooldownMs: 900_000,
  updatedAt: null,
  updatedBy: null
};

/**
 * Every numeric field's legal range, and the ONE place it is written down.
 *
 * These are the CHECK constraints of migrations 022 and 028, restated in TypeScript because three
 * different consumers need them and a fourth transcription is how they drift: the ops route's zod
 * schema rejects out-of-range input before a statement is issued, {@link validateRuntimeSettings}
 * re-checks inside the row lock so a direct `saveRuntimeSettings` call cannot reach the constraint
 * and turn it into a 500, and `GET /ops/api/runtime` ships the object itself so the console's number
 * inputs carry their own `min`/`max` instead of learning them from a 400. That last consumer is the
 * reported bug: setting every delay to 0 failed with no indication of which field or what bound.
 *
 * `analyticsDebounceMs.min` is 0 — migration 028 lowered it, and the comment there explains why the
 * protection it was thought to provide never lived here.
 */
export const RUNTIME_SETTINGS_BOUNDS = {
  analyticsDebounceMs: { min: 0, max: 600_000 },
  analyticsMaxDelayMs: { min: 5_000, max: 1_800_000 },
  analyticsMinPassIntervalMs: { min: 5_000, max: 900_000 },
  codexCooldownMs: { min: 0, max: 86_400_000 }
} as const;

export type RuntimeSettingsBoundedField = keyof typeof RUNTIME_SETTINGS_BOUNDS;

/**
 * Two seconds, not one. The hub ticks at exactly 1000 ms, so a 1000 ms TTL is essentially never a
 * hit on the hub path and the memo would be a permanent extra query per second forever. Two seconds
 * is still inside «an operator's change takes effect within a second or two without a restart»,
 * which `saveRuntimeSettings`'s cache priming makes instant in-process anyway.
 */
export const RUNTIME_SETTINGS_TTL_MS = 2000;

/**
 * Declared HERE, not in `publication.ts`, because the failure it counts happens inside
 * `resolveRuntimeSettings()` and `publication.ts → runtime-settings.ts` is already an import edge —
 * declaring it the other way round would close a cycle. Detached like every other service metric;
 * `registerPublicationMetrics` imports and registers it, so the metric name, help and registration
 * point are exactly as `CONTRACT.md` §10 specifies.
 */
export const settingsReadFailures = new Counter({
  name: 'threatlens_publication_settings_read_failures_total',
  help: 'Reads of runtime_settings that fell back to the safe default',
  registers: []
});

/** The typed rejection `saveRuntimeSettings` raises so the ops route can name the offending field. */
export class RuntimeSettingsRangeError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`runtime settings out of range: ${field}`);
    this.name = 'RuntimeSettingsRangeError';
    this.field = field;
  }
}

/**
 * Pure. Throws {@link RuntimeSettingsRangeError} naming ONE field, which is the whole point: a
 * refusal that does not say which of five numbers is wrong is the bug this delivery started from.
 *
 * Called inside `saveRuntimeSettings`'s `FOR UPDATE`, so it is authoritative rather than advisory.
 * The ops route runs the equivalent checks first (zod for the per-field ranges, the cross-field rule
 * against the stored row) as a fast path that produces a better message; neither of those can see
 * the combination two concurrent requests produce, and reaching the CHECK constraint instead would
 * give the operator a 500 with no `issues` array to act on.
 *
 * Field order is the order the console renders, so an operator who set several fields wrong is told
 * about the first one they would look at.
 */
export function validateRuntimeSettings(settings: RuntimeSettings): void {
  const fields: RuntimeSettingsBoundedField[] = [
    'analyticsDebounceMs', 'analyticsMaxDelayMs', 'analyticsMinPassIntervalMs', 'codexCooldownMs'
  ];
  for (const field of fields) {
    const value = settings[field];
    const { min, max } = RUNTIME_SETTINGS_BOUNDS[field];
    if (!Number.isInteger(value) || value < min || value > max) throw new RuntimeSettingsRangeError(field);
  }
  // The cross-field rule, `runtime_settings_delay_order` in migration 022. It names the MAXIMUM
  // rather than the debounce because the maximum is the field that has to move: a debounce of 0 is
  // legal beside every legal maximum, so the pair can only be violated from above.
  if (settings.analyticsMaxDelayMs < settings.analyticsDebounceMs) {
    throw new RuntimeSettingsRangeError('analyticsMaxDelayMs');
  }
}

interface SettingsRow {
  publication_mode: string;
  mode_changed_at: Date;
  analytics_event_driven: boolean;
  analytics_debounce_ms: number;
  analytics_max_delay_ms: number;
  analytics_min_pass_interval_ms: number;
  codex_cooldown_ms: number;
  updated_at: Date;
  updated_by: string;
}

const SETTINGS_COLUMNS = `publication_mode,mode_changed_at,analytics_event_driven,analytics_debounce_ms,
       analytics_max_delay_ms,analytics_min_pass_interval_ms,codex_cooldown_ms,updated_at,updated_by`;

/**
 * An unknown `publication_mode` is impossible through the CHECK and possible through a hand-edited
 * row or a database restored from a dump written before the constraint existed. It degrades to
 * `live` and counts, because the alternative — throwing out of a read the hub performs every second
 * — is the failure this module exists to not have.
 */
function toPublicationMode(value: string): PublicationMode {
  if ((PUBLICATION_MODES as readonly string[]).includes(value)) return value as PublicationMode;
  settingsReadFailures.inc();
  return 'live';
}

function fromRow(row: SettingsRow): RuntimeSettings {
  return {
    publicationMode: toPublicationMode(row.publication_mode),
    modeChangedAt: row.mode_changed_at.toISOString(),
    analyticsEventDriven: row.analytics_event_driven,
    analyticsDebounceMs: Number(row.analytics_debounce_ms),
    analyticsMaxDelayMs: Number(row.analytics_max_delay_ms),
    analyticsMinPassIntervalMs: Number(row.analytics_min_pass_interval_ms),
    codexCooldownMs: Number(row.codex_cooldown_ms),
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by
  };
}

/**
 * Pure. `undefined` keeps the current value, a value sets it. The three-way discipline
 * `codex-settings.test.ts` pins for `model` is preserved here so a `curl` that flips one field
 * cannot silently reset the other five — and so `analyticsEventDriven: false` is a *value*, which
 * is why every line below is `??` and never `||`. `analyticsDebounceMs: 0` is the same trap with a
 * number: since migration 028 zero is a legal, meaningful value («наживо»), and `||` would read it
 * as an absence and quietly keep the stored twenty seconds.
 *
 * `modeChangedAt` is deliberately not patchable: it is derived from `publication_mode` changing, by
 * the upsert, in the same statement as the mode it describes.
 */
export function applyRuntimeSettingsPatch(
  current: RuntimeSettings, patch: Partial<RuntimeSettings>
): RuntimeSettings {
  return {
    publicationMode: patch.publicationMode ?? current.publicationMode,
    modeChangedAt: current.modeChangedAt,
    analyticsEventDriven: patch.analyticsEventDriven ?? current.analyticsEventDriven,
    analyticsDebounceMs: patch.analyticsDebounceMs ?? current.analyticsDebounceMs,
    analyticsMaxDelayMs: patch.analyticsMaxDelayMs ?? current.analyticsMaxDelayMs,
    analyticsMinPassIntervalMs: patch.analyticsMinPassIntervalMs ?? current.analyticsMinPassIntervalMs,
    codexCooldownMs: patch.codexCooldownMs ?? current.codexCooldownMs,
    updatedAt: current.updatedAt,
    updatedBy: current.updatedBy
  };
}

/**
 * Pure. One row per *changed* field, which is what makes the audit table answerable by reading it
 * rather than by diffing two blobs. Column names are the SQL ones, because that is what an operator
 * reading `runtime_settings_audit` sees. `modeChangedAt` is absent from the list on purpose: an
 * audit row for it would double every mode change.
 */
export function runtimeSettingsDiff(
  before: RuntimeSettings, after: RuntimeSettings
): RuntimeSettingsChange[] {
  const FIELDS: Array<[keyof RuntimeSettings, string]> = [
    ['publicationMode', 'publication_mode'],
    ['analyticsEventDriven', 'analytics_event_driven'],
    ['analyticsDebounceMs', 'analytics_debounce_ms'],
    ['analyticsMaxDelayMs', 'analytics_max_delay_ms'],
    ['analyticsMinPassIntervalMs', 'analytics_min_pass_interval_ms'],
    ['codexCooldownMs', 'codex_cooldown_ms']
  ];
  const rows: RuntimeSettingsChange[] = [];
  for (const [key, column] of FIELDS) {
    if (before[key] === after[key]) continue;
    rows.push({ field: column, previousValue: String(before[key]), newValue: String(after[key]) });
  }
  return rows;
}

/**
 * The stored row, read straight from the database. No row means a dump older than migration 022 —
 * the migration seeds one, so this is belt and braces rather than a state the application produces.
 */
export async function readRuntimeSettings(): Promise<RuntimeSettings> {
  const result = await pool.query<SettingsRow>(
    `SELECT ${SETTINGS_COLUMNS} FROM runtime_settings WHERE singleton`
  );
  const row = result.rows[0];
  return row ? fromRow(row) : RUNTIME_SETTINGS_DEFAULTS;
}

/**
 * The memo holds the IN-FLIGHT PROMISE, stored synchronously before the await — not the resolved
 * value. Caching the value means a cache MISS is not deduplicated: one `eventHub` tick releases up
 * to 200 events, every `onEvent` awaits this, and all 200 reach the `cache &&` check before the
 * first SELECT resolves. Two hundred identical statements against a pool of twelve (two under
 * NODE_ENV=test) that is at the same moment serving the hub poll, the snapshot fan-out and the 15 s
 * ingestion tick, all under a 15 s statement_timeout — a thundering herd during exactly the mass
 * attack the debounce exists for.
 */
let cache: { at: number; value: Promise<RuntimeSettings> } | null = null;
let lastGood: RuntimeSettings | null = null;
let lastDegraded = false;

/**
 * `degraded` exists for one caller: the hub's first tick. Failing open on *publication timing* is a
 * deliberate policy; failing open on *cursor initialisation* silently drops data.
 */
export async function resolveRuntimeSettingsWithStatus(): Promise<{ settings: RuntimeSettings; degraded: boolean }> {
  const now = Date.now();
  if (!cache || now - cache.at >= RUNTIME_SETTINGS_TTL_MS) {
    const pending: Promise<RuntimeSettings> = readRuntimeSettings()
      .then((value) => { lastGood = value; lastDegraded = false; return value; })
      .catch(() => {
        // The slot is CLEARED, never poisoned with the default: the next caller retries the read
        // rather than being pinned to `live` for a whole TTL by one lost connection.
        if (cache?.value === pending) cache = null;
        lastDegraded = true;
        settingsReadFailures.inc();
        return lastGood ?? RUNTIME_SETTINGS_DEFAULTS;
      });
    cache = { at: now, value: pending };   // stored BEFORE the await — this is the whole point
  }
  const settings = await cache.value;
  return { settings, degraded: lastDegraded };
}

export async function resolveRuntimeSettings(): Promise<RuntimeSettings> {
  return (await resolveRuntimeSettingsWithStatus()).settings;
}

/**
 * Primed rather than merely cleared after a save: this process is the one that made the change, and
 * an operator who flips the switch and immediately reloads /ops must not be shown the old value for
 * up to a TTL by our own cache.
 */
function primeRuntimeSettingsCache(settings: RuntimeSettings): void {
  lastGood = settings;
  lastDegraded = false;
  cache = { at: Date.now(), value: Promise.resolve(settings) };
}

/** Test seam. The harness pool and the application pool are different pools, so a harness UPDATE is
 * invisible to this memo until it expires; an integration test that flips the mode and asserts
 * immediately must call this. */
export function resetRuntimeSettingsCache(): void {
  cache = null;
  lastGood = null;
  lastDegraded = false;
}

export async function saveRuntimeSettings(
  patch: Partial<RuntimeSettings>, changedBy: string
): Promise<{ settings: RuntimeSettings; changes: RuntimeSettingsChange[]; modeChanged: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentRow = (await client.query<SettingsRow>(
      `SELECT ${SETTINGS_COLUMNS} FROM runtime_settings WHERE singleton FOR UPDATE`
    )).rows[0];
    const before = currentRow ? fromRow(currentRow) : RUNTIME_SETTINGS_DEFAULTS;
    const after = applyRuntimeSettingsPatch(before, patch);
    // The AUTHORITATIVE range and cross-field check, inside the FOR UPDATE. The route's identical
    // pre-checks are a fast path only: two concurrent ops requests each read the pre-transaction
    // row, each pass a check against a value the other is about to change, and the combined row
    // violates `runtime_settings_delay_order` — which reaches the operator as the 500 the check
    // exists to prevent, with no `issues` array to act on.
    try {
      validateRuntimeSettings(after);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    const saved = fromRow((await client.query<SettingsRow>(
      `INSERT INTO runtime_settings(singleton,publication_mode,analytics_event_driven,
         analytics_debounce_ms,analytics_max_delay_ms,analytics_min_pass_interval_ms,
         codex_cooldown_ms,updated_at,updated_by)
       VALUES (true,$1,$2,$3,$4,$5,$6,now(),$7)
       ON CONFLICT (singleton) DO UPDATE SET
         publication_mode=EXCLUDED.publication_mode,
         analytics_event_driven=EXCLUDED.analytics_event_driven,
         analytics_debounce_ms=EXCLUDED.analytics_debounce_ms,
         analytics_max_delay_ms=EXCLUDED.analytics_max_delay_ms,
         analytics_min_pass_interval_ms=EXCLUDED.analytics_min_pass_interval_ms,
         codex_cooldown_ms=EXCLUDED.codex_cooldown_ms,
         updated_at=now(), updated_by=EXCLUDED.updated_by,
         -- In the SAME statement as the mode it describes, so no reader can see one without the
         -- other, and so the cutoff clamp survives a restart. Every public read computes
         -- GREATEST(now() - delay, mode_changed_at); moving it on any save (rather than only on a
         -- real mode change) would re-freeze the cutoff every time an operator edits the debounce.
         mode_changed_at = CASE
           WHEN runtime_settings.publication_mode IS DISTINCT FROM EXCLUDED.publication_mode
           THEN now() ELSE runtime_settings.mode_changed_at END
       RETURNING ${SETTINGS_COLUMNS}`,
      [after.publicationMode, after.analyticsEventDriven, after.analyticsDebounceMs,
        after.analyticsMaxDelayMs, after.analyticsMinPassIntervalMs, after.codexCooldownMs,
        changedBy]
    )).rows[0]!);

    const changes = runtimeSettingsDiff(before, saved);
    for (const change of changes) {
      await client.query(
        `INSERT INTO runtime_settings_audit(changed_by,field,previous_value,new_value,source)
         VALUES ($1,$2,$3,$4,'ops_api')`,
        [changedBy, change.field, change.previousValue, change.newValue]
      );
    }

    const modeChanged = before.publicationMode !== saved.publicationMode;
    if (modeChanged) {
      // In the SAME transaction as the row it describes, so a reader of the log can never see a
      // mode change announced for a setting that was rolled back.
      await client.query(
        `INSERT INTO system_event_log(event_type,payload) VALUES ('publication.changed',$1)`,
        [JSON.stringify({
          mode: saved.publicationMode,
          delaySeconds: saved.publicationMode === 'delayed_15s' ? config.PUBLICATION_DELAY_SECONDS : 0,
          changedBy,
          changedAt: saved.updatedAt
        })]
      );
    }
    await client.query('COMMIT');
    primeRuntimeSettingsCache(saved);
    return { settings: saved, changes, modeChanged };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * `ORDER BY changed_at DESC, id DESC` — two fields changed in one save share `now()` to the
 * microsecond in one transaction, and `id DESC` is what keeps that pair in a stable order between
 * two reads.
 */
export async function readRuntimeSettingsAudit(limit = 20): Promise<RuntimeSettingsAuditRow[]> {
  const result = await pool.query<{
    changed_at: Date; changed_by: string; field: string;
    previous_value: string | null; new_value: string; source: RuntimeSettingsAuditRow['source'];
  }>(
    `SELECT changed_at,changed_by,field,previous_value,new_value,source
       FROM runtime_settings_audit ORDER BY changed_at DESC, id DESC LIMIT $1`,
    [limit]
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
