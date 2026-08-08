import { Gauge, type Registry } from 'prom-client';
import { config } from '../config.js';
import { pool } from '../db/pool.js';

/**
 * The application's READ-ONLY view of the deployment journal.
 *
 * Nothing in this module writes. The journal is written by a different process in a different
 * container (`src/deployer/**`), which is the whole architecture: `app` terminates untrusted input
 * all day and must never hold the Docker socket, so it does not participate in a deployment beyond
 * proxying one confirmed button press and reading what the runner recorded.
 *
 * That asymmetry is what makes the ops page work across the restart it triggers. The runner writes
 * every stage transition into PostgreSQL — a database the update scenario deliberately never
 * restarts — so the instant a new `app` container answers, the full trail of what just happened,
 * including the tail of a failing build log, is a plain SELECT away.
 */

// ------------------------------------------------------------------------------------------------
// Reads
// ------------------------------------------------------------------------------------------------

export interface DeploymentStateView {
  remoteUrl: string | null;
  branch: string;
  remoteCommit: string | null;
  workingTreeCommit: string | null;
  workingTreeDirty: boolean;
  lastCheckedAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckError: string | null;
  runnerVersion: string | null;
}

export interface DeploymentRunView {
  id: number;
  status: string;
  currentStage: string | null;
  requestedAt: string;
  requestedBy: string;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
  fromCommit: string | null;
  toCommit: string | null;
  expectedCommit: string | null;
  runningCommitBefore: string | null;
  runningCommitAfter: string | null;
  migrationsApplied: string[];
  pendingManualServices: string[];
  errorCode: string | null;
  errorSummary: string | null;
  logTail: string | null;
  durationMs: number | null;
}

export interface DeploymentRunEventView {
  at: string;
  stage: string;
  outcome: string;
  durationMs: number | null;
  detail: string | null;
}

/** Commit relationship between origin/main, the checkout and the image that is actually serving. */
export type CommitState = 'in_sync' | 'behind' | 'drifted' | 'unknown';

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

const RUN_COLUMNS = `id,status,current_stage,requested_at,requested_by,started_at,finished_at,
  heartbeat_at,from_commit,to_commit,expected_commit,running_commit_before,running_commit_after,
  migrations_applied,pending_manual_services,error_code,error_summary,log_tail`;

function toRunView(row: Record<string, any>): DeploymentRunView {
  const started = row.started_at ?? row.requested_at;
  const finished = row.finished_at;
  return {
    id: Number(row.id),
    status: row.status,
    currentStage: row.current_stage,
    requestedAt: row.requested_at.toISOString(),
    requestedBy: row.requested_by,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    heartbeatAt: iso(row.heartbeat_at),
    fromCommit: row.from_commit,
    toCommit: row.to_commit,
    expectedCommit: row.expected_commit,
    runningCommitBefore: row.running_commit_before,
    runningCommitAfter: row.running_commit_after,
    migrationsApplied: row.migrations_applied ?? [],
    pendingManualServices: row.pending_manual_services ?? [],
    errorCode: row.error_code,
    errorSummary: row.error_summary,
    logTail: row.log_tail,
    durationMs: finished && started ? finished.getTime() - started.getTime() : null
  };
}

export async function readDeploymentState(): Promise<DeploymentStateView | null> {
  const result = await pool.query(
    `SELECT remote_url,branch,remote_commit,working_tree_commit,working_tree_dirty,
            last_checked_at,last_check_ok,last_check_error,runner_version
       FROM deployment_state WHERE singleton`
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    remoteUrl: row.remote_url,
    branch: row.branch,
    remoteCommit: row.remote_commit,
    workingTreeCommit: row.working_tree_commit,
    workingTreeDirty: row.working_tree_dirty,
    lastCheckedAt: iso(row.last_checked_at),
    lastCheckOk: row.last_check_ok,
    lastCheckError: row.last_check_error,
    runnerVersion: row.runner_version
  };
}

/**
 * The run that is in progress, if any.
 *
 * Read from `active_lock` rather than from a status list, so this module and the partial unique
 * index that enforces "one at a time" can never disagree about what "active" means.
 */
export async function readActiveRun(): Promise<DeploymentRunView | null> {
  const result = await pool.query(
    `SELECT ${RUN_COLUMNS} FROM deployment_runs WHERE active_lock LIMIT 1`
  );
  const row = result.rows[0];
  return row ? toRunView(row) : null;
}

export async function readRecentRuns(limit = 10): Promise<DeploymentRunView[]> {
  const result = await pool.query(
    `SELECT ${RUN_COLUMNS} FROM deployment_runs ORDER BY requested_at DESC LIMIT $1`,
    [Math.min(50, Math.max(1, limit))]
  );
  return result.rows.map(toRunView);
}

