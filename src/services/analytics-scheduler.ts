import { Counter, Histogram, type Metric, type Registry } from 'prom-client';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { refreshMonthlyAnalytics } from './analytics.js';
import { codexCooldownSkips, warmNarrative } from './analytics-narrative.js';
import { resetAttackAnalyticsCache } from './attack-analytics.js';
import { runRiskAssessmentsGuarded } from './risk.js';
import { RUNTIME_SETTINGS_DEFAULTS, resolveRuntimeSettings, type RuntimeSettings } from './runtime-settings.js';
import { eventHub, type SystemEvent } from './sse.js';

/**
 * The analytics recompute worker: one debounce over the recorded event feed.
 *
 * ================================================================================================
 * Why the event hub, and why the *recorded* feed
 * ================================================================================================
 *
 * Before this module the analytics had three unrelated clocks and no invalidation of any kind: the
 * materialised views on a fifteen-minute timer, the risk engine on another fifteen-minute timer, and
 * the public attack-analytics memo on a 120-second TTL that expires but is never invalidated. A
 * threat observed at 10:00:01 could therefore first appear in the map's аналітична оцінка at
 * 10:15:00. What this module adds is the missing trigger: the moment something the analytics
 * describe actually changed.
 *
 * The subscription is to `'internal-event'`, the hub's **recorded** feed, never to `'event'`, the
 * **published** one. `'event'` is head-bounded by the publication cutoff, so in `delayed_15s` a
 * `threat.created` would not reach this handler for fifteen seconds, the debounce would only start
 * after that, and the map would pay the hold twice — once on the presentation and once again on the
 * assessment that describes it. Internal recomputation, classification, audit and monitoring are
 * never delayed; only the public presentation is.
 *
 * Hooking the hub rather than the writers is deliberate. The hub reads **after** the writer's
 * COMMIT, so nothing here can slow or roll back an ingestion transaction — the same house rule
 * `archiveClassification` follows. Ordering is `version`, the same order the SSE clients and the
 * notification outbox see. A listener that throws cannot roll anything back, because by then there
 * is no transaction to roll back.
 *
 * Delivery is **at-most-once in-process**: `EventHub`'s cursor is memory-only, so a restart loses
 * whatever was in flight. That is correct for a cache invalidation — nothing here must never be
 * missed — and the fifteen-minute floor below catches whatever a restart dropped.
 *
 * ================================================================================================
 * Single replica
 * ================================================================================================
 *
 * Every flag in this module — the debounce window, the overlap guard, the completed-pass clock, the
 * generation token — is in-process, exactly like `shadow-classifier.ts`'s budget,
 * `attack-analytics.ts`'s memo and `ingestion.ts`'s scheduler guard. One process is the deployed
 * shape. A second replica gets a second debounce and a second floor, which is a documented boundary
 * rather than a silent one.
 */

/**
 * Exactly the seven event types that change what the analytics say.
 *
 * `assessment.updated` is deliberately absent: `runRiskAssessments()` writes it, so subscribing to
 * it would make every recompute schedule the next one — a loop that would run the risk engine
 * continuously and would look, from the outside, exactly like an attack. `source.stale` and
 * `source.recovered` describe a channel, not a threat. `publication.changed` and `analytics.updated`
 * are this delivery's own two new types and are equally excluded.
 */
export const ANALYTICS_TRIGGER_EVENTS = [
  'alert.started', 'alert.ended',
  'threat.created', 'threat.updated', 'threat.corrected', 'threat.withdrawn', 'threat.expired'
] as const;
const TRIGGER_SET = new Set<string>(ANALYTICS_TRIGGER_EVENTS);

/** The quiet-period floor: if nothing has run for this long, run anyway. */
export const ANALYTICS_RECOMPUTE_FLOOR_MS = 15 * 60_000;

