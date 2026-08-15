import { z } from 'zod';
import { pool } from '../db/pool.js';
import { firstForecastLexeme } from '../domain/forecast-guard.js';
import { codexChat } from './codex-client.js';
import { resolveCodexSettings } from './codex-settings.js';

/**
 * Одне узагальнення руху загрози з кількох каналів — і жодного слова понад те, що вони написали.
 *
 * ## Навіщо
 *
 * Читачі скаржаться на обсяг тексту. Причина не лише в переліку міст: одна загроза збирає п'ять-шість
 * повідомлень різних каналів, і кожне з них — окремий рядок «джерело сказало те, потім те». Людині
 * потрібен один абзац: звідки, куди, чим і хто це каже.
 *
 * `CONTEXT.md` дозволяє це прямо — «ШІ може допомагати з класифікацією або узагальненням, але не
 * визначає офіційний стан тривоги». Узагальнення нічого не створює й нічого не скасовує: воно
 * переказує вже зібране.
 *
 * ## Чому джерела обов'язкові
 *
 * Це не оформлення, а умова допуску тексту на екран. Модельний абзац без посилання на канал
 * неможливо перевірити — читач не знає, що з написаного є в джерелі, а що додала модель. Тому
 * відповідь без жодного впізнаного джерела ВІДХИЛЯЄТЬСЯ цілком, а не публікується без підпису.
 *
 * ## Що ще відхиляється
 *
 * Три перевірки, і кожна з них — про те, чого джерела не казали:
 *
 *  1. **Прогноз.** `firstForecastLexeme` ловить «ймовірно долетить», «очікується удар» — систему,
 *     яка не передбачає цілей, не можна змусити передбачати їх чужими словами.
 *  2. **Місце, якого немає у фактах.** Модель, що дописала сусіднє місто, створює загрозу, про яку
 *     не повідомляв ніхто.
 *  3. **Невпізнане джерело.** Назва каналу, якої немає серед переданих, — це або галюцинація, або
 *     переінакшена назва; обидва варіанти роблять посилання неперевірним.
 *
 * ## Що буває, коли модель мовчить
 *
 * Нічого. Повертається `null`, і сповіщення йде з детермінованим `summary`, як ішло досі. Виклик
 * моделі не стоїть на шляху попередження: текст — це поліпшення, а попередження — обов'язок.
 */

/** Скільки повідомлень каналів беремо в один переказ. */
const MAX_FACTS = 12;
/**
 * Стеля на текст, який модель має право написати.
 *
 * Скарга була на обсяг; узагальнення, довше за те, що воно замінює, лікувало б симптом навпаки.
 * Чотириста символів — це приблизно абзац у вікні телефона.
 */
const MAX_SUMMARY_CHARS = 400;

export interface MovementFact {
  /** Назва каналу, як її бачить читач. Саме її модель мусить назвати серед джерел. */
  sourceName: string;
  locationName: string;
  observedAt: string;
  text: string;
}

const summarySchema = z.object({
  summary: z.string().min(1),
  sources: z.array(z.string().min(1)).min(1)
});

export interface MovementSummary {
  summary: string;
  sources: string[];
}

/**
 * Повідомлення каналів, з яких склалася ця подія — найсвіжіші першими.
 *
 * Береться `raw_text`, обрізаний до трьохсот символів: моделі потрібне формулювання, а не весь пост
 * із хештегами й підписом каналу.
 */
