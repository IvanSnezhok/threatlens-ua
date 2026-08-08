import type { Exec, ExecResult } from './exec.js';
import type { DeployStage, RunFacts, RunJournal } from './journal.js';

/**
 * The fixed update scenario. One path, no branches an operator can choose, no argument an operator
 * can supply.
 *
 * ## Why the scenario is a constant and not a script
 *
 * The issue's boundary is explicit: «Ops API має запускати тільки визначений сценарій оновлення, а
 * не довільні shell-команди». The way that survives contact with a future feature request is for
 * there to be no place to put a command. Every step below is a literal array of literal strings
 * interpolated only with values this process computed itself: the repository path from its own
 * environment, the compose project from its own environment, and SHAs that `git rev-parse` printed.
 * `requestedBy` reaches a database column and nothing else. `expectedRemoteCommit` is regex-checked
 * and used ONLY in a comparison.
 *
 * ## Why the migrations run explicitly, before the new container serves
 *
 * `src/index.ts` already awaits `migrate()` at boot, and that stays — it is the cold-start cover.
 * But boot-time migration happens AFTER the old container has been destroyed, so a migration that
 * fails leaves a crash-looping new container and a site that is down. Step 8 runs the migration from
 * the freshly built image with `compose run --rm --no-deps -T`, while the OLD app is still serving:
 * a failure ends the run at `migrating`, the site never moved, and `migrations_applied` is a
 * recorded fact rather than a line in a container log.
 *
 * The cost is stated rather than hidden: between step 8 and step 9 the old code runs against the new
 * schema. That makes expand/contract a hard project rule — a migration may add, never rename or
 * drop in the same release. `docs/OPERATIONS.md` says so and every existing migration complies.
 *
 * ## Why postgres, backup and deployer are never restarted
 *
 * `postgres` holds the journal: a scenario that can restart its own journal store cannot report its
 * own failure. `deployer` executes the scenario: restarting it is suicide mid-run, and — the part
 * that matters for the threat model — it means somebody who can push to `main` cannot replace the
 * runner by way of the button. `backup` rides with postgres. Step 11 reports the resulting drift
 * honestly instead of pretending it does not exist.
 */

// ------------------------------------------------------------------------------------------------
// Frozen constants — the boundary of what this feature can do
// ------------------------------------------------------------------------------------------------

/** The only ref that is ever deployed. Not a variable; the DB CHECK is the second lock. */
export const DEPLOY_REF = 'refs/heads/main';

/** The refspec fetched. Written out rather than assembled so a grep for the ref finds every use. */
export const DEPLOY_FETCH_REFSPEC = '+refs/heads/main:refs/remotes/origin/main';

/** Where the fetched ref lands, and the only thing step 4 ever resolves. */
export const DEPLOY_REMOTE_REF = 'refs/remotes/origin/main';

/** The services the scenario is allowed to recreate. See the module header for the exclusions. */
export const DEPLOY_RESTART_SERVICES = ['app', 'caddy'] as const;

/** The services the scenario deliberately does NOT restart, reported as drift in step 11. */
export const DEPLOY_MANUAL_SERVICES = ['postgres', 'backup', 'deployer'] as const;

/** Any commit this package accepts, from an operator or from git. Forty lower-case hex characters. */
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export type DeployErrorCode =
  | 'remote_mismatch' | 'working_tree_dirty' | 'fetch_failed' | 'commit_moved'
  | 'checkout_failed' | 'build_failed' | 'migration_failed' | 'start_failed'
  | 'ready_timeout' | 'ready_commit_mismatch' | 'internal_error';

// ------------------------------------------------------------------------------------------------
// Injected ports
// ------------------------------------------------------------------------------------------------

export interface ProbeResult {
  /** HTTP status, or 0 when the request never completed (the app is mid-restart). */
  status: number;
  /** `commit` from the health payload, when it carried one. */
  commit: string | null;
}

/**
 * The second injected port beside {@link Exec}.
 *
 * With both faked, every test in `./runner.test.ts` runs the entire scenario with no Docker, no git,
 * no network and no clock of its own.
 */
export interface ReadyProbe {
  probe(target: 'live' | 'ready'): Promise<ProbeResult>;
}

export interface MigrationReader {
  /** `schema_migrations` filenames, sorted. Read before and after step 8. */
  applied(): Promise<string[]>;
}

export interface RunnerSettings {
  repoPath: string;
  repoUrl: string;
  composeProject: string;
  buildTimeoutMs: number;
  migrateTimeoutMs: number;
  startTimeoutMs: number;
  gitTimeoutMs: number;
  readyTimeoutMs: number;
  readyIntervalMs: number;
  logTailBytes: number;
}

