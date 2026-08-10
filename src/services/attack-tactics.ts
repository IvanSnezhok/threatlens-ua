import { createHash } from 'node:crypto';
import { Counter, Gauge } from 'prom-client';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import {
  ASSERTING_DECISIONS, clusterWaves, median, plural, threatLabel, type AttackWave, type TimelinePoint
} from './attack-analytics.js';
import { writeTacticsCommentary } from './attack-tactics-commentary.js';

/**
 * What changed in the last twenty-four hours, against the fortnight before it.
 *
 * ================================================================================================
 * The question this module asks, and the one it refuses to
 * ================================================================================================
 *
 * `attack-analytics.ts` answers *what has been flying* over a day, a week or a month. It is a
 * description of a window, and a reader comparing two of its tabs is doing the comparison
 * themselves — badly, because the windows overlap and the denominators differ.
 *
 * This module asks the next question and answers it once, in SQL: **what is different about the
 * last day**. Two windows, no overlap — CURRENT is `[now-24h, now)`, BASELINE is `[now-15d, now-24h)`
 * — a fixed set of seven comparisons, each with a threshold that was chosen before the data was
 * looked at, and a deterministic Ukrainian sentence per finding. Nothing is emitted when the current
 * window is too thin to compare ({@link TACTICS_MIN_CURRENT_MESSAGES}), because "the share of
 * ballistics doubled" over seven messages is a sentence about the weather in a monitoring channel.
 *
 * The question it refuses is the obvious next one. A detection says *«частка змінилася з 31% до
 * 52%»*; it never says what that implies about tonight. The tense is the whole product: everything
 * here is `derived` — arithmetic over messages already ingested, already classified and already
 * counted on the public page — and `derived` is publishable precisely because it makes no claim
 * about anything that has not happened. The prose written beneath the detections, whether
 * deterministic or a model's rewording, is passed through `src/domain/forecast-guard.ts` and thrown
 * away entirely if it slips into the future tense.
 *
 * ================================================================================================
 * Why one row per change instead of one row per pass
 * ================================================================================================
 *
 * The pass runs as a leg of the analytics recompute, behind its own five-minute floor
 * ({@link TACTICS_PASS_FLOOR_MS}), which at the busiest is 288 passes a day. For most of them the
 * answer is exactly the answer before it. {@link tacticsDigest} fingerprints the detection set —
 * order-independent, so a reshuffle is not a change, and value-sensitive, so a moved number is —
 * and a pass whose digest matches the newest stored one moves `last_confirmed_at` and writes
 * nothing else.
 *
 * That gives the page the two timestamps it needs and a table of identical rows could not: when
 * this picture first appeared, and when it was last re-derived and found unchanged.
 *
 * ================================================================================================
 * The hold
 * ================================================================================================
 *
 * The pass computes over UNHELD data — it is internal work, and internal recomputation is never
 * delayed, exactly like the recompute worker that drives it. The hold is applied on the way out, by
 * {@link readTacticsBlock}, as `computed_at <= cutoff`. That single predicate is the entire
 * implementation: in `delayed_15s` a pass computed five seconds ago is simply not the newest row
 * the reader's query can see, and there is no second copy of anything.
 */

// ------------------------------------------------------------------------------------------------
// Windows and thresholds
// ------------------------------------------------------------------------------------------------

export const ATTACK_TACTICS_METHODOLOGY_VERSION = 'tactics-v1';

/** The window the page is about. */
export const TACTICS_CURRENT_HOURS = 24;

/**
 * The window it is compared against: fourteen whole days, ending where the current window begins.
 *
 * Fourteen and not fifteen: the baseline runs `[now-15d, now-24h)`, and the day that was subtracted
 * from it is the current window. A baseline that included the last day would be a comparison of a
 * day against itself-plus-a-fortnight, which understates every change by construction.
 */
export const TACTICS_BASELINE_DAYS = 14;

/**
 * Below this many asserting messages in the current window the pass emits NOTHING — not an empty
 * pass, not a "quiet day" row.
 *
 * Twelve is roughly half a normal night's reporting. Under it every share is a fraction with a
 * single-digit denominator, and the detections would fire on the difference between four messages
 * and seven — which is the difference between two monitoring channels being awake and one of them
 * being asleep, not a difference in how the enemy is flying.
 */
export const TACTICS_MIN_CURRENT_MESSAGES = 12;

/** A detection about a share needs this many current messages behind it before it is named. */
export const MIN_DETECTION_SUPPORT = 5;

/**
 * Below this many baseline messages, only the detections that need no baseline may fire.
 *
 * A thin baseline makes every current share look like a change, so a fresh archive or a backfill
 * that has not reached back a fortnight would otherwise publish a page full of "shifts" that are
 * artefacts of the data's age. What survives the cut is `new_*`: "this class was never named before
 * and is named now" is still true when the archive is young, because it is a statement about
 * absence rather than about a proportion.
 */
export const MIN_BASELINE_SUPPORT = 20;

/** A territory named this often in the current window and never in the baseline is worth a line. */
export const MIN_TERRITORY_EXPANSION_SUPPORT = 3;

/** A redirect corridor has to repeat before it is a corridor rather than one message. */
export const MIN_REDIRECT_CORRIDOR_SUPPORT = 3;

/**
 * The minimum gap between two passes.
 *
 * Five minutes, and its own clock, next to the risk leg's `lastRiskModelAt` and for the same reason:
 * the recompute is debounced by events, a mass attack makes events continuous, and a leg with no
 * floor of its own would run three recursive oblast climbs a minute for as long as the attack lasts.
 * Five minutes is far shorter than anything a 24-hour window can express and far longer than a
 * debounce.
 */
export const TACTICS_PASS_FLOOR_MS = 5 * 60_000;

/** How long a pass is kept. Six baselines of history; the writing leg prunes. */
export const TACTICS_RETENTION_DAYS = 90;

/** Night, as this module counts it. The same hours the attacks page shades. */
export const NIGHT_FROM_HOUR = 22;
export const NIGHT_TO_HOUR = 6;

export interface TacticsWindows {
  currentFrom: Date;
  currentTo: Date;
  baselineFrom: Date;
  baselineTo: Date;
}

export function resolveTacticsWindows(now: Date = new Date()): TacticsWindows {
  const currentTo = new Date(now.getTime());
  const currentFrom = new Date(currentTo.getTime() - TACTICS_CURRENT_HOURS * 3_600_000);
  return {
    currentFrom,
    currentTo,
    baselineFrom: new Date(currentFrom.getTime() - TACTICS_BASELINE_DAYS * 86_400_000),
    baselineTo: new Date(currentFrom.getTime())
  };
}

