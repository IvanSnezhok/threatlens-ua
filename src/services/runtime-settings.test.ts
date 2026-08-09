import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The decisions an operator makes in `/ops`, resolved without a database.
 *
 * Two things are pinned here and nowhere else. The pure half — patch and diff — is where a wrong
 * answer is silent: a `curl` that flips one field must not reset the other four, `false` must be a
 * value rather than an absence, and the audit rows must carry SQL column names and stringified
 * values or the trail becomes unreadable at exactly the moment somebody needs it. The memo half is
 * where a wrong answer is loud but only under load: `resolveRuntimeSettings()` sits in front of the
 * hub's one-second tick, and a memo that stores the resolved value instead of the in-flight promise
 * turns one tick into two hundred identical SELECTs against a pool of two.
 *
 * `pool` is mocked rather than reached, so this file stays in the unit project.
 */

const query = vi.fn();
vi.mock('../db/pool.js', () => ({ pool: { query: (...args: unknown[]) => query(...args), connect: vi.fn() } }));

const {
  RUNTIME_SETTINGS_BOUNDS,
  RUNTIME_SETTINGS_DEFAULTS,
  RuntimeSettingsRangeError,
  applyRuntimeSettingsPatch,
  resetRuntimeSettingsCache,
  resolveRuntimeSettings,
  resolveRuntimeSettingsWithStatus,
  runtimeSettingsDiff,
  validateRuntimeSettings
} = await import('./runtime-settings.js');

type RuntimeSettings = typeof RUNTIME_SETTINGS_DEFAULTS;

const stored: RuntimeSettings = {
  publicationMode: 'live',
  modeChangedAt: '2026-08-08T09:00:00.000Z',
  analyticsEventDriven: true,
  analyticsDebounceMs: 20_000,
  analyticsMaxDelayMs: 120_000,
  analyticsMinPassIntervalMs: 60_000,
  codexCooldownMs: 900_000,
  updatedAt: '2026-08-08T09:00:00.000Z',
  updatedBy: 'operator'
};

function settingsRow(overrides: Record<string, unknown> = {}) {
  return {
    publication_mode: 'delayed_15s',
    mode_changed_at: new Date('2026-08-08T09:00:00.000Z'),
    analytics_event_driven: true,
    analytics_debounce_ms: 20_000,
    analytics_max_delay_ms: 120_000,
    analytics_min_pass_interval_ms: 60_000,
    codex_cooldown_ms: 900_000,
    updated_at: new Date('2026-08-08T09:00:00.000Z'),
    updated_by: 'operator',
    ...overrides
  };
}

/** The field the console renders, and the name a 400 has to carry back to it. */
function rejects(patch: Partial<RuntimeSettings>, field: string): void {
  const next = applyRuntimeSettingsPatch(stored, patch);
  expect(() => validateRuntimeSettings(next)).toThrow(RuntimeSettingsRangeError);
  try {
    validateRuntimeSettings(next);
  } catch (error) {
    expect((error as InstanceType<typeof RuntimeSettingsRangeError>).field).toBe(field);
  }
}

beforeEach(() => {
  query.mockReset();
  resetRuntimeSettingsCache();
});

afterEach(() => {
  resetRuntimeSettingsCache();
});

