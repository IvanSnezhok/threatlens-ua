import { Counter } from 'prom-client';

/**
 * The in-process «щойно почалася тривога» signal.
 *
 * ================================================================================================
 * What it is for
 * ================================================================================================
 *
 * Two workers stand between an `alert.started` row reaching `system_event_log` and a person seeing
 * it, and both of them are pollers on a one-second timer: the SSE hub (`src/services/sse.ts`) and
 * the notification fan-out (`src/bot/outbox.ts`). Two seconds of the end-to-end budget is therefore
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
 * **It is scoped to alert STARTS.** `alert.ended`, `threat.*` and everything else ride the normal
 * tick. The asymmetry is the product decision this delivery implements: a warning that arrives late
 * is a warning that arrives too late, and an all-clear that arrives late is merely unhurried — and
 * `docs/ARCHITECTURE.md` §Consistency rules already treats the two directions asymmetrically
 * everywhere else.
 *
 * ================================================================================================
 * Storm proof
 * ================================================================================================
 *
 * Three independent bounds, so a nationwide raid cannot turn this into a load source:
 *
 *  1. **One poke per COMMIT, not per row.** The callers accumulate the starts a transaction created
 *     and poke once after it commits. A snapshot that raises twenty-five oblasts at once is one
 *     poke.
 *  2. **One pending poke at a time.** A poke while one is already armed is counted and dropped, so
 *     the listeners can never be called twice for the same macrotask turn however many callers fire
 *     inside it.
 *  3. **The consumers are themselves guarded.** The hub refuses a re-entrant poll and the fan-out
 *     refuses a re-entrant pass; both re-arm ONE pending pass instead, the same shape
 *     `analytics-scheduler.ts` uses for `rearm`. A poke landing during a pass costs a flag, not a
 *     statement.
 *
 * The resulting ceiling: pokes per second ≤ committing-transactions-that-started-an-alert per
 * second, which is bounded above by the poll cadence of the three snapshot legs plus the message
 * rate of the alert channels. `threatlens_alert_pokes_total` is the series that proves it in
 * production, and its `coalesced` share is the number a runbook reads.
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
 * Pokes raised, by what happened to them.
 *
 * `coalesced` is not a failure: it is bound 2 above doing its job, and a healthy nationwide raid
 * shows some. A `coalesced` rate that dwarfs `fired` means several writers are committing inside
 * one macrotask turn, which is worth knowing and is not worth acting on.
 */
const alertPokes = new Counter({
  name: 'threatlens_alert_pokes_total',
  help: 'Instant-propagation signals raised after an alert.started was committed, by outcome',
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
 * Raise the signal. Call this AFTER the transaction that wrote the `alert.started` rows commits —
 * a poke that arrives before the COMMIT sends both consumers to read a row they cannot see yet, and
 * the ordinary tick would then be the thing that actually delivered it.
 *
 * Fires on the next macrotask rather than synchronously, for two reasons that are both about the
 * caller: the poke must not run a database pass inside the caller's `finally`, and the next
 * macrotask is the coalescing window — every caller that commits in the same turn produces one
 * poke between them.
 */
export function pokeAlertStarted(): void {
  if (pending) {
    alertPokes.inc({ outcome: 'coalesced' });
    return;
  }
  pending = setTimeout(() => {
    pending = null;
    alertPokes.inc({ outcome: 'fired' });
    // A copy, and a `try` per listener: one consumer throwing must not stop the other from being
    // told, and neither must be able to take the process down from a timer callback.
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* the consumers log their own failures */ }
    }
  }, 0);
  pending.unref?.();
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
