import { z } from 'zod';

/**
 * Статистика ударів і пуассонівський прогноз по регіону — чиста частина.
 *
 * Тут живе все, що не торкається бази й мережі: промт для моделі, розбір її відповіді, детермінований
 * перерахунок Пуассона з інтервалів, які вона назвала, і форма зведення, яку читають сторінка й бот.
 * `src/services/attack-stats.ts` лише кладе це між чергою і таблицею.
 *
 * ================================================================================================
 * Що це за поверхня і чому вона єдина у своєму роді
 * ================================================================================================
 *
 * Проєкт досі не публікував жодного розрахунку про майбутнє (`docs/OPERATIONS.md`, «Oblast research»:
 * «there is no probability in it»). Це рішення власника змінює межу вузько й свідомо (18.08.2026): на
 * сторінці аналізу атак і в нічній аналітиці бота з'являється блок статистики обстрілів по обраних
 * регіонах, зібраний моделлю з ВІДКРИТИХ ДЖЕРЕЛ через вебпошук, і пуассонівська ймовірність того, що
 * доба буде добою атаки. Не ціль, не маршрут, не час удару — базова частота і її наслідок.
 *
 * Три речі тримають межу там, де вона має лишатися:
 *
 *  1. **Арифметика перевіряється.** Модель віддає інтервали між останніми епізодами; λ, p і сценарії
 *     перераховуються тут ({@link recomputePoisson}) і порівнюються з її числами. Розбіжність не
 *     ховає звіт — вона підписує його `inconsistent`, і читач бачить обидва числа.
 *  2. **Дисклеймер — частина даних, а не оформлення.** {@link ATTACK_STATS_DISCLAIMER} їде у зведенні,
 *     першим рядком у боті й помітним блоком на сторінці. Його текст — дослівно з завдання власника.
 *  3. **Нічого не мутує.** Зведення читають дві поверхні; жоден шлях звідси не веде до тривог, подій,
 *     оцінок ризику, стану карти чи сповіщень про загрози.
 *
 * `src/domain/forecast-guard.ts` на цей текст НЕ застосовується — це поверхня, яка прогнозує за
 * визначенням, і ганяти її через сторожа означало б відхиляти кожен звіт. Сторож і далі стереже
 * решту публічних текстів; тут його роль виконує перерахунок і дисклеймер.
 */

// ------------------------------------------------------------------------------------------------
// Версії та словник
// ------------------------------------------------------------------------------------------------

export const ATTACK_STATS_METHODOLOGY_VERSION = 'attack-stats-v1';
export const ATTACK_STATS_PROMPT_VERSION = 'attack-stats-v1';

/** Дослівно з завдання власника. Перший рядок у боті, окремий блок на сторінці. */
export const ATTACK_STATS_DISCLAIMER =
  'Дані засновані на відкритих джерелах та офіційних повідомленнях. Прогноз є ймовірнісним і не '
  + 'гарантує точного передбачення. Він не замінює офіційних сигналів повітряної тривоги — під час '
  + 'тривоги прямуйте в укриття незалежно від будь-яких прогнозів.';

/** Пороги рівнів із завдання: висока ≥ 60 %, середня 30–59 %, низька < 30 %. */
export const FORECAST_LEVEL_THRESHOLDS = { high: 0.6, medium: 0.3 } as const;

export type ForecastLevel = 'low' | 'medium' | 'high';

export const FORECAST_LEVEL_LABELS: Record<ForecastLevel, string> = {
  low: 'низька', medium: 'середня', high: 'висока'
};

export function forecastLevel(p: number): ForecastLevel {
  if (p >= FORECAST_LEVEL_THRESHOLDS.high) return 'high';
  if (p >= FORECAST_LEVEL_THRESHOLDS.medium) return 'medium';
  return 'low';
}

export type WeaponClass = 'ballistic' | 'cruise' | 'uav' | 'unspecified';

export const WEAPON_LABELS: Record<WeaponClass, string> = {
  ballistic: 'балістика', cruise: 'крилаті ракети', uav: 'БпЛА', unspecified: 'не уточнено'
};

// ------------------------------------------------------------------------------------------------
// Регіони: граматика для промту
// ------------------------------------------------------------------------------------------------