export interface RunDeploymentInput {
  journal: RunJournal;
  exec: Exec;
  probe: ReadyProbe;
  migrations: MigrationReader;
  settings: RunnerSettings;
  /** Already validated against {@link COMMIT_PATTERN} by the caller; re-checked here regardless. */
  expectedRemoteCommit: string;
  /** Injected so the ready poll is deterministic in tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface RunDeploymentResult {
  status: 'succeeded' | 'failed';
  stage: DeployStage;
  errorCode?: DeployErrorCode;
  facts: Partial<RunFacts>;
  /** 'already_current' when nothing was built or restarted. */
  detail?: string;
}

// ------------------------------------------------------------------------------------------------
// Step construction
// ------------------------------------------------------------------------------------------------

/**
 * The compose invocation every docker step shares.
 *
 * `-p` pins the project so the runner addresses the RUNNING stack rather than inferring a name from
 * a directory. `--project-directory` is what the daemon resolves the file's relative bind mounts
 * against, and it must be the HOST path — which is why the checkout is mounted at the same absolute
 * path inside this container as outside it (`compose.yaml`, `src/deployer/config.ts`).
 */
function composeArgs(settings: RunnerSettings): string[] {
  return [
    'compose', '-p', settings.composeProject,
    '--project-directory', settings.repoPath,
    '-f', `${settings.repoPath}/compose.yaml`
  ];
}

function firstLine(result: ExecResult): string {
  return result.stdout.split('\n')[0]?.trim() ?? '';
}

/** The end of whatever the failing command said, for the journal's `log_tail`. */
function tailOf(result: ExecResult, limit: number): string {
  const combined = `${result.stdout}${result.stdout && result.stderr ? '\n' : ''}${result.stderr}`.trim();
  const suffix = result.timedOut ? '\n[the runner killed this command on its timeout]' : '';
  const text = `${combined}${suffix}`;
  return text.length > limit ? text.slice(text.length - limit) : text;
}

// ------------------------------------------------------------------------------------------------
// The scenario
// ------------------------------------------------------------------------------------------------

/**
 * Runs the whole scenario, journalling every transition, and never throws.
 *
 * Every failure path writes a terminal row before returning: a run that ended without a recorded
 * outcome would be indistinguishable from a runner that died, and the ops card would show it as
 * still in progress forever. The one `catch` at the bottom exists for the same reason.
 */
