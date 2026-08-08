import { pool } from '../db/pool.js';

/**
 * Dynamic source trust — what the archive says about a publisher, recomputed once a day.
 *
 * `sources.tier` says what a channel is *allowed* to be: 'A' is a body with a state mandate to
 * declare an air-raid alert, 'C' is an auxiliary channel. It is written by hand in
 * `migrations/013_source_catalog_expansion.sql` and by nothing else. This module measures something
 * different — how a publisher has actually behaved over the last thirty days — and stores it in its
 * own table (`migrations/021_source_trust.sql`). The two axes never touch: nothing here writes to
 * `sources`, and the guardrails in `src/services/risk.ts` that cap a Tier-C-only location at 3.9 run
 * *after* trust has been applied, so no amount of good behaviour turns a C into an A.
 *
 * ## The five metrics, and why each one is evidence about a source
 *
 *   * **withdrawnShare** — the share of this source's assertions it later took back. A channel that
 *     regularly retracts is a channel that regularly published something that was not there. This is
 *     the heaviest term.
 *   * **corroboratedShare** — the share of its events that a *different independence group* also
 *     asserted. Corroboration by a repost of itself is not corroboration, which is why the group and
 *     not the source id is the unit; the groups are declared in the catalogue precisely so that a
 *     repost aggregator collapses into the channel it copies.
 *   * **firstReports** — events it published before anybody else. Reposts are excluded structurally,
 *     see {@link countFirstReports}.
 *   * **lagMedianSeconds** — median seconds behind the first reporter, over the events it did *not*
 *     lead. Including the events it led would drag every median towards zero and make a fast source
 *     indistinguishable from a prolific one — the same reasoning as `sourcePerformance` in
 *     `./analytics-archive.ts`, whose SQL shapes this module's queries.
 *   * **unreadableShare** — the share of its messages this project failed to turn into anything. It
 *     is a defect metric for `src/domain/classifier.ts` first and a quality metric for the channel
 *     second, so it carries the smallest weight of the behavioural terms and can never on its own
 *     push a source below the floors below.
 *
 * ## Four guardrails, each of which is a test in `./source-trust.test.ts`
 *
 *   1. **Trust does not change tier.** No statement in this file writes `sources`, and the value is
 *      consumed only as a bounded multiplier on a signal's contribution.
 *   2. **Official sources are never pushed below neutral.** A body with a state mandate that had a
 *      bad month is still the body with the mandate; the correct response to an official source
 *      being wrong is an editorial decision about its row in the catalogue, not a silent nightly
 *      demotion of the state's own alert channel.
 *   3. **A repost is not a first report.** Leadership is decided per independence group and then
 *      across groups, so an aggregator that copies a channel it shares a group with is never the
 *      group's earliest voice and earns nothing.
 *   4. **Old observations weigh less.** Every share is weighted by {@link decayWeight}, a ten-day
 *      half-life over the thirty-day window, so last night's retraction says more about the channel
 *      today than one four weeks ago.
 *
 * Nothing here calls a model, and nothing here is published. Trust is an internal weighting and an
 * operator-facing explanation; the public surface says "висока / звичайна / знижена" in words and
 * keeps the arithmetic in a collapsed block.
 */

// ------------------------------------------------------------------------------------------------
// Constants — the whole methodology in eleven numbers
// ------------------------------------------------------------------------------------------------

/**
 * Stamped on every row. Bump it whenever any constant or weight below changes, so that a step in a
 * source's series can be attributed to us rather than to the channel — the same contract
 * `classifier_version` has in the classification archive.
 */
export const TRUST_METHODOLOGY_VERSION = 'trust-v1';

/** The window every metric is measured over. */
export const TRUST_WINDOW_DAYS = 30;

/**
 * Half-life of an observation inside that window.
 *
 * Ten days over a thirty-day window means the oldest observation still counted carries about an
 * eighth of the weight of last night's. Shorter and the number would jitter with a single quiet
 * week; longer and a channel that has visibly improved would be judged on behaviour it has already
 * corrected.
 */
export const TRUST_HALF_LIFE_DAYS = 10;

/** The value a source has before the archive has anything to say about it, and the official floor. */
export const NEUTRAL_TRUST = 0.5;