/**
 * Регіони, які можна обрати: 24 області та Київ. Крим і Севастополь свідомо поза списком — це не
 * території, по яких ведеться російський обстріл, і звіт про них був би безглуздим у самій постановці.
 */
export const ATTACK_STATS_EXCLUDED_REGIONS: readonly string[] = ['ua-43', 'ua-85'];

export interface RegionPromptForms {
  /** «Київ», «Полтавська область» — називний, як у каталозі. */
  name: string;
  /** Після «по»: «місту Київ», «Полтавській області». */
  scope: string;
  /** Родовий для «повідомлення …»: «Київської міської військової адміністрації (КМВА) та КМДА». */
  authority: string;
  kind: 'city' | 'oblast';
}

/**
 * Відмінює назву області з каталогу. Прикметники на «-ська/-цька/-зька» відмінюються регулярно, тож
 * таблиці не потрібно; Київ — окремий випадок із власною адміністрацією та власним правилом
 * включення (місто, а не область).
 */
export function regionPromptForms(regionId: string, catalogueName: string): RegionPromptForms {
  if (regionId === 'ua-80') {
    return {
      name: 'Київ', scope: 'місту Київ', kind: 'city',
      authority: 'Київської міської військової адміністрації (КМВА) та КМДА'
    };
  }
  const name = catalogueName.trim();
  const adjective = name.replace(/\s+область$/iu, '');
  const locative = adjective.replace(/ська$/u, 'ській').replace(/цька$/u, 'цькій').replace(/зька$/u, 'зькій');
  const genitive = adjective.replace(/ська$/u, 'ської').replace(/цька$/u, 'цької').replace(/зька$/u, 'зької');
  const declined = locative !== adjective;
  return {
    name,
    scope: declined ? `${locative} області` : name,
    authority: declined
      ? `${genitive} обласної військової адміністрації (ОВА)`
      : `обласної військової адміністрації (${name})`,
    kind: 'oblast'
  };
}

// ------------------------------------------------------------------------------------------------
// Промт
// ------------------------------------------------------------------------------------------------

export interface AttackStatsTask {
  regionId: string;
  regionName: string;
  /** ISO-дати (YYYY-MM-DD), київський календар. */
  periodFrom: string;
  periodTo: string;
  forecastFrom: string;
  forecastTo: string;
  lastEpisodes: number;
  /** Сьогоднішня київська дата — модель має знати, який день «сьогодні», щоб шукати правильно. */
  today: string;
}