/**
 * Minimum wall-clock gap between two completed passes, independent of the debounce.
 *
 * `execute()`'s re-arm starts a fresh window the moment the previous pass ends, so under sustained
 * events the passes are back to back with only `analyticsDebounceMs` between them. An operator
 * responding to «аналітика відстає» by lowering the debounce would turn one ops PUT into a standing
 * pair of REFRESH MATERIALIZED VIEW CONCURRENTLY statements plus a full risk pass every few seconds,
 * on the pool the 15 s ingestion tick and every snapshot share, under a 15 s statement_timeout — and
 * a refresh that exceeds the timeout dies, counts as `failed`, and the next pass retries immediately.
 * Sixty seconds is still fifteen times faster than the timer this replaces.
 */
export const ANALYTICS_MIN_PASS_INTERVAL_MS = 60_000;

export type RecomputeTrigger = 'event' | 'manual' | 'schedule';

export interface RecomputeResult {
  /** ISO, when the pass started. */
  recomputedAt: string;
  durationMs: number;
  trigger: RecomputeTrigger;
  /** Read this only when `skipped === null`; on a skip it is `'not_attempted'`. */
  codex: 'used' | 'cooldown' | 'disabled' | 'failed' | 'not_attempted';
  /** Deterministic text was published instead of a model's. */
  fallback: boolean;
  /** Rows from `runRiskAssessments()`. */
  published: number;
  skipped: 'overlap' | 'disabled' | 'cooldown' | null;
}

/**
 * Everything this module reaches outside itself, injectable.
 *
 * Additive to `CONTRACT.md` §8.2's signatures for the same reason `codexChat(request, deps = {})`
 * has a bag: the unit tests for a debounce must run with an injected clock and a fake emitter, and
 * there is no other seam that does not involve a database and a real `setTimeout`.
 */
export interface AnalyticsSchedulerDeps {
  /** Injected clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Timer seam; the handle is opaque. Defaults to `setTimeout`/`clearTimeout` with `.unref()`. */
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  /** The event source. Defaults to `eventHub`. */
  events?: {
    on(name: string, fn: (event: SystemEvent) => void): unknown;
    off(name: string, fn: (event: SystemEvent) => void): unknown;
  };
  /** Defaults to `resolveRuntimeSettings`. */
  settings?: () => Promise<RuntimeSettings>;
  /** Defaults to {@link recomputeAnalytics}; injected so the debounce can be tested without a database. */
  recompute?: (trigger: RecomputeTrigger) => Promise<RecomputeResult>;
  /**
   * Overrides {@link ANALYTICS_MIN_PASS_INTERVAL_MS}. A test seam and nothing else: an integration
   * case that has to observe two passes cannot wait a real minute, and shortening the *debounce*
   * instead would leave the interval guard refusing the second pass — which is what the guard is
   * for. Production never passes it.
   */
  minPassIntervalMs?: number;
}

export interface RecomputeDeps {
  settings?: () => Promise<RuntimeSettings>;
  now?: () => number;
  /** Same test seam as {@link AnalyticsSchedulerDeps.minPassIntervalMs}, for a direct call. */
  minPassIntervalMs?: number;
}

// ------------------------------------------------------------------------------------------------
// Metrics (CONTRACT §10)
// ------------------------------------------------------------------------------------------------

const recomputeTotal = new Counter({
  name: 'threatlens_analytics_recompute_total',
  help: 'Analytics recomputes, by what triggered them and how they ended',
  labelNames: ['trigger', 'outcome'],
  registers: []
});
const recomputeDuration = new Histogram({
  name: 'threatlens_analytics_recompute_duration_seconds',
  help: 'Wall-clock seconds of one analytics recompute pass',
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: []
});

export function registerAnalyticsSchedulerMetrics(registry: Registry): void {
  const metrics: ReadonlyArray<[string, Metric<string>]> = [
    ['threatlens_analytics_recompute_total', recomputeTotal],
    ['threatlens_analytics_recompute_duration_seconds', recomputeDuration],
    // Defined next to the cooldown it counts (`analytics-narrative.ts`) and registered here, because
    // an import the other way round would close a cycle: this module already imports the narrative.
    ['threatlens_codex_cooldown_skips_total', codexCooldownSkips]
  ];
  for (const [name, metric] of metrics) {
    if (!registry.getSingleMetric(name)) registry.registerMetric(metric);
  }
}

