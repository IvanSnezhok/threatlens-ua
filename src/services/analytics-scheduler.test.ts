import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The three legs of a pass and the audit row, stubbed at module level.
 *
 * A pass is the one thing in this file that cannot be driven through the `deps` bag: its legs are
 * imports, not parameters, deliberately — `recomputeAnalytics` is the place where "what a recompute
 * consists of" is stated once, and threading four more injection points through it to test the
 * cadence of one of them would move that statement into the callers.
 */
const legs = vi.hoisted(() => ({
  refresh: 0, risk: 0, warm: 0, tactics: 0, eventRows: [] as unknown[][],
  /** Set to make the materialised-view refresh reject, the way a 15 s `statement_timeout` does. */
  refreshError: null as Error | null,
  /** One entry per risk leg: whether that pass was allowed to spend the model. */
  riskModel: [] as boolean[]
}));

vi.mock('./analytics.js', () => ({
  refreshMonthlyAnalytics: async () => {
    legs.refresh += 1;
    if (legs.refreshError) throw legs.refreshError;
    return true;
  }
}));
vi.mock('./risk.js', () => ({
  runRiskAssessmentsGuarded: async (options: { allowModel?: boolean } = {}) => {
    legs.risk += 1;
    legs.riskModel.push(options.allowModel ?? true);
    return { published: 3, skipped: false };
  }
}));
vi.mock('./attack-analytics.js', () => ({ resetAttackAnalyticsCache: () => undefined }));
vi.mock('../db/pool.js', () => ({
  pool: { query: async (...args: unknown[]) => { legs.eventRows.push(args); return { rows: [], rowCount: 0 }; } }
}));
vi.mock('./attack-tactics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./attack-tactics.js')>()),
  runTacticsPass: async () => {
    legs.tactics += 1;
    return {
      outcome: 'insufficient' as const, passId: null, digest: null, detections: 0, currentMessages: 0
    };
  }
}));
vi.mock('./analytics-narrative.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./analytics-narrative.js')>()),
  warmNarrative: async () => {
    legs.warm += 1;
    return { codex: 'disabled' as const, fallback: false, narrative: null };
  }
}));
import {
  ANALYTICS_RECOMPUTE_FLOOR_MS, ANALYTICS_TRIGGER_EVENTS,
  recomputeAnalytics, resetAnalyticsScheduler, runManualRecompute,
  startAnalyticsRecomputeScheduler, type AnalyticsSchedulerDeps, type AnalyticsTimerKind,
  type RecomputeResult, type RecomputeTrigger
} from './analytics-scheduler.js';
import { withinCodexCooldown } from './analytics-narrative.js';
import { RUNTIME_SETTINGS_DEFAULTS, type RuntimeSettings } from './runtime-settings.js';
import type { SystemEvent } from './sse.js';

/**
 * The interval a deployment that has never touched /ops runs with.
 *
 * It used to be a constant exported from the scheduler itself. Migration 028 moved
 * the number into `runtime_settings.analytics_min_pass_interval_ms` and the constant went with it,
 * so the default now comes from the same place a failed settings read falls back to.
 */
const MIN_PASS_INTERVAL_MS = RUNTIME_SETTINGS_DEFAULTS.analyticsMinPassIntervalMs;

/**
 * The debounce, and the four ways it can silently stop recomputing.
 *
 * Everything here runs against an injected clock, an injected timer seam and a fake emitter, so no
 * test in this file touches PostgreSQL, a real `setTimeout` or the process-wide event hub. That is
 * not only speed: the properties worth pinning are *ordering* properties — a fire that lands during
 * a pass, a stop that lands between an `if` and a `finally` — and a real timer cannot be asked to
 * land anywhere in particular.
 *
 * There are no fake timers. This repo has none anywhere, and they interact badly with the `await`
 * inside `onEvent`: the settings read is a promise, so the handler is not finished when the emit
 * returns and a fake clock advanced synchronously would fire a window that had not been armed yet.
 */

// ------------------------------------------------------------------------------------------------
// Harness
// ------------------------------------------------------------------------------------------------

interface ArmedTimer { id: number; fn: () => void; ms: number; kind: AnalyticsTimerKind; cleared: boolean }