export function formatUaDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year}`;
}

export function formatUaRange(fromIso: string, toIso: string): string {
  const [fy, fm, fd] = fromIso.split('-');
  const [ty, tm, td] = toIso.split('-');
  if (fy === ty && fm === tm) return `${fd}–${td}.${tm}.${ty}`;
  return `${fd}.${fm}.${fy} — ${td}.${tm}.${ty}`;
}

/** Системна роль: коротко, бо все завдання — в користувацькому повідомленні, як у шаблоні власника. */
export const ATTACK_STATS_SYSTEM_PROMPT = [
  'Ти — OSINT-аналітик, який працює для української системи цивільного оповіщення.',
  'Тобі надано детальне завдання зі збору статистики повітряних атак з відкритих джерел, підрахунку',
  'метрик і побудови ймовірнісного прогнозу. Виконуй його повністю, у зазначеному порядку та форматі,',
  'українською мовою. Використовуй веб-пошук для кожної частини періоду — не відповідай з памʼяті',
  'і нічого не вигадуй: епізод без двох незалежних джерел (щонайменше одне офіційне) у статистику не',
  'потрапляє. Не наводь точних адрес влучань, позицій ППО та інших чутливих деталей.',
  'Це автоматичний запуск без людини в діалозі: не зупиняйся для підтвердження, не став запитань,',
  'а після таблиці епізодів одразу переходь до метрик, прогнозу й фінального формату.'
].join(' ');

/**
 * Користувацький промт — шаблон власника з підставленими значеннями. Текст залишено якомога ближче до
 * оригіналу; змінено рівно те, чого вимагає автоматичний запуск: немає зупинки на підтвердження, дати
 * в JSON — ISO, і JSON-блок несе ще кілька машиночитаних полів (episodes, metrics, conclusions),
 * дублюючи те, що текст і так містить, щоб сторінка й бот не розбирали markdown.
 */
export function buildAttackStatsPrompt(task: AttackStatsTask): string {
  const region = regionPromptForms(task.regionId, task.regionName);
  const period = formatUaRange(task.periodFrom, task.periodTo);
  const forecast = formatUaRange(task.forecastFrom, task.forecastTo);
  const inclusionRule = region.kind === 'city'
    ? 'До статистики включай лише атаки безпосередньо по м. Київ (вибухи в місті або офіційно '
      + 'підтверджена робота ППО по цілях над містом). Атаки лише по Київській області фіксуй окремим '
      + 'рядком і в основні метрики не включай.'
    : `До статистики включай лише атаки по території ${region.scope} — вибухи в населених пунктах `
      + 'області або офіційно підтверджена робота ППО по цілях над областю. Транзитний проліт засобів '
      + 'ураження без вибухів і без роботи ППО над областю фіксуй окремим рядком і в основні метрики не '
      + 'включай.';

  return [
    'ЗАВДАННЯ',
    `Ти — OSINT-аналітик. Збери з відкритих джерел, верифікуй і систематизуй дані про повітряні атаки `
    + `(ракетні та дронові удари) по ${region.scope} за період ${period}, порахуй статистику та побудуй `
    + `ймовірнісний прогноз на ${forecast}. Обов'язково використовуй веб-пошук для кожної частини періоду `
    + `— не відповідай з пам'яті. Сьогодні ${formatUaDate(task.today)} (за Києвом).`,
    '',
    'ДЖЕРЕЛА (за пріоритетом)',
    `1. Офіційні: зведення Повітряних сил ЗСУ, повідомлення ${region.authority}, ДСНС, Офіс Генпрокурора.`,
    '2. Провідні медіа: Суспільне, Укрінформ, Українська правда, РБК-Україна, hromadske, Reuters, AP, BBC.',
    '3. Моніторингові ресурси та агрегатори — лише для перехресної перевірки, не як єдине джерело.',
    '',
    'ПРАВИЛА ВЕРИФІКАЦІЇ',
    '* Кожен епізод підтверджуй щонайменше двома незалежними джерелами; хоча б одне з них — офіційне.',
    `* ${inclusionRule}`,
    '* Якщо тип засобу ураження офіційно не підтверджено — познач «не уточнено». Нічого не вгадуй і не '
    + 'заповнюй прогалини припущеннями.',
    '* До кожного епізоду додавай посилання на джерела.',
    '* Не наводь точних адрес влучань, позицій ППО та інших чутливих деталей.',
    '',
    'КРОК 1. ТАБЛИЦЯ ЕПІЗОДІВ',
    'Виведи таблицю всіх епізодів. Це автоматичний запуск: не зупиняйся для підтвердження, після таблиці '
    + 'одразу переходь до метрик.',
    '| Дата | Час початку–кінця (за Києвом) | Засоби ураження | Комбінована атака (так/ні) | Джерела | Примітки |',
    'Класифікація засобів: балістика («Іскандер-М», KN-23/24, аеробалістичний «Кинджал»); крилаті ракети '
    + '(Х-101/Х-555, «Калібр», Х-59, «Онікс», «Циркон»); БпЛА (Shahed/«Герань-2», зокрема реактивні '
    + '«Герань-3»).',
    '',
    'КРОК 2. МЕТРИКИ (окремо по кожному місяцю/підперіоду)',
    '1. Кількість днів з атаками.',
    '2. Частка нічних атак (початок у вікні 00:00–06:00).',
    '3. Частка атак із застосуванням балістики.',
    '4. Розподіл засобів: % балістика / % крилаті / % БпЛА (по епізодах з підтвердженим типом).',
    '5. Інтервали між атаками в добах: повний список, середній, мінімум, максимум.',
    '6. Темп: кількість днів атак у перерахунку на 30 діб.',
    '7. Погодинний розподіл початку ударів (години 00–23).',
    '8. Порівняння підперіодів: темп, середній інтервал, динаміка у %.',
    'Показуй проміжні обчислення (наприклад, список інтервалів), щоб їх можна було перевірити вручну.',
    '',
    'КРОК 3. ПРОГНОЗ',
    `* Візьми інтервали між останніми ${task.lastEpisodes} епізодами.`,
    '* Модель: пуассонівський процес; λ = 1 / середній інтервал (атак на добу).',
    '* Очікувана кількість атак за прогнозний період: λ × кількість діб.',
    '* Базова ймовірність атаки в конкретну ніч: p = 1 − e^(−λ). Якщо в даних є статистично помітний '
    + 'патерн (дні тижня, кластери), скоригуй p по днях і поясни, як саме.',
    '* Три сценарії: низька / базова / висока інтенсивність (наприклад, очікуване значення ± стандартне '
    + 'відхилення кількості днів атак).',
    '* Явно перелічи всі припущення та обмеження моделі.',
    '',
    'КРОК 4. ФОРМАТ ВИВОДУ',
    '1. Таблиця епізодів із джерелами.',
    '2. Блок метрик по періодах.',
    '3. Дані для графіків одним JSON-блоком у fenced-блоці ```json … ``` — ОСТАННІМ JSON-блоком у '
    + 'відповіді, рівно з такими ключами (дати у форматі YYYY-MM-DD, години 0–23, частки та ймовірності '
    + 'як числа від 0 до 1, без коментарів усередині JSON):',
    '```json',
    JSON.stringify({
      region: region.name,
      period: { from: task.periodFrom, to: task.periodTo },
      forecast_period: { from: task.forecastFrom, to: task.forecastTo },
      episodes: [{
        date: task.periodFrom, start: '01:40', end: '05:10', weapons: ['ballistic', 'uav'],
        combined: true, sources: ['https://…', 'https://…'], note: '…'
      }],
      calendar: [{ date: task.periodFrom, attack: true }],
      hourly: [{ hour: 2, count: 4 }],
      weapons: { ballistic: 0.64, cruise: 0.27, uav: 0.09 },
      metrics: [{
        label: 'Липень', from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', attack_days: 0, night_share: 0,
        ballistic_share: 0, intervals_days: [2, 6, 3], mean_interval_days: 0, min_interval_days: 0,
        max_interval_days: 0, tempo_per_30_days: 0
      }],
      intervals_days: [2, 6, 3],
      lambda_per_day: 0.48,
      expected_attacks: 6.7,
      scenarios: { low: 4, base: 6.7, high: 9 },
      forecast: [{ date: task.forecastFrom, p: 0.5, level: 'medium' }],
      conclusions: ['…', '…', '…', '…', '…'],
      assumptions: ['…']
    }, null, 2),
    '```',
    'Ключі `episodes`, `metrics`, `conclusions` і `assumptions` дублюють текст вище машиночитано: '
    + '`weapons` в епізоді — підмножина ballistic|cruise|uav|unspecified; `intervals_days` — інтервали '
    + `між останніми ${task.lastEpisodes} епізодами; \`forecast\` — по одному запису на кожен день `
    + `прогнозного періоду ${forecast}; \`level\` — high при p ≥ 0.60, medium при 0.30–0.59, low при < 0.30.`,
    '4. Календар прогнозу по днях із ймовірністю у %: висока ≥ 60 %, середня 30–59 %, низька < 30 %.',
    '5. П\'ять ключових висновків, по одному реченню кожен.',
    `6. Дисклеймер наприкінці: «${ATTACK_STATS_DISCLAIMER}»`
  ].join('\n');
}

