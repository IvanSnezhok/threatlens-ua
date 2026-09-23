import { Counter } from 'prom-client';

/**
 * The in-process «щойно з'явилося термінове» signal.
 *
 * ================================================================================================
 * What it is for
 * ================================================================================================
 *
 * Two workers stand between a committed row in `system_event_log` and a person seeing it, and both
 * of them are pollers on a one-second timer: the SSE hub (`src/services/sse.ts`) and the
 * notification fan-out (`src/bot/outbox.ts`). Two seconds of the end-to-end budget is therefore
 * spent waiting for two timers to come round, after the fact is already committed and visible.
 *
 * This module removes that wait, and NOTHING else. It carries no payload, no version, no ordering
 * and no delivery guarantee: it says «there is something new below your cursor, look now». Both
 * consumers re-read the log exactly as they would have on their own tick, through exactly the same
 * queries, so every bound those queries carry still applies.
 *
 * ================================================================================================
 * What it deliberately does NOT do
 * ================================================================================================
 *
 * **It does not lift the publication hold.** The hub's public `'event'` feed is bounded by the
 * version just below the oldest row still held; a poke makes that query run sooner, and in
 * `delayed_15s` the fresh row is above the bound and is not selected. The poke removes polling lag,
 * never the hold. That is a property of the hub's SELECT rather than of this file, which is why
 * `tests/integration/alert-poke.test.ts` pins it there.
 *
 * **It is not a queue and not a replacement for the timers.** A poke that is dropped costs at most
 * one ordinary tick. Both consumers keep their one-second interval, so the system's behaviour with
 * this module removed is the behaviour it had before it existed.
 *
 * **It is scoped to the URGENT rows, not to alerts.** Two origins raise it and nothing else does:
 * `alert.started` (an authority declared an alert) and a live threat — `threat.created` /
 * `threat.updated` that `ingestThreat` actually published AND whose `timing` is `now`. Everything
 * else rides the normal tick: `alert.ended`, an expected-window threat («увечері очікується», which
 * `CONTEXT.md` states is not a live threat and which the bot sends as a quiet message), a
 * de-escalation, a coalesced restatement, and every row a stale message never wrote.
 *
 * The asymmetry is the product decision this delivery implements: a warning that arrives late is a
 * warning that arrives too late, and an all-clear — or a forecast for tonight — that arrives late is
 * merely unhurried. `docs/ARCHITECTURE.md` §Consistency rules already treats the two directions
 * asymmetrically everywhere else.
 *
 * The second origin was added because the first one bought the official path out of a wait the
 * monitoring path still paid in full: a `threat.created` from a monitoring channel — which is the
 * ONLY warning that exists before an authority has spoken — waited on the hub's tick AND the
 * fan-out's tick AND then the delivery tick, a deterministic 0–3 s that `alert.started` had already
 * bought its way out of.
 *
 * ================================================================================================
 * Storm proof
 * ================================================================================================
 *
 * Three independent bounds, so a nationwide raid cannot turn this into a load source:
 *
 *  1. **One poke per COMMIT, not per row.** The callers accumulate what a transaction created and
 *     poke once after it commits. A snapshot that raises twenty-five oblasts at once is one poke,
 *     and one ingested message is one poke whatever geography it touched.
 *  2. **One pending poke at a time.** A poke while one is already armed is counted and dropped, so
 *     the listeners can never be called twice for the same macrotask turn however many callers fire
 *     inside it.
 *  3. **The consumers are themselves guarded.** The hub refuses a re-entrant poll and the fan-out
 *     refuses a re-entrant pass; both re-arm ONE pending pass instead, the same shape
 *     `analytics-scheduler.ts` uses for `rearm`. A poke landing during a pass costs a flag, not a
 *     statement.
 *
 * The resulting ceiling: pokes per second ≤ committing-transactions-that-raised-something-urgent per
 * second, which is bounded above by the poll cadence of the three snapshot legs plus the message
 * rate of the alert channels plus the message rate of the monitoring channels — and the last of
 * those is itself bounded by the coalescing window in `src/services/ingestion.ts`, which refuses to
 * re-raise the same class in the same place inside the burst window. `threatlens_alert_pokes_total`
 * is the series that proves it in production, and its `coalesced` share is the number a runbook
 * reads.
 *
 * ================================================================================================
 * Single replica
 * ================================================================================================
 *
 * In-process, like every other coordination flag in this codebase. A second replica's hub would not
 * hear the first replica's poke and would fall back to its one-second timer — a degradation to the
 * previous behaviour, never a correctness problem.
 */

