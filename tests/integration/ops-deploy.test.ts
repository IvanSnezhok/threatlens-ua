import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { count, ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

/**
 * `GET`/`POST /ops/api/deploy`, end to end against a live PostgreSQL and a stand-in runner.
 *
 * The property this file pins is the operator's side of the update contract: «оператор бачить, що
 * зараз працює і що доступне, підтверджує один конкретний commit, і ніколи не може надіслати нічого
 * іншого». Concretely — the endpoint is closed without operator credentials; the card's whole payload
 * arrives in one request so a reachable-runner badge can never be shown beside a stale journal; a
 * body carrying anything but the confirmation and a 40-hex commit is refused HERE, before the
 * process that holds the Docker socket is contacted at all; the runner's three synchronous refusals
 * are passed through unchanged; and a runner that is simply not running reads as «Runner
 * недоступний» rather than as a 500.
 *
 * **Harness (b)**: a bare `Fastify({ logger: false })` with `app.register(opsDeployRoutes)`, the same
 * shape `tests/integration/ops-runtime.test.ts` uses. The plugin is registered without
 * `fastify-plugin` in `buildServer()` too, and registering it onto a bare instance here is what
 * proves that: its auth guard travels with it.
 *
 * `config.DEPLOY_*` is mutated in place rather than through `process.env`: `src/config.ts` parses the
 * environment once at import and the integration project shares one module registry across files, so
 * a `vi.resetModules()` here would hand every later file a second `pg.Pool`. The routes read
 * `config.X` at request time, so assigning the field is both sufficient and contained — and every
 * test restores what it changed.
 */

const OPS = `Basic ${Buffer.from('operator:change-me').toString('base64')}`;
const TARGET = '1f2e3d4c5b6a70819283746556473829100aabbc';
const OLD = '0011223344556677889900aabbccddeeff001122';

interface RunnerCallRecord {
  method: string;
  url: string;
  authorization: string | undefined;
  requestedBy: string | undefined;
  body: string;
}

interface FakeRunner {
  server: Server;
  url: string;
  calls: RunnerCallRecord[];
  answer: { status: number; body: unknown };
  close(): Promise<void>;
}

async function fakeRunner(answer: { status: number; body: unknown } = { status: 202, body: { runId: 7 } }): Promise<FakeRunner> {
  const calls: RunnerCallRecord[] = [];
  const state: FakeRunner = { server: null as never, url: '', calls, answer, close: async () => undefined };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      calls.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
        requestedBy: request.headers['x-deploy-requested-by'] as string | undefined,
        body: Buffer.concat(chunks).toString('utf8')
      });
      if (request.url === '/status') {
        const payload = JSON.stringify({ runnerId: 'fake/1', busy: false, ref: 'refs/heads/main' });
        response.writeHead(200, { 'content-type': 'application/json' });
        return response.end(payload);
      }
      const payload = JSON.stringify(state.answer.body);
      response.writeHead(state.answer.status, { 'content-type': 'application/json' });
      response.end(payload);
    })();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  state.server = server;
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise<void>((done) => { server.close(() => done()); });
  return state;
}

async function buildApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const opsDeployRoutes = (await import('../../src/api/ops-deploy-routes.js')).default;
  const app = Fastify({ logger: false });
  await app.register(opsDeployRoutes);
  await app.ready();
  return app;
}

async function appConfig() {
  return (await import('../../src/config.js')).config as Record<string, unknown>;
}

const restore: Array<() => void> = [];

async function enableDeploy(runnerUrl: string): Promise<void> {
  const config = await appConfig();
  for (const [key, value] of Object.entries({
    DEPLOY_ENABLED: true, DEPLOY_RUNNER_URL: runnerUrl,
    DEPLOY_RUNNER_TOKEN: 'ops-deploy-integration-token-0123456789', APP_COMMIT: OLD
  })) {
    const previous = config[key];
    config[key] = value;
    restore.push(() => { config[key] = previous; });
  }
}