// ------------------------------------------------------------------------------------------------
// Розбір відповіді
// ------------------------------------------------------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const share = z.coerce.number().min(0).max(1);
const nonNegative = z.coerce.number().min(0);

const weaponsShareSchema = z.object({
  ballistic: share.optional(), cruise: share.optional(), uav: share.optional(), unspecified: share.optional()
}).partial();

const episodeSchema = z.object({
  date: isoDate,
  start: z.string().max(20).nullish(),
  end: z.string().max(20).nullish(),
  weapons: z.array(z.string().max(40)).max(8).optional(),
  combined: z.boolean().optional(),
  sources: z.array(z.string().max(500)).max(12).optional(),
  note: z.string().max(600).nullish()
});

const metricsSchema = z.object({
  label: z.string().max(80),
  from: isoDate.optional(),
  to: isoDate.optional(),
  attack_days: nonNegative.optional(),
  night_share: share.optional(),
  ballistic_share: share.optional(),
  weapons: weaponsShareSchema.optional(),
  intervals_days: z.array(nonNegative).max(200).optional(),
  mean_interval_days: nonNegative.optional(),
  min_interval_days: nonNegative.optional(),
  max_interval_days: nonNegative.optional(),
  tempo_per_30_days: nonNegative.optional()
});

/**
 * Те, що модель має віддати в JSON-блоці. Схема м'яка там, де це безпечно (невідомі ключі,
 * необов'язкові поля), і жорстка там, де число піде на сторінку: дати — ISO, частки — 0..1, години —
 * 0..23. `forecast` — єдине обов'язкове поле: без нього нема чого публікувати.
 */
