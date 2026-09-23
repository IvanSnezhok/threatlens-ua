import { createHash } from 'node:crypto';
import { Counter, type Registry } from 'prom-client';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { forecastLexeme } from '../domain/forecast-guard.js';
import { THREAT_LABELS } from '../domain/model-place.js';
import { describeAge } from '../domain/threat-timing.js';
import { groundedNumbers, ungroundedNumber } from './analytics-narrative.js';
import {
  codexChat, writeAiRun, type AiRunRecord, type CodexChatRequest, type CodexChatResult
} from './codex-client.js';
import { codexFeatureEnabled, readCodexSettings } from './codex-settings.js';

/**
 * Актуалізація треку загрози: де ціль ЗАРАЗ (міграція 055, `codex_settings.actualization_enabled`).
 *
 * ================================================================================================
 * Навіщо, коли детермінований трек уже є
 * ================================================================================================
 *
 * Детермінований трек (`./threat-vectors.ts`) бачить кожне повідомлення окремо: які місця каталог
 * у ньому прочитав, у якому порядку й наскільки воно старе. Чого він не бачить — сенсу МІЖ
 * повідомленнями: що «мінус» у пʼятому закрив ціль із третього, що «кружляє над Білою Церквою» —
 * петля, а не новий курс, що після «повз Бровари» Бровари — вже історія. Швидка модель перечитує
 * останні повідомлення живої події й відповідає рівно на це: чи рухається ціль, кружляє, минула чи
 * зникла; де голова, куди курс, звідки прийшла; з якого повідомлення починається поточний відрізок.
 *
 * ================================================================================================
 * Межі, які тримає конструкція, а не домовленість
 * ================================================================================================
 *
 *  - Право — лише форма НАМАЛЬОВАНОГО треку. Рядок `threat_track_actualizations` не створює, не
 *    завершує й не зливає подій, не торкається тривог і ніколи не є відбоєм: його читає лише
 *    `./threat-vectors.ts`, і лише щоб вирішити, які з уже названих джерелами місць показати.
 *  - Модель посилається на місце лише через id, які їй дали. Кожен `*PlaceId` звіряється з місцями
 *    вхідних повідомлень, курс — лише з місцями, які джерело назвало напрямком, `currentSince` — лише
 *    з часом публікації вхідного повідомлення. Одне порушення — рядок не пишеться, а в `ai_runs`
 *    лягає `rejected` з причиною.
 *  - `summary` — публічний текст, тож він іде під ті самі сторожі, що й коментар тактики: жодного
 *    числа, якого не назвало джерело (`ungroundedNumber`), жодного слова прогнозу
 *    (`src/domain/forecast-guard.ts`).
 *  - На публічну карту рядок потрапляє лише в режимі `classifier_mode='codex'` з увімкненим
 *    перемикачем ({@link actualizationApplies}); поріг упевненості (0,6) і «бачив найновішу
 *    класифікацію події» перевіряє `./threat-vectors.ts`, тож рядок із низькою впевненістю тут
 *    записується як є. У режимі `rules` воркер може працювати тінню: рядки пишуться, карта їх не читає.
 *  - Кожен збій — вимкнений перемикач, бюджет, таймаут, відмова, непридатна відповідь — означає
 *    детермінований трек. Вектор ніколи не залежить від моделі.
 */

export const ACTUALIZATION_PROMPT_VERSION = 'actualization-v1';

export const TRACK_STATUSES = ['moving', 'loitering', 'passed', 'ended', 'unclear'] as const;
export type TrackStatus = (typeof TRACK_STATUSES)[number];

export interface TrackActualization {
  eventId: string; asOf: string; createdAt: string; model: string; status: TrackStatus;
  headLocationId: string | null; headingLocationId: string | null; originLocationId: string | null;
  loiterLocationId: string | null; currentSince: string | null; summary: string | null; confidence: number;
}

/** Тік воркера. Чверть хвилини — темп, з яким канали дописують трек під час атаки. */
const TICK_MS = 15_000;
/** Подій на один тік і одночасних викликів у ньому: шість за тік — це 24 на хвилину, під бюджетом. */
const MAX_PER_TICK = 6;
const CONCURRENCY = 2;
/** Скільки кандидатів читати, щоб пам'ять повторів (нижче) не з'їла всі шість місць тіку. */
const CANDIDATE_LIMIT = 24;
const MESSAGES_PER_EVENT = 12;
const TEXT_CHARS = 300;
/**
 * Найдовший горизонт треку (БпЛА, 25 хв) із запасом. Голову, старшу за горизонт, карта не малює
 * взагалі, тож актуалізувати таку подію — витратити виклик на трек, якого ніхто не побачить.
 */
