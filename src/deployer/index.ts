import { hostname } from 'node:os';
import { loadDeployerConfig } from './config.js';
import { spawnExec } from './exec.js';
import { acquireDeployLock, createDeployPool, reapAbandonedRuns } from './journal.js';
import { createDeployServer, createHttpProbe, runRemoteCheck, type RunnerLogger } from './server.js';

/**
 * Entry point of the deployment runner container (`deploy/Dockerfile`, service `deployer`).
 *
 * Boot order is the whole of the interesting behaviour:
 *
 *   1. **Configuration or nothing.** `loadDeployerConfig()` throws a zod error naming the offending
 *      variable. A runner with a weak token or a relative repository path must not start — every
 *      action it can take is irreversible, and «здається, налаштовано» is the worst possible state
 *      for a process holding the host's Docker socket.
 *   2. **Reap before serving.** Taking the advisory lock at startup PROVES that any `deployment_runs`
 *      row still in a non-terminal state belongs to a runner that no longer exists — PostgreSQL
 *      would not have handed the lock over otherwise. Those rows become `failed/runner_lost` before
 *      the first request is accepted, so an operator returning to `/ops` after a crash sees a
 *      recorded failure instead of a run that appears to be in progress forever.
 *   3. **Then listen**, and then check origin/main on a timer.
 */

const logger: RunnerLogger = {
  // `process.stdout.write` rather than `console.log`: the project's lint rules allow only
  // `console.warn`/`console.error`, and a runner whose informational output goes to stderr would
  // make every ordinary line look like a fault in `docker compose logs`.
  info(fields, message) {
    process.stdout.write(`${JSON.stringify({ level: 'info', at: new Date().toISOString(), message, ...fields })}\n`);
  },
  error(fields, message) {
    const { error, ...rest } = fields as { error?: unknown };
    console.error(JSON.stringify({
      level: 'error', at: new Date().toISOString(), message,
      error: error instanceof Error ? `${error.name}: ${error.message}` : error, ...rest
    }));
  }
};

/** The password out of a libpq URL, percent-decoded, or '' when there is nothing to redact. */
function databasePassword(url: string): string {
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return '';
  }
}

const config = loadDeployerConfig();
const runnerId = `${hostname()}/${process.pid}`;
const pool = createDeployPool(config.DEPLOY_DATABASE_URL);
const exec = spawnExec({
  logTailBytes: config.DEPLOY_LOG_TAIL_BYTES,
  // Both secrets this process holds. `spawnExec` strips them from every captured stream before the
  // text can reach `deployment_runs.log_tail`, which is rendered verbatim on the ops page.
  redact: [config.DEPLOY_RUNNER_TOKEN, databasePassword(config.DEPLOY_DATABASE_URL)]
});

const startupLock = await acquireDeployLock(pool);
if (startupLock) {
  const reaped = await reapAbandonedRuns(pool, runnerId);
  if (reaped) logger.info({ reaped }, 'reclaimed deployment runs abandoned before this runner started');
  await startupLock.release();
} else {
  // Another runner is alive and owns the lock. Two runners on one host is a misconfiguration, but it
  // is not this process's job to resolve it: the partial unique index still admits exactly one
  // active run, and whichever runner holds the lock is the one that may start the next one.
  logger.info({}, 'another runner holds the deployment lock; startup reaping skipped');
}

const deployServer = createDeployServer({
  config, pool, exec, runnerId, log: logger, probe: createHttpProbe(config)
});

deployServer.server.listen(config.DEPLOY_PORT, '0.0.0.0', () => {
  logger.info({
    port: config.DEPLOY_PORT, repoPath: config.DEPLOY_REPO_PATH, project: config.DEPLOY_COMPOSE_PROJECT
  }, 'deployment runner listening');
});

const check = () => {
  void runRemoteCheck(exec, config, pool, runnerId)
    .catch((error) => logger.error({ error }, 'origin/main check failed'));
};
check();
const checkTimer = config.DEPLOY_CHECK_INTERVAL_SECONDS
  ? setInterval(check, config.DEPLOY_CHECK_INTERVAL_SECONDS * 1000)
  : null;
checkTimer?.unref?.();

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'deployment runner shutting down');
  if (checkTimer) clearInterval(checkTimer);
  // `close()` awaits the in-flight run. A deployment killed between `docker compose up` and the
  // readiness poll would leave a run row that only the next runner's startup reap can resolve, and
  // resolving it as `runner_lost` when the update actually landed is a lie worth waiting to avoid.
  await deployServer.close();
  await pool.end().catch(() => undefined);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
