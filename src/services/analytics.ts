import { pool } from '../db/pool.js';

/**
 * `REFRESH MATERIALIZED VIEW CONCURRENTLY` takes an exclusive refresh lock on the view. A second
 * concurrent refresh does not fail fast — it waits, and `src/db/pool.ts` sets `statement_timeout` to
 * fifteen seconds, so waiting is how a duplicate refresh turns into an error in the log of whichever
 * caller lost. There are two callers now (the fifteen-minute scheduler below and the event-driven
 * recompute in `analytics-scheduler.ts`), so the guard belongs to the function rather than to one of
 * them. In memory and per process, like every other guard in this repo — single replica is the
 * deployed shape.
 */
let refreshing = false;

/** `false` means another caller held the refresh lock and this call did nothing. */
export async function refreshMonthlyAnalytics(): Promise<boolean> {
  if (refreshing) return false;
  refreshing = true;
  try {
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY monthly_alert_summary');
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY monthly_threat_summary');
    return true;
  } finally {
    refreshing = false;
  }
}

export function startAnalyticsScheduler(log: { info: Function; error: Function }): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await refreshMonthlyAnalytics();
      log.info('monthly analytics refreshed');
    } catch (error) {
      log.error({ error }, 'monthly analytics refresh failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, 15 * 60_000);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
