import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { count, ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';
import { parseDeployerConfig } from '../../src/deployer/config.js';
import { fakeExec, type ExecScript } from '../../src/deployer/exec.js';
import { createDeployPool } from '../../src/deployer/journal.js';
import { createDeployServer, type DeployServer } from '../../src/deployer/server.js';
import type { ProbeResult, ReadyProbe } from '../../src/deployer/runner.js';

/**
 * The deployment runner against a live PostgreSQL: the journal, the lock and the refusals.
 *
 * `src/deployer/runner.test.ts` proves the scenario's argv with everything faked. What it cannot
 * prove is the half of this feature that lives in the database — that two operators pressing the
 * button at the same moment produce one run and one 409, that a run row is physically impossible to
 * duplicate, that a runner killed mid-update leaves a *recorded* failure rather than a run that
 * appears to be in progress forever, and that the set difference of `schema_migrations` around the
 * migrate step is what lands in `migrations_applied`.
 *
 * Only the two injected ports are faked: `Exec` (no Docker, no git) and `ReadyProbe` (no HTTP). The
 * journal, the advisory lock, the partial unique index and the migration reader are all real.
 */

const REPO = '/opt/threatlens-ua';
const REPO_URL = 'https://github.com/IvanSnezhok/threatlens-ua.git';
const TOKEN = 'integration-deploy-runner-token-0123456789';
const FROM = '0011223344556677889900aabbccddeeff001122';
const TARGET = '1f2e3d4c5b6a70819283746556473829100aabbc';
const COMPOSE = `docker compose -p threatlens --project-directory ${REPO} -f ${REPO}/compose.yaml`;
const FAKE_MIGRATION = '999_integration_deploy_runner.sql';

function baseScript(): ExecScript {
  return {
    [`git -C ${REPO} remote get-url origin`]: { stdout: `${REPO_URL}\n` },
    [`git -C ${REPO} status --porcelain`]: { stdout: '' },
    [`git -C ${REPO} fetch --prune --no-tags origin +refs/heads/main:refs/remotes/origin/main`]: {},
    [`git -C ${REPO} rev-parse refs/remotes/origin/main`]: { stdout: `${TARGET}\n` },
    [`git -C ${REPO} rev-parse HEAD`]: { stdout: `${FROM}\n` },
    [`git -C ${REPO} checkout --detach ${TARGET}`]: {},
    [`${COMPOSE} build app`]: {},
    [`${COMPOSE} run --rm --no-deps -T app node dist/db/migrate.js`]: {},
    [`${COMPOSE} up -d --no-build app caddy`]: {},
    [`${COMPOSE} config --hash=postgres,backup,deployer`]: { stdout: '' }
  };
}

function readyProbe(answer: ProbeResult = { status: 200, commit: TARGET }): ReadyProbe {
  return { async probe(target) { return target === 'live' ? { status: 200, commit: FROM } : answer; } };
}

interface RunnerHandle {
  url: string;
  server: DeployServer;
  lines: string[];
  close(): Promise<void>;
}

interface RunnerOptions {
  script?: ExecScript;
  probe?: ReadyProbe;
  minIntervalSeconds?: number;
  run?: Parameters<typeof createDeployServer>[0]['run'];
}

const open: RunnerHandle[] = [];

async function startRunner(options: RunnerOptions = {}): Promise<RunnerHandle> {
  const config = parseDeployerConfig({
    DEPLOY_REPO_PATH: REPO,
    DEPLOY_REPO_URL: REPO_URL,
    DEPLOY_RUNNER_TOKEN: TOKEN,
    DEPLOY_DATABASE_URL: process.env.DATABASE_URL,
    DEPLOY_COMPOSE_PROJECT: 'threatlens',
    DEPLOY_MIN_INTERVAL_SECONDS: String(options.minIntervalSeconds ?? 0),
    DEPLOY_READY_INTERVAL_SECONDS: '1'
  });
  const pool = createDeployPool(config.DEPLOY_DATABASE_URL);
  const fake = fakeExec({ ...baseScript(), ...(options.script ?? {}) });
  const server = createDeployServer({
    config, pool, exec: fake.exec,
    probe: options.probe ?? readyProbe(),
    runnerId: `integration/${open.length + 1}`,
    log: { info: () => undefined, error: () => undefined },
    run: options.run,
    sleep: async () => undefined
  });
  await new Promise<void>((done) => server.server.listen(0, '127.0.0.1', () => done()));
  const port = (server.server.address() as AddressInfo).port;
  const handle: RunnerHandle = {
    url: `http://127.0.0.1:${port}`,
    server,
    lines: fake.lines,
    async close() {
      await server.close();
      await pool.end().catch(() => undefined);
    }
  };
  open.push(handle);
  return handle;
}

async function post(handle: RunnerHandle, path: string, body: unknown, token = TOKEN) {
  const response = await fetch(`${handle.url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

async function runRows() {
  const result = await sql<Record<string, any>>(
    `SELECT id,status,current_stage,error_code,error_summary,log_tail,migrations_applied,
            from_commit,to_commit,expected_commit,requested_by,active_lock
       FROM deployment_runs ORDER BY id`
  );
  return result.rows;
}

describe.skipIf(!integrationDatabaseAvailable)('deployment runner', () => {
  beforeAll(async () => { await ensureMigrated(); });
  beforeEach(async () => { await resetDatabase(); });
  afterEach(async () => {
    while (open.length) await open.pop()!.close();
    await sql(`DELETE FROM schema_migrations WHERE filename=$1`, [FAKE_MIGRATION]);
  });

  it('refuses everything without the bearer token, and records nothing', async () => {
    const runner = await startRunner();
    const anonymous = await fetch(`${runner.url}/status`);
    expect(anonymous.status).toBe(401);
    const wrong = await post(runner, '/deploy', { confirm: true, expectedRemoteCommit: TARGET }, 'not-the-token');
    expect(wrong.status).toBe(401);
    expect(await count('deployment_runs')).toBe(0);
  });

  it('runs the scenario end to end and records one succeeded row with its trail', async () => {
    const runner = await startRunner();
    const accepted = await post(runner, '/deploy', { confirm: true, expectedRemoteCommit: TARGET });
    expect(accepted.status).toBe(202);
    expect(accepted.body.runId).toBeTypeOf('number');
    await runner.server.settled();

    const rows = await runRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'succeeded', from_commit: FROM, to_commit: TARGET, expected_commit: TARGET,
      error_code: null, active_lock: false
    });
    // No migrations were pending: an EMPTY list is the healthy answer and is not the same as
    // "not measured", which would be NULL and never occurs.
    expect(rows[0]!.migrations_applied).toEqual([]);

    const events = await sql<{ stage: string; outcome: string }>(
      `SELECT stage,outcome FROM deployment_run_events WHERE run_id=$1 ORDER BY id`, [rows[0]!.id]
    );
    expect(events.rows.filter((row) => row.outcome === 'started').map((row) => row.stage))
      .toEqual(['checking', 'building', 'migrating', 'starting', 'waiting_ready']);
    expect(events.rows.at(-1)).toMatchObject({ outcome: 'ok' });
  });

  it('records the migrations the target image actually applied, as a set difference', async () => {
    // The fake migrate step does what the real one does: it inserts into `schema_migrations`. The
    // reader either side of it is the real query, so this asserts the difference and not a stub.
    const runner = await startRunner({
      script: {
        [`${COMPOSE} run --rm --no-deps -T app node dist/db/migrate.js`]: async () => {
          await sql(`INSERT INTO schema_migrations(filename) VALUES ($1) ON CONFLICT DO NOTHING`, [FAKE_MIGRATION]);
          return {};
        }
      }
    });
    const accepted = await post(runner, '/deploy', { confirm: true, expectedRemoteCommit: TARGET });
    expect(accepted.status).toBe(202);
    await runner.server.settled();

    const rows = await runRows();
    expect(rows[0]!.status).toBe('succeeded');
    expect(rows[0]!.migrations_applied).toEqual([FAKE_MIGRATION]);
  });

  it('ends a failed build at the building stage, with the log tail an operator can read', async () => {
    const runner = await startRunner({
      script: { [`${COMPOSE} build app`]: { code: 1, stderr: 'ERROR: failed to solve: npm ci exited 1' } }
    });
    expect((await post(runner, '/deploy', { confirm: true, expectedRemoteCommit: TARGET })).status).toBe(202);
    await runner.server.settled();

    const rows = await runRows();
    expect(rows[0]).toMatchObject({ status: 'failed', current_stage: 'building', error_code: 'build_failed' });
    expect(rows[0]!.log_tail).toContain('npm ci exited 1');
    // The row is terminal, so the lock column is free and the next run is not blocked by it.
    expect(rows[0]!.active_lock).toBe(false);
  });

  it('survives the restart it describes: the journal is readable by a process that was not there', async () => {
    const runner = await startRunner({
      script: { [`${COMPOSE} build app`]: { code: 1, stderr: 'boom' } }
    });
    await post(runner, '/deploy', { confirm: true, expectedRemoteCommit: TARGET });
    await runner.server.settled();
    await runner.close();
    open.pop();

    // A brand-new `app` process, exactly as after a deployment: no shared memory with the runner,
    // no file on disk, and the full trail still there.
    const { readRecentRuns, readRunEvents, resetDeploymentMetricsMemo } =
      await import('../../src/services/deployment.js');
    resetDeploymentMetricsMemo();
    const history = await readRecentRuns(10);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ status: 'failed', errorCode: 'build_failed' });
    expect(history[0]!.logTail).toContain('boom');
    expect((await readRunEvents(history[0]!.id)).map((event) => event.stage))
      .toContain('building');
  });

  it('answers two concurrent triggers with one 202 and one 409', async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const runner = await startRunner({
      run: async ({ journal }) => {
        await journal.stage('building');
        await gate;
        await journal.finish({ status: 'succeeded', stage: 'building' });
        return { status: 'succeeded', stage: 'building', facts: {} };
      }
    });
    const body = { confirm: true, expectedRemoteCommit: TARGET };
    const [first, second] = await Promise.all([post(runner, '/deploy', body), post(runner, '/deploy', body)]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([202, 409]);
    expect((first.status === 409 ? first : second).body).toEqual({ error: 'run_in_progress' });
    // Exactly one row, and it is the active one.
    expect(await count('deployment_runs')).toBe(1);
    expect(await count('deployment_runs', 'active_lock')).toBe(1);
    release();
    await runner.server.settled();
  });

  it('makes a second active run physically impossible, not merely unlikely', async () => {
    await sql(`INSERT INTO deployment_runs(status,requested_by,expected_commit) VALUES ('building','operator',$1)`, [TARGET]);
    // The partial unique index over the GENERATED `active_lock` column. This is the layer that holds
    // when every runner process has been killed and no lock is held by anybody.
    await expect(
      sql(`INSERT INTO deployment_runs(status,requested_by,expected_commit) VALUES ('queued','operator',$1)`, [TARGET])
    ).rejects.toMatchObject({ code: '23505' });
    // A terminal row is not active and never collides.
    await expect(
      sql(`INSERT INTO deployment_runs(status,requested_by,expected_commit) VALUES ('failed','operator',$1)`, [TARGET])
    ).resolves.toBeTruthy();
  });

  it('reaps a run whose runner died into failed/runner_lost before starting a new one', async () => {
    // The row a killed runner leaves behind. Backdated so the minimum-interval guard is not what
    // this test is measuring.
    await sql(
      `INSERT INTO deployment_runs(status,current_stage,requested_by,expected_commit,requested_at,heartbeat_at)
       VALUES ('waiting_ready','waiting_ready','operator',$1, now() - interval '10 minutes', now() - interval '9 minutes')`,
      [TARGET]
    );
    const runner = await startRunner({ minIntervalSeconds: 60 });
    const accepted = await post(runner, '/deploy', { confirm: true, expectedRemoteCommit: TARGET });
    expect(accepted.status).toBe(202);
    await runner.server.settled();

    const rows = await runRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: 'failed', error_code: 'runner_lost', current_stage: 'waiting_ready' });
    expect(rows[0]!.error_summary).toContain('reclaimed the deployment lock');
    expect(rows[1]!.status).toBe('succeeded');
  });

  it('refuses a second trigger inside the minimum interval, and records no row for it', async () => {
    const runner = await startRunner({ minIntervalSeconds: 3600 });
    expect((await post(runner, '/deploy', { confirm: true, expectedRemoteCommit: TARGET })).status).toBe(202);
    await runner.server.settled();

    const refused = await post(runner, '/deploy', { confirm: true, expectedRemoteCommit: TARGET });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe('min_interval');
    expect(refused.body.retryAfterSeconds).toBeGreaterThan(0);
    // A refusal that also filled the journal would make the history unreadable after a double click.
    expect(await count('deployment_runs')).toBe(1);
  });

  it('refuses a body that carries anything beyond the confirmation and the commit', async () => {
    const runner = await startRunner();
    for (const body of [
      { confirm: true, expectedRemoteCommit: TARGET, ref: 'refs/heads/evil' },
      { confirm: true, expectedRemoteCommit: 'HEAD' },
      { confirm: false, expectedRemoteCommit: TARGET },
      { expectedRemoteCommit: TARGET },
      { confirm: true, expectedRemoteCommit: `${TARGET}; rm -rf /` }
    ]) {
      const response = await post(runner, '/deploy', body);
      expect([body, response.status]).toEqual([body, 400]);
    }
    expect(await count('deployment_runs')).toBe(0);
    // Not one command was issued for any of them.
    expect(runner.lines).toEqual([]);
  });

  it('writes what the cheap check saw into the singleton state row', async () => {
    const runner = await startRunner({
      script: {
        [`git -C ${REPO} ls-remote origin refs/heads/main`]: { stdout: `${TARGET}\trefs/heads/main\n` }
      }
    });
    expect((await post(runner, '/check', {})).status).toBe(200);
    const state = await sql<Record<string, any>>(`SELECT * FROM deployment_state WHERE singleton`);
    expect(state.rows[0]).toMatchObject({
      remote_url: REPO_URL, branch: 'main', remote_commit: TARGET,
      working_tree_commit: FROM, working_tree_dirty: false, last_check_ok: true, last_check_error: null
    });
    // `ls-remote`, never `fetch`: the check runs on a timer as well as on a button press and must
    // not write to a checkout somebody may be looking at.
    expect(runner.lines.some((line) => line.includes('fetch'))).toBe(false);
  });

  it('records a check against the wrong origin as a failed check, not as a fresh commit', async () => {
    const runner = await startRunner({
      script: { [`git -C ${REPO} remote get-url origin`]: { stdout: 'https://github.com/someone/else.git\n' } }
    });
    expect((await post(runner, '/check', {})).status).toBe(200);
    const state = await sql<Record<string, any>>(`SELECT * FROM deployment_state WHERE singleton`);
    expect(state.rows[0]).toMatchObject({ last_check_ok: false, remote_commit: null });
    expect(state.rows[0]!.last_check_error).toContain('someone/else');
  });
});