const LIVE_LOOKBACK_MINUTES = 30;
/**
 * Та сама подія з тим самим найновішим повідомленням після відмови чи збою питається знову не
 * раніше, ніж за дві хвилини: нове повідомлення все одно знімає цю паузу, а без неї непридатна
 * відповідь на тихий трек коштувала б виклик кожні пʼятнадцять секунд.
 */
const RETRY_AFTER_MS = 2 * 60_000;
const RETENTION_DAYS = 7;

// ------------------------------------------------------------------------------------------------
// Метрики
// ------------------------------------------------------------------------------------------------

export type ActualizationOutcome = 'stored' | 'rejected' | 'failed' | 'skipped_budget';

export const trackActualizations = new Counter({
  name: 'threatlens_track_actualizations_total',
  help: 'Track actualization outcomes: stored, rejected by validation, failed call, or skipped over the per-minute budget',
  labelNames: ['outcome'],
  registers: []
});

export function registerTrackActualizationMetrics(registry: Registry): void {
  if (!registry.getSingleMetric('threatlens_track_actualizations_total')) registry.registerMetric(trackActualizations);
}

// ------------------------------------------------------------------------------------------------
// Бюджет і пам'ять повторів — обидва обмежені за побудовою
// ------------------------------------------------------------------------------------------------

let minuteWindow: number[] = [];
/** Остання непридатна спроба на подію: не більше подій, ніж пройшло через тіки за дві хвилини. */
const attempted = new Map<string, { asOfMs: number; atMs: number }>();

function withinMinuteBudget(nowMs: number): boolean {
  minuteWindow = minuteWindow.filter((at) => nowMs - at < 60_000);
  if (minuteWindow.length >= config.ACTUALIZATION_MAX_PER_MINUTE) return false;
  minuteWindow.push(nowMs);
  return true;
}

/** Тестовий шов: бюджет і пам'ять повторів — стан модуля, який TRUNCATE не скидає. */
export function resetTrackActualization(): void {
  minuteWindow = [];
  attempted.clear();
}

// ------------------------------------------------------------------------------------------------
// Вхід і відповідь моделі
// ------------------------------------------------------------------------------------------------

export interface ActualizationPlace {
  id: string; name: string; type: string; relation: string | null; role: 'asserted' | 'retracted';
}

export interface ActualizationMessage {
  publishedAt: Date; channel: string; text: string; places: ActualizationPlace[];
}

/** Останні класифікації однієї події, від найстарішої до найновішої. */
export interface ActualizationInput {
  eventId: string; threatType: string; messages: ActualizationMessage[];
}

/** Порожній рядок — те саме, що null: модель пише «нічого» обома способами. */
const optionalText = (max: number) => z.string().trim().max(max).nullable().default(null)
  .transform((value) => value || null);

export const actualizationReplySchema = z.object({
  status: z.enum(TRACK_STATUSES),
  headPlaceId: optionalText(120),
  headingPlaceId: optionalText(120),
  originPlaceId: optionalText(120),
  loiterPlaceId: optionalText(120),
  currentSince: optionalText(64),
  summary: optionalText(160),
  confidence: z.number().min(0).max(1)
});

export interface ValidatedActualization {
  status: TrackStatus;
  headLocationId: string | null;
  headingLocationId: string | null;
  originLocationId: string | null;
  loiterLocationId: string | null;
  /** Точний `published_at` вхідного повідомлення, на яке послалася модель, а не її рядок. */
  currentSince: Date | null;
  summary: string | null;
  confidence: number;
}

export type ActualizationCheck = { ok: true; value: ValidatedActualization } | { ok: false; reason: string };

/**
 * Відповідь моделі — або причина, чому її не можна записати. Чиста: жодної бази, жодного годинника.
 *
 * Упевненість тут НЕ порогується: рядок із 0,2 записується як є, а поріг карти (0,6) застосовує
 * `./threat-vectors.ts`. Так оператор бачить у таблиці, наскільки модель вагалася, а не лише те,
 * що пройшло.
 */