function harness(overrides: Partial<RuntimeSettings> = {}, schedulerDeps: AnalyticsSchedulerDeps = {}) {
  let clock = 1_000_000;                        // never 0: a zero clock reads as "no pass ever ran"
  const armed: ArmedTimer[] = [];
  let nextId = 1;

  const listeners = new Map<string, Set<(event: SystemEvent) => void>>();
  const events = {
    on(name: string, fn: (event: SystemEvent) => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(fn);
      return events;
    },
    off(name: string, fn: (event: SystemEvent) => void) {
      listeners.get(name)?.delete(fn);
      return events;
    },
    emit(name: string, event: SystemEvent) {
      for (const fn of [...(listeners.get(name) ?? [])]) fn(event);
    },
    count(name: string) { return listeners.get(name)?.size ?? 0; }
  };

  const settings: RuntimeSettings = {
    ...RUNTIME_SETTINGS_DEFAULTS, analyticsDebounceMs: 20_000, analyticsMaxDelayMs: 120_000,
    ...overrides
  };

  const calls: RecomputeTrigger[] = [];
  let pending: { resolve: (value: RecomputeResult) => void } | null = null;
  let holdNext = false;

  const result = (trigger: RecomputeTrigger): RecomputeResult => ({
    recomputedAt: new Date(clock).toISOString(), durationMs: 1, trigger,
    codex: 'disabled', fallback: false, published: 0, skipped: null
  });

  const deps: AnalyticsSchedulerDeps = {
    now: () => clock,
    timers: {
      set(fn, ms, kind) {
        const handle: ArmedTimer = { id: nextId++, fn, ms, kind, cleared: false };
        armed.push(handle);
        return handle;
      },
      clear(handle) { if (handle) (handle as ArmedTimer).cleared = true; }
    },
    events,
    settings: async () => settings,
    recompute: async (trigger) => {
      calls.push(trigger);
      if (!holdNext) return result(trigger);
      holdNext = false;
      return new Promise<RecomputeResult>((resolve) => { pending = { resolve: () => resolve(result(trigger)) }; });
    },
    ...schedulerDeps
  };

  /**
   * Live (not cleared) timers, by which of the scheduler's three slots they were armed for.
   *
   * The `kind` label is the reason the scheduler's timer seam takes a third argument: filtering by
   * delay used to be good enough, and stopped being so the moment a retry could legitimately be
   * armed for the same number of milliseconds as a debounce window.
   */
  const live = (kind: AnalyticsTimerKind) => armed.filter((entry) => !entry.cleared && entry.kind === kind);
  const liveWindows = () => live('debounce');
  const liveFloors = () => live('floor');
  const liveRetries = () => live('interval-retry');

  const fireOne = (kind: AnalyticsTimerKind) => {
    const handle = live(kind).at(-1);
    if (!handle) throw new Error(`no ${kind} timer is armed`);
    handle.cleared = true;
    handle.fn();
  };

  return {
    deps, events, settings, calls, armed,
    liveWindows, liveFloors, liveRetries,
    advance(ms: number) { clock += ms; },
    at: () => clock,
    holdNextPass() { holdNext = true; },
    releasePass() { pending?.resolve({} as RecomputeResult); pending = null; },
    /** Fires the newest still-armed debounce window, exactly as a real timer would. */
    fireWindow() { fireOne('debounce'); },
    fireFloor() { fireOne('floor'); },
    /** Fires the retry the minimum-interval guard armed. Advances the clock to its expiry first,
     *  because a real timer cannot run before its delay has elapsed and the guard re-checks. */
    fireRetry() {
      const retry = liveRetries().at(-1);
      if (!retry) throw new Error('no interval retry is armed');
      clock += retry.ms;
      retry.cleared = true;
      retry.fn();
    }
  };
}

function event(eventType: string, version = 1): SystemEvent {
  return { version, eventType, payload: {}, createdAt: new Date().toISOString() };
}