// ------------------------------------------------------------------------------------------------
// The aggregate the detections read
// ------------------------------------------------------------------------------------------------

export interface TacticsPair {
  current: number;
  baseline: number;
}

export interface TacticsClassRow extends TacticsPair {
  threatType: string;
  label: string;
}

export interface TacticsOblastRow extends TacticsPair {
  oblastId: string;
  oblastName: string;
}

export interface TacticsHourRow extends TacticsPair {
  hour: number;
}

export interface TacticsCorridorRow extends TacticsPair {
  fromOblastId: string;
  fromOblastName: string;
  toOblastId: string;
  toOblastName: string;
  /** Verbatim `direction_text` values, each observed at least twice in the current window. */
  directions: Array<{ text: string; messages: number }>;
}

export interface TacticsSample {
  windows: TacticsWindows;
  currentMessages: number;
  baselineMessages: number;
  classifierVersions: string[];
  classes: TacticsClassRow[];
  oblasts: TacticsOblastRow[];
  hours: TacticsHourRow[];
  currentWaves: AttackWave[];
  baselineWaves: AttackWave[];
  corridors: TacticsCorridorRow[];
}

// ------------------------------------------------------------------------------------------------
// A detection
// ------------------------------------------------------------------------------------------------

export type TacticsDetectionType =
  | 'weapon_mix_shift'
  | 'new_weapon_class'
  | 'launch_hour_shift'
  | 'territory_expansion'
  | 'territory_concentration'
  | 'wave_cadence_change'
  | 'redirect_corridor';

/**
 * Display order inside a pass.
 *
 * A fixed order rather than one sorted by effect size, because the effects are measured in three
 * different units and «0.21 of a share» is not comparable with «40 minutes» in any way a sort could
 * make honest. The order is the order a reader asks the questions in: what appeared that was not
 * there, what moved in the mix, where, how concentrated, when, in what rhythm, along which corridor.
 */
export const TACTICS_DETECTION_ORDER: readonly TacticsDetectionType[] = [
  'new_weapon_class', 'weapon_mix_shift', 'territory_expansion', 'territory_concentration',
  'launch_hour_shift', 'wave_cadence_change', 'redirect_corridor'
];

export interface TacticsDetection {
  detectionType: TacticsDetectionType;
  subjectKey: string;
  subjectLabel: string;
  unit: 'share' | 'count' | 'minutes';
  currentValue: number;
  baselineValue: number | null;
  currentSupport: number;
  baselineSupport: number;
  effect: number;
  evidence: Record<string, unknown>;
  sentence: string;
  rank: number;
}

// ------------------------------------------------------------------------------------------------
// Arithmetic
// ------------------------------------------------------------------------------------------------

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function shareOf(part: number, total: number): number {
  return total > 0 ? round(part / total, 4) : 0;
}

/** Percentage as it is PRINTED. Everything a sentence shows is also written into `evidence`. */
function percent(share: number): number {
  return round(share * 100, 1);
}

const messagesWord = (count: number) => plural(count, 'повідомлення', 'повідомлення', 'повідомлень');
const timesWord = (count: number) => plural(count, 'раз', 'рази', 'разів');

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/** Share of the hour histogram that falls into the night band. */
export function nightShareOf(counts: ReadonlyArray<{ hour: number; value: number }>): number {
  let night = 0;
  let total = 0;
  for (const row of counts) {
    total += row.value;
    if (row.hour >= NIGHT_FROM_HOUR || row.hour < NIGHT_TO_HOUR) night += row.value;
  }
  return shareOf(night, total);
}

/**
 * The busiest three-hour band, as the hour it starts at.
 *
 * Bands are fixed at 0, 3, 6 … 21 rather than a sliding window: a sliding maximum moves by one hour
 * on a single message and would report a "shift" every pass. Ties break toward the earlier band so
 * the answer does not depend on map iteration order.
 */
export function modalBandStart(counts: ReadonlyArray<{ hour: number; value: number }>): number | null {
  const bands = new Array<number>(8).fill(0);
  let total = 0;
  for (const row of counts) {
    const band = Math.floor(row.hour / 3) % 8;
    bands[band] = bands[band]! + row.value;
    total += row.value;
  }
  if (total === 0) return null;
  let best = 0;
  for (let index = 1; index < bands.length; index += 1) if (bands[index]! > bands[best]!) best = index;
  return best * 3;
}

/** Total inside the three-hour band starting at `start`. */
export function bandTotal(counts: ReadonlyArray<{ hour: number; value: number }>, start: number): number {
  let total = 0;
  for (const row of counts) if (row.hour >= start && row.hour < start + 3) total += row.value;
  return total;
}

/** Distance between two hours on a 24-hour clock, in hours, never more than 12. */
export function clockDistance(a: number, b: number): number {
  const raw = Math.abs(a - b) % 24;
  return Math.min(raw, 24 - raw);
}

// ------------------------------------------------------------------------------------------------
// The seven detections
// ------------------------------------------------------------------------------------------------

function detection(
  input: Omit<TacticsDetection, 'rank'>
): Omit<TacticsDetection, 'rank'> {
  return input;
}

function weaponMixShift(sample: TacticsSample): Array<Omit<TacticsDetection, 'rank'>> {
  const currentTotal = sample.classes.reduce((sum, row) => sum + row.current, 0);
  const baselineTotal = sample.classes.reduce((sum, row) => sum + row.baseline, 0);
  if (currentTotal === 0 || baselineTotal === 0) return [];
  return sample.classes
    .filter((row) => row.current >= MIN_DETECTION_SUPPORT && row.baseline > 0)
    .map((row) => {
      const current = shareOf(row.current, currentTotal);
      const baseline = shareOf(row.baseline, baselineTotal);
      return { row, current, baseline, effect: round(current - baseline, 4) };
    })
    .filter((entry) => Math.abs(entry.effect) >= 0.15)
    .sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect) || a.row.threatType.localeCompare(b.row.threatType))
    .slice(0, 4)
    .map(({ row, current, baseline, effect }) => {
      const evidence = {
        currentPercent: percent(current),
        baselinePercent: percent(baseline),
        currentMessages: row.current,
        baselineMessages: row.baseline,
        currentClassMentions: currentTotal,
        baselineClassMentions: baselineTotal,
        baselineDays: TACTICS_BASELINE_DAYS
      };
      return detection({
        detectionType: 'weapon_mix_shift',
        subjectKey: row.threatType,
        subjectLabel: row.label,
        unit: 'share',
        currentValue: current,
        baselineValue: baseline,
        currentSupport: row.current,
        baselineSupport: row.baseline,
        effect,
        evidence,
        sentence: `Частка класу «${row.label}» серед згадок засобів становить ${evidence.currentPercent}% `
          + `проти ${evidence.baselinePercent}% у попередні ${TACTICS_BASELINE_DAYS} діб `
          + `(${row.current} з ${currentTotal} проти ${row.baseline} з ${baselineTotal}).`
      });
    });
}

