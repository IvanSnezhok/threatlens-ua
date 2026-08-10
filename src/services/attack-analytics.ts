import { config } from '../config.js';
import { pool } from '../db/pool.js';
import type { PublicationMode } from '../types.js';

/**
 * Public attack analytics: what was reported over a day, a week or a month, and what repeats in it.
 *
 * ## Why this is not another slice of `analytics-archive.ts`
 *
 * `src/services/analytics-archive.ts` is an *instrument diagnostic*. Every one of its questions is
 * ultimately about the classifier: which version judged what, which source reports first, which
 * messages this project failed to read. It is operator-only for that reason — the archive contains
 * the decisions the pipeline got wrong, and those are not a public dataset.
 *
 * This module asks a different question, on behalf of a different reader: *what has been flying,
 * where, and at what hours?* It never exposes a per-source or per-message row, only counts over an
 * oblast, a threat class, an hour of the day and a wave. Nothing here can be traced back to a single
 * channel's mistake, which is what makes it publishable.
 *
 * ## Three rules
 *
 * **Aggregation happens in SQL.** Two statements per request, both half-open `[from, to)` range scans
 * over `message_classifications_time_idx`, both bounded by the longest window this module offers
 * (31 days). No slice ever selects a raw classification row into JavaScript: the widest thing that
 * crosses the boundary is a time-bucketed activity timeline, at most ~1500 rows for a month.
 *
 * **Waves are clustered in JavaScript, over that timeline.** The gap that separates one wave from the
 * next is a judgement call, not a fact ({@link WAVE_GAP_MINUTES}), and a wave has to carry its own
 * composition — which classes flew together — which a gap-and-islands query would need a second pass
 * to produce anyway. Keeping {@link clusterWaves} a pure function over an aggregate makes the
 * judgement testable with fixtures instead of arguable in a query plan.
 *
 * **Counting is counting reports, never counting weapons.** A message says "шахеди на Полтавщині"; it
 * does not say how many. Every number below is a count of *classified messages* or of *events
 * raised*, and {@link describeAttacks} is required to say so. A page that quietly renamed
 * `messages` to "засобів" would be inventing military statistics out of Telegram posts, which is the
 * one thing this project exists not to do.
 *
 * Nothing here calls a model. The written conclusion is deterministic, in the same spirit as the
 * baseline in `src/services/analytics-narrative.ts`: an operator can re-derive every sentence from
 * the aggregates printed beside it.
 */

// ------------------------------------------------------------------------------------------------
// Window
// ------------------------------------------------------------------------------------------------

export type AttackPeriod = 'day' | 'week' | 'month';

export const ATTACK_PERIODS: readonly AttackPeriod[] = ['day', 'week', 'month'];

export function isAttackPeriod(value: unknown): value is AttackPeriod {
  return typeof value === 'string' && (ATTACK_PERIODS as readonly string[]).includes(value);
}

/**
 * Window length and timeline resolution per period.
 *
 * `bucketMinutes` is the resolution of the activity timeline the wave clustering reads, chosen so
 * every period produces a comparable number of points (~290 for a day, ~670 for a week, ~1490 for a
 * month). A finer bucket for a month would not make the waves better — it would only make the
 * payload bigger — because the gap that separates waves is an hour and a half either way.
 */
const PERIOD_SHAPE: Record<AttackPeriod, { days: number; bucketMinutes: number }> = {
  day: { days: 1, bucketMinutes: 5 },
  week: { days: 7, bucketMinutes: 15 },
  month: { days: 31, bucketMinutes: 30 }
};

/**
 * Quiet time that ends a wave.
 *
 * Deliberately one value for every period rather than one per period: a wave is a thing that happens
 * in the sky, and how long a window somebody is looking at must not change how many waves the night
 * is said to have contained. Ninety minutes is longer than the gap between two reports of the same
 * incoming group and shorter than the gap between two separate launches on the same night, which is
 * the distinction the number has to make.
 */
export const WAVE_GAP_MINUTES = 90;

/** A single message is an incident report, not a wave. Below this a cluster is not named one. */
export const WAVE_MIN_MESSAGES = 2;

export interface AttackWindow {
  period: AttackPeriod;
  from: Date;
  to: Date;
  /** Start of the equally long window immediately before `from`, for the trend comparison. */
  previousFrom: Date;
  /**
   * The publication cutoff — a bound on `message_classifications.classified_at`, i.e. on WHEN WE
   * LEARNED of a message, and a separate axis from `from`/`to`, which bound `published_at`.
   *
   * The two must not be conflated. `published_at` is the source's own timestamp (migration 012:
   * «Publication time, not receipt time»), so bounding the hold with it holds nothing the moment
   * ingestion lag exceeds the hold, and holds nothing at all for an edited message or a post-
   * disconnect catch-up, both of which are re-processed with the ORIGINAL publication time. The
   * analytical question («when did the enemy act») and the publication question («when did this
   * become a fact we may publish») are different questions about different columns.
   */
  cutoffAt: Date;
  bucketMinutes: number;
  timezone: string;
}

