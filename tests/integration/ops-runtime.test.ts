import { beforeEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { count, ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

/**
 * `GET`/`PUT /ops/api/runtime`, end to end against a live PostgreSQL.
 *
 * The property this file pins is the operator's side of the publication contract: «оператор може
 * перемкнути режим і змінити каденцію перерахунку, не перезапускаючи контейнер, і кожна зміна
 * лишає слід». Concretely — the endpoint is closed without operator credentials, it refuses a
 * cross-field violation with a *named* 400 rather than the 500 the CHECK constraint would produce
 * (including the two-concurrent-requests case the in-transaction check exists for), it writes one
 * audit row per changed field and none for a no-op, and it announces a mode change through
 * `system_event_log` exactly once and only when the mode actually moved.
 *
 * **Harness (b) of CONTRACT §12 wave 3**: a bare `Fastify({ logger: false })` with
 * `app.register(opsRuntimeRoutes)`, copied from `tests/integration/analytics-routes.test.ts:20-27`.
 * The plugin is registered without `fastify-plugin` in `buildServer()` too, and registering it onto
 * a bare instance here is what proves that: its auth guard travels with it, and nothing in this file
 * needs the rest of the server to exist.
 *
 * Wall-clock behaviour is exercised by backdating the column the code itself wrote — never by fake
 * timers — because every decision under test is taken inside PostgreSQL `now()`.
 */

const OPS = `Basic ${Buffer.from('operator:change-me').toString('base64')}`;

/** The sentence the console shows beside the switch; `ops-runtime-routes.ts` owns the text. */
const NOTICE = 'Затримка стосується лише публічних snapshot, SSE, карти, панелі подій і аналітики. '
  + 'Збір, класифікація, аудит, /ops, метрики та Telegram-сповіщення не затримуються.';

async function buildApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const opsRuntimeRoutes = (await import('../../src/api/ops-runtime-routes.js')).default;
  const app = Fastify({ logger: false });
  await app.register(opsRuntimeRoutes);
  await app.ready();
  return app;
}

async function get(app: FastifyInstance, headers: Record<string, string> = { authorization: OPS }) {
  return app.inject({ method: 'GET', url: '/ops/api/runtime', headers });
}

async function put(app: FastifyInstance, payload: Record<string, unknown>) {
  return app.inject({ method: 'PUT', url: '/ops/api/runtime', headers: { authorization: OPS }, payload });
}

interface StoredSettings {
  publication_mode: string;
  analytics_event_driven: boolean;
  analytics_debounce_ms: number;
  analytics_max_delay_ms: number;
  analytics_min_pass_interval_ms: number;
  codex_cooldown_ms: number;
  updated_by: string;
}

async function storedSettings(): Promise<StoredSettings> {
  const result = await sql<StoredSettings>(
    `SELECT publication_mode,analytics_event_driven,analytics_debounce_ms,analytics_max_delay_ms,
            analytics_min_pass_interval_ms,codex_cooldown_ms,updated_by
       FROM runtime_settings WHERE singleton`
  );
  return result.rows[0]!;
}

async function auditRows() {
  const result = await sql<{ field: string; previous_value: string | null; new_value: string; changed_by: string; source: string }>(
    `SELECT field,previous_value,new_value,changed_by,source
       FROM runtime_settings_audit ORDER BY changed_at DESC, id DESC`
  );
  return result.rows;
}

describe.skipIf(!integrationDatabaseAvailable)('ops runtime settings', () => {
  beforeAll(async () => { await ensureMigrated(); });

  // The five in-process seams of CONTRACT §1.4 beside the TRUNCATE. `resetDatabase()` clears the
  // tables; it cannot clear the memo in `runtime-settings.ts` (this file writes through the
  // application pool and reads through the harness pool), the hub's cursors, the scheduler's flags,
  // the risk guard or the narrative memo. The list and its order are documented in
  // `tests/helpers/db.ts`.
  beforeEach(async () => {
    await resetDatabase();
    (await import('../../src/services/runtime-settings.js')).resetRuntimeSettingsCache();
    (await import('../../src/services/sse.js')).resetEventHubCursor();
    (await import('../../src/services/analytics-scheduler.js')).resetAnalyticsScheduler();
    (await import('../../src/services/risk.js')).resetRiskRunGuard();
    (await import('../../src/services/analytics-narrative.js')).resetAnalyticsNarrativeMemo();
  });

  it('401s without Basic auth, and says so in the header a browser needs', async () => {
    const app = await buildApp();
    try {
      const anonymous = await get(app, {});
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.headers['www-authenticate']).toBe('Basic realm="ThreatLens Ops"');

      const wrong = await get(app, {
        authorization: `Basic ${Buffer.from('operator:wrong').toString('base64')}`
      });
      expect(wrong.statusCode).toBe(401);

      const write = await app.inject({
        method: 'PUT', url: '/ops/api/runtime', payload: { publicationMode: 'delayed_15s' }
      });
      expect(write.statusCode).toBe(401);
      // The refusal must not be a refusal that also changed something.
      expect((await storedSettings()).publication_mode).toBe('live');
    } finally {
      await app.close();
    }
  });

  it('returns settings, effective, bounds, audit and the notice in one request', async () => {
    const app = await buildApp();
    try {
      const response = await get(app);
      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(Object.keys(body).sort()).toEqual(['audit', 'bounds', 'effective', 'notice', 'settings']);
      expect(body.settings).toMatchObject({
        publicationMode: 'live', analyticsEventDriven: true,
        analyticsDebounceMs: 20_000, analyticsMaxDelayMs: 120_000,
        analyticsMinPassIntervalMs: 60_000, codexCooldownMs: 900_000
      });
      // `modeChangedAt` is the clamp every public cutoff is taken against; a form that could not
      // show it would leave «чому карта не відстає» unanswerable.
      expect(Date.parse(body.settings.modeChangedAt)).not.toBeNaN();
      expect(body.effective).toMatchObject({ delaySeconds: 0, behindSeconds: 0, backlogEvents: 0 });
      expect(Date.parse(body.effective.cutoffAt)).not.toBeNaN();
      // Every numeric field the PUT accepts carries a range, which is the reported bug's fix on the
      // API side: the console can render «мін … макс» beside each input instead of discovering the
      // bounds from a 400 that names nothing. `analyticsDebounceMs.min` is 0 since migration 028.
      expect(body.bounds.analyticsDebounceMs).toEqual({ min: 0, max: 600_000 });
      expect(body.bounds.analyticsMaxDelayMs).toEqual({ min: 5000, max: 1_800_000 });
      expect(body.bounds.analyticsMinPassIntervalMs).toEqual({ min: 5000, max: 900_000 });
      expect(body.bounds.codexCooldownMs).toEqual({ min: 0, max: 86_400_000 });
      // A range for every settings field the form has an input for, and nothing extra beyond the
      // deployment constant the notice quotes.
      expect(Object.keys(body.bounds).sort()).toEqual([
        'analyticsDebounceMs', 'analyticsMaxDelayMs', 'analyticsMinPassIntervalMs',
        'codexCooldownMs', 'publicationDelaySeconds'
      ]);
      expect(body.bounds.publicationDelaySeconds).toBe(15);
      expect(body.audit).toEqual([]);
      expect(body.notice).toBe(NOTICE);
    } finally {
      await app.close();
    }
  });

  it('rejects analyticsMaxDelayMs below analyticsDebounceMs, including against the stored floor', async () => {
    const app = await buildApp();
    try {
      const both = await put(app, { analyticsDebounceMs: 60_000, analyticsMaxDelayMs: 30_000 });
      expect([both.statusCode, both.json()]).toEqual([400, { error: 'invalid_settings', issues: ['analyticsMaxDelayMs'] }]);

      // Only the maximum is sent; the floor it is checked against comes from the stored row (20 s),
      // which is the case a patch-shaped body makes possible and a whole-form body never would.
      const maxOnly = await put(app, { analyticsMaxDelayMs: 6000 });
      expect([maxOnly.statusCode, maxOnly.json()]).toEqual([400, { error: 'invalid_settings', issues: ['analyticsMaxDelayMs'] }]);

      const stored = await storedSettings();
      expect([stored.analytics_debounce_ms, stored.analytics_max_delay_ms]).toEqual([20_000, 120_000]);
      expect(await count('runtime_settings_audit')).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('saves the наживо combination: a zero debounce beside a five-second minimum interval', async () => {
    // The reported complaint, end to end. Before migration 028 this PUT was refused by the CHECK
    // floor on `analytics_debounce_ms` and the console said only «не зберігається».
    const app = await buildApp();
    try {
      const response = await put(app, { analyticsDebounceMs: 0, analyticsMinPassIntervalMs: 5000 });
      expect(response.statusCode).toBe(200);
      expect(response.json().settings).toMatchObject({
        analyticsDebounceMs: 0, analyticsMinPassIntervalMs: 5000,
        // Untouched, and still above the debounce: `runtime_settings_delay_order` is satisfiable
        // with a zero debounce because the maximum keeps its own floor of five seconds.
        analyticsMaxDelayMs: 120_000
      });

      const stored = await storedSettings();
      expect([stored.analytics_debounce_ms, stored.analytics_min_pass_interval_ms])
        .toEqual([0, 5000]);

      // One audit row per changed field, under the SQL names an operator reads in the table.
      const rows = await auditRows();
      expect(rows.map((row) => row.field).sort())
        .toEqual(['analytics_debounce_ms', 'analytics_min_pass_interval_ms']);
      expect(rows.find((row) => row.field === 'analytics_debounce_ms'))
        .toMatchObject({ previous_value: '20000', new_value: '0', changed_by: 'operator', source: 'ops_api' });
      expect(rows.find((row) => row.field === 'analytics_min_pass_interval_ms'))
        .toMatchObject({ previous_value: '60000', new_value: '5000', changed_by: 'operator', source: 'ops_api' });
    } finally {
      await app.close();
    }
  });

  it('names the field when a value is below its floor, instead of refusing anonymously', async () => {
    const app = await buildApp();
    try {
      // The one field that may NOT go to zero: at zero the overlap guard would be the only thing
      // between a sustained stream and back-to-back view refreshes plus a full risk pass.
      const zeroInterval = await put(app, { analyticsMinPassIntervalMs: 0 });
      expect([zeroInterval.statusCode, zeroInterval.json()])
        .toEqual([400, { error: 'invalid_settings', issues: ['analyticsMinPassIntervalMs'] }]);

      const belowFloor = await put(app, { analyticsMinPassIntervalMs: 4999 });
      expect([belowFloor.statusCode, belowFloor.json()])
        .toEqual([400, { error: 'invalid_settings', issues: ['analyticsMinPassIntervalMs'] }]);

      // Above the quiet-period floor: the floor's own pass would be refused by the interval.
      const aboveCeiling = await put(app, { analyticsMinPassIntervalMs: 900_001 });
      expect([aboveCeiling.statusCode, aboveCeiling.json()])
        .toEqual([400, { error: 'invalid_settings', issues: ['analyticsMinPassIntervalMs'] }]);

      // A debounce below its NEW floor of zero is still refused, and named.
      const negative = await put(app, { analyticsDebounceMs: -1 });
      expect([negative.statusCode, negative.json()])
        .toEqual([400, { error: 'invalid_settings', issues: ['analyticsDebounceMs'] }]);

      const stored = await storedSettings();
      expect([stored.analytics_debounce_ms, stored.analytics_min_pass_interval_ms])
        .toEqual([20_000, 60_000]);
      expect(await count('runtime_settings_audit')).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('rejects an unknown key instead of silently doing nothing', async () => {
    const app = await buildApp();
    try {
      const response = await put(app, { publicationModes: 'delayed_15s' });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('invalid_settings');
      // NOTE: zod v4 reports `unrecognized_keys` with an EMPTY `path` and the offending names in a
      // separate `keys` array, so `issues.map(i => i.path.join('.'))` cannot name the key here. The
      // property that matters — a typo'd field is refused rather than quietly ignored — is asserted
      // on the status and on the row below.
      expect(Array.isArray(response.json().issues)).toBe(true);
      expect((await storedSettings()).publication_mode).toBe('live');
      expect(await count('runtime_settings_audit')).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('rejects a mode outside the enum and leaves the stored row alone', async () => {
    const app = await buildApp();
    try {
      const response = await put(app, { publicationMode: 'delayed_60s' });
      expect([response.statusCode, response.json()]).toEqual([400, { error: 'invalid_settings', issues: ['publicationMode'] }]);
      expect((await storedSettings()).publication_mode).toBe('live');
      expect(await count('system_event_log', `event_type='publication.changed'`)).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('writes one audit row per changed field, attributed to the operator and to the API', async () => {
    const app = await buildApp();
    try {
      const response = await put(app, { publicationMode: 'delayed_15s', analyticsDebounceMs: 30_000 });
      expect(response.statusCode).toBe(200);

      const rows = await auditRows();
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.field).sort()).toEqual(['analytics_debounce_ms', 'publication_mode']);
      for (const row of rows) {
        expect(row.changed_by).toBe('operator');
        expect(row.source).toBe('ops_api');
      }
      // Column names, not camelCase: what an operator reading `runtime_settings_audit` sees.
      expect(rows.find((row) => row.field === 'publication_mode'))
        .toMatchObject({ previous_value: 'live', new_value: 'delayed_15s' });
      expect(rows.find((row) => row.field === 'analytics_debounce_ms'))
        .toMatchObject({ previous_value: '20000', new_value: '30000' });
      // The response is the same shape as GET, `effective` included — the console re-renders from
      // it, and a form showing the new mode beside the previous slice is the "switch on beside a
      // dead session" state this endpoint exists to prevent.
      expect(Object.keys(response.json()).sort()).toEqual(['audit', 'bounds', 'effective', 'notice', 'settings']);
      expect(response.json().settings.publicationMode).toBe('delayed_15s');
      expect(response.json().effective.delaySeconds).toBe(15);
    } finally {
      await app.close();
    }
  });

  it('writes no audit row and no system event for a no-op save', async () => {
    const app = await buildApp();
    try {
      const current = (await get(app)).json().settings;
      const response = await put(app, {
        publicationMode: current.publicationMode,
        analyticsEventDriven: current.analyticsEventDriven,
        analyticsDebounceMs: current.analyticsDebounceMs,
        analyticsMaxDelayMs: current.analyticsMaxDelayMs,
        analyticsMinPassIntervalMs: current.analyticsMinPassIntervalMs,
        codexCooldownMs: current.codexCooldownMs
      });

      expect(response.statusCode).toBe(200);
      expect(await count('runtime_settings_audit')).toBe(0);
      expect(await count('system_event_log', `event_type='publication.changed'`)).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('appends exactly one publication.changed when the mode flips, carrying the four fields', async () => {
    const app = await buildApp();
    try {
      expect((await put(app, { publicationMode: 'delayed_15s' })).statusCode).toBe(200);

      const events = await sql<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM system_event_log WHERE event_type='publication.changed' ORDER BY version`
      );
      expect(events.rowCount).toBe(1);
      expect(events.rows[0]!.payload).toMatchObject({
        mode: 'delayed_15s', delaySeconds: 15, changedBy: 'operator'
      });
      expect(Date.parse(String(events.rows[0]!.payload.changedAt))).not.toBeNaN();
    } finally {
      await app.close();
    }
  });

  it('appends no publication.changed when only the debounce moves', async () => {
    const app = await buildApp();
    try {
      expect((await put(app, { analyticsDebounceMs: 45_000 })).statusCode).toBe(200);

      expect(await count('system_event_log', `event_type='publication.changed'`)).toBe(0);
      expect(await count('runtime_settings_audit')).toBe(1);
      // `mode_changed_at` must not move on a save that did not change the mode: the cutoff clamp is
      // taken against it, and re-freezing it on every debounce edit would re-freeze the public view.
      const moved = await sql<{ fresh: boolean }>(
        `SELECT mode_changed_at > now() - interval '30 seconds' AS fresh FROM runtime_settings WHERE singleton`
      );
      expect(moved.rows[0]!.fresh).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('returns the newest twenty audit rows, newest first', async () => {
    const app = await buildApp();
    try {
      for (let index = 0; index < 25; index += 1) {
        // One changed field per save, so twenty-five saves are twenty-five audit rows.
        expect((await put(app, { analyticsDebounceMs: 10_000 + index * 1000 })).statusCode).toBe(200);
      }

      expect(await count('runtime_settings_audit')).toBe(25);
      const body = (await get(app)).json();
      expect(body.audit).toHaveLength(20);
      expect(body.audit[0].newValue).toBe('34000');
      expect(body.audit[19].newValue).toBe('15000');
      const times = body.audit.map((row: { changedAt: string }) => Date.parse(row.changedAt));
      expect([...times].sort((left, right) => right - left)).toEqual(times);
    } finally {
      await app.close();
    }
  });

  it('counts what is written but not released in effective.backlogEvents', async () => {
    const app = await buildApp();
    try {
      expect((await put(app, { publicationMode: 'delayed_15s' })).statusCode).toBe(200);
      // Two backdates, both of columns the code itself wrote. The `publication.changed` row the flip
      // appended is aged out of the backlog, and `mode_changed_at` is pushed back so the cutoff is
      // `now() - 15 s` rather than the flip instant — otherwise the clamp pins the cutoff to now and
      // the backlog is zero for a reason that has nothing to do with the hold.
      await sql(`UPDATE system_event_log SET created_at = created_at - interval '1 minute'`);
      await sql(`UPDATE runtime_settings SET mode_changed_at = now() - interval '1 hour'`);
      (await import('../../src/services/runtime-settings.js')).resetRuntimeSettingsCache();

      for (let index = 0; index < 3; index += 1) {
        await sql(`INSERT INTO system_event_log(event_type,payload) VALUES ('threat.created',$1)`,
          [JSON.stringify({ eventId: `backlog-${index}` })]);
      }

      const effective = (await get(app)).json().effective;
      expect(effective.backlogEvents).toBe(3);
      expect(effective.delaySeconds).toBe(15);
      expect(effective.behindSeconds).toBeGreaterThanOrEqual(14);
      expect(effective.behindSeconds).toBeLessThanOrEqual(18);
    } finally {
      await app.close();
    }
  });

  it('does not reset the fields a partial PUT omits', async () => {
    const app = await buildApp();
    try {
      expect((await put(app, {
        analyticsEventDriven: false, analyticsDebounceMs: 0,
        analyticsMaxDelayMs: 333_000, analyticsMinPassIntervalMs: 7000, codexCooldownMs: 3000
      })).statusCode).toBe(200);

      const response = await put(app, { publicationMode: 'delayed_15s' });

      expect(response.json().settings).toMatchObject({
        publicationMode: 'delayed_15s',
        // `false` is a value, not an absence: `??` and never `||` in `applyRuntimeSettingsPatch`.
        analyticsEventDriven: false,
        // And so is `0`, which is the same trap with a number and the shape of the reported bug: a
        // patch that omits the debounce must keep the stored zero rather than "restore" 20 000.
        analyticsDebounceMs: 0, analyticsMaxDelayMs: 333_000,
        analyticsMinPassIntervalMs: 7000, codexCooldownMs: 3000
      });
      const stored = await storedSettings();
      expect(stored.analytics_event_driven).toBe(false);
      expect([stored.analytics_debounce_ms, stored.analytics_max_delay_ms,
        stored.analytics_min_pass_interval_ms, stored.codex_cooldown_ms])
        .toEqual([0, 333_000, 7000, 3000]);
    } finally {
      await app.close();
    }
  });

  it('answers two crossing concurrent writes with a 400, never a 500', async () => {
    const app = await buildApp();
    try {
      // Stored: debounce 20 s, max 120 s. Each request passes the route's fast-path check against
      // the row as it was BEFORE the other one committed; only the check inside the FOR UPDATE can
      // see the combination. Without it the pair reaches the operator as the 500 the CHECK
      // constraint produces, with no `issues` array to act on.
      const [raised, lowered] = await Promise.all([
        put(app, { analyticsDebounceMs: 100_000 }),
        put(app, { analyticsMaxDelayMs: 50_000 })
      ]);

      const statuses = [raised.statusCode, lowered.statusCode].sort();
      expect(statuses).toEqual([200, 400]);
      const refused = raised.statusCode === 400 ? raised : lowered;
      expect(refused.json()).toEqual({ error: 'invalid_settings', issues: ['analyticsMaxDelayMs'] });

      const stored = await storedSettings();
      expect(stored.analytics_max_delay_ms).toBeGreaterThanOrEqual(stored.analytics_debounce_ms);
    } finally {
      await app.close();
    }
  });

  it('keeps its decisions apart from the Codex card instead of duplicating them', async () => {
    // CONTRACT §12 wave 3 property 9. The ops console points at the existing Codex card rather than
    // growing a second model selector, and this is the assertion that stops the two from drifting
    // into two places to change the same thing.
    const Fastify = (await import('fastify')).default;
    const opsRuntimeRoutes = (await import('../../src/api/ops-runtime-routes.js')).default;
    const opsCodexRoutes = (await import('../../src/api/ops-codex-routes.js')).default;
    const app = Fastify({ logger: false });
    await app.register(opsRuntimeRoutes);
    await app.register(opsCodexRoutes);
    await app.ready();
    try {
      const runtime = (await app.inject({
        method: 'GET', url: '/ops/api/runtime', headers: { authorization: OPS }
      })).json().settings;
      const codex = (await app.inject({
        method: 'GET', url: '/ops/codex/settings', headers: { authorization: OPS }
      })).json().settings;

      // `updatedAt` is the audit stamp every settings row carries and is deliberately not counted:
      // what must not overlap is the DECISIONS, which is what a duplicated control would be.
      const decisionKeys = (settings: Record<string, unknown>) =>
        Object.keys(settings).filter((key) => key !== 'updatedAt');
      const shared = decisionKeys(runtime).filter((key) => decisionKeys(codex).includes(key));
      expect(shared).toEqual([]);
      expect(Object.keys(runtime)).not.toContain('model');
      expect(Object.keys(runtime)).not.toContain('features');
      expect(Object.keys(codex)).not.toContain('publicationMode');
      expect(Object.keys(codex)).not.toContain('analyticsDebounceMs');
      // The one knob that names Codex lives here because it is a *cadence*, not a model choice.
      expect(Object.keys(runtime)).toContain('codexCooldownMs');
    } finally {
      await app.close();
    }
  });
});