// ------------------------------------------------------------------------------------------------
// Module state
// ------------------------------------------------------------------------------------------------

let timer: unknown = null;              // the debounce window
let floorTimer: unknown = null;         // the quiet-period floor
let firstPendingAt: number | null = null;
let rearm = false;
let running = false;                    // OWNED BY execute(); recomputeAnalytics re-checks it
let lastCompletedAt = 0;
let lastViewRefreshAt = 0;              // the materialised views run at floor cadence, not per pass
let lastRiskModelAt = 0;                // and so does the risk leg's MODEL call — see the pass below
let lastSettings: RuntimeSettings = RUNTIME_SETTINGS_DEFAULTS;
let lastResult: RecomputeResult | null = null;

/**
 * Generation token. `floorTimer` is ONE module-level slot shared by every start/stop cycle and
 * `onFloor()` re-arms in a `finally`, so without this: (a) a stop that lands between the `if` and
 * the `finally` clears the old handle while `armFloor()` writes a new one nobody will ever clear —
 * the chain outlives the scheduler and keeps calling `recomputeAnalytics` against a pool
 * `src/index.ts` has already `pool.end()`ed; (b) a second `start()` (the integration suite builds
 * and tears down repeatedly) overwrites the slot while the first chain keeps self-rescheduling into
 * it, so `stop()` can only ever kill one of N chains and later test files see recomputes they did
 * not cause. Every self-rescheduling callback closes over `myGeneration` and returns if it is stale.
 */
let generation = 0;
let stopped = true;
let currentStop: (() => void) | null = null;

/**
 * The one-shot permission `execute()` hands to the pass it is itself starting.
 *
 * `execute()` sets `running` synchronously *before* it awaits — that is what makes `fire()`'s
 * check-then-act safe — so the re-entrancy belt inside {@link recomputeAnalytics} would otherwise
 * refuse every single pass, including the one that set the flag. The grant is written by the
 * default `recompute` binding immediately before the call and consumed on entry, so a *second*
 * caller that reaches `recomputeAnalytics` during a live pass still sees `running` with no grant and
 * is refused, which is the case the belt exists for.
 */
let executeGrant = false;

