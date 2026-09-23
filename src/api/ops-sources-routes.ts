import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { MONITOR_ADAPTER_TYPE, unresolvedLocationReports } from '../services/ingestion.js';
import {
  requestTelegramCollectorReload, telegramCollectorStatus, type TelegramCollectorStatus
} from '../sources/telegram.js';
import { hasValidOpsAuth, opsUnauthorized } from './ops-auth.js';

const MANAGED_ADAPTERS = [
  'ukraine_alarm', 'alerts_in_ua', 'aerial_alerts_mirror',
  'mtproto', 'mtproto_alert_channel', 'mtproto_monitor'
] as const;
const TELEGRAM_ADAPTERS = new Set(['mtproto', 'mtproto_alert_channel', 'mtproto_monitor']);
const ALERT_ADAPTERS = new Set([
  'ukraine_alarm', 'alerts_in_ua', 'aerial_alerts_mirror', 'mtproto_alert_channel'
]);

const sourceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,95}$/i);
const changeSchema = z.object({
  enabled: z.boolean(),
  expectedEnabled: z.boolean(),
  reason: z.string().trim().min(8).max(500),
  confirmation: z.string().max(120).optional(),
  acknowledgeOfficialAuthority: z.boolean().optional().default(false),
  acknowledgeHeldAlerts: z.boolean().optional().default(false)
}).strict();

/**
 * Ідентифікатор нового рядка: лише нижній регістр, на відміну від {@link sourceIdSchema}.
 *
 * `sources.id` — це `text PRIMARY KEY`, тобто регістрочутливий, а читають його люди й інші рядки:
 * `independence_group` збігається з ним у половини каталогу, документація посилається на нього
 * словом, а `migrations/029` перелічує його в SQL. Дозволити `OSINT-Rynda` поруч із `osint-rynda`
 * означало б два різні джерела, які на екрані виглядають одним. Читання лишається терпимим до
 * регістру (сховище вже має обидва варіанти неможливими), запис — ні.
 */
const newSourceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/);

/**
 * Хендл Telegram: 5–32 символи, перший — літера, останній не підкреслення.
 *
 * Перевіряється ПІСЛЯ нормалізації, бо оператор копіює канал у тій формі, у якій його бачить:
 * `@war_monitor`, `https://t.me/war_monitor`, `t.me/s/war_monitor` — це той самий канал, і
 * відмовити на формі посилання означало б навчити оператора редагувати рядок вручну там, де це
 * вміє зробити функція.
 */
const TELEGRAM_HANDLE = /^[a-z][a-z0-9_]{3,30}[a-z0-9]$/i;

/**
 * Будь-яка форма запису каналу → хендл у нижньому регістрі, або `null`, якщо це не хендл.
 *
 * Нижній регістр не косметичний: унікальний індекс `sources_telegram_username_uidx` побудовано на
 * `lower(telegram_username)`, а `loadMonitoredTelegramChannels()` віддає колектору теж `lower(…)`.
 * Записати `AerisRimor` і порівнювати з `aerisrimor` у трьох місцях — це три шанси розійтися.
 */
