import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.NODE_ENV === 'test' ? 2 : 12,
  statement_timeout: 15_000,
  /**
   * Bounds a session that goes IDLE inside a transaction — an app stall between two statements of an
   * open transaction, which was previously unbounded. It does NOT bound transaction duration: a
   * backend executing statements back to back is never idle, so this timeout never fires for it, and
   * `statement_timeout` above bounds one statement rather than a sequence of N fast ones.
   *
   * That distinction matters because the publication cutoff's real bound IS transaction duration,
   * and nothing here caps it. `system_event_log.version` is a sequence value taken at INSERT while
   * `created_at` is transaction *start* time, so a write transaction whose total duration exceeds
   * the hold can still have its row skipped by the head bound in `src/services/sse.ts`: by the time
   * it becomes visible it is already older than the cutoff, and a later-numbered version that
   * committed first has moved the cursor past it. `persistOfficialAlertSnapshot` is exactly such a
   * transaction — a `reconcileAggregateAlert` loop over every oblast, hundreds of round trips with
   * no idle gap between them, comfortably past fifteen seconds during a nationwide alert.
   *
   * So this setting NARROWS an app stall and nothing else. The reorder it does not bound used to
   * lose rows outright — a reader whose cursor is `version > $1` stepped over a lower version that
   * was still invisible, and the notification fan-out, whose cursor is durable, never came back for
   * it. That is now closed on the READER side rather than here: both readers take only the
   * contiguous run of versions and stop before a gap, so an uncommitted lower version holds the
   * cursor instead of being overtaken by it. See `src/services/event-log-cursor.ts`.
   *
   * Bounding transaction duration itself was the other candidate and was not taken. PostgreSQL 17's
   * `transaction_timeout` (node-pg forwards `options: '-c transaction_timeout=…'` verbatim) ABORTS
   * an over-long nationwide snapshot rather than merely reporting it — trading a delayed alert for a
   * discarded one, which is the wrong direction for this product.
   */
  idle_in_transaction_session_timeout: 10_000,
  application_name: 'threatlens-ua'
});
