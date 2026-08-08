import { pool } from '../db/pool.js';

export async function markSourceSuccess(sourceId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ health_status: string }>(
      `SELECT health_status FROM sources WHERE id=$1 FOR UPDATE`, [sourceId]
    );
    if (!current.rowCount) throw new Error(`Unknown source: ${sourceId}`);
    await client.query(
      `UPDATE sources SET last_success_at=now(),last_error=NULL,health_status='current' WHERE id=$1`,
      [sourceId]
    );
    if (current.rows[0]!.health_status === 'stale' || current.rows[0]!.health_status === 'error') {
      await client.query(
        `INSERT INTO system_event_log(event_type,payload) VALUES ('source.recovered',$1)`,
        [JSON.stringify({ sourceId })]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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

export function startOperationsScheduler(log: { info: Function; error: Function }): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const [expired, stale, purged] = await Promise.all([
        expireThreatEvents(), updateSourceFreshness(), purgeNotificationState()
      ]);
      if (expired || stale || purged) log.info({ expired, stale, purged }, 'operational state updated');
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