// The live dependency set, rebound by `start()` so the debounce can run against a fake emitter and
// an injected clock without any of the functions below taking a parameter they would then have to
// thread through the timer callbacks.
const defaultTimers = {
  set(fn: () => void, ms: number): unknown {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clear(handle: unknown): void {
    if (handle) clearTimeout(handle as NodeJS.Timeout);
  }
};

function defaultRecompute(trigger: RecomputeTrigger): Promise<RecomputeResult> {
  executeGrant = true;
  return recomputeAnalytics(trigger);
}

let now: () => number = Date.now;
let timers = defaultTimers;
let events: NonNullable<AnalyticsSchedulerDeps['events']> = eventHub;
let readSettings: () => Promise<RuntimeSettings> = resolveRuntimeSettings;
let recompute: (trigger: RecomputeTrigger) => Promise<RecomputeResult> = defaultRecompute;
let minPassInterval = ANALYTICS_MIN_PASS_INTERVAL_MS;
let log: { info: Function; error: Function } = { info: () => undefined, error: () => undefined };

function setTimer(fn: () => void, ms: number): unknown {
  return timers.set(fn, ms);
}

function clearTimer(handle: unknown): void {
  timers.clear(handle);
}

/**
 * Test seam. Returns every module-level flag to the state a fresh import would have, so one test
 * file's in-flight pass cannot decide the next file's first assertion.
 */
export function resetAnalyticsScheduler(): void {
  // Detach first, with the seam the scheduler was started with, so a test that forgot its stop
  // closure does not leave a listener on the real hub for every later test file to be surprised by.
  currentStop?.();
  clearTimer(timer);
  clearTimer(floorTimer);
  timer = null;
  floorTimer = null;
  firstPendingAt = null;
  rearm = false;
  running = false;
  executeGrant = false;
  lastCompletedAt = 0;
  lastViewRefreshAt = 0;
  lastRiskModelAt = 0;
  lastSettings = RUNTIME_SETTINGS_DEFAULTS;
  lastResult = null;
  generation += 1;
  stopped = true;
  currentStop = null;
  now = Date.now;
  timers = defaultTimers;
  events = eventHub;
  readSettings = resolveRuntimeSettings;
  recompute = defaultRecompute;
  minPassInterval = ANALYTICS_MIN_PASS_INTERVAL_MS;
  log = { info: () => undefined, error: () => undefined };
}

// ------------------------------------------------------------------------------------------------
// The debounce
// ------------------------------------------------------------------------------------------------

async function onEvent(event: SystemEvent): Promise<void> {
  if (!TRIGGER_SET.has(event.eventType)) return;
  // The promise-memoised read of §2.7: one hub tick releases up to 200 events and this must not
  // become 200 statements. It never throws — a failed read degrades to the defaults.
  const settings = await readSettings();
  lastSettings = settings;
  if (!settings.analyticsEventDriven) return;     // the operator switch, the DB row, read every event

  const at = now();
  firstPendingAt ??= at;

  // Starvation guard. A trailing-edge debounce that is re-armed by every new event never fires while
  // the events keep coming — and "the events keep coming" is a mass attack, the one case these
  // analytics exist to describe. Past `analyticsMaxDelayMs` the next event fires the pass instead of
  // postponing it again.
  if (at - firstPendingAt >= settings.analyticsMaxDelayMs) { fire('event'); return; }

  clearTimer(timer);
  timer = setTimer(() => fire('event'), settings.analyticsDebounceMs);
}

function fire(trigger: RecomputeTrigger): void {
  clearTimer(timer);
  timer = null;
  // Overlap guard. `running` is owned by `execute()` and is set synchronously before its first
  // `await`, which is what makes this check-then-act safe on a single-threaded loop.
  if (running) { rearm = true; return; }
  void execute(trigger);
}

/**
 * The ONE place a pass is started, and the one place `rearm` and `firstPendingAt` are drained.
 *
 * Every pass — event, floor and manual — goes through here. An earlier design had the ops route call
 * `recomputeAnalytics('manual')` directly: it set and cleared the shared `running` flag without ever
 * draining `rearm`, and `fire()` had already nulled `timer`, so nothing was left armed. A burst's
 * pending recompute was silently dropped until the fifteen-minute floor — and `firstPendingAt` kept
 * a stale origin, so the first event after the burst tripped the starvation guard with no debounce
 * at all and then armed a second redundant pass. {@link runManualRecompute} exists so the route
 * cannot bypass this.
 */
async function execute(trigger: RecomputeTrigger): Promise<void> {
  const myGeneration = generation;
  // Owned HERE, so an injected `recompute` spy in a unit test still exercises the overlap guard.
  running = true;
  let completed = false;
  try {
    const result = await recompute(trigger);       // never throws; see recomputeAnalytics
    lastResult = result;
    // A refused pass is not a completed one. Stamping `lastCompletedAt` on a `skipped_interval`
    // result would push the minimum interval forward on every refusal, so a stream of events one
    // debounce apart would refuse itself for ever and the analytics would only ever move on the
    // fifteen-minute floor — the opposite of what this worker is for.
    completed = result.skipped === null;
    log.info({ ...result }, 'analytics recompute finished');
  } catch (error) {
    // Belt to `recomputeAnalytics`'s braces: a bug in the swallowing must not become an unhandled
    // rejection that takes the process down during an attack. A pass that threw still spent the
    // database, so it counts as completed and the minimum interval applies to it.
    completed = true;
    lastResult = {
      recomputedAt: new Date(now()).toISOString(), durationMs: 0, trigger,
      codex: 'failed', fallback: true, published: 0, skipped: null
    };
    log.error({ error }, 'analytics recompute failed');
  } finally {
    running = false;
    if (completed) lastCompletedAt = now();
    // ALWAYS reset, not only when fire() starts a pass: a stale origin must never cross a pass.
    firstPendingAt = null;
    if (rearm && !stopped && myGeneration === generation) {
      rearm = false;
      firstPendingAt = now();
      clearTimer(timer);
      timer = setTimer(() => fire('event'), lastSettings.analyticsDebounceMs);
    } else {
      rearm = false;
    }
  }
}

/**
 * The ops route's entry point. It goes through the SAME `execute()` wrapper the debounce and the
 * floor use, so a manual pass drains `rearm` and resets `firstPendingAt` like any other. The ops
 * route calling `recomputeAnalytics('manual')` directly is the bug this export exists to make
 * impossible.
 */
export async function runManualRecompute(): Promise<RecomputeResult> {
  if (running) {
    recomputeTotal.inc({ trigger: 'manual', outcome: 'skipped_overlap' });
    return {
      recomputedAt: new Date(now()).toISOString(), durationMs: 0, trigger: 'manual',
      codex: 'not_attempted', fallback: false, published: 0, skipped: 'overlap'
    };
  }
  lastResult = null;
  await execute('manual');
  // `execute()` stores the result it logged; a pass that threw past its own catch is the only way
  // this can be null, and reporting a failed manual run is better than reporting nothing.
  return lastResult ?? {
    recomputedAt: new Date(now()).toISOString(), durationMs: 0, trigger: 'manual',
    codex: 'failed', fallback: true, published: 0, skipped: null
  };
}

// ------------------------------------------------------------------------------------------------
// The floor
// ------------------------------------------------------------------------------------------------

function armFloor(myGeneration: number): void {
  if (stopped || myGeneration !== generation) return;
  floorTimer = setTimer(() => { void onFloor(myGeneration); }, ANALYTICS_RECOMPUTE_FLOOR_MS);
}

async function onFloor(myGeneration: number): Promise<void> {
  // Generation check FIRST and in the `finally` too: a stop that lands between the `if` and the
  // `finally` would otherwise clear the old handle while this re-arms a new one nobody will clear.
  if (stopped || myGeneration !== generation) return;
  try {
    // Only when nothing else has run. While events are flowing the debounce is the trigger and the
    // floor must never add a second concurrent pass on top of it.
    if (!running && now() - lastCompletedAt >= ANALYTICS_RECOMPUTE_FLOOR_MS) fire('schedule');
  } finally {
    armFloor(myGeneration);                        // self-rescheduling; one timer seam covers both
  }
}

// ------------------------------------------------------------------------------------------------
// Start and stop
// ------------------------------------------------------------------------------------------------

const handler = (event: SystemEvent) => { void onEvent(event); };

export function startAnalyticsRecomputeScheduler(
  logger: { info: Function; error: Function }, deps: AnalyticsSchedulerDeps = {}
): () => void {
  // Deployment-level kill switch, checked BEFORE subscribing. When it is off the worker is not
  // merely idle, it is absent: no listener, no timer, nothing that needs to read a database flag to
  // decide to do nothing. The reason to stop event-driven recomputation is almost always that it is
  // amplifying a database problem, which is the worst possible moment to need the database.
  if (!config.ANALYTICS_EVENT_DRIVEN_ENABLED) {
    logger.info('event-driven analytics disabled by configuration');
    return () => undefined;
  }
  // Idempotent. A second start while the first is live would leave two self-rescheduling floor
  // chains writing into one `floorTimer` slot, and `stop()` could only ever kill one of them.
  if (!stopped && currentStop) {
    logger.info('analytics recompute scheduler already running');
    return currentStop;
  }

  log = logger;
  now = deps.now ?? Date.now;
  timers = deps.timers ?? defaultTimers;
  events = deps.events ?? eventHub;
  readSettings = deps.settings ?? resolveRuntimeSettings;
  recompute = deps.recompute ?? defaultRecompute;
  minPassInterval = deps.minPassIntervalMs ?? ANALYTICS_MIN_PASS_INTERVAL_MS;

  generation += 1;
  stopped = false;
  const myGeneration = generation;
  // The RECORDED feed, never the published one: gating the analytics trigger behind the publication
  // cutoff would make the map's аналітична оцінка pay the hold twice.
  events.on('internal-event', handler);
  armFloor(myGeneration);
  currentStop = () => {
    // All four halves matter. `buildServer()` and this scheduler are started and torn down
    // repeatedly by the integration suite; a stop closure that forgot `off` would accumulate one
    // live listener per test file and every later test would see other tests' recomputes, and one
    // that forgot the generation bump would let an in-flight `onFloor` re-arm itself afterwards.
    stopped = true;
    generation += 1;
    events.off('internal-event', handler);
    clearTimer(timer); timer = null;
    clearTimer(floorTimer); floorTimer = null;
    currentStop = null;
  };
  return currentStop;
}

// ------------------------------------------------------------------------------------------------
// One pass
// ------------------------------------------------------------------------------------------------

/**
 * What a recompute does, and why it never throws.
 *
 * Every caller — the debounce, the floor, the ops button — is a place where an exception is worse
 * than a missing paragraph, so the `catch` logs, counts and returns a shaped result. It does not
 * recurse: `runRiskAssessments()` writes `assessment.updated`, which is not a trigger type, and
 * neither is the `analytics.updated` row written at the end.
 */
export async function recomputeAnalytics(
  trigger: RecomputeTrigger, deps: RecomputeDeps = {}
): Promise<RecomputeResult> {
  const clock = deps.now ?? now;
  const startedAt = clock();
  const skeleton = { recomputedAt: new Date(startedAt).toISOString(), trigger, published: 0 };

  // Re-entrancy check for DIRECT callers. `execute()` owns the flag; this is the belt for anything
  // that reaches this function without going through it, and the grant is how the pass `execute()`
  // itself started is told apart from a second caller landing inside it.
  const granted = executeGrant;
  executeGrant = false;
  if (running && !granted) {
    recomputeTotal.inc({ trigger, outcome: 'skipped_overlap' });
    return { ...skeleton, durationMs: 0, codex: 'not_attempted', fallback: false, skipped: 'overlap' };
  }
  // Minimum interval between two completed passes, independent of the debounce. See
  // ANALYTICS_MIN_PASS_INTERVAL_MS above for why the debounce alone is not a bound.
  if (startedAt - lastCompletedAt < (deps.minPassIntervalMs ?? minPassInterval)) {
    recomputeTotal.inc({ trigger, outcome: 'skipped_interval' });
    return { ...skeleton, durationMs: 0, codex: 'not_attempted', fallback: false, skipped: 'cooldown' };
  }
  running = true;                                   // set before the first await
  /**
   * Whether this pass got past every refusal and started spending the database.
   *
   * The two guards above return before `running = true` and so never reach the `finally`, but the
   * `disabled` refusal below is inside the `try` — and stamping `lastCompletedAt` for it would arm
   * the minimum-interval guard on a pass that read one settings row and did nothing. An operator who
   * switches `analyticsEventDriven` back on, or presses «Оновити зараз», within a minute of a
   * fifteen-minute floor tick would then be refused with `skipped: 'cooldown'` and told «попередній
   * перерахунок був щойно» about a pass that never happened.
   */
  let attempted = false;
  try {
    const settings = await (deps.settings ?? readSettings)();
    // A manual «Оновити зараз» always runs: an operator who pressed the button has already
    // overridden the switch by pressing it. Event and floor passes obey it.
    if (trigger !== 'manual' && !settings.analyticsEventDriven) {
      recomputeTotal.inc({ trigger, outcome: 'skipped_disabled' });
      return { ...skeleton, durationMs: 0, codex: 'not_attempted', fallback: false, skipped: 'disabled' };
    }
    attempted = true;                               // past every refusal; the pass now spends the DB

    // 1. The public attack-analytics memo. Its 120 s TTL is a floor on staleness, not an
    //    invalidation; this is the invalidation, and the existing test seam is the seam.
    resetAttackAnalyticsCache();

    // 2. Materialised views — at FLOOR cadence, not once per pass. Both views aggregate by MONTH
    //    and cannot change meaningfully inside a debounce window, while two
    //    REFRESH MATERIALIZED VIEW CONCURRENTLY statements every few seconds compete with the 1 s
    //    hub poll, the 15 s ingestion tick and every client's snapshot on a pool of twelve.
    //    `refreshMonthlyAnalytics` owns its own overlap guard because it has two callers.
    if (startedAt - lastViewRefreshAt >= ANALYTICS_RECOMPUTE_FLOOR_MS) {
      try {
        if (await refreshMonthlyAnalytics()) lastViewRefreshAt = startedAt;
      } catch (error) {
        // `refreshMonthlyAnalytics` has a `finally` and no `catch`, so a refresh that exceeds the
        // 15 s `statement_timeout` — the failure this module's header and the runbook both name as
        // the expected one — rejects into the caller. Without this guard that rejection unwinds
        // straight past the risk leg, the Codex leg and the `analytics.updated` row: a stale month
        // bucket would cost the map its аналітична оцінка, which is the thing this worker exists to
        // move. The clock is stamped on failure too, so the retry stays at floor cadence instead of
        // re-satisfying the floor test on every pass and burning a connection every minute for ever.
        lastViewRefreshAt = startedAt;
        recomputeTotal.inc({ trigger, outcome: 'view_refresh_failed' });
        log.error({ error }, 'monthly analytics refresh failed; the pass continues');
      }
    }

    // 3. The risk engine — the expensive leg and the one that writes what the map draws.
    //    Every pass re-scores every group; only one pass per floor interval, plus the operator's
    //    button, may spend the configured model doing it. `runRiskAssessmentsPass` calls the model
    //    once per `(location_id, threat_type)` group, and one national air-raid message fans out to
    //    every oblast for six hours — so without this bound the delivery would turn a leg that used
    //    to run on a fifteen-minute timer into one that runs up to once a minute, at up to
    //    `AI_TIMEOUT_MS` per group, with no operator knob covering it. The intermediate passes still
    //    re-score everything through the deterministic scorer, which is the default deployment path
    //    and already produces complete, clamped, Ukrainian assessments.
    const allowModel = trigger === 'manual'
      || startedAt - lastRiskModelAt >= ANALYTICS_RECOMPUTE_FLOOR_MS;
    const risk = await runRiskAssessmentsGuarded({ allowModel });
    if (risk.skipped) recomputeTotal.inc({ trigger, outcome: 'skipped_overlap' });
    else if (allowModel) lastRiskModelAt = startedAt;

    // 4. Codex leg: the cooldown is checked first, so a mass attack cannot turn a debounce into a
    //    model-call storm.
    const leg = await warmNarrative({ cooldownMs: settings.codexCooldownMs });

    const durationMs = clock() - startedAt;
    // 5. One row, so the browser, the ops console and any future consumer learn about the recompute
    //    through the same ordered log everything else uses.
    await pool.query(
      `INSERT INTO system_event_log(event_type,payload) VALUES ('analytics.updated',$1::jsonb)`,
      [JSON.stringify({ trigger, durationMs, codex: leg.codex, fallback: leg.fallback })]
    );

    recomputeTotal.inc({ trigger, outcome: 'ok' });
    recomputeDuration.observe(durationMs / 1000);
    return {
      ...skeleton, durationMs, codex: leg.codex, fallback: leg.fallback,
      published: risk.published, skipped: null
    };
  } catch (error) {
    // A pass that threw still spent the database, so the minimum interval applies to it — otherwise
    // a leg that fails fast would be retried as fast as the events arrive.
    attempted = true;
    recomputeTotal.inc({ trigger, outcome: 'failed' });
    log.error({ error }, 'analytics recompute pass failed');
    return {
      ...skeleton, durationMs: clock() - startedAt, codex: 'failed', fallback: true, skipped: null
    };
  } finally {
    running = false;
    if (attempted) lastCompletedAt = clock();
    // NOTE: `rearm` and `firstPendingAt` are drained by `execute()`'s finally, not here — one place,
    // and every pass goes through it.
  }
}
