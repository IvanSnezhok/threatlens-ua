import { config } from '../config.js';
import { pool } from '../db/pool.js';

/**
 * Analytics over the classification archive.
 *
 * The archive (`message_classifications`, `message_classification_locations`, `threat_assertions`,
 * written by `migrations/012_threat_assertions_and_classification_log.sql`) records one row per
 * classifier decision, including the decisions to do nothing. This module turns it into the two
 * answers the product owner actually asked for:
 *
 *   1. **What is being struck, where, and how is that changing?** — `threatTypeDynamics`,
 *      `strikeComposition`, `geographyShift`.
 *   2. **Where are attacks countered?** — `lossPoints`, which reads the assertion table from the
 *      withdrawal side and reports the rate, not only the count.
 *
 * Plus the two supporting views without which neither answer can be trusted: `sourcePerformance`
 * ("is this a change in the sky or a change in one channel's posting?") and
 * `classifierVersionComparison` ("is this a change in the sky or a change in our own regexes?").
 *
 * ## Three rules the whole module obeys
 *
 * **Every series is splittable by `classifier_version`, and says so when it is not.** A version bump
 * changes what a message *means*, so an unsplit comparison reports an improvement to
 * `src/domain/classifier.ts` as a change in enemy tactics — the exact confusion the archive exists to
 * prevent. Every result carries a {@link VersionSafety} block: which versions the window contains,
 * whether the numbers are broken out per version, whether a period-over-period comparison is
 * version-safe, and how many rows could not be attributed to a version at all. Nothing here mixes
 * versions silently.
 *
 * **Geography comes from `message_classification_locations`, not `threat_event_locations`.** The
 * classification's places are stamped with the classification's version; an event's places are
 * shared by every version that ever judged a message about it. Rolling geography up through the
 * event table would quietly re-mix the versions the rest of the module is careful to separate. The
 * cost is that these counts answer "where was it reported" rather than "where did the event end up",
 * which is the question the strategy view wants anyway.
 *
 * **Every statement is window-bounded.** `message_classifications` grows by one row per ingested
 * message with no ceiling, and `src/db/pool.ts` sets `statement_timeout=15s`. Each query filters a
 * half-open `[from, to)` interval so the planner gets a range scan over
 * `message_classifications_version_time_idx` (or `_time_idx`) instead of a sequential scan of a
 * year. {@link resolveWindow} clamps the interval before any SQL is built.
 *
 * Nothing in this module calls a model. `src/services/analytics-narrative.ts` writes prose *about*
 * these numbers and can be switched off entirely without changing a single one of them.
 */

// ------------------------------------------------------------------------------------------------
// Window and parameter handling
// ------------------------------------------------------------------------------------------------

export type Bucket = 'day' | 'week' | 'month';

const BUCKETS: readonly Bucket[] = ['day', 'week', 'month'];

/** Decisions that mean "this message asserted a threat", as opposed to withdrawing or raising none. */
const ASSERTING_DECISIONS = ['event_created', 'event_merged', 'redirect'];

export const DEFAULT_WINDOW_DAYS = 30;

/**
 * Longest window any slice will accept.
 *
 * A year plus a month, so "the last twelve months" is expressible and "everything, ever" is not.
 * The bound is what keeps the range scans proportional to a question rather than to the table.
 */
export const MAX_WINDOW_DAYS = 400;

export class AnalyticsInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AnalyticsInputError';
  }
}

export interface AnalyticsWindowInput {
  from?: string | Date | null;
  to?: string | Date | null;
  bucket?: string | null;
  /** `null` means "do not filter"; every result is still broken out per version. */
  classifierVersions?: string[] | null;
  threatType?: string | null;
  oblastId?: string | null;
  limit?: number | null;
}

export interface AnalyticsWindow {
  from: Date;
  to: Date;
  bucket: Bucket;
  days: number;
  classifierVersions: string[] | null;
  threatType: string | null;
  oblastId: string | null;
  timezone: string;
  limit: number;
}

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function parseInstant(value: string | Date | null | undefined, field: string): Date | null {
  if (value == null || value === '') return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new AnalyticsInputError('invalid_' + field, `${field} is not a valid timestamp`);
  return parsed;
}

/**
 * Normalises and clamps a request into the window every statement in this module is built around.
 *
 * Defaults are deliberate: `to` is now, `from` is 30 days back, the bucket follows the window length
 * so a year does not come back as 365 day-rows nobody can read. `from >= to` and anything longer
 * than {@link MAX_WINDOW_DAYS} are rejected rather than silently repaired — a caller asking for an
 * unbounded window has a wrong idea about what this archive is for and should be told.
 */
export function resolveWindow(input: AnalyticsWindowInput = {}): AnalyticsWindow {
  const to = parseInstant(input.to, 'to') ?? new Date();
  const from = parseInstant(input.from, 'from') ?? new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);
  if (from.getTime() >= to.getTime()) throw new AnalyticsInputError('invalid_range', 'from must be earlier than to');
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  if (days > MAX_WINDOW_DAYS) {
    throw new AnalyticsInputError('window_too_long', `Window must not exceed ${MAX_WINDOW_DAYS} days`);
  }

  const requestedBucket = input.bucket ?? null;
  if (requestedBucket && !BUCKETS.includes(requestedBucket as Bucket)) {
    throw new AnalyticsInputError('invalid_bucket', `bucket must be one of ${BUCKETS.join(', ')}`);
  }
  const bucket: Bucket = (requestedBucket as Bucket | null) ?? (days > 120 ? 'month' : days > 35 ? 'week' : 'day');

  const versions = input.classifierVersions?.filter((value) => value.length > 0) ?? null;
  for (const version of versions ?? []) {
    if (!IDENTIFIER.test(version)) throw new AnalyticsInputError('invalid_version', 'classifier version is not a valid identifier');
  }
  for (const [field, value] of [['threatType', input.threatType], ['oblastId', input.oblastId]] as const) {
    if (value && !IDENTIFIER.test(value)) throw new AnalyticsInputError(`invalid_${field}`, `${field} is not a valid identifier`);
  }

  const limit = input.limit == null ? 100 : Math.trunc(input.limit);
  if (!Number.isFinite(limit) || limit < 1 || limit > 1000) {
    throw new AnalyticsInputError('invalid_limit', 'limit must be between 1 and 1000');
  }

  return {
    from, to, bucket, days,
    classifierVersions: versions?.length ? versions : null,
    threatType: input.threatType || null,
    oblastId: input.oblastId || null,
    timezone: config.APP_TIMEZONE,
    limit
  };
}

// ------------------------------------------------------------------------------------------------
// Version safety
// ------------------------------------------------------------------------------------------------

/**
 * What the numbers below are worth as a comparison.
 *
 * Attached to every result. `splitByVersion` says the rows are broken out per version and can be
 * read one version at a time; `comparable` says a *period-over-period* reading is version-safe,
 * which needs the same single version present on both sides. `unattributed` is the count of rows
 * whose version could not be established — currently only reachable through `threat_assertions`,
 * whose withdrawal message may predate the archive or have been judged by two versions at once.
 */
export interface VersionSafety {
  versionsInWindow: string[];
  splitByVersion: boolean;
  comparable: boolean;
  unattributed: number;
  notes: string[];
}

function versionSafety(
  versions: string[],
  options: { comparable?: boolean; unattributed?: number; notes?: string[] } = {}
): VersionSafety {
  const notes = [...(options.notes ?? [])];
  const unattributed = options.unattributed ?? 0;
  if (versions.length > 1) {
    notes.push(
      `Вікно містить ${versions.length} версії класифікатора (${versions.join(', ')}). `
      + 'Рядки розділені за версією — не додавайте їх між версіями, це порівняння різних правил.'
    );
  }
  if (unattributed > 0) {
    notes.push(
      `${unattributed} записів не вдалося віднести до версії класифікатора; вони позначені `
      + 'classifierVersion=null і не входять до жодної версійної серії.'
    );
  }
  return {
    versionsInWindow: versions,
    splitByVersion: true,
    comparable: options.comparable ?? versions.length <= 1,
    unattributed,
    notes
  };
}

function collectVersions(rows: Array<{ classifier_version: string | null }>): string[] {
  return [...new Set(rows.map((row) => row.classifier_version).filter((value): value is string => Boolean(value)))].sort();
}

// ------------------------------------------------------------------------------------------------
// Shared SQL fragments
// ------------------------------------------------------------------------------------------------

/**
 * Rolls a set of location ids up to the oblast (or special city, or country) that contains them.
 *
 * The recursion is seeded from `seed`, a CTE the caller defines over *the places named inside the
 * window*, and not from `locations` as a whole. After the KATOTTG import the catalogue is tens of
 * thousands of rows, and seeding from all of them would make every analytics request pay for a
 * recursive walk of the entire country; seeded from the handful of places a night actually mentions,
 * the climb is a few primary-key lookups per place over `locations_parent_idx`.
 *
 * `DISTINCT ON … ORDER BY depth` keeps the *nearest* terminal ancestor, so a city under a raion
 * lands in its oblast exactly once instead of being counted again under `ua` if the chain continues.
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

/** Bind list shared by the classification-side slices. `$1..$5` are always these five. */
function classificationParams(window: AnalyticsWindow): unknown[] {
  return [window.from, window.to, window.classifierVersions, window.threatType, window.bucket];
}

const CLASSIFICATION_FILTER = `
  mc.published_at >= $1 AND mc.published_at < $2
  AND ($3::text[] IS NULL OR mc.classifier_version = ANY($3))
  AND ($4::text IS NULL OR mc.threat_type = $4)`;

// ------------------------------------------------------------------------------------------------
// 0. Coverage — what the archive actually contains
// ------------------------------------------------------------------------------------------------

export interface ArchiveCoverageVersion {
  classifierVersion: string;
  messages: number;
  events: number;
  sources: number;
  firstPublishedAt: string | null;
  lastPublishedAt: string | null;
}

export interface ArchiveCoverage {
  versions: ArchiveCoverageVersion[];
  messages: number;
  /** Versions whose observed spans overlap: a window inside the overlap can be compared like for like. */
  overlappingVersions: string[];
  generatedAt: string;
}

let coverageCache: { at: number; value: ArchiveCoverage } | null = null;

/**
 * Which classifier versions exist and over what span.
 *
 * The one query here that is not window-bounded, because its entire job is to tell a caller which
 * windows are worth asking for. It is an aggregate over `message_classifications_version_time_idx`
 * with no row output, and its result is memoised for a minute so a dashboard polling every slice
 * does not re-run it per panel.
 */
export async function archiveCoverage(now = Date.now()): Promise<ArchiveCoverage> {
  if (coverageCache && now - coverageCache.at < 60_000) return coverageCache.value;
  const result = await pool.query<{
    classifier_version: string; messages: number; events: number; sources: number;
    first_published_at: Date | null; last_published_at: Date | null;
  }>(
    `SELECT classifier_version,
            count(*)::int AS messages,
            count(DISTINCT event_id)::int AS events,
            count(DISTINCT source_id)::int AS sources,
            min(published_at) AS first_published_at,
            max(published_at) AS last_published_at
     FROM message_classifications
     GROUP BY 1 ORDER BY 1`
  );
  const versions = result.rows.map((row) => ({
    classifierVersion: row.classifier_version,
    messages: row.messages,
    events: row.events,
    sources: row.sources,
    firstPublishedAt: row.first_published_at?.toISOString() ?? null,
    lastPublishedAt: row.last_published_at?.toISOString() ?? null
  }));
  const overlapping = versions.filter((version) => versions.some((other) =>
    other.classifierVersion !== version.classifierVersion
    && version.firstPublishedAt && version.lastPublishedAt && other.firstPublishedAt && other.lastPublishedAt
    && version.firstPublishedAt <= other.lastPublishedAt && other.firstPublishedAt <= version.lastPublishedAt
  )).map((version) => version.classifierVersion);
  const value: ArchiveCoverage = {
    versions,
    messages: versions.reduce((sum, version) => sum + version.messages, 0),
    overlappingVersions: overlapping,
    generatedAt: new Date(now).toISOString()
  };
  coverageCache = { at: now, value };
  return value;
}

/** Test seam: the memo above would otherwise carry one test's archive into the next. */
export function resetAnalyticsCaches(): void {
  coverageCache = null;
}

// ------------------------------------------------------------------------------------------------
// 1. Threat type dynamics — what is being reported, when, and where
// ------------------------------------------------------------------------------------------------

export interface ThreatTypePoint {
  bucket: string;
  classifierVersion: string;
  threatType: string;
  messages: number;
  eventsRaised: number;
  events: number;
}

export interface ThreatTypeOblastPoint extends ThreatTypePoint {
  oblastId: string;
  oblastName: string;
}

export interface ThreatTypeDynamics {
  window: SerialisedWindow;
  versionSafety: VersionSafety;
  /** One row per (bucket, version, threat class), with no geography — the headline series. */
  series: ThreatTypePoint[];
  /** The same series broken out by oblast. A message naming two oblasts appears under both. */
  byOblast: ThreatTypeOblastPoint[];
  /** Asserting messages the window contains that resolved to no oblast and were not national. */
  withoutGeography: number;
}

export interface SerialisedWindow {
  from: string;
  to: string;
  bucket: Bucket;
  days: number;
  classifierVersions: string[] | null;
  threatType: string | null;
  oblastId: string | null;
  timezone: string;
}

function serialiseWindow(window: AnalyticsWindow): SerialisedWindow {
  return {
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    bucket: window.bucket,
    days: Number(window.days.toFixed(3)),
    classifierVersions: window.classifierVersions,
    threatType: window.threatType,
    oblastId: window.oblastId,
    timezone: window.timezone
  };
}

/**
 * How the mix of threat classes moves over time, overall and per oblast.
 *
 * Counted from asserting decisions only (`event_created`, `event_merged`, `redirect`) — a stand-down
 * is not a strike report, and folding it in would make a quiet night with many all-clears look busy.
 * Three measures, because they answer different questions and are routinely confused:
 *
 *   * `messages` — reporting volume. Rises when the enemy is busy *and* when a channel gets chatty.
 *   * `eventsRaised` — decisions that created a new event. The closest thing to "distinct incidents",
 *     and the series to read for tactics.
 *   * `events` — distinct events touched in the bucket, so an event straddling two buckets is
 *     visible in both. Never sum this across buckets.
 */
export async function threatTypeDynamics(window: AnalyticsWindow): Promise<ThreatTypeDynamics> {
  const params = [...classificationParams(window), window.timezone, window.oblastId];
  const sql = `
WITH RECURSIVE base AS (
  SELECT mc.id, mc.classifier_version, mc.published_at, mc.created_event, mc.event_id,
         mc.national_scope, COALESCE(mc.threat_type,'unknown') AS threat_type
  FROM message_classifications mc
  WHERE ${CLASSIFICATION_FILTER} AND mc.decision = ANY($8::text[])
),
placed AS (
  SELECT b.id, cl.location_id
  FROM base b
  JOIN message_classification_locations cl ON cl.classification_id=b.id AND cl.role='asserted'
),
seed AS (SELECT DISTINCT location_id FROM placed),
${OBLAST_ROLLUP},
attributed AS (
  SELECT b.id, b.classifier_version, b.published_at, b.created_event, b.event_id, b.threat_type,
         COALESCE(o.oblast_id, CASE WHEN b.national_scope THEN 'ua' END) AS oblast_id
  FROM base b
  LEFT JOIN placed p ON p.id=b.id
  LEFT JOIN oblast_of o ON o.location_id=p.location_id
),
deduped AS (
  SELECT DISTINCT id, classifier_version, published_at, created_event, event_id, threat_type, oblast_id
  FROM attributed
)
SELECT 'total' AS scope, NULL::text AS oblast_id, NULL::text AS oblast_name,
       date_trunc($5::text,b.published_at AT TIME ZONE $6::text)::date::text AS bucket,
       b.classifier_version, b.threat_type,
       count(*)::int AS messages,
       count(*) FILTER (WHERE b.created_event)::int AS events_raised,
       count(DISTINCT b.event_id)::int AS events
FROM base b
WHERE $7::text IS NULL
GROUP BY 4,5,6
UNION ALL
SELECT 'oblast', d.oblast_id, l.name_uk,
       date_trunc($5::text,d.published_at AT TIME ZONE $6::text)::date::text,
       d.classifier_version, d.threat_type,
       count(*)::int,
       count(*) FILTER (WHERE d.created_event)::int,
       count(DISTINCT d.event_id)::int
FROM deduped d JOIN locations l ON l.id=d.oblast_id
WHERE d.oblast_id IS NOT NULL AND ($7::text IS NULL OR d.oblast_id=$7)
GROUP BY 2,3,4,5,6
ORDER BY 4,5,6,2`;

  const rows = (await pool.query<{
    scope: string; oblast_id: string | null; oblast_name: string | null; bucket: string;
    classifier_version: string; threat_type: string; messages: number; events_raised: number; events: number;
  }>(sql, [...params, ASSERTING_DECISIONS])).rows;

  const ungeolocated = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM message_classifications mc
     WHERE ${CLASSIFICATION_FILTER} AND mc.decision = ANY($5::text[])
       AND NOT mc.national_scope
       AND NOT EXISTS (SELECT 1 FROM message_classification_locations cl
                       WHERE cl.classification_id=mc.id AND cl.role='asserted')`,
    [window.from, window.to, window.classifierVersions, window.threatType, ASSERTING_DECISIONS]
  );

  const point = (row: typeof rows[number]): ThreatTypePoint => ({
    bucket: row.bucket,
    classifierVersion: row.classifier_version,
    threatType: row.threat_type,
    messages: row.messages,
    eventsRaised: row.events_raised,
    events: row.events
  });

  const byOblast = rows.filter((row) => row.scope === 'oblast').map((row) => ({
    ...point(row), oblastId: row.oblast_id ?? '', oblastName: row.oblast_name ?? row.oblast_id ?? ''
  }));
  // With an oblast filter the all-Ukraine total would answer a question nobody asked, so the
  // headline series becomes that oblast's own rows rather than a number it does not belong to.
  const series = window.oblastId
    ? byOblast.map(({ oblastId: _id, oblastName: _name, ...rest }) => rest)
    : rows.filter((row) => row.scope === 'total').map(point);

  return {
    window: serialiseWindow(window),
    versionSafety: versionSafety(collectVersions(rows)),
    series,
    byOblast,
    withoutGeography: ungeolocated.rows[0]?.n ?? 0
  };
}

// ------------------------------------------------------------------------------------------------
// 2. Geography shift — which oblasts are moving up the board and which are falling off it
// ------------------------------------------------------------------------------------------------

export interface GeographyShiftRow {
  oblastId: string;
  oblastName: string;
  classifierVersion: string;
  current: { messages: number; eventsRaised: number; share: number; rank: number | null };
  previous: { messages: number; eventsRaised: number; share: number; rank: number | null };
  deltaEventsRaised: number;
  deltaShare: number;
  rankDelta: number | null;
  trend: 'rising' | 'falling' | 'steady' | 'new' | 'gone';
}

export interface GeographyShift {
  window: SerialisedWindow;
  previousWindow: { from: string; to: string };
  versionSafety: VersionSafety;
  rows: GeographyShiftRow[];
}

/**
 * Which oblasts are coming to the front and which are fading, measured against the window that
 * immediately precedes the one asked for.
 *
 * The comparison is where version mixing does the most damage, so this is where the check is
 * strictest: if the two halves were judged by different classifier versions, `versionSafety.
 * comparable` is false and a note says the difference may be ours rather than theirs. Pinning
 * `classifierVersions` to a single version that is present in both halves is the only configuration
 * that reports `comparable: true`.
 *
 * Shares are computed within a (version, half) so they always total 1 for that half — a change in
 * share is a change in *where* the reporting went, independent of how much of it there was.
 */
export async function geographyShift(window: AnalyticsWindow): Promise<GeographyShift> {
  const span = window.to.getTime() - window.from.getTime();
  const previousFrom = new Date(window.from.getTime() - span);
  const sql = `
WITH RECURSIVE base AS (
  SELECT mc.id, mc.classifier_version, mc.created_event, mc.national_scope,
         (mc.published_at >= $2) AS is_current
  FROM message_classifications mc
  WHERE mc.published_at >= $1 AND mc.published_at < $3
    AND ($4::text[] IS NULL OR mc.classifier_version = ANY($4))
    AND ($5::text IS NULL OR mc.threat_type = $5)
    AND mc.decision = ANY($6::text[])
),
placed AS (
  SELECT b.id, cl.location_id
  FROM base b
  JOIN message_classification_locations cl ON cl.classification_id=b.id AND cl.role='asserted'
),
seed AS (SELECT DISTINCT location_id FROM placed),
${OBLAST_ROLLUP},
attributed AS (
  SELECT DISTINCT b.id, b.classifier_version, b.created_event, b.is_current,
         COALESCE(o.oblast_id, CASE WHEN b.national_scope THEN 'ua' END) AS oblast_id
  FROM base b
  LEFT JOIN placed p ON p.id=b.id
  LEFT JOIN oblast_of o ON o.location_id=p.location_id
)
SELECT a.oblast_id, l.name_uk AS oblast_name, a.classifier_version,
       count(*) FILTER (WHERE a.is_current)::int AS current_messages,
       count(*) FILTER (WHERE a.is_current AND a.created_event)::int AS current_events,
       count(*) FILTER (WHERE NOT a.is_current)::int AS previous_messages,
       count(*) FILTER (WHERE NOT a.is_current AND a.created_event)::int AS previous_events
FROM attributed a JOIN locations l ON l.id=a.oblast_id
WHERE a.oblast_id IS NOT NULL
GROUP BY 1,2,3`;

  const rows = (await pool.query<{
    oblast_id: string; oblast_name: string; classifier_version: string;
    current_messages: number; current_events: number; previous_messages: number; previous_events: number;
  }>(sql, [
    previousFrom, window.from, window.to, window.classifierVersions, window.threatType, ASSERTING_DECISIONS
  ])).rows;

  const versionsCurrent = new Set(rows.filter((row) => row.current_messages > 0).map((row) => row.classifier_version));
  const versionsPrevious = new Set(rows.filter((row) => row.previous_messages > 0).map((row) => row.classifier_version));
  const totals = new Map<string, { current: number; previous: number }>();
  for (const row of rows) {
    const bucket = totals.get(row.classifier_version) ?? { current: 0, previous: 0 };
    bucket.current += row.current_events;
    bucket.previous += row.previous_events;
    totals.set(row.classifier_version, bucket);
  }

  const ranked = new Map<string, { current: string[]; previous: string[] }>();
  for (const version of new Set(rows.map((row) => row.classifier_version))) {
    const scoped = rows.filter((row) => row.classifier_version === version);
    ranked.set(version, {
      current: [...scoped].filter((row) => row.current_events > 0)
        .sort((a, b) => b.current_events - a.current_events || a.oblast_id.localeCompare(b.oblast_id))
        .map((row) => row.oblast_id),
      previous: [...scoped].filter((row) => row.previous_events > 0)
        .sort((a, b) => b.previous_events - a.previous_events || a.oblast_id.localeCompare(b.oblast_id))
        .map((row) => row.oblast_id)
    });
  }

  const shifted = rows.map((row) => {
    const total = totals.get(row.classifier_version) ?? { current: 0, previous: 0 };
    const currentShare = total.current ? row.current_events / total.current : 0;
    const previousShare = total.previous ? row.previous_events / total.previous : 0;
    const order = ranked.get(row.classifier_version)!;
    const currentRank = order.current.indexOf(row.oblast_id);
    const previousRank = order.previous.indexOf(row.oblast_id);
    const deltaShare = currentShare - previousShare;
    const trend: GeographyShiftRow['trend'] =
      row.previous_events === 0 && row.current_events > 0 ? 'new'
        : row.current_events === 0 && row.previous_events > 0 ? 'gone'
          : deltaShare > 0.02 ? 'rising' : deltaShare < -0.02 ? 'falling' : 'steady';
    return {
      oblastId: row.oblast_id,
      oblastName: row.oblast_name,
      classifierVersion: row.classifier_version,
      current: {
        messages: row.current_messages, eventsRaised: row.current_events,
        share: Number(currentShare.toFixed(4)), rank: currentRank < 0 ? null : currentRank + 1
      },
      previous: {
        messages: row.previous_messages, eventsRaised: row.previous_events,
        share: Number(previousShare.toFixed(4)), rank: previousRank < 0 ? null : previousRank + 1
      },
      deltaEventsRaised: row.current_events - row.previous_events,
      deltaShare: Number(deltaShare.toFixed(4)),
      rankDelta: currentRank < 0 || previousRank < 0 ? null : previousRank - currentRank,
      trend
    };
  }).sort((a, b) => b.deltaEventsRaised - a.deltaEventsRaised || a.oblastId.localeCompare(b.oblastId));

  const versions = collectVersions(rows);
  const sameInstrument = versionsCurrent.size === 1 && versionsPrevious.size === 1
    && [...versionsCurrent][0] === [...versionsPrevious][0];
  const notes: string[] = [];
  if (!sameInstrument && (versionsCurrent.size || versionsPrevious.size)) {
    notes.push(
      'Порівняння періодів не є версійно-безпечним: поточне вікно судила версія(ї) '
      + `[${[...versionsCurrent].sort().join(', ') || '—'}], попереднє — [${[...versionsPrevious].sort().join(', ') || '—'}]. `
      + 'Різниця може бути зміною наших правил, а не тактики противника. '
      + 'Зафіксуйте classifierVersions однією версією, присутньою в обох половинах.'
    );
  }

  return {
    window: serialiseWindow(window),
    previousWindow: { from: previousFrom.toISOString(), to: window.from.toISOString() },
    versionSafety: versionSafety(versions, { comparable: sameInstrument, notes }),
    rows: shifted.slice(0, window.limit)
  };
}

// ------------------------------------------------------------------------------------------------
// 3. Loss points — where threats stop
// ------------------------------------------------------------------------------------------------

export interface LossAggregate {
  key: string;
  label: string;
  classifierVersion: string | null;
  withdrawals: number;
  events: number;
  sources: number;
  medianHeldSeconds: number | null;
  p90HeldSeconds: number | null;
}

export interface ClosedEvent {
  eventId: string;
  threatType: string;
  evidenceLevel: string;
  lastAssertedBy: string;
  lastAssertedFor: string;
  withdrawnBy: string;
  withdrawnFor: string;
  withdrawalReason: string | null;
  heldSeconds: number | null;
  withdrawnAt: string;
  classifierVersion: string | null;
}

export interface LossPoints {
  window: SerialisedWindow;
  versionSafety: VersionSafety;
  /** Assertions opened in the window and how many of them were taken back — the rate, not the count. */
  interception: {
    asserted: number;
    withdrawn: number;
    withdrawnShare: number;
    medianHeldSeconds: number | null;
    byVersion: Array<{ classifierVersion: string | null; asserted: number; withdrawn: number; withdrawnShare: number }>;
  };
  byOblast: LossAggregate[];
  bySource: LossAggregate[];
  byThreatType: LossAggregate[];
  closedEvents: ClosedEvent[];
}

/**
 * Where attacks are countered — read from the withdrawal side of `threat_assertions`.
 *
 * A threat that ends in a stand-down ended because somebody said so; a threat that ends on its
 * validity timer just ran out. Only the first is evidence about interception, which is why every
 * aggregate here is keyed on `withdrawn_at` rather than on the end of the event.
 *
 * `threat_assertions` carries no `classifier_version` of its own — it is written by the ingestion
 * path, not by the archive — so the version is recovered by joining the withdrawing message back to
 * its classification. A withdrawal whose message was judged by two versions at once, or whose
 * classification never made it into the archive, is reported as `classifierVersion: null` and
 * counted in `versionSafety.unattributed` instead of being folded into whichever version happened to
 * sort first.
 */
export async function lossPoints(window: AnalyticsWindow): Promise<LossPoints> {
  const versionOf = (column: string) => `
    CASE
      WHEN $3::text[] IS NOT NULL AND cardinality($3::text[])=1 AND ${column} @> $3::text[] THEN ($3::text[])[1]
      WHEN cardinality(${column})=1 THEN (${column})[1]
    END`;

  const sql = `
WITH RECURSIVE withdrawn AS (
  SELECT ta.id, ta.event_id, ta.source_id, ta.location_id, ta.threat_type,
         ta.withdrawn_at, ta.withdrawal_reason,
         EXTRACT(EPOCH FROM (ta.withdrawn_at - ta.asserted_at))::double precision AS held_seconds,
         ${versionOf('v.versions')} AS classifier_version
  FROM threat_assertions ta
  LEFT JOIN LATERAL (
    SELECT array_agg(DISTINCT m.classifier_version) AS versions
    FROM message_classifications m WHERE m.source_message_id=ta.withdrawn_message_id
  ) v ON true
  WHERE ta.withdrawn_at >= $1 AND ta.withdrawn_at < $2
    AND ($4::text IS NULL OR ta.threat_type=$4)
    AND ($3::text[] IS NULL OR v.versions && $3::text[])
),
seed AS (SELECT DISTINCT location_id FROM withdrawn),
${OBLAST_ROLLUP}
SELECT 'oblast' AS dimension,
       COALESCE(o.oblast_id,w.location_id) AS key,
       COALESCE(l.name_uk,w.location_id) AS label,
       w.classifier_version,
       count(*)::int AS withdrawals,
       count(DISTINCT w.event_id)::int AS events,
       count(DISTINCT w.source_id)::int AS sources,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY w.held_seconds) AS median_held_seconds,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY w.held_seconds) AS p90_held_seconds
FROM withdrawn w
LEFT JOIN oblast_of o ON o.location_id=w.location_id
LEFT JOIN locations l ON l.id=COALESCE(o.oblast_id,w.location_id)
GROUP BY 1,2,3,4
UNION ALL
SELECT 'source', w.source_id, COALESCE(s.name,w.source_id), w.classifier_version,
       count(*)::int, count(DISTINCT w.event_id)::int, 1,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY w.held_seconds),
       percentile_cont(0.9) WITHIN GROUP (ORDER BY w.held_seconds)
FROM withdrawn w LEFT JOIN sources s ON s.id=w.source_id
GROUP BY 1,2,3,4
UNION ALL
SELECT 'threat_type', w.threat_type, w.threat_type, w.classifier_version,
       count(*)::int, count(DISTINCT w.event_id)::int, count(DISTINCT w.source_id)::int,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY w.held_seconds),
       percentile_cont(0.9) WITHIN GROUP (ORDER BY w.held_seconds)
FROM withdrawn w
GROUP BY 1,2,3,4
ORDER BY 1,5 DESC,2`;

  const aggregates = (await pool.query<{
    dimension: string; key: string; label: string; classifier_version: string | null;
    withdrawals: number; events: number; sources: number;
    median_held_seconds: number | null; p90_held_seconds: number | null;
  }>(sql, [window.from, window.to, window.classifierVersions, window.threatType])).rows;

  // The rate: how many of the claims opened in this window were taken back at all. Served by
  // `threat_assertions_asserted_idx` from migrations/015_analytics.sql.
  const rate = (await pool.query<{
    classifier_version: string | null; asserted: number; withdrawn: number; median_held_seconds: number | null;
  }>(
    `SELECT ${versionOf('v.versions')} AS classifier_version,
            count(*)::int AS asserted,
            count(*) FILTER (WHERE ta.withdrawn_at IS NOT NULL)::int AS withdrawn,
            percentile_cont(0.5) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (ta.withdrawn_at - ta.asserted_at))::double precision
            ) AS median_held_seconds
     FROM threat_assertions ta
     LEFT JOIN LATERAL (
       SELECT array_agg(DISTINCT m.classifier_version) AS versions
       FROM message_classifications m WHERE m.source_message_id=ta.asserted_message_id
     ) v ON true
     WHERE ta.asserted_at >= $1 AND ta.asserted_at < $2
       AND ($4::text IS NULL OR ta.threat_type=$4)
       AND ($3::text[] IS NULL OR v.versions && $3::text[])
     GROUP BY 1 ORDER BY 1`,
    [window.from, window.to, window.classifierVersions, window.threatType]
  )).rows;

  const closed = (await pool.query<{
    event_id: string; threat_type: string; evidence_level: string;
    last_asserted_by: string; last_asserted_for: string; withdrawn_by: string; withdrawn_for: string;
    withdrawal_reason: string | null; held_seconds: number | null; withdrawn_at: Date;
    classifier_version: string | null;
  }>(
    `SELECT e.id AS event_id, e.threat_type, e.evidence_level,
            last_assertion.source_id AS last_asserted_by, last_assertion.location_id AS last_asserted_for,
            withdrawal.source_id AS withdrawn_by, withdrawal.location_id AS withdrawn_for,
            withdrawal.withdrawal_reason,
            EXTRACT(EPOCH FROM (withdrawal.withdrawn_at - last_assertion.asserted_at))::double precision AS held_seconds,
            withdrawal.withdrawn_at,
            ${versionOf('withdrawal.versions')} AS classifier_version
     FROM threat_events e
     CROSS JOIN LATERAL (
       SELECT ta.source_id,ta.location_id,ta.asserted_at FROM threat_assertions ta
       WHERE ta.event_id=e.id ORDER BY ta.asserted_at DESC,ta.id LIMIT 1
     ) AS last_assertion
     CROSS JOIN LATERAL (
       SELECT ta.source_id,ta.location_id,ta.withdrawn_at,ta.withdrawal_reason,
              (SELECT array_agg(DISTINCT m.classifier_version) FROM message_classifications m
               WHERE m.source_message_id=ta.withdrawn_message_id) AS versions
       FROM threat_assertions ta
       WHERE ta.event_id=e.id AND ta.withdrawn_at IS NOT NULL
       ORDER BY ta.withdrawn_at DESC,ta.id LIMIT 1
     ) AS withdrawal
     WHERE e.status='withdrawn'
       AND withdrawal.withdrawn_at >= $1 AND withdrawal.withdrawn_at < $2
       AND ($4::text IS NULL OR e.threat_type=$4)
       AND ($3::text[] IS NULL OR withdrawal.versions && $3::text[])
     ORDER BY withdrawal.withdrawn_at DESC
     LIMIT $5`,
    [window.from, window.to, window.classifierVersions, window.threatType, window.limit]
  )).rows;

  const unattributed = aggregates.filter((row) => row.dimension === 'source' && row.classifier_version === null)
    .reduce((sum, row) => sum + row.withdrawals, 0);
  const totalAsserted = rate.reduce((sum, row) => sum + row.asserted, 0);
  const totalWithdrawn = rate.reduce((sum, row) => sum + row.withdrawn, 0);

  const toAggregate = (row: typeof aggregates[number]): LossAggregate => ({
    key: row.key,
    label: row.label,
    classifierVersion: row.classifier_version,
    withdrawals: row.withdrawals,
    events: row.events,
    sources: row.sources,
    medianHeldSeconds: row.median_held_seconds == null ? null : Number(row.median_held_seconds.toFixed(1)),
    p90HeldSeconds: row.p90_held_seconds == null ? null : Number(row.p90_held_seconds.toFixed(1))
  });

  const medianOverall = rate
    .map((row) => row.median_held_seconds)
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b);

  return {
    window: serialiseWindow(window),
    versionSafety: versionSafety(collectVersions(aggregates), { unattributed }),
    interception: {
      asserted: totalAsserted,
      withdrawn: totalWithdrawn,
      withdrawnShare: totalAsserted ? Number((totalWithdrawn / totalAsserted).toFixed(4)) : 0,
      medianHeldSeconds: medianOverall.length ? Number(medianOverall[Math.floor(medianOverall.length / 2)]!.toFixed(1)) : null,
      byVersion: rate.map((row) => ({
        classifierVersion: row.classifier_version,
        asserted: row.asserted,
        withdrawn: row.withdrawn,
        withdrawnShare: row.asserted ? Number((row.withdrawn / row.asserted).toFixed(4)) : 0
      }))
    },
    byOblast: aggregates.filter((row) => row.dimension === 'oblast').map(toAggregate),
    bySource: aggregates.filter((row) => row.dimension === 'source').map(toAggregate),
    byThreatType: aggregates.filter((row) => row.dimension === 'threat_type').map(toAggregate),
    closedEvents: closed.map((row) => ({
      eventId: row.event_id,
      threatType: row.threat_type,
      evidenceLevel: row.evidence_level,
      lastAssertedBy: row.last_asserted_by,
      lastAssertedFor: row.last_asserted_for,
      withdrawnBy: row.withdrawn_by,
      withdrawnFor: row.withdrawn_for,
      withdrawalReason: row.withdrawal_reason,
      heldSeconds: row.held_seconds == null ? null : Number(row.held_seconds.toFixed(1)),
      withdrawnAt: row.withdrawn_at.toISOString(),
      classifierVersion: row.classifier_version
    }))
  };
}

// ------------------------------------------------------------------------------------------------
// 4. Source performance — who is first, who repeats, whose text we fail to read
// ------------------------------------------------------------------------------------------------

export interface SourcePerformanceRow {
  sourceId: string;
  name: string;
  tier: string;
  independenceGroup: string;
  classifierVersion: string;
  messages: number;
  eventsRaised: number;
  corroborations: number;
  redirects: number;
  deEscalations: number;
  emptyWithdrawals: number;
  coalesced: number;
  ignored: number;
  unrecognized: number;
  noLocation: number;
  notAnAssertion: number;
  firstReports: number;
  followUps: number;
  medianLagSeconds: number | null;
  signalShare: number;
  duplicateShare: number;
  unreadableShare: number;
}

export interface SourcePerformance {
  window: SerialisedWindow;
  versionSafety: VersionSafety;
  rows: SourcePerformanceRow[];
}

/**
 * What each source is actually contributing, per classifier version.
 *
 * `firstReports` is the count of events this source published about before anyone else did, decided
 * inside a single version so a v2 replay of the same night cannot make a channel look faster than it
 * was. `medianLagSeconds` is measured only over the events it did *not* lead, which is the number
 * that means "how far behind the leader" — including the events it led would drag every median
 * towards zero and make a fast source indistinguishable from a prolific one.
 *
 * `unreadableShare` is the share of a source's messages this project failed to turn into anything.
 * It is a defect metric for `src/domain/classifier.ts` first and a quality metric for the channel
 * second, which is why it is reported per version: the honest way to justify a classifier change is
 * this column falling on the same corpus.
 */
export async function sourcePerformance(window: AnalyticsWindow): Promise<SourcePerformance> {
  const sql = `
WITH base AS (
  SELECT mc.id, mc.source_id, mc.classifier_version, mc.published_at, mc.decision, mc.created_event,
         mc.event_id, mc.ignored_reason, mc.withdrawn_assertions
  FROM message_classifications mc
  WHERE ${CLASSIFICATION_FILTER}
),
leaders AS (
  SELECT DISTINCT ON (classifier_version,event_id) classifier_version, event_id, source_id
  FROM base WHERE event_id IS NOT NULL
  ORDER BY classifier_version, event_id, published_at, id
),
firsts AS (
  SELECT classifier_version, event_id, min(published_at) AS first_at
  FROM base WHERE event_id IS NOT NULL GROUP BY 1,2
),
per_event AS (
  SELECT b.classifier_version, b.source_id, b.event_id,
         EXTRACT(EPOCH FROM (min(b.published_at) - f.first_at))::double precision AS lag_seconds
  FROM base b JOIN firsts f ON f.classifier_version=b.classifier_version AND f.event_id=b.event_id
  WHERE b.event_id IS NOT NULL
  GROUP BY 1,2,3,f.first_at
),
lag_stats AS (
  SELECT classifier_version, source_id,
         count(*) FILTER (WHERE lag_seconds > 0)::int AS follow_ups,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY lag_seconds)
           FILTER (WHERE lag_seconds > 0) AS median_lag_seconds
  FROM per_event GROUP BY 1,2
),
led AS (
  SELECT classifier_version, source_id, count(*)::int AS first_reports FROM leaders GROUP BY 1,2
)
SELECT b.source_id, COALESCE(s.name,b.source_id) AS name, COALESCE(s.tier,'?') AS tier,
       COALESCE(s.independence_group,'?') AS independence_group, b.classifier_version,
       count(*)::int AS messages,
       count(*) FILTER (WHERE b.created_event)::int AS events_raised,
       count(*) FILTER (WHERE b.decision='event_merged')::int AS corroborations,
       count(*) FILTER (WHERE b.decision='redirect')::int AS redirects,
       count(*) FILTER (WHERE b.decision='de_escalation')::int AS de_escalations,
       count(*) FILTER (WHERE b.decision='de_escalation' AND b.withdrawn_assertions=0)::int AS empty_withdrawals,
       count(*) FILTER (WHERE b.decision='coalesced')::int AS coalesced,
       count(*) FILTER (WHERE b.decision='ignored')::int AS ignored,
       count(*) FILTER (WHERE b.decision='unrecognized')::int AS unrecognized,
       count(*) FILTER (WHERE b.ignored_reason='no_location')::int AS no_location,
       count(*) FILTER (WHERE b.ignored_reason='not_an_assertion')::int AS not_an_assertion,
       COALESCE(led.first_reports,0)::int AS first_reports,
       COALESCE(lag_stats.follow_ups,0)::int AS follow_ups,
       lag_stats.median_lag_seconds
FROM base b
LEFT JOIN sources s ON s.id=b.source_id
LEFT JOIN led ON led.classifier_version=b.classifier_version AND led.source_id=b.source_id
LEFT JOIN lag_stats ON lag_stats.classifier_version=b.classifier_version AND lag_stats.source_id=b.source_id
GROUP BY 1,2,3,4,5,led.first_reports,lag_stats.follow_ups,lag_stats.median_lag_seconds
ORDER BY 6 DESC,1`;

  const rows = (await pool.query<{
    source_id: string; name: string; tier: string; independence_group: string; classifier_version: string;
    messages: number; events_raised: number; corroborations: number; redirects: number;
    de_escalations: number; empty_withdrawals: number; coalesced: number; ignored: number;
    unrecognized: number; no_location: number; not_an_assertion: number;
    first_reports: number; follow_ups: number; median_lag_seconds: number | null;
  }>(sql, classificationParams(window).slice(0, 4))).rows;

  return {
    window: serialiseWindow(window),
    versionSafety: versionSafety(collectVersions(rows)),
    rows: rows.map((row) => ({
      sourceId: row.source_id,
      name: row.name,
      tier: row.tier,
      independenceGroup: row.independence_group,
      classifierVersion: row.classifier_version,
      messages: row.messages,
      eventsRaised: row.events_raised,
      corroborations: row.corroborations,
      redirects: row.redirects,
      deEscalations: row.de_escalations,
      emptyWithdrawals: row.empty_withdrawals,
      coalesced: row.coalesced,
      ignored: row.ignored,
      unrecognized: row.unrecognized,
      noLocation: row.no_location,
      notAnAssertion: row.not_an_assertion,
      firstReports: row.first_reports,
      followUps: row.follow_ups,
      medianLagSeconds: row.median_lag_seconds == null ? null : Number(row.median_lag_seconds.toFixed(1)),
      signalShare: Number(((row.events_raised + row.corroborations + row.redirects) / row.messages).toFixed(4)),
      duplicateShare: Number(((row.corroborations + row.coalesced) / row.messages).toFixed(4)),
      unreadableShare: Number(((row.ignored + row.unrecognized) / row.messages).toFixed(4))
    }))
  };
}

// ------------------------------------------------------------------------------------------------
// 5. Classifier version comparison — the same corpus, two sets of rules
// ------------------------------------------------------------------------------------------------

export interface DecisionMigration {
  baselineDecision: string;
  candidateDecision: string;
  messages: number;
  threatTypeChanged: number;
}

export interface ClassifierVersionComparison {
  window: SerialisedWindow;
  baseline: string;
  candidate: string;
  /** Messages judged by both versions — the only rows a comparison is entitled to use. */
  sharedMessages: number;
  onlyBaseline: number;
  onlyCandidate: number;
  sameCorpus: boolean;
  agreementRate: number | null;
  decisionMigration: DecisionMigration[];
  totals: Array<{ classifierVersion: string; messages: number; eventsRaised: number; unreadable: number }>;
  notes: string[];
}

/**
 * Two classifier versions over the messages they both judged.
 *
 * `UNIQUE (source_message_id, classifier_version)` is what makes this possible: a replay under new
 * rules lands beside the old verdict instead of overwriting it, so the archive is a golden corpus.
 * The comparison is restricted to the intersection — `onlyBaseline`/`onlyCandidate` report how much
 * of each version's output had no counterpart, and `sameCorpus` is false whenever either is non-zero,
 * because a version that simply saw more messages will look better at everything otherwise.
 *
 * `decisionMigration` is the useful artefact: not "v2 is better" but "142 messages v1 called
 * `unrecognized` v2 calls `event_created`", which is a claim somebody can go and check.
 */
export async function classifierVersionComparison(
  window: AnalyticsWindow, baseline: string, candidate: string
): Promise<ClassifierVersionComparison> {
  if (!IDENTIFIER.test(baseline) || !IDENTIFIER.test(candidate)) {
    throw new AnalyticsInputError('invalid_version', 'classifier version is not a valid identifier');
  }
  if (baseline === candidate) {
    throw new AnalyticsInputError('same_version', 'baseline and candidate must be different classifier versions');
  }

  const params = [window.from, window.to, baseline, candidate];
  const counts = (await pool.query<{
    shared: number; only_baseline: number; only_candidate: number; agreed: number;
  }>(
    `WITH a AS (SELECT source_message_id,decision,threat_type FROM message_classifications
                WHERE classifier_version=$3 AND published_at>=$1 AND published_at<$2),
          b AS (SELECT source_message_id,decision,threat_type FROM message_classifications
                WHERE classifier_version=$4 AND published_at>=$1 AND published_at<$2)
     SELECT (SELECT count(*) FROM a JOIN b USING (source_message_id))::int AS shared,
            (SELECT count(*) FROM a WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.source_message_id=a.source_message_id))::int AS only_baseline,
            (SELECT count(*) FROM b WHERE NOT EXISTS (SELECT 1 FROM a WHERE a.source_message_id=b.source_message_id))::int AS only_candidate,
            (SELECT count(*) FROM a JOIN b USING (source_message_id) WHERE a.decision=b.decision)::int AS agreed`,
    params
  )).rows[0]!;

  const migration = (await pool.query<{
    baseline_decision: string; candidate_decision: string; messages: number; threat_type_changed: number;
  }>(
    `WITH a AS (SELECT source_message_id,decision,threat_type FROM message_classifications
                WHERE classifier_version=$3 AND published_at>=$1 AND published_at<$2),
          b AS (SELECT source_message_id,decision,threat_type FROM message_classifications
                WHERE classifier_version=$4 AND published_at>=$1 AND published_at<$2)
     SELECT a.decision AS baseline_decision, b.decision AS candidate_decision,
            count(*)::int AS messages,
            count(*) FILTER (WHERE a.threat_type IS DISTINCT FROM b.threat_type)::int AS threat_type_changed
     FROM a JOIN b USING (source_message_id)
     GROUP BY 1,2 ORDER BY 3 DESC,1,2`,
    params
  )).rows;

  const totals = (await pool.query<{
    classifier_version: string; messages: number; events_raised: number; unreadable: number;
  }>(
    `SELECT classifier_version, count(*)::int AS messages,
            count(*) FILTER (WHERE created_event)::int AS events_raised,
            count(*) FILTER (WHERE decision IN ('ignored','unrecognized'))::int AS unreadable
     FROM message_classifications
     WHERE published_at>=$1 AND published_at<$2 AND classifier_version = ANY(ARRAY[$3,$4])
     GROUP BY 1 ORDER BY 1`,
    params
  )).rows;

  const sameCorpus = counts.only_baseline === 0 && counts.only_candidate === 0;
  const notes: string[] = [];
  if (!sameCorpus) {
    notes.push(
      `Корпуси не збігаються: ${counts.only_baseline} повідомлень судила лише ${baseline}, `
      + `${counts.only_candidate} — лише ${candidate}. Порівнюйте лише перетин (${counts.shared}); `
      + 'різниця сумарних чисел відображає різне покриття, а не якість правил.'
    );
  }
  if (counts.shared === 0) {
    notes.push('Жодне повідомлення не судили обидві версії — порівняння неможливе на цьому вікні.');
  }

  return {
    window: serialiseWindow(window),
    baseline,
    candidate,
    sharedMessages: counts.shared,
    onlyBaseline: counts.only_baseline,
    onlyCandidate: counts.only_candidate,
    sameCorpus,
    agreementRate: counts.shared ? Number((counts.agreed / counts.shared).toFixed(4)) : null,
    decisionMigration: migration.map((row) => ({
      baselineDecision: row.baseline_decision,
      candidateDecision: row.candidate_decision,
      messages: row.messages,
      threatTypeChanged: row.threat_type_changed
    })),
    totals: totals.map((row) => ({
      classifierVersion: row.classifier_version,
      messages: row.messages,
      eventsRaised: row.events_raised,
      unreadable: row.unreadable
    })),
    notes
  };
}

// ------------------------------------------------------------------------------------------------
// 6. Strike composition — what a wave is made of, and what the launch side is doing
// ------------------------------------------------------------------------------------------------

export interface CompositionPoint {
  bucket: string;
  classifierVersion: string;
  threatType: string;
  messages: number;
  share: number;
}

export interface IndicatorPoint {
  classifierVersion: string;
  indicator: string;
  messages: number;
  sources: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface StrikeComposition {
  window: SerialisedWindow;
  versionSafety: VersionSafety;
  /** From `candidate_threat_types`: everything a message matched, before the aggregate collapse. */
  composition: CompositionPoint[];
  indicators: IndicatorPoint[];
  nationalScope: Array<{ bucket: string; classifierVersion: string; national: number; located: number; nationalShare: number }>;
}

/**
 * What the reported waves are made of.
 *
 * `candidate_threat_types` is the column 012 added for exactly this: every class a message matched
 * before the pipeline collapsed a mixed message into the aggregate `combined`. A shift from
 * single-class to mixed reporting is the shape a change in strike composition takes, and the
 * collapsed `threat_type` cannot show it.
 *
 * `indicators` is the launch-side view — MiG-31K activity, strategic aviation taking off, naval
 * missile carriers at sea. These fire before anything is over Ukraine, so their trend is the closest
 * this archive gets to a leading signal about intent.
 */
export async function strikeComposition(window: AnalyticsWindow): Promise<StrikeComposition> {
  const params = classificationParams(window);
  const composition = (await pool.query<{
    bucket: string; classifier_version: string; threat_type: string; messages: number;
  }>(
    `SELECT date_trunc($5::text,mc.published_at AT TIME ZONE $6::text)::date::text AS bucket,
            mc.classifier_version, t AS threat_type, count(*)::int AS messages
     FROM message_classifications mc, unnest(mc.candidate_threat_types) AS t
     WHERE ${CLASSIFICATION_FILTER} AND mc.decision = ANY($7::text[])
     GROUP BY 1,2,3 ORDER BY 1,2,4 DESC`,
    [...params, window.timezone, ASSERTING_DECISIONS]
  )).rows;

  const indicators = (await pool.query<{
    classifier_version: string; indicator: string; messages: number; sources: number;
    first_seen_at: Date; last_seen_at: Date;
  }>(
    `SELECT mc.classifier_version, i AS indicator, count(*)::int AS messages,
            count(DISTINCT mc.source_id)::int AS sources,
            min(mc.published_at) AS first_seen_at, max(mc.published_at) AS last_seen_at
     FROM message_classifications mc, unnest(mc.indicators) AS i
     WHERE ${CLASSIFICATION_FILTER}
     GROUP BY 1,2 ORDER BY 3 DESC,2 LIMIT $5`,
    [...params.slice(0, 4), window.limit]
  )).rows;

  const national = (await pool.query<{
    bucket: string; classifier_version: string; national: number; located: number;
  }>(
    `SELECT date_trunc($5::text,mc.published_at AT TIME ZONE $6::text)::date::text AS bucket,
            mc.classifier_version,
            count(*) FILTER (WHERE mc.national_scope)::int AS national,
            count(*) FILTER (WHERE NOT mc.national_scope)::int AS located
     FROM message_classifications mc
     WHERE ${CLASSIFICATION_FILTER} AND mc.decision = ANY($7::text[])
     GROUP BY 1,2 ORDER BY 1,2`,
    [...params, window.timezone, ASSERTING_DECISIONS]
  )).rows;

  const totals = new Map<string, number>();
  for (const row of composition) {
    const key = `${row.bucket}|${row.classifier_version}`;
    totals.set(key, (totals.get(key) ?? 0) + row.messages);
  }

  return {
    window: serialiseWindow(window),
    versionSafety: versionSafety(collectVersions([...composition, ...indicators, ...national])),
    composition: composition.map((row) => ({
      bucket: row.bucket,
      classifierVersion: row.classifier_version,
      threatType: row.threat_type,
      messages: row.messages,
      share: Number((row.messages / (totals.get(`${row.bucket}|${row.classifier_version}`) || 1)).toFixed(4))
    })),
    indicators: indicators.map((row) => ({
      classifierVersion: row.classifier_version,
      indicator: row.indicator,
      messages: row.messages,
      sources: row.sources,
      firstSeenAt: row.first_seen_at.toISOString(),
      lastSeenAt: row.last_seen_at.toISOString()
    })),
    nationalScope: national.map((row) => ({
      bucket: row.bucket,
      classifierVersion: row.classifier_version,
      national: row.national,
      located: row.located,
      nationalShare: Number((row.national / (row.national + row.located || 1)).toFixed(4))
    }))
  };
}

// ------------------------------------------------------------------------------------------------
// 7. The overview the narrative reads
// ------------------------------------------------------------------------------------------------

export interface StrategicOverview {
  window: SerialisedWindow;
  coverage: ArchiveCoverage;
  versionSafety: VersionSafety;
  dynamics: ThreatTypeDynamics;
  geography: GeographyShift;
  loss: LossPoints;
  sources: SourcePerformance;
  composition: StrikeComposition;
}

/**
 * Every slice for one window, in one object.
 *
 * This is also the exact input `analytics-narrative.ts` is given: the model sees these numbers and
 * nothing else, so anything it says has to be derivable from what is here.
 */
export async function strategicOverview(window: AnalyticsWindow): Promise<StrategicOverview> {
  const [coverage, dynamics, geography, loss, sources, composition] = await Promise.all([
    archiveCoverage(),
    threatTypeDynamics(window),
    geographyShift(window),
    lossPoints(window),
    sourcePerformance(window),
    strikeComposition(window)
  ]);
  const versions = [...new Set([
    ...dynamics.versionSafety.versionsInWindow,
    ...geography.versionSafety.versionsInWindow,
    ...loss.versionSafety.versionsInWindow,
    ...sources.versionSafety.versionsInWindow,
    ...composition.versionSafety.versionsInWindow
  ])].sort();
  return {
    window: serialiseWindow(window),
    coverage,
    versionSafety: versionSafety(versions, {
      comparable: geography.versionSafety.comparable,
      unattributed: loss.versionSafety.unattributed,
      notes: geography.versionSafety.notes.filter((note) => !note.startsWith('Вікно містить'))
    }),
    dynamics,
    geography,
    loss,
    sources,
    composition
  };
}