function newWeaponClass(sample: TacticsSample): Array<Omit<TacticsDetection, 'rank'>> {
  return sample.classes
    .filter((row) => row.baseline === 0 && row.current >= MIN_DETECTION_SUPPORT)
    .sort((a, b) => b.current - a.current || a.threatType.localeCompare(b.threatType))
    .slice(0, 3)
    .map((row) => {
      const evidence = {
        currentMessages: row.current,
        baselineMessages: 0,
        baselineDays: TACTICS_BASELINE_DAYS
      };
      return detection({
        detectionType: 'new_weapon_class',
        subjectKey: row.threatType,
        subjectLabel: row.label,
        unit: 'count',
        currentValue: row.current,
        baselineValue: null,
        currentSupport: row.current,
        baselineSupport: 0,
        effect: row.current,
        evidence,
        sentence: `Клас «${row.label}» зʼявився в повідомленнях уперше за ${TACTICS_BASELINE_DAYS} діб: `
          + `${row.current} ${messagesWord(row.current)} за добу проти ${0} раніше.`
      });
    });
}

function launchHourShift(sample: TacticsSample): Array<Omit<TacticsDetection, 'rank'>> {
  const current = sample.hours.map((row) => ({ hour: row.hour, value: row.current }));
  const baseline = sample.hours.map((row) => ({ hour: row.hour, value: row.baseline }));
  const currentTotal = current.reduce((sum, row) => sum + row.value, 0);
  const baselineTotal = baseline.reduce((sum, row) => sum + row.value, 0);
  if (currentTotal === 0 || baselineTotal === 0) return [];

  const found: Array<Omit<TacticsDetection, 'rank'>> = [];

  const currentNight = nightShareOf(current);
  const baselineNight = nightShareOf(baseline);
  const nightEffect = round(currentNight - baselineNight, 4);
  if (Math.abs(nightEffect) >= 0.20) {
    const evidence = {
      currentPercent: percent(currentNight),
      baselinePercent: percent(baselineNight),
      nightFromHour: NIGHT_FROM_HOUR,
      nightToHour: NIGHT_TO_HOUR,
      currentMessages: currentTotal,
      baselineMessages: baselineTotal,
      baselineDays: TACTICS_BASELINE_DAYS
    };
    found.push(detection({
      detectionType: 'launch_hour_shift',
      subjectKey: 'night',
      subjectLabel: `нічні години ${hourLabel(NIGHT_FROM_HOUR)}–${hourLabel(NIGHT_TO_HOUR)}`,
      unit: 'share',
      currentValue: currentNight,
      baselineValue: baselineNight,
      currentSupport: currentTotal,
      baselineSupport: baselineTotal,
      effect: nightEffect,
      evidence,
      sentence: `На нічні години ${hourLabel(NIGHT_FROM_HOUR)}–${hourLabel(NIGHT_TO_HOUR)} припадає `
        + `${evidence.currentPercent}% повідомлень за добу проти ${evidence.baselinePercent}% `
        + `у попередні ${TACTICS_BASELINE_DAYS} діб.`
    }));
  }

  const currentBand = modalBandStart(current);
  const baselineBand = modalBandStart(baseline);
  if (currentBand !== null && baselineBand !== null) {
    const shift = clockDistance(currentBand, baselineBand);
    const bandShare = shareOf(bandTotal(current, currentBand), currentTotal);
    if (shift >= 3 && bandShare >= 0.25) {
      const evidence = {
        currentBandStartHour: currentBand,
        currentBandEndHour: (currentBand + 3) % 24,
        baselineBandStartHour: baselineBand,
        baselineBandEndHour: (baselineBand + 3) % 24,
        shiftHours: shift,
        currentPercent: percent(bandShare),
        currentMessages: bandTotal(current, currentBand),
        windowMessages: currentTotal,
        baselineDays: TACTICS_BASELINE_DAYS
      };
      found.push(detection({
        detectionType: 'launch_hour_shift',
        subjectKey: 'band',
        subjectLabel: `тригодинна смуга ${hourLabel(currentBand)}`,
        unit: 'share',
        currentValue: bandShare,
        baselineValue: null,
        currentSupport: evidence.currentMessages,
        baselineSupport: baselineTotal,
        effect: shift,
        evidence,
        sentence: `Найактивніша тригодинна смуга змістилася на ${shift} `
          + `${plural(shift, 'годину', 'години', 'годин')}: з ${hourLabel(baselineBand)} `
          + `на ${hourLabel(currentBand)}, на неї припадає ${evidence.currentPercent}% повідомлень за добу.`
      }));
    }
  }
  return found;
}

function territoryExpansion(sample: TacticsSample): Array<Omit<TacticsDetection, 'rank'>> {
  return sample.oblasts
    .filter((row) => row.baseline === 0 && row.current >= MIN_TERRITORY_EXPANSION_SUPPORT)
    .sort((a, b) => b.current - a.current || a.oblastId.localeCompare(b.oblastId))
    .slice(0, 3)
    .map((row) => {
      const evidence = {
        currentMessages: row.current,
        baselineMessages: 0,
        baselineDays: TACTICS_BASELINE_DAYS
      };
      return detection({
        detectionType: 'territory_expansion',
        subjectKey: row.oblastId,
        subjectLabel: row.oblastName,
        unit: 'count',
        currentValue: row.current,
        baselineValue: null,
        currentSupport: row.current,
        baselineSupport: 0,
        effect: row.current,
        evidence,
        // «згадано територію: X», а не «X названо»: назви територій у каталозі мають різний рід
        // («Одеська область», «Київ», «Україна»), і будь-яке дієслово, узгоджене з підметом, буде
        // помилковим на третьому рядку з чотирьох. Двокрапка лишає назву в називному відмінку.
        sentence: `У повідомленнях уперше за ${TACTICS_BASELINE_DAYS} діб згадано територію: `
          + `${row.oblastName} — ${row.current} ${messagesWord(row.current)} за добу проти ${0} раніше.`
      });
    });
}

