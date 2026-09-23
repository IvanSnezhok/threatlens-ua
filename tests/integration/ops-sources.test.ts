import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { config } from '../../src/config.js';
import type * as TelegramCollector from '../../src/sources/telegram.js';
import {
  ensureMigrated, integrationDatabaseAvailable, resetDatabase, restoreSourceFlags, sql
} from '../helpers/db.js';

const OPS = `Basic ${Buffer.from('operator:change-me').toString('base64')}`;
const MONITOR = 'osint-eradar';
const ALERT_CHANNEL = 'air-alert-ua';
const MIRROR = 'aerial-alerts-mirror';
/** Everything the POST cases create, swept by prefix: `sources` is reference data and survives `resetDatabase()`. */
const CREATED_PREFIX = 'ops-created-';
const CREATED = `${CREATED_PREFIX}monitor`;

/**
 * Проксі навколо колектора, щоб «перезавантаження запитано» було ТВЕРДЖЕННЯМ, а не збігом.
 *
 * У процесі інтеграційних тестів живого MTProto-колектора немає, тож справжній
 * `requestTelegramCollectorReload()` повернув би `false` — і відповідь `collectorReloadRequested:
 * false` однаково влаштувала б і маршрут, який викликає колектор, і маршрут, який забув це зробити.
 * Лічильник розрізняє їх. `telegramCollectorStatus` лишається справжнім: від нього залежить поле
 * `subscription`, і підміняти його означало б перевіряти заглушку.
 */
const collector = vi.hoisted(() => ({ reloads: 0 }));
vi.mock('../../src/sources/telegram.js', async (importOriginal) => {
  const actual = await importOriginal<typeof TelegramCollector>();
  return {
    ...actual,
    requestTelegramCollectorReload: () => { collector.reloads += 1; return true; }
  };
});

async function buildApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const routes = (await import('../../src/api/ops-sources-routes.js')).default;
  const app = Fastify({ logger: false });
  await app.register(routes);
  await app.ready();
  return app;
}

async function get(app: FastifyInstance) {
  return app.inject({ method: 'GET', url: '/ops/api/sources', headers: { authorization: OPS } });
}

async function put(app: FastifyInstance, sourceId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'PUT', url: `/ops/api/sources/${sourceId}`, headers: { authorization: OPS }, payload
  });
}

async function post(app: FastifyInstance, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST', url: '/ops/api/sources', headers: { authorization: OPS }, payload
  });
}

/** A body the route accepts, so each refusal case differs from it by exactly one field. */
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CREATED,
    name: 'Тестовий монітор',
    telegramUsername: '@ops_created_monitor',
    adapterType: 'mtproto_monitor',
    tier: 'B',
    independenceGroup: 'ops-created-monitor',
    publicUrl: 'https://t.me/ops_created_monitor',
    expectedUpdateIntervalSeconds: 60,
    staleAfterSeconds: 300,
    reason: 'Перевірено класифікатором на двадцяти повідомленнях',
    ...overrides
  };
}

async function dropCreated(): Promise<void> {
  await sql(`DELETE FROM source_enabled_audit WHERE source_id LIKE $1`, [`${CREATED_PREFIX}%`]);
  await sql(`DELETE FROM sources WHERE id LIKE $1`, [`${CREATED_PREFIX}%`]);
}