async function seedRun(patch: Record<string, unknown> = {}): Promise<number> {
  const row = {
    status: 'succeeded', current_stage: 'waiting_ready', requested_by: 'operator',
    expected_commit: TARGET, from_commit: OLD, to_commit: TARGET, ...patch
  };
  const result = await sql<{ id: string }>(
    `INSERT INTO deployment_runs(status,current_stage,requested_by,expected_commit,from_commit,to_commit,
       started_at,finished_at,error_code,log_tail,migrations_applied)
     VALUES ($1,$2,$3,$4,$5,$6, now() - interval '2 minutes',
             CASE WHEN $1 IN ('succeeded','failed') THEN now() ELSE NULL END,
             $7,$8,$9) RETURNING id`,
    [row.status, row.current_stage, row.requested_by, row.expected_commit, row.from_commit, row.to_commit,
      patch.error_code ?? null, patch.log_tail ?? null, patch.migrations_applied ?? []]
  );
  return Number(result.rows[0]!.id);
}

describe.skipIf(!integrationDatabaseAvailable)('ops deployment API', () => {
  beforeAll(async () => { await ensureMigrated(); });

  beforeEach(async () => {
    await resetDatabase();
    (await import('../../src/services/deployment.js')).resetDeploymentMetricsMemo();
  });

  afterEach(() => {
    while (restore.length) restore.pop()!();
  });

  it('401s without Basic auth on every route, and says so in the header a browser needs', async () => {
    const app = await buildApp();
    try {
      for (const [method, url] of [
        ['GET', '/ops/api/deploy'], ['POST', '/ops/api/deploy/check'], ['POST', '/ops/api/deploy']
      ] as const) {
        const response = await app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
        expect([url, response.statusCode]).toEqual([url, 401]);
        expect(response.headers['www-authenticate']).toBe('Basic realm="ThreatLens Ops"');
      }
      const wrong = await app.inject({
        method: 'GET', url: '/ops/api/deploy',
        headers: { authorization: `Basic ${Buffer.from('operator:wrong').toString('base64')}` }
      });
      expect(wrong.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('answers the whole card in one request, before any deployment has ever run', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/ops/api/deploy', headers: { authorization: OPS } });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Object.keys(body).sort())
        .toEqual(['app', 'commitState', 'current', 'enabled', 'history', 'limits', 'repo', 'runner']);
      // Disabled by default: a deployment that never created the runner container must not be shown
      // a button that 502s.
      expect(body.enabled).toBe(false);
      expect(body.runner.reachable).toBe(false);
      expect(body.current).toBeNull();
      expect(body.history).toEqual([]);
      // The seeded singleton, never "no row, therefore unknown".
      expect(body.repo).toMatchObject({ branch: 'main', remoteCommit: null, workingTreeDirty: false });
      expect(body.commitState).toBe('unknown');
      expect(body.app.migrations.newest).toBe('030_app_settings.sql');
      // The boundary is stated on the payload, so an operator can read it off the page.
      expect(body.limits).toEqual({
        ref: 'refs/heads/main', services: ['app', 'caddy'],
        manualServices: ['postgres', 'backup', 'deployer']
      });
    } finally {
      await app.close();
    }
  });

  it('reports the runner as unreachable rather than failing, when it is simply not running', async () => {
    const runner = await fakeRunner();
    const url = runner.url;
    await runner.close();                       // the port is now closed
    await enableDeploy(url);
    const app = await buildApp();
    try {
      const body = (await app.inject({ method: 'GET', url: '/ops/api/deploy', headers: { authorization: OPS } })).json();
      expect(body.enabled).toBe(true);
      expect(body.runner.reachable).toBe(false);
      const check = await app.inject({ method: 'POST', url: '/ops/api/deploy/check', headers: { authorization: OPS }, payload: {} });
      expect([check.statusCode, check.json()]).toEqual([502, { error: 'runner_unreachable' }]);
    } finally {
      await app.close();
    }
  });

  it('carries the journal and the runner status in the same payload', async () => {
    const runner = await fakeRunner();
    await enableDeploy(runner.url);
    const failed = await seedRun({
      status: 'failed', current_stage: 'migrating', error_code: 'migration_failed',
      log_tail: 'ERROR:  column "x" does not exist'
    });
    await sql(`UPDATE deployment_state SET remote_commit=$1, working_tree_commit=$1, last_checked_at=now(), last_check_ok=true WHERE singleton`, [TARGET]);
    const app = await buildApp();
    try {
      const body = (await app.inject({ method: 'GET', url: '/ops/api/deploy', headers: { authorization: OPS } })).json();
      expect(body.runner).toMatchObject({ reachable: true, runnerId: 'fake/1', ref: 'refs/heads/main' });
      expect(body.history).toHaveLength(1);
      expect(body.history[0]).toMatchObject({
        id: failed, status: 'failed', errorCode: 'migration_failed', currentStage: 'migrating'
      });
      // The tail of the failing command reaches the operator: this is the whole point of writing the
      // journal into a database the update never restarts.
      expect(body.history[0].logTail).toContain('column "x" does not exist');
      expect(body.history[0].durationMs).toBeGreaterThan(0);
      // The running image is at OLD while origin/main and the checkout are at TARGET.
      expect(body.commitState).toBe('drifted');
    } finally {
      await app.close();
      await runner.close();
    }
  });

  it('shows an in-flight run as current, separately from the history', async () => {
    const runner = await fakeRunner();
    await enableDeploy(runner.url);
    const active = await seedRun({ status: 'building', current_stage: 'building' });
    const app = await buildApp();
    try {
      const body = (await app.inject({ method: 'GET', url: '/ops/api/deploy', headers: { authorization: OPS } })).json();
      expect(body.current).toMatchObject({ id: active, status: 'building', currentStage: 'building' });
      expect(body.history.map((run: { id: number }) => run.id)).toEqual([active]);
    } finally {
      await app.close();
      await runner.close();
    }
  });

  it('refuses a body that is anything other than a confirmation and a commit', async () => {
    const runner = await fakeRunner();
    await enableDeploy(runner.url);
    const app = await buildApp();
    try {
      for (const payload of [
        { confirm: true, expectedRemoteCommit: TARGET, ref: 'refs/heads/evil' },
        { confirm: true, expectedRemoteCommit: 'refs/heads/main' },
        { confirm: true, expectedRemoteCommit: TARGET.toUpperCase() },
        { confirm: true, expectedRemoteCommit: `${TARGET} && rm -rf /` },
        { confirm: false, expectedRemoteCommit: TARGET },
        { confirm: 'true', expectedRemoteCommit: TARGET },
        { expectedRemoteCommit: TARGET },
        {}
      ]) {
        const response = await app.inject({
          method: 'POST', url: '/ops/api/deploy', headers: { authorization: OPS }, payload
        });
        expect([payload, response.statusCode]).toEqual([payload, 400]);
        expect(response.json().error).toBe('invalid_request');
      }
      // The process that holds the Docker socket was never contacted for any of them.
      expect(runner.calls).toEqual([]);
      expect(await count('deployment_runs')).toBe(0);
    } finally {
      await app.close();
      await runner.close();
    }
  });

  it('forwards a confirmed commit with the operator as a header, and passes the run id back', async () => {
    const runner = await fakeRunner({ status: 202, body: { runId: 42 } });
    await enableDeploy(runner.url);
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST', url: '/ops/api/deploy', headers: { authorization: OPS },
        payload: { confirm: true, expectedRemoteCommit: TARGET }
      });
      expect([response.statusCode, response.json()]).toEqual([202, { runId: 42 }]);
      expect(runner.calls).toHaveLength(1);
      expect(runner.calls[0]).toMatchObject({
        method: 'POST', url: '/deploy',
        authorization: 'Bearer ops-deploy-integration-token-0123456789',
        // The operator's identity travels as a header into a database column, and never as an
        // argument to anything the runner executes.
        requestedBy: 'operator'
      });
      expect(JSON.parse(runner.calls[0]!.body)).toEqual({ confirm: true, expectedRemoteCommit: TARGET });
    } finally {
      await app.close();
      await runner.close();
    }
  });

  it('passes the runner\'s two synchronous refusals through unchanged', async () => {
    // 409 and 429 both mean "no run was recorded", which is exactly what the card has to say. Turning
    // either into a generic 502 would leave an operator pressing a button that silently does nothing.
    for (const answer of [
      { status: 409, body: { error: 'run_in_progress' } },
      { status: 429, body: { error: 'min_interval', retryAfterSeconds: 41 } }
    ]) {
      const runner = await fakeRunner(answer);
      await enableDeploy(runner.url);
      const app = await buildApp();
      try {
        const response = await app.inject({
          method: 'POST', url: '/ops/api/deploy', headers: { authorization: OPS },
          payload: { confirm: true, expectedRemoteCommit: TARGET }
        });
        expect([response.statusCode, response.json()]).toEqual([answer.status, answer.body]);
      } finally {
        await app.close();
        await runner.close();
        while (restore.length) restore.pop()!();
      }
    }
  });

  it('refuses to trigger anything at all while the feature is off', async () => {
    const app = await buildApp();
    try {
      for (const url of ['/ops/api/deploy', '/ops/api/deploy/check']) {
        const response = await app.inject({
          method: 'POST', url, headers: { authorization: OPS },
          payload: { confirm: true, expectedRemoteCommit: TARGET }
        });
        expect([url, response.statusCode, response.json()]).toEqual([url, 503, { error: 'deploy_disabled' }]);
      }
      expect(await count('deployment_runs')).toBe(0);
    } finally {
      await app.close();
    }
  });

  /**
   * The gate itself, on the whole server rather than on one plugin.
   *
   * `src/deployer/runner.test.ts` proves the runner refuses to call an update successful until
   * `/health/ready` answers 200 with the deployed commit. That proof is worth nothing if the endpoint
   * cannot actually tell the truth about either half — which is exactly what it could not do before:
   * readiness gated on ONE hard-coded filename, so a container carrying an unapplied migration
   * answered 200, and the response named no commit at all, so a `compose up` that silently kept the
   * old container was indistinguishable from a successful deployment.
   */
  describe('the readiness gate the runner deploys against', () => {
    it('names the running commit on both health endpoints', async () => {
      const { buildServer } = await import('../../src/api/server.js');
      const { config } = await import('../../src/config.js');
      const app = await buildServer();
      try {
        const live = await app.inject({ method: 'GET', url: '/health/live' });
        expect(live.statusCode).toBe(200);
        // `version` keeps its meaning and its place; `commit` and `builtAt` are additive.
        expect(live.json()).toMatchObject({ status: 'ok', commit: config.APP_COMMIT });
        expect(live.json()).toHaveProperty('version');

        const ready = await app.inject({ method: 'GET', url: '/health/ready' });
        expect(ready.statusCode).toBe(200);
        expect(ready.json()).toMatchObject({
          status: 'ready', commit: config.APP_COMMIT, migration: '030_app_settings.sql'
        });
      } finally {
        await app.close();
      }
    });

    it('refuses to be ready while any migration shipped in the image is unapplied', async () => {
      const { buildServer } = await import('../../src/api/server.js');
      const app = await buildServer();
      // The whole point: the newest migration, which the previous hard-coded marker did not know
      // about. Restored in `finally` — every other file's `ensureMigrated()` probes exactly this row.
      await sql(`DELETE FROM schema_migrations WHERE filename='023_deployment_and_backfill.sql'`);
      try {
        const ready = await app.inject({ method: 'GET', url: '/health/ready' });
        expect(ready.statusCode).toBe(503);
        const body = ready.json();
        expect(body.reason).toBe('migrations_pending');
        expect(body.required).toContain('023_deployment_and_backfill.sql');
        expect(body.applied).not.toContain('023_deployment_and_backfill.sql');
        // The commit still travels: an operator reading this 503 during an update needs to know
        // WHICH image is refusing, and the runner's poll needs it to distinguish the two containers.
        expect(body).toHaveProperty('commit');
      } finally {
        await sql(
          `INSERT INTO schema_migrations(filename) VALUES ('023_deployment_and_backfill.sql')
           ON CONFLICT DO NOTHING`
        );
        await app.close();
      }
    });
  });

  it('re-reads the state row after a check instead of echoing what the runner said', async () => {
    const runner = await fakeRunner({ status: 200, body: { checked: true } });
    await enableDeploy(runner.url);
    const app = await buildApp();
    try {
      // What the "runner" wrote while handling /check. The route's answer must come from here.
      await sql(`UPDATE deployment_state SET remote_commit=$1, working_tree_commit=$2,
                 last_checked_at=now(), last_check_ok=true WHERE singleton`, [TARGET, OLD]);
      const response = await app.inject({
        method: 'POST', url: '/ops/api/deploy/check', headers: { authorization: OPS }, payload: {}
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().repo).toMatchObject({ remoteCommit: TARGET, workingTreeCommit: OLD, lastCheckOk: true });
      expect(response.json().commitState).toBe('behind');
      expect(runner.calls.map((call) => call.url)).toEqual(['/check']);
    } finally {
      await app.close();
      await runner.close();
    }
  });
});