/**
 * Where a period starts and ends. `to` is the request instant; nothing is rounded to a calendar day.
 *
 * `cutoffAt` defaults to `now`, which is what `live` mode's cutoff is — so every existing caller and
 * every unit fixture keeps the statement it had, with a predicate that is true for every visible row.
 */
export function resolveAttackWindow(
  period: AttackPeriod, now: Date = new Date(), cutoffAt: Date = now
): AttackWindow {
  const shape = PERIOD_SHAPE[period];
  const span = shape.days * 86_400_000;
  const to = new Date(now.getTime());
  return {
    period,
    from: new Date(to.getTime() - span),
    to,
    previousFrom: new Date(to.getTime() - span * 2),
    cutoffAt: new Date(cutoffAt.getTime()),
    bucketMinutes: shape.bucketMinutes,
    timezone: config.APP_TIMEZONE
  };
}

// ------------------------------------------------------------------------------------------------
// Vocabulary
// ------------------------------------------------------------------------------------------------

/**
 * Short names for prose.
 *
 * `src/domain/classifier.ts` has its own label map, and this is not a duplicate of it by accident:
 * those labels are event titles ("Загроза ударних БпЛА") and read as headlines. A sentence needs the
 * bare noun ("ударні БпЛА"), so the two maps say the same thing in two grammatical registers and
 * neither can be derived from the other without string surgery.
 */
export const THREAT_LABELS: Record<string, string> = {
  uav: 'ударні БпЛА',
  ballistic_missile: 'балістика',
  cruise_missile: 'крилаті ракети',
  guided_air_bomb: 'керовані авіабомби',
  aviation: 'активність авіації',
  mlrs: 'РСЗВ',
  artillery: 'артилерія',
  mortar: 'міномети',
  combined: 'комбінований удар',
  unknown: 'невизначений тип'
};

export function threatLabel(threatType: string): string {
  return THREAT_LABELS[threatType] ?? threatType;
}

// ------------------------------------------------------------------------------------------------
// Result shape
// ------------------------------------------------------------------------------------------------

export type Trend = 'rising' | 'falling' | 'steady' | 'new' | 'gone';

export interface TrendPair {
  messages: number;
  eventsRaised: number;
  previousMessages: number;
  previousEventsRaised: number;
  /** Change in `messages` against the previous window, in percent. `null` when there is no baseline. */
  deltaPercent: number | null;
  trend: Trend;
}

export interface MeansRow extends TrendPair {
  threatType: string;
  label: string;
  /** Share of this class among all class mentions in the window, 0..1. */
  share: number;
}

export interface TargetRow extends TrendPair {
  oblastId: string;
  oblastName: string;
  share: number;
}

export interface HourRow {
  hour: number;
  messages: number;
  eventsRaised: number;
}

export interface DirectionRow {
  direction: string;
  messages: number;
  previousMessages: number;
}

/**
 * One point of the activity timeline. `threatType` is `null` on the row that counts messages once.
 *
 * `firstAt`/`lastAt` are the real timestamps of the earliest and latest message inside the bucket,
 * carried only on those spine rows. They exist so wave boundaries are measured between messages
 * rather than between bucket edges — see {@link clusterWaves}. Optional because every fixture and
 * every caller that has only bucket starts is still a valid input.
 */
export interface TimelinePoint {
  at: string;
  threatType: string | null;
  messages: number;
  eventsRaised: number;
  firstAt?: string | null;
  lastAt?: string | null;
}

export interface AttackWave {
  startedAt: string;
  endedAt: string;
  durationMinutes: number;
  messages: number;
  eventsRaised: number;
  /** Classes seen in the wave, busiest first. A message matching two classes appears under both. */
  threatTypes: Array<{ threatType: string; label: string; messages: number }>;
}

export interface CombinationRow {
  threatTypes: [string, string];
  labels: [string, string];
  waves: number;
  /** Share of the window's waves in which both classes appear, 0..1. */
  share: number;
}

export interface AttackPatterns {
  headline: string;
  findings: string[];
  caveats: string[];
}

export interface AttackAnalytics {
  window: {
    period: AttackPeriod;
    from: string;
    to: string;
    previousFrom: string;
    bucketMinutes: number;
    timezone: string;
  };
  totals: TrendPair;
  means: MeansRow[];
  targets: TargetRow[];
  hours: HourRow[];
  directions: DirectionRow[];
  waves: AttackWave[];
  combinations: CombinationRow[];
  patterns: AttackPatterns;
  /** Classifier versions that judged the messages in this window. More than one weakens the trend. */
  classifierVersions: string[];
  generatedAt: string;
}

// ------------------------------------------------------------------------------------------------
// Pure helpers — the arithmetic every number on the page is made of
// ------------------------------------------------------------------------------------------------

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * How a count moved against the same-length window before it.
 *
 * The 15 % dead band is what keeps "тренд" from meaning "the number changed at all". Below it two
 * windows of monitoring-channel volume are indistinguishable, and calling a 4 % drift "спад" in front
 * of a civilian reader would be asserting a pattern that is not there.
 */