/**
 * Below this many observed events the window cannot distinguish a bad channel from an unlucky one,
 * so the source keeps {@link NEUTRAL_TRUST} and its metrics are recorded but not scored. Twenty is
 * the point at which a single retraction stops moving `withdrawnShare` by more than five points.
 */
export const MIN_SAMPLE_SIZE = 20;

/**
 * The lag at which the speed term reaches zero. Fifteen minutes is roughly the life of a UAV
 * transit report: a source that is a quarter of an hour behind the leader contributed nothing the
 * leader had not already contributed.
 */
export const LAG_REFERENCE_SECONDS = 900;

/**
 * Weights, summing to 1. Ordered by how directly the metric is evidence about the *source* rather
 * than about us: retraction and corroboration are the channel's own record, speed is a property of
 * its reporting, and readability is mostly a property of our parser.
 */
export const TRUST_WEIGHTS = {
  withdrawn: 0.35,
  corroborated: 0.25,
  lead: 0.15,
  lag: 0.10,
  unreadable: 0.15
} as const;

/**
 * Where the modifier that `src/services/risk.ts` applies is allowed to go.
 *
 * A floor of 0.6 and a ceiling of 1.2, rather than 0 and 2, because trust modulates an assessment
 * and must not become one. Three consequences, all intended:
 *
 *   * **The assessment stays complete without the trust layer.** With no `source_trust` row the
 *     modifier is exactly 1.0 and every number is what it was before this feature existed. A source
 *     that has never been measured is not thereby penalised, and a failed nightly run degrades to
 *     "no change" rather than to "everything is suspect".
 *   * **A distrusted source is discounted, never erased.** At the floor a signal still contributes
 *     60% of its evidential weight. A channel whose measurements are bad is a channel that has been
 *     wrong before, not a channel that is wrong now; silencing it would let a real threat reported
 *     only by the imperfect source disappear from the map, which is the one failure this system may
 *     not have.
 *   * **A trusted source cannot outrun the guardrails.** The ceiling of 1.2 is small enough that no
 *     combination of trusted Tier C signals reaches the 3.9 cap from below in a way it would not
 *     have reached anyway; and the cap is applied afterwards regardless, so the ceiling is a
 *     convenience, not the safety property.
 */
export const TRUST_MODIFIER_FLOOR = 0.6;
export const TRUST_MODIFIER_CEILING = 1.2;

/** Word boundaries for the human-readable label. One definition, used by every surface. */
export const TRUST_HIGH_FROM = 0.65;
export const TRUST_REDUCED_TO = 0.40;

// ------------------------------------------------------------------------------------------------
// Pure formula
// ------------------------------------------------------------------------------------------------

export interface TrustComponents {
  /** Decay-weighted share of assertions later withdrawn, 0..1. */
  withdrawnShare: number;
  /** Decay-weighted share of events another independence group also asserted, 0..1. */
  corroboratedShare: number;
  /** Events this source published before anyone else, reposts excluded. */
  firstReports: number;
  /** Median seconds behind the leader over events it did not lead; `null` when it always led. */
  lagMedianSeconds: number | null;
  /** Decay-weighted share of its messages the classifier could not read, 0..1. */
  unreadableShare: number;
  /** Distinct events it asserted on inside the window. */
  sampleSize: number;
}

export interface TrustInput extends TrustComponents {
  /** From `sources.official`. Carries guardrail (b): a mandated body never falls below neutral. */
  official: boolean;
  /**
   * From `sources.tier`. Carried through onto the result for display only — nothing in this module
   * reads it to decide a number, and nothing writes it back. Guardrail (a) is the absence of any
   * such use, which `./source-trust.test.ts` asserts against the returned object.
   */
  tier: 'A' | 'B' | 'C';
  /**
   * The window the metrics above were measured over. Read for one purpose only — the sentence shown
   * to an operator when a source is left neutral has to name the window the run actually used, not
   * the default. A run over seven days that says "за 30 днів" is a message that sends somebody
   * looking for a month of data that was never read.
   */
  windowDays?: number;
}

