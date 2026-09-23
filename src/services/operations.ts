import { pool } from '../db/pool.js';
import { pruneTrackActualizations } from './track-actualization.js';

/**
 * Marks a batch of sources fresh in ONE transaction, and reports which of them were not fresh
 * before.
 *
 * ## Why the batch exists
 *
 * The MTProto heartbeat (`src/sources/telegram.ts`) used to call the single-source form in a loop
 * over every live channel. At fifty-four channels and a one-minute heartbeat that is 54 × (connect
 * + BEGIN + SELECT … FOR UPDATE + UPDATE + COMMIT) — 216 statements and 54 pool checkouts per
 * minute, fired concurrently into a twelve-connection pool, forever, to write a column whose whole
 * content is «still alive». The batch says the same thing in three statements and one checkout, and
 * the fifty-four row locks are taken in one ordered pass instead of fifty-four interleaved ones.
 *
 * ## Why the pre-image is read the way it is
 *
 * `source.recovered` is a TRANSITION, not a state: it must be appended exactly when a row was
 * `stale` or `error` and is now `current`, and never on the fifty-nine following heartbeats that
 * find it already `current`. `UPDATE … RETURNING` returns the NEW row, so the old status has to be
 * captured before the write — the sub-select in `FROM` does that, and its `FOR UPDATE` is the same
 * lock the single-source path always took, so two collectors heartbeating the same source still
 * serialise rather than both claiming the recovery. `ORDER BY id` inside it is what keeps two
 * overlapping batches from deadlocking on the same rows in opposite orders.
 *
 * A source id with no row is reported rather than swallowed — the same diagnostic the single-source
 * form raised — but only AFTER the rows that do exist have been committed: one channel deleted from
 * the registry must not cost the other fifty-three their freshness.
 */