export async function movementFacts(eventId: string, limit = MAX_FACTS): Promise<MovementFact[]> {
  const result = await pool.query<{
    source_name: string; location_name: string | null; published_at: Date; raw_text: string;
  }>(
    `SELECT s.name AS source_name, l.name_uk AS location_name, sm.published_at,
            left(sm.raw_text, 300) AS raw_text
       FROM event_evidence ee
       JOIN source_messages sm ON sm.id=ee.source_message_id
       JOIN sources s ON s.id=sm.source_id
       LEFT JOIN threat_event_locations el ON el.event_id=ee.event_id
       LEFT JOIN locations l ON l.id=el.location_id
      WHERE ee.event_id=$1
      ORDER BY sm.published_at DESC
      LIMIT $2`,
    [eventId, limit]
  );
  const seen = new Set<string>();
  const facts: MovementFact[] = [];
  for (const row of result.rows) {
    // Один рядок на повідомлення: LEFT JOIN на локації множить їх на кількість місць події.
    const key = `${row.source_name}|${row.published_at.toISOString()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({
      sourceName: row.source_name,
      locationName: row.location_name ?? '',
      observedAt: row.published_at.toISOString(),
      text: row.raw_text
    });
  }
  return facts;
}

const SYSTEM = [
  'Ти стисло переказуєш повідомлення українських моніторингових каналів про рух однієї повітряної загрози.',
  'Пиши українською, одним абзацом, не довше 400 символів.',
  'Скажи: звідки й куди рухається загроза, якого вона типу, і що саме змінилося з часом.',
  'НЕ прогнозуй ціль, час прильоту чи наслідки. НЕ додавай населених пунктів, яких немає у фактах.',
  'НЕ називай чисел, яких немає у фактах.',
  'У полі sources перелічи НАЗВИ КАНАЛІВ із фактів, на які ти спираєшся, дослівно.',
  'Якщо факти суперечливі — скажи про це прямо, не обираючи сторону.'
].join(' ');

/**
 * Назви місць, які модель має право згадати.
 *
 * Береться з фактів, а не з каталогу: дозволено рівно те, що каналами вже сказано про ЦЮ подію.
 */
function allowedPlaces(facts: readonly MovementFact[]): Set<string> {
  const places = new Set<string>();
  for (const fact of facts) if (fact.locationName) places.add(fact.locationName.toLowerCase());
  return places;
}

/**
 * Причина, з якої текст не можна показати, або `null`.
 *
 * Повертається саме причина, а не булеве значення: вона потрапляє в аудит `ai_runs`, і «текст
 * відхилено» без відповіді на питання «чому» перетворює перевірку на чорну скриньку.
 */
export function rejectionFor(
  candidate: MovementSummary, facts: readonly MovementFact[]
): string | null {
  const forecast = firstForecastLexeme([candidate.summary]);
  if (forecast) return `forecast:${forecast}`;
  if (candidate.summary.length > MAX_SUMMARY_CHARS) return 'too_long';

  const knownSources = new Set(facts.map((fact) => fact.sourceName.toLowerCase()));
  const cited = candidate.sources.filter((name) => knownSources.has(name.trim().toLowerCase()));
  // Жодного впізнаного джерела — текст неперевірний, і це відмова, а не привід друкувати без підпису.
  if (!cited.length) return 'no_known_source';

  const places = allowedPlaces(facts);
  if (places.size) {
    // Слова з великої літери, довші за три знаки, — груба, але дешева ознака топоніма. Хибне
    // спрацювання коштує одного відхиленого абзацу; пропуск коштує вигаданого міста в попередженні.
    //
    // БЕЗ `\b`. У JavaScript це межа ASCII-слова: кирилична літера не є `\w`, пробіл теж, тож між
    // ними переходу немає й `\b` не спрацьовує НІКОДИ перед українським словом. Перша редакція мала
    // `\b` — регулярка не знаходила жодного слова, перевірка мовчала, а тести на дозволені абзаци
    // проходили з хибної причини. Тому тут беруться всі кириличні слова, а великою літерою вони
    // відсіюються вже після.
    const words = (candidate.summary.match(/[А-ЯІЇЄҐа-яіїєґ’'-]{4,}/gu) ?? [])
      .filter((word) => /^[А-ЯІЇЄҐ]/u.test(word));
    for (const word of words) {
      const lower = word.toLowerCase();
      if (places.has(lower)) continue;
      if ([...places].some((place) => place.includes(lower) || lower.includes(place))) continue;
      // Слово може бути не топонімом узагалі — воно мусить іще й траплятися у вихідних текстах.
      if (facts.some((fact) => fact.text.toLowerCase().includes(lower))) continue;
      return `unknown_place:${word}`;
    }
  }
  return null;
}

/**
 * Абзац переказу, або `null`, якщо його не можна показати.
 *
 * Ніколи не кидає: викликається зі шляху доставки сповіщень, і виняток тут коштував би попередження.
 */
export async function summariseMovement(
  eventId: string,
  deps: { facts?: typeof movementFacts; chat?: typeof codexChat; settings?: typeof resolveCodexSettings } = {}
): Promise<MovementSummary | null> {
  try {
    const settings = await (deps.settings ?? resolveCodexSettings)();
    if (!settings.features.movement_summary) return null;

    const facts = await (deps.facts ?? movementFacts)(eventId);
    // Один канал — це вже сам по собі короткий текст; переказувати одне повідомлення одним
    // абзацом означає витратити виклик моделі на те, щоб нічого не спростити.
    if (facts.length < 2) return null;

    const result = await (deps.chat ?? codexChat)({
      promptVersion: 'movement-summary-v1',
      surface: 'movement_summary',
      system: SYSTEM,
      user: JSON.stringify({ facts }),
      json: true,
      // В аудит їдуть самі факти, а не серіалізований проміпт: читати назад треба те, на чому
      // модель працювала, а не рядок, у який його склеїли.
      auditInput: { facts }
    });
    if (!result.ok) return null;

    const parsed = summarySchema.safeParse(JSON.parse(result.content));
    if (!parsed.success) return null;

    const candidate: MovementSummary = {
      summary: parsed.data.summary.trim(),
      sources: parsed.data.sources.map((name) => name.trim())
    };
    if (rejectionFor(candidate, facts)) return null;

    const known = new Set(facts.map((fact) => fact.sourceName.toLowerCase()));
    return {
      summary: candidate.summary,
      // Показуємо лише впізнані назви: одна вигадана в переліку зробила б неперевірними всі.
      sources: [...new Set(candidate.sources.filter((name) => known.has(name.toLowerCase())))]
    };
  } catch {
    return null;
  }
}