export const attackStatsChartsSchema = z.object({
  region: z.string().max(120).optional(),
  period: z.object({ from: isoDate, to: isoDate }).optional(),
  forecast_period: z.object({ from: isoDate, to: isoDate }).optional(),
  episodes: z.array(episodeSchema).max(300).optional(),
  calendar: z.array(z.object({ date: isoDate, attack: z.boolean() })).max(400).optional(),
  hourly: z.array(z.object({ hour: z.coerce.number().int().min(0).max(23), count: nonNegative })).max(48).optional(),
  weapons: weaponsShareSchema.optional(),
  metrics: z.array(metricsSchema).max(12).optional(),
  intervals_days: z.array(nonNegative).max(200).optional(),
  lambda_per_day: nonNegative.optional(),
  expected_attacks: nonNegative.optional(),
  scenarios: z.object({ low: nonNegative.optional(), base: nonNegative.optional(), high: nonNegative.optional() }).partial().optional(),
  forecast: z.array(z.object({
    date: isoDate, p: share, level: z.enum(['low', 'medium', 'high']).optional()
  })).min(1).max(93),
  conclusions: z.array(z.string().max(600)).max(12).optional(),
  assumptions: z.array(z.string().max(600)).max(30).optional()
}).loose();

export type AttackStatsCharts = z.infer<typeof attackStatsChartsSchema>;

/**
 * Останній fenced-блок ```json … ``` у відповіді, який розбирається як об'єкт. Останній, а не
 * перший: промт показує приклад форми у власному fenced-блоці, і модель, яка цитує завдання, поставить
 * приклад ПЕРЕД справжніми даними. Без огорожі — спроба на найбільший `{…}` у тексті, для відповідей,
 * де модель забула бектики.
 */