export function validateActualization(content: string, input: ActualizationInput): ActualizationCheck {
  let reply: z.infer<typeof actualizationReplySchema>;
  try {
    reply = actualizationReplySchema.parse(JSON.parse(content) as unknown);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof z.ZodError
        ? `schema:${error.issues.map((issue) => issue.path.join('.')).join(',')}`
        : 'unparsable'
    };
  }
  const places = input.messages.flatMap((message) => message.places);
  const named = new Set(places.map((place) => place.id));
  const referenced = [
    ['headPlaceId', reply.headPlaceId], ['headingPlaceId', reply.headingPlaceId],
    ['originPlaceId', reply.originPlaceId], ['loiterPlaceId', reply.loiterPlaceId]
  ] as const;
  for (const [field, id] of referenced) {
    if (id !== null && !named.has(id)) return { ok: false, reason: `unknown_place:${field}:${id}` };
  }
  // Курс — лише туди, куди його назвало джерело. Місце, що просто згадане чи пройдене, курсом не є:
  // стрілка на карті — це твердження про рух, і вона мусить мати за собою чиєсь слово.
  if (reply.headingPlaceId !== null && !places.some((place) =>
    place.id === reply.headingPlaceId && place.role === 'asserted' && place.relation === 'reported_direction')) {
    return { ok: false, reason: `heading_not_named_destination:${reply.headingPlaceId}` };
  }
  let currentSince: Date | null = null;
  if (reply.currentSince !== null) {
    // За миттю, а не за рядком: модель може переписати той самий момент у UTC. Секундна точність —
    // бо з такою точністю момент їй і показано.
    const at = Date.parse(reply.currentSince);
    const match = Number.isNaN(at) ? undefined : input.messages.find((message) =>
      Math.floor(message.publishedAt.getTime() / 1000) === Math.floor(at / 1000));
    if (!match) return { ok: false, reason: 'current_since_not_in_input' };
    currentSince = match.publishedAt;
  }
  if (reply.summary !== null) {
    const forecast = forecastLexeme(reply.summary);
    if (forecast) return { ok: false, reason: `forecast_lexeme:${forecast}` };
    // Числа лише з ТЕКСТІВ джерел, а не з усього входу: інакше дата й година публікації дозволили б
    // моделі написати час, якого жоден канал не називав.
    const invented = ungroundedNumber(reply.summary, groundedNumbers(input.messages.map((message) => message.text)));
    if (invented) return { ok: false, reason: `ungrounded_number:${invented}` };
  }
  return {
    ok: true,
    value: {
      status: reply.status,
      headLocationId: reply.headPlaceId,
      headingLocationId: reply.headingPlaceId,
      originLocationId: reply.originPlaceId,
      loiterLocationId: reply.loiterPlaceId,
      currentSince,
      summary: reply.summary,
      confidence: reply.confidence
    }
  };
}

/**
 * Київський момент у формі ISO з поясом — «2026-09-23T01:40:12+03:00».
 *
 * Один годинник на все: `now` і кожне `publishedAt` у тому самому поясі, в якому канали пишуть
 * «о 01:40», тож моделі не треба переводити UTC. І точний до секунди, бо `currentSince` модель має
 * повернути ДОСЛІВНО одним із цих значень, а хвилинна мітка зробила б два повідомлення тієї самої
 * хвилини нерозрізненними.
 */
function kyivStamper(): (at: Date) => string {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset'
  });
  return (at) => {
    const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
    for (const part of format.formatToParts(at)) parts[part.type] = part.value;
    const offset = /GMT([+-]\d{2}:\d{2})/u.exec(parts.timeZoneName ?? '')?.[1] ?? '+00:00';
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
  };
}

/** Те, що бачить модель. Експортовано, щоб тести бачили той самий вхід, що й виклик. */
export function actualizationFacts(input: ActualizationInput, now: Date) {
  const stamp = kyivStamper();
  return {
    now: stamp(now),
    threatType: input.threatType,
    threatLabel: THREAT_LABELS[input.threatType as keyof typeof THREAT_LABELS] ?? null,
    messages: input.messages.map((message) => ({
      publishedAt: stamp(message.publishedAt),
      age: describeAge(message.publishedAt, now),
      channel: message.channel,
      text: message.text,
      places: message.places
    }))
  };
}