/**
 * Pokes raised, by origin and by what happened to them.
 *
 * Four values on the ONE existing `outcome` label rather than a second label, because the two
 * origins are two different operational findings and a dashboard that already reads `fired` and
 * `coalesced` must keep reading exactly the alert series it has always read. `fired`/`coalesced`
 * are `alert.started`; `threat_fired`/`threat_coalesced` are a live monitoring-channel warning.
 * Four series, fixed at compile time — the cardinality bound is the enum below, not the traffic.
 *
 * `coalesced` is not a failure: it is bound 2 above doing its job, and a healthy nationwide raid
 * shows some of both kinds. A `coalesced` rate that dwarfs `fired` means several writers are
 * committing inside one macrotask turn, which is worth knowing and is not worth acting on. During a
 * mass raid the threat share is expected to dominate: fifty channels post about one wave, and every
 * commit that actually published a live event raises one.
 */
const POKE_OUTCOMES = {
  alert: { fired: 'fired', coalesced: 'coalesced' },
  threat: { fired: 'threat_fired', coalesced: 'threat_coalesced' }
} as const;

type PokeOrigin = keyof typeof POKE_OUTCOMES;

const alertPokes = new Counter({
  name: 'threatlens_alert_pokes_total',
  help: 'Instant-propagation signals raised after an urgent row was committed, by origin and outcome',
  labelNames: ['outcome'], registers: []
});

export function alertPokeMetrics(): ReadonlyArray<[string, Counter<string>]> {
  return [['threatlens_alert_pokes_total', alertPokes]];
}

type PokeListener = () => void;

const listeners = new Set<PokeListener>();

/** The one pending poke of bound 2. `null` means nothing is armed. */
let pending: NodeJS.Timeout | null = null;

/**
 * Subscribes to the signal and returns the detach closure.
 *
 * Returning the closure rather than exposing an `off` is deliberate: the two consumers are started
 * and stopped repeatedly by the integration suite, and a subscriber that has to reconstruct its own
 * function identity in order to detach is a subscriber that leaks on the first refactor.
 */
export function onAlertPoke(listener: PokeListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Raise the signal. Call this AFTER the transaction that wrote the row commits — a poke that
 * arrives before the COMMIT sends both consumers to read a row they cannot see yet, and the
 * ordinary tick would then be the thing that actually delivered it.
 *
 * Fires on the next macrotask rather than synchronously, for two reasons that are both about the
 * caller: the poke must not run a database pass inside the caller's `finally`, and the next
 * macrotask is the coalescing window — every caller that commits in the same turn produces one
 * poke between them.
 *
 * `origin` decides only which counter series records the poke. The signal itself carries nothing:
 * both consumers re-read the log through their own query, so two origins racing inside one turn are
 * one wake-up that finds both rows, which is exactly the behaviour wanted.
 */
function raise(origin: PokeOrigin): void {
  if (pending) {
    alertPokes.inc({ outcome: POKE_OUTCOMES[origin].coalesced });
    return;
  }
  pending = setTimeout(() => {
    pending = null;
    alertPokes.inc({ outcome: POKE_OUTCOMES[origin].fired });
    // A copy, and a `try` per listener: one consumer throwing must not stop the other from being
    // told, and neither must be able to take the process down from a timer callback.
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* the consumers log their own failures */ }
    }
  }, 0);
  pending.unref?.();
}

/** An authority declared an alert. Call after the reconcile transaction commits. */
export function pokeAlertStarted(): void {
  raise('alert');
}

/**
 * A monitoring or official channel's message became a LIVE threat on the map. Call after
 * `ingestThreat` commits, and only when both of these hold:
 *
 *  * the call actually published — `IngestThreatResult.published`, i.e. a `system_event_log` row was
 *    written. A message past the delivery-age ceiling, a duplicate and a no-op merge write nothing,
 *    and waking two pollers to find nothing is pure cost;
 *  * the event's `timing` is `now`. «Увечері очікується» is not a live threat (`CONTEXT.md`), the
 *    fan-out sends it at the quiet priority without a call to shelter, and buying a second off a
 *    forecast for tonight is buying nothing.
 *
 * A de-escalation and a coalesced restatement never reach here: `ingestion.ts` returns from both
 * before `ingestThreat` is called.
 */
export function pokeLiveThreat(): void {
  raise('threat');
}

/**
 * Test seam. Drops every listener and disarms the pending poke.
 *
 * Required by any integration file that starts the hub or the fan-out: the integration project runs
 * every file in ONE fork, so a listener left attached by one file would run against the next file's
 * truncated database.
 */
export function resetAlertPoke(): void {
  if (pending) clearTimeout(pending);
  pending = null;
  listeners.clear();
}