export function extractJsonBlock(text: string): unknown | null {
  const fenced = [...text.matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)```/g)].map((match) => match[1]!.trim());
  for (const candidate of fenced.reverse()) {
    const parsed = tryParseObject(candidate);
    if (parsed && typeof parsed === 'object' && 'forecast' in (parsed as Record<string, unknown>)) return parsed;
  }
  for (const candidate of fenced) {
    const parsed = tryParseObject(candidate);
    if (parsed) return parsed;
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) return tryParseObject(text.slice(first, last + 1));
  return null;
}

function tryParseObject(candidate: string): unknown | null {
  try {
    const parsed: unknown = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------
// Пуассон: детермінований перерахунок
// ------------------------------------------------------------------------------------------------

export interface PoissonEstimate {
  intervalsDays: number[];
  meanIntervalDays: number;
  minIntervalDays: number;
  maxIntervalDays: number;
  lambdaPerDay: number;
  /** p = 1 − e^(−λ): базова ймовірність, що доба буде добою атаки. */
  pDaily: number;
  horizonDays: number;
  expectedAttacks: number;
  /** Очікуване ± σ, де σ = √(очікуване) для пуассонівської кількості. Низький сценарій не нижче нуля. */
  scenarios: { low: number; base: number; high: number };
}

export function recomputePoisson(intervalsDays: readonly number[], horizonDays: number): PoissonEstimate | null {
  const intervals = intervalsDays.filter((value) => Number.isFinite(value) && value >= 0);
  if (!intervals.length) return null;
  const mean = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  if (!(mean > 0)) return null;
  const lambda = 1 / mean;
  const expected = lambda * horizonDays;
  const sd = Math.sqrt(expected);
  return {
    intervalsDays: intervals,
    meanIntervalDays: round(mean, 3),
    minIntervalDays: Math.min(...intervals),
    maxIntervalDays: Math.max(...intervals),
    lambdaPerDay: round(lambda, 4),
    pDaily: round(1 - Math.exp(-lambda), 4),
    horizonDays,
    expectedAttacks: round(expected, 2),
    scenarios: { low: round(Math.max(0, expected - sd), 2), base: round(expected, 2), high: round(expected + sd, 2) }
  };
}

export function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

// ------------------------------------------------------------------------------------------------
// Зведення: те, що читають сторінка й бот
// ------------------------------------------------------------------------------------------------

export type AttackStatsVerification = 'passed' | 'inconsistent' | 'rejected';

export interface ForecastDay {
  date: string;
  /** Ймовірність від моделі (вона могла скоригувати базову за днями тижня чи кластерами). */
  p: number;
  /** Рівень — завжди перерахований тут із p за порогами завдання, а не взятий у моделі. */
  level: ForecastLevel;
}

export interface AttackStatsEpisode {
  date: string;
  start: string | null;
  end: string | null;
  weapons: WeaponClass[];
  combined: boolean | null;
  sources: string[];
  note: string | null;
}

export interface AttackStatsSummary {
  version: 1;
  region: { id: string; name: string };
  period: { from: string; to: string; days: number };
  forecastPeriod: { from: string; to: string; days: number };
  /** Кількість днів з атаками за календарем моделі; null, коли календаря нема. */
  attackDays: number | null;
  /** Частка епізодів із початком у вікні 00:00–06:00 — з метрик моделі або порахована з епізодів. */
  nightShare: number | null;
  ballisticShare: number | null;
  weapons: { ballistic: number | null; cruise: number | null; uav: number | null; unspecified: number | null };
  /** 24 значення, години 0–23. */
  hourly: number[];
  calendar: Array<{ date: string; attack: boolean }>;
  metrics: z.infer<typeof metricsSchema>[];
  poisson: PoissonEstimate | null;
  /** Числа моделі, для звірки поруч із перерахунком. */
  model: { lambdaPerDay: number | null; pMedian: number | null; expectedAttacks: number | null };
  forecast: ForecastDay[];
  /** Перший день прогнозу від `forecastFrom` включно — те, що бот називає «найближчою ніччю». */
  tonight: ForecastDay | null;
  conclusions: string[];
  assumptions: string[];
  episodes: AttackStatsEpisode[];
  verification: AttackStatsVerification;
  /** Чому `inconsistent` або `rejected` — рядки для оператора й для примітки на сторінці. */
  issues: string[];
  disclaimer: string;
}

/** Допуски звірки: λ — 15 % або 0.05 на добу (що більше), медіана p — 0.15. */
export const VERIFICATION_TOLERANCE = { lambdaRelative: 0.15, lambdaAbsolute: 0.05, pMedian: 0.15 } as const;

const WEAPON_ALIASES: Record<string, WeaponClass> = {
  ballistic: 'ballistic', 'балістика': 'ballistic', 'балістична': 'ballistic', 'balistic': 'ballistic',
  cruise: 'cruise', 'крилаті': 'cruise', 'крилата': 'cruise', 'крилаті ракети': 'cruise',
  uav: 'uav', 'бпла': 'uav', drone: 'uav', drones: 'uav', shahed: 'uav', 'шахеди': 'uav',
  unspecified: 'unspecified', 'не уточнено': 'unspecified', unknown: 'unspecified'
};

function normaliseWeapon(value: string): WeaponClass | null {
  return WEAPON_ALIASES[value.trim().toLowerCase()] ?? null;
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000) + 1);
}

function startHour(start: string | null | undefined): number | null {
  if (!start) return null;
  const match = /^(\d{1,2})[:.]/.exec(start.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  return hour >= 0 && hour <= 23 ? hour : null;
}

function safeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    return new URL(trimmed).toString();
  } catch {
    return null;
  }
}

/**
 * Зведення з розібраного JSON-блоку. Чиста функція: усе, що тут порахувано, можна перевірити з тих
 * самих вхідних даних, і саме це — відповідь на питання «звідки ці числа».
 */
export function composeAttackStatsSummary(charts: AttackStatsCharts, task: AttackStatsTask): AttackStatsSummary {
  const issues: string[] = [];
  const horizonDays = daysBetween(task.forecastFrom, task.forecastTo);

  const episodes: AttackStatsEpisode[] = (charts.episodes ?? [])
    .filter((episode) => episode.date >= task.periodFrom && episode.date <= task.periodTo)
    .map((episode) => ({
      date: episode.date,
      start: episode.start?.trim() || null,
      end: episode.end?.trim() || null,
      weapons: [...new Set((episode.weapons ?? []).map(normaliseWeapon).filter((item): item is WeaponClass => item !== null))],
      combined: episode.combined ?? null,
      sources: (episode.sources ?? []).map(safeUrl).filter((item): item is string => item !== null).slice(0, 8),
      note: episode.note?.trim() || null
    }));

  const calendar = (charts.calendar ?? [])
    .filter((day) => day.date >= task.periodFrom && day.date <= task.periodTo);
  const attackDates = new Set(calendar.filter((day) => day.attack).map((day) => day.date));
  for (const episode of episodes) attackDates.add(episode.date);
  const attackDays = calendar.length || episodes.length ? attackDates.size : null;

  const hourly = new Array<number>(24).fill(0);
  if (charts.hourly?.length) {
    for (const row of charts.hourly) hourly[row.hour] = (hourly[row.hour] ?? 0) + row.count;
  } else {
    for (const episode of episodes) {
      const hour = startHour(episode.start);
      if (hour !== null) hourly[hour] = (hourly[hour] ?? 0) + 1;
    }
  }

  const metrics = charts.metrics ?? [];
  const weightedShare = (pick: (row: z.infer<typeof metricsSchema>) => number | undefined): number | null => {
    let weight = 0; let sum = 0;
    for (const row of metrics) {
      const value = pick(row);
      if (value === undefined || row.attack_days === undefined) continue;
      weight += row.attack_days; sum += value * row.attack_days;
    }
    return weight > 0 ? round(sum / weight, 3) : null;
  };
  const nightFromEpisodes = (): number | null => {
    const withHour = episodes.map((episode) => startHour(episode.start)).filter((hour): hour is number => hour !== null);
    if (!withHour.length) return null;
    return round(withHour.filter((hour) => hour < 6).length / withHour.length, 3);
  };
  const ballisticFromEpisodes = (): number | null => {
    if (!episodes.length) return null;
    return round(episodes.filter((episode) => episode.weapons.includes('ballistic')).length / episodes.length, 3);
  };
  const nightShare = weightedShare((row) => row.night_share) ?? nightFromEpisodes();
  const ballisticShare = weightedShare((row) => row.ballistic_share) ?? ballisticFromEpisodes();

  const weapons = {
    ballistic: charts.weapons?.ballistic ?? null,
    cruise: charts.weapons?.cruise ?? null,
    uav: charts.weapons?.uav ?? null,
    unspecified: charts.weapons?.unspecified ?? null
  };

  const intervals = charts.intervals_days ?? [];
  const poisson = recomputePoisson(intervals, horizonDays);
  if (!poisson) issues.push('intervals_missing');

  const forecast: ForecastDay[] = charts.forecast
    .filter((day) => day.date >= task.forecastFrom && day.date <= task.forecastTo)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => ({ date: day.date, p: round(day.p, 4), level: forecastLevel(day.p) }));
  if (!forecast.length) issues.push('forecast_outside_period');
  const modelLevelMismatch = charts.forecast.some((day) => day.level && day.level !== forecastLevel(day.p));
  if (modelLevelMismatch) issues.push('level_relabelled');

  const pMedian = median(forecast.map((day) => day.p));
  const modelLambda = charts.lambda_per_day ?? null;
  const model = { lambdaPerDay: modelLambda, pMedian: pMedian === null ? null : round(pMedian, 4), expectedAttacks: charts.expected_attacks ?? null };

  if (poisson) {
    if (modelLambda !== null) {
      const tolerance = Math.max(VERIFICATION_TOLERANCE.lambdaAbsolute, poisson.lambdaPerDay * VERIFICATION_TOLERANCE.lambdaRelative);
      if (Math.abs(modelLambda - poisson.lambdaPerDay) > tolerance) issues.push(`lambda_mismatch:${modelLambda}≠${poisson.lambdaPerDay}`);
    }
    if (pMedian !== null && Math.abs(pMedian - poisson.pDaily) > VERIFICATION_TOLERANCE.pMedian) {
      issues.push(`p_mismatch:${round(pMedian, 3)}≠${poisson.pDaily}`);
    }
  }

  const rejected = !forecast.length;
  const inconsistent = !rejected && issues.some((issue) => /^(lambda_mismatch|p_mismatch|intervals_missing)/.test(issue));

  return {
    version: 1,
    region: { id: task.regionId, name: task.regionName },
    period: { from: task.periodFrom, to: task.periodTo, days: daysBetween(task.periodFrom, task.periodTo) },
    forecastPeriod: { from: task.forecastFrom, to: task.forecastTo, days: horizonDays },
    attackDays,
    nightShare,
    ballisticShare,
    weapons,
    hourly,
    calendar,
    metrics,
    poisson,
    model,
    forecast,
    tonight: forecast.find((day) => day.date >= task.forecastFrom) ?? null,
    conclusions: (charts.conclusions ?? []).map((line) => line.trim()).filter(Boolean).slice(0, 8),
    assumptions: (charts.assumptions ?? []).map((line) => line.trim()).filter(Boolean).slice(0, 12),
    episodes,
    verification: rejected ? 'rejected' : inconsistent ? 'inconsistent' : 'passed',
    issues,
    disclaimer: ATTACK_STATS_DISCLAIMER
  };
}

export interface ParsedAttackStatsReply {
  charts: AttackStatsCharts | null;
  summary: AttackStatsSummary | null;
  /** `null` — розібрано; інакше причина, з якою звіт іде як `rejected`. */
  rejectionReason: string | null;
}

/** Повний шлях від тексту моделі до зведення. Ніколи не кидає. */
export function parseAttackStatsReply(text: string, task: AttackStatsTask): ParsedAttackStatsReply {
  const block = extractJsonBlock(text);
  if (!block) return { charts: null, summary: null, rejectionReason: 'json_block_missing' };
  const parsed = attackStatsChartsSchema.safeParse(block);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join('.') || 'root';
    return { charts: null, summary: null, rejectionReason: `schema:${path}` };
  }
  const summary = composeAttackStatsSummary(parsed.data, task);
  return {
    charts: parsed.data,
    summary,
    rejectionReason: summary.verification === 'rejected' ? (summary.issues[0] ?? 'forecast_missing') : null
  };
}

// ------------------------------------------------------------------------------------------------
// Текст для бота
// ------------------------------------------------------------------------------------------------

export function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${Math.round(value * 100)} %`;
}

