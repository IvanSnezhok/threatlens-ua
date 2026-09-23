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
  const [{ closeHarnessPool, restoreSourceFlags }, { pool }] = await Promise.all([
    import('./db.js'),
    import('../../src/db/pool.js')
  ]);
  // ПЕРЕД закриттям пулів, і саме тут, а не в `resetDatabase()`: `sources` — довідкові дані, які
  // переживають скидання, тож усе, що файл увімкнув або вимкнув, лишалося б таким для КОЖНОГО
  // наступного файла набору. Саме так `telegram-collector.test.ts` бачив 52 канали замість 54 —
  // залежно від порядку, який vitest обрав того разу. Прибирання per-file, а не per-test, бо файл
  // має право вимкнути джерело у власному `beforeAll` на весь свій набір.
  await restoreSourceFlags().catch(() => undefined);
  await closeHarnessPool();
  await pool.end().catch(() => undefined);
});
