import { describe, expect, it } from 'vitest';
import { fakeExec, type ExecScript } from './exec.js';
import type { DeployStage, RunEvent, RunFacts, RunFinish, RunJournal } from './journal.js';
import {
  DEPLOY_MANUAL_SERVICES, DEPLOY_REF, DEPLOY_RESTART_SERVICES, runDeployment,
  type ProbeResult, type ReadyProbe, type RunnerSettings
} from './runner.js';

/**
 * The fixed update scenario, proved step by step with no Docker, no git, no network and no clock.
 *
 * Two injected ports is all it takes: {@link fakeExec} answers commands by their exact command line
 * and records the argv it was handed, and a fake {@link ReadyProbe} answers the two health probes.
 * That is what makes the strongest assertion in this file cheap enough to write — the EXACT argv
 * sequence, in order, as literal strings. A refactor that reorders two steps, drops `--no-build`, or
 * lets an operator-supplied byte reach an argument fails here and nowhere else.
 */

const REPO = '/opt/threatlens-ua';
const REPO_URL = 'https://github.com/IvanSnezhok/threatlens-ua.git';
const FROM = '0011223344556677889900aabbccddeeff001122';
const TARGET = '1f2e3d4c5b6a70819283746556473829100aabbc';

const SETTINGS: RunnerSettings = {
  repoPath: REPO,
  repoUrl: REPO_URL,
  composeProject: 'threatlens',
  buildTimeoutMs: 1_800_000,
  migrateTimeoutMs: 600_000,
  startTimeoutMs: 300_000,
  gitTimeoutMs: 60_000,
  readyTimeoutMs: 30_000,
  readyIntervalMs: 5000,
  logTailBytes: 8192
};

const COMPOSE = `docker compose -p threatlens --project-directory ${REPO} -f ${REPO}/compose.yaml`;

/** The healthy answers for every command the scenario issues. */
function happyScript(target = TARGET, from = FROM): ExecScript {
  return {
    [`git -C ${REPO} remote get-url origin`]: { stdout: `${REPO_URL}\n` },
    [`git -C ${REPO} status --porcelain`]: { stdout: '' },
    [`git -C ${REPO} fetch --prune --no-tags origin +refs/heads/main:refs/remotes/origin/main`]: {},
    [`git -C ${REPO} rev-parse refs/remotes/origin/main`]: { stdout: `${target}\n` },
    [`git -C ${REPO} rev-parse HEAD`]: { stdout: `${from}\n` },
    [`git -C ${REPO} checkout --detach ${target}`]: {},
    [`${COMPOSE} build app`]: {},
    [`${COMPOSE} run --rm --no-deps -T app node dist/db/migrate.js`]: {},
    [`${COMPOSE} up -d --no-build app caddy`]: {},
    [`${COMPOSE} config --hash=postgres,backup,deployer`]: { stdout: 'postgres h1\nbackup h2\ndeployer h3\n' },
    'docker ps --filter label=com.docker.compose.project=threatlens --format {{index .Labels "com.docker.compose.service"}} {{index .Labels "com.docker.compose.config-hash"}}':
      { stdout: 'postgres h1\nbackup h2\ndeployer h3\napp hApp\n' }
  };
}

interface Recorder {
  journal: RunJournal;
  stages: DeployStage[];
  events: RunEvent[];
  facts: Partial<RunFacts>;
  finish: RunFinish | null;
}

function recorder(): Recorder {
  const state: Recorder = {
    stages: [], events: [], facts: {}, finish: null,
    journal: null as unknown as RunJournal
  };
  state.journal = {
    runId: 1,
    async stage(stage, detail) {
      state.stages.push(stage);
      state.events.push({ stage, outcome: 'started', detail });
    },
    async event(entry) { state.events.push(entry); },
    async record(fields) { Object.assign(state.facts, fields); },
    async finish(outcome) { state.finish = outcome; }
  };
  return state;
}

/** A probe that answers `live` once and then walks a scripted list of `ready` answers. */
function probeOf(live: ProbeResult, ready: ProbeResult[]): ReadyProbe {
  let index = 0;
  return {
    async probe(target) {
      if (target === 'live') return live;
      const answer = ready[Math.min(index, ready.length - 1)] ?? { status: 0, commit: null };
      index += 1;
      return answer;
    }
  };
}

interface RunOptions {
  script?: ExecScript;
  live?: ProbeResult;
  ready?: ProbeResult[];
  expected?: string;
  migrationsBefore?: string[];
  migrationsAfter?: string[];
  readyTimeoutMs?: number;
}

