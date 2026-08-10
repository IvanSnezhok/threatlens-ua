import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { pool } from '../db/pool.js';
import { hasValidOpsAuth, opsUnauthorized } from './ops-auth.js';

/**
 * Покриття по областях — зведення, якого в схемі немає.
 *
 * Продуктова потреба звучить як «зведення та інформація по областях з усіх каналів для оцінки
 * загроз». Перше, що з'ясовується при спробі її виконати: **таблиці, яка приписує джерело до
 * області, у схемі не існує**. `sources` не має жодної географічної колонки; `source_messages` теж;
 * `recommended_telegram_channels` (міграція 005, названа `territory_channels`) має `location_id`,
 * але це редакційний список «що порадити читачеві», без зовнішнього ключа на `sources` і з двома
 * рядками, в обох `location_id IS NULL`. Область, яку обслуговує канал, живе лише як підрядок у
 * `sources.name` та `independence_group` (`gov-kherson-oda`, `osint-sumyregion`) і як проза в
 * коментарях міграції 013.
 *
 * Тому покриття тут ВИВЕДЕНЕ, а не оголошене, і ендпоінт каже про це вголос у `notice`. Джерело
 * покриває область, якщо у вікні спостереження воно або поставило в неї хоча б одне класифіковане
 * повідомлення (`message_classifications` → `message_classification_locations`, роль `asserted`),
 * або тримає в ній стан офіційної тривоги (`alert_source_states`). Обидва сигнали — це
 * зафіксована поведінка, а не намір: канал, який ніколи не писав про Волинь, у цій відомості
 * Волині й не покриває, і це та сама правда, яку побачив би оператор, гортаючи стрічку.
 *
 * Наслідок, який треба читати саме так: нуль у колонці «канали» означає «за вікно жодне джерело
 * сюди нічого не поставило», а не «область не обслуговується». Для оператора це однаково є
 * знахідкою — саме такі області міграція 013 перелічує як прогалини каталогу.
 *
 * Рядок «Загальнодержавні» (`locations.id = 'ua'`) збирає те, що не має обласної прив'язки:
 * `national_scope` класифікації та все, що піднялося по ієрархії до країни. Без нього
 * загальнонаціональні канали або зникали б із відомості, або розмазувалися б по всіх 27 рядках.
 *
 * Тільки читання. Жодного POST: це відомість, а не орган керування.
 */

/** Скільки днів дивимося назад, вирішуючи, що джерело «покриває» область. */
const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 30;

const NOTICE = 'Прив’язки джерела до області в схемі немає — покриття виведене зі спостереженої '
  + 'поведінки. Джерело вважається таким, що покриває область, якщо за вікно воно поставило в неї '
  + 'хоча б одне класифіковане повідомлення або тримає в ній стан офіційної тривоги. Нуль у '
  + 'колонці «канали» означає «за вікно сюди нічого не надійшло», а не «область не обслуговується». '
  + 'Повідомлення без обласної прив’язки та загальнодержавні зведено в рядок «Загальнодержавні».';

/**
 * Одним запитом, бо всі чотири числа мусять описувати той самий момент.
 *
 * `climb`/`oblast_of` — той самий підйом по ієрархії, що в `src/services/analytics-archive.ts`:
 * повідомлення називає громаду або місто, а відомість рахує області, тож кожну згадану локацію
 * треба підняти до найближчого предка рівня області. Засівається він РЕФЕРЕНСАМИ, а не всім
 * каталогом: після імпорту КАТОТТГ у `locations` десятки тисяч рядків, і підіймати їх усі
 * означало б рекурсію на порожньому місці.
 *
 * Згортання в `placed` навмисне: повідомлення, яке назвало три населені пункти однієї області, —
 * це одне повідомлення цієї області, а не три. З тієї ж причини ключем групування є
 * `source_message_id`, а не `message_classifications.id`: тіньова класифікація дає другий рядок на
 * те саме повідомлення, і без цього ввімкнення тіньового класифікатора подвоїло б трафік кожної
 * області. Групування, а не `UNION`-дедуплікація, — бо `published_at` у двох класифікацій того
 * самого повідомлення збігається лише за домовленістю, і `UNION` розійшовся б на мілісекунді.
 *
 * `national_scope` зараховується в «Загальнодержавні» ЛИШЕ коли жодної обласної прив'язки немає:
 * інакше одне повідомлення потрапило б і в область, і в підсумок країни, і сума по рядках
 * перестала б бути сумою.
 */
