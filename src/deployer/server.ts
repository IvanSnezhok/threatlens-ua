import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type pg from 'pg';
import { z } from 'zod';
import type { DeployerConfig } from './config.js';
import type { Exec } from './exec.js';
import {
  acquireDeployLock, appliedMigrations, createRun, lastRunRequestedAt, openRunJournal,
  reapAbandonedRuns, startHeartbeat, writeDeploymentState
} from './journal.js';
import {
  COMMIT_PATTERN, DEPLOY_MANUAL_SERVICES, DEPLOY_REF, DEPLOY_RESTART_SERVICES,
  runDeployment, type ProbeResult, type ReadyProbe, type RunnerSettings
} from './runner.js';

/**
 * The runner's HTTP surface: three endpoints, all bearer-authenticated, none of which accepts a
 * command.
 *
 * `node:http` rather than Fastify on purpose. This package is import-restricted to `node:*`, `pg`
 * and `zod` (see `eslint.config.js`), and the restriction is the isolation: the process that holds
 * the Docker socket must not acquire a plugin ecosystem, a static file server or a JSON body parser
 * whose failure modes nobody here has read. Three routes and a 8 KiB body cap is the whole surface.
 *
 * The app is the only client, and it is not reachable from outside the compose network anyway
 * (`expose`, never `ports`). The bearer token is what stops anything *else* on that network — a
 * compromised sidecar, a future service — from using it.
 */

export interface RunnerLogger {
  info: (fields: Record<string, unknown>, message: string) => void;
  error: (fields: Record<string, unknown>, message: string) => void;
}

export interface DeployServerDeps {
  config: DeployerConfig;
  pool: pg.Pool;
  exec: Exec;
  probe: ReadyProbe;
  runnerId: string;
  log: RunnerLogger;
  /** Injected only by tests; production always runs the real scenario. */
  run?: typeof runDeployment;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The trigger body, and the whole of what an operator may send.
 *
 * `.strict()` so an unknown key is a 400 rather than a silently ignored field: a request carrying
 * `{"confirm":true,"expectedRemoteCommit":"…","ref":"refs/heads/evil"}` must be REFUSED, not
 * accepted-and-partly-ignored. `confirm` is a literal `true` because the issue puts «автоматичне
 * оновлення без явного підтвердження оператора» out of scope and a boolean that can be false is a
 * boolean somebody will default to false.
 */
export const deployBody = z.object({
  confirm: z.literal(true),
  expectedRemoteCommit: z.string().regex(COMMIT_PATTERN)
}).strict();

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  response.end(payload);
}

function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const left = Buffer.from(header.slice(7));
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Reads at most 8 KiB. The one legitimate body here is under a hundred bytes. */
async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 8192) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function settingsOf(config: DeployerConfig): RunnerSettings {
  return {
    repoPath: config.DEPLOY_REPO_PATH,
    repoUrl: config.DEPLOY_REPO_URL,
    composeProject: config.DEPLOY_COMPOSE_PROJECT,
    buildTimeoutMs: config.DEPLOY_BUILD_TIMEOUT_SECONDS * 1000,
    migrateTimeoutMs: config.DEPLOY_MIGRATE_TIMEOUT_SECONDS * 1000,
    startTimeoutMs: config.DEPLOY_START_TIMEOUT_SECONDS * 1000,
    gitTimeoutMs: 60_000,
    readyTimeoutMs: config.DEPLOY_READY_TIMEOUT_SECONDS * 1000,
    readyIntervalMs: config.DEPLOY_READY_INTERVAL_SECONDS * 1000,
    logTailBytes: config.DEPLOY_LOG_TAIL_BYTES
  };
}

/**
 * The HTTP {@link ReadyProbe}: reads `/health/live` and `/health/ready` on the compose network.
 *
 * A refused connection, a timeout and a malformed body are all `{ status: 0, commit: null }` — the
 * app being unreachable during its own restart is the EXPECTED state of step 10, not an error, and
 * the polling loop decides when that stops being acceptable.
 */
export function createHttpProbe(config: DeployerConfig): ReadyProbe {
  const urls = { live: config.DEPLOY_LIVE_URL, ready: config.DEPLOY_READY_URL };
  return {
    async probe(target): Promise<ProbeResult> {
      try {
        const response = await fetch(urls[target], {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(5000)
        });
        const body = await response.json().catch(() => null) as { commit?: unknown } | null;
        const commit = typeof body?.commit === 'string' ? body.commit : null;
        return { status: response.status, commit };
      } catch {
        return { status: 0, commit: null };
      }
    }
  };
}