function territoryConcentration(sample: TacticsSample): Array<Omit<TacticsDetection, 'rank'>> {
  const currentTotal = sample.oblasts.reduce((sum, row) => sum + row.current, 0);
  const baselineTotal = sample.oblasts.reduce((sum, row) => sum + row.baseline, 0);
  if (currentTotal === 0 || baselineTotal === 0) return [];
  const leader = [...sample.oblasts]
    .sort((a, b) => b.current - a.current || a.oblastId.localeCompare(b.oblastId))[0];
  if (!leader || leader.current < MIN_DETECTION_SUPPORT) return [];
  const current = shareOf(leader.current, currentTotal);
  const baseline = shareOf(leader.baseline, baselineTotal);
  const effect = round(current - baseline, 4);
  if (Math.abs(effect) < 0.20) return [];
  const evidence = {
    currentPercent: percent(current),
    baselinePercent: percent(baseline),
    currentMessages: leader.current,
    baselineMessages: leader.baseline,
    currentTerritoryMentions: currentTotal,
    baselineTerritoryMentions: baselineTotal,
    baselineDays: TACTICS_BASELINE_DAYS
  };
  return [detection({
    detectionType: 'territory_concentration',
    subjectKey: leader.oblastId,
    subjectLabel: leader.oblastName,
    unit: 'share',
    currentValue: current,
    baselineValue: baseline,
    currentSupport: leader.current,
    baselineSupport: leader.baseline,
    effect,
    evidence,
    sentence: `На найчастіше названу територію (${leader.oblastName}) припадає ${evidence.currentPercent}% `
      + `усіх згадок територій за добу проти ${evidence.baselinePercent}% у попередні `
      + `${TACTICS_BASELINE_DAYS} діб.`
  })];
}

function waveCadenceChange(sample: TacticsSample): Array<Omit<TacticsDetection, 'rank'>> {
  const found: Array<Omit<TacticsDetection, 'rank'>> = [];
  const currentWaves = sample.currentWaves.length;
  const baselineWaves = sample.baselineWaves.length;

  if (currentWaves >= 3 && baselineWaves >= 3) {
    const currentMedian = median(sample.currentWaves.map((wave) => wave.durationMinutes)) ?? 0;
    const baselineMedian = median(sample.baselineWaves.map((wave) => wave.durationMinutes)) ?? 0;
    if (baselineMedian > 0) {
      const change = round((currentMedian - baselineMedian) / baselineMedian, 4);
      if (Math.abs(change) >= 0.40) {
        const evidence = {
          currentMedianMinutes: round(currentMedian),
          baselineMedianMinutes: round(baselineMedian),
          changePercent: percent(Math.abs(change)),
          currentWaves,
          baselineWaves,
          baselineDays: TACTICS_BASELINE_DAYS
        };
        found.push(detection({
          detectionType: 'wave_cadence_change',
          subjectKey: 'duration',
          subjectLabel: 'тривалість хвилі',
          unit: 'minutes',
          currentValue: round(currentMedian),
          baselineValue: round(baselineMedian),
          currentSupport: currentWaves,
          baselineSupport: baselineWaves,
          effect: round(currentMedian - baselineMedian),
          evidence,
          sentence: `Типова тривалість хвилі становить ${evidence.currentMedianMinutes} хв проти `
            + `${evidence.baselineMedianMinutes} хв у попередні ${TACTICS_BASELINE_DAYS} діб `
            + `(${currentWaves} ${plural(currentWaves, 'хвиля', 'хвилі', 'хвиль')} за добу, `
            + `${baselineWaves} у базовому вікні).`
        }));
      }
    }
  }

  const currentPerNight = round(currentWaves, 1);
  const baselinePerNight = round(baselineWaves / TACTICS_BASELINE_DAYS, 1);
  const effect = round(currentPerNight - baselinePerNight, 1);
  if (Math.abs(effect) >= 1.0) {
    const evidence = {
      currentWaves,
      baselineWaves,
      baselinePerNight,
      baselineDays: TACTICS_BASELINE_DAYS
    };
    found.push(detection({
      detectionType: 'wave_cadence_change',
      subjectKey: 'per_night',
      subjectLabel: 'хвиль за добу',
      unit: 'count',
      currentValue: currentPerNight,
      baselineValue: baselinePerNight,
      currentSupport: currentWaves,
      baselineSupport: baselineWaves,
      effect,
      evidence,
      sentence: `За добу повідомлення згрупувалися у ${currentWaves} `
        + `${plural(currentWaves, 'хвилю', 'хвилі', 'хвиль')}; у попередні ${TACTICS_BASELINE_DAYS} діб `
        + `на добу припадало ${baselinePerNight}.`
    }));
  }
  return found;
}

function redirectCorridor(sample: TacticsSample): Array<Omit<TacticsDetection, 'rank'>> {
  return sample.corridors
    .filter((row) => row.current >= MIN_REDIRECT_CORRIDOR_SUPPORT
      && row.baseline / TACTICS_BASELINE_DAYS <= row.current / 2)
    .sort((a, b) => b.current - a.current
      || `${a.fromOblastId}>${a.toOblastId}`.localeCompare(`${b.fromOblastId}>${b.toOblastId}`))
    .slice(0, 3)
    .map((row) => {
      const baselinePerDay = round(row.baseline / TACTICS_BASELINE_DAYS, 1);
      const evidence = {
        currentMessages: row.current,
        baselineMessages: row.baseline,
        baselinePerDay,
        baselineDays: TACTICS_BASELINE_DAYS,
        fromOblastId: row.fromOblastId,
        fromOblastName: row.fromOblastName,
        toOblastId: row.toOblastId,
        toOblastName: row.toOblastName,
        // Verbatim, and only formulations that repeated. A phrase quoted from exactly one message
        // has no business on a public page, and a paraphrase would make this a route we computed.
        directions: row.directions.slice(0, 3)
      };
      return detection({
        detectionType: 'redirect_corridor',
        subjectKey: `${row.fromOblastId}>${row.toOblastId}`,
        subjectLabel: `${row.fromOblastName} → ${row.toOblastName}`,
        unit: 'count',
        currentValue: row.current,
        baselineValue: baselinePerDay,
        currentSupport: row.current,
        baselineSupport: row.baseline,
        effect: row.current,
        evidence,
        sentence: `Перенацілення в парі «${row.fromOblastName} → ${row.toOblastName}» повторилося `
          + `за добу ${row.current} ${timesWord(row.current)}; у попередні ${TACTICS_BASELINE_DAYS} `
          + `діб — ${baselinePerDay} на добу.`
      });
    });
}

