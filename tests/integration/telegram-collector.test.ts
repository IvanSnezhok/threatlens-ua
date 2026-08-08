import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

/**
 * The MTProto collector wired to the real catalogue, the real ingestion pipeline and the real
 * readiness surface — everything except Telegram itself.
 *
 * `src/sources/telegram.test.ts` pins the call counts against the library's own event builders. What
 * that file cannot show is the part an operator actually sees: that a message arriving on a
 * monitoring channel lands in `source_messages`, that a message arriving on an official channel
 * reaches `alert_source_states`/`alert_periods` and never the classifier, and that a collector held
 * down by a flood wait reports itself through `/health/ready` and `/api/v1/sources/health` instead of
 * leaving fresh `last_success_at` values behind a `healthy` container.
 *
 * The reconciliation and classification semantics themselves are NOT re-tested here — they belong to
 * `alert-channel.test.ts` and `osint-monitor-sources.test.ts`. This file asserts only that the
 * collector's delivery seam reaches each of them.
 */

// `src/config.ts` parses `process.env` at import time and the collector's first statement is a
// credentials gate, so the three variables have to be in place before anything under `src/` is
// pulled in. Restored in `afterAll` so the next integration file parses the environment it expects.
const COLLECTOR_ENV: Record<string, string> = {
  TELEGRAM_API_ID: '1000',
  TELEGRAM_API_HASH: 'integration-api-hash',
  TELEGRAM_SESSION: 'integration-session',
  // Connect-time backlog reading has its own coverage; leaving it on would only add seven empty
  // history reads to every test in this file.
  ALERT_CHANNEL_BACKFILL_MESSAGES: '0'
};
const PREVIOUS_ENV = Object.fromEntries(
  Object.keys(COLLECTOR_ENV).map((key) => [key, process.env[key]])
);
Object.assign(process.env, COLLECTOR_ENV);

const NIKOPOL = 'test-raion-nikopol';
const AIR_ALERT_UA = 'air-alert-ua';

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

interface ArmedTimer { ms: number; run: () => void; cancelled: boolean }

interface FakeClient {
  client: Record<string, any>;
  calls: { dialogScans: number; peerLookups: string[]; inputEntities: unknown[] };
  handlers: Array<[(event: any) => Promise<void>, any]>;
}

/** Marked channel ids, derived from the handle so a test can address a channel by name. */
function peerIdFor(username: string, handles: string[]): string {
  return `-100${2_000_000_000 + handles.indexOf(username)}`;
}

function fakeClient(handles: string[], options: { dialogsError?: Error } = {}): FakeClient {
  const calls = { dialogScans: 0, peerLookups: [] as string[], inputEntities: [] as unknown[] };
  const handlers: Array<[(event: any) => Promise<void>, any]> = [];
  return {
    calls,
    handlers,
    client: {
      async getDialogs() {
        calls.dialogScans += 1;
        if (options.dialogsError && calls.dialogScans === 1) throw options.dialogsError;
        return handles.map((username) => ({
          id: peerIdFor(username, handles), entity: { username }
        }));
      },
      async getPeerId(username: string) {
        calls.peerLookups.push(username);
        return peerIdFor(username, handles);
      },
      async getInputEntity(peer: unknown) {
        calls.inputEntities.push(peer);
        throw new Error(`getInputEntity must never run during startup (asked for ${String(peer)})`);
      },
      async getMessages() { return []; },
      addEventHandler(callback: (event: any) => Promise<void>, builder: any) { handlers.push([callback, builder]); },
      removeEventHandler(callback: (event: any) => Promise<void>, builder: any) {
        for (let index = handlers.length - 1; index >= 0; index -= 1) {
          const entry = handlers[index];
          if (entry && (entry[0] === callback || entry[1] === builder)) handlers.splice(index, 1);
        }
      },
      async disconnect() { return undefined; },
      _log: { error: () => undefined, warn: () => undefined }
    }
  };
}

/** Delivers one update the way `_dispatchUpdate` does — resolved builder, real chat filter. */
async function deliver(fake: FakeClient, kind: 'new' | 'edited', event: Record<string, unknown>): Promise<boolean> {
  const entry = fake.handlers[kind === 'new' ? 0 : 1];
  if (!entry) return false;
  const [callback, builder] = entry;
  if (!builder.resolved) return false;
  if (!builder.filter(event)) return false;
  await callback(event);
  return true;
}