const COVERAGE_SQL = `
WITH RECURSIVE seed AS (
  SELECT DISTINCT location_id FROM (
    SELECT cl.location_id
      FROM message_classifications mc
      JOIN message_classification_locations cl
        ON cl.classification_id = mc.id AND cl.role = 'asserted'
     WHERE mc.published_at >= now() - ($1::int * interval '1 day')
    UNION ALL
    SELECT ass.location_id FROM alert_source_states ass
    UNION ALL
    SELECT ap.location_id FROM alert_periods ap WHERE ap.status = 'active'
    UNION ALL
    SELECT el.location_id
      FROM threat_event_locations el
      JOIN threat_events e ON e.id = el.event_id
     WHERE e.status IN ('observed','confirmed','active')
       AND e.last_observed_at > now() - interval '12 hours'
  ) referenced
),
climb(location_id, node_id, node_type, depth, path) AS (
    SELECT s.location_id, l.id, l.type, 0, ARRAY[l.id]
      FROM seed s JOIN locations l ON l.id = s.location_id
  UNION ALL
    SELECT c.location_id, parent.id, parent.type, c.depth + 1, c.path || parent.id
      FROM climb c
      JOIN locations child  ON child.id  = c.node_id
      JOIN locations parent ON parent.id = child.parent_id
     WHERE c.depth < 8 AND NOT (parent.id = ANY(c.path))
),
oblast_of AS (
  SELECT DISTINCT ON (location_id) location_id, node_id AS oblast_id
    FROM climb
   WHERE node_type IN ('oblast','special_city','country')
   ORDER BY location_id, depth
),
regions AS (
  SELECT id, name_uk, type FROM locations WHERE type IN ('oblast','special_city') OR id = 'ua'
),
covering AS (
  SELECT o.oblast_id, mc.source_id
    FROM message_classifications mc
    JOIN message_classification_locations cl
      ON cl.classification_id = mc.id AND cl.role = 'asserted'
    JOIN oblast_of o ON o.location_id = cl.location_id
   WHERE mc.published_at >= now() - ($1::int * interval '1 day')
  UNION
  SELECT 'ua', mc.source_id
    FROM message_classifications mc
   WHERE mc.national_scope AND mc.published_at >= now() - ($1::int * interval '1 day')
     AND NOT EXISTS (
       SELECT 1 FROM message_classification_locations cl
        WHERE cl.classification_id = mc.id AND cl.role = 'asserted')
  UNION
  SELECT o.oblast_id, ass.source_id
    FROM alert_source_states ass
    JOIN oblast_of o ON o.location_id = ass.location_id
),
coverage AS (
  SELECT c.oblast_id,
         count(*) FILTER (WHERE s.enabled)::int     AS sources_enabled,
         count(*) FILTER (WHERE NOT s.enabled)::int AS sources_disabled
    FROM covering c JOIN sources s ON s.id = c.source_id
   GROUP BY 1
),
placed AS (
  SELECT oblast_id, source_message_id, max(published_at) AS published_at
    FROM (
      SELECT o.oblast_id, mc.source_message_id, mc.published_at
        FROM message_classifications mc
        JOIN message_classification_locations cl
          ON cl.classification_id = mc.id AND cl.role = 'asserted'
        JOIN oblast_of o ON o.location_id = cl.location_id
       WHERE mc.published_at >= now() - ($1::int * interval '1 day')
      UNION ALL
      SELECT 'ua', mc.source_message_id, mc.published_at
        FROM message_classifications mc
       WHERE mc.national_scope AND mc.published_at >= now() - ($1::int * interval '1 day')
         AND NOT EXISTS (
           SELECT 1 FROM message_classification_locations cl
            WHERE cl.classification_id = mc.id AND cl.role = 'asserted')
    ) hits
   GROUP BY 1, 2
),
messages AS (
  SELECT oblast_id,
         count(*) FILTER (WHERE published_at >= now() - interval '1 hour')::int AS messages_hour,
         count(*)::int    AS messages_window,
         max(published_at) AS last_message_at
    FROM placed GROUP BY 1
),
alerts AS (
  SELECT o.oblast_id, count(DISTINCT ap.id)::int AS active_alerts
    FROM alert_periods ap JOIN oblast_of o ON o.location_id = ap.location_id
   WHERE ap.status = 'active'
   GROUP BY 1
),
threats AS (
  SELECT o.oblast_id, count(DISTINCT e.id)::int AS active_threats
    FROM threat_events e
    JOIN threat_event_locations el ON el.event_id = e.id
    JOIN oblast_of o ON o.location_id = el.location_id
   WHERE e.status IN ('observed','confirmed','active')
     AND e.last_observed_at > now() - interval '12 hours'
   GROUP BY 1
)
SELECT r.id, r.name_uk, r.type,
       COALESCE(c.sources_enabled, 0)  AS sources_enabled,
       COALESCE(c.sources_disabled, 0) AS sources_disabled,
       COALESCE(m.messages_hour, 0)    AS messages_hour,
       COALESCE(m.messages_window, 0)  AS messages_window,
       m.last_message_at,
       COALESCE(a.active_alerts, 0)    AS active_alerts,
       COALESCE(t.active_threats, 0)   AS active_threats
  FROM regions r
  LEFT JOIN coverage c ON c.oblast_id = r.id
  LEFT JOIN messages m ON m.oblast_id = r.id
  LEFT JOIN alerts   a ON a.oblast_id = r.id
  LEFT JOIN threats  t ON t.oblast_id = r.id
 ORDER BY (r.type = 'country'), r.id`;