export async function runDeployment(input: RunDeploymentInput): Promise<RunDeploymentResult> {
  const { journal, exec, probe, migrations, settings } = input;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((done) => { setTimeout(done, ms); }));
  const now = input.now ?? Date.now;
  const compose = composeArgs(settings);
  const facts: Partial<RunFacts> = {};

  const fail = async (
    stage: DeployStage, errorCode: DeployErrorCode, summary: string, logTail?: string
  ): Promise<RunDeploymentResult> => {
    await journal.event({ stage, outcome: 'failed', detail: errorCode });
    await journal.finish({ status: 'failed', stage, errorCode, errorSummary: summary, logTail });
    return { status: 'failed', stage, errorCode, facts };
  };

  const git = (args: string[], timeoutMs = settings.gitTimeoutMs) =>
    exec({ command: 'git', args: ['-C', settings.repoPath, ...args], timeoutMs, cwd: settings.repoPath });

  try {
    // -- 1..6: checking ---------------------------------------------------------------------------
    await journal.stage('checking');

    const remote = await git(['remote', 'get-url', 'origin']);
    if (remote.code !== 0 || firstLine(remote) !== settings.repoUrl) {
      return await fail('checking', 'remote_mismatch',
        `origin is «${firstLine(remote)}», not the configured «${settings.repoUrl}»`,
        tailOf(remote, settings.logTailBytes));
    }

    const status = await git(['status', '--porcelain']);
    if (status.code !== 0) {
      return await fail('checking', 'working_tree_dirty', 'git status failed on the checkout',
        tailOf(status, settings.logTailBytes));
    }
    if (status.stdout.trim()) {
      // Refused rather than stashed or reset. Uncommitted host edits are somebody's unfinished work
      // and a `checkout --detach` over them would either fail halfway or silently discard them —
      // and would make the recorded `to_commit` a statement about code that never ran.
      return await fail('checking', 'working_tree_dirty',
        'The checkout has uncommitted changes; commit, stash or discard them on the host first',
        tailOf(status, settings.logTailBytes));
    }

    const fetched = await git(['fetch', '--prune', '--no-tags', 'origin', DEPLOY_FETCH_REFSPEC]);
    if (fetched.code !== 0) {
      return await fail('checking', 'fetch_failed', 'Could not fetch origin/main',
        tailOf(fetched, settings.logTailBytes));
    }

    const resolved = await git(['rev-parse', DEPLOY_REMOTE_REF]);
    const target = firstLine(resolved);
    if (resolved.code !== 0 || !COMMIT_PATTERN.test(target)) {
      return await fail('checking', 'fetch_failed', `origin/main did not resolve to a commit («${target}»)`,
        tailOf(resolved, settings.logTailBytes));
    }
    if (!COMMIT_PATTERN.test(input.expectedRemoteCommit) || input.expectedRemoteCommit !== target) {
      // The operator confirmed a specific commit. If main has moved since the page was rendered,
      // pressing the button would ship something nobody looked at — so the run is refused and the
      // card re-renders with the new SHA for a second, explicit confirmation.
      return await fail('checking', 'commit_moved',
        `origin/main is now ${target}; the confirmation was for ${input.expectedRemoteCommit}`);
    }

    const head = await git(['rev-parse', 'HEAD']);
    const from = firstLine(head);
    facts.fromCommit = COMMIT_PATTERN.test(from) ? from : null;
    facts.toCommit = target;
    const live = await probe.probe('live');
    facts.runningCommitBefore = live.commit;
    await journal.record({
      fromCommit: facts.fromCommit, toCommit: facts.toCommit,
      runningCommitBefore: facts.runningCommitBefore
    });

    // Nothing to do, and saying so is not the same as pretending to work. The check is on BOTH the
    // checkout and the running container: a tree already at the target whose container answers with
    // an older commit is exactly the drift a rebuild has to repair.
    if (facts.fromCommit === target && live.commit === target) {
      await journal.event({ stage: 'checking', outcome: 'skipped', detail: 'already_current' });
      await journal.finish({ status: 'succeeded', stage: 'checking' });
      return { status: 'succeeded', stage: 'checking', facts, detail: 'already_current' };
    }
    await journal.event({ stage: 'checking', outcome: 'ok', detail: `${from.slice(0, 7)} → ${target.slice(0, 7)}` });

    const checkout = await git(['checkout', '--detach', target]);
    if (checkout.code !== 0) {
      return await fail('checking', 'checkout_failed', `Could not check out ${target}`,
        tailOf(checkout, settings.logTailBytes));
    }

    // -- 7: building ------------------------------------------------------------------------------
    await journal.stage('building');
    const build = await exec({
      command: 'docker',
      args: [...compose, 'build', 'app'],
      timeoutMs: settings.buildTimeoutMs,
      cwd: settings.repoPath,
      // The build args `compose.yaml` forwards into the image. This is the ONLY place the target
      // commit becomes part of the artefact, and it is what makes step 10's commit check meaningful.
      env: { APP_COMMIT: target, APP_BUILT_AT: new Date(now()).toISOString() }
    });
    if (build.code !== 0) {
      return await fail('building', 'build_failed', 'docker compose build app failed',
        tailOf(build, settings.logTailBytes));
    }
    await journal.event({ stage: 'building', outcome: 'ok' });

    // -- 8: migrating -----------------------------------------------------------------------------
    await journal.stage('migrating');
    const before = await migrations.applied();
    const migrate = await exec({
      command: 'docker',
      args: [...compose, 'run', '--rm', '--no-deps', '-T', 'app', 'node', 'dist/db/migrate.js'],
      timeoutMs: settings.migrateTimeoutMs,
      cwd: settings.repoPath
    });
    if (migrate.code !== 0) {
      // The GOOD failure. The old container is still serving, the schema is whatever the migration
      // transaction left behind (each file is applied in its own transaction), and the operator has
      // the log. `docs/OPERATIONS.md` treats this as the least bad outcome of a bad release.
      facts.migrationsBefore = before.length;
      await journal.record({ migrationsBefore: before.length });
      return await fail('migrating', 'migration_failed', 'Migrations from the target image failed',
        tailOf(migrate, settings.logTailBytes));
    }
    const after = await migrations.applied();
    const applied = after.filter((filename) => !before.includes(filename));
    facts.migrationsBefore = before.length;
    facts.migrationsAfter = after.length;
    facts.migrationsApplied = applied;
    await journal.record({
      migrationsBefore: before.length, migrationsAfter: after.length, migrationsApplied: applied
    });
    await journal.event({
      stage: 'migrating', outcome: applied.length ? 'ok' : 'skipped',
      detail: applied.length ? applied.join(', ') : 'no pending migrations'
    });

    // -- 9: starting ------------------------------------------------------------------------------
    await journal.stage('starting');
    const up = await exec({
      command: 'docker',
      args: [...compose, 'up', '-d', '--no-build', ...DEPLOY_RESTART_SERVICES],
      timeoutMs: settings.startTimeoutMs,
      cwd: settings.repoPath
    });
    if (up.code !== 0) {
      return await fail('starting', 'start_failed', 'docker compose up failed',
        tailOf(up, settings.logTailBytes));
    }
    await journal.event({ stage: 'starting', outcome: 'ok', detail: DEPLOY_RESTART_SERVICES.join(', ') });

    // -- 10: waiting_ready ------------------------------------------------------------------------
    await journal.stage('waiting_ready');
    const deadline = now() + settings.readyTimeoutMs;
    let lastStatus = 0;
    let lastCommit: string | null = null;
    for (;;) {
      const ready = await probe.probe('ready').catch(() => ({ status: 0, commit: null }));
      lastStatus = ready.status;
      lastCommit = ready.commit;
      if (ready.status === 200 && ready.commit === target) break;
      // A 200 from an OLD container is the failure this check exists for: `up -d` can legitimately
      // leave the previous container in place (no new image, a failed recreate, a matching content
      // hash) and the site would answer perfectly while the deployment did nothing. Wait for the
      // recreate to finish before concluding it never will, but do not wait past the deadline.
      if (now() >= deadline) {
        const mismatch = ready.status === 200 && ready.commit !== target;
        return await fail('waiting_ready',
          mismatch ? 'ready_commit_mismatch' : 'ready_timeout',
          mismatch
            ? `/health/ready answers from ${ready.commit ?? 'an unknown commit'}, not ${target}`
            : `/health/ready did not become ready within ${Math.round(settings.readyTimeoutMs / 1000)}s (last status ${lastStatus})`);
      }
      await sleep(settings.readyIntervalMs);
    }
    facts.runningCommitAfter = lastCommit;
    await journal.event({ stage: 'waiting_ready', outcome: 'ok', detail: `commit ${target.slice(0, 7)}` });

    // -- 11: drift probe, best effort -------------------------------------------------------------
    const pending = await detectManualDrift(exec, settings, compose);
    facts.pendingManualServices = pending;

    // -- 12: succeeded ----------------------------------------------------------------------------
    await journal.record({ runningCommitAfter: target, pendingManualServices: pending });
    await journal.finish({ status: 'succeeded', stage: 'waiting_ready' });
    return { status: 'succeeded', stage: 'waiting_ready', facts };
  } catch (error) {
    // Anything unforeseen still ends as a recorded failure. A thrown runner that left no terminal
    // row would show on the ops card as a run in progress until the next runner reaped it.
    const summary = error instanceof Error ? error.message : String(error);
    return fail('checking', 'internal_error', `The runner threw: ${summary}`);
  }
}