const SYSTEM_PROMPT = [
  'Ти актуалізуєш трек ОДНІЄЇ повітряної загрози в Україні для публічної карти: за повідомленнями джерел кажеш, де ціль зараз, звідки вона прийшла й куди прямує.',
  'Тобі дано поточний київський час (now), клас загрози й до 12 останніх повідомлень про цю подію від найстарішого до найновішого: час публікації (publishedAt), вік, канал, текст і місця, які каталог розпізнав у повідомленні.',
  'Кожне місце має id, назву, тип, relation і role. relation=reported_direction — джерело назвало місце напрямком або метою руху; explicit_threat — загроза для місця; mentioned — згадка; aftermath — наслідки. role=retracted — місце, яке ціль, за словами джерела, минула («повз») або звідки пішла: це історія, а не поточне положення.',
  'Посилайся на місця ЛИШЕ через їхні id із вхідних даних. Не вигадуй місць, не підставляй сусідніх і не пиши назв замість id.',
  'status: moving — ціль рухається; loitering — кружляє над місцем або тримається біля нього; passed — минула названі місця, а нового не названо; ended — джерело повідомило, що ціль збито, «мінус» або вона зникла; unclear — із повідомлень цього не встановити.',
  'headPlaceId — де ціль зараз за найсвіжішими повідомленнями; headingPlaceId — куди прямує, ЛИШЕ місце з relation=reported_direction, інакше null; originPlaceId — звідки прийшла; loiterPlaceId — над чим кружляє, лише коли status=loitering. Невідоме — null.',
  'currentSince — publishedAt повідомлення, з якого починається поточний відрізок треку; усе раніше — історія. Скопіюй значення дослівно з вхідних даних або постав null.',
  'summary — до 160 символів українською: що летить, звідки, де зараз, куди прямує. Жодних чисел, крім кількостей, які назвало саме джерело; жодних прогнозів, цілей удару, влучань, швидкостей чи часу прибуття.',
  'Ти не оголошуєш тривог і відбоїв і нічого не вирішуєш про саму загрозу: лише описуєш трек за тим, що написали джерела.',
  'confidence — твоя впевненість у всій відповіді від 0 до 1; старі чи суперечливі повідомлення — нижча впевненість.',
  'Поверни лише JSON: {"status": "moving"|"loitering"|"passed"|"ended"|"unclear", "headPlaceId": string|null, "headingPlaceId": string|null, "originPlaceId": string|null, "loiterPlaceId": string|null, "currentSince": string|null, "summary": string|null, "confidence": number}.'
].join(' ');

// ------------------------------------------------------------------------------------------------
// Читання
// ------------------------------------------------------------------------------------------------

interface CandidateRow { id: string; threat_type: string; newest_at: Date }

/**
 * Живі події з принаймні двома класифікаціями, чия найновіша класифікація новіша за останню
 * актуалізацію, — найсвіжіші першими.
 *
 * `threat_events_live_idx (status, last_observed_at DESC)` звужує до подій останніх тридцяти хвилин;
 * обидва LATERAL — одна проба `message_classifications_event_idx` і одна
 * `threat_track_actualizations_event_idx` на подію. «Остання актуалізація» — за `created_at`, тим
 * самим порядком, яким {@link latestActualizations} віддає її карті.
 */
const CANDIDATES_SQL = `
  SELECT e.id, e.threat_type, c.newest_at
    FROM threat_events e
    CROSS JOIN LATERAL (
      SELECT max(mc.published_at) AS newest_at, count(*) AS classifications
        FROM message_classifications mc WHERE mc.event_id = e.id
    ) c
    LEFT JOIN LATERAL (
      SELECT a.as_of FROM threat_track_actualizations a
       WHERE a.event_id = e.id ORDER BY a.created_at DESC LIMIT 1
    ) latest ON true
   WHERE e.status IN ('observed','confirmed','active')
     AND e.timing = 'now'
     AND e.last_observed_at > $1::timestamptz - make_interval(mins => $2::int)
     AND (e.valid_until IS NULL OR e.valid_until > $1::timestamptz)
     AND c.classifications >= 2
     AND c.newest_at > $1::timestamptz - make_interval(mins => $2::int)
     AND (latest.as_of IS NULL OR c.newest_at > latest.as_of)
   ORDER BY c.newest_at DESC
   LIMIT $3`;