/**
 * Every detection the sample supports, ranked.
 *
 * Pure, and the whole of the analysis: the SQL above it only counts, and the storage below it only
 * writes. A test that wants to know what the engine says about a fortnight builds a
 * {@link TacticsSample} and calls this.
 */
export function detectTactics(sample: TacticsSample): TacticsDetection[] {
  const all = [
    ...newWeaponClass(sample),
    ...weaponMixShift(sample),
    ...territoryExpansion(sample),
    ...territoryConcentration(sample),
    ...launchHourShift(sample),
    ...waveCadenceChange(sample),
    ...redirectCorridor(sample)
  ];
  // A baseline too thin to compare against leaves only the detections that compare against nothing.
  const survivors = sample.baselineMessages >= MIN_BASELINE_SUPPORT
    ? all
    : all.filter((row) => row.detectionType.startsWith('new_'));
  return survivors
    .sort((a, b) =>
      TACTICS_DETECTION_ORDER.indexOf(a.detectionType) - TACTICS_DETECTION_ORDER.indexOf(b.detectionType)
      || b.currentSupport - a.currentSupport
      || a.subjectKey.localeCompare(b.subjectKey))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

// ------------------------------------------------------------------------------------------------
// The digest
// ------------------------------------------------------------------------------------------------

/**
 * The fingerprint insert-on-change compares.
 *
 * Order-independent (the parts are sorted before hashing) so a change in ranking is not a change in
 * findings, and value-sensitive to four decimal places so a share that moved by a percentage point
 * is. `rank` and `sentence` are deliberately NOT part of it: both are functions of the values above
 * them, and hashing a derived field would make a wording change look like a change in the sky.
 */
export function tacticsDigest(detections: readonly TacticsDetection[]): string {
  const parts = detections
    .map((row) => [
      row.detectionType, row.subjectKey, row.unit,
      round(row.currentValue, 4), row.baselineValue === null ? 'null' : round(row.baselineValue, 4),
      row.currentSupport, row.baselineSupport, round(row.effect, 4)
    ].join(':'))
    .sort();
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

// ------------------------------------------------------------------------------------------------
// SQL
// ------------------------------------------------------------------------------------------------

/**
 * The seeded oblast climb, identical in shape to the one `attack-analytics.ts` uses.
 *
 * Seeded from the places named inside the two windows rather than from the catalogue: after the
 * KATOTTG import the catalogue is tens of thousands of rows, and a pass that runs every five minutes
 * cannot pay for a walk of the whole country.
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

/** Same fallback as the attacks page: the classes a message matched, before the aggregate collapse. */
const TYPES_EXPRESSION = `
  CASE WHEN cardinality(mc.candidate_threat_types) > 0 THEN mc.candidate_threat_types
       ELSE ARRAY[COALESCE(mc.threat_type,'unknown')] END`;

interface DimensionRow {
  dimension: string;
  key: string;
  label: string | null;
  current_messages: number;
  baseline_messages: number;
}

async function dimensions(windows: TacticsWindows): Promise<DimensionRow[]> {
  const measures = (alias: string) => `
    count(*) FILTER (WHERE ${alias}.is_current)::int AS current_messages,
    count(*) FILTER (WHERE NOT ${alias}.is_current)::int AS baseline_messages`;

  const sql = `
WITH RECURSIVE base AS (
  SELECT mc.id, mc.published_at, mc.national_scope, mc.classifier_version,
         (mc.published_at >= $2) AS is_current,
         ${TYPES_EXPRESSION} AS types
  FROM message_classifications mc
  -- No classified_at bound: the pass is INTERNAL work and internal recomputation is never held.
  -- The hold is applied to the pass as a whole on the way out, in readTacticsBlock().
  WHERE mc.published_at >= $1 AND mc.published_at < $3
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
  SELECT DISTINCT b.id, b.is_current,
         COALESCE(o.oblast_id, CASE WHEN b.national_scope THEN 'ua' END) AS oblast_id
  FROM base b
  LEFT JOIN placed p ON p.id=b.id
  LEFT JOIN oblast_of o ON o.location_id=p.location_id
)
SELECT 'total' AS dimension, 'all' AS key, NULL::text AS label, ${measures('b')}
FROM base b
UNION ALL
SELECT 'class', t, NULL, ${measures('b')}
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
ORDER BY 1, 4 DESC, 2`;

  return (await pool.query<DimensionRow>(sql, [
    windows.baselineFrom, windows.currentFrom, windows.currentTo, ASSERTING_DECISIONS, config.APP_TIMEZONE
  ])).rows;
}

/** Fifteen minutes across both windows: the wave gap is ninety, and the exact edges come from the rows. */
const TACTICS_BUCKET_MINUTES = 15;

async function timeline(windows: TacticsWindows): Promise<TimelinePoint[]> {
  const sql = `
WITH bucketed AS (
  SELECT mc.id, mc.created_event, mc.published_at,
         to_timestamp(floor(EXTRACT(EPOCH FROM mc.published_at) / $3::double precision) * $3::double precision) AS at
  FROM message_classifications mc
  WHERE mc.published_at >= $1 AND mc.published_at < $2
    AND mc.decision = ANY($4::text[])
)
SELECT at, NULL::text AS threat_type,
       count(*)::int AS messages,
       count(*) FILTER (WHERE created_event)::int AS events_raised,
       min(published_at) AS first_at, max(published_at) AS last_at
FROM bucketed GROUP BY 1
ORDER BY 1`;

  const rows = (await pool.query<{
    at: Date; threat_type: string | null; messages: number; events_raised: number;
    first_at: Date | null; last_at: Date | null;
  }>(sql, [
    windows.baselineFrom, windows.currentTo, TACTICS_BUCKET_MINUTES * 60, ASSERTING_DECISIONS
  ])).rows;
  return rows.map((row) => ({
    at: row.at.toISOString(),
    threatType: row.threat_type,
    messages: row.messages,
    eventsRaised: row.events_raised,
    firstAt: row.first_at?.toISOString() ?? null,
    lastAt: row.last_at?.toISOString() ?? null
  }));
}

interface CorridorSqlRow {
  from_id: string;
  from_name: string;
  to_id: string;
  to_name: string;
  current_messages: number;
  baseline_messages: number;
  directions: Array<{ text: string; messages: number }>;
}

/**
 * Redirect corridors: the oblast a message took a threat back FROM and the one it named instead.
 *
 * `decision = 'redirect'` is the only decision that asserts and withdraws in the same message, which
 * is why migration 012 gave `message_classification_locations` a `role` at all. Nothing here is a
 * route: the pair is two places the same message named in two opposite roles, and the quotations
 * carried alongside it are exactly what the channel wrote.
 */
async function corridors(windows: TacticsWindows): Promise<CorridorSqlRow[]> {
  const sql = `
WITH RECURSIVE base AS (
  SELECT mc.id, mc.published_at, mc.direction_text, (mc.published_at >= $2) AS is_current
  FROM message_classifications mc
  WHERE mc.published_at >= $1 AND mc.published_at < $3 AND mc.decision = 'redirect'
),
placed AS (
  SELECT b.id, cl.location_id, cl.role
  FROM base b
  JOIN message_classification_locations cl ON cl.classification_id=b.id
),
seed AS (SELECT DISTINCT location_id FROM placed),
${OBLAST_ROLLUP},
roles AS (
  SELECT DISTINCT b.id, b.is_current, b.direction_text, p.role, o.oblast_id
  FROM base b
  JOIN placed p ON p.id=b.id
  JOIN oblast_of o ON o.location_id=p.location_id
),
pairs AS (
  SELECT r.id, r.is_current, r.direction_text,
         r.oblast_id AS from_id, a.oblast_id AS to_id
  FROM roles r
  JOIN roles a ON a.id=r.id AND a.role='asserted'
  WHERE r.role='retracted' AND r.oblast_id <> a.oblast_id
),
totals AS (
  SELECT from_id, to_id,
         count(*) FILTER (WHERE is_current)::int AS current_messages,
         count(*) FILTER (WHERE NOT is_current)::int AS baseline_messages
  FROM pairs GROUP BY 1,2
),
-- Grouped case-insensitively, shown in a spelling that was actually published; only formulations
-- that repeated at least twice inside the current window are kept.
phrases AS (
  SELECT from_id, to_id, lower(btrim(direction_text)) AS key,
         min(btrim(direction_text)) AS text, count(*)::int AS messages
  FROM pairs
  WHERE is_current AND direction_text IS NOT NULL AND length(btrim(direction_text)) >= 3
  GROUP BY 1,2,3
  HAVING count(*) >= 2
)
SELECT t.from_id, lf.name_uk AS from_name, t.to_id, lt.name_uk AS to_name,
       t.current_messages, t.baseline_messages,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object('text', p.text, 'messages', p.messages))
         FROM (
           SELECT text, messages FROM phrases ph
           WHERE ph.from_id=t.from_id AND ph.to_id=t.to_id
           ORDER BY messages DESC, text
           LIMIT 3
         ) p
       ), '[]'::jsonb) AS directions
FROM totals t
JOIN locations lf ON lf.id=t.from_id
JOIN locations lt ON lt.id=t.to_id
WHERE t.current_messages > 0
ORDER BY t.current_messages DESC, t.from_id, t.to_id`;

  return (await pool.query<CorridorSqlRow>(sql, [
    windows.baselineFrom, windows.currentFrom, windows.currentTo
  ])).rows;
}

/** The three statements, assembled into the one aggregate {@link detectTactics} reads. */
export async function loadTacticsSample(windows: TacticsWindows): Promise<TacticsSample> {
  const [rows, points, corridorRows] = await Promise.all([
    dimensions(windows), timeline(windows), corridors(windows)
  ]);
  const pick = (dimension: string) => rows.filter((row) => row.dimension === dimension);
  const totals = pick('total')[0];

  const currentFrom = windows.currentFrom.getTime();
  const split = (predicate: (at: number) => boolean) =>
    points.filter((point) => predicate(Date.parse(point.at)));

  const hourCounts = new Map(pick('hour').map((row) => [Number(row.key), row]));

  return {
    windows,
    currentMessages: totals?.current_messages ?? 0,
    baselineMessages: totals?.baseline_messages ?? 0,
    classifierVersions: pick('version')
      .filter((row) => row.current_messages > 0 || row.baseline_messages > 0)
      .map((row) => row.key)
      .filter(Boolean)
      .sort(),
    classes: pick('class')
      .map((row) => ({
        threatType: row.key, label: threatLabel(row.key),
        current: row.current_messages, baseline: row.baseline_messages
      }))
      .sort((a, b) => b.current - a.current || a.threatType.localeCompare(b.threatType)),
    oblasts: pick('oblast')
      .map((row) => ({
        oblastId: row.key, oblastName: row.label ?? row.key,
        current: row.current_messages, baseline: row.baseline_messages
      }))
      .sort((a, b) => b.current - a.current || a.oblastId.localeCompare(b.oblastId)),
    hours: Array.from({ length: 24 }, (_unused, hour) => ({
      hour,
      current: hourCounts.get(hour)?.current_messages ?? 0,
      baseline: hourCounts.get(hour)?.baseline_messages ?? 0
    })),
    currentWaves: clusterWaves(split((at) => at >= currentFrom), { bucketMinutes: TACTICS_BUCKET_MINUTES }),
    baselineWaves: clusterWaves(split((at) => at < currentFrom), { bucketMinutes: TACTICS_BUCKET_MINUTES }),
    corridors: corridorRows.map((row) => ({
      fromOblastId: row.from_id, fromOblastName: row.from_name,
      toOblastId: row.to_id, toOblastName: row.to_name,
      current: row.current_messages, baseline: row.baseline_messages,
      directions: Array.isArray(row.directions) ? row.directions : []
    }))
  };
}

// ------------------------------------------------------------------------------------------------
// Metrics
// ------------------------------------------------------------------------------------------------

/**
 * Declared here, next to the pass they count, and registered by
 * `registerAnalyticsSchedulerMetrics` — the same arrangement `codexCooldownSkips` has, and for the
 * same reason: the scheduler already imports this module, so the import the other way would be a
 * cycle.
 */
export const tacticsPassTotal = new Counter({
  name: 'threatlens_attack_tactics_pass_total',
  help: 'Tactical comparison passes, by how they ended',
  labelNames: ['outcome'],
  registers: []
});

export const tacticsDetectionsGauge = new Gauge({
  name: 'threatlens_attack_tactics_detections',
  help: 'Detections in the newest stored tactical pass, by type',
  labelNames: ['type'],
  registers: []
});

// ------------------------------------------------------------------------------------------------
// The pass
// ------------------------------------------------------------------------------------------------

export type TacticsTrigger = 'event' | 'manual' | 'schedule';

export interface TacticsCommentaryText {
  headline: string;
  findings: string[];
  caveats: string[];
}

export interface TacticsCommentaryOutcome extends TacticsCommentaryText {
  generatedBy: 'deterministic' | 'model';
  aiGenerated: boolean;
  model: string | null;
  rejectionReason: string | null;
  aiRunId?: string | null;
}

export interface TacticsPassFacts {
  methodologyVersion: string;
  windows: {
    currentFrom: string;
    currentTo: string;
    baselineFrom: string;
    baselineTo: string;
    currentHours: number;
    baselineDays: number;
  };
  totals: { currentMessages: number; baselineMessages: number };
  classifierVersions: string[];
  detections: TacticsDetection[];
}

export interface TacticsPassResult {
  outcome: 'changed' | 'unchanged' | 'insufficient' | 'failed';
  passId: string | null;
  digest: string | null;
  detections: number;
  currentMessages: number;
}

export interface TacticsPassOptions {
  now?: Date;
  /**
   * The commentary writer, injected. Defaults to the module in
   * `src/services/attack-tactics-commentary.ts`, which is where the Codex gate, the cooldown and
   * the four rejection checks live. A test that wants the storage behaviour without a model passes
   * its own.
   */
  commentary?: (facts: TacticsPassFacts) => Promise<TacticsCommentaryOutcome>;
}

/** The facts a commentary writer is allowed to see: the detections of this pass and nothing else. */
export function tacticsPassFacts(
  windows: TacticsWindows, sample: TacticsSample, detections: TacticsDetection[]
): TacticsPassFacts {
  return {
    methodologyVersion: ATTACK_TACTICS_METHODOLOGY_VERSION,
    windows: {
      currentFrom: windows.currentFrom.toISOString(),
      currentTo: windows.currentTo.toISOString(),
      baselineFrom: windows.baselineFrom.toISOString(),
      baselineTo: windows.baselineTo.toISOString(),
      currentHours: TACTICS_CURRENT_HOURS,
      baselineDays: TACTICS_BASELINE_DAYS
    },
    totals: { currentMessages: sample.currentMessages, baselineMessages: sample.baselineMessages },
    classifierVersions: sample.classifierVersions,
    detections
  };
}

async function insertPass(
  windows: TacticsWindows, sample: TacticsSample, detections: TacticsDetection[],
  digest: string, trigger: TacticsTrigger, commentary: TacticsCommentaryOutcome, now: Date
): Promise<string> {
  const passId = (await pool.query<{ id: string }>(
    `INSERT INTO attack_tactic_passes(digest,computed_at,last_confirmed_at,methodology_version,
       current_from,current_to,baseline_from,baseline_to,current_messages,baseline_messages,
       classifier_versions,trigger,commentary,commentary_origin,commentary_model,
       commentary_rejection_reason,ai_run_id)
     VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16)
     RETURNING id`,
    [
      digest, now, ATTACK_TACTICS_METHODOLOGY_VERSION,
      windows.currentFrom, windows.currentTo, windows.baselineFrom, windows.baselineTo,
      sample.currentMessages, sample.baselineMessages, sample.classifierVersions, trigger,
      JSON.stringify({
        headline: commentary.headline, findings: commentary.findings, caveats: commentary.caveats
      }),
      commentary.generatedBy, commentary.model, commentary.rejectionReason,
      commentary.aiRunId ?? null
    ]
  )).rows[0]!.id;

  for (const row of detections) {
    await pool.query(
      `INSERT INTO attack_tactic_detections(pass_id,detection_type,subject_key,subject_label,unit,
         current_value,baseline_value,current_support,baseline_support,effect,evidence,sentence,rank)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)`,
      [
        passId, row.detectionType, row.subjectKey, row.subjectLabel, row.unit,
        row.currentValue, row.baselineValue, row.currentSupport, row.baselineSupport, row.effect,
        JSON.stringify(row.evidence), row.sentence, row.rank
      ]
    );
  }
  return passId;
}

/**
 * One tactical pass.
 *
 * Never throws: it is a leg of the recompute, and a leg that raises would cost the pass the
 * `analytics.updated` row and everything after it. Every exit is counted.
 *
 * The order of the two writes matters. The pass is INSERTed with its deterministic commentary
 * already in place, and the model — when a model is involved at all — replaces it with a second
 * statement afterwards. A crash between the two leaves a complete, readable, honestly labelled pass
 * rather than a row with an empty paragraph in it.
 */
export async function runTacticsPass(
  trigger: TacticsTrigger, options: TacticsPassOptions = {}
): Promise<TacticsPassResult> {
  const now = options.now ?? new Date();
  const windows = resolveTacticsWindows(now);
  try {
    const sample = await loadTacticsSample(windows);
    if (sample.currentMessages < TACTICS_MIN_CURRENT_MESSAGES) {
      tacticsPassTotal.inc({ outcome: 'insufficient' });
      return {
        outcome: 'insufficient', passId: null, digest: null, detections: 0,
        currentMessages: sample.currentMessages
      };
    }

    const detections = detectTactics(sample);
    const digest = tacticsDigest(detections);

    const newest = (await pool.query<{ id: string; digest: string }>(
      `SELECT id, digest FROM attack_tactic_passes ORDER BY computed_at DESC LIMIT 1`
    )).rows[0];
    if (newest?.digest === digest) {
      await pool.query(`UPDATE attack_tactic_passes SET last_confirmed_at=$2 WHERE id=$1`, [newest.id, now]);
      tacticsPassTotal.inc({ outcome: 'unchanged' });
      return {
        outcome: 'unchanged', passId: newest.id, digest, detections: detections.length,
        currentMessages: sample.currentMessages
      };
    }

    const facts = tacticsPassFacts(windows, sample, detections);
    const write = options.commentary ?? writeTacticsCommentary;
    const commentary = await write(facts);
    const passId = await insertPass(windows, sample, detections, digest, trigger, commentary, now);

    await pool.query(
      `DELETE FROM attack_tactic_passes WHERE computed_at < $1`,
      [new Date(now.getTime() - TACTICS_RETENTION_DAYS * 86_400_000)]
    );

    for (const type of TACTICS_DETECTION_ORDER) {
      tacticsDetectionsGauge.set({ type }, detections.filter((row) => row.detectionType === type).length);
    }
    tacticsPassTotal.inc({ outcome: 'changed' });
    return {
      outcome: 'changed', passId, digest, detections: detections.length,
      currentMessages: sample.currentMessages
    };
  } catch {
    tacticsPassTotal.inc({ outcome: 'failed' });
    return { outcome: 'failed', passId: null, digest: null, detections: 0, currentMessages: 0 };
  }
}

// ------------------------------------------------------------------------------------------------
// The public read
// ------------------------------------------------------------------------------------------------

export interface TacticsBlockDetection {
  detectionType: string;
  subjectKey: string;
  subjectLabel: string;
  unit: string;
  currentValue: number;
  baselineValue: number | null;
  currentSupport: number;
  baselineSupport: number;
  effect: number;
  evidence: Record<string, unknown>;
  sentence: string;
  rank: number;
}

export interface TacticsBlock {
  available: boolean;
  reason: string | null;
  dataNature: 'derived';
  methodologyVersion: string;
  computedAt: string | null;
  lastConfirmedAt: string | null;
  windows: {
    currentFrom: string; currentTo: string; baselineFrom: string; baselineTo: string;
    currentHours: number; baselineDays: number;
  } | null;
  totals: { currentMessages: number; baselineMessages: number } | null;
  classifierVersions: string[];
  detections: TacticsBlockDetection[];
  commentary: (TacticsCommentaryText & {
    generatedBy: string; aiGenerated: boolean; model: string | null; rejectionReason: string | null;
  }) | null;
}

/**
 * The one reason the block can be missing.
 *
 * A pass that found the day too thin writes nothing, and a deployment that has never run one has
 * nothing either. Both are the same sentence to a reader — «поки нема з чим порівнювати» — and
 * inventing a second code for them would be inventing a distinction the page cannot act on.
 */
export const TACTICS_UNAVAILABLE_REASON = 'insufficient_data';

function unavailable(): TacticsBlock {
  return {
    available: false,
    reason: TACTICS_UNAVAILABLE_REASON,
    dataNature: 'derived',
    methodologyVersion: ATTACK_TACTICS_METHODOLOGY_VERSION,
    computedAt: null,
    lastConfirmedAt: null,
    windows: null,
    totals: null,
    classifierVersions: [],
    detections: [],
    commentary: null
  };
}

interface PassSqlRow {
  computed_at: Date;
  last_confirmed_at: Date;
  methodology_version: string;
  current_from: Date;
  current_to: Date;
  baseline_from: Date;
  baseline_to: Date;
  current_messages: number;
  baseline_messages: number;
  classifier_versions: string[];
  commentary: TacticsCommentaryText;
  commentary_origin: string;
  commentary_model: string | null;
  commentary_rejection_reason: string | null;
  detections: Array<{
    detection_type: string; subject_key: string; subject_label: string; unit: string;
    current_value: string | number; baseline_value: string | number | null;
    current_support: number; baseline_support: number; effect: string | number;
    evidence: Record<string, unknown>; sentence: string; rank: number;
  }>;
}

/**
 * The newest pass a reader is allowed to see, with its detections, in one indexed statement.
 *
 * `computed_at <= $1` IS the publication hold on this surface — see the module header. Everything
 * else is shaping: `numeric` arrives from `pg` as a string, and a page that printed «0.5200» where
 * it meant «52%» would be undoing the care the rest of this file takes.
 */
export async function readTacticsBlock(cutoffAt: Date = new Date()): Promise<TacticsBlock> {
  const row = (await pool.query<PassSqlRow>(
    `SELECT p.computed_at, p.last_confirmed_at, p.methodology_version,
            p.current_from, p.current_to, p.baseline_from, p.baseline_to,
            p.current_messages, p.baseline_messages, p.classifier_versions,
            p.commentary, p.commentary_origin, p.commentary_model, p.commentary_rejection_reason,
            COALESCE((
              SELECT jsonb_agg(to_jsonb(d) - 'pass_id' ORDER BY d.rank)
              FROM attack_tactic_detections d WHERE d.pass_id = p.id
            ), '[]'::jsonb) AS detections
       FROM attack_tactic_passes p
      WHERE p.computed_at <= $1
      ORDER BY p.computed_at DESC
      LIMIT 1`,
    [cutoffAt]
  ).catch(() => ({ rows: [] as PassSqlRow[] }))).rows[0];
  if (!row) return unavailable();

  return {
    available: true,
    reason: null,
    dataNature: 'derived',
    methodologyVersion: row.methodology_version,
    computedAt: row.computed_at.toISOString(),
    lastConfirmedAt: row.last_confirmed_at.toISOString(),
    windows: {
      currentFrom: row.current_from.toISOString(),
      currentTo: row.current_to.toISOString(),
      baselineFrom: row.baseline_from.toISOString(),
      baselineTo: row.baseline_to.toISOString(),
      currentHours: TACTICS_CURRENT_HOURS,
      baselineDays: TACTICS_BASELINE_DAYS
    },
    totals: { currentMessages: row.current_messages, baselineMessages: row.baseline_messages },
    classifierVersions: row.classifier_versions ?? [],
    detections: (row.detections ?? []).map((detectionRow) => ({
      detectionType: detectionRow.detection_type,
      subjectKey: detectionRow.subject_key,
      subjectLabel: detectionRow.subject_label,
      unit: detectionRow.unit,
      currentValue: Number(detectionRow.current_value),
      baselineValue: detectionRow.baseline_value === null ? null : Number(detectionRow.baseline_value),
      currentSupport: detectionRow.current_support,
      baselineSupport: detectionRow.baseline_support,
      effect: Number(detectionRow.effect),
      evidence: detectionRow.evidence ?? {},
      sentence: detectionRow.sentence,
      rank: detectionRow.rank
    })),
    commentary: {
      headline: row.commentary?.headline ?? '',
      findings: row.commentary?.findings ?? [],
      caveats: row.commentary?.caveats ?? [],
      generatedBy: row.commentary_origin,
      aiGenerated: row.commentary_origin === 'model',
      model: row.commentary_model,
      rejectionReason: row.commentary_rejection_reason
    }
  };
}