export async function readRunEvents(runId: number): Promise<DeploymentRunEventView[]> {
  const result = await pool.query(
    `SELECT at,stage,outcome,duration_ms,detail FROM deployment_run_events
      WHERE run_id=$1 ORDER BY id`,
    [runId]
  );
  return result.rows.map((row) => ({
    at: row.at.toISOString(),
    stage: row.stage,
    outcome: row.outcome,
    durationMs: row.duration_ms,
    detail: row.detail
  }));
}

/**
 * Where the running image sits relative to the checkout and to origin/main.
 *
 * Three distinguishable ways of not being current, because they need three different actions:
 *
 *   * `behind` — origin/main has moved past the checkout. Press the button.
 *   * `drifted` — the checkout is AT origin/main but the container is answering from another
 *     commit. Somebody moved the working tree by hand without rebuilding; the button repairs it, and
 *     until it is pressed the code on disk is not the code that is running.
 *   * `unknown` — no check has succeeded yet, or the image was built outside compose and honestly
 *     reports `APP_COMMIT=unknown`.
 */
export function commitState(state: DeploymentStateView | null, appCommit: string): CommitState {
  if (!state?.remoteCommit || !appCommit || appCommit === 'unknown') return 'unknown';
  if (state.remoteCommit === appCommit) return 'in_sync';
  if (state.workingTreeCommit === state.remoteCommit) return 'drifted';
  return 'behind';
}

// ------------------------------------------------------------------------------------------------
// Metrics
// ------------------------------------------------------------------------------------------------
//
// Constructed DETACHED (`registers: []`) and attached by `registerDeploymentMetrics(registry)` in
// `src/api/server.ts` — the shape `registerPublicationMetrics` and `registerAlertChannelMetrics`
// already use. Importing a service must never mutate a shared registry.

const RUN_STATUSES = [
  'queued', 'checking', 'building', 'migrating', 'starting', 'waiting_ready', 'succeeded', 'failed'
] as const;

const COMMIT_STATES: readonly CommitState[] = ['in_sync', 'behind', 'drifted', 'unknown'];

/**
 * How long a scrape may reuse the previous reading.
 *
 * `/metrics` is scraped every fifteen seconds by default and by more than one collector in a normal
 * setup. Two indexed statements per scrape is not much, but it is two statements against the same
 * pool the public snapshot uses, for a value that changes when an operator presses a button — i.e.
 * a few times a month. Ten seconds is short enough that a Prometheus scrape never shows a run as
 * active a minute after it ended, and long enough that a scrape storm cannot amplify.
 */
const MEMO_TTL_MS = 10_000;

interface DeploymentSample {
  runsByStatus: Map<string, number>;
  active: number;
  lastResult: 'succeeded' | 'failed' | null;
  lastSuccessAt: Date | null;
  lastRunDurationSeconds: number | null;
  commitState: CommitState;
  lastCheckAgeSeconds: number | null;
}

let memo: { at: number; value: Promise<DeploymentSample> } | null = null;

/**
 * Everything the seven gauges need, in TWO statements.
 *
 * The counts, the newest run and the newest success are folded into one CTE rather than issued as
 * three round trips: this runs on every `/metrics` scrape past the memo, against the same pool the
 * public snapshot uses, and a gauge is never worth three trips. Both statements are index-served —
 * the newest-run branch walks `deployment_runs_recent_idx`, and the state read is a primary-key
 * probe of a one-row table.
 */
async function sampleDeployment(): Promise<DeploymentSample> {
  const [aggregate, state] = await Promise.all([
    pool.query<{ by_status: Record<string, number>; last_run: Record<string, any> | null; last_success_at: Date | null }>(
      `WITH by_status AS (SELECT status, count(*)::int AS n FROM deployment_runs GROUP BY status),
            last_run AS (SELECT status, requested_at, started_at, finished_at
                           FROM deployment_runs ORDER BY requested_at DESC LIMIT 1)
       SELECT (SELECT COALESCE(json_object_agg(status, n), '{}'::json) FROM by_status) AS by_status,
              (SELECT row_to_json(l) FROM last_run l) AS last_run,
              (SELECT max(finished_at) FROM deployment_runs WHERE status='succeeded') AS last_success_at`
    ),
    readDeploymentState()
  ]);
  const row = aggregate.rows[0];
  const runsByStatus = new Map<string, number>(Object.entries(row?.by_status ?? {}));
  let active = 0;
  for (const [status, n] of runsByStatus) {
    if (status !== 'succeeded' && status !== 'failed') active += n;
  }
  const lastRun = row?.last_run ?? null;
  // `row_to_json` renders timestamps as ISO strings, so these are parsed rather than used directly.
  const lastStarted = Date.parse(lastRun?.started_at ?? lastRun?.requested_at ?? '');
  const lastFinished = Date.parse(lastRun?.finished_at ?? '');
  return {
    runsByStatus,
    active,
    lastResult: lastRun?.status === 'succeeded' || lastRun?.status === 'failed' ? lastRun.status : null,
    lastSuccessAt: row?.last_success_at ?? null,
    lastRunDurationSeconds: Number.isFinite(lastStarted) && Number.isFinite(lastFinished)
      ? (lastFinished - lastStarted) / 1000
      : null,
    commitState: commitState(state, config.APP_COMMIT),
    lastCheckAgeSeconds: state?.lastCheckedAt
      ? Math.max(0, (Date.now() - Date.parse(state.lastCheckedAt)) / 1000)
      : null
  };
}