function normaliseTelegramHandle(raw: string): string | null {
  const handle = raw.trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^t\.me\//i, '')
    .replace(/^s\//i, '')
    .replace(/^@/, '')
    .replace(/[/?#].*$/, '');
  return TELEGRAM_HANDLE.test(handle) ? handle.toLowerCase() : null;
}

/**
 * Реєстрація моніторингового каналу. Те, чого тут НЕМАЄ, — половина гарантії.
 *
 * `official` і `tier: 'A'` не є полями цієї схеми взагалі, а `adapterType` — літерал. Схема
 * `.strict()`, тож `{"official":true}` відхиляється як нерозпізнане поле, а не мовчки ігнорується:
 * запит, який просив alert-владу, мусить почути «ні», а не отримати 201 і рядок без того, що просив.
 *
 * Це ПЕРШИЙ замок, і сам по собі він нічого не гарантує. Другий стоїть у базі —
 * `sources_mtproto_monitor_check` (`migrations/011:31-35`) забороняє `mtproto_monitor` бути
 * `official` або Tier A незалежно від того, який код пише рядок. Маршрут, який лишився б єдиним
 * замком, перетворив би будь-яку майбутню помилку в цьому файлі на джерело з офіційною владою.
 */
const createSourceSchema = z.object({
  id: newSourceIdSchema,
  name: z.string().trim().min(2).max(120),
  telegramUsername: z.string().trim().min(1).max(120),
  // Літерал, а не enum: розширення переліку адаптерів — це рішення про рівень доказовості й
  // довіри, і воно не належить формі. `mtproto_alert_channel` тут поверне 400 з назвою поля.
  adapterType: z.literal(MONITOR_ADAPTER_TYPE),
  tier: z.enum(['B', 'C']),
  /**
   * Не має замовчування, і це не забута зручність.
   *
   * `count(DISTINCT independence_group)` — це рівно те, на чому `ingestThreat` піднімає подію до
   * `confirmed` (`src/repositories/events.ts:1010-1031`). Підставити сюди `id` нового рядка «бо так
   * у більшості» означає оголосити канал незалежним спостерігачем, не спитавши: якщо він насправді
   * репостить чужі повідомлення, та сама заява, порахована двічі, сама себе підтвердить. Правильне
   * значення для репостера — група першоджерела (`migrations/011:105-112`, `air-force`), і вибрати
   * її може лише той, хто читав канал.
   */
  independenceGroup: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  publicUrl: z.string().trim().url().max(300).optional(),
  // Межі свіжості обов'язкові: саме вони вирішують, коли мовчання каналу стає `stale` на /ops.
  // Значення за замовчуванням у таблиці (60/180) писалися під API-опитування, а не під канал, який
  // між хвилями мовчить хвилинами — тож тиха підстановка зробила б кожен новий канал «застарілим».
  expectedUpdateIntervalSeconds: z.number().int().min(10).max(3600),
  staleAfterSeconds: z.number().int().min(30).max(86_400),
  reason: z.string().trim().min(8).max(500)
}).strict();

function authorised(request: FastifyRequest): boolean {
  return hasValidOpsAuth(request.headers.authorization);
}

function sourceConfigured(row: { adapter_type: string; enabled: boolean }): boolean {
  if (!row.enabled) return false;
  // The web transport reads the public preview without an account, so a Telegram row has no
  // prerequisite there; only MTProto needs its three credentials. The rule `sourceIsConfigured` in
  // `./server.ts` applies too — the two must never disagree about the same row.
  const telegram = config.TELEGRAM_TRANSPORT === 'web'
    || Boolean(config.TELEGRAM_API_ID && config.TELEGRAM_API_HASH && config.TELEGRAM_SESSION);
  switch (row.adapter_type) {
    case 'mtproto':
    case 'mtproto_alert_channel':
    case 'mtproto_monitor': return telegram;
    case 'ukraine_alarm': return Boolean(config.UKRAINE_ALARM_API_TOKEN);
    case 'alerts_in_ua': return Boolean(config.ALERTS_IN_UA_TOKEN);
    case 'aerial_alerts_mirror': return config.AERIAL_MIRROR_ENABLED;
    default: return false;
  }
}

const SOURCE_LEDGER_SQL = `
WITH latest_message AS (
  SELECT source_id,max(received_at) AS received_at,max(published_at) AS published_at
    FROM source_messages GROUP BY source_id
), holds AS (
  SELECT ass.source_id,
         count(*) FILTER (WHERE ass.active OR COALESCE(
           ass.missing_since > now()-($1::int * interval '1 second'),false))::int AS holding_count,
         min(COALESCE(ass.provider_started_at,ass.last_event_at,ass.updated_at)) FILTER (
           WHERE ass.active OR COALESCE(
             ass.missing_since > now()-($1::int * interval '1 second'),false)) AS oldest_hold_at,
         jsonb_agg(jsonb_build_object(
           'locationId',ass.location_id,'locationName',l.name_uk,'alertType',ass.alert_type,
           'active',ass.active,'missingSince',ass.missing_since,
           'startedAt',COALESCE(ass.provider_started_at,ass.last_event_at,ass.updated_at)
         ) ORDER BY l.name_uk) FILTER (WHERE ass.active OR COALESCE(
           ass.missing_since > now()-($1::int * interval '1 second'),false)) AS holding
    FROM alert_source_states ass JOIN locations l ON l.id=ass.location_id GROUP BY ass.source_id
), gaps AS (
  SELECT mc.source_id,count(*)::int AS ignored_no_location_24h,max(mc.published_at) AS last_gap_at
    FROM message_classifications mc
   WHERE mc.ignored_reason='no_location' AND mc.published_at >= now()-interval '24 hours'
   GROUP BY mc.source_id
), latest_audit AS (
  SELECT DISTINCT ON (source_id) source_id,reason,changed_by,changed_at
    FROM source_enabled_audit ORDER BY source_id,changed_at DESC
)
SELECT s.id,s.name,s.source_type,s.tier,s.official,s.enabled,s.adapter_type,s.independence_group,
       s.expected_update_interval_seconds,s.stale_after_seconds,s.public_url,s.telegram_username,
       s.health_status,s.last_success_at,s.last_error_at,s.last_error,
       lm.received_at AS last_message_received_at,lm.published_at AS last_message_published_at,
       COALESCE(h.holding_count,0)::int AS holding_count,h.oldest_hold_at,
       COALESCE(h.holding,'[]'::jsonb) AS holding,
       COALESCE(g.ignored_no_location_24h,0)::int AS ignored_no_location_24h,g.last_gap_at,
       la.reason AS last_change_reason,la.changed_by AS last_changed_by,la.changed_at AS last_changed_at
  FROM sources s
  LEFT JOIN latest_message lm ON lm.source_id=s.id
  LEFT JOIN holds h ON h.source_id=s.id
  LEFT JOIN gaps g ON g.source_id=s.id
  LEFT JOIN latest_audit la ON la.source_id=s.id
 WHERE s.adapter_type = ANY($2::text[])
 ORDER BY CASE WHEN s.official THEN 0 ELSE 1 END,s.tier,s.name,s.id`;

/**
 * Що колектор насправді знає про підписку на канал цього рядка.
 *
 * `'unsubscribed'` — головна причина, чому ця функція існує. Такий маршрут ЗВ'ЯЗАНО: у
 * `resolveChannelPeers` він проходить через `contacts.ResolveUsername`, потрапляє в `byPeerId`,
 * рахується в `resolved`, колектор лишається `ready`, а щохвилинний heartbeat пише джерелу
 * `last_success_at`. Тобто рядок звітує «актуальне» — і не доставляє жодного живого повідомлення,
 * бо Telegram надсилає оновлення лише для діалогів, у яких акаунт перебуває. Без окремого поля цей
 * стан невідрізнимий від здорового на всіх поверхнях одразу.
 *
 * `'unknown'` — чесна відмова відповідати, а не «мабуть, усе добре»: доки прохід резолву не
 * завершився (`handlersReady=false`) або доки рядок вимкнений і в жоден прохід не входив, переліки
 * колектора не містять про нього ЖОДНОГО твердження.
 */
type SourceSubscription = 'subscribed' | 'unsubscribed' | 'unresolved' | 'unknown';

function subscriptionState(
  row: { adapter_type: string; enabled: boolean; telegram_username: string | null },
  collector: TelegramCollectorStatus
): SourceSubscription | null {
  if (!TELEGRAM_ADAPTERS.has(row.adapter_type) || !row.telegram_username) return null;
  const handle = row.telegram_username.toLowerCase();
  // Порівняння в нижньому регістрі з обох боків: переліки колектора формуються з ключів реєстру,
  // які `loadMonitoredTelegramChannels()` приводить до нижнього регістру ще в SQL, а колонка —
  // ні. Один рядок з великої літери інакше вічно читався б як «підписані».
  if (collector.unsubscribed.some((name) => name.toLowerCase() === handle)) return 'unsubscribed';
  if (collector.unresolved.some((name) => name.toLowerCase() === handle)) return 'unresolved';
  if (!row.enabled || !collector.handlersReady) return 'unknown';
  return 'subscribed';
}

async function readSources() {
  const rows = (await pool.query(SOURCE_LEDGER_SQL, [
    config.ALERT_END_DEBOUNCE_SECONDS, [...MANAGED_ADAPTERS]
  ])).rows;
  const reports = new Map(unresolvedLocationReports().map((report) => [report.sourceId, report]));
  const collector = telegramCollectorStatus();
  return rows.map((row) => {
    const configured = sourceConfigured(row);
    const report = reports.get(row.id);
    return {
      id: row.id,
      name: row.name,
      sourceType: row.source_type,
      tier: row.tier,
      official: row.official,
      enabled: row.enabled,
      adapterType: row.adapter_type,
      independenceGroup: row.independence_group,
      telegramUsername: row.telegram_username,
      publicUrl: row.public_url,
      configured,
      status: !row.enabled ? 'disabled' : configured ? row.health_status : 'unconfigured',
      expectedUpdateIntervalSeconds: row.expected_update_interval_seconds,
      staleAfterSeconds: row.stale_after_seconds,
      lastSuccessAt: row.last_success_at,
      lastErrorAt: row.last_error_at,
      lastError: row.last_error,
      lastMessageReceivedAt: row.last_message_received_at,
      lastMessagePublishedAt: row.last_message_published_at,
      holdingCount: row.holding_count,
      oldestHoldAt: row.oldest_hold_at,
      holding: row.holding,
      catalogueGaps: {
        ignoredMessages24h: row.ignored_no_location_24h,
        lastIgnoredAt: row.last_gap_at,
        providerCount: report?.count ?? 0,
        providerSamples: report?.samples ?? [],
        observedAt: report?.observedAt ?? null
      },
      lastChange: row.last_changed_at ? {
        reason: row.last_change_reason, changedBy: row.last_changed_by, changedAt: row.last_changed_at
      } : null,
      collector: TELEGRAM_ADAPTERS.has(row.adapter_type) ? collector : null,
      subscription: subscriptionState(row, collector)
    };
  });
}

const opsSourcesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/ops/api/sources', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    const sources = await readSources();
    return {
      generatedAt: new Date().toISOString(),
      notice: 'Вимкнення зупиняє майбутній збір, але не стирає стан тривоги, який джерело вже тримає. Аналітичні Telegram-джерела не можуть змінювати alert_source_states або alert_periods.',
      totals: {
        sources: sources.length,
        enabled: sources.filter((source) => source.enabled).length,
        failing: sources.filter((source) => ['error', 'stale'].includes(source.status)).length,
        holding: sources.filter((source) => source.holdingCount > 0).length,
        withGaps: sources.filter((source) => source.catalogueGaps.providerCount > 0
          || source.catalogueGaps.ignoredMessages24h > 0).length,
        // Окремо від `failing`, бо це протилежність збою: такі рядки звітують здоровими. Число тут
        // — єдине місце, де «зв'язано, але мовчить» видно, не розгортаючи жодного джерела.
        unsubscribed: sources.filter((source) => source.subscription === 'unsubscribed').length
      },
      sources
    };
  });

  /**
   * Реєстрація моніторингового каналу — запис, якого в цьому API не було.
   *
   * ================================================================================================
   * Чому це не міграція
   * ================================================================================================
   *
   * Кожен канал у каталозі — це `INSERT` у міграції плюс перерозгортання, і саме тому каталог не
   * рухався з `migrations/029`. Для рядка, який не може ні підняти, ні зняти тривогу, ціна входу
   * виявилася вищою за ціну помилки: моніторинговий канал живить `classifyMessage` і не має жодного
   * шляху до `alert_source_states` чи `alert_periods`.
   *
   * Канали ТРИВОГ лишаються тільки в міграціях, і це не непослідовність. Їхній `enabled` тримається
   * на доказі, якого форма не має й не може мати: дослівне повідомлення каналу, прогнане через
   * `parseAlertChannelMessage` і покладене фікстурою в `alert-parser.test.ts` (див. «Enabling a
   * switched-off source» у `docs/OPERATIONS.md`, міграції 013/014/029). Кнопка, яка створює рядок з
   * офіційною владою за тридцять секунд, знецінила б саме той доказ.
   *
   * ================================================================================================
   * Рядок приходить ВИМКНЕНИМ
   * ================================================================================================
   *
   * Рішення, і воно коштує оператору одного додаткового кроку. Три причини, кожної окремо досить:
   *
   *   1. `enabled=true` на моніторі — це твердження «цей канал публікує оперативний текст, який
   *      розбирається в українську локацію», і мірою тут, за `docs/OPERATIONS.md`, є прогін через
   *      `classifyMessage` його повідомлень, а не вигляд каналу. Між набором назви й натисканням
   *      кнопки цього прогону не було.
   *   2. Tier B підтверджує. Дві різні `independence_group` рівня A/B піднімають подію до
   *      `confirmed`; канал, увімкнений тієї ж секунди, коли його вперше побачили, може підтвердити
   *      чужу заяву раніше, ніж хтось прочитав бодай одне його повідомлення.
   *   3. Підписка. Якщо акаунт колектора на канал не підписаний, увімкнений рядок зв'яжеться через
   *      `contacts.ResolveUsername`, лишить колектор у стані `ready` і мовчатиме, звітуючи здоровим
   *      (див. {@link subscriptionState}). Вимкнений рядок не входить у прохід резолву взагалі, тож
   *      оператор вмикає його ПІСЛЯ підписки — і одразу бачить результат у `collector.unsubscribed`.
   *
   * Вмикання вже має своє місце: `PUT /ops/api/sources/:id`, з причиною, оптимістичним замком і
   * власним аудитом. Дублювати його тут прапорцем означало б два шляхи до одного рішення.
   */
  app.post('/ops/api/sources', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    const parsed = createSourceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_source', issues: parsed.error.flatten().fieldErrors
      });
    }
    const input = parsed.data;
    const telegramUsername = normaliseTelegramHandle(input.telegramUsername);
    if (!telegramUsername) {
      return reply.code(400).send({ error: 'invalid_telegram_username' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Без попереднього SELECT: обидва унікальні ключі вже в базі (`sources_pkey` і частковий
      // `sources_telegram_username_uidx` на `lower(telegram_username)`), і перевірка перед вставкою
      // лише додала б вікно, у якому два оператори пройшли б її обидва.
      await client.query(
        `INSERT INTO sources (id,name,source_type,tier,official,enabled,adapter_type,
           independence_group,expected_update_interval_seconds,stale_after_seconds,public_url,
           telegram_username,health_status)
         VALUES ($1,$2,'telegram',$3,false,false,$4,$5,$6,$7,$8,$9,'unknown')`,
        [input.id, input.name, input.tier, MONITOR_ADAPTER_TYPE, input.independenceGroup,
          input.expectedUpdateIntervalSeconds, input.staleAfterSeconds, input.publicUrl ?? null,
          telegramUsername]
      );
      // Той самий слід, що й у PUT, і навмисно в тій самій таблиці. `previous_enabled=false,
      // enabled=false` — не заглушка: колонки відповідають на «чи збирали до цього» і «чи збираємо
      // тепер», і для щойно створеного вимкненого рядка обидві відповіді — «ні». Причина при цьому
      // зберігається там, де її шукатимуть, — поруч із рештою рішень про цей source_id.
      await client.query(
        `INSERT INTO source_enabled_audit(source_id,previous_enabled,enabled,reason,changed_by)
         VALUES ($1,false,false,$2,$3)`,
        [input.id, input.reason, config.OPS_USER]
      );
      await client.query(
        `INSERT INTO system_event_log(event_type,payload) VALUES ('source.registered',$1)`,
        [JSON.stringify({
          sourceId: input.id, adapterType: MONITOR_ADAPTER_TYPE, tier: input.tier,
          independenceGroup: input.independenceGroup, telegramUsername, changedBy: config.OPS_USER
        })]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const failure = error as { code?: string; constraint?: string };
      if (failure.code === '23505') {
        return reply.code(409).send({
          error: failure.constraint === 'sources_telegram_username_uidx'
            ? 'telegram_username_taken' : 'source_exists',
          telegramUsername
        });
      }
      // Другий замок озвався. Недосяжно через цю схему — і саме тому це 409 з назвою обмеження, а
      // не 500: якщо він колись спрацює, оператор має прочитати, ЩО саме база відмовилася прийняти.
      if (failure.code === '23514') {
        return reply.code(409).send({ error: 'monitor_constraint_violated', constraint: failure.constraint });
      }
      throw error;
    } finally {
      client.release();
    }

    // Перезавантаження реєстру для ВИМКНЕНОГО рядка не зв'яже жодного каналу — і викликається воно
    // не заради цього. Повернене значення відповідає на питання, яке інакше з'ясувалося б аж після
    // вмикання: чи є в цьому розгортанні живий MTProto-колектор. `false` означає, що канал не
    // читатиметься, скільки б прапорців оператор не перемкнув, і сказати це треба зараз.
    const collectorReloadRequested = requestTelegramCollectorReload();
    return reply.code(201).send({
      sourceId: input.id,
      telegramUsername,
      tier: input.tier,
      independenceGroup: input.independenceGroup,
      adapterType: MONITOR_ADAPTER_TYPE,
      official: false,
      enabled: false,
      collectorReloadRequested,
      nextStep: 'subscribe_then_enable',
      notice: collectorReloadRequested
        ? 'Джерело створено вимкненим. Спершу підпишіть акаунт колектора на канал, і лише потім '
          + 'увімкніть рядок: увімкнений рядок без підписки зв\'яжеться, звітуватиме здоровим і не '
          + 'доставить жодного повідомлення.'
        : 'Джерело створено вимкненим, але живого MTProto-колектора в цьому розгортанні немає — '
          + 'канал не читатиметься навіть після вмикання. Перевірте TELEGRAM_API_ID, '
          + 'TELEGRAM_API_HASH і TELEGRAM_SESSION.'
    });
  });

  app.put<{ Params: { id: string } }>('/ops/api/sources/:id', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    if (!sourceIdSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: 'invalid_source_id' });
    }
    const parsed = changeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_source_change', issues: parsed.error.flatten().fieldErrors });
    }
    const client = await pool.connect();
    let adapterType: string;
    try {
      await client.query('BEGIN');
      // One decision at a time. Row locks on two different source ids would still let two requests
      // both observe "one other official source" and disable the final pair concurrently.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('ops-source-enabled-change'))`);
      const source = await client.query<{
        id: string; name: string; enabled: boolean; official: boolean; adapter_type: string;
      }>(
        `SELECT id,name,enabled,official,adapter_type FROM sources
          WHERE id=$1 AND adapter_type=ANY($2::text[]) FOR UPDATE`,
        [request.params.id, [...MANAGED_ADAPTERS]]
      );
      if (!source.rowCount) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'source_not_found' });
      }
      const row = source.rows[0]!;
      adapterType = row.adapter_type;
      if (row.enabled !== parsed.data.expectedEnabled) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'source_state_changed', enabled: row.enabled });
      }
      if (row.enabled === parsed.data.enabled) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'source_state_unchanged', enabled: row.enabled });
      }

      const held = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM alert_source_states
          WHERE source_id=$1 AND (active OR COALESCE(
            missing_since > now()-($2::int * interval '1 second'),false))`,
        [row.id, config.ALERT_END_DEBOUNCE_SECONDS]
      );
      const holdingCount = held.rows[0]?.count ?? 0;
      if (row.official && (parsed.data.confirmation !== row.id
        || !parsed.data.acknowledgeOfficialAuthority)) {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          error: 'official_confirmation_required', confirmation: row.id
        });
      }
      if (!parsed.data.enabled && holdingCount > 0 && !parsed.data.acknowledgeHeldAlerts) {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          error: 'held_alerts_acknowledgement_required', holdingCount
        });
      }
      if (!parsed.data.enabled && row.official && ALERT_ADAPTERS.has(row.adapter_type)) {
        const remaining = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM sources
            WHERE id<>$1 AND official=true AND enabled=true
              AND adapter_type=ANY($2::text[])`,
          [row.id, [...ALERT_ADAPTERS]]
        );
        if ((remaining.rows[0]?.count ?? 0) === 0) {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error: 'last_official_alert_source' });
        }
      }

      await client.query(
        `UPDATE sources SET enabled=$2,health_status=CASE WHEN $2 THEN 'unknown' ELSE 'disabled' END
          WHERE id=$1`,
        [row.id, parsed.data.enabled]
      );
      await client.query(
        `INSERT INTO source_enabled_audit(
           source_id,previous_enabled,enabled,reason,changed_by,
           official_authority_acknowledged,held_alerts_acknowledged,held_alerts_at_change
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [row.id, row.enabled, parsed.data.enabled, parsed.data.reason, config.OPS_USER,
          parsed.data.acknowledgeOfficialAuthority, parsed.data.acknowledgeHeldAlerts, holdingCount]
      );
      await client.query(
        `INSERT INTO system_event_log(event_type,payload) VALUES ('source.configuration_changed',$1)`,
        [JSON.stringify({
          sourceId: row.id, enabled: parsed.data.enabled, previousEnabled: row.enabled,
          holdingCount, changedBy: config.OPS_USER
        })]
      );
      await client.query('COMMIT');

      const collectorReloadRequested = TELEGRAM_ADAPTERS.has(adapterType)
        ? requestTelegramCollectorReload() : false;
      return {
        sourceId: row.id,
        enabled: parsed.data.enabled,
        holdingCount,
        holdsPreserved: holdingCount > 0,
        collectorReloadRequested
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });
};

export default opsSourcesRoutes;
export { opsSourcesRoutes, MANAGED_ADAPTERS, SOURCE_LEDGER_SQL };