export function trendOf(current: number, previous: number): Trend {
  if (previous === 0) return current > 0 ? 'new' : 'steady';
  if (current === 0) return 'gone';
  const change = (current - previous) / previous;
  if (change > 0.15) return 'rising';
  if (change < -0.15) return 'falling';
  return 'steady';
}

export function deltaPercent(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return round(((current - previous) / previous) * 100, 1);
}

function trendPair(messages: number, eventsRaised: number, previousMessages: number, previousEvents: number): TrendPair {
  return {
    messages,
    eventsRaised,
    previousMessages,
    previousEventsRaised: previousEvents,
    deltaPercent: deltaPercent(messages, previousMessages),
    trend: trendOf(messages, previousMessages)
  };
}

/** The busiest hour of the day, ties broken by the earlier hour. `null` when the window is empty. */
export function peakHour(hours: HourRow[]): HourRow | null {
  let best: HourRow | null = null;
  for (const row of hours) {
    if (row.messages === 0) continue;
    if (!best || row.messages > best.messages || (row.messages === best.messages && row.hour < best.hour)) best = row;
  }
  return best;
}

/**
 * Share of reporting that falls into the night window 22:00–05:59 local time.
 *
 * Not a decorative statistic: a night share well above a half is the single most robust pattern in
 * this data, and it is the one that tells a reader when to keep a phone within reach.
 */
export function nightShare(hours: HourRow[]): number {
  let night = 0;
  let total = 0;
  for (const row of hours) {
    total += row.messages;
    if (row.hour >= 22 || row.hour < 6) night += row.messages;
  }
  return total === 0 ? 0 : round(night / total, 4);
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : round((sorted[middle - 1]! + sorted[middle]!) / 2, 1);
}

// ------------------------------------------------------------------------------------------------
// Wave clustering
// ------------------------------------------------------------------------------------------------

export interface ClusterOptions {
  bucketMinutes: number;
  gapMinutes?: number;
  minMessages?: number;
}

/**
 * Groups the activity timeline into waves.
 *
 * The timeline is already an aggregate: one row per time bucket for the total, plus one row per
 * (bucket, threat class) for the composition. The spine — the rows with `threatType === null` — is
 * what decides where a wave starts and stops; the typed rows only describe what was inside it. That
 * split matters because a message matching two classes must be counted once towards the wave's size
 * and twice towards its composition, and a single row shape cannot do both.
 *
 * A gap is measured between the *messages* on either side of it — the last one before the silence and
 * the first one after — which is why the spine carries `firstAt`/`lastAt` and not only a bucket
 * start. Measuring between bucket edges instead looked equivalent and is not: with a 30-minute bucket
 * the arithmetic can understate a silence by most of an hour, so the same night genuinely came out as
 * three waves under «Доба» and two under «Місяць». How many waves a night contained must not depend
 * on which tab the reader has open. Bucket edges remain the fallback for inputs that carry no exact
 * timestamps, where they are the best available estimate.
 *
 * Clusters below `minMessages` are dropped rather than shown as one-report waves: a lone message is
 * an incident report, and drawing it as a wave would make a quiet week look structured.
 */