/**
 * The cheap check: what does origin/main hold right now, and is the checkout clean.
 *
 * `git ls-remote` and NOT `git fetch`: this runs on a timer as well as on a button press, and a
 * fetch writes to the checkout — objects, refs, a lock file — while the operator may be looking at
 * it. `ls-remote` is one HTTPS request that touches nothing.
 */
export async function runRemoteCheck(
  exec: Exec, config: DeployerConfig, pool: pg.Pool, runnerId: string
): Promise<void> {
  const repo = config.DEPLOY_REPO_PATH;
  const git = (args: string[]) =>
    exec({ command: 'git', args: ['-C', repo, ...args], timeoutMs: 60_000, cwd: repo });
  const remote = await git(['remote', 'get-url', 'origin']);
  const originUrl = remote.stdout.split('\n')[0]?.trim() ?? '';
  const headResult = await git(['rev-parse', 'HEAD']);
  const head = headResult.stdout.split('\n')[0]?.trim() ?? '';
  const statusResult = await git(['status', '--porcelain']);
  const dirty = statusResult.code === 0 && Boolean(statusResult.stdout.trim());

  if (remote.code !== 0 || originUrl !== config.DEPLOY_REPO_URL) {
    await writeDeploymentState(pool, {
      remoteUrl: originUrl || null, remoteCommit: null,
      workingTreeCommit: COMMIT_PATTERN.test(head) ? head : null, workingTreeDirty: dirty,
      lastCheckOk: false,
      lastCheckError: `origin is «${originUrl}», not the configured «${config.DEPLOY_REPO_URL}»`,
      runnerVersion: runnerId
    });
    return;
  }

  const lsRemote = await git(['ls-remote', 'origin', DEPLOY_REF]);
  const remoteCommit = lsRemote.stdout.split('\n')[0]?.trim().split(/\s+/)[0] ?? '';
  const ok = lsRemote.code === 0 && COMMIT_PATTERN.test(remoteCommit);
  await writeDeploymentState(pool, {
    remoteUrl: originUrl,
    remoteCommit: ok ? remoteCommit : null,
    workingTreeCommit: COMMIT_PATTERN.test(head) ? head : null,
    workingTreeDirty: dirty,
    lastCheckOk: ok,
    // The tail of stderr, not the whole of it: this string is rendered on the ops card.
    lastCheckError: ok ? null : (lsRemote.stderr.trim().slice(-500) || 'git ls-remote failed'),
    runnerVersion: runnerId
  });
}

export interface DeployServer {
  server: Server;
  /** Resolves once any in-flight deployment has finished journalling. Tests await it. */
  settled(): Promise<void>;
  close(): Promise<void>;
}

