import pg from 'pg';
import { redactSecrets } from './exec.js';

/**
 * The deployment journal: everything this package writes to and reads from PostgreSQL.
 *
 * ## Why PostgreSQL and not a file
 *
 * The journal has to survive the thing it describes. An update destroys and recreates the `app`
 * container; the operator's browser loses the page mid-run and comes back asking "what happened".
 * A record held in the app process, or in a volume the app owns, is gone at exactly that moment.
 * PostgreSQL is the one service the scenario deliberately never restarts (`./runner.ts` freezes the
 * restart list to `app` and `caddy`), it is writable while `app` is down, and it is where `/ops`
 * already reads everything else.
 *
 * ## The three layers of "only one run at a time"
 *
 *   1. **Invariant** — `deployment_runs.active_lock` is GENERATED from `status` and carries a
 *      partial unique index. A second active row is a 23505, not a race, and it holds even if every
 *      runner process is killed.
 *   2. **Liveness** — {@link acquireDeployLock}. A session-scoped advisory lock on a dedicated
 *      connection. PostgreSQL releases it when the connection dies, which is the only signal that
 *      distinguishes "a run is in progress" from "a runner was killed mid-run". Acquiring it while
 *      an active row exists therefore PROVES the row is abandoned, which is what
 *      {@link reapAbandonedRuns} acts on.
 *   3. **Display** — `heartbeat_at`, refreshed every ten seconds. Never a decision input; it is what
 *      lets the ops card say «оновлення триває» rather than «оновлення зависло».
 */

const { Pool } = pg;

/** Statuses that count as an active run. Must match the CHECK and the GENERATED column in 023. */
export const DEPLOY_ACTIVE_STAGES = [
  'queued', 'checking', 'building', 'migrating', 'starting', 'waiting_ready'
] as const;

export type DeployStage = typeof DEPLOY_ACTIVE_STAGES[number];
export type DeployStatus = DeployStage | 'succeeded' | 'failed';
export type DeployOutcome = 'started' | 'ok' | 'failed' | 'skipped';

/** The advisory-lock key. `hashtext` is stable for a given string across sessions and versions. */
const DEPLOY_LOCK_SQL = `SELECT pg_try_advisory_lock(hashtext('threatlens-deploy')) AS acquired`;

export interface RunFacts {
  fromCommit: string | null;
  toCommit: string | null;
  runningCommitBefore: string | null;
  runningCommitAfter: string | null;
  migrationsBefore: number | null;
  migrationsAfter: number | null;
  migrationsApplied: string[];
  pendingManualServices: string[];
}

export interface RunEvent {
  stage: string;
  outcome: DeployOutcome;
  durationMs?: number;
  detail?: string;
}

export interface RunFinish {
  status: 'succeeded' | 'failed';
  stage: DeployStage;
  errorCode?: string;
  errorSummary?: string;
  logTail?: string;
}

/**
 * Everything {@link import('./runner.js').runDeployment} is allowed to do to the journal.
 *
 * An interface rather than the concrete writer so the unit tests can run the whole scenario with an
 * in-memory journal and no database, and so the runner cannot reach for a statement of its own.
 */
export interface RunJournal {
  readonly runId: number;
  /** Moves the run into a stage and appends a `started` event for it. */
  stage(stage: DeployStage, detail?: string): Promise<void>;
  event(entry: RunEvent): Promise<void>;
  /** Merges recorded facts onto the run row. Only the named fields are written. */
  record(fields: Partial<RunFacts>): Promise<void>;
  finish(outcome: RunFinish): Promise<void>;
}

export interface DeployLock {
  release(): Promise<void>;
}

export interface CreateRunInput {
  requestedBy: string;
  remoteUrl: string;
  expectedCommit: string;
  runnerId: string;
}

export interface DeploymentStateInput {
  remoteUrl: string | null;
  remoteCommit: string | null;
  workingTreeCommit: string | null;
  workingTreeDirty: boolean;
  lastCheckOk: boolean;
  lastCheckError: string | null;
  runnerVersion: string | null;
}

