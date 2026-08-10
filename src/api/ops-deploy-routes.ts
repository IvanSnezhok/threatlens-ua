import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import {
  commitState, readActiveRun, readDeploymentState, readRecentRuns, type DeploymentStateView
} from '../services/deployment.js';
import { hasValidOpsAuth, opsUnauthorized } from './ops-auth.js';

/**
 * Operator-controlled deployment, from the application's side of the wall.
 *
 * Everything here is a READ or a PROXY. The application never touches Docker, never runs a command
 * and never waits for a deployment: it validates a confirmed button press, forwards it to the runner
 * on the compose network, and hands back the run id the runner recorded. The runner works detached
 * and writes its own journal straight into PostgreSQL, which is why the ops page can lose its own
 * server mid-update and still show what happened.
 *
 * A separate plugin registered WITHOUT `fastify-plugin`, for the reason the rest of `/ops` is: the
 * auth guard belongs to these routes and has no business leaking onto every response the server
 * sends. Every path starts with `/ops/` including the slash — `setNotFoundHandler` in `server.ts`
 * JSON-404s only `/api/`, `/health/` and `/ops/`.
 */

function authorised(request: FastifyRequest): boolean {
  return hasValidOpsAuth(request.headers.authorization);
}

/**
 * The trigger body, validated HERE as well as in the runner.
 *
 * `.strict()` on both sides is not redundancy for its own sake: this side keeps a typo'd field from
 * reaching the process that holds the Docker socket at all, and the runner's copy keeps the promise
 * true for anything that ever reaches it by another route. `confirm: true` as a literal is the
 * issue's «явне підтвердження оператора» expressed as a type — a boolean that may be false is a
 * boolean somebody will eventually default to false.
 */
export const deployBody = z.object({
  confirm: z.literal(true),
  expectedRemoteCommit: z.string().regex(/^[0-9a-f]{40}$/)
}).strict();

interface RunnerCall {
  status: number;
  body: any;
  reachable: boolean;
}

/**
 * One request to the runner, with every failure turned into a value.
 *
 * A runner that is down is an ordinary, expected state — it is a container an operator starts by
 * hand once — and the ops card has to render it as «Runner недоступний», not as a stack trace. The
 * only thing this must never do is hang: the browser is polling this endpoint every three seconds.
 */
async function callRunner(
  path: string, init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs: number }
): Promise<RunnerCall> {
  try {
    const response = await fetch(`${config.DEPLOY_RUNNER_URL}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${config.DEPLOY_RUNNER_TOKEN}`,
        'content-type': 'application/json',
        // The operator's identity travels as a header and lands in a database column. It is never an
        // argument to anything the runner executes.
        'x-deploy-requested-by': config.OPS_USER
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs)
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body, reachable: true };
  } catch {
    return { status: 0, body: null, reachable: false };
  }
}

/** What the running image is, as opposed to what the checkout says. */
async function appIdentity(): Promise<{ commit: string; builtAt: string | null; migrations: { count: number; newest: string | null } }> {
  const result = await pool.query<{ n: string; newest: string | null }>(
    `SELECT count(*)::text AS n, max(filename) AS newest FROM schema_migrations`
  );
  return {
    commit: config.APP_COMMIT,
    builtAt: config.APP_BUILT_AT || null,
    migrations: { count: Number(result.rows[0]?.n ?? 0), newest: result.rows[0]?.newest ?? null }
  };
}

function repoFacts(state: DeploymentStateView | null) {
  return {
    remoteUrl: state?.remoteUrl ?? null,
    branch: state?.branch ?? 'main',
    remoteCommit: state?.remoteCommit ?? null,
    workingTreeCommit: state?.workingTreeCommit ?? null,
    workingTreeDirty: state?.workingTreeDirty ?? false,
    lastCheckedAt: state?.lastCheckedAt ?? null,
    lastCheckOk: state?.lastCheckOk ?? null,
    lastCheckError: state?.lastCheckError ?? null
  };
}

const opsDeployRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Everything the card needs in one request, including the two things a second request would make
   * inconsistent: whether the runner is reachable, and what the journal currently says.
   *
   * The browser polls this every three seconds while a run is active, and it is EXPECTED to fail
   * outright partway through — the update restarts the very server answering it. The card treats a
   * failed poll beside a known-active run as «застосунок перезапускається», which is only honest
   * because the journal it will read on reconnect is in a database the update never restarts.
   */
  app.get('/ops/api/deploy', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    const [app_, state, current, history, runner] = await Promise.all([
      appIdentity(),
      readDeploymentState(),
      readActiveRun(),
      readRecentRuns(10),
      // 1.5 s: this is a sidecar on the same bridge network, and the poll behind it is on a
      // three-second cadence. A slower budget would queue polls behind an unreachable runner.
      config.DEPLOY_ENABLED
        ? callRunner('/status', { method: 'GET', timeoutMs: 1500 })
        : Promise.resolve<RunnerCall>({ status: 0, body: null, reachable: false })
    ]);
    return {
      enabled: config.DEPLOY_ENABLED,
      app: app_,
      repo: repoFacts(state),
      commitState: commitState(state, config.APP_COMMIT),
      runner: {
        reachable: runner.reachable && runner.status === 200,
        url: config.DEPLOY_RUNNER_URL,
        ...(runner.status === 200 && runner.body ? runner.body : {})
      },
      current,
      history,
      limits: {
        // Stated rather than implied: an operator reading the card can see the boundary of what the
        // button can do without opening the source.
        ref: 'refs/heads/main',
        services: ['app', 'caddy'],
        manualServices: ['postgres', 'backup', 'deployer']
      }
    };
  });

  /**
   * «Перевірити» — one `git ls-remote`, no fetch, nothing written to the checkout.
   *
   * Separate from the trigger on purpose: an operator has to be able to ask "is there anything new"
   * without the answer being "and I have now moved your working tree".
   */
  app.post('/ops/api/deploy/check', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    if (!config.DEPLOY_ENABLED) return reply.code(503).send({ error: 'deploy_disabled' });
    const runner = await callRunner('/check', { method: 'POST', body: {}, timeoutMs: config.DEPLOY_RUNNER_TIMEOUT_MS });
    if (!runner.reachable) return reply.code(502).send({ error: 'runner_unreachable' });
    if (runner.status !== 200) return reply.code(502).send({ error: 'runner_error', status: runner.status });
    const state = await readDeploymentState();
    return { repo: repoFacts(state), commitState: commitState(state, config.APP_COMMIT) };
  });

  /**
   * The button. Returns 202 with the run id and NOTHING else happens on this request.
   *
   * The three refusals the runner answers synchronously are passed through unchanged — 409
   * `run_in_progress`, 429 `min_interval` — because they mean "no run was recorded" and the card has
   * to say so. Everything past that point becomes a RECORDED failed run instead of an HTTP error:
   * a failure an operator cannot read afterwards is the failure mode this feature exists to remove.
   */
  app.post('/ops/api/deploy', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    if (!config.DEPLOY_ENABLED) return reply.code(503).send({ error: 'deploy_disabled' });
    const parsed = deployBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_request', issues: parsed.error.issues.map((issue) => issue.path.join('.'))
      });
    }
    const runner = await callRunner('/deploy', {
      method: 'POST', body: parsed.data, timeoutMs: config.DEPLOY_RUNNER_TIMEOUT_MS
    });
    if (!runner.reachable) return reply.code(502).send({ error: 'runner_unreachable' });
    return reply.code(runner.status).send(runner.body ?? { error: 'runner_error' });
  });
};

export default opsDeployRoutes;
export { opsDeployRoutes };