async function run(options: RunOptions = {}) {
  const fake = fakeExec({ ...happyScript(), ...(options.script ?? {}) });
  const journal = recorder();
  let migrationCalls = 0;
  const result = await runDeployment({
    journal: journal.journal,
    exec: fake.exec,
    probe: probeOf(
      options.live ?? { status: 200, commit: FROM },
      options.ready ?? [{ status: 200, commit: TARGET }]
    ),
    migrations: {
      async applied() {
        migrationCalls += 1;
        return migrationCalls === 1
          ? (options.migrationsBefore ?? ['001_init.sql'])
          : (options.migrationsAfter ?? ['001_init.sql']);
      }
    },
    settings: { ...SETTINGS, ...(options.readyTimeoutMs ? { readyTimeoutMs: options.readyTimeoutMs } : {}) },
    expectedRemoteCommit: options.expected ?? TARGET,
    // No real waiting and no real clock: the ready poll advances a counter instead.
    sleep: async () => undefined,
    now: (() => {
      let clock = 1_000_000;
      return () => {
        clock += 5000;
        return clock;
      };
    })()
  });
  return { result, journal, fake };
}

describe('the fixed scenario', () => {
  it('issues exactly this argv, in exactly this order', async () => {
    const { result, fake } = await run();
    expect(result.status).toBe('succeeded');
    expect(fake.lines).toEqual([
      `git -C ${REPO} remote get-url origin`,
      `git -C ${REPO} status --porcelain`,
      `git -C ${REPO} fetch --prune --no-tags origin +refs/heads/main:refs/remotes/origin/main`,
      `git -C ${REPO} rev-parse refs/remotes/origin/main`,
      `git -C ${REPO} rev-parse HEAD`,
      `git -C ${REPO} checkout --detach ${TARGET}`,
      `${COMPOSE} build app`,
      `${COMPOSE} run --rm --no-deps -T app node dist/db/migrate.js`,
      `${COMPOSE} up -d --no-build app caddy`,
      `${COMPOSE} config --hash=postgres,backup,deployer`,
      'docker ps --filter label=com.docker.compose.project=threatlens --format {{index .Labels "com.docker.compose.service"}} {{index .Labels "com.docker.compose.config-hash"}}'
    ]);
    // Only two binaries are ever executed. The `command` field is a union of two literals, and this
    // is the runtime half of that guarantee.
    expect([...new Set(fake.calls.map((call) => call.command))].sort()).toEqual(['docker', 'git']);
  });

  it('produces byte-identical argv whatever the operator is called', async () => {
    // `requestedBy` is a DATABASE COLUMN and nothing else. It never reaches this module, which is
    // why it cannot reach an argument — and this is the assertion that keeps it that way.
    const first = await run();
    const second = await run();
    expect(second.fake.lines).toEqual(first.fake.lines);
    expect(second.fake.calls.map((call) => call.args)).toEqual(first.fake.calls.map((call) => call.args));
  });

  it('bakes the target commit into the build and nothing else', async () => {
    const { fake } = await run();
    const build = fake.calls.find((call) => call.args.includes('build'))!;
    expect(build.env?.APP_COMMIT).toBe(TARGET);
    expect(Date.parse(build.env!.APP_BUILT_AT!)).not.toBeNaN();
    // The commit reaches the image through a build ARG, never through an argument to git or docker.
    expect(build.args).not.toContain(TARGET);
  });

  it('migrates before it starts, and starts nothing it is not allowed to restart', async () => {
    const { fake } = await run();
    const migrate = fake.lines.findIndex((line) => line.includes('node dist/db/migrate.js'));
    const up = fake.lines.findIndex((line) => line.includes(' up -d '));
    expect(migrate).toBeGreaterThan(-1);
    expect(up).toBeGreaterThan(migrate);
    const upCall = fake.calls[up]!;
    for (const service of DEPLOY_MANUAL_SERVICES) {
      expect(upCall.args, `up must never recreate ${service}`).not.toContain(service);
    }
    expect(upCall.args.slice(-2)).toEqual([...DEPLOY_RESTART_SERVICES]);
  });

  it('records the migrations it actually applied as a set difference', async () => {
    const { result, journal } = await run({
      migrationsBefore: ['001_init.sql', '022_publication_runtime.sql'],
      migrationsAfter: ['001_init.sql', '022_publication_runtime.sql', '023_deployment_and_backfill.sql']
    });
    expect(result.status).toBe('succeeded');
    expect(journal.facts.migrationsApplied).toEqual(['023_deployment_and_backfill.sql']);
    expect([journal.facts.migrationsBefore, journal.facts.migrationsAfter]).toEqual([2, 3]);
  });

  it('records an empty applied list, not a failure, when nothing was pending', async () => {
    const { result, journal } = await run();
    expect(result.status).toBe('succeeded');
    expect(journal.facts.migrationsApplied).toEqual([]);
    expect(journal.events).toContainEqual(
      expect.objectContaining({ stage: 'migrating', outcome: 'skipped', detail: 'no pending migrations' })
    );
  });

  it('walks the stages in order and finishes on waiting_ready', async () => {
    const { journal } = await run();
    expect(journal.stages).toEqual(['checking', 'building', 'migrating', 'starting', 'waiting_ready']);
    expect(journal.finish).toMatchObject({ status: 'succeeded', stage: 'waiting_ready' });
  });

  it('reports the services it deliberately did not restart', async () => {
    const { journal } = await run({
      script: {
        'docker ps --filter label=com.docker.compose.project=threatlens --format {{index .Labels "com.docker.compose.service"}} {{index .Labels "com.docker.compose.config-hash"}}':
          { stdout: 'postgres h1\nbackup OLD\ndeployer h3\n' }
      }
    });
    expect(journal.facts.pendingManualServices).toEqual(['backup']);
  });

  it('never fails a completed run because the drift probe failed', async () => {
    const { result, journal } = await run({
      script: { [`${COMPOSE} config --hash=postgres,backup,deployer`]: { code: 1, stderr: 'boom' } }
    });
    expect(result.status).toBe('succeeded');
    expect(journal.facts.pendingManualServices).toEqual([]);
  });
});