export function shortUaDate(iso: string): string {
  const [, month, day] = iso.split('-');
  return `${day}.${month}`;
}

function uaNumber(value: number, digits = 1): string {
  return value.toFixed(digits).replace('.', ',');
}

/**
 * Рядки для нічної аналітики бота — без HTML і без назви регіону (її форматувальник ставить
 * заголовком блоку); екранує форматувальник. Дисклеймер їде окремим полем і стає першим рядком
 * блоку: повідомлення читають переслане й скриншотом, і те, що переживе пересилання, мусить нести
 * «це не тривога».
 */
export function attackStatsDigestLines(summary: AttackStatsSummary): string[] {
  const lines: string[] = [];
  const period = formatUaRange(summary.period.from, summary.period.to);
  const facts: string[] = [];
  if (summary.attackDays !== null) facts.push(`${summary.attackDays} дн. з атаками із ${summary.period.days}`);
  if (summary.nightShare !== null) facts.push(`нічних ${percent(summary.nightShare)}`);
  if (summary.ballisticShare !== null) facts.push(`з балістикою ${percent(summary.ballisticShare)}`);
  if (summary.poisson) facts.push(`середній інтервал ${uaNumber(summary.poisson.meanIntervalDays)} доби`);
  lines.push(`Період ${period}${facts.length ? `: ${facts.join(', ')}` : ''}.`);
  if (summary.tonight) {
    lines.push(`Найближча ніч (${shortUaDate(summary.tonight.date)}): ≈${percent(summary.tonight.p)} — ${FORECAST_LEVEL_LABELS[summary.tonight.level]}.`);
  }
  const next = summary.forecast.filter((day) => !summary.tonight || day.date > summary.tonight.date).slice(0, 6);
  if (next.length) lines.push(`Далі: ${next.map((day) => `${shortUaDate(day.date)} ${percent(day.p)}`).join(' · ')}.`);
  if (summary.verification === 'inconsistent' && summary.poisson) {
    lines.push(`Перерахунок за Пуассоном дає ≈${percent(summary.poisson.pDaily)} на добу — числа моделі з ним не сходяться.`);
  }
  return lines;
}
