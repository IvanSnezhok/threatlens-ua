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
  RUNTIME_SETTINGS_DEFAULTS,
  applyRuntimeSettingsPatch,
  resetRuntimeSettingsCache,
  resolveRuntimeSettings,
  resolveRuntimeSettingsWithStatus,
  runtimeSettingsDiff
} = await import('./runtime-settings.js');

type RuntimeSettings = typeof RUNTIME_SETTINGS_DEFAULTS;

const stored: RuntimeSettings = {
  publicationMode: 'live',
  modeChangedAt: '2026-08-08T09:00:00.000Z',
  analyticsEventDriven: true,
  analyticsDebounceMs: 20_000,
  analyticsMaxDelayMs: 120_000,
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
    codex_cooldown_ms: 900_000,
    updated_at: new Date('2026-08-08T09:00:00.000Z'),
    updated_by: 'operator',
    ...overrides
  };
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
    expect([next.analyticsDebounceMs, next.analyticsMaxDelayMs, next.codexCooldownMs])
      .toEqual([20_000, 120_000, 900_000]);
    expect(next.analyticsEventDriven).toBe(true);
  });

  it('treats false as a value, not as absent', () => {
    // Guards the `||` regression: `patch.analyticsEventDriven || current.analyticsEventDriven`
    // silently ignores every request that switches the recompute off.
    expect(applyRuntimeSettingsPatch(stored, { analyticsEventDriven: false }).analyticsEventDriven)
      .toBe(false);
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