describe('refusals', () => {
  it('refuses a checkout whose origin is not the configured repository', async () => {
    const { result, journal } = await run({
      script: { [`git -C ${REPO} remote get-url origin`]: { stdout: 'https://github.com/someone/else.git\n' } }
    });
    expect(result).toMatchObject({ status: 'failed', stage: 'checking', errorCode: 'remote_mismatch' });
    expect(journal.finish?.errorCode).toBe('remote_mismatch');
  });

  it('refuses a dirty working tree instead of discarding somebody\'s edits', async () => {
    const { result, fake } = await run({
      script: { [`git -C ${REPO} status --porcelain`]: { stdout: ' M src/config.ts\n' } }
    });
    expect(result.errorCode).toBe('working_tree_dirty');
    // Nothing was fetched, nothing was checked out, nothing was built.
    expect(fake.lines.some((line) => line.includes('fetch'))).toBe(false);
  });

  it('refuses when origin/main moved between the render and the click', async () => {
    const moved = 'ffeeddccbbaa99887766554433221100ffeeddcc';
    const { result, fake } = await run({
      script: { [`git -C ${REPO} rev-parse refs/remotes/origin/main`]: { stdout: `${moved}\n` } }
    });
    expect(result.errorCode).toBe('commit_moved');
    expect(fake.lines.some((line) => line.includes('checkout'))).toBe(false);
  });

  it('refuses a confirmation that is not a commit at all', async () => {
    const { result, fake } = await run({ expected: 'refs/heads/evil' });
    expect(result.errorCode).toBe('commit_moved');
    expect(fake.lines.some((line) => line.includes('checkout'))).toBe(false);
  });

  it('reports a fetch failure without touching the working tree', async () => {
    const { result, fake } = await run({
      script: {
        [`git -C ${REPO} fetch --prune --no-tags origin +refs/heads/main:refs/remotes/origin/main`]:
          { code: 128, stderr: 'fatal: unable to access' }
      }
    });
    expect(result.errorCode).toBe('fetch_failed');
    expect(fake.lines.some((line) => line.includes('checkout'))).toBe(false);
  });

  it('does nothing at all when the checkout and the container are already at origin/main', async () => {
    const { result, journal, fake } = await run({
      script: { [`git -C ${REPO} rev-parse HEAD`]: { stdout: `${TARGET}\n` } },
      live: { status: 200, commit: TARGET }
    });
    expect(result).toMatchObject({ status: 'succeeded', detail: 'already_current' });
    expect(journal.finish).toMatchObject({ status: 'succeeded', stage: 'checking' });
    expect(fake.lines.some((line) => line.includes('build') || line.includes('up -d'))).toBe(false);
  });

  it('rebuilds when the tree is current but the container is answering from another commit', async () => {
    // The drift case: somebody moved the working tree by hand without rebuilding, so the code on
    // disk is not the code that is running. `already_current` here would be a lie.
    const { result, fake } = await run({
      script: { [`git -C ${REPO} rev-parse HEAD`]: { stdout: `${TARGET}\n` } },
      live: { status: 200, commit: FROM }
    });
    expect(result.status).toBe('succeeded');
    expect(fake.lines).toContain(`${COMPOSE} build app`);
  });
});

