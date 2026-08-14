import { EventEmitter } from 'node:events';
import { pool } from '../db/pool.js';
import type { PublicationMode } from '../types.js';
import { onAlertPoke } from './alert-poke.js';
import { deliverableRun } from './event-log-cursor.js';
import { delaySecondsFor, observeSseDeliveryLag } from './publication.js';
import { resolveRuntimeSettingsWithStatus } from './runtime-settings.js';

/**
 * The one hub that turns `system_event_log` into two feeds.
 *
 * **`'event'` is the PUBLISHED feed and is gated; `'internal-event'` is the RECORDED feed and never
 * is.** The head bound is a publication decision, and the analytics recompute is not a publication
 * surface — «внутрішнє збереження, класифікація, аудит і моніторинг не затримуються». A scheduler on
 * the gated feed would not see a `threat.created` for fifteen seconds, would start its debounce
 * after that, and the map's аналітична оцінка would pay the hold twice: once here and once in
 * `currentAssessments(cutoff)`.
 *
 * The bot outbox is unaffected by either: it reads the log with its own durable cursor in
 * `worker_state('notification-fanout')` and never touches this hub.
 */

export interface SystemEvent {
  version: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
  // Envelope v2. Optional on the TYPE so the five existing `createEventRelay` unit tests and the
  // `tests/helpers/db.ts` fixtures keep compiling; ALWAYS populated by `publishedEnvelope()`, which
  // is the only place an outbound frame is built.
  envelopeVersion?: number;
  occurredAt?: string;
  publishedAt?: string;
  delayMode?: PublicationMode;
}

/**
 * Deliberately NOT called `version`: the wire already has two different things called version — the
 * log id on the `id:` line and the `connected` frame's `systemVersion()` — and a third collision
 * would be unreadable.
 */
export const SSE_ENVELOPE_VERSION = 2;

/**
 * The only place an outbound envelope is built. Used by the hub's live emit and by the reconnect
 * backfill, so the two can never drift into describing the same event differently.
 *
 * `version`, `eventType`, `payload` and `createdAt` are the compatibility contract and are
 * unchanged. Nothing added here may ever collide with the forbidden-token list pinned by
 * `tests/integration/threat-vector.test.ts`.
 */
export function publishedEnvelope(
  row: { version: number | string; event_type: string; payload: unknown; created_at: Date },
  mode: PublicationMode,
  now: Date
): SystemEvent {
  const createdAt = row.created_at.toISOString();
  return {
    // `bigserial` arrives from pg as a string; every consumer compares it numerically.
    version: Number(row.version),
    eventType: row.event_type,
    payload: row.payload,
    createdAt,
    envelopeVersion: SSE_ENVELOPE_VERSION,
    // `occurredAt` is deliberately equal to `createdAt` rather than a per-type real-world time (an
    // alert's `started_at`). A per-type time would need a domain read per frame, and the payload
    // already carries the id a client can read the real time from. Naming it states the meaning
    // instead of leaving it to be inferred from a column name.
    occurredAt: createdAt,
    publishedAt: now.toISOString(),
    delayMode: mode
  };
}

export interface EventRelay {
  buffer(event: SystemEvent): void;
  deliver(event: SystemEvent): void;
  flush(): void;
}

export function createEventRelay(sinceVersion: number, write: (event: SystemEvent) => void): EventRelay {
  let highest = sinceVersion;
  let pending: SystemEvent[] | null = [];
  const deliver = (event: SystemEvent) => {
    if (event.version <= highest) return;
    highest = event.version;
    write(event);
  };
  return {
    deliver,
    buffer: (event) => { if (pending) pending.push(event); else deliver(event); },
    flush: () => {
      const queued = pending ?? [];
      pending = null;
      for (const event of [...queued].sort((a, b) => a.version - b.version)) deliver(event);
    }
  };
}

class EventHub extends EventEmitter {
  private lastVersion: number | null = null;
  private internalVersion: number | null = null;
  private timer?: NodeJS.Timeout;
  /** Detaches this hub from the instant-propagation signal. Set by `start`, called by `stop`. */
  private detachPoke?: () => void;

  /** Cleared to `null`, never to `0`: `null` is what makes the next tick re-derive the cursor under
   *  the mode in force. Reached through the exported {@link resetEventHubCursor}. */
  clearCursors() {
    this.lastVersion = null;
    this.internalVersion = null;
  }

  private async readUnboundedHead(): Promise<number> {
    const head = await pool.query<{ version: string }>(
      `SELECT COALESCE(max(version),0) AS version FROM system_event_log`
    );
    return Number(head.rows[0]?.version ?? 0);
  }

