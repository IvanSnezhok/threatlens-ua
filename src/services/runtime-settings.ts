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
  codexCooldownMs: 900_000,
  updatedAt: null,
  updatedBy: null
};

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

interface SettingsRow {
  publication_mode: string;
  mode_changed_at: Date;
  analytics_event_driven: boolean;
  analytics_debounce_ms: number;
  analytics_max_delay_ms: number;
  codex_cooldown_ms: number;
  updated_at: Date;
  updated_by: string;
}

const SETTINGS_COLUMNS = `publication_mode,mode_changed_at,analytics_event_driven,analytics_debounce_ms,
       analytics_max_delay_ms,codex_cooldown_ms,updated_at,updated_by`;

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
    codexCooldownMs: Number(row.codex_cooldown_ms),
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by
  };
}

/**
 * Pure. `undefined` keeps the current value, a value sets it. The three-way discipline
 * `codex-settings.test.ts` pins for `model` is preserved here so a `curl` that flips one field
 * cannot silently reset the other four — and so `analyticsEventDriven: false` is a *value*, which
 * is why every line below is `??` and never `||`.
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
    // The AUTHORITATIVE cross-field check, inside the FOR UPDATE. The route's identical pre-check is
    // a fast path only: two concurrent ops requests each read the pre-transaction row, each pass a
    // check against a value the other is about to change, and the combined row violates
    // `runtime_settings_delay_order` — which reaches the operator as the 500 the check exists to
    // prevent, with no `issues` array to act on.
    if (after.analyticsMaxDelayMs < after.analyticsDebounceMs) {
      await client.query('ROLLBACK');
      throw new RuntimeSettingsRangeError('analyticsMaxDelayMs');
    }
    const saved = fromRow((await client.query<SettingsRow>(
      `INSERT INTO runtime_settings(singleton,publication_mode,analytics_event_driven,
         analytics_debounce_ms,analytics_max_delay_ms,codex_cooldown_ms,updated_at,updated_by)
       VALUES (true,$1,$2,$3,$4,$5,now(),$6)
       ON CONFLICT (singleton) DO UPDATE SET
         publication_mode=EXCLUDED.publication_mode,
         analytics_event_driven=EXCLUDED.analytics_event_driven,
         analytics_debounce_ms=EXCLUDED.analytics_debounce_ms,
         analytics_max_delay_ms=EXCLUDED.analytics_max_delay_ms,
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
        after.analyticsMaxDelayMs, after.codexCooldownMs, changedBy]
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
