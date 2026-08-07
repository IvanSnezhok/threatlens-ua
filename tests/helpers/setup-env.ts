import { afterAll, inject } from 'vitest';

/**
 * Runs inside the worker *before* any integration test module is imported.
 *
 * This ordering is load-bearing: `src/config.ts` parses `process.env` at import time and
 * `src/db/pool.ts` builds its singleton pool from the parsed value, so the database URL and the
 * source tokens have to be in place before anything under `src/` is pulled in.
 */
const databaseUrl = inject('integrationDatabaseUrl' as never) as string | null;

if (databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
  process.env.TL_INTEGRATION_DB = '1';
} else {
  delete process.env.TL_INTEGRATION_DB;
}

process.env.NODE_ENV = 'test';
process.env.PUBLIC_URL = 'http://localhost:3000';
process.env.DEMO_SOURCE_ENABLED = 'false';
process.env.KATOTTG_SYNC_ENABLED = 'false';
process.env.OCCUPATION_SOURCE_ENABLED = 'false';
process.env.TELEGRAM_MODE = 'disabled';
// Both official adapters return early without a token, so the reconciliation tests need one.
process.env.UKRAINE_ALARM_API_TOKEN = 'integration-ukraine-alarm-token';
process.env.ALERTS_IN_UA_TOKEN = 'integration-alerts-in-ua-token';

afterAll(async () => {
  if (!databaseUrl) return;
  const [{ closeHarnessPool }, { pool }] = await Promise.all([
    import('./db.js'),
    import('../../src/db/pool.js')
  ]);
  await closeHarnessPool();
  await pool.end().catch(() => undefined);
});