describe('applying an operator patch', () => {
  it('keeps every field an empty patch omits', () => {
    expect(applyRuntimeSettingsPatch(stored, {})).toEqual(stored);
  });

  it('sets only the fields present', () => {
    const next = applyRuntimeSettingsPatch(stored, { publicationMode: 'delayed_15s' });
    expect(next.publicationMode).toBe('delayed_15s');
    expect([next.analyticsDebounceMs, next.analyticsMaxDelayMs, next.analyticsMinPassIntervalMs,
      next.codexCooldownMs]).toEqual([20_000, 120_000, 60_000, 900_000]);
    expect(next.analyticsEventDriven).toBe(true);
  });

  it('sets the minimum pass interval on its own without disturbing the delays', () => {
    const next = applyRuntimeSettingsPatch(stored, { analyticsMinPassIntervalMs: 5_000 });
    expect(next.analyticsMinPassIntervalMs).toBe(5_000);
    expect([next.analyticsDebounceMs, next.analyticsMaxDelayMs]).toEqual([20_000, 120_000]);
  });

  it('treats false as a value, not as absent', () => {
    // Guards the `||` regression: `patch.analyticsEventDriven || current.analyticsEventDriven`
    // silently ignores every request that switches the recompute off.
    expect(applyRuntimeSettingsPatch(stored, { analyticsEventDriven: false }).analyticsEventDriven)
      .toBe(false);
  });

  it('treats a debounce of zero as a value, not as absent', () => {
    // The same `||` trap with a number, and the reported bug's shape: since migration 028 zero is
    // the legal «наживо» setting, and `||` would silently keep the stored twenty seconds — a save
    // that reports success and changes nothing.
    expect(applyRuntimeSettingsPatch(stored, { analyticsDebounceMs: 0 }).analyticsDebounceMs).toBe(0);
  });

  it('never lets a patch move modeChangedAt', () => {
    // It is derived from the mode changing, by the upsert, in the same statement as the mode.
    const next = applyRuntimeSettingsPatch(stored, { modeChangedAt: '2020-01-01T00:00:00.000Z' });
    expect(next.modeChangedAt).toBe(stored.modeChangedAt);
  });
});

describe('the audit diff', () => {
  it('emits one row per changed field, named as its column', () => {
    const after = { ...stored, publicationMode: 'delayed_15s' as const, analyticsDebounceMs: 30_000 };
    expect(runtimeSettingsDiff(stored, after)).toEqual([
      { field: 'publication_mode', previousValue: 'live', newValue: 'delayed_15s' },
      { field: 'analytics_debounce_ms', previousValue: '20000', newValue: '30000' }
    ]);
  });

  it('emits nothing for an identical save', () => {
    expect(runtimeSettingsDiff(stored, { ...stored })).toEqual([]);
  });

  it('stringifies booleans and numbers', () => {
    const after = { ...stored, analyticsEventDriven: false, analyticsMaxDelayMs: 600_000 };
    const rows = runtimeSettingsDiff(stored, after);
    expect(rows.map((row) => row.newValue)).toEqual(['false', '600000']);
    expect(rows.map((row) => row.previousValue)).toEqual(['true', '120000']);
  });

  it('ignores modeChangedAt so a mode change is not counted twice', () => {
    const after = { ...stored, modeChangedAt: '2026-08-08T10:00:00.000Z' };
    expect(runtimeSettingsDiff(stored, after)).toEqual([]);
  });

  it('records the minimum pass interval under its SQL name', () => {
    // The field migration 028 moved out of the compiler. An operator asking «хто зробив аналітику
    // повільнішою» reads `runtime_settings_audit`, so it has to be in the trail like the rest.
    const after = { ...stored, analyticsMinPassIntervalMs: 5_000 };
    expect(runtimeSettingsDiff(stored, after)).toEqual([
      { field: 'analytics_min_pass_interval_ms', previousValue: '60000', newValue: '5000' }
    ]);
  });

  it('records a debounce lowered to zero rather than reading it as no change', () => {
    const after = { ...stored, analyticsDebounceMs: 0 };
    expect(runtimeSettingsDiff(stored, after)).toEqual([
      { field: 'analytics_debounce_ms', previousValue: '20000', newValue: '0' }
    ]);
  });
});