export function clusterWaves(timeline: TimelinePoint[], options: ClusterOptions): AttackWave[] {
  const bucketMs = options.bucketMinutes * 60_000;
  const gapMs = (options.gapMinutes ?? WAVE_GAP_MINUTES) * 60_000;
  const minMessages = options.minMessages ?? WAVE_MIN_MESSAGES;

  const instant = (value: string | null | undefined, fallback: number): number => {
    const parsed = value == null ? NaN : Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const spine = timeline
    .filter((point) => point.threatType === null)
    .map((point) => {
      const at = Date.parse(point.at);
      return {
        at,
        first: instant(point.firstAt, at),
        last: instant(point.lastAt, at + bucketMs),
        messages: point.messages,
        eventsRaised: point.eventsRaised
      };
    })
    .filter((point) => Number.isFinite(point.at) && point.messages > 0)
    .sort((a, b) => a.at - b.at);
  if (!spine.length) return [];

  const typed = new Map<number, Array<{ threatType: string; messages: number }>>();
  for (const point of timeline) {
    if (point.threatType === null) continue;
    const at = Date.parse(point.at);
    if (!Number.isFinite(at)) continue;
    const list = typed.get(at) ?? [];
    list.push({ threatType: point.threatType, messages: point.messages });
    typed.set(at, list);
  }

  // `quietSince` is the running maximum rather than the previous point's own `last`, because a bucket
  // that reported nothing new still cannot lengthen a silence that an earlier one already ended.
  const groups: Array<typeof spine> = [[spine[0]!]];
  let quietSince = spine[0]!.last;
  for (let index = 1; index < spine.length; index += 1) {
    const point = spine[index]!;
    if (point.first - quietSince > gapMs) groups.push([point]);
    else groups[groups.length - 1]!.push(point);
    quietSince = Math.max(quietSince, point.last);
  }

  return groups
    .map((group) => {
      const composition = new Map<string, number>();
      for (const point of group) {
        for (const entry of typed.get(point.at) ?? []) {
          composition.set(entry.threatType, (composition.get(entry.threatType) ?? 0) + entry.messages);
        }
      }
      const startedAt = group[0]!.first;
      const endedAt = group.reduce((latest, point) => Math.max(latest, point.last), startedAt);
      return {
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        durationMinutes: Math.round((endedAt - startedAt) / 60_000),
        messages: group.reduce((sum, point) => sum + point.messages, 0),
        eventsRaised: group.reduce((sum, point) => sum + point.eventsRaised, 0),
        threatTypes: [...composition.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([threatType, messages]) => ({ threatType, label: threatLabel(threatType), messages }))
      };
    })
    .filter((wave) => wave.messages >= minMessages);
}

/**
 * Classes that keep showing up together inside one wave.
 *
 * Pairs, not full combinations: "шахеди й балістика однієї ночі" is a claim a reader can check, while
 * "шахеди + балістика + крилаті + невизначене" is a description of one particular night that will
 * never repeat exactly and therefore never be a pattern. `unknown` is excluded because a pair with it
 * says nothing, and `combined` because it is the aggregate the constituent classes already cover.
 */
export function repeatedCombinations(waves: AttackWave[], minWaves = 2): CombinationRow[] {
  const counts = new Map<string, number>();
  for (const wave of waves) {
    const classes = [...new Set(wave.threatTypes.map((entry) => entry.threatType))]
      .filter((threatType) => threatType !== 'unknown' && threatType !== 'combined')
      .sort();
    for (let i = 0; i < classes.length; i += 1) {
      for (let j = i + 1; j < classes.length; j += 1) {
        const key = `${classes[i]}|${classes[j]}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= minWaves)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([key, count]) => {
      const [first, second] = key.split('|') as [string, string];
      return {
        threatTypes: [first, second] as [string, string],
        labels: [threatLabel(first), threatLabel(second)] as [string, string],
        waves: count,
        share: waves.length ? round(count / waves.length, 4) : 0
      };
    });
}

// ------------------------------------------------------------------------------------------------
// The written conclusion — deterministic, and honest about what it is
// ------------------------------------------------------------------------------------------------

const PERIOD_NAMES: Record<AttackPeriod, string> = { day: 'добу', week: 'тиждень', month: 'місяць' };

/**
 * «за останню добу», але «за останній тиждень».
 *
 * Kept as three whole phrases rather than one template plus {@link PERIOD_NAMES}, because the
 * adjective has to agree in gender with the noun and Ukrainian gives no way to interpolate that.
 * A page that says «за останню тиждень» to a civilian reader has already told them nobody proofread
 * it, and everything else it claims is read with that in mind.
 */
const LAST_PERIOD_PHRASES_CAPITALISED: Record<AttackPeriod, string> = {
  day: 'За останню добу',
  week: 'За останній тиждень',
  month: 'За останній місяць'
};

/**
 * Ukrainian numeric agreement: one / few / many.
 *
 * Needed because every sentence here is built around a count, and «1 повідомлень» or «2 хвиль» is
 * the exact register this project cannot afford — the whole argument of the page is that the numbers
 * were assembled carefully.
 */
export function plural(count: number, one: string, few: string, many: string): string {
  const absolute = Math.abs(count) % 100;
  if (absolute > 10 && absolute < 20) return many;
  const last = absolute % 10;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

const messagesWord = (count: number) => plural(count, 'повідомлення', 'повідомлення', 'повідомлень');
const eventsWord = (count: number) => plural(count, 'подія', 'події', 'подій');

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/**
 * The always-present caveats.
 *
 * Not a legal footer — the three sentences correspond to the three ways this page can be misread, in
 * the order a reader is likely to make the mistake: taking an open-source count for an official one,
 * taking a description of the past for a forecast, and taking a message count for a count of drones.
 */
const BASE_CAVEATS = [
  'Дані зібрано з відкритих джерел — публічних моніторингових Telegram-каналів — і згруповано '
  + 'автоматично. Це не офіційна статистика Повітряних сил і не заміна офіційним повідомленням.',
  'Це опис того, що вже сталося. Система не прогнозує наступні удари, не називає цілі й не рахує '
  + 'ймовірності.',
  'Одиниця підрахунку — повідомлення, а не засіб ураження: одну загрозу можуть згадати кілька разів, '
  + 'а частина подій у відкриті джерела не потрапляє взагалі.'
];

export interface DescribeInput {
  window: AttackAnalytics['window'];
  totals: TrendPair;
  means: MeansRow[];
  targets: TargetRow[];
  hours: HourRow[];
  directions: DirectionRow[];
  waves: AttackWave[];
  combinations: CombinationRow[];
  classifierVersions: string[];
}

/**
 * Turns the aggregates into «Патерни та ймовірна стратегія».
 *
 * Every sentence is a restatement of a number printed on the same page — nothing here infers, and
 * nothing here extrapolates forward. The verbs are chosen accordingly: «повторюється», «припадає»,
 * «зміщується», never «планує», «готує» or «очікується». Tone follows the rest of the product: this
 * is read by civilians, often at night, and a calm sentence with a number in it is worth more than a
 * dramatic one.
 */
export function describeAttacks(input: DescribeInput): AttackPatterns {
  const findings: string[] = [];
  const periodName = PERIOD_NAMES[input.window.period];

  const leading = input.means[0];
  if (leading) {
    findings.push(
      `Найчастіше повідомляли про ${leading.label}: ${leading.messages} ${messagesWord(leading.messages)} `
      + `(${round(leading.share * 100, 1)}% усіх згадок засобів).`
    );
  }

  const peak = peakHour(input.hours);
  if (peak) {
    const night = nightShare(input.hours);
    findings.push(
      `Пік повідомлень припадає на ${hourLabel(peak.hour)}–${hourLabel((peak.hour + 1) % 24)} `
      + `за київським часом (${peak.messages} ${messagesWord(peak.messages)}). `
      + `На нічні години 22:00–06:00 припадає ${round(night * 100)}% усіх повідомлень.`
    );
  }

  if (input.waves.length) {
    const durations = input.waves.map((wave) => wave.durationMinutes);
    const middle = median(durations);
    findings.push(
      `Активність згрупувалася у ${input.waves.length} `
      + `${plural(input.waves.length, 'хвилю', 'хвилі', 'хвиль')} `
      + `(проміжок тиші від ${WAVE_GAP_MINUTES} хв розділяє хвилі)`
      + (middle == null ? '.' : `, типова тривалість хвилі — ${Math.round(middle)} хв.`)
    );
  }

  const combination = input.combinations[0];
  if (combination) {
    findings.push(
      `Повторювана комбінація: ${combination.labels[0]} і ${combination.labels[1]} в одній хвилі — `
      + `${combination.waves} з ${input.waves.length} ${plural(input.waves.length, 'хвилі', 'хвиль', 'хвиль')}.`
    );
  }

  // A shift needs something to have shifted *from*. When the previous window is empty — a fresh
  // archive, or a backfill that has not reached that far — every oblast is formally «new», and
  // calling the busiest of them «зміщення фокусу» would report an artefact of the data's age as a
  // change in what is being struck.
  const hasBaseline = input.totals.previousMessages > 0;
  const rising = hasBaseline ? input.targets.filter((row) => row.trend === 'rising' || row.trend === 'new')[0] : undefined;
  const falling = hasBaseline
    ? [...input.targets].filter((row) => row.trend === 'falling' || row.trend === 'gone')
        .sort((a, b) => (a.messages - a.previousMessages) - (b.messages - b.previousMessages))[0]
    : undefined;
  const leadingTarget = input.targets[0];
  if (!hasBaseline && leadingTarget) {
    findings.push(
      `Найчастіше в повідомленнях називали: ${leadingTarget.oblastName} — ${leadingTarget.messages} `
      + `${messagesWord(leadingTarget.messages)} (${round(leadingTarget.share * 100)}% усіх згадок територій). `
      + 'Порівняти з попереднім періодом немає з чим: у ньому таких повідомлень не було.'
    );
  } else if (rising) {
    findings.push(
      `Фокус повідомлень зміщується до області: ${rising.oblastName} — `
      + `${rising.previousMessages} → ${rising.messages} ${messagesWord(rising.messages)} за ${periodName}`
      + (falling ? `, тоді як ${falling.oblastName} — ${falling.previousMessages} → ${falling.messages}.` : '.')
    );
  } else if (falling) {
    findings.push(
      `Помітне зниження: ${falling.oblastName} — ${falling.previousMessages} → ${falling.messages} `
      + `${messagesWord(falling.messages)}.`
    );
  }

  const route = input.directions[0];
  if (route) {
    findings.push(
      `Найчастіше повторюване формулювання напрямку: «${route.direction}» — ${route.messages} `
      + `${plural(route.messages, 'раз', 'рази', 'разів')}. `
      + 'Це дослівна цитата з повідомлень, а не розрахований маршрут.'
    );
  }

  if (!findings.length) {
    findings.push(
      `${LAST_PERIOD_PHRASES_CAPITALISED[input.window.period]} у відкритих джерелах не було `
      + 'повідомлень, які система розпізнала б як загрозу. Це не означає, що нічого не відбувалося.'
    );
  }

  const caveats = [...BASE_CAVEATS];
  if (input.classifierVersions.length > 1) {
    caveats.push(
      `Вікно охоплює ${input.classifierVersions.length} версії правил розпізнавання `
      + `(${input.classifierVersions.join(', ')}). Частину різниці з попереднім періодом могли `
      + 'створити зміни в наших правилах, а не в діях противника.'
    );
  }

  // Without a previous window there is no comparison to word, and the fallthrough said the worst
  // possible thing: «103 повідомлення — приблизно стільки ж, скільки попереднього періоду (0)».
  // Saying plainly that the baseline is missing costs a clause and keeps the page believable.
  const trendWord = input.totals.trend === 'rising' ? 'більше, ніж попереднього'
    : input.totals.trend === 'falling' || input.totals.trend === 'gone' ? 'менше, ніж попереднього'
      : 'приблизно стільки ж, скільки попереднього';
  const comparison = input.totals.previousMessages > 0
    ? `${trendWord} періоду (${input.totals.previousMessages})`
    : input.totals.messages > 0
      ? 'за попередній такий самий період у нас таких повідомлень немає, тож порівняння тут не буде'
      : 'як і попереднього періоду, жодного';
  return {
    headline: `За ${periodName}: ${input.totals.messages} ${messagesWord(input.totals.messages)} про загрозу, `
      + `${input.totals.eventsRaised} ${plural(input.totals.eventsRaised, 'окрема', 'окремі', 'окремих')} `
      + `${eventsWord(input.totals.eventsRaised)} — ${comparison}.`,
    findings,
    caveats
  };
}

// ------------------------------------------------------------------------------------------------
// SQL
// ------------------------------------------------------------------------------------------------

/**
 * Decisions that mean "this message asserted a threat". Mirrors `analytics-archive.ts`.
 *
 * Exported because a second reader of the same archive arrived: anything that counts what the
 * channels asserted over a window has to draw the same line between an assertion and a refusal, and
 * a second literal list would be a second definition of "attack" that drifts silently. Whoever adds
 * a decision word to `message_classifications.decision` changes the meaning of every number on the
 * attacks page, and this is the one place that says so.
 */
export const ASSERTING_DECISIONS = ['event_created', 'event_merged', 'redirect'];

/**
 * Rolls the places named inside the window up to their oblast.
 *
 * Same seeded climb as `analytics-archive.ts` uses, and seeded for the same reason: after the KATOTTG
 * import the catalogue is tens of thousands of rows, and recursing from all of them would make every
 * request on this public page pay for a walk of the whole country.
 */
const OBLAST_ROLLUP = `
climb(location_id,node_id,node_type,depth,path) AS (
    SELECT s.location_id,l.id,l.type,0,ARRAY[l.id]
    FROM seed s JOIN locations l ON l.id=s.location_id
  UNION ALL
    SELECT c.location_id,parent.id,parent.type,c.depth+1,c.path||parent.id
    FROM climb c
    JOIN locations child ON child.id=c.node_id
    JOIN locations parent ON parent.id=child.parent_id
    WHERE c.depth<8 AND NOT (parent.id=ANY(c.path))
),
oblast_of AS (
  SELECT DISTINCT ON (location_id) location_id, node_id AS oblast_id
  FROM climb WHERE node_type IN ('oblast','special_city','country')
  ORDER BY location_id, depth
)`;

/**
 * `candidate_threat_types` is what a message actually matched, before the pipeline collapsed a mixed
 * report into the aggregate `combined`. Reading the collapsed column instead would make every
 * combined strike disappear from the per-class breakdown, which is precisely the breakdown this page
 * is for. The fallback keeps pre-012 rows, which have an empty array, from vanishing.
 */
const TYPES_EXPRESSION = `
  CASE WHEN cardinality(mc.candidate_threat_types) > 0 THEN mc.candidate_threat_types
       ELSE ARRAY[COALESCE(mc.threat_type,'unknown')] END`;

/** One aggregate row as the dimension query emits it. Exported so tests can build fixtures of it. */
export interface DimensionRow {
  dimension: string;
  key: string;
  label: string | null;
  current_messages: number;
  current_events: number;
  previous_messages: number;
  previous_events: number;
}

async function dimensions(window: AttackWindow): Promise<DimensionRow[]> {
  const measures = (alias: string) => `
    count(*) FILTER (WHERE ${alias}.is_current)::int AS current_messages,
    count(*) FILTER (WHERE ${alias}.is_current AND ${alias}.created_event)::int AS current_events,
    count(*) FILTER (WHERE NOT ${alias}.is_current)::int AS previous_messages,
    count(*) FILTER (WHERE NOT ${alias}.is_current AND ${alias}.created_event)::int AS previous_events`;

  const sql = `
WITH RECURSIVE base AS (
  SELECT mc.id, mc.published_at, mc.created_event, mc.national_scope, mc.classifier_version,
         mc.direction_text, (mc.published_at >= $2) AS is_current,
         ${TYPES_EXPRESSION} AS types
  FROM message_classifications mc
  -- published_at bounds the WINDOW, classified_at bounds the HOLD. See AttackWindow.cutoffAt:
  -- gating the hold on the publisher's own timestamp lets a message we learned of a second ago into
  -- the public aggregate the moment it is classified, which is a side channel around the fifteen
  -- seconds every other public surface is applying to the very same message.
  WHERE mc.published_at >= $1 AND mc.published_at < $3 AND mc.classified_at <= $6
    AND mc.decision = ANY($4::text[])
),
placed AS (
  SELECT b.id, cl.location_id
  FROM base b
  JOIN message_classification_locations cl ON cl.classification_id=b.id AND cl.role='asserted'
),
seed AS (SELECT DISTINCT location_id FROM placed),
${OBLAST_ROLLUP},
by_oblast AS (
  SELECT DISTINCT b.id, b.is_current, b.created_event,
         COALESCE(o.oblast_id, CASE WHEN b.national_scope THEN 'ua' END) AS oblast_id
  FROM base b
  LEFT JOIN placed p ON p.id=b.id
  LEFT JOIN oblast_of o ON o.location_id=p.location_id
)
SELECT 'total' AS dimension, 'all' AS key, NULL::text AS label, ${measures('b')}
FROM base b
UNION ALL
SELECT 'means', t, NULL, ${measures('b')}
FROM base b CROSS JOIN LATERAL unnest(b.types) AS t
GROUP BY 2
UNION ALL
SELECT 'oblast', d.oblast_id, l.name_uk, ${measures('d')}
FROM by_oblast d JOIN locations l ON l.id=d.oblast_id
WHERE d.oblast_id IS NOT NULL
GROUP BY 2,3
UNION ALL
SELECT 'hour', lpad(EXTRACT(HOUR FROM b.published_at AT TIME ZONE $5::text)::int::text,2,'0'), NULL, ${measures('b')}
FROM base b
GROUP BY 2
UNION ALL
SELECT 'version', b.classifier_version, NULL, ${measures('b')}
FROM base b
GROUP BY 2
UNION ALL
SELECT * FROM (
  -- Grouped case-insensitively, displayed in a spelling that was actually observed: «Курсом на
  -- Суми» and «курсом на Суми» are one repetition, and inventing a canonical casing for a quotation
  -- would make the page show a sentence nobody published.
  SELECT 'direction' AS dimension, lower(left(btrim(b.direction_text),80)) AS key,
         min(left(btrim(b.direction_text),80)) AS label, ${measures('b')}
  FROM base b
  WHERE b.direction_text IS NOT NULL AND length(btrim(b.direction_text)) >= 3
  GROUP BY 2
  -- Only formulations that repeat are shown. Two purposes in one clause: a route is a *pattern*
  -- only if it recurs, and a phrase quoted from exactly one Telegram post has no business on a
  -- public page at all.
  HAVING count(*) FILTER (WHERE b.is_current) >= 2
  ORDER BY 4 DESC, 2
  LIMIT 12
) repeated_directions
ORDER BY 1, 4 DESC, 2`;

  return (await pool.query<DimensionRow>(sql, [
    window.previousFrom, window.from, window.to, ASSERTING_DECISIONS, window.timezone, window.cutoffAt
  ])).rows;
}

async function timeline(window: AttackWindow): Promise<TimelinePoint[]> {
  const sql = `
WITH bucketed AS (
  SELECT mc.id, mc.created_event, mc.published_at,
         to_timestamp(floor(EXTRACT(EPOCH FROM mc.published_at) / $3::double precision) * $3::double precision) AS at,
         ${TYPES_EXPRESSION} AS types
  FROM message_classifications mc
  -- Same two axes as dimensions() above: the window is published_at, the hold is classified_at.
  WHERE mc.published_at >= $1 AND mc.published_at < $2 AND mc.classified_at <= $5
    AND mc.decision = ANY($4::text[])
)
-- The spine carries the real first and last instant in each bucket, so wave boundaries are measured
-- between messages instead of between bucket edges; see clusterWaves(). The per-class rows only
-- describe composition and never decide a boundary, so they carry no timestamps.
SELECT at, NULL::text AS threat_type,
       count(*)::int AS messages,
       count(*) FILTER (WHERE created_event)::int AS events_raised,
       min(published_at) AS first_at, max(published_at) AS last_at
FROM bucketed GROUP BY 1
UNION ALL
SELECT b.at, t, count(*)::int, count(*) FILTER (WHERE b.created_event)::int,
       NULL::timestamptz, NULL::timestamptz
FROM bucketed b CROSS JOIN LATERAL unnest(b.types) AS t
GROUP BY 1,2
ORDER BY 1, 2 NULLS FIRST`;

  const rows = (await pool.query<{
    at: Date; threat_type: string | null; messages: number; events_raised: number;
    first_at: Date | null; last_at: Date | null;
  }>(sql, [window.from, window.to, window.bucketMinutes * 60, ASSERTING_DECISIONS, window.cutoffAt])).rows;
  return rows.map((row) => ({
    at: row.at.toISOString(),
    threatType: row.threat_type,
    messages: row.messages,
    eventsRaised: row.events_raised,
    firstAt: row.first_at?.toISOString() ?? null,
    lastAt: row.last_at?.toISOString() ?? null
  }));
}

// ------------------------------------------------------------------------------------------------
// Composition
// ------------------------------------------------------------------------------------------------

/**
 * Assembles the finished payload from the two statements above.
 *
 * Exported separately from {@link attackAnalytics} so the integration suite can feed it real query
 * output and the unit suite can feed it fixtures: everything between the database and the response
 * is pure.
 */
export function composeAttackAnalytics(
  window: AttackWindow, rows: DimensionRow[], points: TimelinePoint[], now = new Date()
): AttackAnalytics {
  const pick = (dimension: string) => rows.filter((row) => row.dimension === dimension);

  const totalRow = pick('total')[0];
  const totals = trendPair(
    totalRow?.current_messages ?? 0, totalRow?.current_events ?? 0,
    totalRow?.previous_messages ?? 0, totalRow?.previous_events ?? 0
  );

  const meansRows = pick('means');
  const meansTotal = meansRows.reduce((sum, row) => sum + row.current_messages, 0);
  const means: MeansRow[] = meansRows
    .map((row) => ({
      threatType: row.key,
      label: threatLabel(row.key),
      share: meansTotal ? round(row.current_messages / meansTotal, 4) : 0,
      ...trendPair(row.current_messages, row.current_events, row.previous_messages, row.previous_events)
    }))
    .filter((row) => row.messages > 0 || row.previousMessages > 0)
    .sort((a, b) => b.messages - a.messages || a.threatType.localeCompare(b.threatType));

  const targetRows = pick('oblast');
  const targetTotal = targetRows.reduce((sum, row) => sum + row.current_messages, 0);
  const targets: TargetRow[] = targetRows
    .map((row) => ({
      oblastId: row.key,
      oblastName: row.label ?? row.key,
      share: targetTotal ? round(row.current_messages / targetTotal, 4) : 0,
      ...trendPair(row.current_messages, row.current_events, row.previous_messages, row.previous_events)
    }))
    .filter((row) => row.messages > 0 || row.previousMessages > 0)
    .sort((a, b) => b.messages - a.messages || a.oblastId.localeCompare(b.oblastId));

  // Every hour of the clock is present even when nothing happened in it: a bar chart with holes in
  // it reads as missing data, and "нічого не було о 04:00" is itself information.
  const hourCounts = new Map(pick('hour').map((row) => [Number(row.key), row]));
  const hours: HourRow[] = Array.from({ length: 24 }, (_unused, hour) => ({
    hour,
    messages: hourCounts.get(hour)?.current_messages ?? 0,
    eventsRaised: hourCounts.get(hour)?.current_events ?? 0
  }));

  const directions: DirectionRow[] = pick('direction')
    .map((row) => ({ direction: row.label ?? row.key, messages: row.current_messages, previousMessages: row.previous_messages }))
    .filter((row) => row.messages >= 2)
    .sort((a, b) => b.messages - a.messages || a.direction.localeCompare(b.direction));

  const waves = clusterWaves(points, { bucketMinutes: window.bucketMinutes });
  const combinations = repeatedCombinations(waves);
  const classifierVersions = pick('version')
    .filter((row) => row.current_messages > 0)
    .map((row) => row.key)
    .filter(Boolean)
    .sort();

  const serialisedWindow = {
    period: window.period,
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    previousFrom: window.previousFrom.toISOString(),
    bucketMinutes: window.bucketMinutes,
    timezone: window.timezone
  };

  return {
    window: serialisedWindow,
    totals,
    means,
    targets,
    hours,
    directions,
    waves,
    combinations,
    patterns: describeAttacks({
      window: serialisedWindow, totals, means, targets, hours, directions, waves, combinations, classifierVersions
    }),
    classifierVersions,
    generatedAt: now.toISOString()
  };
}

// ------------------------------------------------------------------------------------------------
// Entry point and cache
// ------------------------------------------------------------------------------------------------

/**
 * How long a computed period is reused.
 *
 * Two minutes. The page is public and the same three periods are requested by everybody, so without
 * a memo a burst of readers would turn into a burst of recursive oblast climbs. Two minutes is short
 * enough that a wave that started while somebody was reading appears on their next refresh, and long
 * enough that the archive is scanned at most thirty times an hour no matter how many readers there
 * are.
 */
export const ATTACK_CACHE_TTL_MS = 120_000;

const cache = new Map<string, { at: number; value: AttackAnalytics }>();

/** Test seam: the memo would otherwise carry one test's fixture into the next. */
export function resetAttackAnalyticsCache(): void {
  cache.clear();
}

export async function attackAnalytics(
  period: AttackPeriod, now: Date = new Date(), mode: PublicationMode = 'live',
  cutoffAt: Date = now
): Promise<AttackAnalytics> {
  // The publication mode is in the KEY, not only in the window. A flip moves the window end by the
  // hold length, and a memo keyed on the period alone would serve the other mode's answer for up to
  // two minutes after the operator changed their mind — the hold simply would not take effect on
  // this surface.
  const key = `${period}|${mode}`;
  const cached = cache.get(key);
  if (cached && now.getTime() - cached.at < ATTACK_CACHE_TTL_MS) return cached.value;

  const window = resolveAttackWindow(period, now, cutoffAt);
  const [rows, points] = await Promise.all([dimensions(window), timeline(window)]);
  const value = composeAttackAnalytics(window, rows, points, now);
  cache.set(key, { at: now.getTime(), value });
  return value;
}