export function createDeployPool(connectionString: string): pg.Pool {
  return new Pool({
    connectionString,
    // Three is the whole budget: the advisory-lock holder, the journal writer and one spare for the
    // periodic check. A runner that needs a connection pool is a runner doing too much.
    max: 3,
    application_name: 'threatlens-deployer'
  });
}

/**
 * Takes the session-scoped advisory lock, or returns null if another live runner holds it.
 *
 * The connection is held for the whole run and released with the lock. That is the point: if this
 * process is killed, PostgreSQL drops the connection and the lock with it, and the next runner's
 * successful acquisition is the proof that the previous run is abandoned rather than in progress.
 */
export async function acquireDeployLock(pool: pg.Pool): Promise<DeployLock | null> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ acquired: boolean }>(DEPLOY_LOCK_SQL);
    if (!result.rows[0]?.acquired) {
      client.release();
      return null;
    }
  } catch (error) {
    client.release();
    throw error;
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      // Releasing the advisory lock explicitly and THEN the connection: a pooled connection that is
      // handed back still holding a session lock would hold it for the next borrower too.
      await client.query(`SELECT pg_advisory_unlock(hashtext('threatlens-deploy'))`).catch(() => undefined);
      client.release();
    }
  };
}

/**
 * Fails every active run row, for a caller that has just proved no runner owns them.
 *
 * ONLY call this while holding the advisory lock. Without that proof this statement would fail the
 * run of a healthy peer runner, which is worse than the abandoned row it is trying to clean up.
 */
export async function reapAbandonedRuns(pool: pg.Pool, runnerId: string): Promise<number> {
  const result = await pool.query(
    `UPDATE deployment_runs
        SET status='failed', finished_at=now(), error_code='runner_lost',
            error_summary=$2, current_stage=COALESCE(current_stage, status)
      WHERE status = ANY($1::text[])`,
    [
      [...DEPLOY_ACTIVE_STAGES],
      `The runner holding this run is gone; ${runnerId} reclaimed the deployment lock while the run was still active.`
    ]
  );
  return result.rowCount ?? 0;
}

/** When the newest run was requested, for the minimum-interval refusal. */
export async function lastRunRequestedAt(pool: pg.Pool): Promise<Date | null> {
  const result = await pool.query<{ requested_at: Date }>(
    `SELECT requested_at FROM deployment_runs ORDER BY requested_at DESC LIMIT 1`
  );
  return result.rows[0]?.requested_at ?? null;
}

/**
 * Opens the run row.
 *
 * `remote_ref` is left at its column default (`refs/heads/main`), which the CHECK constraint pins:
 * there is no parameter here that could carry another ref, which is what keeps "only main" true
 * after somebody adds a field to a form. A 23505 from the partial unique index means another active
 * run exists and is the caller's cue for a 409.
 */