export interface TrustResult {
  trust: number;
  components: TrustComponents;
  /** True when the score is the neutral start rather than a measurement. */
  neutral: boolean;
  /** Why it is neutral, when it is. Shown verbatim in the ops console. */
  neutralReason: string | null;
  /** True when the official floor actually raised the measured value. */
  officialFloorApplied: boolean;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * How much an observation that happened `ageDays` ago still counts.
 *
 * Exponential with a ten-day half-life, matching the shape `effectiveContribution` in
 * `src/services/risk.ts` uses for signal freshness — one decay curve in the product, two horizons.
 * Ages before now are clamped to zero so a clock skew cannot make an observation count double.
 */
export function decayWeight(ageDays: number, halfLifeDays = TRUST_HALF_LIFE_DAYS): number {
  return 2 ** (-Math.max(0, ageDays) / halfLifeDays);
}

/** The decay-weighted share of observations that carry a flag. Zero observations means zero share. */
export function weightedShare(observations: Array<{ hit: boolean; ageDays: number }>): number {
  let total = 0;
  let hits = 0;
  for (const observation of observations) {
    const weight = decayWeight(observation.ageDays);
    total += weight;
    if (observation.hit) hits += weight;
  }
  return total === 0 ? 0 : hits / total;
}

export interface ReportObservation {
  eventId: string;
  sourceId: string;
  /** `sources.independence_group`. A repost aggregator shares it with the channel it copies. */
  independenceGroup: string;
  publishedAtMs: number;
}

/**
 * Who reported each event first, counted per source — with reposts structurally excluded.
 *
 * Two passes, in this order, and the order is the guardrail:
 *
 *   1. **Earliest message per (event, group).** Inside one independence group there is one voice.
 *      An aggregator that copies a channel it shares a group with is by definition not the earliest
 *      message of that group, so it never survives this pass.
 *   2. **Earliest group per event.** The source carrying the winning group's earliest message is the
 *      first reporter.
 *
 * Deciding leadership per *source* instead would hand a repost aggregator a first report every time
 * it happened to be the only member of its group covering an event it copied from outside — and
 * would let one statement, copied, look like two independent scoops. Ties break on source id so the
 * result does not depend on row order.
 *
 * Exported because `recalculateSourceTrust` runs the same logic in SQL and this is where it is
 * specified and tested; the two are checked against each other by the integration corpus.
 */
export function countFirstReports(observations: readonly ReportObservation[]): Map<string, number> {
  const groupFirst = new Map<string, ReportObservation>();
  for (const observation of observations) {
    // \u0000 as the separator rather than a raw NUL byte in the file: the value is identical at
    // runtime and it is the one character no id can contain, but a literal NUL in the source makes
    // the module read as a binary blob to grep, diff and half the editors that will ever open it.
    const key = `${observation.eventId}\u0000${observation.independenceGroup}`;
    const held = groupFirst.get(key);
    const earlier = !held || observation.publishedAtMs < held.publishedAtMs
      || (observation.publishedAtMs === held.publishedAtMs && observation.sourceId < held.sourceId);
    if (earlier) groupFirst.set(key, observation);
  }

  const eventLeader = new Map<string, ReportObservation>();
  for (const observation of groupFirst.values()) {
    const held = eventLeader.get(observation.eventId);
    const earlier = !held || observation.publishedAtMs < held.publishedAtMs
      || (observation.publishedAtMs === held.publishedAtMs && observation.sourceId < held.sourceId);
    if (earlier) eventLeader.set(observation.eventId, observation);
  }

  const counts = new Map<string, number>();
  for (const leader of eventLeader.values()) {
    counts.set(leader.sourceId, (counts.get(leader.sourceId) ?? 0) + 1);
  }
  return counts;
}

/**
 * The formula. Pure, total, and the only place a trust number is produced.
 *
 * Each term is normalised to 0..1 with "higher is better", multiplied by its weight and summed, so
 * the result is monotone in every metric by construction: more withdrawals lowers it, more
 * corroboration raises it, more first reports raises it, a longer lag lowers it, more unreadable
 * messages lowers it. That monotonicity is asserted metric by metric in the tests, because it is the
 * property that makes the number arguable — an operator can point at a component and say why.
 *
 * `lagMedianSeconds: null` means "never followed anyone", which the archive also reports for a
 * source that has barely spoken. It is scored as neutral 0.5 rather than as perfect speed: a source
 * with no measured lag has not demonstrated speed, it has only avoided demonstrating slowness.
 */
export function computeTrust(input: TrustInput): TrustResult {
  const components: TrustComponents = {
    withdrawnShare: round(clamp(input.withdrawnShare, 0, 1), 4),
    corroboratedShare: round(clamp(input.corroboratedShare, 0, 1), 4),
    firstReports: Math.max(0, Math.trunc(input.firstReports)),
    lagMedianSeconds: input.lagMedianSeconds == null ? null : round(Math.max(0, input.lagMedianSeconds), 1),
    unreadableShare: round(clamp(input.unreadableShare, 0, 1), 4),
    sampleSize: Math.max(0, Math.trunc(input.sampleSize))
  };

  if (components.sampleSize < MIN_SAMPLE_SIZE) {
    return {
      trust: NEUTRAL_TRUST,
      components,
      neutral: true,
      neutralReason: `Замало спостережень: ${components.sampleSize} подій за `
        + `${input.windowDays ?? TRUST_WINDOW_DAYS} днів при потрібних ${MIN_SAMPLE_SIZE}. `
        + 'Джерело лишається на нейтральному рівні.',
      officialFloorApplied: false
    };
  }

  const reliability = 1 - components.withdrawnShare;
  const corroboration = components.corroboratedShare;
  const lead = clamp(components.firstReports / components.sampleSize, 0, 1);
  const speed = components.lagMedianSeconds == null
    ? NEUTRAL_TRUST
    : clamp(1 - components.lagMedianSeconds / LAG_REFERENCE_SECONDS, 0, 1);
  const readability = 1 - components.unreadableShare;

  const measured = clamp(
    TRUST_WEIGHTS.withdrawn * reliability
    + TRUST_WEIGHTS.corroborated * corroboration
    + TRUST_WEIGHTS.lead * lead
    + TRUST_WEIGHTS.lag * speed
    + TRUST_WEIGHTS.unreadable * readability,
    0, 1
  );

  // Guardrail (b). Applied last so the floor is visible as a floor: the measured value is what the
  // components add up to, and `officialFloorApplied` says the catalogue overrode it.
  const trust = input.official ? Math.max(measured, NEUTRAL_TRUST) : measured;
  return {
    trust: round(trust),
    components,
    neutral: false,
    neutralReason: null,
    officialFloorApplied: input.official && measured < NEUTRAL_TRUST
  };
}

/**
 * The bounded multiplier `src/services/risk.ts` applies to a signal's contribution.
 *
 * Piecewise linear through three fixed points: 0 → {@link TRUST_MODIFIER_FLOOR}, the neutral 0.5 →
 * exactly 1.0, and 1 → {@link TRUST_MODIFIER_CEILING}. Anchoring the neutral value at 1.0 is what
 * makes "no measurement" and "measured as average" the same thing for the index, so a source
 * crossing the {@link MIN_SAMPLE_SIZE} threshold does not produce a step in every assessment it
 * touches. `null`/`undefined`/non-finite all mean "no row", which is 1.0.
 */
export function trustModifier(trust: number | null | undefined): number {
  if (trust == null || !Number.isFinite(Number(trust))) return 1;
  const value = clamp(Number(trust), 0, 1);
  const raw = value <= NEUTRAL_TRUST
    ? TRUST_MODIFIER_FLOOR + (1 - TRUST_MODIFIER_FLOOR) * (value / NEUTRAL_TRUST)
    : 1 + (TRUST_MODIFIER_CEILING - 1) * ((value - NEUTRAL_TRUST) / (1 - NEUTRAL_TRUST));
  return round(clamp(raw, TRUST_MODIFIER_FLOOR, TRUST_MODIFIER_CEILING), 4);
}

export type TrustLabel = 'висока' | 'звичайна' | 'знижена';

/**
 * The word the public surface uses. Numbers do not belong in the main flow of a threat card: a
 * reader deciding whether to take cover cannot act on "0.63", and a number invites a precision the
 * measurement does not have. The arithmetic stays one collapsed block away.
 */
export function trustLabel(trust: number | null | undefined): TrustLabel | null {
  if (trust == null || !Number.isFinite(Number(trust))) return null;
  const value = Number(trust);
  if (value >= TRUST_HIGH_FROM) return 'висока';
  if (value <= TRUST_REDUCED_TO) return 'знижена';
  return 'звичайна';
}

// ------------------------------------------------------------------------------------------------
// Measurement — the archive queries
// ------------------------------------------------------------------------------------------------

interface AssertionMetricsRow {
  source_id: string;
  sample_size: number;
  withdrawn_share: number | string | null;
  corroborated_share: number | string | null;
}

interface MessageMetricsRow {
  source_id: string;
  unreadable_share: number | string | null;
  first_reports: number;
  lag_median_seconds: number | string | null;
}

/**
 * Assertion-side metrics: how much this source claimed, how much it took back, and how much of it
 * anybody else confirmed.
 *
 * Both shares are decay-weighted in SQL with the same half-life {@link decayWeight} uses, so the
 * worker and the pure helper cannot drift apart in what "recent" means. The unit is one
 * (source, event) pair rather than one assertion row, because a source that asserts the same event
 * for six locations should not count as six witnesses when its seventh assertion is withdrawn.
 *
 * Corroboration tests `independence_group <> `, never `source_id <>`: the group is exactly the
 * column the catalogue uses to say "these two channels are one voice", and a repost of an official
 * statement must not corroborate the official statement.
 */
async function assertionMetrics(windowDays: number, halfLifeDays: number): Promise<Map<string, AssertionMetricsRow>> {
  const rows = (await pool.query<AssertionMetricsRow>(
    `WITH per_event AS (
       SELECT ta.source_id, ta.event_id, ta.independence_group,
              min(ta.asserted_at) AS asserted_at,
              bool_or(ta.withdrawn_at IS NOT NULL) AS withdrawn
       FROM threat_assertions ta
       WHERE ta.asserted_at >= now() - ($1::int * interval '1 day')
       GROUP BY 1,2,3
     ),
     weighted AS (
       SELECT p.source_id, p.event_id, p.withdrawn,
              power(0.5, EXTRACT(EPOCH FROM (now() - p.asserted_at)) / 86400.0 / $2::double precision) AS weight,
              EXISTS (
                SELECT 1 FROM threat_assertions o
                WHERE o.event_id = p.event_id
                  AND o.independence_group <> p.independence_group
                  AND o.asserted_at >= now() - ($1::int * interval '1 day')
              ) AS corroborated
       FROM per_event p
     )
     SELECT source_id,
            count(*)::int AS sample_size,
            CASE WHEN sum(weight) > 0
                 THEN sum(weight) FILTER (WHERE withdrawn) / sum(weight) END AS withdrawn_share,
            CASE WHEN sum(weight) > 0
                 THEN sum(weight) FILTER (WHERE corroborated) / sum(weight) END AS corroborated_share
     FROM weighted GROUP BY 1`,
    [windowDays, halfLifeDays]
  )).rows;
  return new Map(rows.map((row) => [row.source_id, row]));
}

/**
 * Message-side metrics: readability, leadership and lag.
 *
 * `group_first` and `event_leader` are {@link countFirstReports} written in SQL, in the same order
 * and for the same reason — the group's earliest message first, then the earliest group. An
 * aggregator sharing a group with the channel it reposts never appears in `group_first` for an event
 * that channel already covered, so it earns neither a first report nor a lag measurement for it.
 *
 * The lag is measured over `group_first` rather than over every message, so a channel that restates
 * its own report ten times in an hour is measured on when it first spoke, not on its noisiest
 * repetition. Events the source led are excluded by the `> el.first_at` filter for the reason given
 * in `sourcePerformance`: including them would flatter every median towards zero.
 */
async function messageMetrics(windowDays: number, halfLifeDays: number): Promise<Map<string, MessageMetricsRow>> {
  const rows = (await pool.query<MessageMetricsRow>(
    `WITH base AS (
       SELECT mc.source_id, mc.event_id, mc.published_at, mc.decision,
              COALESCE(s.independence_group, mc.source_id) AS independence_group,
              power(0.5, EXTRACT(EPOCH FROM (now() - mc.published_at)) / 86400.0 / $2::double precision) AS weight
       FROM message_classifications mc
       LEFT JOIN sources s ON s.id = mc.source_id
       WHERE mc.published_at >= now() - ($1::int * interval '1 day')
     ),
     readability AS (
       SELECT source_id,
              CASE WHEN sum(weight) > 0
                   THEN sum(weight) FILTER (WHERE decision IN ('ignored','unrecognized')) / sum(weight)
              END AS unreadable_share
       FROM base GROUP BY 1
     ),
     group_first AS (
       SELECT DISTINCT ON (event_id, independence_group)
              event_id, independence_group, source_id, published_at
       FROM base WHERE event_id IS NOT NULL
       ORDER BY event_id, independence_group, published_at, source_id
     ),
     event_leader AS (
       SELECT DISTINCT ON (event_id) event_id, source_id, published_at AS first_at
       FROM group_first ORDER BY event_id, published_at, source_id
     ),
     led AS (SELECT source_id, count(*)::int AS first_reports FROM event_leader GROUP BY 1),
     lag_stats AS (
       SELECT gf.source_id,
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (gf.published_at - el.first_at))::double precision
              ) FILTER (WHERE gf.published_at > el.first_at) AS lag_median_seconds
       FROM group_first gf JOIN event_leader el ON el.event_id = gf.event_id
       GROUP BY 1
     )
     SELECT r.source_id, r.unreadable_share,
            COALESCE(led.first_reports, 0)::int AS first_reports,
            lag_stats.lag_median_seconds
     FROM readability r
     LEFT JOIN led ON led.source_id = r.source_id
     LEFT JOIN lag_stats ON lag_stats.source_id = r.source_id`,
    [windowDays, halfLifeDays]
  )).rows;
  return new Map(rows.map((row) => [row.source_id, row]));
}

function numeric(value: number | string | null | undefined, fallback: number): number {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface TrustRun {
  computedAt: string;
  windowDays: number;
  methodologyVersion: string;
  sources: number;
  neutral: number;
}

/**
 * One nightly pass: measure every catalogued source, score it, append a row per source.
 *
 * Every source in the catalogue gets a row, including the ones the window says nothing about — a
 * missing row and a neutral row are different states, and only the second one is a statement that we
 * looked. All rows share one `computed_at` so a run is a run and can be read back as a slice.
 *
 * The whole insert is one transaction. A partially written run would leave half the catalogue on
 * yesterday's numbers and half on today's, which is exactly the kind of inconsistency an operator
 * would spend an evening chasing.
 */
export async function recalculateSourceTrust(
  options: { windowDays?: number; halfLifeDays?: number } = {}
): Promise<TrustRun> {
  const windowDays = options.windowDays ?? TRUST_WINDOW_DAYS;
  const halfLifeDays = options.halfLifeDays ?? TRUST_HALF_LIFE_DAYS;

  const [sources, assertions, messages] = await Promise.all([
    pool.query<{ id: string; tier: 'A' | 'B' | 'C'; official: boolean }>(
      `SELECT id,tier,official FROM sources ORDER BY id`
    ),
    assertionMetrics(windowDays, halfLifeDays),
    messageMetrics(windowDays, halfLifeDays)
  ]);

  const computedAt = new Date();
  const results = sources.rows.map((source) => {
    const assertion = assertions.get(source.id);
    const message = messages.get(source.id);
    return {
      sourceId: source.id,
      result: computeTrust({
        official: source.official,
        tier: source.tier,
        windowDays,
        withdrawnShare: numeric(assertion?.withdrawn_share, 0),
        corroboratedShare: numeric(assertion?.corroborated_share, 0),
        firstReports: message?.first_reports ?? 0,
        lagMedianSeconds: message?.lag_median_seconds == null ? null : numeric(message.lag_median_seconds, 0),
        unreadableShare: numeric(message?.unreadable_share, 0),
        sampleSize: assertion?.sample_size ?? 0
      })
    };
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const { sourceId, result } of results) {
      await client.query(
        `INSERT INTO source_trust(source_id,trust,methodology_version,components,window_days,computed_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [sourceId, result.trust.toFixed(3), TRUST_METHODOLOGY_VERSION,
          JSON.stringify(result.components), windowDays, computedAt]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return {
    computedAt: computedAt.toISOString(),
    windowDays,
    methodologyVersion: TRUST_METHODOLOGY_VERSION,
    sources: results.length,
    neutral: results.filter(({ result }) => result.neutral).length
  };
}

// ------------------------------------------------------------------------------------------------
// Reading
// ------------------------------------------------------------------------------------------------

export interface SourceTrustView {
  sourceId: string;
  name: string;
  tier: string;
  official: boolean;
  enabled: boolean;
  independenceGroup: string;
  /** `null` when the worker has never run for this source. */
  trust: number | null;
  label: TrustLabel | null;
  neutral: boolean;
  /** What `src/services/risk.ts` multiplies this source's contributions by. */
  modifier: number;
  methodologyVersion: string | null;
  windowDays: number | null;
  computedAt: string | null;
  components: TrustComponents | null;
}

/**
 * The whole catalogue with its current trust, for the ops console.
 *
 * A LEFT JOIN so a source with no measurement is listed as unmeasured rather than omitted: "we have
 * never scored this channel" is information an operator needs, and a list that quietly drops rows
 * teaches nobody anything. Ordered as the ops source list already orders, by tier then id.
 */
export async function listSourceTrust(): Promise<SourceTrustView[]> {
  const rows = (await pool.query<{
    id: string; name: string; tier: string; official: boolean; enabled: boolean;
    independence_group: string; trust: string | null; methodology_version: string | null;
    components: TrustComponents | null; window_days: number | null; computed_at: Date | null;
  }>(
    `SELECT s.id,s.name,s.tier,s.official,s.enabled,s.independence_group,
            t.trust,t.methodology_version,t.components,t.window_days,t.computed_at
     FROM sources s LEFT JOIN source_trust_current t ON t.source_id = s.id
     ORDER BY s.tier,s.id`
  )).rows;

  return rows.map((row) => {
    const trust = row.trust == null ? null : Number(row.trust);
    return {
      sourceId: row.id,
      name: row.name,
      tier: row.tier,
      official: row.official,
      enabled: row.enabled,
      independenceGroup: row.independence_group,
      trust,
      label: trustLabel(trust),
      neutral: trust != null && (row.components?.sampleSize ?? 0) < MIN_SAMPLE_SIZE,
      modifier: trustModifier(trust),
      methodologyVersion: row.methodology_version,
      windowDays: row.window_days,
      computedAt: row.computed_at ? row.computed_at.toISOString() : null,
      components: row.components
    };
  });
}

/** History for one source, newest first — the series the append-only table exists to make readable. */
export async function sourceTrustHistory(sourceId: string, limit = 60): Promise<Array<{
  trust: number; methodologyVersion: string; components: TrustComponents; windowDays: number; computedAt: string;
}>> {
  const rows = (await pool.query<{
    trust: string; methodology_version: string; components: TrustComponents;
    window_days: number; computed_at: Date;
  }>(
    `SELECT trust,methodology_version,components,window_days,computed_at
     FROM source_trust WHERE source_id=$1 ORDER BY computed_at DESC LIMIT $2`,
    [sourceId, Math.min(365, Math.max(1, Math.trunc(limit)))]
  )).rows;
  return rows.map((row) => ({
    trust: Number(row.trust),
    methodologyVersion: row.methodology_version,
    components: row.components,
    windowDays: row.window_days,
    computedAt: row.computed_at.toISOString()
  }));
}

// ------------------------------------------------------------------------------------------------
// The worker
// ------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/**
 * Once a day, following the shape of `startNightlyDigestScheduler` and `startRiskScheduler`.
 *
 * Daily rather than hourly because the window is thirty days with a ten-day half-life: an hourly
 * recomputation would move the third decimal place and write twenty-four times the history for it.
 * The `running` latch is the same guard the other schedulers use — a run that overshoots its slot
 * must not be started again on top of itself, and the transaction would serialise anyway.
 *
 * A failure is logged and nothing else happens: yesterday's rows stay current, which is the correct
 * degradation for a measurement that is a month wide. `unref()` keeps the timer from holding the
 * process open during shutdown.
 */
export function startSourceTrustScheduler(
  log: { info: Function; error: Function },
  intervalMs = DAY_MS
): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const outcome = await recalculateSourceTrust();
      log.info(outcome, 'source trust recomputed');
    } catch (error) {
      log.error({ error }, 'source trust recomputation failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  // Deliberately late: the first run reads the whole archive window, and startup already has the
  // migration, the collector and the first risk pass competing for the pool.
  //
  // Held in a variable and cleared alongside the interval: a process that shuts down inside its
  // first minute would otherwise open a pool connection for a full archive scan on the way out, and
  // the failure that follows is logged as "source trust recomputation failed" rather than as what it
  // is — a timer that outlived its scheduler.
  const firstRun = setTimeout(run, 60_000);
  firstRun.unref();
  return () => { clearInterval(timer); clearTimeout(firstRun); };
}