export async function markSourcesSuccess(sourceIds: readonly string[]): Promise<void> {
  const ids = [...new Set(sourceIds)];
  if (!ids.length) return;
  const client = await pool.connect();
  let missing: string[];
  try {
    await client.query('BEGIN');
    const updated = await client.query<{ id: string; previous_status: string }>(
      `UPDATE sources SET last_success_at=now(),last_error=NULL,health_status='current'
         FROM (SELECT id,health_status FROM sources WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE) pre
        WHERE sources.id = pre.id
       RETURNING sources.id, pre.health_status AS previous_status`,
      [ids]
    );
    const recovered = updated.rows
      .filter((row) => row.previous_status === 'stale' || row.previous_status === 'error')
      .map((row) => row.id);
    if (recovered.length) {
      await client.query(
        `INSERT INTO system_event_log(event_type,payload)
         SELECT 'source.recovered', jsonb_build_object('sourceId', id) FROM unnest($1::text[]) AS id`,
        [recovered]
      );
    }
    await client.query('COMMIT');
    const seen = new Set(updated.rows.map((row) => row.id));
    missing = ids.filter((id) => !seen.has(id));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (missing.length) throw new Error(`Unknown source${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
}

export async function markSourceSuccess(sourceId: string): Promise<void> {
  await markSourcesSuccess([sourceId]);
}

export async function markSourceError(sourceId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await pool.query(
    `UPDATE sources SET last_error_at=now(),last_error=$2,health_status='error' WHERE id=$1`,
    [sourceId, message.slice(0, 800)]
  );
}

/**
 * Retires the events whose validity window has elapsed.
 *
 * `ended_at=now()`, deliberately NOT `COALESCE(ended_at,valid_until,now())`. `ended_at` is what the
 * publication cutoff reads to decide how long a terminated event stays on the delayed public map:
 * `liveThreats` (src/repositories/events.ts) keeps a terminal row while `ended_at > cutoff`, which
 * is exactly as long as the `threat.expired` frame written below is held by the hub. Back-dating
 * `ended_at` to `valid_until` broke that handoff — the WHERE above guarantees `valid_until <=
 * now()`, so it is the deadline, older than this sweep by however late the thirty-second timer
 * caught the row. Whenever that lateness reached `PUBLICATION_DELAY_SECONDS` the row left the public
 * snapshot at the instant this transaction committed, fifteen seconds BEFORE the frame that explains
 * it — an early all-clear, the direction `docs/ARCHITECTURE.md` §Consistency rules calls
 * unrecoverable. The withdrawal (events.ts `applyRetraction`) and correction paths already write
 * `now()`; expiry is now symmetric with them.
 *
 * Nothing is lost by it: the validity deadline stays on the row as `valid_until`, which is the
 * column every reader that wants "until when was this true" already reads. In `live` mode the cutoff
 * is `now()`, `ended_at > now()` is false either way, and the row leaves the map exactly as before.
 */
export async function expireThreatEvents(): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const candidates = await client.query<{ id: string; evidence_level: string; status: string }>(
      `SELECT id,evidence_level,status FROM threat_events
       WHERE status IN ('observed','confirmed','active') AND valid_until IS NOT NULL AND valid_until<=now()
       FOR UPDATE`
    );
    for (const event of candidates.rows) {
      await client.query(
        `UPDATE threat_events SET status='expired',ended_at=now(),updated_at=now() WHERE id=$1`,
        [event.id]
      );
      await client.query(
        `INSERT INTO event_updates(event_id,previous_status,new_status,previous_evidence_level,new_evidence_level,reason)
         VALUES ($1,$2,'expired',$3,$3,'validity_window_elapsed')`,
        [event.id, event.status, event.evidence_level]
      );
      await client.query(
        `INSERT INTO system_event_log(event_type,payload) VALUES ('threat.expired',$1)`,
        [JSON.stringify({ eventId: event.id })]
      );
    }
    await client.query('COMMIT');
    return candidates.rowCount ?? 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function updateSourceFreshness(): Promise<number> {
  const stale = await pool.query<{ id: string }>(
    `UPDATE sources SET health_status='stale'
     WHERE enabled=true AND health_status='current' AND last_success_at IS NOT NULL
       AND last_success_at < now()-(stale_after_seconds||' seconds')::interval
     RETURNING id`
  );
  for (const source of stale.rows) {
    await pool.query(
      `INSERT INTO system_event_log(event_type,payload) VALUES ('source.stale',$1)`,
      [JSON.stringify({ sourceId: source.id })]
    );
  }
  return stale.rowCount ?? 0;
}

/**
 * Drops the per-chat notification state of threats and assessments that are long over.
 *
 * The table holds one row per subscriber per entity, so without this it grows for as long as the
 * service runs. `expires_at` is set six hours past a threat's validity window (and twelve hours for
 * an assessment), which is far beyond the point where a repeat could still be mistaken for the same
 * warning — deleting earlier would only turn the next mention of a stale threat into a fresh
 * «нова загроза» message.
 */
export async function purgeNotificationState(): Promise<number> {
  const purged = await pool.query(`DELETE FROM notification_state WHERE expires_at < now()`);
  return purged.rowCount ?? 0;
}

/**
 * The track actualizations (migration 055) live seven days. Pruned from this tick, but once an hour
 * rather than every thirty seconds: the DELETE has no index on `created_at` to ride — the table's one
 * index leads with `event_id`, for the reads that matter — and a scan of a week of rows twice a minute
 * would be the housekeeping costing more than the thing it keeps tidy.
 */
const ACTUALIZATION_PRUNE_EVERY_MS = 3_600_000;

export function startOperationsScheduler(log: { info: Function; error: Function }): () => void {
  let running = false;
  let actualizationsPrunedAt = 0;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const pruneActualizations = Date.now() - actualizationsPrunedAt >= ACTUALIZATION_PRUNE_EVERY_MS;
      const [expired, stale, purged, actualizations] = await Promise.all([
        expireThreatEvents(), updateSourceFreshness(), purgeNotificationState(),
        pruneActualizations ? pruneTrackActualizations() : Promise.resolve(0)
      ]);
      if (pruneActualizations) actualizationsPrunedAt = Date.now();
      if (expired || stale || purged || actualizations) {
        log.info({ expired, stale, purged, actualizations }, 'operational state updated');
      }
    } catch (error) {
      log.error({ error }, 'operational state update failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, 30_000);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