describe('failure stops where it happened', () => {
  it('ends at building and never migrates when the build fails', async () => {
    const { result, journal, fake } = await run({
      script: { [`${COMPOSE} build app`]: { code: 1, stderr: 'npm ci failed' } }
    });
    expect(result).toMatchObject({ status: 'failed', stage: 'building', errorCode: 'build_failed' });
    expect(journal.stages).toEqual(['checking', 'building']);
    expect(fake.lines.some((line) => line.includes('migrate.js'))).toBe(false);
    expect(journal.finish?.logTail).toContain('npm ci failed');
  });

  it('ends at migrating and never restarts anything when a migration fails', async () => {
    // The GOOD failure: the old container is still serving, and the operator has the log.
    const { result, journal, fake } = await run({
      script: {
        [`${COMPOSE} run --rm --no-deps -T app node dist/db/migrate.js`]:
          { code: 1, stderr: 'ERROR:  column "x" does not exist' }
      }
    });
    expect(result).toMatchObject({ status: 'failed', stage: 'migrating', errorCode: 'migration_failed' });
    expect(fake.lines.some((line) => line.includes(' up -d '))).toBe(false);
    expect(journal.finish?.logTail).toContain('column "x" does not exist');
  });

  it('ends at starting when compose up fails', async () => {
    const { result } = await run({
      script: { [`${COMPOSE} up -d --no-build app caddy`]: { code: 1, stderr: 'port is already allocated' } }
    });
    expect(result).toMatchObject({ status: 'failed', stage: 'starting', errorCode: 'start_failed' });
  });

  it('waits out three not-ready answers and then succeeds', async () => {
    const { result, journal } = await run({
      ready: [
        { status: 503, commit: FROM }, { status: 0, commit: null }, { status: 503, commit: TARGET },
        { status: 200, commit: TARGET }
      ]
    });
    expect(result.status).toBe('succeeded');
    expect(journal.finish).toMatchObject({ status: 'succeeded', stage: 'waiting_ready' });
  });

  it('fails with ready_timeout when readiness never arrives', async () => {
    const { result, journal } = await run({
      ready: [{ status: 503, commit: null }], readyTimeoutMs: 20_000
    });
    expect(result).toMatchObject({ status: 'failed', stage: 'waiting_ready', errorCode: 'ready_timeout' });
    expect(journal.finish?.errorSummary).toContain('did not become ready');
  });

  it('fails with ready_commit_mismatch when the OLD container keeps answering 200', async () => {
    // `up -d` can legitimately leave the previous container in place — no new image, a failed
    // recreate, a matching content hash — and the site answers perfectly while the deployment did
    // nothing at all. Without the commit check this is the silent false success.
    const { result, journal } = await run({
      ready: [{ status: 200, commit: FROM }], readyTimeoutMs: 20_000
    });
    expect(result).toMatchObject({ status: 'failed', errorCode: 'ready_commit_mismatch' });
    expect(journal.finish?.errorSummary).toContain(FROM);
  });

  it('records a terminal row even when a port throws', async () => {
    const journal = recorder();
    const result = await runDeployment({
      journal: journal.journal,
      exec: async () => { throw new Error('docker daemon is gone'); },
      probe: probeOf({ status: 200, commit: FROM }, [{ status: 200, commit: TARGET }]),
      migrations: { async applied() { return []; } },
      settings: SETTINGS,
      expectedRemoteCommit: TARGET,
      sleep: async () => undefined
    });
    expect(result).toMatchObject({ status: 'failed', errorCode: 'internal_error' });
    expect(journal.finish?.status).toBe('failed');
  });
});

describe('frozen constants', () => {
  it('deploys one ref and restarts two services', () => {
    // The issue puts «оновлення з довільної гілки, tag або fork» out of scope. A scope boundary
    // survives by not existing as a setting somebody can set.
    expect(DEPLOY_REF).toBe('refs/heads/main');
    expect(DEPLOY_RESTART_SERVICES).toEqual(['app', 'caddy']);
    expect(DEPLOY_MANUAL_SERVICES).toEqual(['postgres', 'backup', 'deployer']);
  });
});