  start() {
    if (this.timer) return;
    let polling = false;
    /**
     * A poke that arrived while a pass was in flight.
     *
     * The re-arm, not a second concurrent pass — the shape `analytics-scheduler.ts` calls `rearm`.
     * Without it a poke landing mid-pass would be *lost*, because the pass may already have run its
     * SELECT before the poking transaction became visible, and the event would then wait for the
     * ordinary tick after all. Set only by the poke handler: the one-second timer needs no re-arm,
     * it is coming round anyway.
     */
    let repoll = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        // The hold is a moving bound on the SELECT, not a queue in this process. A queue would be
        // lost on restart, would double-deliver against the reconnect backfill (which has no idea
        // what is sitting in memory), and would have to be re-sorted after a mode flip. A bound
        // cannot be lost, cannot be replayed and cannot be re-ordered, because the log is the only
        // state.
        const { settings, degraded } = await resolveRuntimeSettingsWithStatus();
        const delaySeconds = delaySecondsFor(settings.publicationMode);
        const modeChangedAt = settings.modeChangedAt;
        const cursor = this.lastVersion;
        if (cursor === null) {
          // First tick, and the cursor is initialised under the SAME bound. Initialising to the
          // unbounded max(version) while in delayed mode would permanently drop everything written
          // in the last `delaySeconds` before the restart: those rows are below the unbounded head,
          // so the cursor would start above them and they would never be selected again.
          //
          // And on a DEGRADED settings read we do not initialise at all. `resolveRuntimeSettings`
          // fails open to `live` on purpose — correct for publication timing, wrong here: on process
          // start the memo is empty, so one transient failure (pool warming, Postgres finishing
          // recovery) would set the cursor to the unbounded max(version) while the stored mode is
          // delayed_15s, and `lastVersion` only ever increases. Returning leaves it null and the
          // next tick retries, which is exactly what the comment in the catch below promises.
          if (degraded) return;
          const head = await pool.query<{ version: string }>(
            `SELECT COALESCE((SELECT version - 1 FROM system_event_log
                               WHERE created_at > GREATEST(now() - make_interval(secs => $1::int), $2::timestamptz)
                               ORDER BY version LIMIT 1),
                             (SELECT version FROM system_event_log ORDER BY version DESC LIMIT 1), 0) AS version`,
            [delaySeconds, modeChangedAt]
          );
          this.lastVersion = Number(head.rows[0]?.version ?? 0);
          this.internalVersion ??= await this.readUnboundedHead();
          return;
        }
        // `version <= head` rather than `created_at <= cutoff` per row. A per-row predicate would
        // let the cursor advance past a row that was not yet releasable — the cursor moves on emit,
        // and a row filtered out on one tick is below the cursor on the next — and that row would be
        // dropped forever. Bounding the head instead means the cursor can only ever stop *before* a
        // held row.
        //
        // The head is the version just BELOW the OLDEST row still held, not the newest row already
        // releasable. `max(version) WHERE created_at <= cutoff` looks equivalent and is not: version
        // order and created_at order diverge, because `version` is taken at INSERT while `created_at`
        // defaults to `now()` = transaction START. A long write transaction that appends its log rows
        // last (`persistOfficialAlertSnapshot`'s reconcile loop) produces HIGH versions carrying an
        // OLD created_at; the instant they become visible they lift a `max`-shaped head above every
        // short-transaction row that committed in between with a LOWER version and a NEWER created_at,
        // and the loop below emits those with no time check of their own — the hold silently degrades
        // to `delaySeconds − (write transaction duration)`, i.e. to nothing during a nationwide alert.
        // Stopping strictly before the first held row makes that unrepresentable: every emitted
        // version is below every row whose created_at is past the cutoff, so its own created_at is
        // necessarily at or before the cutoff.
        //
        // Five properties this shape buys:
        //  1. Nothing is skipped. The cursor only ever takes a value that was selected and emitted,
        //     in ascending `version`, and for a fixed hold `head(t)` is non-decreasing in `t` and
        //     converges to max(version), so every `v > cursor` is eventually `<= head`.
        //  2. The first tick uses the same bound, and refuses to initialise on a degraded read.
        //  3. A mode flip never rewinds the head. With the GREATEST(…, mode_changed_at) clamp,
        //     head(t₀⁺) >= head(t₀⁻), so emission does not even pause across a live→delayed_15s
        //     flip; the hold ramps in over `delaySeconds`.
        //  4. The internal feed below is never gated. Two cursors, one tick, one extra statement.
        //  5. The commit-order gap is closed, but NOT by this bound. A row still INVISIBLE when the
        //     head is computed cannot be seen by any bound derived from visible rows, so the head
        //     stops the cursor before a HELD row and never before an UNCOMMITTED one. The emit loop
        //     below takes only the contiguous run of versions, which does — see
        //     `src/services/event-log-cursor.ts`. Both halves are needed: the head decides what is
        //     releasable, the run decides what is complete.
        //
        // In `live` mode `delaySeconds = 0`, `now() - make_interval(secs => 0)` is `now()`, no
        // VISIBLE row can carry a created_at newer than this transaction's own start, the first
        // subselect is NULL, `head.v = max(version)`, and this is today's statement with an extra CTE
        // Postgres flattens. That equivalence is the whole safety argument for shipping this with the
        // switch off.
        const result = await pool.query(
          `WITH head AS (
             SELECT COALESCE((SELECT version - 1 FROM system_event_log
                               WHERE created_at > GREATEST(now() - make_interval(secs => $2::int), $3::timestamptz)
                               ORDER BY version LIMIT 1),
                             (SELECT version FROM system_event_log ORDER BY version DESC LIMIT 1), 0) AS v
           )
           SELECT l.version, l.event_type, l.payload, l.created_at
           FROM system_event_log l, head
           WHERE l.version > $1 AND l.version <= head.v
           ORDER BY l.version LIMIT 200`,
          [cursor, delaySeconds, modeChangedAt]
        );
        const releasedAt = new Date();
        const mode: PublicationMode = delaySeconds > 0 ? 'delayed_15s' : 'live';
        // Property 5 above — the commit-order gap — is what this closes. The head bound stops the
        // cursor before a row still HELD; it cannot stop it before a row still INVISIBLE, because no
        // bound computed from visible rows can see one. Taking only the contiguous run does, and it
        // is the same rule the notification fan-out now applies to its durable cursor.
        for (const row of deliverableRun(result.rows, cursor, releasedAt.getTime())) {
          this.lastVersion = Number(row.version);
          const envelope = publishedEnvelope(row, mode, releasedAt);
          observeSseDeliveryLag('live', (releasedAt.getTime() - row.created_at.getTime()) / 1000);
          this.emit('event', envelope);
        }

        // ----------------------------------------------------------------------------------------
        // The SECOND, UNBOUNDED feed — see the module header. `'internal-event'` exists so
        // `src/services/analytics-scheduler.ts` learns of a recorded fact at the instant it is
        // recorded, whatever the publication mode is. «внутрішній перерахунок може завершитися
        // раніше».
        // ----------------------------------------------------------------------------------------
        const internalCursor = this.internalVersion ?? 0;
        const internal = await pool.query(
          `SELECT version,event_type,payload,created_at FROM system_event_log
           WHERE version > $1 ORDER BY version LIMIT 200`, [internalCursor]
        );
        // Unbounded in TIME, not in ORDER. This feed skips the publication hold on purpose; skipping
        // a row whose transaction had not committed yet was never part of that intent.
        for (const row of deliverableRun(internal.rows, internalCursor, releasedAt.getTime())) {
          this.internalVersion = Number(row.version);
          this.emit('internal-event', publishedEnvelope(row, mode, releasedAt));
        }
      } catch {
        // Readiness and logs report database errors; the hub retries without terminating the app.
        // A failed cursor initialization leaves lastVersion null so the next tick retries instead
        // of replaying the whole log as live events.
      } finally {
        polling = false;
        if (repoll) { repoll = false; void poll(); }
      }
    };
    void poll();
    this.timer = setInterval(poll, 1000);
    this.timer.unref();
    /**
     * The instant-propagation path. It runs THIS poll — the same statement, the same head bound,
     * the same cursor — only sooner, which is the entire contract: `src/services/alert-poke.ts`
     * removes the wait for the timer and can never remove the hold, because the hold is the
     * `WHERE l.version <= head.v` above and a fresh row in `delayed_15s` is not below it. The
     * cursor cannot advance past a held row on a poked pass any more than on a timed one.
     */
    this.detachPoke = onAlertPoke(() => {
      if (polling) { repoll = true; return; }
      void poll();
    });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // Before the timer would matter: a listener left attached to a stopped hub would keep running
    // `poll()` against a pool `src/index.ts` is about to end, and would keep every later
    // integration file's events flowing into the previous file's cursor.
    this.detachPoke?.();
    this.detachPoke = undefined;
  }
}

export const eventHub = new EventHub();

/**
 * Clears BOTH cursors to `null` (not `0` — `null` is what makes the next tick re-derive them under
 * the mode in force).
 *
 * Required by every integration file that writes to `system_event_log`: `resetDatabase()` runs
 * `TRUNCATE … RESTART IDENTITY`, so `version` restarts at 1 while this in-memory cursor keeps
 * whatever the previous test left it at, and every `version > cursor` afterwards selects nothing.
 */
export function resetEventHubCursor(): void {
  eventHub.clearCursors();
}