interface InputRow {
  event_id: string; published_at: Date; channel: string; raw_text: string | null; places: ActualizationPlace[];
}

/**
 * Останні дванадцять класифікацій кожної обраної події одним запитом. Місця всередині
 * повідомлення впорядковані за роллю й id: від порядку залежить `input_digest`, і той самий вхід
 * мусить давати той самий відбиток.
 */
const INPUTS_SQL = `
  WITH recent AS (
    SELECT mc.id, mc.event_id, mc.published_at, mc.source_id, mc.source_message_id,
           row_number() OVER (PARTITION BY mc.event_id ORDER BY mc.published_at DESC, mc.id DESC) AS rn
      FROM message_classifications mc
     WHERE mc.event_id = ANY($1::uuid[])
  )
  SELECT r.event_id, r.published_at, s.name AS channel, sm.raw_text,
         COALESCE(jsonb_agg(jsonb_build_object(
           'id', l.id, 'name', l.name_uk, 'type', l.type, 'relation', mcl.relation_type, 'role', mcl.role
         ) ORDER BY mcl.role, mcl.location_id) FILTER (WHERE l.id IS NOT NULL), '[]') AS places
    FROM recent r
    JOIN sources s ON s.id = r.source_id
    LEFT JOIN source_messages sm ON sm.id = r.source_message_id
    LEFT JOIN message_classification_locations mcl ON mcl.classification_id = r.id
    LEFT JOIN locations l ON l.id = mcl.location_id
   WHERE r.rn <= $2
   GROUP BY r.id, r.event_id, r.published_at, s.name, sm.raw_text
   ORDER BY r.event_id, r.published_at, r.id`;

async function loadInputs(candidates: readonly CandidateRow[]): Promise<ActualizationInput[]> {
  const result = await pool.query<InputRow>(INPUTS_SQL, [candidates.map((candidate) => candidate.id), MESSAGES_PER_EVENT]);
  const byEvent = new Map<string, ActualizationMessage[]>();
  for (const row of result.rows) {
    const messages = byEvent.get(row.event_id) ?? [];
    messages.push({
      publishedAt: row.published_at,
      channel: row.channel,
      text: (row.raw_text ?? '').replace(/\s+/gu, ' ').trim().slice(0, TEXT_CHARS),
      places: row.places
    });
    byEvent.set(row.event_id, messages);
  }
  return candidates.map((candidate) => ({
    eventId: candidate.id, threatType: candidate.threat_type, messages: byEvent.get(candidate.id) ?? []
  }));
}

interface ActualizationRow {
  event_id: string; as_of: Date; created_at: Date; model: string; status: TrackStatus;
  head_location_id: string | null; heading_location_id: string | null; origin_location_id: string | null;
  loiter_location_id: string | null; current_since: Date | null; summary: string | null; confidence: number;
}

/**
 * Latest row per event. One indexed query; no model call.
 *
 * Returned as stored — the 0.6 confidence floor and the «saw the newest classification» rule belong
 * to the map (`./threat-vectors.ts`). Never throws: an unreadable table is an empty map, and an empty
 * map is the deterministic track for every event, which is what any failure here must mean.
 */
export async function latestActualizations(eventIds: readonly string[]): Promise<Map<string, TrackActualization>> {
  const latest = new Map<string, TrackActualization>();
  if (!eventIds.length) return latest;
  try {
    // LATERAL на кожну подію, а не DISTINCT ON по всіх її рядках: одна проба індексу
    // `(event_id, created_at DESC)` з LIMIT 1, хоч би скільки рядків подія назбирала.
    const result = await pool.query<ActualizationRow>(
      `SELECT a.* FROM unnest($1::uuid[]) AS wanted(event_id)
         CROSS JOIN LATERAL (
           SELECT t.event_id, t.as_of, t.created_at, t.model, t.status, t.head_location_id,
                  t.heading_location_id, t.origin_location_id, t.loiter_location_id, t.current_since,
                  t.summary, t.confidence
             FROM threat_track_actualizations t
            WHERE t.event_id = wanted.event_id
            ORDER BY t.created_at DESC LIMIT 1
         ) a`,
      [[...new Set(eventIds)]]
    );
    for (const row of result.rows) {
      latest.set(row.event_id, {
        eventId: row.event_id,
        asOf: row.as_of.toISOString(),
        createdAt: row.created_at.toISOString(),
        model: row.model,
        status: row.status,
        headLocationId: row.head_location_id,
        headingLocationId: row.heading_location_id,
        originLocationId: row.origin_location_id,
        loiterLocationId: row.loiter_location_id,
        currentSince: row.current_since?.toISOString() ?? null,
        summary: row.summary,
        confidence: Number(row.confidence)
      });
    }
  } catch {
    latest.clear();
  }
  return latest;
}

