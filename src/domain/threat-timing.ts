/**
 * Актуальність загрози в часі — коли саме, за словами джерела, вона стосується названих місць.
 *
 * До цього словника кожне твердження читалося як «зараз»: подія жила тридцять хвилин від часу
 * публікації, і повідомлення «увечері очікується масований удар» або відкидалося правилами як
 * прогноз, або ставало такою самою живою загрозою, як «вибухи в місті». Модель-класифікатор
 * (`src/services/codex-classifier.ts`) відповідає на це питання окремим полем, і це поле їде до
 * події, на карту, в бот і в архів.
 *
 * Ця таблиця — чиста: жодної бази. Вікно очікування рахується з київського календаря, бо «увечері»
 * — це київський вечір, а не UTC.
 */

import { THREAT_TIMINGS, type ThreatTiming } from '../types.js';

export { THREAT_TIMINGS };
export type { ThreatTiming };

export function isThreatTiming(value: unknown): value is ThreatTiming {
  return typeof value === 'string' && (THREAT_TIMINGS as readonly string[]).includes(value);
}

/** Чим менше, тим ближче. Злиття двох повідомлень в одну подію бере ближче з двох. */
export const TIMING_RANK: Record<ThreatTiming, number> = {
  now: 0, within_hour: 1, evening: 2, within_day: 3, within_two_days: 4
};

export const TIMING_LABELS: Record<ThreatTiming, string> = {
  now: 'зараз',
  within_hour: 'протягом години',
  evening: 'увечері',
  within_day: 'протягом доби',
  within_two_days: 'протягом двох діб'
};

/** Для заголовків і бейджів: «ОЧІКУЄТЬСЯ УВЕЧЕРІ». `now` бейджа не має — це звичайна жива загроза. */
export const TIMING_BADGES: Record<Exclude<ThreatTiming, 'now'>, string> = {
  within_hour: 'очікується протягом години',
  evening: 'очікується увечері',
  within_day: 'очікується протягом доби',
  within_two_days: 'очікується протягом двох діб'
};

/** Скільки живе подія з такою актуальністю, коли модель не назвала вікна явно. */
export const TIMING_VALIDITY_MS: Record<ThreatTiming, number> = {
  now: 30 * 60_000,
  within_hour: 90 * 60_000,
  evening: 6 * 3_600_000,          // нижня межа; реальне вікно — до кінця київського вечора, див. нижче
  within_day: 24 * 3_600_000,
  within_two_days: 48 * 3_600_000
};

/** Київський вечір: від 18:00 до 23:59 тієї ж доби (або до 23:59, якщо вже вечір). */
const EVENING_START_HOUR = 18;

function kyivParts(at: Date, timezone: string): { hour: number; offsetMinutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset'
  }).formatToParts(at);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  const offsetMinutes = match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0)) : 0;
  return { hour, offsetMinutes };
}

/** Початок київської доби, в яку потрапляє `at`, як мить UTC. */
function kyivMidnight(at: Date, timezone: string): Date {
  const { offsetMinutes } = kyivParts(at, timezone);
  const local = at.getTime() + offsetMinutes * 60_000;
  const midnightLocal = Math.floor(local / 86_400_000) * 86_400_000;
  return new Date(midnightLocal - offsetMinutes * 60_000);
}

export interface ExpectedWindow {
  from: Date;
  until: Date;
}

/**
 * Вікно, в якому загроза вважається актуальною.
 *
 *  - `now` — від публікації на тридцять хвилин (як і раніше для кожного твердження);
 *  - `within_hour` — від публікації на дев'яносто хвилин;
 *  - `evening` — від 18:00 київського часу (або від публікації, якщо вже пізніше) до 23:59 цієї доби;
 *    опубліковане після півночі, але до ранку, читається як «цей вечір» тієї самої календарної доби;
 *  - `within_day` / `within_two_days` — від публікації на 24 / 48 годин.
 *
 * Явне вікно від моделі приймається лише в межах цих самих горизонтів — модель може звузити, не
 * розширити: «о 20:00» усередині вечора так, «наступного тижня» — ні.
 */
export function expectedWindow(
  timing: ThreatTiming, publishedAt: Date, timezone: string,
  explicit?: { from?: Date | null; until?: Date | null }
): ExpectedWindow {
  let from = publishedAt;
  let until = new Date(publishedAt.getTime() + TIMING_VALIDITY_MS[timing]);
  if (timing === 'evening') {
    const midnight = kyivMidnight(publishedAt, timezone);
    const eveningStart = new Date(midnight.getTime() + EVENING_START_HOUR * 3_600_000);
    const dayEnd = new Date(midnight.getTime() + 24 * 3_600_000 - 60_000);
    from = publishedAt > eveningStart ? publishedAt : eveningStart;
    until = dayEnd > from ? dayEnd : new Date(from.getTime() + TIMING_VALIDITY_MS.evening);
  }
  if (explicit?.from && explicit.from >= from && explicit.from <= until) from = explicit.from;
  if (explicit?.until && explicit.until > from && explicit.until <= until) until = explicit.until;
  return { from, until };
}

/** Ближча актуальність із двох — те, що лишається на події після злиття. */
export function nearerTiming(a: ThreatTiming, b: ThreatTiming): ThreatTiming {
  return TIMING_RANK[a] <= TIMING_RANK[b] ? a : b;
}