describe('the range check that names the field', () => {
  it('accepts the наживо combination the product owner asked for', () => {
    // «Для наживо режиму затримки мають бути мінімальні»: debounce 0, and the storm guard turned
    // down to its own floor. This is the exact save the /ops card used to refuse without saying why.
    const next = applyRuntimeSettingsPatch(stored, {
      analyticsDebounceMs: 0, analyticsMinPassIntervalMs: 5_000
    });
    expect(() => validateRuntimeSettings(next)).not.toThrow();
  });

  it('refuses a minimum pass interval below its floor, naming it', () => {
    // 0 is legal for the debounce and illegal here on purpose: at zero the overlap guard would be
    // the only thing between a sustained stream and back-to-back view refreshes plus a risk pass.
    rejects({ analyticsMinPassIntervalMs: 0 }, 'analyticsMinPassIntervalMs');
    rejects({ analyticsMinPassIntervalMs: 4_999 }, 'analyticsMinPassIntervalMs');
  });

  it('refuses a minimum pass interval above the quiet-period floor, naming it', () => {
    // Longer than ANALYTICS_RECOMPUTE_FLOOR_MS would mean the floor's own pass is refused by the
    // interval and the analytics have no cadence at all.
    rejects({ analyticsMinPassIntervalMs: 900_001 }, 'analyticsMinPassIntervalMs');
  });

  it('refuses a negative debounce while allowing zero', () => {
    rejects({ analyticsDebounceMs: -1 }, 'analyticsDebounceMs');
    expect(() => validateRuntimeSettings(applyRuntimeSettingsPatch(stored, { analyticsDebounceMs: 0 })))
      .not.toThrow();
  });

  it('still refuses a maximum delay below the debounce, naming the maximum', () => {
    // The cross-field rule of migration 022 (`runtime_settings_delay_order`), unchanged by 028 and
    // still satisfiable with a debounce of zero: the maximum keeps its own floor of five seconds.
    rejects({ analyticsDebounceMs: 60_000, analyticsMaxDelayMs: 30_000 }, 'analyticsMaxDelayMs');
    expect(() => validateRuntimeSettings(applyRuntimeSettingsPatch(stored, {
      analyticsDebounceMs: 0, analyticsMaxDelayMs: 5_000
    }))).not.toThrow();
  });

  it('publishes a range for every numeric field the console renders', () => {
    // The bug was a refusal with no bounds to show. `GET /ops/api/runtime` ships this object, so a
    // field missing from it is a field whose input has no min/max.
    expect(Object.keys(RUNTIME_SETTINGS_BOUNDS).sort()).toEqual([
      'analyticsDebounceMs', 'analyticsMaxDelayMs', 'analyticsMinPassIntervalMs', 'codexCooldownMs'
    ]);
    expect(RUNTIME_SETTINGS_BOUNDS.analyticsDebounceMs.min).toBe(0);
    expect(RUNTIME_SETTINGS_BOUNDS.analyticsMinPassIntervalMs).toEqual({ min: 5_000, max: 900_000 });
  });
});

describe('the defaults a failed read falls back to', () => {
  it('publishes live', () => {
    // The property that makes migration 022 safe on a running deployment: nothing about installing
    // the table changes what the installation publishes.
    expect(RUNTIME_SETTINGS_DEFAULTS.publicationMode).toBe('live');
  });
});

describe('the settings memo', () => {
  it('deduplicates a burst of concurrent reads into one statement', async () => {
    // One `eventHub` tick releases up to 200 events and every one of them awaits this. A memo that
    // stored the resolved value would let all of them miss before the first SELECT resolved.
    let resolveRead: ((rows: unknown) => void) | null = null;
    query.mockImplementation(() => new Promise((resolve) => { resolveRead = resolve; }));

    const pending = Array.from({ length: 20 }, () => resolveRuntimeSettings());
    await Promise.resolve();
    expect(query).toHaveBeenCalledTimes(1);

    resolveRead!({ rows: [settingsRow()] });
    const results = await Promise.all(pending);
    expect(query).toHaveBeenCalledTimes(1);
    expect(results.every((value) => value.publicationMode === 'delayed_15s')).toBe(true);
  });

  it('reports degraded and does not pin the memo when the read rejects', async () => {
    query.mockRejectedValueOnce(new Error('connection terminated'));
    const first = await resolveRuntimeSettingsWithStatus();
    expect(first.degraded).toBe(true);
    expect(first.settings.publicationMode).toBe('live');

    // The slot is cleared rather than poisoned with the default: the very next caller retries
    // instead of being pinned to `live` for a whole TTL by one lost connection.
    query.mockResolvedValueOnce({ rows: [settingsRow()] });
    const second = await resolveRuntimeSettingsWithStatus();
    expect(query).toHaveBeenCalledTimes(2);
    expect(second.degraded).toBe(false);
    expect(second.settings.publicationMode).toBe('delayed_15s');
  });
});
