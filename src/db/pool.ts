import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.NODE_ENV === 'test' ? 2 : 12,
  statement_timeout: 15_000,
  /**
   * The publication cutoff's real bound is TRANSACTION duration, and until this line nothing bounded
   * it.
   *
   * `system_event_log.version` is a sequence value taken at INSERT while `created_at` is transaction
   * *start* time, so a write transaction whose total duration exceeds the hold can still have its
   * row skipped by the head bound in `src/services/sse.ts`: by the time it becomes visible it is
   * already older than the cutoff, and a later-numbered version that committed first has moved the
   * cursor past it. `statement_timeout` bounds one statement, not a transaction, and
   * `persistOfficialAlertSnapshot` loops `resolveLocationId` + `reconcileAggregateAlert` over every
   * oblast inside one transaction — comfortably past fifteen seconds during a nationwide alert.
   *
   * Ten seconds is therefore a ceiling on the gap, not its elimination: the risk is NARROWED, not
   * closed, and it is pre-existing in `live` mode (where the hold is zero and any commit reorder
   * does the same thing). Escalation path if a stronger guarantee is ever wanted: bound the head
   * additionally by the oldest in-flight write (`SELECT min(backend_xmin) …`, or an explicit
   * `publication_watermark` row advanced after commit).
   */
  idle_in_transaction_session_timeout: 10_000,
  application_name: 'threatlens-ua'
});
