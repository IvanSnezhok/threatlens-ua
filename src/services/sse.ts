import { EventEmitter } from 'node:events';
import { pool } from '../db/pool.js';
import type { PublicationMode } from '../types.js';
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
            `SELECT COALESCE((SELECT version FROM system_event_log
                               WHERE created_at <= GREATEST(now() - make_interval(secs => $1::int), $2::timestamptz)
                               ORDER BY version DESC LIMIT 1), 0) AS version`,
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
        // Five properties this shape buys:
        //  1. Nothing is skipped. The cursor only ever takes a value that was selected and emitted,
        //     in ascending `version`, and for a fixed hold `head(t)` is non-decreasing in `t` and
        //     converges to max(version), so every `v > cursor` is eventually `<= head`.
        //  2. The first tick uses the same bound, and refuses to initialise on a degraded read.
        //  3. A mode flip never rewinds the head. With the GREATEST(…, mode_changed_at) clamp,
        //     head(t₀⁺) >= head(t₀⁻), so emission does not even pause across a live→delayed_15s
        //     flip; the hold ramps in over `delaySeconds`.
        //  4. The internal feed below is never gated. Two cursors, one tick, one extra statement.
        //  5. The commit-order gap is narrowed, not closed. `version` is taken at INSERT while
        //     `created_at` is transaction-START time, so a transaction whose TOTAL duration exceeds
        //     the hold can still have its row skipped — exactly as it can today in live mode.
        //     `idle_in_transaction_session_timeout: 10_000` in `src/db/pool.ts` is what makes that
        //     duration bounded at all; see the comment there for the escalation path.
        //
        // In `live` mode `delaySeconds = 0`, `now() - make_interval(secs => 0)` is `now()`, every
        // committed row satisfies `created_at <= now()`, `head.v = max(version)`, and this is
        // today's statement with an extra CTE Postgres flattens. That equivalence is the whole
        // safety argument for shipping this with the switch off.
        const result = await pool.query(
          `WITH head AS (
             SELECT COALESCE((SELECT version FROM system_event_log
                               WHERE created_at <= GREATEST(now() - make_interval(secs => $2::int), $3::timestamptz)
                               ORDER BY version DESC LIMIT 1), 0) AS v
           )
           SELECT l.version, l.event_type, l.payload, l.created_at
           FROM system_event_log l, head
           WHERE l.version > $1 AND l.version <= head.v
           ORDER BY l.version LIMIT 200`,
          [cursor, delaySeconds, modeChangedAt]
        );
        const releasedAt = new Date();
        const mode: PublicationMode = delaySeconds > 0 ? 'delayed_15s' : 'live';
        for (const row of result.rows) {
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
        const internal = await pool.query(
          `SELECT version,event_type,payload,created_at FROM system_event_log
           WHERE version > $1 ORDER BY version LIMIT 200`, [this.internalVersion ?? 0]
        );
        for (const row of internal.rows) {
          this.internalVersion = Number(row.version);
          this.emit('internal-event', publishedEnvelope(row, mode, releasedAt));
        }
      } catch {
        // Readiness and logs report database errors; the hub retries without terminating the app.
        // A failed cursor initialization leaves lastVersion null so the next tick retries instead
        // of replaying the whole log as live events.
      } finally {
        polling = false;
      }
    };
    void poll();
    this.timer = setInterval(poll, 1000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
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