export interface CoverageRow {
  locationId: string;
  name: string;
  kind: 'oblast' | 'special_city' | 'country';
  sourcesEnabled: number;
  sourcesDisabled: number;
  messagesLastHour: number;
  messagesWindow: number;
  lastMessageAt: string | null;
  activeAlerts: number;
  activeThreats: number;
}

function authorised(request: FastifyRequest): boolean {
  return hasValidOpsAuth(request.headers.authorization);
}

const opsCoverageRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { windowDays?: string } }>('/ops/api/coverage', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    const raw = request.query.windowDays;
    const windowDays = raw == null ? DEFAULT_WINDOW_DAYS : Number(raw);
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > MAX_WINDOW_DAYS) {
      return reply.code(400).send({ error: 'invalid_window_days' });
    }

    const result = await pool.query(COVERAGE_SQL, [windowDays]);
    const rows: CoverageRow[] = result.rows.map((row: any) => ({
      locationId: String(row.id),
      // Ім'я країни в цій відомості — не «Україна», а роль рядка: усе, що не має обласної
      // прив'язки. Підписати його «Україна» означало б поставити його в один ряд із областями.
      name: row.type === 'country' ? 'Загальнодержавні' : String(row.name_uk),
      kind: row.type,
      sourcesEnabled: Number(row.sources_enabled),
      sourcesDisabled: Number(row.sources_disabled),
      messagesLastHour: Number(row.messages_hour),
      messagesWindow: Number(row.messages_window),
      lastMessageAt: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
      activeAlerts: Number(row.active_alerts),
      activeThreats: Number(row.active_threats)
    }));

    const oblasts = rows.filter((row) => row.kind !== 'country');
    return {
      generatedAt: new Date().toISOString(),
      windowDays,
      derivation: 'observed' as const,
      notice: NOTICE,
      totals: {
        regions: oblasts.length,
        uncovered: oblasts.filter((row) => row.sourcesEnabled === 0).length,
        messagesLastHour: rows.reduce((sum, row) => sum + row.messagesLastHour, 0),
        activeAlerts: oblasts.filter((row) => row.activeAlerts > 0).length,
        activeThreats: rows.reduce((sum, row) => sum + row.activeThreats, 0)
      },
      rows
    };
  });
};

export default opsCoverageRoutes;
export { opsCoverageRoutes, COVERAGE_SQL, NOTICE, DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS };
