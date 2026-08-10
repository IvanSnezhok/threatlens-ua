import { z } from 'zod';
import { Counter, type Registry } from 'prom-client';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { relatedLocationsCte } from '../repositories/events.js';
import { ASSERTING_DECISIONS, clusterWaves, median, threatLabel, type TimelinePoint } from './attack-analytics.js';
import { groundedNumbers, ungroundedNumber } from './analytics-narrative.js';
import { firstForecastLexeme } from '../domain/forecast-guard.js';
import { reportedVectorsForEvents } from './threat-vectors.js';
import { codexChat } from './codex-client.js';
import { codexFeatureEnabled } from './codex-settings.js';

/**
 * Operator research: what the archive says about one oblast in one band of hours.
 *
 * ================================================================================================
 * The question, and the shape of an answer that is not a forecast
 * ================================================================================================
 *
 * An operator asks «які атаки можливі на цю ніч по Полтавщині». Every honest part of that question
 * is about the past: which classes have filled these hours over the last thirty days, what is
 * airborne right now, which oblast has historically been the one a target was redirected *from*.
 * The dishonest part is the tense, and it is the part a model will supply unprompted if it is handed
 * a table of counts and asked for prose.
 *
 * So this module refuses the only output that would make it a forecast — a probability — and answers
 * with a **band** instead: one of four closed phrases, each of which is a statement about the past or
 * the present and about nothing else. `classifyBand()` computes it from counts alone, in a pure
 * function with no model anywhere near it, and the four literals are a CHECK constraint in migration
 * 035. A model may reword the memo around them; {@link verifyResearchMemo} rejects the whole reply if
 * it moves a band by one rung, invents a class, invents a number, invents an indicator, or writes any
 * sentence {@link firstForecastLexeme} recognises.
 *
 * ================================================================================================
 * Why none of this can be seen from outside `/ops`
 * ================================================================================================
 *
 * Positional, exactly as the vector extrapolation is: the memos live in `ops_attack_research_*`
 * tables, this module is named by no module that builds a public response, and
 * `src/api/vector-isolation.test.ts` walks the import graph and the file contents on every run to
 * keep both true. The arrows point ops → public and never back: this file reads
 * `./threat-vectors.js` and `./attack-analytics.js`, and neither of them has heard of it.
 *
 * ================================================================================================
 * Never on a schedule
 * ================================================================================================
 *
 * Nothing here is wired into `recomputeAnalytics()`, into a leg, or into any timer. A memo exists
 * because an operator pressed a button, and the request row that records the press is written on
 * every path including the refusals — which is also where the daily cap and the per-oblast cooldown
 * are counted from, so a restart cannot hand anybody a fresh allowance.
 */

// ------------------------------------------------------------------------------------------------
// Vocabulary
// ------------------------------------------------------------------------------------------------

export const RESEARCH_METHODOLOGY_VERSION = 'research-v1';
export const RESEARCH_PROMPT_VERSION = 'attack-research-v1';

/**
 * The sentence that travels with every memo, deterministic or model-written.
 *
 * Stored on the row rather than rendered beside it: a memo that is copied out of the console into a
 * chat window has to carry its own framing, because the copy is exactly the moment the surrounding
 * page stops being there.
 */
export const RESEARCH_FRAMING =
  'Це операторське дослідження, не прогноз і не офіційна інформація.';

/** The one thing a reader must not do with a memo, said in the payload rather than in a runbook. */
export const RESEARCH_NOTICE =
  'Меморандум не публікується, не пересилається в канал і не цитується поза консоллю: він описує '
  + 'смугу годин у минулому, а не інтервал, у якому щось станеться.';

/**
 * The closed band enum, ordered from strongest to weakest.
 *
 * Order is load-bearing twice: {@link classifyBand} returns the first rung whose condition holds, and
 * the console renders them in this order. Adding a fifth phrase means editing this array, the CHECK
 * in migration 035 and the pin in `vector-isolation.test.ts` in one commit — which is the point.
 */
export const RESEARCH_BANDS = [
  'спостерігається',
  'типово для цього вікна',
  'нетипово, але траплялося',
  'у цьому вікні не фіксували'
] as const;
export type ResearchBand = (typeof RESEARCH_BANDS)[number];

export const RESEARCH_WINDOWS = ['night', 'day', 'next12h'] as const;
export type ResearchWindowName = (typeof RESEARCH_WINDOWS)[number];

export function isResearchWindow(value: unknown): value is ResearchWindowName {
  return typeof value === 'string' && (RESEARCH_WINDOWS as readonly string[]).includes(value);
}

/** How far back the archive is read for the per-class counts. */
export const RESEARCH_HISTORY_DAYS = 30;
/** How far back the national indicator list is read. Shorter: an indicator is a current pattern. */
export const RESEARCH_INDICATOR_DAYS = 7;
/** A live classification this recent counts as «зараз», with no event needed. */
export const RESEARCH_LIVE_MINUTES = 90;
/** Below this many messages over thirty days the sample cannot support `medium`. */
export const RESEARCH_MEDIUM_MIN_MESSAGES = 50;
/** `типово для цього вікна` needs both of these. */
export const RESEARCH_TYPICAL_MIN_COUNT = 3;
export const RESEARCH_TYPICAL_MIN_SHARE = 0.15;
/** Wave clustering over the band, in minutes. */
export const RESEARCH_BUCKET_MINUTES = 10;
/** Rows kept. Older requests, and the memos hanging off them, are pruned. */
export const RESEARCH_RETENTION_DAYS = 90;

// ------------------------------------------------------------------------------------------------
// Metrics
// ------------------------------------------------------------------------------------------------

export type ResearchOutcomeLabel =
  | 'ok' | 'model_rejected' | 'refused_disabled' | 'refused_cooldown' | 'refused_daily_cap' | 'failed';

export const attackResearchRuns = new Counter({
  name: 'threatlens_attack_research_runs_total',
  help: 'Operator research requests by outcome, refusals included',
  labelNames: ['outcome'],
  registers: []
});

export function registerAttackResearchMetrics(registry: Registry): void {
  if (!registry.getSingleMetric('threatlens_attack_research_runs_total')) {
    registry.registerMetric(attackResearchRuns);
  }
}

// ------------------------------------------------------------------------------------------------
// Windows — a band of hours in the archive, never a predicted interval
// ------------------------------------------------------------------------------------------------

export interface ResearchWindow {
  window: ResearchWindowName;
  label: string;
  /** The wall-clock pair the label names. Descriptive: the history is read by {@link hours}. */
  from: string;
  to: string;
  /** The Kyiv hours this window covers. THIS is what selects rows from the archive. */
  hours: number[];
}

/** What the wall clock in `timezone` reads at `at`. */
function wallClock(at: Date, timezone: string): { year: number; month: number; day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit'
  }).formatToParts(at);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  // Some ICU builds render midnight as «24» under hour12:false; the modulo is what keeps that from
  // becoming a day that is 24 hours long.
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour') % 24 };
}

/** The instant at which the wall clock in `timezone` reads the given local time. */
function instantAt(
  wall: { year: number; month: number; day: number; hour: number }, timezone: string
): Date {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, 0, 0);
  // Two passes rather than one: the offset has to be sampled at an instant close to the answer, and
  // the first pass is what produces one. Across a DST change the second pass lands on the right side.
  let instant = naive;
  for (let pass = 0; pass < 2; pass += 1) {
    const sampled = wallClock(new Date(instant), timezone);
    const asUtc = Date.UTC(sampled.year, sampled.month - 1, sampled.day, sampled.hour, 0, 0);
    instant = naive - (asUtc - instant);
  }
  return new Date(instant);
}

function shiftDays(wall: { year: number; month: number; day: number; hour: number }, days: number) {
  const moved = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return {
    year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(), hour: wall.hour
  };
}

function hourRange(from: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => (from + index) % 24);
}

const NIGHT_HOURS = hourRange(22, 8);   // 22:00 → 06:00
const DAY_HOURS = hourRange(6, 16);     // 06:00 → 22:00

/**
 * Which band of hours a request names, and which wall-clock pair to call it by.
 *
 * The pair is a *label*. The archive is read by {@link ResearchWindow.hours} — the same eight hours
 * of every one of the last thirty days — because the claim a memo is allowed to make is «ці години
 * виглядали так», not «між 22:00 і 06:00 станеться». Naming the window after the coming night is a
 * convenience for the operator reading it, and it is the only thing about the future in this module.
 */
export function resolveResearchWindow(
  window: ResearchWindowName, now: Date, timezone: string = config.APP_TIMEZONE
): ResearchWindow {
  const wall = wallClock(now, timezone);
  if (window === 'next12h') {
    const to = new Date(now.getTime() + 12 * 3_600_000);
    return {
      window, label: 'найближча смуга: 12 годин від поточної',
      from: now.toISOString(), to: to.toISOString(), hours: hourRange(wall.hour, 12)
    };
  }
  if (window === 'night') {
    // Before 06:00 the operator is standing inside the night; after that the next one is meant.
    const start = wall.hour < 6 ? shiftDays(wall, -1) : wall;
    const from = instantAt({ ...start, hour: 22 }, timezone);
    const to = instantAt({ ...shiftDays(start, 1), hour: 6 }, timezone);
    return {
      window, label: 'нічна смуга 22:00–06:00',
      from: from.toISOString(), to: to.toISOString(), hours: NIGHT_HOURS
    };
  }
  // The day band: today's when the clock has not yet passed 22:00, tomorrow's once it has.
  const start = wall.hour >= 22 ? shiftDays(wall, 1) : wall;
  const from = instantAt({ ...start, hour: 6 }, timezone);
  const to = instantAt({ ...start, hour: 22 }, timezone);
  return {
    window, label: 'денна смуга 06:00–22:00',
    from: from.toISOString(), to: to.toISOString(), hours: DAY_HOURS
  };
}

// ------------------------------------------------------------------------------------------------
// The band — the whole of what this surface asserts
// ------------------------------------------------------------------------------------------------

export interface BandInput {
  /** A live event of this class covers the oblast, or a classification landed within 90 minutes. */
  observedNow: boolean;
  /** Messages of this class inside the hour band over thirty days. */
  windowMessages: number;
  /** That count as a share of every message in the band, 0..1. */
  windowShare: number;
}

/**
 * Pure. The first rung whose condition holds, in the order {@link RESEARCH_BANDS} declares.
 *
 * Every rung is a sentence about the past or the present, and the thresholds are deliberately blunt:
 * three messages and a fifteen-percent share is the difference between «this is what these hours are
 * made of» and «this happened once», and refining it further would be pretending the archive
 * supports a precision it does not. Nothing here looks at a trend, a direction or a rate of change —
 * those are the shapes an extrapolation is built from.
 */
export function classifyBand(input: BandInput): ResearchBand {
  if (input.observedNow) return 'спостерігається';
  if (input.windowMessages >= RESEARCH_TYPICAL_MIN_COUNT && input.windowShare >= RESEARCH_TYPICAL_MIN_SHARE) {
    return 'типово для цього вікна';
  }
  if (input.windowMessages >= 1) return 'нетипово, але траплялося';
  return 'у цьому вікні не фіксували';
}

// ------------------------------------------------------------------------------------------------
// The evidence pack
// ------------------------------------------------------------------------------------------------

export interface ResearchClassFact {
  threatType: string;
  label: string;
  observedNow: boolean;
  windowMessages: number;
  windowShare: number;
  baselineSupport: number;
  /** Whole days since the last message of this class inside the band; null when there is none. */
  lastInWindowDaysAgo: number | null;
  band: ResearchBand;
}

export interface ResearchPack {
  oblast: { id: string; name: string };
  window: ResearchWindow;
  methodologyVersion: string;
  computedAt: string;
  confidence: 'low' | 'medium';
  now: {
    alerts: Array<{ locationName: string; alertType: string; startedAt: string }>;
    liveThreats: Array<{ threatType: string; label: string; status: string; evidenceLevel: string }>;
    /** Public observation chains, from `threat-vectors.ts`. Never an ops projection. */
    chains: Array<{ threatType: string; label: string; places: string[] }>;
    risk: Array<{ locationName: string; threatType: string; label: string; score: number; level: string }>;
    signalCounts: { hours3: number; hours6: number; hours12: number };
  };
  history: {
    days: number;
    windowMessages: number;
    baselineMessages: number;
    classifierVersions: string[];
    perClass: ResearchClassFact[];
    hours: Array<{ hour: string; messages: number }>;
    waves: { count: number; medianDurationMinutes: number | null };
    upstream: Array<{ locationName: string; occurrences: number }>;
  };
  indicators: Array<{ indicator: string; messages: number }>;
  caveats: string[];
}

interface NowRow {
  alerts: ResearchPack['now']['alerts'];
  live_threats: Array<{ eventId: string; threatType: string; status: string; evidenceLevel: string }>;
  risk: Array<{ locationName: string; threatType: string; score: string; level: string }>;
  live_classes: string[];
  signals_3h: number;
  signals_6h: number;
  signals_12h: number;
}

interface HistoryRow {
  kind: 'class' | 'hour' | 'version' | 'total' | 'indicator';
  key: string;
  in_band_messages: number;
  all_messages: number;
  last_in_band_at: Date | null;
}

interface UpstreamRow { location_name: string; occurrences: number }

/**
 * Everything the memo may be written from, in one shape.
 *
 * Four statements of its own — now-state, history plus indicators, the wave timeline, the upstream
 * redirects — plus the PUBLIC chain builder, which is called rather than reimplemented so a memo can
 * never disagree with what the map is drawing. No candidate locations, no bearings, no cones: those
 * belong to the extrapolation and are a different kind of claim.
 */
export async function buildResearchPack(
  oblastId: string, window: ResearchWindowName, now: Date = new Date()
): Promise<ResearchPack> {
  const resolved = resolveResearchWindow(window, now);
  const oblast = await pool.query<{ id: string; name_uk: string }>(
    `SELECT id,name_uk FROM locations WHERE id=$1`, [oblastId]
  );
  if (!oblast.rowCount) throw new Error(`unknown oblast ${oblastId}`);

  const nowRow = (await pool.query<NowRow>(NOW_QUERY, [oblastId, now, RESEARCH_LIVE_MINUTES])).rows[0]!;
  const history = (await pool.query<HistoryRow>(HISTORY_QUERY, [
    oblastId, now, ASSERTING_DECISIONS, RESEARCH_HISTORY_DAYS, config.APP_TIMEZONE,
    resolved.hours, RESEARCH_INDICATOR_DAYS
  ])).rows;
  const timeline = (await pool.query<{ at: Date; messages: number; first_at: Date; last_at: Date }>(
    TIMELINE_QUERY,
    [oblastId, now, ASSERTING_DECISIONS, RESEARCH_HISTORY_DAYS, config.APP_TIMEZONE,
      resolved.hours, RESEARCH_BUCKET_MINUTES * 60]
  )).rows;
  const upstream = (await pool.query<UpstreamRow>(UPSTREAM_QUERY, [oblastId, now, RESEARCH_HISTORY_DAYS])).rows;

  const chains = await reportedVectorsForEvents(nowRow.live_threats.map((threat) => threat.eventId));

  return composeResearchPack({
    oblast: { id: oblast.rows[0]!.id, name: oblast.rows[0]!.name_uk },
    window: resolved,
    now,
    nowRow,
    history,
    timeline: timeline.map((row) => ({
      at: row.at.toISOString(), threatType: null, messages: row.messages, eventsRaised: 0,
      firstAt: row.first_at?.toISOString() ?? null, lastAt: row.last_at?.toISOString() ?? null
    })),
    upstream,
    chains: chains.map((chain) => ({
      threatType: chain.threatType ?? 'unknown',
      label: threatLabel(chain.threatType ?? 'unknown'),
      places: chain.nodes.map((node) => node.name)
    }))
  });
}

export interface ComposeResearchInput {
  oblast: { id: string; name: string };
  window: ResearchWindow;
  now: Date;
  nowRow: NowRow;
  history: HistoryRow[];
  timeline: TimelinePoint[];
  upstream: UpstreamRow[];
  chains: ResearchPack['now']['chains'];
}

/** Pure: the rows above, assembled. Exported so the shape can be pinned without a database. */
export function composeResearchPack(input: ComposeResearchInput): ResearchPack {
  const rows = (kind: HistoryRow['kind']) => input.history.filter((row) => row.kind === kind);
  const total = rows('total')[0];
  const windowMessages = total?.in_band_messages ?? 0;
  const baselineMessages = total?.all_messages ?? 0;
  const liveClasses = new Set(input.nowRow.live_classes ?? []);

  const perClass: ResearchClassFact[] = rows('class')
    .map((row) => {
      const windowShare = windowMessages ? round4(row.in_band_messages / windowMessages) : 0;
      const observedNow = liveClasses.has(row.key);
      return {
        threatType: row.key,
        label: threatLabel(row.key),
        observedNow,
        windowMessages: row.in_band_messages,
        windowShare,
        baselineSupport: row.all_messages,
        lastInWindowDaysAgo: row.last_in_band_at
          ? Math.max(0, Math.floor((input.now.getTime() - new Date(row.last_in_band_at).getTime()) / 86_400_000))
          : null,
        band: classifyBand({ observedNow, windowMessages: row.in_band_messages, windowShare })
      };
    })
    // A class that is airborne right now but has never filled these hours still belongs in the memo,
    // so the sort is by band strength first and by history second.
    .sort((left, right) =>
      RESEARCH_BANDS.indexOf(left.band) - RESEARCH_BANDS.indexOf(right.band)
      || right.windowMessages - left.windowMessages
      || left.threatType.localeCompare(right.threatType));

  // A class seen live that the archive has never filed in this oblast is still a fact about now.
  for (const threatType of liveClasses) {
    if (perClass.some((entry) => entry.threatType === threatType)) continue;
    perClass.unshift({
      threatType, label: threatLabel(threatType), observedNow: true,
      windowMessages: 0, windowShare: 0, baselineSupport: 0, lastInWindowDaysAgo: null,
      band: 'спостерігається'
    });
  }

  const hourCounts = new Map(rows('hour').map((row) => [row.key, row.all_messages]));
  const hours = Array.from({ length: 24 }, (_, hour) => {
    const key = String(hour).padStart(2, '0');
    return { hour: key, messages: hourCounts.get(key) ?? 0 };
  });

  const classifierVersions = rows('version').map((row) => row.key).sort();
  const waves = clusterWaves(input.timeline, { bucketMinutes: RESEARCH_BUCKET_MINUTES });
  const waveDurations = waves.map((wave) => wave.durationMinutes);

  const liveThreats = input.nowRow.live_threats.map((threat) => ({
    threatType: threat.threatType, label: threatLabel(threat.threatType),
    status: threat.status, evidenceLevel: threat.evidenceLevel
  }));
  const alerts = input.nowRow.alerts ?? [];
  const somethingLive = liveThreats.length > 0 || alerts.length > 0;

  const confidence: 'low' | 'medium' =
    baselineMessages >= RESEARCH_MEDIUM_MIN_MESSAGES && classifierVersions.length === 1 && somethingLive
      ? 'medium'
      : 'low';

  const caveats = researchCaveats({
    baselineMessages, windowMessages, classifierVersions, somethingLive,
    upstream: input.upstream.length
  });

  return {
    oblast: input.oblast,
    window: input.window,
    methodologyVersion: RESEARCH_METHODOLOGY_VERSION,
    computedAt: input.now.toISOString(),
    confidence,
    now: {
      alerts,
      liveThreats,
      chains: input.chains,
      risk: (input.nowRow.risk ?? []).map((entry) => ({
        locationName: entry.locationName, threatType: entry.threatType,
        label: threatLabel(entry.threatType), score: Number(entry.score), level: entry.level
      })),
      signalCounts: {
        hours3: input.nowRow.signals_3h, hours6: input.nowRow.signals_6h, hours12: input.nowRow.signals_12h
      }
    },
    history: {
      days: RESEARCH_HISTORY_DAYS,
      windowMessages,
      baselineMessages,
      classifierVersions,
      perClass,
      hours,
      waves: { count: waves.length, medianDurationMinutes: median(waveDurations) },
      upstream: input.upstream.map((row) => ({
        locationName: row.location_name, occurrences: row.occurrences
      }))
    },
    indicators: rows('indicator')
      .map((row) => ({ indicator: row.key, messages: row.all_messages }))
      .sort((left, right) => right.messages - left.messages || left.indicator.localeCompare(right.indicator))
      .slice(0, 6),
    caveats
  };
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Pure. Every admission the pack has to make, in the order a reader needs them. */
export function researchCaveats(input: {
  baselineMessages: number; windowMessages: number; classifierVersions: string[];
  somethingLive: boolean; upstream: number;
}): string[] {
  const caveats = [
    'Смуга годин узята з архіву за минулі дні — це не інтервал, у якому щось станеться.'
  ];
  if (input.windowMessages === 0) {
    caveats.push('У цій смузі за весь період архів порожній, тож порівнювати класи нема з чим.');
  } else if (input.baselineMessages < RESEARCH_MEDIUM_MIN_MESSAGES) {
    caveats.push(`За період архіву в цій області ${input.baselineMessages} повідомлень — вибірка мала, `
      + 'і частки рахуються з одиниць.');
  }
  if (input.classifierVersions.length > 1) {
    caveats.push(`У вікні ${input.classifierVersions.length} версії класифікатора `
      + `(${input.classifierVersions.join(', ')}): числа до і після зміни правил не цілком порівнянні.`);
  }
  if (!input.somethingLive) {
    caveats.push('Зараз у цій області немає ні активної тривоги, ні живої події — весь меморандум спирається лише на архів.');
  }
  if (!input.upstream) {
    caveats.push('Жодного перенаправлення в цю область за період архіву не зафіксовано.');
  }
  return caveats;
}

// ------------------------------------------------------------------------------------------------
// SQL
// ------------------------------------------------------------------------------------------------

/**
 * The hierarchy walk is `relatedLocationsCte` from `src/repositories/events.ts`, unchanged.
 *
 * An oblast anchor fans out to every raion, hromada and city inside it, which is what «по
 * Полтавщині» means to somebody reading a memo — a message that named a village is a message about
 * the oblast. Writing a second walk here would be a second definition of «the same place».
 */
const NOW_QUERY = `${relatedLocationsCte('$1')}
SELECT
  (SELECT coalesce(json_agg(json_build_object(
            'locationName', l.name_uk, 'alertType', ap.alert_type, 'startedAt', ap.started_at
          ) ORDER BY ap.started_at), '[]'::json)
     FROM alert_periods ap JOIN locations l ON l.id=ap.location_id
    WHERE ap.status='active' AND ap.location_id IN (SELECT id FROM related_locations)) AS alerts,
  (SELECT coalesce(json_agg(json_build_object(
            'eventId', e.id, 'threatType', e.threat_type, 'status', e.status,
            'evidenceLevel', e.evidence_level
          ) ORDER BY e.last_observed_at DESC), '[]'::json)
     FROM threat_events e
    WHERE e.status IN ('observed','confirmed','active')
      AND e.last_observed_at > $2::timestamptz - interval '2 hours'
      AND EXISTS (SELECT 1 FROM threat_event_locations tel
                   WHERE tel.event_id=e.id
                     AND tel.location_id IN (SELECT id FROM related_locations))) AS live_threats,
  (SELECT coalesce(json_agg(json_build_object(
            'locationName', l.name_uk, 'threatType', ra.threat_type,
            'score', ra.risk_score, 'level', ra.risk_level
          ) ORDER BY ra.risk_score DESC), '[]'::json)
     FROM risk_assessments ra JOIN locations l ON l.id=ra.location_id
    WHERE ra.superseded_by IS NULL AND ra.expires_at > $2::timestamptz
      AND ra.location_id IN (SELECT id FROM related_locations)) AS risk,
  -- «Зараз» for a CLASS, which is the first rung of the band. A live event covers it, and so does a
  -- classification of the last ninety minutes that named a place in this oblast — the second is what
  -- keeps a class visible during the minutes between a message landing and an event being raised.
  (SELECT coalesce(array_agg(DISTINCT c.threat_type), '{}')
     FROM (
       SELECT e.threat_type
         FROM threat_events e
        WHERE e.status IN ('observed','confirmed','active')
          AND e.last_observed_at > $2::timestamptz - interval '2 hours'
          AND EXISTS (SELECT 1 FROM threat_event_locations tel
                       WHERE tel.event_id=e.id
                         AND tel.location_id IN (SELECT id FROM related_locations))
       UNION ALL
       SELECT t
         FROM message_classifications mc
         JOIN message_classification_locations cl
           ON cl.classification_id=mc.id AND cl.role='asserted'
         CROSS JOIN LATERAL unnest(
           CASE WHEN cardinality(mc.candidate_threat_types) > 0 THEN mc.candidate_threat_types
                ELSE ARRAY[COALESCE(mc.threat_type,'unknown')] END) AS t
        WHERE mc.published_at > $2::timestamptz - make_interval(mins => $3::int)
          AND mc.published_at <= $2::timestamptz
          AND cl.location_id IN (SELECT id FROM related_locations)
     ) c
    WHERE c.threat_type IS NOT NULL) AS live_classes,
  (SELECT count(*)::int FROM risk_signals rs
    WHERE rs.location_id IN (SELECT id FROM related_locations)
      AND rs.observed_at > $2::timestamptz - interval '3 hours'
      AND rs.observed_at <= $2::timestamptz) AS signals_3h,
  (SELECT count(*)::int FROM risk_signals rs
    WHERE rs.location_id IN (SELECT id FROM related_locations)
      AND rs.observed_at > $2::timestamptz - interval '6 hours'
      AND rs.observed_at <= $2::timestamptz) AS signals_6h,
  (SELECT count(*)::int FROM risk_signals rs
    WHERE rs.location_id IN (SELECT id FROM related_locations)
      AND rs.observed_at > $2::timestamptz - interval '12 hours'
      AND rs.observed_at <= $2::timestamptz) AS signals_12h`;

/**
 * `scoped` is DISTINCT because a message that named three villages of one oblast is one message.
 * Without it every count would be multiplied by how precisely a channel wrote, which is a property of
 * the channel and not of the night.
 */
const SCOPED_CTE = `
scoped AS (
  SELECT DISTINCT mc.id, mc.published_at, mc.classifier_version,
         CASE WHEN cardinality(mc.candidate_threat_types) > 0 THEN mc.candidate_threat_types
              ELSE ARRAY[COALESCE(mc.threat_type,'unknown')] END AS types
    FROM message_classifications mc
    JOIN message_classification_locations cl
      ON cl.classification_id=mc.id AND cl.role='asserted'
   WHERE mc.decision = ANY($3::text[])
     AND mc.published_at >= $2::timestamptz - make_interval(days => $4::int)
     AND mc.published_at < $2::timestamptz
     AND cl.location_id IN (SELECT id FROM related_locations)
),
banded AS (
  SELECT s.*, (EXTRACT(HOUR FROM s.published_at AT TIME ZONE $5::text)::int = ANY($6::int[])) AS in_band
    FROM scoped s
)`;

const HISTORY_QUERY = `${relatedLocationsCte('$1')},${SCOPED_CTE},
national AS (
  SELECT mc.id, i AS indicator
    FROM message_classifications mc
    CROSS JOIN LATERAL unnest(mc.indicators) AS i
   WHERE mc.decision = ANY($3::text[])
     AND mc.published_at >= $2::timestamptz - make_interval(days => $7::int)
     AND mc.published_at < $2::timestamptz
)
SELECT 'class' AS kind, t AS key,
       count(*) FILTER (WHERE b.in_band)::int AS in_band_messages,
       count(*)::int AS all_messages,
       max(b.published_at) FILTER (WHERE b.in_band) AS last_in_band_at
  FROM banded b CROSS JOIN LATERAL unnest(b.types) AS t
 GROUP BY 2
UNION ALL
SELECT 'hour', lpad(EXTRACT(HOUR FROM b.published_at AT TIME ZONE $5::text)::int::text, 2, '0'),
       count(*) FILTER (WHERE b.in_band)::int, count(*)::int, NULL::timestamptz
  FROM banded b GROUP BY 2
UNION ALL
SELECT 'version', b.classifier_version,
       count(*) FILTER (WHERE b.in_band)::int, count(*)::int, NULL::timestamptz
  FROM banded b GROUP BY 2
UNION ALL
SELECT 'total', 'all',
       count(*) FILTER (WHERE b.in_band)::int, count(*)::int, NULL::timestamptz
  FROM banded b
UNION ALL
SELECT 'indicator', n.indicator, 0, count(*)::int, NULL::timestamptz
  FROM national n GROUP BY 2
 ORDER BY 1, 4 DESC, 2`;

const TIMELINE_QUERY = `${relatedLocationsCte('$1')},${SCOPED_CTE}
SELECT to_timestamp(floor(EXTRACT(EPOCH FROM b.published_at) / $7::double precision) * $7::double precision) AS at,
       count(*)::int AS messages, min(b.published_at) AS first_at, max(b.published_at) AS last_at
  FROM banded b WHERE b.in_band
 GROUP BY 1 ORDER BY 1`;

/**
 * Where a target was redirected FROM, on its way here.
 *
 * One `redirect` classification retracts a place and asserts another in the same message, which is
 * the most precise movement signal the archive holds. Counting the pairs whose asserted end is inside
 * this oblast and whose retracted end is outside it answers «звідки до нас заходили» — a statement
 * about journeys that already happened, and the closest this memo comes to a direction.
 */
const UPSTREAM_QUERY = `${relatedLocationsCte('$1')}
SELECT lf.name_uk AS location_name, count(*)::int AS occurrences
  FROM message_classifications mc
  JOIN message_classification_locations ret
    ON ret.classification_id=mc.id AND ret.role='retracted'
  JOIN message_classification_locations asr
    ON asr.classification_id=mc.id AND asr.role='asserted'
  JOIN locations lf ON lf.id=ret.location_id
 WHERE mc.decision='redirect'
   AND mc.published_at >= $2::timestamptz - make_interval(days => $3::int)
   AND mc.published_at < $2::timestamptz
   AND asr.location_id IN (SELECT id FROM related_locations)
   AND ret.location_id NOT IN (SELECT id FROM related_locations)
 GROUP BY 1
 ORDER BY 2 DESC, 1
 LIMIT 6`;

// ------------------------------------------------------------------------------------------------
// The memo
// ------------------------------------------------------------------------------------------------

export interface ResearchMemo {
  summary: string;
  classes: Array<{ threatType: string; band: ResearchBand | null; rationale: string }>;
  watchIndicators: string[];
  caveats: string[];
}

export const researchMemoSchema = z.object({
  summary: z.string().min(20).max(600),
  classes: z.array(z.object({
    threatType: z.string().min(1).max(64),
    band: z.enum(RESEARCH_BANDS),
    rationale: z.string().min(10).max(400)
  })).min(1).max(10),
  watchIndicators: z.array(z.string().min(1).max(120)).max(6),
  caveats: z.array(z.string().min(1).max(300)).min(1).max(6)
});

/**
 * The baseline memo, and the reason it contains no band word at all.
 *
 * The four band phrases are the output of a judgement the deterministic path did not make in prose:
 * `classifyBand()` produced them from counts, and they are written to
 * `ops_attack_research_classes` for the audit either way. But printing «типово для цього вікна» in a
 * memo that no model reasoned over would dress arithmetic as an assessment, and an operator reading
 * two memos side by side must be able to tell which one a model wrote by reading them, not by
 * checking a badge. So the fallback states the counts and lets the reader draw the line: класс,
 * чи видно зараз, скільки за період, коли востаннє.
 *
 * Pure, and the numbers in it come only from `pack`, which is what makes it pass its own verifier.
 */
export function deterministicMemo(pack: ResearchPack): ResearchMemo {
  const live = pack.now.liveThreats.length
    ? `зараз у роботі ${pack.now.liveThreats.length} `
      + `(${pack.now.liveThreats.map((threat) => threat.label).join(', ')})`
    : 'зараз живих подій немає';
  const alerts = pack.now.alerts.length ? `тривог ${pack.now.alerts.length}` : 'тривоги немає';
  const indicators = pack.indicators.slice(0, 3)
    .map((entry) => `${entry.indicator} ${entry.messages}`)
    .join(', ');

  const summary = [
    RESEARCH_FRAMING,
    `${pack.oblast.name}, ${pack.window.label}. За ${pack.history.days} днів у цій смузі `
      + `${pack.history.windowMessages} повідомлень з ${pack.history.baselineMessages} по області; `
      + `${live}; ${alerts}. Сигнали за 3/6/12 год: `
      + `${pack.now.signalCounts.hours3}/${pack.now.signalCounts.hours6}/${pack.now.signalCounts.hours12}.`,
    indicators ? `Індикатори по країні за ${RESEARCH_INDICATOR_DAYS} днів: ${indicators}.` : ''
  ].filter(Boolean).join('\n');

  const classes = pack.history.perClass.slice(0, 10).map((entry) => ({
    threatType: entry.threatType,
    // Null rather than the computed value: the audit table keeps the band, the prose does not use it.
    band: null,
    rationale: `${entry.label}: зараз — ${entry.observedNow ? 'так' : 'ні'}; `
      + `у смузі ${entry.windowMessages} з ${pack.history.windowMessages} `
      + `(${Math.round(entry.windowShare * 100)}%), по області за період ${entry.baselineSupport}; `
      + (entry.lastInWindowDaysAgo == null
        ? 'у смузі не траплялося.'
        : `востаннє у смузі ${entry.lastInWindowDaysAgo} дн. тому.`)
  }));

  const caveats = [...pack.caveats.slice(0, 5)];
  caveats.push('Текст склали правила, модель не залучалася.');
  return { summary, classes, watchIndicators: pack.indicators.map((entry) => entry.indicator), caveats };
}

/** Every string in a memo, in one list, so no verifier can forget one of the fields. */
function memoTexts(memo: ResearchMemo): string[] {
  return [memo.summary, ...memo.classes.map((entry) => entry.rationale), ...memo.watchIndicators, ...memo.caveats];
}

/**
 * The texts as the forecast guard must see them: this project's own sentences removed first.
 *
 * {@link RESEARCH_FRAMING} says «це операторське дослідження, **не прогноз** і не офіційна
 * інформація», and `forecastLexeme` matches the stem `прогноз` whatever stands next to it. That is
 * not a defect of the guard — it is a closed list of stems precisely so that it cannot be argued out
 * of a match by the surrounding words, and a guard that tried to read negation would be the kind of
 * judgement this project refuses to put on the path where text reaches a reader. The consequence is
 * that the framing sentence trips it, and every memo carries the framing sentence.
 *
 * So the exemption is stated where it can be audited: exactly the string constants THIS FILE
 * defines, removed verbatim, before the guard reads what is left. Nothing about a variation is
 * exempt — «це не зовсім прогноз» is not this constant and is still refused — and the remainder is,
 * by construction, only words a writer chose.
 */
export function memoForecastLexeme(memo: ResearchMemo): string | null {
  return firstForecastLexeme(memoTexts(memo).map((text) => text.split(RESEARCH_FRAMING).join(' ')));
}

/**
 * The five ways a model reply is refused, in the order they are cheapest to explain.
 *
 * Any one of them discards the WHOLE reply — not the offending sentence — because a memo is read as
 * one statement and a partially-corrected one would be a statement nobody wrote. The fallback is
 * already complete, so a refusal costs a paragraph and never an answer.
 */
export function verifyResearchMemo(memo: ResearchMemo, pack: ResearchPack): string | null {
  const allowed = groundedNumbers(pack);
  for (const text of memoTexts(memo)) {
    const invented = ungroundedNumber(text, allowed);
    if (invented) return `ungrounded_number:${invented}`;
  }
  const known = new Map(pack.history.perClass.map((entry) => [entry.threatType, entry.band]));
  for (const entry of memo.classes) {
    if (!known.has(entry.threatType)) return `unknown_class:${entry.threatType}`;
    if (entry.band !== null && entry.band !== known.get(entry.threatType)) {
      return `band_mismatch:${entry.threatType}`;
    }
  }
  const indicators = new Set(pack.indicators.map((entry) => entry.indicator));
  for (const indicator of memo.watchIndicators) {
    if (!indicators.has(indicator)) return `unknown_indicator:${indicator}`;
  }
  const forecast = memoForecastLexeme(memo);
  if (forecast) return `forecast_lexeme:${forecast}`;
  return null;
}

/**
 * The sentence that says a machine wrote this, appended after the verifier passed.
 *
 * Added rather than asked for, exactly as `withAiMarker` in `analytics-narrative.ts` does it: a
 * disclosure the model could choose to omit is not a disclosure.
 */
export function withResearchMarker(caveats: string[]): string[] {
  const marker = 'Текст сформулювала мовна модель за переліком спостережень вище; '
    + 'усі числа, класи й індикатори звірено з архівом, а формулювання — зі списком заборонених.';
  return caveats.includes(marker) ? caveats : [...caveats, marker];
}

const RESEARCH_SYSTEM_PROMPT =
  'Ти пишеш операторський меморандум українською за готовим набором спостережень. Поверни ЛИШЕ JSON: '
  + '{"summary":string,"classes":[{"threatType":string,"band":string,"rationale":string}],'
  + '"watchIndicators":[string],"caveats":[string]}. Жорсткі правила: не вигадуй жодного числа, '
  + 'якого немає у вхідних даних; використовуй лише ті класи загроз, що є у вхідних даних; поле band '
  + 'копіюй дослівно з вхідних даних і НЕ змінюй; watchIndicators копіюй дослівно з indicators; '
  + 'пиши лише про минуле й теперішнє — жодних прогнозів, очікувань, наступних цілей чи ймовірностей '
  + 'удару. Це не прогноз, і текст має це говорити.';

function modelInput(pack: ResearchPack) {
  return {
    oblast: pack.oblast.name,
    window: pack.window.label,
    framing: RESEARCH_FRAMING,
    confidence: pack.confidence,
    now: pack.now,
    history: pack.history,
    indicators: pack.indicators,
    caveats: pack.caveats
  };
}

export interface ModelMemoAttempt {
  memo: ResearchMemo | null;
  model: string | null;
  rejectionReason: string | null;
  verification: 'passed' | 'rejected' | 'skipped';
}

/**
 * The model attempt. Never reached unless the operator switched `attack_research` on, and it can only
 * ever replace prose: the bands, the counts and the stored class rows are already fixed by the time
 * this runs.
 */
export async function researchWithCodex(pack: ResearchPack): Promise<ModelMemoAttempt> {
  const input = modelInput(pack);
  const result = await codexChat({
    promptVersion: RESEARCH_PROMPT_VERSION,
    surface: 'attack_research',
    ...(pack.history.classifierVersions.length === 1
      ? { classifierVersion: pack.history.classifierVersions[0]! }
      : {}),
    system: RESEARCH_SYSTEM_PROMPT,
    user: JSON.stringify(input),
    json: true,
    auditInput: input
  });
  if (!result.ok) {
    return { memo: null, model: null, verification: 'skipped', rejectionReason: result.reason };
  }
  let parsed: ResearchMemo;
  try {
    parsed = researchMemoSchema.parse(JSON.parse(result.content)) as ResearchMemo;
  } catch (error) {
    return { memo: null, model: result.model, verification: 'rejected', rejectionReason: `schema:${String(error).slice(0, 200)}` };
  }
  const rejection = verifyResearchMemo(parsed, pack);
  if (rejection) return { memo: null, model: result.model, verification: 'rejected', rejectionReason: rejection };
  return {
    memo: { ...parsed, caveats: withResearchMarker(parsed.caveats) },
    model: result.model, verification: 'passed', rejectionReason: null
  };
}

// ------------------------------------------------------------------------------------------------
// Governance — counted from the table, never from a module variable
// ------------------------------------------------------------------------------------------------

export type ResearchRefusalStatus = 'refused_disabled' | 'refused_cooldown' | 'refused_daily_cap';

export interface ResearchGovernanceInput {
  featureEnabled: boolean;
  /** Requests of ANY status made today, in the app timezone — refusals included. */
  usedToday: number;
  perDay: number;
  /** When this oblast and window last produced a memo. Refusals do not count; see {@link lastCompletedAt}. */
  lastRequestAt: Date | null;
  cooldownSeconds: number;
  now: Date;
}

export interface ResearchRefusal {
  status: ResearchRefusalStatus;
  detail: string;
  retryAfterSeconds: number | null;
}

/**
 * Pure. Whether a request is refused, and by which rule — checked BEFORE any evidence is gathered.
 *
 * Order is deliberate. The switch comes first because an installation that never turned the feature
 * on should never learn what its cap is; the daily cap comes before the cooldown because it is the
 * bound an operator cannot wait out, and telling somebody to come back in two minutes when they have
 * spent the day's allowance would be a lie.
 */
export function researchRefusal(input: ResearchGovernanceInput): ResearchRefusal | null {
  if (!input.featureEnabled) {
    return {
      status: 'refused_disabled',
      detail: 'Перемикач «Дослідження області» вимкнено в налаштуваннях Codex.',
      retryAfterSeconds: null
    };
  }
  if (input.perDay <= 0 || input.usedToday >= input.perDay) {
    return {
      status: 'refused_daily_cap',
      detail: `Денний ліміт вичерпано: ${input.usedToday} з ${input.perDay}.`,
      retryAfterSeconds: null
    };
  }
  if (input.cooldownSeconds > 0 && input.lastRequestAt) {
    const elapsed = (input.now.getTime() - input.lastRequestAt.getTime()) / 1000;
    if (elapsed < input.cooldownSeconds) {
      const remaining = Math.max(1, Math.ceil(input.cooldownSeconds - elapsed));
      return {
        status: 'refused_cooldown',
        detail: `Ця область і вікно вже досліджувалися; лишилося ${remaining} с.`,
        retryAfterSeconds: remaining
      };
    }
  }
  return null;
}

export interface ResearchCaps {
  perDay: number;
  usedToday: number;
  cooldownSeconds: number;
}

/** The caps as configured, plus how much of today's allowance the table says is gone. */
export async function researchCaps(now: Date = new Date()): Promise<ResearchCaps> {
  const used = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ops_attack_research_requests
      WHERE (requested_at AT TIME ZONE $2::text)::date = ($1::timestamptz AT TIME ZONE $2::text)::date`,
    [now, config.APP_TIMEZONE]
  );
  return {
    perDay: config.ATTACK_RESEARCH_MAX_PER_DAY,
    usedToday: used.rows[0]?.n ?? 0,
    cooldownSeconds: config.ATTACK_RESEARCH_COOLDOWN_SECONDS
  };
}

/**
 * When this oblast and window were last actually researched.
 *
 * `status='completed'` and not «any row», which is the one place the two bounds deliberately count
 * different things. The daily cap counts every press because a press is what an operator spends and
 * because a stuck client has to be bounded by something. The cooldown bounds the WORK — four
 * statements over thirty days of archive — so a request that was refused before any of it ran has
 * nothing to cool down from. Counting refusals here produced the sharpest version of the bug: an
 * operator who pressed the button while the switch was off, then switched it on, was told to wait two
 * minutes for a computation that had never happened.
 */
async function lastCompletedAt(oblastId: string, window: ResearchWindowName): Promise<Date | null> {
  const result = await pool.query<{ requested_at: Date }>(
    `SELECT requested_at FROM ops_attack_research_requests
      WHERE oblast_id=$1 AND research_window=$2 AND status='completed'
      ORDER BY requested_at DESC LIMIT 1`,
    [oblastId, window]
  );
  return result.rows[0]?.requested_at ?? null;
}

async function recordRequest(input: {
  oblastId: string; window: ResearchWindowName; requestedBy: string;
  status: string; refusalDetail: string | null; requestedAt: Date;
}): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO ops_attack_research_requests(
       requested_by,oblast_id,research_window,requested_at,status,refusal_detail)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [input.requestedBy, input.oblastId, input.window, input.requestedAt, input.status, input.refusalDetail]
  );
  return inserted.rows[0]!.id;
}

// ------------------------------------------------------------------------------------------------
// The one path a memo is produced on
// ------------------------------------------------------------------------------------------------

export interface StoredResearchMemo {
  id: string;
  requestId: string;
  oblast: { id: string; name: string };
  window: ResearchWindowName;
  windowLabel: string;
  dataNature: 'calculated';
  methodologyVersion: string;
  computedAt: string;
  confidence: 'low' | 'medium';
  framing: string;
  notice: string;
  memo: ResearchMemo;
  memoOrigin: 'deterministic' | 'model';
  modelVersion: string | null;
  promptVersion: string | null;
  verification: 'passed' | 'rejected' | 'skipped';
  rejectionReason: string | null;
  aiRunId: string | null;
  bands: Array<{ threatType: string; label: string; band: ResearchBand }>;
  /** Only on the single-memo read; the list omits it. */
  evidence?: ResearchPack;
}

export type ResearchResult =
  | { ok: true; memo: StoredResearchMemo }
  | { ok: false; status: ResearchRefusalStatus | 'failed'; detail: string; retryAfterSeconds: number | null };

export interface ResearchRunInput {
  oblastId: string;
  window: ResearchWindowName;
  requestedBy?: string;
  now?: Date;
}

/**
 * Compute one memo, or refuse and say why. Every path writes a request row.
 *
 * The refusal check runs before the evidence pack is built, so a refused request costs four
 * statements it never ran, and the `ai_runs` table stays empty for a request the switch turned away.
 */
export async function runAttackResearch(input: ResearchRunInput): Promise<ResearchResult> {
  const now = input.now ?? new Date();
  const requestedBy = input.requestedBy ?? 'operator';
  const featureEnabled = await codexFeatureEnabled('attack_research');
  const caps = await researchCaps(now);
  const refusal = researchRefusal({
    featureEnabled,
    usedToday: caps.usedToday,
    perDay: caps.perDay,
    lastRequestAt: await lastCompletedAt(input.oblastId, input.window),
    cooldownSeconds: caps.cooldownSeconds,
    now
  });
  if (refusal) {
    await recordRequest({
      oblastId: input.oblastId, window: input.window, requestedBy,
      status: refusal.status, refusalDetail: refusal.detail, requestedAt: now
    });
    attackResearchRuns.inc({ outcome: refusal.status });
    return { ok: false, status: refusal.status, detail: refusal.detail, retryAfterSeconds: refusal.retryAfterSeconds };
  }

  let requestId: string;
  try {
    const pack = await buildResearchPack(input.oblastId, input.window, now);
    const attempt = await researchWithCodex(pack).catch((error) => ({
      memo: null, model: null, verification: 'skipped' as const, rejectionReason: `transport:${String(error).slice(0, 200)}`
    }));
    const memo = attempt.memo ?? deterministicMemo(pack);
    requestId = await recordRequest({
      oblastId: input.oblastId, window: input.window, requestedBy,
      status: 'completed', refusalDetail: null, requestedAt: now
    });
    const stored = await persistMemo({ requestId, pack, memo, attempt });
    attackResearchRuns.inc({ outcome: attempt.verification === 'rejected' ? 'model_rejected' : 'ok' });
    return { ok: true, memo: stored };
  } catch (error) {
    await recordRequest({
      oblastId: input.oblastId, window: input.window, requestedBy,
      status: 'failed', refusalDetail: String(error).slice(0, 500), requestedAt: now
    }).catch(() => undefined);
    attackResearchRuns.inc({ outcome: 'failed' });
    return { ok: false, status: 'failed', detail: String(error).slice(0, 500), retryAfterSeconds: null };
  }
}

/**
 * The `ai_runs` row this memo's model call produced, if there was one.
 *
 * `codexChat` writes the audit row itself and returns no id — deliberately, since its callers are
 * surfaces that do not care. This one does, because an operator reading a memo wants the verbatim
 * exchange behind it, so the newest row on this surface since the memo started is claimed. Bounded by
 * time and by surface: two concurrent research requests are already serialised by the cooldown.
 */
async function claimAiRun(since: Date): Promise<string | null> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM ai_runs WHERE surface='attack_research' AND created_at >= $1
      ORDER BY created_at DESC LIMIT 1`, [since]
  );
  return result.rows[0]?.id ?? null;
}

async function persistMemo(input: {
  requestId: string; pack: ResearchPack; memo: ResearchMemo; attempt: ModelMemoAttempt;
}): Promise<StoredResearchMemo> {
  // Claimed on every path, including the rejected and the skipped one: a pre-flight refusal
  // («no_session», «model_not_selected») is exactly the row an operator goes looking for when the
  // memo came out deterministic and they expected prose.
  const aiRunId = await claimAiRun(new Date(input.pack.computedAt));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<{ id: string; computed_at: Date }>(
      `INSERT INTO ops_attack_research_memos(
         request_id,methodology_version,computed_at,confidence,framing,evidence,memo,memo_origin,
         model_version,prompt_version,verification,rejection_reason,ai_run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id,computed_at`,
      [
        input.requestId, input.pack.methodologyVersion, input.pack.computedAt, input.pack.confidence,
        RESEARCH_FRAMING, JSON.stringify(input.pack), JSON.stringify(input.memo),
        input.attempt.memo ? 'model' : 'deterministic',
        input.attempt.memo ? input.attempt.model : null,
        input.attempt.memo ? RESEARCH_PROMPT_VERSION : null,
        input.attempt.verification, input.attempt.rejectionReason, aiRunId
      ]
    );
    const memoId = inserted.rows[0]!.id;
    for (const entry of input.pack.history.perClass.slice(0, 10)) {
      await client.query(
        `INSERT INTO ops_attack_research_classes(
           memo_id,threat_type,band,observed_now,window_messages,window_share,baseline_support)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [memoId, entry.threatType, entry.band, entry.observedNow, entry.windowMessages,
          entry.windowShare, entry.baselineSupport]
      );
    }
    await client.query('COMMIT');
    return {
      id: memoId,
      requestId: input.requestId,
      oblast: input.pack.oblast,
      window: input.pack.window.window,
      windowLabel: input.pack.window.label,
      dataNature: 'calculated',
      methodologyVersion: input.pack.methodologyVersion,
      computedAt: inserted.rows[0]!.computed_at.toISOString(),
      confidence: input.pack.confidence,
      framing: RESEARCH_FRAMING,
      notice: RESEARCH_NOTICE,
      memo: input.memo,
      memoOrigin: input.attempt.memo ? 'model' : 'deterministic',
      modelVersion: input.attempt.memo ? input.attempt.model : null,
      promptVersion: input.attempt.memo ? RESEARCH_PROMPT_VERSION : null,
      verification: input.attempt.verification,
      rejectionReason: input.attempt.rejectionReason,
      aiRunId,
      bands: input.pack.history.perClass.slice(0, 10).map((entry) => ({
        threatType: entry.threatType, label: entry.label, band: entry.band
      })),
      evidence: input.pack
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------------------------------------------
// Reads
// ------------------------------------------------------------------------------------------------

interface MemoRow {
  id: string; request_id: string; oblast_id: string; oblast_name: string;
  research_window: ResearchWindowName; methodology_version: string; computed_at: Date;
  confidence: 'low' | 'medium'; framing: string; memo: ResearchMemo; evidence: ResearchPack;
  memo_origin: 'deterministic' | 'model'; model_version: string | null; prompt_version: string | null;
  verification: 'passed' | 'rejected' | 'skipped'; rejection_reason: string | null;
  ai_run_id: string | null;
}

const MEMO_SELECT = `
  SELECT m.id, m.request_id, r.oblast_id, l.name_uk AS oblast_name, r.research_window,
         m.methodology_version, m.computed_at, m.confidence, m.framing, m.memo, m.evidence,
         m.memo_origin, m.model_version, m.prompt_version, m.verification, m.rejection_reason,
         m.ai_run_id
    FROM ops_attack_research_memos m
    JOIN ops_attack_research_requests r ON r.id=m.request_id
    JOIN locations l ON l.id=r.oblast_id`;

function toStoredMemo(row: MemoRow, bands: Array<{ threat_type: string; band: ResearchBand }>, withEvidence: boolean): StoredResearchMemo {
  return {
    id: row.id,
    requestId: row.request_id,
    oblast: { id: row.oblast_id, name: row.oblast_name },
    window: row.research_window,
    windowLabel: row.evidence?.window?.label ?? row.research_window,
    dataNature: 'calculated',
    methodologyVersion: row.methodology_version,
    computedAt: row.computed_at.toISOString(),
    confidence: row.confidence,
    framing: row.framing,
    notice: RESEARCH_NOTICE,
    memo: row.memo,
    memoOrigin: row.memo_origin,
    modelVersion: row.model_version,
    promptVersion: row.prompt_version,
    verification: row.verification,
    rejectionReason: row.rejection_reason,
    aiRunId: row.ai_run_id,
    bands: bands.map((band) => ({
      threatType: band.threat_type, label: threatLabel(band.threat_type), band: band.band
    })),
    ...(withEvidence ? { evidence: row.evidence } : {})
  };
}

export async function researchMemoById(id: string): Promise<StoredResearchMemo | null> {
  const row = (await pool.query<MemoRow>(`${MEMO_SELECT} WHERE m.id=$1`, [id])).rows[0];
  if (!row) return null;
  const bands = await pool.query<{ threat_type: string; band: ResearchBand }>(
    `SELECT threat_type,band FROM ops_attack_research_classes WHERE memo_id=$1 ORDER BY threat_type`, [id]
  );
  return toStoredMemo(row, bands.rows, true);
}

export interface ResearchHistoryEntry {
  requestId: string;
  memoId: string | null;
  oblastName: string;
  window: ResearchWindowName;
  requestedAt: string;
  status: string;
  refusalDetail: string | null;
  memoOrigin: 'deterministic' | 'model' | null;
  verification: 'passed' | 'rejected' | 'skipped' | null;
  rejectionReason: string | null;
  aiRunId: string | null;
}

/** The last requests, refusals included — the refusals are half of what this history is for. */
export async function recentResearch(limit = 20): Promise<ResearchHistoryEntry[]> {
  const result = await pool.query<{
    request_id: string; memo_id: string | null; oblast_name: string;
    research_window: ResearchWindowName; requested_at: Date; status: string;
    refusal_detail: string | null; memo_origin: 'deterministic' | 'model' | null;
    verification: 'passed' | 'rejected' | 'skipped' | null; rejection_reason: string | null;
    ai_run_id: string | null;
  }>(
    `SELECT r.id AS request_id, m.id AS memo_id, l.name_uk AS oblast_name, r.research_window,
            r.requested_at, r.status, r.refusal_detail, m.memo_origin, m.verification,
            m.rejection_reason, m.ai_run_id
       FROM ops_attack_research_requests r
       JOIN locations l ON l.id=r.oblast_id
       LEFT JOIN ops_attack_research_memos m ON m.request_id=r.id
      ORDER BY r.requested_at DESC LIMIT $1`, [limit]
  );
  return result.rows.map((row) => ({
    requestId: row.request_id,
    memoId: row.memo_id,
    oblastName: row.oblast_name,
    window: row.research_window,
    requestedAt: row.requested_at.toISOString(),
    status: row.status,
    refusalDetail: row.refusal_detail,
    memoOrigin: row.memo_origin,
    verification: row.verification,
    rejectionReason: row.rejection_reason,
    aiRunId: row.ai_run_id
  }));
}

/** The oblasts a memo may be asked about: the top tier of the catalogue and nothing below it. */
export async function researchOblasts(): Promise<Array<{ id: string; name: string }>> {
  const result = await pool.query<{ id: string; name_uk: string }>(
    `SELECT id,name_uk FROM locations WHERE type IN ('oblast','special_city') ORDER BY name_uk`
  );
  return result.rows.map((row) => ({ id: row.id, name: row.name_uk }));
}

/** Retention. The memos and their class rows go with the request row they hang off. */
export async function pruneAttackResearch(days = RESEARCH_RETENTION_DAYS): Promise<number> {
  const result = await pool.query(
    `DELETE FROM ops_attack_research_requests WHERE requested_at < now() - make_interval(days => $1::int)`,
    [days]
  );
  return result.rowCount ?? 0;
}