/**
 * Which of the never-restarted services have a compose definition the running container does not
 * match.
 *
 * Best effort by construction: every failure returns an empty list. The scenario has already
 * succeeded by the time this runs, and a drift probe that could fail a completed update would be a
 * worse lie than the drift it reports. What it produces is a `.legend-note` on the ops card telling
 * the operator which `docker compose up -d <service>` to run by hand.
 */
async function detectManualDrift(
  exec: Exec, settings: RunnerSettings, compose: string[]
): Promise<string[]> {
  try {
    const hashes = await exec({
      command: 'docker',
      args: [...compose, 'config', `--hash=${DEPLOY_MANUAL_SERVICES.join(',')}`],
      timeoutMs: settings.gitTimeoutMs,
      cwd: settings.repoPath
    });
    if (hashes.code !== 0) return [];
    const wanted = new Map<string, string>();
    for (const line of hashes.stdout.split('\n')) {
      const [service, hash] = line.trim().split(/\s+/);
      if (service && hash) wanted.set(service, hash);
    }
    const running = await exec({
      command: 'docker',
      args: [
        'ps', '--filter', `label=com.docker.compose.project=${settings.composeProject}`,
        '--format', '{{index .Labels "com.docker.compose.service"}} {{index .Labels "com.docker.compose.config-hash"}}'
      ],
      timeoutMs: settings.gitTimeoutMs
    });
    if (running.code !== 0) return [];
    const live = new Map<string, string>();
    for (const line of running.stdout.split('\n')) {
      const [service, hash] = line.trim().split(/\s+/);
      if (service && hash) live.set(service, hash);
    }
    return [...wanted.entries()]
      .filter(([service, hash]) => live.get(service) !== hash)
      .map(([service]) => service);
  } catch {
    return [];
  }
}