export function createDeployServer(deps: DeployServerDeps): DeployServer {
  const { config, pool, exec, probe, runnerId, log } = deps;
  const run = deps.run ?? runDeployment;
  const now = deps.now ?? Date.now;
  const settings = settingsOf(config);
  let inFlight: Promise<void> | null = null;
  let activeRunId: number | null = null;

  const status = () => ({
    runnerId,
    repoPath: config.DEPLOY_REPO_PATH,
    repoUrl: config.DEPLOY_REPO_URL,
    composeProject: config.DEPLOY_COMPOSE_PROJECT,
    // Reported so the ops card can state the boundary rather than assert it: this runner deploys one
    // ref and recreates two services, and an operator can read that off the page.
    ref: DEPLOY_REF,
    services: [...DEPLOY_RESTART_SERVICES],
    manualServices: [...DEPLOY_MANUAL_SERVICES],
    busy: activeRunId !== null,
    activeRunId,
    minIntervalSeconds: config.DEPLOY_MIN_INTERVAL_SECONDS,
    checkIntervalSeconds: config.DEPLOY_CHECK_INTERVAL_SECONDS,
    readyTimeoutSeconds: config.DEPLOY_READY_TIMEOUT_SECONDS
  });

  /**
   * Accepts or refuses a trigger, and — when it accepts — starts the scenario DETACHED.
   *
   * The three synchronous refusals are the only ones that leave no run row: a bad token (401), a
   * live run (409) and the minimum interval (429). Everything after `createRun` becomes a RECORDED
   * failed run, because a failure an operator cannot read afterwards is the failure mode this whole
   * feature exists to remove.
   */
  const trigger = async (response: ServerResponse, body: unknown, requestedBy: string) => {
    const parsed = deployBody.safeParse(body);
    if (!parsed.success) {
      return json(response, 400, { error: 'invalid_request', issues: parsed.error.issues.map((issue) => issue.path.join('.')) });
    }
    const lock = await acquireDeployLock(pool);
    if (!lock) return json(response, 409, { error: 'run_in_progress' });

    let runId: number;
    try {
      // Holding the lock is the PROOF that no runner owns the active rows: PostgreSQL would not have
      // handed it over otherwise. Only here is reaping safe.
      const reaped = await reapAbandonedRuns(pool, runnerId);
      if (reaped) log.info({ reaped }, 'reclaimed deployment runs abandoned by a dead runner');

      const previous = await lastRunRequestedAt(pool);
      const minIntervalMs = config.DEPLOY_MIN_INTERVAL_SECONDS * 1000;
      if (previous && now() - previous.getTime() < minIntervalMs) {
        await lock.release();
        return json(response, 429, {
          error: 'min_interval',
          retryAfterSeconds: Math.ceil((minIntervalMs - (now() - previous.getTime())) / 1000)
        });
      }
      runId = await createRun(pool, {
        requestedBy,
        remoteUrl: config.DEPLOY_REPO_URL,
        expectedCommit: parsed.data.expectedRemoteCommit,
        runnerId
      });
    } catch (error) {
      await lock.release();
      // 23505 can only come from the partial unique index, i.e. an active row this process did not
      // create and could not reap. Reported as the same refusal a held lock produces.
      if ((error as { code?: string }).code === '23505') return json(response, 409, { error: 'run_in_progress' });
      log.error({ error }, 'deployment could not be recorded');
      return json(response, 500, { error: 'journal_unavailable' });
    }

    activeRunId = runId;
    const stopHeartbeat = startHeartbeat(pool, runId);
    inFlight = (async () => {
      try {
        const result = await run({
          journal: openRunJournal(pool, runId),
          exec,
          probe,
          migrations: { applied: () => appliedMigrations(pool) },
          settings,
          expectedRemoteCommit: parsed.data.expectedRemoteCommit,
          sleep: deps.sleep,
          now
        });
        log.info({ runId, ...result, facts: undefined }, 'deployment run finished');
      } catch (error) {
        log.error({ error, runId }, 'deployment run threw outside the journal');
      } finally {
        stopHeartbeat();
        activeRunId = null;
        await lock.release();
      }
    })();
    // 202 the instant the row exists. The app NEVER awaits a deployment: the browser polls the
    // journal, and the run outlives both the request and the container that answered it.
    return json(response, 202, { runId });
  };

  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (!bearerMatches(request.headers.authorization, config.DEPLOY_RUNNER_TOKEN)) {
          return json(response, 401, { error: 'unauthorized' });
        }
        const path = (request.url ?? '/').split('?')[0];
        if (request.method === 'GET' && path === '/status') return json(response, 200, status());
        if (request.method === 'POST' && path === '/check') {
          await runRemoteCheck(exec, config, pool, runnerId);
          return json(response, 200, { checked: true });
        }
        if (request.method === 'POST' && path === '/deploy') {
          const raw = await readBody(request);
          if (raw === null) return json(response, 413, { error: 'body_too_large' });
          let body: unknown;
          try {
            body = raw ? JSON.parse(raw) : {};
          } catch {
            return json(response, 400, { error: 'invalid_json' });
          }
          const requestedBy = String(request.headers['x-deploy-requested-by'] ?? 'operator').slice(0, 120);
          return await trigger(response, body, requestedBy);
        }
        return json(response, 404, { error: 'not_found' });
      } catch (error) {
        log.error({ error }, 'runner request failed');
        if (!response.headersSent) json(response, 500, { error: 'internal_error' });
      }
    })();
  });

  return {
    server,
    async settled() {
      await inFlight;
    },
    async close() {
      await new Promise<void>((done) => { server.close(() => done()); });
      await inFlight;
    }
  };
}
