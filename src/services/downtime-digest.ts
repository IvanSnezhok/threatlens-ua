import { Counter, type Registry } from 'prom-client';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { sourceMessageUrl } from '../domain/source-link.js';
import { deliveryAgeCeilingMs, relatedLocationsByRootCte } from '../repositories/events.js';
import { appendLocationContext, contextLine } from './model-context.js';

/**
 * Що було, поки нас не було — одним повідомленням, а не сотнею.
 *
 * ================================================================================================
 * Задача
 * ================================================================================================
 *
 * Після простою колектор дочитує пропущене (`./source-backfill.ts`), і зі стелею віку
 * (`SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES`, див. `src/repositories/events.ts`) кожне таке
 * повідомлення тепер лягає в архів і в контекст локацій, не створюючи ні події, ні сповіщення. Це
 * правильно поодинці й неповно в цілому: людина, підписана на місто, після трьох годин простою не
 * дізнається нічого — ані що по її місту вночі щось було, ані що не було нічого.
 *
 * Рішення власника 20.08.2026: за час простою — ОДНЕ повідомлення на чат, про те, що було, без
 * рядка на кожне значне повідомлення. Одне, бо сто попереджень про те, що вже скінчилося, — не
 * попередження, а шум, який вчить читача вимикати бота; і саме тому це зведення їде тихо
 * (`silent`), найнижчим пріоритетом і без жодного заклику в укриття: укриття — на офіційний сигнал
 * про те, що відбувається зараз.
 *
 * ================================================================================================
 * Що воно каже і чого не каже
 * ================================================================================================
 *
 * Каже: вікно простою, скільки повідомлень стосувалося кожного місця, які класи загроз називали
 * джерела і скільки з тих повідомлень стали подіями. Кожне число — це рахунок ПОВІДОМЛЕНЬ, і текст
 * говорить це вголос, тією самою мовою, що й `./attack-analytics.ts`: «повідомлень», ніколи не
 * «цілей». Скільки чого летіло, канали не пишуть, і зведення не має права це вигадати.
 *
 * Не каже: чи є загроза зараз. Це погляд назад на закрите вікно, і кожен його рядок — у минулому
 * часі. Ніщо тут не пише в `threat_events`, `alert_periods` чи `system_event_log`, і жоден рядок не
 * може стати тривогою або відбоєм.
 *
 * ================================================================================================
 * Той самий простій — для моделі
 * ================================================================================================
 *
 * {@link renderDowntimeForModel} записує ті самі повідомлення в контекст локацій у переліченому
 * вигляді, який назвав власник: «повідомлення N : час HH:MM, канал, посилання». Це не текст для
 * людини — це вхід для наступного запиту до моделі про це місце (`./codex-classifier.ts`,
 * `./risk.ts`): модель, яка бачить, що о 02:14 і о 02:31 два канали писали про Шахеди над цим
 * районом, читає наступне повідомлення про нього інакше, ніж модель, для якої ніч порожня. Посилання
 * — щоб кожен рядок лишався перевірюваним, а не переказом з нашої памʼяті.
 */

const DIGEST_WORKER = 'downtime-digest';

/** Скільки місць потрапляє в одне повідомлення чату, і скільки повідомлень — в один перелік моделі. */
const MAX_LOCATIONS_PER_CHAT = 6;
const MAX_MESSAGES_PER_CONTEXT = 40;

/** Рішення конвеєра, за яких повідомлення справді щось стверджувало про місце. */
const ASSERTING_DECISIONS = ['event_created', 'event_merged', 'redirect'];

export const downtimeDigests = new Counter({
  name: 'threatlens_downtime_digests_total',
  help: 'Downtime digests produced, by outcome: queued chats, locations covered, or a pass with nothing to say',
  labelNames: ['outcome'],
  registers: []
});

export function registerDowntimeDigestMetrics(registry: Registry): void {
  if (!registry.getSingleMetric('threatlens_downtime_digests_total')) registry.registerMetric(downtimeDigests);
}

// ------------------------------------------------------------------------------------------------
// Що саме ми проґавили
// ------------------------------------------------------------------------------------------------

export interface DowntimeMessage {
  publishedAt: Date;
  sourceId: string;
  sourceName: string;
  url: string | null;
  threatType: string;
  directionText: string | null;
  createdEvent: boolean;
  locationId: string;
  locationName: string;
  locationType: string;
}