export async function createRun(pool: pg.Pool, input: CreateRunInput): Promise<number> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO deployment_runs(status,current_stage,requested_by,remote_url,expected_commit,runner_id,heartbeat_at)
     VALUES ('queued','queued',$1,$2,$3,$4,now()) RETURNING id`,
    [input.requestedBy, input.remoteUrl, input.expectedCommit, input.runnerId]
  );
  return Number(result.rows[0]!.id);
}

/**
 * The PostgreSQL-backed {@link RunJournal} for one run.
 *
 * `redact` strips the process's secrets from every free-text column at the moment of the write.
 * This is THE redaction boundary: `spawnExec` hands back raw output because the runner compares it
 * (the first production check died on a password that was a substring of the repository name), and
 * only what lands in the journal is rendered on the ops page.
 */
export function openRunJournal(pool: pg.Pool, runId: number, redact: readonly string[] = []): RunJournal {
  const clean = (text: string | null | undefined) =>
    text === null || text === undefined ? null : redactSecrets(text, redact);
  const appendEvent = async (entry: RunEvent) => {
    await pool.query(
      `INSERT INTO deployment_run_events(run_id,stage,outcome,duration_ms,detail) VALUES ($1,$2,$3,$4,$5)`,
      [runId, entry.stage, entry.outcome, entry.durationMs ?? null, clean(entry.detail)]
    );
  };
  return {
    runId,
    async stage(stage, detail) {
      await pool.query(
        `UPDATE deployment_runs
            SET status=$2, current_stage=$2, heartbeat_at=now(),
                started_at=COALESCE(started_at, now())
          WHERE id=$1`,
        [runId, stage]
      );
      await appendEvent({ stage, outcome: 'started', detail });
    },
    event: appendEvent,
    async record(fields) {
      // Every column is written as COALESCE($n, column): a partial record must not blank a fact an
      // earlier step established. The runner records each fact exactly once, in order.
      await pool.query(
        `UPDATE deployment_runs SET
           from_commit=COALESCE($2, from_commit),
           to_commit=COALESCE($3, to_commit),
           running_commit_before=COALESCE($4, running_commit_before),
           running_commit_after=COALESCE($5, running_commit_after),
           migrations_before=COALESCE($6, migrations_before),
           migrations_after=COALESCE($7, migrations_after),
           migrations_applied=COALESCE($8::text[], migrations_applied),
           pending_manual_services=COALESCE($9::text[], pending_manual_services),
           heartbeat_at=now()
         WHERE id=$1`,
        [
          runId,
          fields.fromCommit ?? null, fields.toCommit ?? null,
          fields.runningCommitBefore ?? null, fields.runningCommitAfter ?? null,
          fields.migrationsBefore ?? null, fields.migrationsAfter ?? null,
          fields.migrationsApplied ?? null, fields.pendingManualServices ?? null
        ]
      );
    },
    async finish(outcome) {
      await pool.query(
        `UPDATE deployment_runs
            SET status=$2, current_stage=$3, finished_at=now(), heartbeat_at=now(),
                error_code=$4, error_summary=$5, log_tail=$6
          WHERE id=$1`,
        [runId, outcome.status, outcome.stage, outcome.errorCode ?? null,
          clean(outcome.errorSummary), clean(outcome.logTail)]
      );
      await appendEvent({
        stage: outcome.stage,
        outcome: outcome.status === 'succeeded' ? 'ok' : 'failed',
        detail: outcome.errorCode
      });
    }
  };
}

/**
 * Refreshes `heartbeat_at` on a cadence and returns its canceller.
 *
 * Display only. A stalled heartbeat never fails a run by itself — the advisory lock decides that —
 * but a run whose heartbeat is minutes old is how an operator tells «триває» from «зависло».
 */
export function startHeartbeat(pool: pg.Pool, runId: number, intervalMs = 10_000): () => void {
  const timer = setInterval(() => {
    void pool.query(`UPDATE deployment_runs SET heartbeat_at=now() WHERE id=$1`, [runId]).catch(() => undefined);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Filenames in `schema_migrations`, sorted. The set difference around the migrate step. */
export async function appliedMigrations(pool: pg.Pool): Promise<string[]> {
  const result = await pool.query<{ filename: string }>(
    `SELECT filename FROM schema_migrations ORDER BY filename`
  );
  return result.rows.map((row) => row.filename);
}

/** Upserts the singleton observation row. The row itself is seeded by migration 023. */
export async function writeDeploymentState(
  pool: pg.Pool, state: DeploymentStateInput, redact: readonly string[] = []
): Promise<void> {
  await pool.query(
    `UPDATE deployment_state SET
       remote_url=$1, remote_commit=$2, working_tree_commit=$3, working_tree_dirty=$4,
       last_checked_at=now(), last_check_ok=$5, last_check_error=$6, runner_version=$7, updated_at=now()
     WHERE singleton`,
    [
      // remote_url і текст помилки — єдині вільнотекстові поля рядка; редагування тут, а не при
      // захопленні виводу, бо порівняння в runner мусять бачити сирі байти.
      redactSecrets(state.remoteUrl ?? '', redact) || null, state.remoteCommit,
      state.workingTreeCommit, state.workingTreeDirty,
      state.lastCheckOk,
      state.lastCheckError === null ? null : redactSecrets(state.lastCheckError, redact),
      state.runnerVersion
    ]
  );
}