describe.skipIf(!integrationDatabaseAvailable)('Ops source management', () => {
  beforeAll(async () => { await ensureMigrated(); });
  beforeEach(async () => {
    await resetDatabase();
    // Два кейси нижче вимикають офіційні канали тривог ГУРТОМ
    // (`UPDATE … WHERE official=true AND adapter_type=ANY(…)`), щоб перевірити захист «останнього
    // увімкненого джерела». Між тестами це треба відкотити, інакше наступний кейс стартує з
    // каталогом, у якому лишилося одне офіційне джерело. Між ФАЙЛАМИ те саме робить
    // `tests/helpers/setup-env.ts`, і з того ж знімка.
    await restoreSourceFlags();
    // `sources` не входить у `VOLATILE_TABLES` — це довідкові дані, які міграції засівають один раз.
    // Тож рядки, створені POST-кейсами, прибирає цей файл, інакше вони поїхали б у наступний.
    await dropCreated();
    collector.reloads = 0;
  });
  afterAll(async () => { await dropCreated(); });

  it('is private and reports freshness, holding alerts and both kinds of catalogue gap', async () => {
    await sql(`UPDATE sources SET enabled=true,health_status='error',last_error='fixture failure',
               last_error_at=now(),last_success_at=now()-interval '10 minutes' WHERE id=$1`, [MONITOR]);
    await sql(
      `INSERT INTO alert_source_states(source_id,location_id,alert_type,active,provider_started_at)
       VALUES ($1,'ua-32','air_raid',true,now()-interval '1 hour')`,
      [ALERT_CHANNEL]
    );
    const messageId = (await sql<{ id: string }>(
      `INSERT INTO source_messages(source_id,external_id,published_at,raw_text,content_hash,processing_status)
       VALUES ($1,'ops-gap',now(),'БпЛА курсом на невідоме місце','ops-gap','ignored') RETURNING id`,
      [MONITOR]
    )).rows[0]!.id;
    await sql(
      `INSERT INTO message_classifications(source_message_id,source_id,classifier_version,published_at,
         decision,intent,ignored_reason,threat_type,candidate_threat_types)
       VALUES ($1,$2,'test','now','ignored','threat','no_location','uav',ARRAY['uav'])`,
      [messageId, MONITOR]
    );

    const app = await buildApp();
    const transport = config.TELEGRAM_TRANSPORT;
    try {
      expect((await app.inject({ method: 'GET', url: '/ops/api/sources' })).statusCode).toBe(401);
      const response = await get(app);
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.notice).toContain('не стирає стан тривоги');
      expect(body.sources.length).toBeGreaterThan(50);
      expect(body.sources.find((source: { id: string }) => source.id === MONITOR)).toMatchObject({
        // The web transport — the default — reads the public preview without an account, so a
        // Telegram row has no prerequisite and its stored health word stands, failure included.
        configured: true, status: 'error', lastError: 'fixture failure',
        catalogueGaps: { ignoredMessages24h: 1 }
      });
      const holder = body.sources.find((source: any) => source.id === ALERT_CHANNEL);
      expect(holder.holdingCount).toBe(1);
      expect(holder.holding[0]).toMatchObject({ locationId: 'ua-32', alertType: 'air_raid' });
      expect(body.totals.holding).toBeGreaterThanOrEqual(1);
      expect(body.totals.withGaps).toBeGreaterThanOrEqual(1);

      // Under MTProto the three credentials are the prerequisite, and the integration process has
      // none: configuration truth outranks the stored health word, while the failure remains
      // visible in its own field.
      Object.assign(config, { TELEGRAM_TRANSPORT: 'mtproto' });
      expect((await get(app)).json().sources.find((source: { id: string }) => source.id === MONITOR)).toMatchObject({
        configured: false, status: 'unconfigured', lastError: 'fixture failure'
      });
    } finally {
      Object.assign(config, { TELEGRAM_TRANSPORT: transport });
      await app.close();
    }
  });

  it('requires a reason and optimistic state match for an ordinary Telegram source', async () => {
    await sql(`UPDATE sources SET enabled=true WHERE id=$1`, [MONITOR]);
    const app = await buildApp();
    try {
      expect((await put(app, MONITOR, {
        enabled: false, expectedEnabled: true, reason: 'short'
      })).statusCode).toBe(400);
      const stale = await put(app, MONITOR, {
        enabled: false, expectedEnabled: false, reason: 'Перевірено недоступний канал'
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error).toBe('source_state_changed');

      const changed = await put(app, MONITOR, {
        enabled: false, expectedEnabled: true, reason: 'Перевірено недоступний канал'
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toMatchObject({ enabled: false, holdingCount: 0, holdsPreserved: false });
      const stored = await sql<{ enabled: boolean; health_status: string }>(
        `SELECT enabled,health_status FROM sources WHERE id=$1`, [MONITOR]
      );
      expect(stored.rows[0]).toEqual({ enabled: false, health_status: 'disabled' });
      const audit = await sql<{ reason: string; previous_enabled: boolean; enabled: boolean }>(
        `SELECT reason,previous_enabled,enabled FROM source_enabled_audit WHERE source_id=$1`, [MONITOR]
      );
      expect(audit.rows).toEqual([{
        reason: 'Перевірено недоступний канал', previous_enabled: true, enabled: false
      }]);
    } finally {
      await app.close();
    }
  });

  it('requires official and hold acknowledgements and never clears held alert state', async () => {
    await sql(`UPDATE sources SET enabled=true WHERE id=ANY($1::text[])`, [[ALERT_CHANNEL, MIRROR]]);
    await sql(
      `INSERT INTO alert_source_states(source_id,location_id,alert_type,active,provider_started_at)
       VALUES ($1,'ua-32','air_raid',true,now()-interval '1 hour')`,
      [ALERT_CHANNEL]
    );
    const app = await buildApp();
    const base = { enabled: false, expectedEnabled: true, reason: 'Формат каналу більше не читається' };
    try {
      const noOfficial = await put(app, ALERT_CHANNEL, base);
      expect(noOfficial.json().error).toBe('official_confirmation_required');

      const noHold = await put(app, ALERT_CHANNEL, {
        ...base, confirmation: ALERT_CHANNEL, acknowledgeOfficialAuthority: true
      });
      expect(noHold.json()).toMatchObject({
        error: 'held_alerts_acknowledgement_required', holdingCount: 1
      });

      const changed = await put(app, ALERT_CHANNEL, {
        ...base, confirmation: ALERT_CHANNEL, acknowledgeOfficialAuthority: true,
        acknowledgeHeldAlerts: true
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toMatchObject({ enabled: false, holdingCount: 1, holdsPreserved: true });
      const held = await sql<{ active: boolean }>(
        `SELECT active FROM alert_source_states WHERE source_id=$1 AND location_id='ua-32'`,
        [ALERT_CHANNEL]
      );
      expect(held.rows[0]!.active).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('does not allow Ops to disable the last enabled official alert source', async () => {
    await sql(
      `UPDATE sources SET enabled=(id=$1)
        WHERE official=true AND adapter_type=ANY($2::text[])`,
      [MIRROR, ['ukraine_alarm', 'alerts_in_ua', 'aerial_alerts_mirror', 'mtproto_alert_channel']]
    );
    const app = await buildApp();
    try {
      const response = await put(app, MIRROR, {
        enabled: false, expectedEnabled: true, reason: 'Тривала відмова провайдера',
        confirmation: MIRROR, acknowledgeOfficialAuthority: true
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('last_official_alert_source');
      const source = await sql<{ enabled: boolean }>(`SELECT enabled FROM sources WHERE id=$1`, [MIRROR]);
      expect(source.rows[0]!.enabled).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('serializes two official switches so concurrent requests cannot disable the final pair', async () => {
    await sql(
      `UPDATE sources SET enabled=(id=ANY($1::text[]))
        WHERE official=true AND adapter_type=ANY($2::text[])`,
      [[MIRROR, ALERT_CHANNEL], ['ukraine_alarm', 'alerts_in_ua', 'aerial_alerts_mirror', 'mtproto_alert_channel']]
    );
    const app = await buildApp();
    try {
      const change = (id: string) => put(app, id, {
        enabled: false, expectedEnabled: true, reason: 'Паралельна перевірка захисного блокування',
        confirmation: id, acknowledgeOfficialAuthority: true
      });
      const responses = await Promise.all([change(MIRROR), change(ALERT_CHANNEL)]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      expect(responses.find((response) => response.statusCode === 409)?.json().error)
        .toBe('last_official_alert_source');
      const enabled = await sql<{ count: number }>(
        `SELECT count(*)::int AS count FROM sources WHERE official=true AND enabled=true
          AND adapter_type=ANY($1::text[])`,
        [['ukraine_alarm', 'alerts_in_ua', 'aerial_alerts_mirror', 'mtproto_alert_channel']]
      );
      expect(enabled.rows[0]!.count).toBe(1);
    } finally {
      await app.close();
    }
  });

  // ----------------------------------------------------------------------------------------------
  // Onboarding a monitoring channel without a migration
  // ----------------------------------------------------------------------------------------------

  it('registers a monitoring channel disabled, audits it and asks the collector to reload', async () => {
    const app = await buildApp();
    try {
      expect((await app.inject({
        method: 'POST', url: '/ops/api/sources', payload: validBody()
      })).statusCode).toBe(401);
      expect(collector.reloads).toBe(0);

      // Посилання, а не хендл: оператор копіює канал у тій формі, у якій його бачить.
      const created = await post(app, validBody({
        telegramUsername: 'https://t.me/Ops_Created_Monitor'
      }));
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        sourceId: CREATED, telegramUsername: 'ops_created_monitor', adapterType: 'mtproto_monitor',
        official: false, enabled: false, tier: 'B', collectorReloadRequested: true,
        nextStep: 'subscribe_then_enable'
      });
      expect(created.json().notice).toContain('підпишіть акаунт колектора');
      expect(collector.reloads).toBe(1);

      const stored = await sql<{
        name: string; adapter_type: string; official: boolean; enabled: boolean; tier: string;
        telegram_username: string; health_status: string; independence_group: string;
        stale_after_seconds: number; expected_update_interval_seconds: number; source_type: string;
        public_url: string;
      }>(`SELECT name,adapter_type,official,enabled,tier,telegram_username,health_status,
            independence_group,stale_after_seconds,expected_update_interval_seconds,source_type,
            public_url FROM sources WHERE id=$1`, [CREATED]);
      // Повний рядок, а не вибірка: колонки `sources` заповнюються позиційним `INSERT`, і зсув на
      // одну позицію дає валідний рядок із назвою в полі типу — тобто помилку, яку видно лише тут.
      expect(stored.rows[0]).toEqual({
        name: 'Тестовий монітор', adapter_type: 'mtproto_monitor', official: false, enabled: false,
        tier: 'B', telegram_username: 'ops_created_monitor', health_status: 'unknown',
        independence_group: 'ops-created-monitor', stale_after_seconds: 300,
        expected_update_interval_seconds: 60, source_type: 'telegram',
        public_url: 'https://t.me/ops_created_monitor'
      });

      const audit = await sql<{ reason: string; previous_enabled: boolean; enabled: boolean }>(
        `SELECT reason,previous_enabled,enabled FROM source_enabled_audit WHERE source_id=$1`, [CREATED]
      );
      expect(audit.rows).toEqual([{
        reason: 'Перевірено класифікатором на двадцяти повідомленнях',
        previous_enabled: false, enabled: false
      }]);
      const logged = await sql<{ event_type: string }>(
        `SELECT event_type FROM system_event_log WHERE payload->>'sourceId'=$1`, [CREATED]
      );
      expect(logged.rows.map((row) => row.event_type)).toEqual(['source.registered']);

      // Реєстр бачить рядок одразу — без міграції й без перезапуску процесу.
      const listed = (await get(app)).json().sources
        .find((source: { id: string }) => source.id === CREATED);
      expect(listed).toMatchObject({ enabled: false, status: 'disabled', subscription: 'unknown' });
    } finally {
      await app.close();
    }
  });

  it('refuses a handle another source already claims, and creates nothing', async () => {
    const app = await buildApp();
    try {
      // `osint-eradar` тримає `eRadarrua`; унікальний індекс побудовано на `lower(…)`, тож інший
      // регістр і форма посилання — це той самий канал.
      const response = await post(app, validBody({ telegramUsername: 'https://t.me/eRadarrua' }));
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: 'telegram_username_taken', telegramUsername: 'eradarrua'
      });
      expect(collector.reloads).toBe(0);
      expect((await sql(`SELECT 1 FROM sources WHERE id=$1`, [CREATED])).rowCount).toBe(0);

      // Той самий ідентифікатор двічі — друга спроба теж нічого не створює.
      expect((await post(app, validBody())).statusCode).toBe(201);
      const repeat = await post(app, validBody({ telegramUsername: '@ops_created_other' }));
      expect(repeat.statusCode).toBe(409);
      expect(repeat.json().error).toBe('source_exists');
      expect(collector.reloads).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('cannot be talked into alert authority: official, tier A and the alert adapter are refused', async () => {
    const app = await buildApp();
    try {
      for (const body of [
        validBody({ official: true }),
        validBody({ tier: 'A' }),
        validBody({ adapterType: 'mtproto_alert_channel' }),
        validBody({ telegramUsername: 'https://t.me/s/four' })   // хендл коротший за п'ять символів
      ]) {
        const response = await post(app, body);
        expect(response.statusCode).toBe(400);
        expect(['invalid_source', 'invalid_telegram_username']).toContain(response.json().error);
      }
      expect(collector.reloads).toBe(0);
      expect((await sql(`SELECT 1 FROM sources WHERE id=$1`, [CREATED])).rowCount).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('keeps the database as the second lock, so the route is not the only thing saying no', async () => {
    // Рівно той `INSERT`, що й у маршруті, але з `official=true`. Якщо колись цей тест почне
    // проходити без помилки, значить `sources_mtproto_monitor_check` зник, і будь-яка майбутня
    // помилка в маршруті стане джерелом з офіційною владою.
    await expect(sql(
      `INSERT INTO sources (id,name,source_type,tier,official,enabled,adapter_type,
         independence_group,telegram_username,health_status)
       VALUES ($1,'Обхід','telegram','B',true,false,'mtproto_monitor',$1,'ops_bypass','unknown')`,
      [`${CREATED_PREFIX}bypass`]
    )).rejects.toThrow(/sources_mtproto_monitor_check/);
    await expect(sql(
      `INSERT INTO sources (id,name,source_type,tier,official,enabled,adapter_type,
         independence_group,telegram_username,health_status)
       VALUES ($1,'Обхід','telegram','A',false,false,'mtproto_monitor',$1,'ops_bypass','unknown')`,
      [`${CREATED_PREFIX}bypass`]
    )).rejects.toThrow(/sources_mtproto_monitor_check/);
  });
});