/**
 * Повідомлення, про які ми дізналися запізно — і те, яких місць вони стосувалися.
 *
 * «Запізно» вимірюється в самому архіві: `classified_at - published_at >= стеля`. Це властивість
 * рядка, а не того, коли запустили зведення, тож двічі запущений прохід над тим самим вікном бачить
 * той самий набір, а перезапуск процесу нічого не змінює. Порівняння з тією ж стелею, яку читає
 * `ingestThreat`, — і не з власною копією числа: інакше «застаріле» означало б тут одне, а там інше.
 *
 * Три межі, і кожна відповідає на власне питання:
 *
 *  * `classified_at > $1` — **курсор**: що зʼявилося в архіві після попереднього зведення. Саме він,
 *    а не вікно публікацій, робить прохід неповторним, бо вікна двох сусідніх дозборів
 *    перекриваються, а рядки архіву — ні;
 *  * `classified_at <= $2` — верхня межа того самого курсора;
 *  * `published_at >= $5` — **підлога простою**, і без неї зведення бреше. Перший бойовий прохід
 *    (20.08.2026) заявив вікно «з 12 травня»: у добу, з якої курсор почав, потрапили рядки архіву,
 *    чиї повідомлення опубліковано три місяці тому, і читач отримав би «поки звʼязок був відсутній,
 *    12.05–20.08». Простій не може бути довшим, ніж дозбір узагалі має право сягати назад
 *    (`CLASSIFIER_BACKFILL_MAX_AGE_SECONDS`), тож саме це число і є підлогою: те, що старше, не є
 *    пропущеним за час мовчання — воно є архівом.
 */
/**
 * Найдавніше, що ще має право називатися простоєм.
 *
 * Те саме число, яким обмежений сам дозбір: далі назад він не читає, тож нічого старшого в
 * «пропущене за час мовчання» потрапити не може. Читається щоразу — межа дозбору гаряча.
 */
export function downtimeFloor(now: Date): Date {
  return new Date(now.getTime() - config.CLASSIFIER_BACKFILL_MAX_AGE_SECONDS * 1000);
}

export async function downtimeMessages(since: Date, until: Date): Promise<DowntimeMessage[]> {
  const ceiling = deliveryAgeCeilingMs();
  if (ceiling === null) return [];
  const result = await pool.query<{
    published_at: Date; source_id: string; source_name: string; telegram_username: string | null;
    public_url: string | null; external_id: string; threat_type: string | null; direction_text: string | null;
    created_event: boolean; location_id: string; name_uk: string; type: string;
  }>(
    `SELECT mc.published_at, mc.source_id, s.name AS source_name, s.telegram_username, s.public_url,
            sm.external_id, mc.threat_type, mc.direction_text, mc.created_event,
            el.location_id, l.name_uk, l.type
       FROM message_classifications mc
       JOIN source_messages sm ON sm.id = mc.source_message_id
       JOIN sources s ON s.id = mc.source_id
       JOIN threat_event_locations el ON el.event_id = mc.event_id
       JOIN locations l ON l.id = el.location_id
      WHERE mc.classified_at > $1 AND mc.classified_at <= $2
        AND mc.decision = ANY($3::text[])
        AND mc.classified_at - mc.published_at >= make_interval(secs => $4::double precision)
        AND mc.published_at >= $5
      ORDER BY mc.published_at, mc.source_id, el.location_id`,
    [since, until, ASSERTING_DECISIONS, ceiling / 1000, downtimeFloor(until)]
  );
  return result.rows.map((row) => ({
    publishedAt: row.published_at,
    sourceId: row.source_id,
    sourceName: row.source_name,
    url: sourceMessageUrl({
      telegramUsername: row.telegram_username, externalId: row.external_id, publicUrl: row.public_url
    }),
    threatType: row.threat_type ?? 'unknown',
    directionText: row.direction_text,
    createdEvent: row.created_event,
    locationId: row.location_id,
    locationName: row.name_uk,
    locationType: row.type
  }));
}

// ------------------------------------------------------------------------------------------------
// Перелік для моделі
// ------------------------------------------------------------------------------------------------

function kyivClock(at: Date): string {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: config.APP_TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(at);
}

/**
 * «повідомлення 1 : час 02:14, Napalm, https://t.me/napalm/9931;» — формат, який назвав власник.
 *
 * Один рядок на повідомлення, нумерація наскрізна, час київський, назва каналу така, як її бачить
 * читач, і посилання на сам пост. Джерело без публічної адреси дає рядок без посилання, а не рядок
 * із посиланням у нікуди.
 *
 * Дедуплікація за (каналом, часом): одне повідомлення, що зачепило три райони, — це одне
 * повідомлення в переліку, а не три. Без цього модель читала б трикратне повторення як три
 * незалежні свідчення.
 */