describe.skipIf(!integrationDatabaseAvailable)('MTProto collector wiring', () => {
  let handles: string[] = [];
  let routes: Map<string, { kind: string; sourceId: string; username: string }>;
  let stopCollector: (() => Promise<void>) | undefined;
  let armed: ArmedTimer[] = [];
  let app: FastifyInstance;

  async function startWith(fake: FakeClient) {
    const [{ startTelegramCollector }, events, edited] = await Promise.all([
      import('../../src/sources/telegram.js'),
      import('teleproto/events/index.js'),
      import('teleproto/events/EditedMessage.js')
    ]);
    stopCollector = await startTelegramCollector(silentLog, {
      createRuntime: async () => ({
        client: fake.client, NewMessage: events.NewMessage as never, EditedMessage: edited.EditedMessage as never
      }),
      schedule: (run, ms) => {
        const timer: ArmedTimer = { ms, run, cancelled: false };
        armed.push(timer);
        return () => { timer.cancelled = true; };
      },
      // Long enough that no test in this file observes a heartbeat tick it did not ask for.
      heartbeatMs: 3_600_000
    });
  }

  async function status() {
    const { telegramCollectorStatus } = await import('../../src/sources/telegram.js');
    return telegramCollectorStatus();
  }

  beforeAll(async () => {
    await ensureMigrated();
    const { resolveChannelRoutes } = await import('../../src/sources/telegram.js');
    routes = await resolveChannelRoutes(silentLog) as never;
    handles = [...routes.keys()];
    // buildServer() registers every plugin itself; this file only reads from it.
    const { buildServer } = await import('../../src/api/server.js');
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    for (const [key, value] of Object.entries(PREVIOUS_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async () => {
    await resetDatabase();
    armed = [];
    const { resetTelegramCollectorStatus } = await import('../../src/sources/telegram.js');
    resetTelegramCollectorStatus();
    await sql(
      `INSERT INTO locations(id,parent_id,type,name_uk,aliases) VALUES ($1,'ua-12','raion','Нікопольський район','{}')
       ON CONFLICT (id) DO NOTHING`,
      [NIKOPOL]
    );
  });

  afterEach(async () => {
    await stopCollector?.();
    stopCollector = undefined;
  });

  it('subscribes to the whole catalogue from one dialog scan, with no username resolve', async () => {
    const fake = fakeClient(handles);
    await startWith(fake);

    expect(handles.length).toBeGreaterThanOrEqual(54);
    expect(fake.calls.dialogScans).toBe(1);
    expect(fake.calls.peerLookups).toEqual([]);
    // The library's own resolve path, the one that produced the FloodWaitError storm, is never
    // reached: `_intoIdSet` only calls `getInputEntity` for a value it cannot parse as an id.
    expect(fake.calls.inputEntities).toEqual([]);

    const [newBuilder, editedBuilder] = fake.handlers.map((entry) => entry[1]);
    expect(newBuilder.resolved).toBe(true);
    expect(editedBuilder.resolved).toBe(true);
    expect(newBuilder.chats).toHaveLength(handles.length);

    expect(await status()).toMatchObject({ state: 'ready', handlersReady: true, unresolved: [] });
  });

  it('marks exactly the subscribed sources current, and only after the handlers are ready', async () => {
    const before = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM sources WHERE health_status='current'`);
    expect(Number(before.rows[0]!.n)).toBe(0);

    await startWith(fakeClient(handles));

    const expected = new Set([...routes.values()].map((route) => route.sourceId));
    const current = await sql<{ id: string }>(
      `SELECT id FROM sources WHERE health_status='current' AND last_success_at IS NOT NULL ORDER BY id`
    );
    expect(current.rows.map((row) => row.id).sort()).toEqual([...expected].sort());
  });

  it('delivers a monitoring-channel message into the source_messages ingestion path', async () => {
    const fake = fakeClient(handles);
    await startWith(fake);

    const monitor = [...routes.values()]
      .find((route) => route.kind === 'classifier' && route.username !== 'kpszsu');
    expect(monitor).toBeDefined();
    const text = 'Загроза застосування ударних БпЛА для Полтавської області. Прямуйте в укриття.';
    const delivered = await deliver(fake, 'new', {
      chatId: peerIdFor(monitor!.username, handles),
      message: { id: 90210, message: text, date: Math.floor(Date.now() / 1000), out: false }
    });
    expect(delivered).toBe(true);

    const stored = await sql<{ source_id: string; external_id: string; raw_text: string; raw_payload: any }>(
      `SELECT source_id,external_id,raw_text,raw_payload FROM source_messages WHERE source_id=$1`,
      [monitor!.sourceId]
    );
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0]).toMatchObject({ external_id: '90210', raw_text: text });
    expect(stored.rows[0]!.raw_payload).toMatchObject({
      channel: monitor!.username, peerId: peerIdFor(monitor!.username, handles)
    });
    // A monitoring channel can never touch the official alert tables.
    expect((await sql(`SELECT 1 FROM alert_source_states`)).rowCount).toBe(0);
  });

  it('delivers an alert-channel message into the alert reconciliation path', async () => {
    const fake = fakeClient(handles);
    await startWith(fake);

    const alert = [...routes.values()].find((route) => route.sourceId === AIR_ALERT_UA);
    expect(alert).toBeDefined();
    const delivered = await deliver(fake, 'new', {
      chatId: peerIdFor(alert!.username, handles),
      message: {
        id: 5150,
        message: '🔴 12:29 Повітряна тривога в Нікопольський район\n'
          + 'Слідкуйте за подальшими повідомленнями.\n#Нікопольський_район',
        date: Math.floor(Date.now() / 1000), out: false
      }
    });
    expect(delivered).toBe(true);

    const states = await sql<{ location_id: string; active: boolean }>(
      `SELECT location_id,active FROM alert_source_states WHERE source_id=$1`, [AIR_ALERT_UA]
    );
    expect(states.rows).toEqual([{ location_id: NIKOPOL, active: true }]);
    const periods = await sql<{ location_id: string; status: string }>(
      `SELECT location_id,status FROM alert_periods`
    );
    expect(periods.rows).toEqual([{ location_id: NIKOPOL, status: 'active' }]);
    // The official channel never reaches the classifier, so nothing became a threat event.
    expect((await sql(`SELECT 1 FROM threat_events`)).rowCount).toBe(0);
  });

  it('reports a flood wait as not-ready, and recovers when the named interval elapses', async () => {
    const { FloodWaitError } = await import('teleproto/errors/index.js');
    const fake = fakeClient(handles, { dialogsError: new FloodWaitError({ capture: 900 }) as never });
    await startWith(fake);

    expect(await status()).toMatchObject({ state: 'flood_wait', handlersReady: false, resolved: 0 });
    expect(fake.handlers).toHaveLength(0);

    // Readiness. The container healthcheck probes /health/live, so this does not restart anything —
    // it is the signal an operator was missing while the process reported itself perfectly healthy.
    const notReady = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(notReady.statusCode).toBe(503);
    expect(notReady.json()).toMatchObject({
      status: 'not_ready', reason: 'collector_flood_wait',
      collector: { state: 'flood_wait', floodWaitSeconds: 900 }
    });

    // Source health. Nothing is `current`, every subscribed row carries the reason, and the live
    // collector state rides along on the MTProto rows only.
    const health = await app.inject({ method: 'GET', url: '/api/v1/sources/health' });
    const rows = health.json() as Array<Record<string, any>>;
    expect(rows.some((row) => row.status === 'current')).toBe(false);
    const mtproto = rows.filter((row) => String(row.adapter_type ?? '').startsWith('mtproto'));
    expect(mtproto.length).toBeGreaterThan(0);
    for (const row of mtproto) expect(row.collector).toMatchObject({ state: 'flood_wait' });
    for (const row of rows.filter((entry) => !String(entry.adapter_type ?? '').startsWith('mtproto'))) {
      expect(row.collector).toBeNull();
    }
    const errored = await sql<{ last_error: string }>(
      `SELECT last_error FROM sources WHERE id=$1`, [AIR_ALERT_UA]
    );
    expect(errored.rows[0]!.last_error).toContain('900s');

    // One timer, armed for exactly what Telegram named, and nothing asked for until it fires.
    expect(armed.filter((timer) => !timer.cancelled)).toHaveLength(1);
    expect(armed[0]!.ms).toBe(900_000);
    expect(fake.calls.dialogScans).toBe(1);
    expect(fake.calls.peerLookups).toEqual([]);

    armed[0]!.run();
    await expect.poll(async () => (await status()).state, { timeout: 15_000 }).toBe('ready');
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: 'ready', collector: { state: 'ready', handlersReady: true } });
  });
});