function currentSample(): Promise<DeploymentSample> {
  const now = Date.now();
  if (memo && now - memo.at < MEMO_TTL_MS) return memo.value;
  // The PROMISE is memoised, not its result: two scrapes arriving in the same millisecond must
  // share one pair of statements rather than race to fill the slot.
  const value = sampleDeployment().catch((error) => {
    memo = null;
    throw error;
  });
  memo = { at: now, value };
  return value;
}

/** Test seam, and the counterpart of `resetRuntimeSettingsCache()` in the integration harness. */
export function resetDeploymentMetricsMemo(): void {
  memo = null;
}

const deployRuns = new Gauge({
  name: 'threatlens_deploy_runs',
  help: 'Recorded deployment runs by terminal or in-flight status',
  labelNames: ['status'], registers: [],
  async collect() {
    const sample = await currentSample();
    for (const status of RUN_STATUSES) this.set({ status }, sample.runsByStatus.get(status) ?? 0);
  }
});
const deployActive = new Gauge({
  name: 'threatlens_deploy_active',
  help: 'Deployment runs currently in a non-terminal state. Never above one',
  registers: [],
  async collect() { this.set((await currentSample()).active); }
});
const deployLastResult = new Gauge({
  name: 'threatlens_deploy_last_result',
  help: 'One for the outcome of the most recent deployment run, zero for the other',
  labelNames: ['result'], registers: [],
  async collect() {
    const sample = await currentSample();
    // Both series always present: a single-series gauge would leave a "no data" gap in a dashboard
    // at exactly the moment the result flips, which is the moment somebody is looking at it.
    for (const result of ['succeeded', 'failed'] as const) {
      this.set({ result }, sample.lastResult === result ? 1 : 0);
    }
  }
});
const deployLastSuccess = new Gauge({
  name: 'threatlens_deploy_last_success_timestamp_seconds',
  help: 'Unix time of the last successful deployment. Zero when there has never been one',
  registers: [],
  async collect() {
    const sample = await currentSample();
    this.set(sample.lastSuccessAt ? sample.lastSuccessAt.getTime() / 1000 : 0);
  }
});
const deployLastDuration = new Gauge({
  name: 'threatlens_deploy_last_run_duration_seconds',
  help: 'Wall-clock length of the most recent finished deployment run',
  registers: [],
  async collect() { this.set((await currentSample()).lastRunDurationSeconds ?? 0); }
});
const deployCommitState = new Gauge({
  name: 'threatlens_deploy_commit_state',
  help: 'One for the current relationship between origin/main, the checkout and the running image',
  labelNames: ['state'], registers: [],
  async collect() {
    const sample = await currentSample();
    for (const state of COMMIT_STATES) this.set({ state }, sample.commitState === state ? 1 : 0);
  }
});
const deployCheckAge = new Gauge({
  name: 'threatlens_deploy_last_check_age_seconds',
  help: 'Seconds since the runner last read origin/main. Grows without bound when the runner is down',
  registers: [],
  async collect() { this.set((await currentSample()).lastCheckAgeSeconds ?? -1); }
});

const METRICS: ReadonlyArray<[string, Gauge<string>]> = [
  ['threatlens_deploy_runs', deployRuns],
  ['threatlens_deploy_active', deployActive],
  ['threatlens_deploy_last_result', deployLastResult],
  ['threatlens_deploy_last_success_timestamp_seconds', deployLastSuccess],
  ['threatlens_deploy_last_run_duration_seconds', deployLastDuration],
  ['threatlens_deploy_commit_state', deployCommitState],
  ['threatlens_deploy_last_check_age_seconds', deployCheckAge]
];

/** Attaches this module's gauges to the one HTTP registry. Idempotent, like its neighbours. */
export function registerDeploymentMetrics(registry: Registry): void {
  for (const [name, metric] of METRICS) {
    if (!registry.getSingleMetric(name)) registry.registerMetric(metric);
  }
}