export function renderDowntimeForModel(messages: readonly DowntimeMessage[], limit = MAX_MESSAGES_PER_CONTEXT): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const message of messages) {
    const key = `${message.sourceId}|${message.publishedAt.getTime()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`повідомлення ${lines.length + 1} : час ${kyivClock(message.publishedAt)}, ${message.sourceName}`
      + `${message.url ? `, ${message.url}` : ''};`);
    if (lines.length >= limit) break;
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------------------------------------
// Зведення для людини
// ------------------------------------------------------------------------------------------------

const THREAT_WORDS: Record<string, string> = {
  uav: 'ударні БпЛА', ballistic_missile: 'балістика', cruise_missile: 'крилаті ракети',
  guided_air_bomb: 'КАБи', aviation: 'авіація', mlrs: 'РСЗВ', artillery: 'артилерія',
  mortar: 'обстріли', combined: 'комбінована загроза', unknown: 'невизначена загроза'
};

export interface DowntimeLocationSummary {
  locationId: string;
  locationName: string;
  /** Скільки РІЗНИХ повідомлень стосувалося цього місця. Не цілей і не засобів. */
  messages: number;
  /** Класи загроз, які називали джерела, від найчастішого. */
  classes: string[];
  firstAt: Date;
  lastAt: Date;
}

/** Одне місце — один підсумок. Повідомлення, що зачепило три місця, рахується в кожному з них раз. */
export function summariseByLocation(messages: readonly DowntimeMessage[]): DowntimeLocationSummary[] {
  const byLocation = new Map<string, {
    name: string; seen: Set<string>; classes: Map<string, number>; first: Date; last: Date;
  }>();
  for (const message of messages) {
    const entry = byLocation.get(message.locationId) ?? {
      name: message.locationName, seen: new Set<string>(), classes: new Map<string, number>(),
      first: message.publishedAt, last: message.publishedAt
    };
    const key = `${message.sourceId}|${message.publishedAt.getTime()}`;
    if (!entry.seen.has(key)) {
      entry.seen.add(key);
      entry.classes.set(message.threatType, (entry.classes.get(message.threatType) ?? 0) + 1);
    }
    if (message.publishedAt < entry.first) entry.first = message.publishedAt;
    if (message.publishedAt > entry.last) entry.last = message.publishedAt;
    byLocation.set(message.locationId, entry);
  }
  return [...byLocation.entries()]
    .map(([locationId, entry]) => ({
      locationId,
      locationName: entry.name,
      messages: entry.seen.size,
      classes: [...entry.classes.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([threatType]) => THREAT_WORDS[threatType] ?? threatType),
      firstAt: entry.first,
      lastAt: entry.last
    }))
    .sort((left, right) => right.messages - left.messages || left.locationName.localeCompare(right.locationName));
}

/** «Київська область — 7 повідомлень (ударні БпЛА, балістика), 01:40–04:12». */
export function downtimeLine(summary: DowntimeLocationSummary): string {
  const window = `${kyivClock(summary.firstAt)}–${kyivClock(summary.lastAt)}`;
  const classes = summary.classes.slice(0, 3).join(', ');
  return `${summary.locationName} — ${summary.messages} ${plural(summary.messages, 'повідомлення', 'повідомлення', 'повідомлень')}`
    + `${classes ? ` (${classes})` : ''}, ${window}`;
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = count % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

// ------------------------------------------------------------------------------------------------
// Прохід
// ------------------------------------------------------------------------------------------------

export interface DowntimeDigestResult {
  /** Скільки чатів отримали зведення. */
  chats: number;
  /** Скільки місць воно накрило. */
  locations: number;
  /** Скільки повідомлень простою лягло в контексти локацій для моделі. */
  contextMessages: number;
}

const NOTHING: DowntimeDigestResult = { chats: 0, locations: 0, contextMessages: 0 };

async function readCursor(): Promise<Date> {
  const state = await pool.query<{ cursor_value: string }>(
    `SELECT cursor_value::text FROM worker_state WHERE worker_name=$1`, [DIGEST_WORKER]
  );
  const value = Number(state.rows[0]?.cursor_value ?? 0);
  // Порожній курсор — не «уся історія». Перший прохід після викочування має бачити лише те, що
  // сталося за останню добу: зведення про позаминулий тиждень нікому не потрібне, а прочитати
  // піврічний архів однією вибіркою — це вже не зведення, а інцидент.
  return new Date(value > 0 ? value : Date.now() - 24 * 3_600_000);
}

async function writeCursor(at: Date): Promise<void> {
  await pool.query(
    `INSERT INTO worker_state(worker_name,cursor_value,updated_at) VALUES ($1,$2,now())
     ON CONFLICT (worker_name) DO UPDATE SET cursor_value=EXCLUDED.cursor_value, updated_at=now()`,
    [DIGEST_WORKER, at.getTime()]
  );
}

/**
 * Один прохід: контекст моделі, потім зведення читачам.
 *
 * Порядок навмисний і той самий, що в решті проєкту не так: тут спершу пишеться контекст, бо він не
 * має адресата й не може розбудити людину, а зведення — може. Курсор рухається ПЕРЕД розсилкою: збій
 * при вставці в чергу коштує одного пропущеного зведення, а той самий збій після повторного читання
 * того самого вікна коштував би читачеві другої копії того, що він уже прочитав.
 */
export async function publishDowntimeDigest(now = new Date()): Promise<DowntimeDigestResult> {
  const since = await readCursor();
  const messages = await downtimeMessages(since, now);
  await writeCursor(now);
  if (!messages.length) {
    downtimeDigests.inc({ outcome: 'nothing' });
    return NOTHING;
  }
  const summaries = summariseByLocation(messages);

  // ---- контекст локацій: той самий простій, переліком, для наступного запиту до моделі ----------
  let contextMessages = 0;
  if (config.MODEL_CONTEXT_ENABLED) {
    for (const summary of summaries) {
      const forLocation = messages.filter((message) => message.locationId === summary.locationId);
      const listing = renderDowntimeForModel(forLocation);
      if (!listing) continue;
      contextMessages += listing.split('\n').length;
      await appendLocationContext(
        [summary.locationId],
        contextLine(summary.lastAt, `дозбір після простою, ${summary.locationName}, ${downtimeLine(summary)}:\n${listing}`,
          Number.MAX_SAFE_INTEGER)
      ).catch(() => undefined);
    }
  }

  // ---- одне повідомлення на чат ----------------------------------------------------------------
  const locationIds = summaries.map((summary) => summary.locationId);
  // `root` — це те місце, де вночі щось було; `id` — усе, підписка на що робить його «своїм» для
  // читача. Групування дає кожному чату РІВНО ті місця з простою, які він просив, і жодного зайвого.
  const subscribers = await pool.query<{ chat_id: string; location_ids: string[] }>(
    `${relatedLocationsByRootCte()}
     SELECT s.chat_id, array_agg(DISTINCT r.root) AS location_ids
       FROM subscriptions s
       JOIN telegram_users u ON u.chat_id = s.chat_id
       JOIN related_locations_by_root r ON r.id = s.location_id
      WHERE s.enabled = true AND u.enabled = true AND s.notify_threats = true
      GROUP BY s.chat_id`,
    [locationIds]
  );

  const byId = new Map(summaries.map((summary) => [summary.locationId, summary]));
  let chats = 0;
  for (const row of subscribers.rows) {
    // Читачеві показуються лише ті місця, які він насправді просив: перетин його підписок із тим, що
    // сталося. Той самий принцип, що й `scopeToSubscription` у фан-ауті загроз — підписаний на Київ
    // не має читати про сім областей, у яких тієї ночі теж було гучно.
    const mine = (row.location_ids ?? []).map((id) => byId.get(id)).filter(Boolean) as DowntimeLocationSummary[];
    if (!mine.length) continue;
    const chosen = mine
      .sort((left, right) => right.messages - left.messages)
      .slice(0, MAX_LOCATIONS_PER_CHAT);
    const from = chosen.reduce((earliest, item) => (item.firstAt < earliest ? item.firstAt : earliest), chosen[0]!.firstAt);
    const to = chosen.reduce((latest, item) => (item.lastAt > latest ? item.lastAt : latest), chosen[0]!.lastAt);
    const inserted = await pool.query(
      `INSERT INTO notification_outbox(chat_id,notification_type,idempotency_key,priority,payload)
       VALUES ($1,'downtime_digest',$2,4,$3::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [row.chat_id, `downtime:${to.getTime()}:${row.chat_id}`, JSON.stringify({
        from: from.toISOString(), to: to.toISOString(),
        silent: true,
        locations: chosen.map((summary) => ({
          locationName: summary.locationName, messages: summary.messages, classes: summary.classes,
          line: downtimeLine(summary)
        })),
        omitted: Math.max(0, mine.length - chosen.length)
      })]
    );
    if (inserted.rowCount) chats += 1;
  }
  downtimeDigests.inc({ outcome: chats ? 'queued' : 'nothing' }, 1);
  return { chats, locations: summaries.length, contextMessages };
}
