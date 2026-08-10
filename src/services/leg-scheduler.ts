import { Counter, Gauge, Histogram } from 'prom-client';

/**
 * One self-rescheduling chain per collection leg.
 *
 * ================================================================================================
 * Why this replaced a single `setInterval` over `Promise.allSettled`
 * ================================================================================================
 *
 * Every official alert leg used to share ONE fifteen-second `setInterval` and one boolean overlap
 * guard. Three properties of that shape are what this module exists to remove:
 *
 *  1. **One cadence for legs with different budgets.** The tokenless mirror publishes two requests
 *     per second per host and refreshes behind a three-second cache; alerts.in.ua allows twelve
 *     requests a minute. A single interval has to be slow enough for the strictest of them, so the
 *     cheapest and freshest source was polled at the pace of the most expensive one — and the whole
 *     acquisition lag, up to fifteen seconds of it, sat in front of every alert this system shows.
 *  2. **A shared overlap guard.** `running` was one flag for four legs: a single hung upstream
 *     stopped the other three from being polled at all, for as long as it hung.
 *  3. **A dead upstream hammered at the healthy cadence.** A leg that has failed sixty times in a
 *     row is not going to answer on the sixty-first, and at a four-second cadence that is fifteen
 *     futile requests a minute against a host that is already in trouble.
 *
 * A chain per leg answers all three. Each leg carries its own interval function, its own failure
 * count and its own timer handle, and nothing about one leg can delay another.
 *
 * ================================================================================================
 * The interval is a GAP, not a period
 * ================================================================================================
 *
 * The next pass is armed in the `finally` of the previous one, so `intervalMs()` is the quiet time
 * BETWEEN two passes rather than the distance between their start instants. A pass that takes two
 * seconds at a four-second interval therefore runs every six seconds, not every four.
 *
 * That is the conservative direction and it is chosen deliberately. The alternative — subtracting
 * the elapsed time so the period stays constant — turns a slow upstream into a *burst*: the moment
 * a request that took longer than the interval returns, the next one is issued immediately, which
 * is precisely the behaviour a rate limit exists to punish and precisely the moment (a struggling
 * upstream) at which punishing it is worst. A gap can never issue two requests closer together than
 * the interval, so the per-provider floors in `src/services/ingestion.ts` are floors on the real
 * request spacing and not merely on an arithmetic mean.
 *
 * The same property makes the overlap guard structural rather than a flag: there is no timer armed
 * while a pass is in flight, so a second pass of the same leg cannot be started. The guard the old
 * scheduler kept in a boolean is now the absence of a handle.
 *
 * ================================================================================================
 * Hot intervals
 * ================================================================================================
 *
 * `intervalMs()` is called on EVERY tick, never captured. That is the whole of what makes
 * `ALERT_POLL_INTERVAL_SECONDS` a `hot` setting in `APP_SETTINGS`: `applyAppSettings` mutates
 * `config` in place, the next tick reads the new number, and no scheduler is rebuilt. The cost is
 * that a change takes effect no sooner than the end of the interval currently being waited out —
 * which is the applyNote on that key, and is why it is `hot` rather than `restart` but not
 * instantaneous.
 *
 * ================================================================================================
 * Single replica
 * ================================================================================================
 *
 * The failure counters and the handles are in-process, exactly like `analytics-scheduler.ts`'s
 * debounce and `shadow-classifier.ts`'s budget. One process is the deployed shape; a second replica
 * would double every request rate computed in `docs/OPERATIONS.md`.
 */

/**
 * Ceiling on the exponential backoff.
 *
 * Two minutes, and the reasoning is the same one `CLASSIFIER_BACKFILL_MIN_RERUN_SECONDS` uses at a
 * different scale: the backoff exists to stop a dead upstream being hammered, not to stop it being
 * *noticed*. An alert source that has recovered must be picked up again inside the window an
 * operator would call "промацали й повернулися", and two minutes is short against
 * `ALERT_END_DEBOUNCE_SECONDS` × any reasonable multiple while being long enough that a genuinely
 * dead host sees half a request a minute instead of fifteen.
 */
export const LEG_BACKOFF_CAP_MS = 120_000;

/**
 * Pure. The delay before the next pass, given the configured gap and how many passes in a row have
 * failed.
 *
 * `Math.max(baseMs, LEG_BACKOFF_CAP_MS)` rather than the cap alone: a leg deliberately configured
 * SLOWER than the cap — the fifteen-second alert-channel backstop, or `ALERT_POLL_INTERVAL_SECONDS`
 * raised past two minutes by an operator throttling under load — must never be *sped up* by
 * failing. The backoff may only ever push a leg further apart than its configured gap.
 *
 * The shift is clamped at 20 so a leg that has been failing for a week cannot produce `Infinity`.
 */
export function legDelayMs(baseMs: number, consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return baseMs;
  const factor = 2 ** Math.min(consecutiveFailures, 20);
  return Math.min(baseMs * factor, Math.max(baseMs, LEG_BACKOFF_CAP_MS));
}

export interface SchedulerLeg {
  /** Metric label and log field. Stable across restarts — a dashboard groups on it. */
  name: string;
  /** One pass. A rejection is caught here and is what drives the backoff. */
  run: () => Promise<unknown>;
  /** The gap to the next pass, in milliseconds. Read fresh on every tick; never captured. */
  intervalMs: () => number;
}

export interface LegSchedulerDeps {
  /**
   * Timer seam; the handle is opaque. Defaults to `setTimeout`/`clearTimeout` with `.unref()`, the
   * shape `analytics-scheduler.ts` uses, so a unit test can drive twenty simulated hours of cadence
   * without waiting for one real second. The leg name is passed through for the same reason that
   * scheduler passes a `kind`: an assertion about *which* chain armed a timer should not have to be
   * inferred from the delay.
   */
  timers?: {
    set(fn: () => void, ms: number, leg: string): unknown;
    clear(handle: unknown): void;
  };
}