/**
 * Whether the public map may use actualizations now: classifier_mode==='codex' && feature
 * 'actualization' on. Errors → false.
 *
 * Обидві умови з ОДНОГО читання рядка налаштувань, а не з двох: перемикач і режим, прочитані в різні
 * моменти, могли б дати комбінацію, якої оператор ніколи не бачив на екрані.
 */
export async function actualizationApplies(): Promise<boolean> {
  try {
    const settings = await readCodexSettings();
    return settings.classifierMode === 'codex' && settings.features.actualization;
  } catch {
    return false;
  }
}

/** Ретенція: сім діб — досить, щоб розібрати ніч, і мало, щоб таблиця не росла без меж. */
export async function pruneTrackActualizations(days = RETENTION_DAYS): Promise<number> {
  const result = await pool.query(
    `DELETE FROM threat_track_actualizations WHERE created_at < now() - make_interval(days => $1::int)`, [days]
  );
  return result.rowCount ?? 0;
}

// ------------------------------------------------------------------------------------------------
// Прохід
// ------------------------------------------------------------------------------------------------

export interface ActualizationDeps {
  chat?: (request: CodexChatRequest) => Promise<CodexChatResult>;
  /** Рядок `rejected` в `ai_runs`. Типово — той самий запис, що й транспортний рядок `codexChat`. */
  audit?: (row: AiRunRecord) => Promise<void>;
  now?: () => Date;
}

export interface ActualizationPass {
  enabled: boolean;
  stored: number;
  rejected: number;
  failed: number;
  skippedBudget: number;
}

/**
 * Один тік: до шести подій, по дві одночасно. Ніколи не кидає через модель — лише через базу, яку
 * ловить воркер; кожна подія, що не отримала рядка, лишається на детермінованому треку.
 */
