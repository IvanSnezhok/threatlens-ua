import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { count, ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

/**
 * `GET`/`PUT /ops/api/settings` and `GET /ops/api/settings/audit`, end to end against a live
 * PostgreSQL.
 *
 * The property this file pins is the operator's side of the configuration contract: «майже все з
 * .env можна змінити з /ops, зміна діє одразу або чесно каже, що чекає на перезапуск, і жодне
 * значення, яке не можна змінювати, змінити не вдасться». Concretely — the endpoint is closed
 * without operator credentials; a stored value overrides `.env` and reaches `config` in the same
 * request; `null` puts it back; four refusals are distinguishable by code; the delay cannot be moved
 * while the public view is held; and no credential leaves the process, proven by searching the
 * entire response body rather than the four fields somebody remembered.
 *
 * **Harness (b) of CONTRACT §12 wave 3**: a bare `Fastify({ logger: false })` with
 * `app.register(opsSettingsRoutes)`, the same shape `tests/integration/ops-runtime.test.ts` uses.
 * The plugin is registered without `fastify-plugin` in `buildServer()` too, and registering it onto
 * a bare instance is what proves it: the auth guard travels with the plugin, and nothing here needs
 * the rest of the server to exist.
 *
 * Every test that writes leaves `config` mutated in this process — the integration project runs one
 * fork — so `resetAppSettingsCache()` is in `beforeEach` AND in `afterAll`. Without the second one
 * this file would hand a raised `AI_TIMEOUT_MS` to whichever file vitest runs next.
 */

const OPS = `Basic ${Buffer.from('operator:change-me').toString('base64')}`;

async function buildApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const opsSettingsRoutes = (await import('../../src/api/ops-settings-routes.js')).default;
  const app = Fastify({ logger: false });
  await app.register(opsSettingsRoutes);
  await app.ready();
  return app;
}

async function get(app: FastifyInstance, headers: Record<string, string> = { authorization: OPS }) {
  return app.inject({ method: 'GET', url: '/ops/api/settings', headers });
}

async function put(
  app: FastifyInstance, values: Record<string, string | null>, confirm: string[] = []
) {
  return app.inject({
    method: 'PUT', url: '/ops/api/settings',
    headers: { authorization: OPS }, payload: { values, confirm }
  });
}

/** One setting out of the eighty, by key. */
function setting(body: any, key: string) {
  return body.settings.find((entry: any) => entry.key === key);
}

async function liveConfig() {
  return (await import('../../src/config.js')).config;
}

async function storedRows(): Promise<Array<{ key: string; value: string; updated_by: string }>> {
  const result = await sql<{ key: string; value: string; updated_by: string }>(
    'SELECT key,value,updated_by FROM app_settings ORDER BY key'
  );
  return result.rows;
}

async function auditRows() {
  const result = await sql<{ field: string; previous_value: string | null; new_value: string; changed_by: string; source: string }>(
    'SELECT field,previous_value,new_value,changed_by,source FROM app_settings_audit ORDER BY changed_at DESC, id DESC'
  );
  return result.rows;
}

describe.skipIf(!integrationDatabaseAvailable)('ops app settings', () => {
  beforeAll(async () => { await ensureMigrated(); });

  beforeEach(async () => {
    await resetDatabase();
    (await import('../../src/services/runtime-settings.js')).resetRuntimeSettingsCache();
    (await import('../../src/services/sse.js')).resetEventHubCursor();
    (await import('../../src/services/analytics-scheduler.js')).resetAnalyticsScheduler();
    (await import('../../src/services/risk.js')).resetRiskRunGuard();
    (await import('../../src/services/analytics-narrative.js')).resetAnalyticsNarrativeMemo();
    (await import('../../src/services/app-settings.js')).resetAppSettingsCache();
  });

  afterAll(async () => {
    (await import('../../src/services/app-settings.js')).resetAppSettingsCache();
  });

  // 1 ---------------------------------------------------------------------------------------------
  it('401s without operator credentials, on the read and on the write, and the write changes nothing', async () => {
    const app = await buildApp();
    try {
      const anonymous = await get(app, {});
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.headers['www-authenticate']).toBe('Basic realm="ThreatLens Ops"');

      const wrong = await get(app, { authorization: `Basic ${Buffer.from('operator:wrong').toString('base64')}` });
      expect(wrong.statusCode).toBe(401);

      const write = await app.inject({
        method: 'PUT', url: '/ops/api/settings', payload: { values: { AI_TIMEOUT_MS: '31000' } }
      });
      expect(write.statusCode).toBe(401);
      expect(await count('app_settings')).toBe(0);

      const audit = await app.inject({ method: 'GET', url: '/ops/api/settings/audit' });
      expect(audit.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // 2 ---------------------------------------------------------------------------------------------
  it('describes every setting once, in six groups, with the environment-only refusals and their reasons', async () => {
    const { APP_SETTINGS } = await import('../../src/config.js');
    const app = await buildApp();
    try {
      const body = (await get(app)).json();

      expect(body.settings).toHaveLength(Object.keys(APP_SETTINGS).length);
      expect(new Set(body.settings.map((entry: any) => entry.key)).size).toBe(body.settings.length);
      expect(body.groups.map((group: any) => group.id)).toEqual([
        'telegram', 'official', 'publication', 'analytics', 'map', 'system'
      ]);
      // Every setting belongs to a group the page can render it under.
      const groupIds = new Set(body.groups.map((group: any) => group.id));
      for (const entry of body.settings) expect(groupIds.has(entry.group), entry.key).toBe(true);

      // The refusals, each with a sentence explaining itself. An `envReason` that is empty would
      // render as a blank tooltip beside a field the operator cannot edit.
      expect(body.envOnly.length).toBe(
        body.settings.filter((entry: any) => entry.scope === 'env').length
      );
      for (const item of body.envOnly) expect(item.reason.length, item.key).toBeGreaterThan(20);

      // Nothing stored yet: the three sources are distinguishable, and `defaultValue` is the
      // schema's answer rather than the environment's.
      const timeout = setting(body, 'AI_TIMEOUT_MS');
      expect(timeout.source).toBe('default');
      expect(timeout.stored).toBeNull();
      expect(timeout.applied).toBe('20000');
      expect(timeout.defaultValue).toBe('20000');
      expect(timeout.ui).toEqual({ kind: 'number', min: 1, unit: 'мс' });

      // `tests/helpers/setup-env.ts` sets this one, so it is the `env` case.
      const token = setting(body, 'UKRAINE_ALARM_API_TOKEN');
      expect(token.source).toBe('env');
      expect(token.isSecret).toBe(true);
      expect(token.isSet).toBe(true);

      expect(body.orphans).toEqual([]);
      expect(body.blocked).toEqual([]);
      expect(body.rejected).toEqual([]);
      expect(body.restartPending).toEqual({ count: 0, keys: [] });
      expect(body.audit).toEqual([]);
    } finally {
      await app.close();
    }
  });

  // 3 ---------------------------------------------------------------------------------------------
  it('stores a value, applies it to the running config in the same request, and says where it came from', async () => {
    const app = await buildApp();
    try {
      const config = await liveConfig();
      expect(config.AI_TIMEOUT_MS).toBe(20000);

      const response = await put(app, { AI_TIMEOUT_MS: '31000' });
      expect(response.statusCode).toBe(200);

      // Hot: no restart, no second request, the value is in force by the time the response is built.
      expect(config.AI_TIMEOUT_MS).toBe(31000);

      const entry = setting(response.json(), 'AI_TIMEOUT_MS');
      expect(entry.source).toBe('db');
      expect(entry.stored).toBe('31000');
      expect(entry.applied).toBe('31000');
      expect(entry.defaultValue).toBe('20000');
      expect(entry.pendingRestart).toBe(false);
      expect(entry.updatedBy).toBe('operator');
      expect(entry.updatedAt).toBeTruthy();

      expect(await storedRows()).toEqual([
        { key: 'AI_TIMEOUT_MS', value: '31000', updated_by: 'operator' }
      ]);
    } finally {
      await app.close();
    }
  });

  // 4 ---------------------------------------------------------------------------------------------
  it('treats null as a reset: the row is deleted and the environment or the default takes over again', async () => {
    const app = await buildApp();
    try {
      const config = await liveConfig();
      await put(app, { AI_TIMEOUT_MS: '31000', MAP_STYLE_URL: 'https://tiles.example/stored' });
      expect(config.AI_TIMEOUT_MS).toBe(31000);

      const reset = await put(app, { AI_TIMEOUT_MS: null });
      expect(reset.statusCode).toBe(200);
      expect(config.AI_TIMEOUT_MS).toBe(20000);

      const entry = setting(reset.json(), 'AI_TIMEOUT_MS');
      expect(entry.source).toBe('default');
      expect(entry.stored).toBeNull();
      expect(entry.updatedAt).toBeNull();

      // Only the key that was reset. A reset is not a "restore everything".
      expect((await storedRows()).map((row) => row.key)).toEqual(['MAP_STYLE_URL']);
      expect(config.MAP_STYLE_URL).toBe('https://tiles.example/stored');

      // The reset is legible in the trail rather than being an absence.
      const audit = await auditRows();
      expect(audit[0]).toMatchObject({ field: 'AI_TIMEOUT_MS', previous_value: '31000', new_value: '«знято»' });
    } finally {
      await app.close();
    }
  });

  // 5 ---------------------------------------------------------------------------------------------
  it('refuses a key it has never heard of, and writes nothing at all', async () => {
    const app = await buildApp();
    try {
      const response = await put(app, { NOT_A_SETTING: 'x', AI_TIMEOUT_MS: '31000' });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'unknown_setting', keys: ['NOT_A_SETTING'] });
      // The legal half of the patch is refused with it: a partially applied patch is worse than none.
      expect(await count('app_settings')).toBe(0);
      expect((await liveConfig()).AI_TIMEOUT_MS).toBe(20000);
    } finally {
      await app.close();
    }
  });

  // 6 ---------------------------------------------------------------------------------------------
  it('refuses an environment-only key with the same refusal, and the ops door still opens', async () => {
    const app = await buildApp();
    try {
      for (const key of ['OPS_PASSWORD', 'DEPLOY_RUNNER_URL', 'NODE_ENV', 'DATABASE_URL']) {
        const response = await put(app, { [key]: 'chosen-from-the-web-page' });
        expect(response.statusCode, key).toBe(400);
        expect(response.json(), key).toEqual({ error: 'unknown_setting', keys: [key] });
      }
      expect(await count('app_settings')).toBe(0);
      expect(await count('app_settings_audit')).toBe(0);

      const config = await liveConfig();
      expect(config.OPS_PASSWORD).toBe('change-me');
      expect(config.NODE_ENV).toBe('test');
      // …and the credentials that were nearly rewritten still work.
      expect((await get(app)).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  // 7 ---------------------------------------------------------------------------------------------
  it('refuses a value the schema rejects, names the key, and leaves the previous one in force', async () => {
    const app = await buildApp();
    try {
      const config = await liveConfig();
      await put(app, { AI_TIMEOUT_MS: '31000' });

      const bad = await put(app, { AI_TIMEOUT_MS: 'тридцять секунд' });
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toEqual({ error: 'invalid_settings', issues: ['AI_TIMEOUT_MS'] });

      // The bound the schema owns, not a second copy of it in the route: 4 is below the floor of 5.
      const belowFloor = await put(app, { PUBLICATION_DELAY_SECONDS: '4' }, ['PUBLICATION_DELAY_SECONDS']);
      expect(belowFloor.statusCode).toBe(400);
      expect(belowFloor.json()).toEqual({ error: 'invalid_settings', issues: ['PUBLICATION_DELAY_SECONDS'] });

      expect(config.AI_TIMEOUT_MS).toBe(31000);
      expect((await storedRows()).map((row) => row.value)).toEqual(['31000']);
    } finally {
      await app.close();
    }
  });

  // 8 ---------------------------------------------------------------------------------------------
  it('demands a confirmation for a switch that can silence a warning, and only for a real change', async () => {
    const app = await buildApp();
    try {
      const config = await liveConfig();

      const unconfirmed = await put(app, { OSINT_MONITOR_ENABLED: 'false' });
      expect(unconfirmed.statusCode).toBe(400);
      expect(unconfirmed.json()).toEqual({ error: 'confirmation_required', keys: ['OSINT_MONITOR_ENABLED'] });
      expect(config.OSINT_MONITOR_ENABLED).toBe(true);
      expect(await count('app_settings')).toBe(0);

      const confirmed = await put(app, { OSINT_MONITOR_ENABLED: 'false' }, ['OSINT_MONITOR_ENABLED']);
      expect(confirmed.statusCode).toBe(200);
      expect(config.OSINT_MONITOR_ENABLED).toBe(false);

      // «Зберегти всі» re-sends the field unchanged. Demanding a second press for a value that is
      // not moving is what trains an operator to confirm without reading.
      const unchanged = await put(app, { OSINT_MONITOR_ENABLED: 'false', AI_TIMEOUT_MS: '31000' });
      expect(unchanged.statusCode).toBe(200);
      expect(config.AI_TIMEOUT_MS).toBe(31000);
    } finally {
      await app.close();
    }
  });

  // 9 ---------------------------------------------------------------------------------------------
  it('refuses to move the publication delay while the public view is held, and allows it live', async () => {
    const app = await buildApp();
    try {
      const config = await liveConfig();
      await sql(`UPDATE runtime_settings SET publication_mode='delayed_15s' WHERE singleton`);

      const held = await put(app, { PUBLICATION_DELAY_SECONDS: '30' }, ['PUBLICATION_DELAY_SECONDS']);
      expect(held.statusCode).toBe(409);
      expect(held.json()).toEqual({ error: 'publication_delayed', publicationMode: 'delayed_15s' });
      expect(config.PUBLICATION_DELAY_SECONDS).toBe(15);
      expect(await count('app_settings')).toBe(0);

      // Everything else is still writable while the hold is on: the refusal is about the one value
      // that would retract already-published rows, not about the mode being an editing lock.
      expect((await put(app, { AI_TIMEOUT_MS: '31000' })).statusCode).toBe(200);

      await sql(`UPDATE runtime_settings SET publication_mode='live' WHERE singleton`);
      const live = await put(app, { PUBLICATION_DELAY_SECONDS: '30' }, ['PUBLICATION_DELAY_SECONDS']);
      expect(live.statusCode).toBe(200);
      expect(config.PUBLICATION_DELAY_SECONDS).toBe(30);
      // Declared `restart` even though `delaySecondsFor` re-reads it: see the applyNote.
      expect(setting(live.json(), 'PUBLICATION_DELAY_SECONDS').pendingRestart).toBe(true);
    } finally {
      await app.close();
    }
  });

  // 10 --------------------------------------------------------------------------------------------
  it('never serialises a credential — searched for over the whole response, not over four fields', async () => {
    const app = await buildApp();
    try {
      const BOT_TOKEN = '7000000001:AA-integration-only-bot-token-value';
      const saved = await put(app, { TELEGRAM_BOT_TOKEN: BOT_TOKEN }, ['TELEGRAM_BOT_TOKEN']);
      expect(saved.statusCode).toBe(200);
      expect((await liveConfig()).TELEGRAM_BOT_TOKEN).toBe(BOT_TOKEN);

      for (const response of [saved, await get(app)]) {
        const raw = response.body;
        // The value that was just written, and the two credentials the ENVIRONMENT holds — being
        // unwritable is not the same as being safe to print.
        expect(raw).not.toContain(BOT_TOKEN);
        expect(raw).not.toContain(process.env.DATABASE_URL!);
        expect(raw).not.toContain('integration-ukraine-alarm-token');

        const entry = setting(response.json(), 'TELEGRAM_BOT_TOKEN');
        expect(entry).toMatchObject({
          isSecret: true, isSet: true, source: 'db',
          stored: null, applied: null, envValue: null, defaultValue: null
        });
        // Everything a console needs to draw the field is still there.
        expect(entry.updatedBy).toBe('operator');
      }

      // The one other place the value could reach a nightly dump.
      const audit = await auditRows();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        field: 'TELEGRAM_BOT_TOKEN', previous_value: null, new_value: '«замінено»'
      });
      expect(JSON.stringify(audit)).not.toContain(BOT_TOKEN);

      // Clearing it is recorded as a clearing, still without the value.
      await put(app, { TELEGRAM_BOT_TOKEN: null }, ['TELEGRAM_BOT_TOKEN']);
      expect((await auditRows())[0]).toMatchObject({
        field: 'TELEGRAM_BOT_TOKEN', previous_value: '«замінено»', new_value: '«знято»'
      });
    } finally {
      await app.close();
    }
  });

  // 11 --------------------------------------------------------------------------------------------
  it('writes one audit row per changed key, none for a no-op, and answers for one key on request', async () => {
    const app = await buildApp();
    try {
      await put(app, { AI_TIMEOUT_MS: '31000', AI_MODEL: 'gpt-test', MAP_STYLE_URL: 'https://tiles.example/a' });
      expect(await count('app_settings_audit')).toBe(3);

      // Re-sending the same values is not a change, and a trail that recorded it would be unreadable
      // the first time an operator pressed «Зберегти всі» twice.
      const again = await put(app, { AI_TIMEOUT_MS: '31000', AI_MODEL: 'gpt-test' });
      expect(again.statusCode).toBe(200);
      expect(await count('app_settings_audit')).toBe(3);

      await put(app, { AI_TIMEOUT_MS: '45000' });
      const all = await auditRows();
      expect(all).toHaveLength(4);
      expect(all[0]).toMatchObject({
        field: 'AI_TIMEOUT_MS', previous_value: '31000', new_value: '45000',
        changed_by: 'operator', source: 'ops_api'
      });

      const filtered = await app.inject({
        method: 'GET', url: '/ops/api/settings/audit?key=AI_TIMEOUT_MS', headers: { authorization: OPS }
      });
      expect(filtered.statusCode).toBe(200);
      expect(filtered.json().audit.map((row: any) => row.newValue)).toEqual(['45000', '31000']);

      const unknown = await app.inject({
        method: 'GET', url: '/ops/api/settings/audit?key=NOT_A_SETTING', headers: { authorization: OPS }
      });
      expect(unknown.statusCode).toBe(400);
      const badLimit = await app.inject({
        method: 'GET', url: '/ops/api/settings/audit?limit=9000', headers: { authorization: OPS }
      });
      expect(badLimit.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  // 12 --------------------------------------------------------------------------------------------
  it('raises the restart banner for a key its consumer froze, and not for one that is re-read', async () => {
    const app = await buildApp();
    try {
      // TELEGRAM_MODE is read once, inside createBot(); AI_TIMEOUT_MS is read per model call.
      //
      // `polling` rather than `disabled` because `tests/helpers/setup-env.ts` boots this process
      // with `TELEGRAM_MODE=disabled` — which is the point. The banner is a claim about the
      // difference from THIS PROCESS's boot value, not about whether a row was written, and writing
      // the value the process already started with must raise nothing.
      const response = await put(
        app, { TELEGRAM_MODE: 'polling', AI_TIMEOUT_MS: '31000' }, ['TELEGRAM_MODE']
      );
      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.restartPending).toEqual({ count: 1, keys: ['TELEGRAM_MODE'] });
      expect(setting(body, 'TELEGRAM_MODE').pendingRestart).toBe(true);
      expect(setting(body, 'TELEGRAM_MODE').applyNote).toContain('createBot()');
      expect(setting(body, 'AI_TIMEOUT_MS').pendingRestart).toBe(false);

      // Putting it back clears the banner: the claim is about the difference from boot, not about
      // whether a save happened. And a save that writes the boot value raises nothing at all.
      const restored = await put(app, { TELEGRAM_MODE: null }, ['TELEGRAM_MODE']);
      expect(restored.json().restartPending).toEqual({ count: 0, keys: [] });

      const sameAsBoot = await put(app, { TELEGRAM_MODE: 'disabled' }, ['TELEGRAM_MODE']);
      expect(sameAsBoot.json().restartPending).toEqual({ count: 0, keys: [] });
      expect(setting(sameAsBoot.json(), 'TELEGRAM_MODE').source).toBe('db');
    } finally {
      await app.close();
    }
  });

  // 13 --------------------------------------------------------------------------------------------
  it('ignores a hand-edited environment-only row and an orphan row at boot, and reports both', async () => {
    const app = await buildApp();
    try {
      // Rows the API refuses to create, inserted the way a restored dump or a careless psql session
      // would: straight into the table.
      await sql(
        `INSERT INTO app_settings(key,value,updated_by) VALUES
           ('OPS_PASSWORD','chosen-by-hand','psql'),
           ('DEPLOY_RUNNER_URL','http://attacker:9000','psql'),
           ('SOME_KEY_FROM_AN_OLDER_IMAGE','x','psql'),
           ('AI_TIMEOUT_MS','нечисло','psql'),
           ('MAP_STYLE_URL','https://tiles.example/hand','psql')`
      );

      // The boot path, which is the only one these rows can reach.
      const { loadAppSettings } = await import('../../src/services/app-settings.js');
      const state = await loadAppSettings();
      expect(state.degraded).toBe(false);

      const config = await liveConfig();
      expect(config.OPS_PASSWORD).toBe('change-me');
      expect(config.DEPLOY_RUNNER_URL).toBe('http://deployer:9000');
      expect(config.AI_TIMEOUT_MS).toBe(20000);                                 // refused, degraded
      expect(config.MAP_STYLE_URL).toBe('https://tiles.example/hand');           // its neighbour survived

      const body = (await get(app)).json();
      expect(body.blocked.sort()).toEqual(['DEPLOY_RUNNER_URL', 'OPS_PASSWORD']);
      expect(body.orphans).toEqual(['SOME_KEY_FROM_AN_OLDER_IMAGE']);
      expect(body.rejected).toEqual(['AI_TIMEOUT_MS']);
      // A blocked row is visible AS a row — the operator has to be able to see the thing that is
      // doing nothing in order to delete it — while `source` reports what is actually deciding.
      expect(setting(body, 'DEPLOY_RUNNER_URL')).toMatchObject({
        source: 'default', stored: 'http://attacker:9000', applied: 'http://deployer:9000'
      });
      // Same for a rejected row: what is IN the table, so it can be fixed, beside what is in force.
      expect(setting(body, 'AI_TIMEOUT_MS')).toMatchObject({
        stored: 'нечисло', applied: '20000', source: 'default'
      });
      // The credential never appears, hand-written or not.
      expect((await get(app)).body).not.toContain('chosen-by-hand');
    } finally {
      await app.close();
    }
  });
});