/**
 * Passes, by leg and by outcome.
 *
 * `failed` is the series a runbook reads: a leg whose failures climb is a leg whose interval is
 * being pushed out by the backoff, and the gauge below is where the operator sees how far.
 */
const legRuns = new Counter({
  name: 'threatlens_ingestion_leg_runs_total',
  help: 'Collection scheduler passes, by leg and outcome',
  labelNames: ['leg', 'outcome'], registers: []
});

/**
 * The gap currently armed for each leg, in seconds.
 *
 * Two questions in one series, and both used to be unanswerable from outside the process: «чи
 * підхопилося нове значення ALERT_POLL_INTERVAL_SECONDS» (the gauge moves on the next tick) and «чи
 * не сидить якась нога в backoff» (the gauge stands well above its configured interval).
 */
const legInterval = new Gauge({
  name: 'threatlens_ingestion_leg_interval_seconds',
  help: 'Gap currently armed before the next pass of one collection leg, backoff included',
  labelNames: ['leg'], registers: []
});

/**
 * How long one pass of a leg actually took.
 *
 * The gauge above is a GAP and cannot be read as a period — that is the whole «інтервал — це пауза,
 * а не період» property this module is built on. So `threatlens_ingestion_leg_interval_seconds`
 * *understates* the real spacing between two requests to an upstream by exactly the length of a
 * pass, and until this histogram existed that length was unobservable from outside the process:
 * real spacing = armed gap + pass duration, and only one of the two terms was exported.
 *
 * That matters for two questions at once. The request-budget table in `docs/OPERATIONS.md` is
 * computed from the floors and is therefore a worst case that only holds if a pass is instant —
 * `histogram_quantile(0.95, …)` here is what says how much headroom the floors actually have. And a
 * pass whose duration approaches its own interval is a leg that has quietly halved its own polling
 * rate without ever entering backoff, which no existing series would show.
 *
 * Observed for FAILED passes too: a leg that fails after a thirty-second timeout has spaced its
 * requests thirty seconds further apart than the gauge claims, and that is precisely the case where
 * the difference is largest. Buckets run from 50 ms (a cached mirror response) to 30 s (an upstream
 * at its timeout), which spans every pass this scheduler can produce.
 */
const legDuration = new Histogram({
  name: 'threatlens_ingestion_leg_duration_seconds',
  help: 'Wall-clock seconds one pass of a collection leg took, successful or failed',
  labelNames: ['leg'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30], registers: []
});

export function legSchedulerMetrics(): ReadonlyArray<[string, Counter<string> | Gauge<string> | Histogram<string>]> {
  return [
    ['threatlens_ingestion_leg_runs_total', legRuns],
    ['threatlens_ingestion_leg_interval_seconds', legInterval],
    ['threatlens_ingestion_leg_duration_seconds', legDuration]
  ];
}

const defaultTimers: NonNullable<LegSchedulerDeps['timers']> = {
  set(fn: () => void, ms: number): unknown {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clear(handle: unknown): void {
    if (handle) clearTimeout(handle as NodeJS.Timeout);
  }
};

/**
 * Starts one chain per leg and returns the stop closure for all of them.
 *
 * Every leg runs once immediately, exactly as the `void run()` beside the old `setInterval` did: a
 * restart must not leave the map without an official snapshot for a whole interval.
 */
export function startLegScheduler(
  legs: readonly SchedulerLeg[],
  log: { info: Function; warn: Function; error: Function },
  deps: LegSchedulerDeps = {}
): () => void {
  const timers = deps.timers ?? defaultTimers;
  let stopped = false;
  const handles = new Map<string, unknown>();

  for (const leg of legs) {
    let failures = 0;

    const schedule = () => {
      if (stopped) return;
      // `Math.max(1, …)` and not a bound of its own: the real floors are per provider and live in
      // `ingestion.ts`. This only refuses zero, which would be a busy loop.
      const base = Math.max(1, Math.round(leg.intervalMs()));
      const delay = legDelayMs(base, failures);
      legInterval.set({ leg: leg.name }, delay / 1000);
      handles.set(leg.name, timers.set(() => { void tick(); }, delay, leg.name));
    };

    const tick = async () => {
      if (stopped) return;
      // The handle has fired; dropping it here keeps `stop()` from clearing a dead timer and, more
      // importantly, keeps the map from holding a handle that no longer exists while the pass runs.
      handles.delete(leg.name);
      // Started before the body and stopped in the `finally`, so the observation covers exactly the
      // window in which no timer is armed for this leg — which is what makes it the missing term of
      // «real spacing = armed gap + pass duration».
      const observeDuration = legDuration.startTimer({ leg: leg.name });
      try {
        await leg.run();
        if (failures) {
          log.info({ leg: leg.name, failures }, 'collection leg recovered; backoff reset');
        }
        failures = 0;
        legRuns.inc({ leg: leg.name, outcome: 'ok' });
      } catch (error) {
        failures += 1;
        legRuns.inc({ leg: leg.name, outcome: 'failed' });
        // Each leg has already run `markSourceError` inside itself before rethrowing, so the health
        // card is written whatever happens here; this line is the process-level trace and the
        // failure count the backoff is computed from.
        log.error({ error, leg: leg.name, failures }, 'collection leg failed');
      } finally {
        // Observed BEFORE the next pass is armed: the duration is the length of the pass, not the
        // length of the pass plus whatever `schedule()` costs.
        observeDuration();
        schedule();
      }
    };

    void tick();
  }

  return () => {
    stopped = true;
    for (const handle of handles.values()) timers.clear(handle);
    handles.clear();
  };
}