/** One macrotask, which is enough for `onEvent`'s awaited settings read to have finished. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function emit(h: ReturnType<typeof harness>, eventType: string, version = 1): Promise<void> {
  h.events.emit('internal-event', event(eventType, version));
  await settle();
}

beforeEach(() => {
  resetAnalyticsScheduler();
  legs.refresh = 0; legs.risk = 0; legs.warm = 0; legs.tactics = 0; legs.eventRows = [];
  legs.refreshError = null; legs.riskModel = [];
});
afterEach(() => { resetAnalyticsScheduler(); });

const log = { info: () => undefined, error: () => undefined };

// ------------------------------------------------------------------------------------------------
// The debounce
// ------------------------------------------------------------------------------------------------

describe('the debounce window', () => {
  it('coalesces a burst of ten events into one recompute', async () => {
    const h = harness();
    startAnalyticsRecomputeScheduler(log, h.deps);
    for (let index = 0; index < 10; index += 1) await emit(h, 'threat.created', index + 1);

    expect(h.calls).toEqual([]);
    h.fireWindow();
    await settle();
    expect(h.calls).toEqual(['event']);
  });

  it('re-arms the window on every event instead of firing at the first', async () => {
    const h = harness();
    startAnalyticsRecomputeScheduler(log, h.deps);
    await emit(h, 'threat.created', 1);
    await emit(h, 'alert.started', 2);
    await emit(h, 'threat.updated', 3);

    // Three windows were set, two were cleared, and the survivor carries the full debounce — an
    // event three seconds into the window must not fire seventeen seconds early.
    const windows = h.armed.filter((entry) => entry.ms === h.settings.analyticsDebounceMs);
    expect(windows).toHaveLength(3);
    expect(windows.filter((entry) => !entry.cleared)).toHaveLength(1);
    expect(h.liveWindows()[0]!.ms).toBe(20_000);
  });

  it('fires at analyticsMaxDelayMs when the window is continuously re-armed', async () => {
    const h = harness({ analyticsDebounceMs: 20_000, analyticsMaxDelayMs: 60_000 });
    startAnalyticsRecomputeScheduler(log, h.deps);

    // An event every 19 s: the trailing edge is never reached, so without the starvation guard the
    // pass would never run — and "the events keep coming" is exactly a mass attack.
    for (let index = 0; index < 3; index += 1) {
      await emit(h, 'threat.created', index + 1);
      h.advance(19_000);
    }
    expect(h.calls).toEqual([]);

    h.advance(10_000);                     // now 67 s past the first pending event
    await emit(h, 'threat.created', 4);
    expect(h.calls).toEqual(['event']);
    await settle();

    // `firstPendingAt` was drained by `execute()`, so the next event starts a fresh window rather
    // than tripping the guard again immediately.
    await emit(h, 'threat.created', 5);
    expect(h.calls).toEqual(['event']);
    expect(h.liveWindows()).toHaveLength(1);
  });

  it('ignores event types that are not threat or alert lifecycle', async () => {
    const h = harness();
    startAnalyticsRecomputeScheduler(log, h.deps);
    for (const type of ['source.stale', 'source.recovered', 'publication.changed', 'analytics.updated']) {
      await emit(h, type);
    }
    expect(h.armed.filter((entry) => entry.kind !== 'floor')).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('assessment.updated never re-triggers a recompute', async () => {
    // Named separately because it is the one that would run the risk engine for ever: the recompute
    // writes `assessment.updated`, so subscribing to it would make every pass schedule the next.
    expect(ANALYTICS_TRIGGER_EVENTS).not.toContain('assessment.updated');
    const h = harness();
    startAnalyticsRecomputeScheduler(log, h.deps);
    await emit(h, 'assessment.updated');
    expect(h.calls).toEqual([]);
    expect(h.liveWindows()).toEqual([]);
  });

  it('subscribes to the internal feed, not the published one', async () => {
    const h = harness();
    const on = vi.spyOn(h.events, 'on');
    startAnalyticsRecomputeScheduler(log, h.deps);
    expect(on.mock.calls[0]![0]).toBe('internal-event');
    // The published feed is head-bounded by the publication cutoff; a scheduler listening there
    // would make the map's аналітична оцінка pay the delay twice.
    expect(h.events.count('event')).toBe(0);
    expect(h.events.count('internal-event')).toBe(1);
  });

  it('returns immediately when analyticsEventDriven is false', async () => {
    const h = harness({ analyticsEventDriven: false });
    startAnalyticsRecomputeScheduler(log, h.deps);
    await emit(h, 'threat.created');
    expect(h.liveWindows()).toEqual([]);
    expect(h.calls).toEqual([]);

    // The switch is a database row read on every event, so flipping it back takes effect on the
    // next event without a restart.
    h.settings.analyticsEventDriven = true;
    await emit(h, 'threat.created', 2);
    expect(h.liveWindows()).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------------------------------
// Overlap, re-arm and the manual pass
// ------------------------------------------------------------------------------------------------

describe('the overlap guard', () => {
  it('drops a concurrent fire and re-arms exactly once', async () => {
    const h = harness();
    startAnalyticsRecomputeScheduler(log, h.deps);
    h.holdNextPass();
    await emit(h, 'threat.created', 1);
    h.fireWindow();
    await settle();
    expect(h.calls).toEqual(['event']);

    // Three more fires land while the pass is in flight. `running` is owned by `execute()`, so all
    // three are refused here — and they must collapse into ONE re-armed window, not three.
    for (let index = 0; index < 3; index += 1) {
      await emit(h, 'threat.created', index + 2);
      h.fireWindow();
    }
    expect(h.calls).toEqual(['event']);

    h.releasePass();
    await settle();
    expect(h.liveWindows()).toHaveLength(1);
    // The pass that just completed stamped the completed-pass clock, so the re-armed window is
    // inside the minimum interval; this test is about the re-arm, not about that guard.
    h.advance(MIN_PASS_INTERVAL_MS);
    h.fireWindow();
    await settle();
    expect(h.calls).toEqual(['event', 'event']);
  });

  it('a manual pass drains the pending re-arm', async () => {
    const h = harness();
    startAnalyticsRecomputeScheduler(log, h.deps);
    h.holdNextPass();
    const manual = runManualRecompute();
    await settle();
    expect(h.calls).toEqual(['manual']);

    // A debounce window fires while the operator's pass is still running.
    await emit(h, 'threat.created', 1);
    h.fireWindow();
    expect(h.calls).toEqual(['manual']);

    h.releasePass();
    await manual;
    await settle();

    // Exactly one further pass is armed, and it runs. Without `runManualRecompute` going through
    // `execute()`, `rearm` would never be drained and the whole burst would be swallowed until the
    // fifteen-minute floor.
    expect(h.liveWindows()).toHaveLength(1);
    h.advance(MIN_PASS_INTERVAL_MS);              // the manual pass completed; clear its interval
    h.fireWindow();
    await settle();
    expect(h.calls).toEqual(['manual', 'event']);
  });

  it('refuses a second manual pass while the first is in flight', async () => {
    const h = harness();
    startAnalyticsRecomputeScheduler(log, h.deps);
    h.holdNextPass();
    const first = runManualRecompute();
    await settle();
    const second = await runManualRecompute();
    expect(second).toMatchObject({ trigger: 'manual', skipped: 'overlap', durationMs: 0 });
    expect(h.calls).toEqual(['manual']);
    h.releasePass();
    await first;
  });
});

// ------------------------------------------------------------------------------------------------
// Start, stop and the floor
// ------------------------------------------------------------------------------------------------

describe('start and stop', () => {
  it('a second start returns the existing stop closure', () => {
    const h = harness();
    const first = startAnalyticsRecomputeScheduler(log, h.deps);
    const second = startAnalyticsRecomputeScheduler(log, h.deps);
    expect(second).toBe(first);
    expect(h.events.count('internal-event')).toBe(1);
    expect(h.liveFloors()).toHaveLength(1);
    first();
    expect(h.events.count('internal-event')).toBe(0);
  });

  it('the stop closure removes the listener and clears both timers', async () => {
    const h = harness();
    const off = vi.spyOn(h.events, 'off');
    const stop = startAnalyticsRecomputeScheduler(log, h.deps);
    await emit(h, 'threat.created');
    expect(h.liveWindows()).toHaveLength(1);

    stop();
    expect(off.mock.calls[0]![0]).toBe('internal-event');
    expect(h.events.count('internal-event')).toBe(0);
    expect(h.liveWindows()).toEqual([]);
    expect(h.liveFloors()).toEqual([]);

    // A later emit reaches nobody.
    await emit(h, 'threat.created', 2);
    expect(h.calls).toEqual([]);
  });

  it('stopping mid-pass arms nothing afterwards', async () => {
    const h = harness();
    const stop = startAnalyticsRecomputeScheduler(log, h.deps);
    h.holdNextPass();
    await emit(h, 'threat.created', 1);
    h.fireWindow();
    await settle();

    // A fire lands during the pass and sets `rearm`, then the scheduler is stopped.
    await emit(h, 'threat.created', 2);
    h.fireWindow();
    // The floor chain is the one that re-arms itself, so it is the handle a stop can race.
    const staleFloor = h.liveFloors().at(-1)!;
    stop();

    h.releasePass();
    await settle();
    expect(h.liveWindows()).toEqual([]);

    // A stale handle that fires anyway must do nothing and must not re-arm itself: the generation
    // token is what makes that true, and without it a torn-down scheduler keeps calling a pool
    // `index.ts` has already ended, into every later test file.
    h.advance(ANALYTICS_RECOMPUTE_FLOOR_MS);
    staleFloor.fn();
    await settle();
    expect(h.calls).toEqual(['event']);
    expect(h.liveFloors()).toEqual([]);
  });

  it('the floor fires a schedule-triggered recompute only after a quiet interval', async () => {
    const h = harness();
    startAnalyticsRecomputeScheduler(log, h.deps);
    expect(h.liveFloors()).toHaveLength(1);

    // A pass has just completed: the floor must not add a second one on top of it.
    await emit(h, 'threat.created', 1);
    h.fireWindow();
    await settle();
    expect(h.calls).toEqual(['event']);

    h.fireFloor();
    await settle();
    expect(h.calls).toEqual(['event']);
    expect(h.liveFloors()).toHaveLength(1);        // re-armed either way

    h.advance(ANALYTICS_RECOMPUTE_FLOOR_MS);
    h.fireFloor();
    await settle();
    expect(h.calls).toEqual(['event', 'schedule']);
    expect(h.liveFloors()).toHaveLength(1);
  });

  it('does not subscribe at all when ANALYTICS_EVENT_DRIVEN_ENABLED is false', async () => {
    // The deployment-level kill switch is read from `config`, which parses `process.env` at import
    // time, so this is the one case that needs a fresh module graph.
    vi.resetModules();
    process.env.ANALYTICS_EVENT_DRIVEN_ENABLED = 'false';
    try {
      const module = await import('./analytics-scheduler.js');
      const h = harness();
      const stop = module.startAnalyticsRecomputeScheduler(log, h.deps);
      expect(h.events.count('internal-event')).toBe(0);
      expect(h.armed).toEqual([]);
      expect(() => stop()).not.toThrow();
    } finally {
      process.env.ANALYTICS_EVENT_DRIVEN_ENABLED = 'true';
      vi.resetModules();
    }
  });
});

// ------------------------------------------------------------------------------------------------
// The minimum interval: an operator's number, and the retry it now owes a refused burst
// ------------------------------------------------------------------------------------------------

describe('the minimum interval between completed passes', () => {
  it('serves a burst that lands just after a pass at interval expiry, not at the floor', async () => {
    // The gap docs/OPERATIONS.md used to document as "not an incident": the burst's debounce window
    // opened and closed normally, the pass it fired was refused for being too early, and by then
    // there was nothing left to re-arm — so the next trigger was a further event or the
    // FIFTEEN-MINUTE floor. That is exactly the «аналітика відстає» an operator reaches for the
    // debounce to fix, and lowering the debounce made it more likely, not less.
    const h = harness();                                  // debounce 20 s, interval 60 s
    startAnalyticsRecomputeScheduler(log, h.deps);

    await emit(h, 'threat.created', 1);
    h.fireWindow();
    await settle();
    expect(h.calls).toEqual(['event']);
    const completedAt = h.at();

    // The burst lands three seconds later; its window closes well inside the interval.
    h.advance(3_000);
    await emit(h, 'threat.created', 2);
    h.advance(20_000);
    h.fireWindow();
    await settle();

    expect(h.calls).toEqual(['event']);                   // refused, as before
    expect(h.liveRetries()).toHaveLength(1);              // but no longer dropped
    expect(h.at() + h.liveRetries()[0]!.ms).toBe(completedAt + MIN_PASS_INTERVAL_MS);
    expect(h.liveRetries()[0]!.ms).toBeLessThan(ANALYTICS_RECOMPUTE_FLOOR_MS);

    h.fireRetry();
    await settle();
    expect(h.calls).toEqual(['event', 'event']);
    expect(h.liveRetries()).toEqual([]);                  // and it does not re-arm itself
  });

  it('coalesces every fire inside the interval into ONE retry and one pass', async () => {
    // `waitMs` is always measured from `lastCompletedAt`, which does not move while no pass
    // completes, so ten fires re-arm the same absolute instant rather than stacking ten timers —
    // and none of them reaches `skipped_interval`, which the runbook reads as "events are arriving
    // faster than one pass per interval" rather than "one burst was refused ten times".
    const h = harness({ analyticsDebounceMs: 0 });
    startAnalyticsRecomputeScheduler(log, h.deps);

    await emit(h, 'threat.created', 1);
    h.fireWindow();
    await settle();
    const completedAt = h.at();

    for (let index = 0; index < 10; index += 1) {
      h.advance(1_000);
      await emit(h, 'threat.created', index + 2);
      h.fireWindow();
      await settle();
    }

    expect(h.calls).toEqual(['event']);
    expect(h.liveRetries()).toHaveLength(1);
    expect(h.at() + h.liveRetries()[0]!.ms).toBe(completedAt + MIN_PASS_INTERVAL_MS);

    h.fireRetry();
    await settle();
    expect(h.calls).toEqual(['event', 'event']);
  });

  it('honours a five-second interval beside a zero debounce', async () => {
    // The наживо combination the product owner asked for and migration 028 made storable. A zero
    // debounce arms a zero-delay window — the next macrotask, not "never" — and the interval, not
    // the debounce floor, is what keeps the passes apart.
    const h = harness({ analyticsDebounceMs: 0, analyticsMinPassIntervalMs: 5_000 });
    startAnalyticsRecomputeScheduler(log, h.deps);

    await emit(h, 'threat.created', 1);
    expect(h.liveWindows()[0]!.ms).toBe(0);
    h.fireWindow();
    await settle();
    expect(h.calls).toEqual(['event']);

    await emit(h, 'threat.created', 2);
    h.fireWindow();
    await settle();
    expect(h.calls).toEqual(['event']);
    expect(h.liveRetries()[0]!.ms).toBe(5_000);

    h.fireRetry();
    await settle();
    expect(h.calls).toEqual(['event', 'event']);
  });

  it('applies a new interval from the settings row without a restart', async () => {
    // It is read through the same memoised `resolveRuntimeSettings()` the debounce comes from, on
    // every event, so an operator's PUT takes effect at the next event rather than at the next
    // deploy. This is the whole point of moving it out of the compiler.
    const h = harness();
    startAnalyticsRecomputeScheduler(log, h.deps);

    await emit(h, 'threat.created', 1);
    h.fireWindow();
    await settle();
    expect(h.calls).toEqual(['event']);

    h.settings.analyticsMinPassIntervalMs = 5_000;        // the operator saves a shorter interval
    await emit(h, 'threat.created', 2);
    h.fireWindow();
    await settle();

    expect(h.liveRetries()[0]!.ms).toBe(5_000);           // not the 60 000 the process started with
    h.fireRetry();
    await settle();
    expect(h.calls).toEqual(['event', 'event']);
  });

  it('leaves no timer armed when the scheduler stops with a retry pending', async () => {
    const h = harness();
    const stop = startAnalyticsRecomputeScheduler(log, h.deps);

    await emit(h, 'threat.created', 1);
    h.fireWindow();
    await settle();
    await emit(h, 'threat.created', 2);
    h.fireWindow();
    await settle();
    const stale = h.liveRetries()[0]!;
    expect(stale).toBeDefined();

    stop();
    // Every slot, not only the two `stop()` knew about before: a retry that outlived the scheduler
    // would call `recomputeAnalytics` against a pool `src/index.ts` has already `pool.end()`ed.
    expect(h.armed.filter((entry) => !entry.cleared)).toEqual([]);

    // A stale handle that fires anyway does nothing and re-arms nothing — the generation token.
    h.advance(MIN_PASS_INTERVAL_MS);
    stale.fn();
    await settle();
    expect(h.calls).toEqual(['event']);
    expect(h.armed.filter((entry) => !entry.cleared)).toEqual([]);
  });

  it('answers a manual pass inside the interval with cooldown while the armed retry survives', async () => {
    // The REAL `recomputeAnalytics`, not the harness spy: `fire()`'s pre-check means the scheduler
    // path never reaches the guard inside it, so the 'cooldown' an operator is shown is produced
    // here and nowhere else. `runManualRecompute` deliberately does not become a queued request —
    // the operator is told the truth — but the burst's retry must not be collateral damage.
    const h = harness();
    startAnalyticsRecomputeScheduler(log, { ...h.deps, recompute: undefined });

    await emit(h, 'threat.created', 1);
    h.fireWindow();
    await settle();
    expect(legs.risk).toBe(1);

    h.advance(3_000);
    await emit(h, 'threat.created', 2);
    h.fireWindow();
    await settle();
    expect(legs.risk).toBe(1);
    expect(h.liveRetries()).toHaveLength(1);

    const manual = await runManualRecompute();
    expect(manual).toMatchObject({ trigger: 'manual', skipped: 'cooldown', durationMs: 0 });
    expect(legs.risk).toBe(1);

    expect(h.liveRetries()).toHaveLength(1);
    h.fireRetry();
    await settle();
    expect(legs.risk).toBe(2);
  });
});

// ------------------------------------------------------------------------------------------------
// `recomputeAnalytics` guards, without a database
// ------------------------------------------------------------------------------------------------

describe('the guards inside one pass', () => {
  it('refuses a pass inside the minimum interval', async () => {
    // `lastCompletedAt` is 0 after a reset, so a clock reading below the minimum interval is the
    // "a pass completed a moment ago" state — and the refusal must happen before any database work.
    let settingsRead = 0;
    const result = await recomputeAnalytics('event', {
      now: () => MIN_PASS_INTERVAL_MS - 1,
      settings: async () => { settingsRead += 1; return RUNTIME_SETTINGS_DEFAULTS; }
    });
    expect(result).toMatchObject({
      trigger: 'event', skipped: 'cooldown', codex: 'not_attempted', durationMs: 0, published: 0
    });
    expect(settingsRead).toBe(0);
  });

  it('a skipped pass reports skipped and does no work', async () => {
    // Two direct callers, the first parked on its settings read: the second must be refused rather
    // than start a second `REFRESH MATERIALIZED VIEW` on top of it.
    let settingsRead = 0;
    const parked = recomputeAnalytics('event', {
      now: () => MIN_PASS_INTERVAL_MS * 10,
      settings: () => new Promise<RuntimeSettings>(() => undefined)
    });
    const second = await recomputeAnalytics('manual', {
      now: () => MIN_PASS_INTERVAL_MS * 10,
      settings: async () => { settingsRead += 1; return RUNTIME_SETTINGS_DEFAULTS; }
    });
    expect(second).toMatchObject({ trigger: 'manual', skipped: 'overlap', durationMs: 0 });
    expect(settingsRead).toBe(0);
    void parked;                                    // never settles; the guard is the assertion
    resetAnalyticsScheduler();
  });

  it('a disabled operator switch skips an event pass but never a manual one', async () => {
    const disabled = { ...RUNTIME_SETTINGS_DEFAULTS, analyticsEventDriven: false };
    const skipped = await recomputeAnalytics('event', {
      now: () => MIN_PASS_INTERVAL_MS * 10, settings: async () => disabled
    });
    expect(skipped).toMatchObject({ skipped: 'disabled', codex: 'not_attempted' });
    expect([legs.refresh, legs.risk, legs.warm]).toEqual([0, 0, 0]);

    // An operator who pressed «Оновити зараз» has already overridden the switch by pressing it.
    const manual = await recomputeAnalytics('manual', {
      now: () => MIN_PASS_INTERVAL_MS * 20, settings: async () => disabled
    });
    expect(manual).toMatchObject({ skipped: null, published: 3 });
    expect(legs.risk).toBe(1);
  });

  it('a pass refused by the switch does not arm the minimum-interval guard', async () => {
    // The case the ten-fake-minute gap in the test above steps over. The `disabled` refusal returns
    // from INSIDE the try, so its `finally` used to stamp `lastCompletedAt` for a pass that read one
    // settings row and did nothing — and the fifteen-minute floor keeps firing those while the
    // switch is off. The operator who then flips the switch back, or presses «Оновити зараз», is
    // told «попередній перерахунок був щойно» about a pass that never happened.
    const disabled = { ...RUNTIME_SETTINGS_DEFAULTS, analyticsEventDriven: false };
    const at = MIN_PASS_INTERVAL_MS * 10;

    const floorPass = await recomputeAnalytics('schedule', { now: () => at, settings: async () => disabled });
    expect(floorPass).toMatchObject({ skipped: 'disabled' });

    // The SAME instant, not ten fake minutes later.
    const manual = await recomputeAnalytics('manual', { now: () => at, settings: async () => disabled });
    expect(manual).toMatchObject({ skipped: null, published: 3 });
    expect(legs.risk).toBe(1);
  });

  it('refreshes the materialised views at floor cadence, not per pass', async () => {
    let clock = MIN_PASS_INTERVAL_MS * 100;
    for (let index = 0; index < 3; index += 1) {
      const result = await recomputeAnalytics('event', {
        now: () => clock, settings: async () => RUNTIME_SETTINGS_DEFAULTS
      });
      expect(result.skipped).toBeNull();
      clock += MIN_PASS_INTERVAL_MS + 1_000;
    }
    // A month bucket does not move inside a debounce window, and two
    // REFRESH MATERIALIZED VIEW CONCURRENTLY statements every minute would compete with the 1 s hub
    // poll and the 15 s ingestion tick on the same pool, under a 15 s statement_timeout.
    expect(legs.refresh).toBe(1);
    expect(legs.risk).toBe(3);
    expect(legs.warm).toBe(3);
  });

  it('a failing view refresh costs the pass its views and nothing else', async () => {
    // `refreshMonthlyAnalytics` has a `finally` and no `catch`, and the failure the module header
    // and the runbook both name — a `REFRESH MATERIALIZED VIEW CONCURRENTLY` past the 15 s
    // `statement_timeout` — rejects into this pass. Unguarded it unwound past the risk leg, the
    // Codex leg and the `analytics.updated` row, so a stale month bucket silently reverted the map's
    // аналітична оцінка to the fifteen-minute timer this worker exists to replace.
    legs.refreshError = new Error('canceling statement due to statement timeout');

    const result = await recomputeAnalytics('event', {
      now: () => MIN_PASS_INTERVAL_MS * 300, settings: async () => RUNTIME_SETTINGS_DEFAULTS
    });

    expect(result).toMatchObject({ skipped: null, published: 3, codex: 'disabled', fallback: false });
    expect([legs.refresh, legs.risk, legs.warm, legs.tactics]).toEqual([1, 1, 1, 1]);
    expect(legs.eventRows).toHaveLength(1);
  });

  it('a failing view refresh retries at floor cadence, not on every pass', async () => {
    // The floor test is `startedAt - lastViewRefreshAt`, and the clock was advanced only on success —
    // so a refresh that keeps timing out re-satisfied the test on every single pass and burned a
    // connection and up to fifteen seconds of `statement_timeout` every minute, for ever.
    legs.refreshError = new Error('canceling statement due to statement timeout');
    let clock = MIN_PASS_INTERVAL_MS * 400;
    for (let index = 0; index < 3; index += 1) {
      const result = await recomputeAnalytics('event', {
        now: () => clock, settings: async () => RUNTIME_SETTINGS_DEFAULTS
      });
      expect(result.skipped).toBeNull();
      clock += MIN_PASS_INTERVAL_MS + 1_000;
    }
    expect(legs.refresh).toBe(1);
    expect(legs.risk).toBe(3);
  });

  it('spends the risk engine\'s model at floor cadence while re-scoring on every pass', async () => {
    // `runRiskAssessmentsPass` calls the model once per `(location_id, threat_type)` group, and one
    // nationwide message fans out to every oblast for six hours. Before the bound, moving that leg
    // from a fifteen-minute timer onto a once-a-minute recompute multiplied model spend with no ops
    // knob covering it. Every pass still re-scores every group — through the deterministic scorer,
    // which is the default deployment path — so nothing the map draws goes stale in between.
    let clock = MIN_PASS_INTERVAL_MS * 500;
    const base = clock;
    for (let index = 0; index < 3; index += 1) {
      await recomputeAnalytics('event', { now: () => clock, settings: async () => RUNTIME_SETTINGS_DEFAULTS });
      clock += MIN_PASS_INTERVAL_MS + 1_000;
    }
    expect(legs.risk).toBe(3);
    expect(legs.riskModel).toEqual([true, false, false]);

    // Past the floor the next pass may spend it again.
    await recomputeAnalytics('event', {
      now: () => base + ANALYTICS_RECOMPUTE_FLOOR_MS, settings: async () => RUNTIME_SETTINGS_DEFAULTS
    });
    expect(legs.riskModel).toEqual([true, false, false, true]);
  });

  it('the operator button always spends the model', async () => {
    // «Оновити зараз» is a person asking for the best answer available, and it is rate-limited by a
    // human pressing it plus the minimum-interval guard.
    const base = MIN_PASS_INTERVAL_MS * 600;
    await recomputeAnalytics('event', { now: () => base, settings: async () => RUNTIME_SETTINGS_DEFAULTS });
    await recomputeAnalytics('manual', {
      now: () => base + MIN_PASS_INTERVAL_MS + 1_000, settings: async () => RUNTIME_SETTINGS_DEFAULTS
    });
    expect(legs.riskModel).toEqual([true, true]);
  });

  it('writes one analytics.updated row per completed pass and nothing on a skip', async () => {
    const ok = await recomputeAnalytics('schedule', {
      now: () => MIN_PASS_INTERVAL_MS * 200, settings: async () => RUNTIME_SETTINGS_DEFAULTS
    });
    expect(ok).toMatchObject({ trigger: 'schedule', skipped: null, codex: 'disabled', published: 3 });
    expect(legs.eventRows).toHaveLength(1);
    expect(String(legs.eventRows[0]![0])).toContain("'analytics.updated'");
    expect(JSON.parse(String((legs.eventRows[0]![1] as string[])[0]))).toMatchObject({
      trigger: 'schedule', codex: 'disabled', fallback: false
    });

    // Immediately again: refused by the minimum interval, and nothing is appended to the log.
    const refused = await recomputeAnalytics('schedule', {
      now: () => MIN_PASS_INTERVAL_MS * 200 + 1, settings: async () => RUNTIME_SETTINGS_DEFAULTS
    });
    expect(refused.skipped).toBe('cooldown');
    expect(legs.eventRows).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------------------------------
// The Codex cooldown boundary, which the recompute's fourth leg is gated on
// ------------------------------------------------------------------------------------------------

describe('withinCodexCooldown', () => {
  it('allows the first call', () => {
    expect(withinCodexCooldown(1_000_000, 0, 900_000)).toBe(false);
  });

  it('allows a call at exactly cooldownMs', () => {
    // `>=` would make a fifteen-minute cooldown mean fifteen minutes plus a tick, drifting for ever.
    expect(withinCodexCooldown(1_900_000, 1_000_000, 900_000)).toBe(false);
    expect(withinCodexCooldown(1_899_999, 1_000_000, 900_000)).toBe(true);
  });

  it('is disabled by a zero interval', () => {
    expect(withinCodexCooldown(1_000_001, 1_000_000, 0)).toBe(false);
  });
});
