import { pool } from '../db/pool.js';

export async function refreshMonthlyAnalytics(): Promise<void> {
  await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY monthly_alert_summary');
  await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY monthly_threat_summary');
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