export async function runTrackActualization(deps: ActualizationDeps = {}): Promise<ActualizationPass> {
  const pass: ActualizationPass = { enabled: false, stored: 0, rejected: 0, failed: 0, skippedBudget: 0 };
  if (!(await codexFeatureEnabled('actualization'))) return pass;
  pass.enabled = true;

  const now = deps.now?.() ?? new Date();
  const chat = deps.chat ?? ((request: CodexChatRequest) => codexChat(request));
  const audit = deps.audit ?? writeAiRun;
  const wallMs = Date.now();
  for (const [eventId, attempt] of attempted) if (wallMs - attempt.atMs >= RETRY_AFTER_MS) attempted.delete(eventId);

  const candidates = (await pool.query<CandidateRow>(CANDIDATES_SQL, [now, LIVE_LOOKBACK_MINUTES, CANDIDATE_LIMIT])).rows
    .filter((candidate) => attempted.get(candidate.id)?.asOfMs !== candidate.newest_at.getTime())
    .slice(0, MAX_PER_TICK);
  if (!candidates.length) return pass;

  const inputs = (await loadInputs(candidates)).filter((input) => input.messages.length >= 2);
  if (!inputs.length) return pass;
  // Відбиток того, що модель прочитає, БЕЗ поточного часу: `now` міняється щотіку, і з ним у відбитку
  // незмінний вхід щоразу виглядав би новим.
  const digests = new Map(inputs.map((input) => [input.eventId, createHash('sha256').update(JSON.stringify({
    threatType: input.threatType,
    messages: input.messages.map((message) => ({ ...message, publishedAt: message.publishedAt.toISOString() }))
  })).digest('hex')]));
  const known = await pool.query<{ event_id: string; input_digest: string }>(
    `SELECT event_id, input_digest FROM threat_track_actualizations
      WHERE event_id = ANY($1::uuid[]) AND input_digest = ANY($2::text[])`,
    [[...digests.keys()], [...digests.values()]]
  );
  const seen = new Set(known.rows.map((row) => `${row.event_id}:${row.input_digest}`));
  const queue = inputs.filter((input) => !seen.has(`${input.eventId}:${digests.get(input.eventId)}`));

  const count = (outcome: ActualizationOutcome) => {
    trackActualizations.inc({ outcome });
    if (outcome === 'skipped_budget') pass.skippedBudget += 1; else pass[outcome] += 1;
  };

  const actualize = async (input: ActualizationInput): Promise<void> => {
    const inputDigest = digests.get(input.eventId)!;
    const asOf = input.messages.at(-1)!.publishedAt;
    const remember = () => attempted.set(input.eventId, { asOfMs: asOf.getTime(), atMs: Date.now() });
    if (!withinMinuteBudget(Date.now())) return count('skipped_budget');

    const facts = actualizationFacts(input, now);
    const result = await chat({
      promptVersion: ACTUALIZATION_PROMPT_VERSION,
      surface: 'actualization',
      tier: 'fast',
      system: SYSTEM_PROMPT,
      user: JSON.stringify(facts),
      json: true,
      timeoutMs: config.ACTUALIZATION_TIMEOUT_MS,
      // Транспортний рядок пишеться на кожен виклик, тож він тримає те, що ВПІЗНАЄ вхід — id, ролі,
      // час і відбиток, — а не тексти: ті лежать у `source_messages`, а `ai_runs` не має ретенції.
      // Повний вхід іде лише в рядок відмови нижче — той, який оператор відкриває, щоб зрозуміти чому.
      auditInput: {
        eventId: input.eventId, asOf: asOf.toISOString(), inputDigest, threatType: input.threatType,
        messages: input.messages.map((message) => ({
          publishedAt: message.publishedAt.toISOString(), channel: message.channel,
          places: message.places.map(({ id, relation, role }) => ({ id, relation, role }))
        }))
      }
    }).catch((error: unknown): CodexChatResult => ({
      ok: false, reason: 'transport_error', detail: String(error).slice(0, 200), model: null, durationMs: 0
    }));
    if (!result.ok) {
      remember();
      return count('failed');
    }

    const check = validateActualization(result.content, input);
    if (!check.ok) {
      await audit({
        model: result.model, promptVersion: ACTUALIZATION_PROMPT_VERSION,
        input: { eventId: input.eventId, asOf: asOf.toISOString(), inputDigest, ...facts },
        output: { content: result.content }, status: 'failed', error: `rejected: ${check.reason}`,
        durationMs: result.durationMs, surface: 'actualization', classifierVersion: null,
        validationStatus: 'rejected', fallbackReason: check.reason
      }).catch(() => undefined);
      remember();
      return count('rejected');
    }

    const value = check.value;
    try {
      await pool.query(
        `INSERT INTO threat_track_actualizations(event_id,as_of,model,status,head_location_id,heading_location_id,
           origin_location_id,loiter_location_id,current_since,summary,confidence,input_digest)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (event_id, input_digest) DO NOTHING`,
        [input.eventId, asOf, result.model, value.status, value.headLocationId, value.headingLocationId,
          value.originLocationId, value.loiterLocationId, value.currentSince, value.summary, value.confidence,
          inputDigest]
      );
      count('stored');
    } catch {
      // Подію могли щойно видалити або місце — прибрати з каталогу (FK). Трек лишається детермінованим.
      remember();
      count('failed');
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let input = queue.shift(); input; input = queue.shift()) await actualize(input);
  }));
  return pass;
}

/**
 * Воркер: тік кожні п'ятнадцять секунд, без накладання тіків. З вимкненим перемикачем тік читає
 * один рядок налаштувань і виходить.
 */
export function startTrackActualizationWorker(log: { info: Function; error: Function }): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const pass = await runTrackActualization();
      // Записані рядки видно на метриці; у журнал — лише те, що пішло не так, щоб ніч атаки не
      // перетворилася на чотири рядки журналу щохвилини.
      if (pass.rejected || pass.failed || pass.skippedBudget) log.info({ ...pass }, 'track actualization pass');
    } catch (error) {
      log.error({ error }, 'track actualization pass failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
