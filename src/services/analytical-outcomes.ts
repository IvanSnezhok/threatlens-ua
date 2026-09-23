import { Counter, Gauge, type Registry } from 'prom-client';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { relatedLocationsCte } from '../repositories/events.js';
import { CODEX_CLASSIFIER_VERSION } from './codex-classifier.js';

/**
 * Did the model's verdicts turn out to be true?
 *
 * ## Why this module exists
 *
 * Migration 040 gave a high-confidence shadow verdict the right to publish: when
 * `codex_settings.analytical_threats_enabled` is on and the deterministic rules declined the
 * message, `promoteAnalyticalThreat` in `./shadow-classifier.ts` creates one `unverified` event and
 * writes the link into `shadow_classifications.analytical_event_id`. What no part of the system did
 * until now is look back afterwards. The event carries a thirty-minute validity window (the
 * `valid_until` written at INSERT in `src/repositories/events.ts`); when it lapses the row stops
 * being live and that is the end of it — nothing records whether an official alert followed, whether
 * an independent human source said the same thing, or whether nobody ever corroborated it.
 *
 * Which means `config.ANALYTICAL_THREAT_MIN_CONFIDENCE` (`src/config.ts`, default 0.9) is not a
 * calibrated threshold. It is a guess, and an operator deciding whether to publish model analytics
 * to a public map and to a Telegram channel has no evidence to move it with. This module produces
 * that evidence: one row in `analytical_outcomes` (migration 043) per model-authored event, written
 * once, after its window closed, and read by `/ops/analytical-outcomes` as precision per candidate
 * threshold.
 *
 * ## Two populations, never one number
 *
 * There are two ways a model verdict becomes an event, they are gated on two different floors, and
 * for a long time only one of them was measured here:
 *
 *   * **promotion** — the case above. `ANALYTICAL_THREAT_MIN_CONFIDENCE`, default 0.9, feature off
 *     by default.
 *   * **codex_primary** — `classifier_mode=codex` (ADR 0002, owner's decision of 18.08.2026): the
 *     model is the primary classifier, it reads a source message and its verdict creates the event
 *     with the SOURCE's evidence. `CODEX_PRIMARY_MIN_CONFIDENCE`, default 0.5.
 *
 * The second had no evidence behind it at all, because the candidate predicate keyed on
 * `analytical_event_id` — a column only the promotion path writes. The floor that decides whether a
 * model verdict becomes a real warning in the mode the owner actually chose was the one nobody could
 * defend. Both are scored now, through the same evidence queries and the same
 * {@link decideOutcome}; see {@link READY_CODEX_PRIMARY} for how a primary event is found.
 *
 * They are never added together. Every number this module emits — the metric, the report, the
 * reading list — carries the population, because a precision figure only means anything beside the
 * floor it was measured against, and 0.5 and 0.9 are not the same question.
 *
 * ## What "confirmed" is allowed to mean, and what it deliberately is not
 *
 *   * **confirmed_official** — an official alert **started** over the same territory inside the
 *     window. Started, not «was active»: during a mass attack an oblast can sit under one continuous
 *     alert for hours, and counting a standing alert as corroboration would confirm essentially
 *     every promotion made that night and report a precision near 100% that measures the length of
 *     the alert and nothing else. The cost of that choice is a false negative — a correct promotion
 *     made under a standing alert can never be confirmed officially — so the condition is recorded
 *     in `alert_active_at_publication` and {@link analyticalPrecision} takes those rows out of the
 *     denominator instead of scoring them either way.
 *   * **confirmed_independent** — a **different** independence group asserted the same threat class
 *     over a related location inside the window. The group and not the source id is the unit for the
 *     reason given in `migrations/012_threat_assertions_and_classification_log.sql`: a repost
 *     aggregator shares its group with the channel it copies, and being echoed is not being
 *     corroborated. Assertions authored by another model promotion are excluded too — two models
 *     agreeing is one opinion, not two.
 *   * **unconfirmed** — the window closed and neither of the above happened.
 *
 * Territory is matched through {@link relatedLocationsCte}, the same hierarchy walk subscriptions
 * and public reads use, so an oblast-wide official alert confirms a promotion that named a city
 * inside it and vice versa. Writing a bespoke `parent_id` comparison here would answer a different
 * question than the rest of the system answers about the same two places.
 *
 * ## The safety boundary
 *
 * Everything here is a statement ABOUT a finished event and never a statement that changes one. No
 * query in this file writes to `threat_events`, `threat_event_locations`, `threat_assertions`,
 * `alert_periods`, `alert_source_states`, `risk_signals` or `notification_outbox`; the only table it
 * inserts into is its own. A precision figure is a reading for a human who then edits an environment
 * variable by hand — nothing in this module moves `ANALYTICAL_THREAT_MIN_CONFIDENCE` or
 * `CODEX_PRIMARY_MIN_CONFIDENCE`, and nothing re-publishes, retracts or re-labels an event on the
 * strength of its own verdict. An automatic feedback loop from "the model was right last week" to
 * "the model may decide more" is exactly the kind of drift `CONTEXT.md` forbids, and it is absent by
 * construction rather than by policy. Widening the measurement to the primary population did not
 * widen that: see the boundary restated at {@link READY_CODEX_PRIMARY}, where the widening happens.
 *
 * The measurement stays proportional to what an installation actually switched on, without needing a
 * switch of its own. The promotion half is driven from `idx_shadow_classifications_analytical_event`,
 * partial on `analytical_event_id IS NOT NULL` and therefore empty where promotion was never turned
 * on; the primary half is a bounded time range on
 * `message_classifications_version_time_idx (classifier_version, published_at DESC)` and matches
 * nothing at all while `classifier_mode` is `rules`, because no row carries that version. A pass on
 * a default installation reads two empty index ranges and writes nothing.
 */

// ------------------------------------------------------------------------------------------------
// Constants — the methodology, in numbers
// ------------------------------------------------------------------------------------------------

/**
 * How long after an event's `valid_until` the evaluation waits before judging it.
 *
 * The official alert channel is slower than the OSINT channels this model reads — that lag is the
 * entire reason a model promotion could be worth publishing — so an alert that vindicates a
 * promotion can land after the promotion's own window has closed. Judging at `valid_until` exactly
 * would score those as failures and calibrate the threshold upwards for the wrong reason. Fifteen
 * minutes is half the validity window: long enough for the official channel to catch up, short
 * enough that an operator watching an attack sees last hour's promotions scored within the hour.
 */
export const OUTCOME_GRACE_MINUTES = 15;

/**
 * How far past publication corroboration still counts, in minutes.
 *
 * Deliberately measured from `published_at` rather than from `valid_until`, because the claim being
 * scored is the one the model made at publication: «this threat is over this place now». Forty-five
 * minutes is the thirty-minute validity window plus the same grace as above, so an alert that
 * arrives inside the grace period confirms rather than being cut off by an arbitrary edge.
 */
export const CONFIRMATION_WINDOW_MINUTES = 45;

/**
 * Rows evaluated per pass.
 *
 * Each candidate costs two hierarchy walks, so the bound is on work and not on time: a backlog after
 * a long outage drains over several passes instead of holding a pool connection for one enormous
 * one. Promotions are rare by construction — the switch is off by default, the confidence floor is
 * high, and the deterministic rules must have declined the message first — so in normal operation a
 * pass finds a handful of rows or none.
 */
export const OUTCOME_BATCH_SIZE = 200;

/**
 * The thresholds `/ops` reports promotion precision for.
 *
 * Three points around the shipped default of 0.9, which is what makes the reading actionable: the
 * question an operator has is not «what is the precision» but «would moving the floor up buy enough
 * precision to be worth the promotions it would silence», and that question needs the neighbouring
 * values beside the current one.
 */
export const PRECISION_THRESHOLDS = [0.85, 0.9, 0.95] as const;

/**
 * The same three points, placed around the OTHER floor — `CODEX_PRIMARY_MIN_CONFIDENCE`, default
 * 0.5 (`src/config.ts`).
 *
 * A second list and not a shared one, because the two floors are nowhere near each other and a
 * bracket is only a reading when it brackets. Every codex-primary verdict sits below 0.85 by
 * construction — that is what a floor of 0.5 means — so reporting this population against
 * {@link PRECISION_THRESHOLDS} would put every row in the lowest bucket and answer nothing. The
 * question here is the mirror of the one above: would raising the primary floor to 0.6 buy enough
 * precision to be worth the events it would hand back to the rules.
 */
export const PRIMARY_PRECISION_THRESHOLDS = [0.4, 0.5, 0.6] as const;

/**
 * How far back a codex-primary event may be picked up, in hours.
 *
 * The promotion branch needs no such bound: it is driven from
 * `idx_shadow_classifications_analytical_event`, a partial index holding only promoted rows, so an
 * unbounded backlog scan is still a handful of index entries. The primary branch is driven from
 * `message_classifications`, which takes a row for EVERY message the pipeline ever saw, and its
 * usable index is `message_classifications_version_time_idx (classifier_version, published_at DESC)`
 * — a time range. Without an upper age the pass would walk the whole archive of codex decisions
 * every ten minutes to find the handful whose window just closed.
 *
 * Two days rather than two hours so that a process down for a night still scores that night when it
 * comes back; and not more, because a precision figure assembled from a week-old backlog is not the
 * reading this page exists for. Events older than this are never scored and are never counted as
 * pending either — the bound is in the shared predicate, so the gauge and the batch agree about what
 * work exists, which is the one property a backlog number has to have.
 */
export const OUTCOME_PRIMARY_LOOKBACK_HOURS = 48;

/**
 * Which floor a scored row was published under, and therefore which number it may be read as.
 *
 * `promotion` — `promoteAnalyticalThreat` (`./shadow-classifier.ts`) published an unverified event
 * the deterministic rules had declined, gated on `ANALYTICAL_THREAT_MIN_CONFIDENCE`.
 * `codex_primary` — in the owner-chosen `classifier_mode=codex` the model READ a source message and
 * its verdict created the event with the source's own evidence (ADR 0002), gated on
 * `CODEX_PRIMARY_MIN_CONFIDENCE`.
 *
 * They are two different claims measured against two different floors, and every number this module
 * produces carries the label — in the metric, in the report and in the reading list — because a
 * precision figure read against the wrong floor is worse than no figure at all.
 */
export type OutcomePopulation = 'promotion' | 'codex_primary';

/** How often the scheduler evaluates. A third of the validity window; see {@link startAnalyticalOutcomeScheduler}. */
const OUTCOME_INTERVAL_MS = 10 * 60_000;

// ------------------------------------------------------------------------------------------------
// The decision
// ------------------------------------------------------------------------------------------------

export type AnalyticalOutcomeKind = 'confirmed_official' | 'confirmed_independent' | 'unconfirmed';

export interface OfficialCorroboration {
  at: Date;
  /** The alert's own location, which may be an ancestor or a descendant of the one the model named. */
  locationId: string;
  alertType: string;
}

export interface IndependentCorroboration {
  at: Date;
  locationId: string;
  /** The asserting group, never the source id — see the module note on reposts. */
  group: string;
}

export interface OutcomeEvidence {
  official: OfficialCorroboration | null;
  independent: IndependentCorroboration | null;
  /** The territory was already under an official alert when the promotion published. */
  alertActiveAtPublication: boolean;
}

export interface OutcomeDecision {
  outcome: AnalyticalOutcomeKind;
  confirmedAt: Date | null;
  confirmedLocationId: string | null;
  /** Alert type for an official confirmation, independence group for an independent one. */
  confirmedBy: string | null;
  alertActiveAtPublication: boolean;
}

/**
 * Turns gathered evidence into the one outcome the row records.
 *
 * Official wins over independent when both exist, and that ordering is not a preference about which
 * query ran first. `CONTEXT.md` §Межі безпеки puts the official signal above every analytical one,
 * so when the state itself declared an alert over the territory the model named, that is what the
 * promotion is scored against; an OSINT channel that also happened to report it does not get to
 * relabel the stronger fact. It also keeps the two buckets honest as separate series — every row
 * lands in exactly one, and `confirmed_independent` therefore means «the officials never declared
 * this, but somebody else saw it», which is a materially different claim about the model.
 *
 * Kept pure and exported so the three cases are provable without a database; the SQL that feeds it
 * is exercised by `tests/integration/analytical-outcomes.test.ts`.
 */
export function decideOutcome(evidence: OutcomeEvidence): OutcomeDecision {
  if (evidence.official) {
    return {
      outcome: 'confirmed_official',
      confirmedAt: evidence.official.at,
      confirmedLocationId: evidence.official.locationId,
      confirmedBy: evidence.official.alertType,
      alertActiveAtPublication: evidence.alertActiveAtPublication
    };
  }
  if (evidence.independent) {
    return {
      outcome: 'confirmed_independent',
      confirmedAt: evidence.independent.at,
      confirmedLocationId: evidence.independent.locationId,
      confirmedBy: evidence.independent.group,
      alertActiveAtPublication: evidence.alertActiveAtPublication
    };
  }
  return {
    outcome: 'unconfirmed',
    confirmedAt: null,
    confirmedLocationId: null,
    confirmedBy: null,
    alertActiveAtPublication: evidence.alertActiveAtPublication
  };
}

// ------------------------------------------------------------------------------------------------
// Metrics
// ------------------------------------------------------------------------------------------------

/**
 * The share of scored model verdicts that were corroborated, as a counter to divide rather than as
 * a gauge.
 *
 * Same reasoning as `threatlens_shadow_outcomes_total` in `./shadow-classifier.ts`: a ratio computed
 * inside the process cannot be aggregated across replicas or survive a restart, while a counter
 * divided at query time can. The share this module exists to expose is
 *
 *     sum by (population) (threatlens_analytical_outcomes_total{outcome=~"confirmed_.*"})
 *       / sum by (population) (threatlens_analytical_outcomes_total)
 *
 * and the two `confirmed_*` series stay separate so that an installation whose precision rests
 * entirely on OSINT echo is distinguishable from one the state's own alerts keep agreeing with.
 *
 * `population` is on the series and not left to a dashboard, and `by (population)` in the expression
 * above is not decoration: a promotion is gated on 0.9 and a codex-primary verdict on 0.5, so an
 * unlabelled sum would divide one floor's successes by both floors' attempts and call the result
 * precision. Two values, fixed at compile time ({@link OutcomePopulation}) — six series with the
 * outcome label, and no way for the cardinality to grow from data.
 */
const analyticalOutcomes = new Counter({
  name: 'threatlens_analytical_outcomes_total',
  help: 'Evaluated model verdicts by population and by what corroborated them, or that nothing did',
  labelNames: ['population', 'outcome'],
  registers: []
});

/**
 * Scored-eligible events past their window that nobody has evaluated yet, by population.
 *
 * A gauge and not a counter because it is a backlog, and the only number that distinguishes «the
 * feature is off, so there is nothing to measure» from «the scheduler died and the precision figure
 * on the ops page has been frozen for a day». Both look identical on the counters above. Labelled
 * for the same reason the counter is: the two populations are produced by two different switches,
 * and a backlog that belongs entirely to one of them is a different incident.
 */
const analyticalOutcomesPending = new Gauge({
  name: 'threatlens_analytical_outcomes_pending',
  help: 'Model-authored events past their validity window that have not been evaluated yet',
  labelNames: ['population'],
  registers: []
});

const METRICS: ReadonlyArray<[string, Counter<string> | Gauge<string>]> = [
  ['threatlens_analytical_outcomes_total', analyticalOutcomes],
  ['threatlens_analytical_outcomes_pending', analyticalOutcomesPending]
];

/**
 * Attaches this module's metrics to the registry, mirroring `registerBackfillMetrics`.
 *
 * Both are constructed DETACHED (`registers: []`) above: importing a service must never mutate a
 * shared registry, or a test that imports this file would start contributing series to whichever
 * server it builds next. The guard makes the call idempotent, so building a second server in a suite
 * does not throw on a duplicate name.
 */
export function registerAnalyticalOutcomeMetrics(registry: Registry): void {
  for (const [name, metric] of METRICS) {
    if (!registry.getSingleMetric(name)) registry.registerMetric(metric);
  }
}

/** Test seam: the metrics are process-global and a suite asserting on them needs a clean slate. */
export function resetAnalyticalOutcomeMetrics(): void {
  analyticalOutcomes.reset();
  analyticalOutcomesPending.reset();
}

// ------------------------------------------------------------------------------------------------
// Evaluation
// ------------------------------------------------------------------------------------------------

export interface OutcomeCandidate {
  event_id: string;
  /** Audit root of the verdict; null when the message it belonged to has been purged. */
  shadow_id: string | null;
  model: string;
  confidence: string;
  threat_type: string;
  published_at: Date;
  valid_until: Date;
  independence_group: string;
  location_ids: string[];
  population: OutcomePopulation;
}

/**
 * Which promotions are ready to be scored, as one predicate both the batch and the backlog gauge
 * use.
 *
 * Shared as a string rather than written twice because the two must agree by construction: a gauge
 * that counts rows the batch would never pick up reports a backlog that never drains, and an
 * operator watching it would page somebody about a scheduler that is working perfectly.
 *
 * `model_confidence IS NOT NULL` excludes a promotion whose verdict lost its confidence — the whole
 * output of this module is bucketed by that column, so a row that cannot be bucketed cannot
 * calibrate anything, and counting it as pending work would be counting work no pass will ever do.
 */
const READY_PROMOTION = `sc.analytical_event_id IS NOT NULL
  AND sc.model_confidence IS NOT NULL
  AND o.event_id IS NULL
  AND e.valid_until <= now() - ($1 || ' minutes')::interval`;

/**
 * The same question asked of the OTHER population — and the reason this module stopped being a
 * promotion-only measurement.
 *
 * ## What was unmeasured
 *
 * {@link READY_PROMOTION} requires `sc.analytical_event_id IS NOT NULL`, and that column is written
 * in exactly one place: the promotion path in `./shadow-classifier.ts`. The codex-primary comparison
 * row (`recordComparison` in `./codex-classifier.ts`) never sets it, because in that mode the model
 * did not promote anything — it READ a source message, and the event carries the source's own
 * evidence. The consequence was a hole exactly where the stakes are highest:
 * `ANALYTICAL_THREAT_MIN_CONFIDENCE` (0.9), which gates a feature that ships OFF, had a measured
 * precision readout, while `CODEX_PRIMARY_MIN_CONFIDENCE` (0.5) — the floor that decides whether the
 * model's verdict becomes a real event in the mode the owner chose (ADR 0002) — had no evidence
 * behind it at all.
 *
 * ## How a primary event is found, and why not through the same column
 *
 * Through `message_classifications`, which already records the link this module needs and records it
 * for the right reason: `event_id` is the event the decision produced, `created_event` says the
 * decision CREATED it rather than merging into one that existed, `classifier_version` is
 * `CODEX_CLASSIFIER_VERSION` exactly when the model built the classification, and `model_confidence`
 * (migration 049) is the number being calibrated. `created_event` is also what keeps the population
 * one-row-per-event without a DISTINCT: an event has exactly one creating message, and every later
 * message that merged into it describes corroboration rather than the decision under test.
 *
 * The `published_at` bound is what makes the plan bounded —
 * `message_classifications_version_time_idx (classifier_version, published_at DESC)` turns the
 * branch into a time range over model decisions instead of a scan of every classified message; see
 * {@link OUTCOME_PRIMARY_LOOKBACK_HOURS}.
 *
 * ## The boundary, restated where it is widened
 *
 * Widening what is MEASURED widens nothing else. This predicate feeds the same read-only pipeline:
 * one row in this module's own table, per event, after its window closed. No statement in this file
 * writes to `threat_events`, `threat_event_locations`, `threat_assertions`, `alert_periods`,
 * `alert_source_states`, `risk_signals` or `notification_outbox`, and nothing here moves
 * `CODEX_PRIMARY_MIN_CONFIDENCE` any more than it moves `ANALYTICAL_THREAT_MIN_CONFIDENCE`. The
 * floor is an environment variable a human edits after reading the page. An automatic path from «the
 * model was right last week» to «the model may decide more» is the drift `CONTEXT.md` forbids, and
 * it is absent by construction here too: this module's only output is a row, a metric and a number
 * on a page, and in the primary mode the model's failures still fall back to the rules rather than
 * to anything this file knows.
 */
// $1 grace minutes, $2 classifier version, $3 lookback hours — the same three positions in both
// statements below, so the gauge and the batch share the predicate text verbatim.
const READY_CODEX_PRIMARY = `mc.classifier_version = $2
  AND mc.created_event
  AND mc.model_confidence IS NOT NULL
  AND mc.published_at > now() - ($3 || ' hours')::interval
  AND o.event_id IS NULL
  AND e.valid_until <= now() - ($1 || ' minutes')::interval`;

/** Everything both branches select, so the two halves of the UNION cannot drift apart in shape. */
const CANDIDATE_LOCATIONS = `COALESCE((SELECT array_agg(el.location_id)
                        FROM threat_event_locations el WHERE el.event_id = e.id), '{}')`;

/**
 * The events this pass will score, from both populations, oldest window first.
 *
 * The promotion half is driven FROM `shadow_classifications` and not from a scan of `threat_events`,
 * for the same reason migration 041's backfill is: the promoted rows are reachable through
 * `idx_shadow_classifications_analytical_event`, which is partial on `analytical_event_id IS NOT
 * NULL`, so the plan starts from a handful of rows instead of from every event the installation has
 * ever published. `LEFT JOIN … IS NULL` against this module's own table is what makes a pass
 * idempotent: an event scored yesterday is not a candidate today.
 *
 * `independence_group` comes along because the independence test needs it and only the authoring
 * message knows it: the event asserts under its source's own group (`assertThreat` in
 * `src/repositories/events.ts`), so «another group» can only be expressed relative to this value.
 *
 * The primary half reaches its audit root through a LATERAL rather than a plain join: a message can
 * carry a shadow row per `classifier_version`, and a second row would duplicate the candidate — one
 * event scored twice, the second write silently refused by the primary key and the backlog gauge
 * disagreeing with the batch forever. Newest first, and `LEFT` because the row is nullable by
 * design: `recordComparison` is best-effort and a purged message takes its verdict with it, while
 * the measurement must survive (migration 043).
 *
 * `ORDER BY` and `LIMIT` sit outside the UNION so the bound is on the pass and not on each half; a
 * night of primary decisions cannot starve a promotion whose window closed earlier.
 */
async function pendingCandidates(limit: number): Promise<OutcomeCandidate[]> {
  const result = await pool.query<OutcomeCandidate>(
    `SELECT * FROM (
       SELECT e.id AS event_id, sc.id AS shadow_id, sc.model, sc.model_confidence AS confidence,
              e.threat_type, e.started_at AS published_at, e.valid_until, s.independence_group,
              'promotion'::text AS population, ${CANDIDATE_LOCATIONS} AS location_ids
         FROM shadow_classifications sc
         JOIN threat_events e ON e.id = sc.analytical_event_id
         JOIN source_messages sm ON sm.id = sc.source_message_id
         JOIN sources s ON s.id = sm.source_id
         LEFT JOIN analytical_outcomes o ON o.event_id = e.id
        WHERE ${READY_PROMOTION}
       UNION ALL
       SELECT e.id AS event_id, sc.id AS shadow_id, mc.model, mc.model_confidence AS confidence,
              e.threat_type, e.started_at AS published_at, e.valid_until, s.independence_group,
              'codex_primary'::text AS population, ${CANDIDATE_LOCATIONS} AS location_ids
         FROM message_classifications mc
         JOIN threat_events e ON e.id = mc.event_id
         JOIN sources s ON s.id = mc.source_id
         LEFT JOIN LATERAL (
           SELECT id FROM shadow_classifications
            WHERE source_message_id = mc.source_message_id
            ORDER BY created_at DESC LIMIT 1
         ) sc ON true
         LEFT JOIN analytical_outcomes o ON o.event_id = e.id
        WHERE ${READY_CODEX_PRIMARY}
     ) candidates
     ORDER BY valid_until ASC
     LIMIT $4`,
    [String(OUTCOME_GRACE_MINUTES), CODEX_CLASSIFIER_VERSION,
      String(OUTCOME_PRIMARY_LOOKBACK_HOURS), limit]
  );
  return result.rows;
}

/** The backlog behind {@link analyticalOutcomesPending}, per population. */
export type PendingByPopulation = Record<OutcomePopulation, number>;

/**
 * The backlog behind {@link analyticalOutcomesPending}; see {@link READY_PROMOTION} and
 * {@link READY_CODEX_PRIMARY}.
 *
 * One statement with the same two halves as {@link pendingCandidates} and the same predicates, so
 * the gauge counts exactly the work a pass would pick up. Split by population because the two are
 * switched on independently: a backlog that is entirely primary means the classifier mode is busy
 * and the scheduler is behind, while a backlog that is entirely promotion means something else.
 */
export async function pendingEvaluationCount(): Promise<PendingByPopulation> {
  const result = await pool.query<{ population: OutcomePopulation; count: number }>(
    `SELECT 'promotion'::text AS population, count(*)::int AS count
       FROM shadow_classifications sc
       JOIN threat_events e ON e.id = sc.analytical_event_id
       LEFT JOIN analytical_outcomes o ON o.event_id = e.id
      WHERE ${READY_PROMOTION}
      UNION ALL
     SELECT 'codex_primary'::text AS population, count(*)::int AS count
       FROM message_classifications mc
       JOIN threat_events e ON e.id = mc.event_id
       LEFT JOIN analytical_outcomes o ON o.event_id = e.id
      WHERE ${READY_CODEX_PRIMARY}`,
    [String(OUTCOME_GRACE_MINUTES), CODEX_CLASSIFIER_VERSION, String(OUTCOME_PRIMARY_LOOKBACK_HOURS)]
  );
  const pending: PendingByPopulation = { promotion: 0, codex_primary: 0 };
  for (const row of result.rows) pending[row.population] = row.count;
  return pending;
}

/**
 * The earliest official alert that STARTED over the promotion's territory inside the window.
 *
 * `alert_periods` is the authoritative history: `reconcileAggregateAlert`
 * (`src/services/ingestion.ts`) writes exactly one row per aggregate alert start and closes it on
 * the all-clear, so a period exists for every alert that was ever public, including the short ones
 * that were over before this evaluation ran. `alert_source_states` is unioned in as the second half
 * of the pair because it is the per-source truth and carries the provider's own
 * `provider_started_at`; it is filtered on `active` because that column describes the state NOW and
 * an inactive row's timestamp may belong to an alert that ended long ago. The union therefore adds
 * only alerts a source is still holding, and `min(started_at)` makes the overlap between the two
 * harmless.
 *
 * The alert type is not constrained to air-raid. The claim being scored is «something was over this
 * place», the catalogue of types is written by migration and by providers rather than by this
 * module, and a filter here would silently score an artillery-alert confirmation as a failure the
 * day a provider adds a type nobody updated this list for. Which type it was is stored in
 * `confirmed_by`, so the distinction survives without being enforced.
 */
async function officialCorroboration(
  locationIds: string[], from: Date, until: Date
): Promise<OfficialCorroboration | null> {
  if (!locationIds.length) return null;
  const result = await pool.query<{ started_at: Date; location_id: string; alert_type: string }>(
    `${relatedLocationsCte('ANY($1::text[])')}
     SELECT started_at, location_id, alert_type FROM (
       SELECT ap.started_at, ap.location_id, ap.alert_type
         FROM alert_periods ap JOIN related_locations r ON r.id = ap.location_id
        WHERE ap.started_at >= $2 AND ap.started_at <= $3
       UNION ALL
       SELECT ass.provider_started_at AS started_at, ass.location_id, ass.alert_type
         FROM alert_source_states ass JOIN related_locations r ON r.id = ass.location_id
        WHERE ass.active AND ass.provider_started_at >= $2 AND ass.provider_started_at <= $3
     ) starts
      ORDER BY started_at ASC
      LIMIT 1`,
    [locationIds, from, until]
  );
  const row = result.rows[0];
  return row ? { at: new Date(row.started_at), locationId: row.location_id, alertType: row.alert_type } : null;
}

/**
 * Whether the territory was already under an official alert at publication time.
 *
 * `alert_periods` only, deliberately. This is a question about a past instant, and
 * `alert_source_states` holds one row per (source, location, type) describing the state NOW — asking
 * it about half an hour ago would answer with today's flag and a start timestamp that may have been
 * overwritten since. The period rows carry `started_at`/`ended_at` and are the only record that can
 * be read as of a moment.
 */
async function alertActiveAt(locationIds: string[], instant: Date): Promise<boolean> {
  if (!locationIds.length) return false;
  const result = await pool.query<{ active: boolean }>(
    `${relatedLocationsCte('ANY($1::text[])')}
     SELECT EXISTS (
       SELECT 1 FROM alert_periods ap JOIN related_locations r ON r.id = ap.location_id
        WHERE ap.started_at <= $2 AND (ap.ended_at IS NULL OR ap.ended_at > $2)
     ) AS active`,
    [locationIds, instant]
  );
  return result.rows[0]?.active ?? false;
}

/**
 * The earliest assertion of the same threat class over the same territory from another independence
 * group.
 *
 * Read from `threat_assertions` rather than from `threat_events`, and that is what makes the common
 * case work at all. When a human channel reports the same threat over the same place inside thirty
 * minutes, `ingestThreat` does not create a second event — it merges the message INTO the model's
 * event and appends an assertion carrying the human source's group. So the corroboration usually
 * arrives as another row on the promotion's own event, and a query that looked for a *different*
 * event would score the most convincing possible confirmation as a failure. The location join then
 * also catches the other shape, where the human report landed on its own event over a related place.
 *
 * `withdrawn_at IS NULL` because an assertion its own source took back is not corroboration of
 * anything. The `event_evidence` exclusion drops assertions authored by another model promotion:
 * `ingestThreat` stamps a promoted message's evidence role as `model:<group>` and nothing else does,
 * so this is the only per-assertion way to tell a human report from a second machine opinion. Doing
 * it per event instead — «this event has a shadow verdict pointing at it» — would exclude the human
 * assertions on the promotion's own event, i.e. exactly the rows that matter.
 */
async function independentCorroboration(
  locationIds: string[], threatType: string, ownGroup: string, from: Date, until: Date
): Promise<IndependentCorroboration | null> {
  if (!locationIds.length) return null;
  const result = await pool.query<{ asserted_at: Date; location_id: string; independence_group: string }>(
    `${relatedLocationsCte('ANY($1::text[])')}
     SELECT ta.asserted_at, ta.location_id, ta.independence_group
       FROM threat_assertions ta JOIN related_locations r ON r.id = ta.location_id
      WHERE ta.threat_type = $2
        AND ta.independence_group <> $3
        AND ta.asserted_at >= $4 AND ta.asserted_at <= $5
        AND ta.withdrawn_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM event_evidence ee
           WHERE ee.event_id = ta.event_id
             AND ee.source_message_id = ta.asserted_message_id
             AND ee.evidence_role LIKE 'model:%'
        )
      ORDER BY ta.asserted_at ASC
      LIMIT 1`,
    [locationIds, threatType, ownGroup, from, until]
  );
  const row = result.rows[0];
  return row
    ? { at: new Date(row.asserted_at), locationId: row.location_id, group: row.independence_group }
    : null;
}

/** Everything the decision needs about one candidate, gathered under one window. */
export async function gatherEvidence(candidate: OutcomeCandidate): Promise<OutcomeEvidence> {
  const publishedAt = new Date(candidate.published_at);
  const until = new Date(publishedAt.getTime() + CONFIRMATION_WINDOW_MINUTES * 60_000);
  const [official, independent, alertActiveAtPublication] = await Promise.all([
    officialCorroboration(candidate.location_ids, publishedAt, until),
    independentCorroboration(
      candidate.location_ids, candidate.threat_type, candidate.independence_group, publishedAt, until
    ),
    alertActiveAt(candidate.location_ids, publishedAt)
  ]);
  return { official, independent, alertActiveAtPublication };
}

export interface EvaluationSummary {
  evaluated: number;
  confirmedOfficial: number;
  confirmedIndependent: number;
  unconfirmed: number;
  /** Scored rows per population, so a pass that touched only one of the two says so. */
  byPopulation: Record<OutcomePopulation, number>;
  pending: PendingByPopulation;
}

/**
 * Scores every model-authored event whose window has closed, up to the batch bound.
 *
 * `ON CONFLICT (event_id) DO NOTHING` and counting only what the INSERT actually wrote: two
 * processes evaluating the same backlog — a replica and a `docker compose exec`, say — must not each
 * add a point to the same series. That is also why the metric is incremented from the write result
 * rather than from the decision.
 *
 * The population never reaches the INSERT. `analytical_outcomes` has no column for it and does not
 * need one: the event itself already carries the distinction on two columns migration 049 defined
 * for exactly this purpose — `classified_by='codex'` means the model built the classification, and
 * the row is joined back by primary key wherever the split is read ({@link analyticalPrecision}).
 * Storing a third copy would be a third thing that can disagree with the other two, and it would
 * need a migration this change does not otherwise require.
 */
export async function evaluateAnalyticalOutcomes(limit = OUTCOME_BATCH_SIZE): Promise<EvaluationSummary> {
  const candidates = await pendingCandidates(limit);
  const summary: EvaluationSummary = {
    evaluated: 0,
    confirmedOfficial: 0,
    confirmedIndependent: 0,
    unconfirmed: 0,
    byPopulation: { promotion: 0, codex_primary: 0 },
    pending: { promotion: 0, codex_primary: 0 }
  };
  for (const candidate of candidates) {
    const decision = decideOutcome(await gatherEvidence(candidate));
    const written = await pool.query(
      `INSERT INTO analytical_outcomes(event_id,shadow_classification_id,model,confidence,threat_type,
         published_at,valid_until,outcome,confirmed_at,confirmed_location_id,confirmed_by,
         alert_active_at_publication)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (event_id) DO NOTHING`,
      [candidate.event_id, candidate.shadow_id, candidate.model, candidate.confidence,
        candidate.threat_type, candidate.published_at, candidate.valid_until, decision.outcome,
        decision.confirmedAt, decision.confirmedLocationId, decision.confirmedBy,
        decision.alertActiveAtPublication]
    );
    if (!written.rowCount) continue;
    analyticalOutcomes.inc({ population: candidate.population, outcome: decision.outcome });
    summary.evaluated += 1;
    summary.byPopulation[candidate.population] += 1;
    if (decision.outcome === 'confirmed_official') summary.confirmedOfficial += 1;
    else if (decision.outcome === 'confirmed_independent') summary.confirmedIndependent += 1;
    else summary.unconfirmed += 1;
  }
  summary.pending = await pendingEvaluationCount();
  for (const [population, count] of Object.entries(summary.pending)) {
    analyticalOutcomesPending.set({ population }, count);
  }
  return summary;
}

// ------------------------------------------------------------------------------------------------
// The reading an operator acts on
// ------------------------------------------------------------------------------------------------

export interface ThresholdPrecision {
  threshold: number;
  /** Scored events at or above this threshold, within this population and window. */
  scored: number;
  confirmedOfficial: number;
  confirmedIndependent: number;
  unconfirmed: number;
  /** Unconfirmed rows published under a standing official alert; see migration 043. */
  undecidable: number;
  /** Confirmed over decidable, in percent, or `null` when nothing is decidable yet. */
  precisionPercent: number | null;
  /** Median seconds between publication and corroboration, over the confirmed rows. */
  medianLeadSeconds: number | null;
}

/**
 * One population's whole reading, labelled so it cannot be read as the other one's.
 *
 * `label` and `floorSetting` are part of the payload rather than of a prose note beside it because
 * the mistake being prevented is silent: 63% precision at 0.5 (a primary floor) and 63% precision at
 * 0.9 (a promotion floor) are the same digits about two different decisions, and an operator moving
 * the wrong environment variable would be acting on a number that never described it. Every consumer
 * — `/ops/analytical-outcomes`, a screenshot in an incident channel — carries the name of the
 * setting with the figure.
 */
export interface PopulationPrecision {
  population: OutcomePopulation;
  /** Human-readable name of what was measured, in the interface language. */
  label: string;
  /** The configuration key this population's floor lives under; never written by this module. */
  floorSetting: string;
  /** The floor in force right now, which is the row an operator is standing on. */
  currentThreshold: number;
  /** Scored events of this population inside the window, at any confidence. */
  evaluated: number;
  /** Events of this population past their window that no pass has scored yet. */
  pending: number;
  thresholds: ThresholdPrecision[];
}

export interface UnconfirmedOutcome {
  eventId: string;
  shadowId: string | null;
  publishedAt: string;
  confidence: number;
  model: string;
  threatType: string;
  locationIds: string[];
  title: string;
  text: string | null;
  alertActiveAtPublication: boolean;
  /** Which floor let this one out; the same distinction the populations above carry. */
  population: OutcomePopulation;
}

export interface AnalyticalPrecisionReport {
  windowDays: number;
  /** Every scored row in the window, both populations — the denominator of «how much evidence». */
  evaluated: number;
  /** Unscored backlog, both populations. */
  pending: number;
  /**
   * The two readings, never merged into one.
   *
   * There is deliberately no top-level `thresholds` or `currentThreshold` any more. Those fields
   * were the promotion reading in a place that did not say so, and the moment a second population
   * existed they became the one thing this page must not produce: a precision figure whose floor is
   * ambiguous.
   */
  populations: PopulationPrecision[];
  recentUnconfirmed: UnconfirmedOutcome[];
}

/**
 * The population a scored row belongs to, expressed in SQL over columns the event already carries.
 *
 * `threat_events.classified_by='codex'` means the model built the classification from a source
 * message — the primary mode — and anything else is a promotion, which is the only other way a row
 * gets into `analytical_outcomes` at all. Migration 049 defines these as two axes precisely so this
 * question has an answer on the event: «`origin='model'` — промоція; `classified_by='codex'` — модель
 * прочитала повідомлення джерела».
 *
 * Derived from the EVENT and not from `shadow_classifications`, because the event is the one row
 * guaranteed to exist for as long as the outcome does (`event_id` is the primary key and cascades
 * with it), while a verdict is nullable by design — a purged source message takes it away, and a
 * population that went NULL after retention would silently move rows between two precision figures.
 */
const POPULATION_SQL = `CASE WHEN e.classified_by = 'codex' THEN 'codex_primary' ELSE 'promotion' END`;

const POPULATION_LABELS: Record<OutcomePopulation, { label: string; floorSetting: string }> = {
  promotion: {
    label: 'Промоція моделі (правила відмовили)',
    floorSetting: 'ANALYTICAL_THREAT_MIN_CONFIDENCE'
  },
  codex_primary: {
    label: 'Основний класифікатор Codex (вердикт створив подію)',
    floorSetting: 'CODEX_PRIMARY_MIN_CONFIDENCE'
  }
};

/** The thresholds each population is reported against; see {@link PRIMARY_PRECISION_THRESHOLDS}. */
const POPULATION_THRESHOLDS: Record<OutcomePopulation, readonly number[]> = {
  promotion: PRECISION_THRESHOLDS,
  codex_primary: PRIMARY_PRECISION_THRESHOLDS
};

/**
 * Precision per candidate threshold, per population — which is the whole point of this module.
 *
 * Aggregated in SQL over `unnest(populations, thresholds)`, so every (population, threshold) pair is
 * one pass of the same windowed index range (`idx_analytical_outcomes_precision`) rather than one
 * round trip each. Two parallel arrays and not a cross product, because the two populations are
 * bracketed around two different floors and share no threshold: pairing them in TypeScript keeps
 * that fact in one place instead of spreading it across a CASE inside the statement.
 *
 * The LEFT JOIN keeps a pair in the answer when nothing reaches it: «0.95 has no promotions yet» is
 * an answer an operator needs — it says the higher floor would silence the feature entirely — and a
 * missing row would read as a rendering bug instead. For the same reason the population itself is
 * always present: a report with no `codex_primary` entry would read as «not measured» where the
 * truth is «measured, nothing happened».
 *
 * `precisionPercent` divides by the DECIDABLE rows, not by all of them. An event published while the
 * oblast was already under an official alert cannot be confirmed officially by construction (see the
 * module note), so leaving those in the denominator would drag the figure down by an amount that
 * depends on how many alerts there were that week rather than on how good the model is. They are
 * reported beside it as `undecidable` so the operator can see how much of the window was
 * unmeasurable instead of having it silently discounted.
 */
export async function analyticalPrecision(
  windowDays = 30, failures = 10
): Promise<AnalyticalPrecisionReport> {
  const pairs = (Object.keys(POPULATION_THRESHOLDS) as OutcomePopulation[])
    .flatMap((population) => POPULATION_THRESHOLDS[population].map((threshold) => ({ population, threshold })));
  const [buckets, recent, evaluated, pending] = await Promise.all([
    pool.query<{
      population: OutcomePopulation; threshold: string; scored: number; confirmed_official: number;
      confirmed_independent: number; unconfirmed: number; undecidable: number;
      median_lead_seconds: string | null;
    }>(
      `WITH scored AS (
         SELECT o.confidence, o.outcome, o.alert_active_at_publication, o.confirmed_at, o.published_at,
                ${POPULATION_SQL} AS population
           FROM analytical_outcomes o
           JOIN threat_events e ON e.id = o.event_id
          WHERE o.published_at > now() - ($1 || ' days')::interval
       )
       SELECT t.population, t.threshold,
              count(s.confidence)::int AS scored,
              count(*) FILTER (WHERE s.outcome = 'confirmed_official')::int AS confirmed_official,
              count(*) FILTER (WHERE s.outcome = 'confirmed_independent')::int AS confirmed_independent,
              count(*) FILTER (WHERE s.outcome = 'unconfirmed')::int AS unconfirmed,
              count(*) FILTER (WHERE s.outcome = 'unconfirmed' AND s.alert_active_at_publication)::int
                AS undecidable,
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (s.confirmed_at - s.published_at))
              ) AS median_lead_seconds
         FROM unnest($2::text[], $3::numeric[]) AS t(population, threshold)
         LEFT JOIN scored s
           ON s.population = t.population
          AND s.confidence >= t.threshold
        GROUP BY t.population, t.threshold
        ORDER BY t.population, t.threshold ASC`,
      [String(windowDays), pairs.map((pair) => pair.population),
        pairs.map((pair) => String(pair.threshold))]
    ),
    pool.query<{
      event_id: string; shadow_classification_id: string | null; published_at: Date; confidence: string;
      model: string; threat_type: string; title: string; message_text: string | null;
      alert_active_at_publication: boolean; location_ids: string[]; population: OutcomePopulation;
    }>(
      `SELECT o.event_id, o.shadow_classification_id, o.published_at, o.confidence, o.model,
              o.threat_type, o.alert_active_at_publication, e.title, sc.message_text,
              ${POPULATION_SQL} AS population,
              COALESCE((SELECT array_agg(el.location_id)
                          FROM threat_event_locations el WHERE el.event_id = o.event_id), '{}') AS location_ids
         FROM analytical_outcomes o
         JOIN threat_events e ON e.id = o.event_id
         LEFT JOIN shadow_classifications sc ON sc.id = o.shadow_classification_id
        WHERE o.outcome = 'unconfirmed'
          AND o.published_at > now() - ($1 || ' days')::interval
        ORDER BY o.published_at DESC
        LIMIT $2`,
      [String(windowDays), failures]
    ),
    // Every scored row in the window, whatever its confidence — the denominator of «how much
    // evidence is this page built on». Asked separately rather than read off the lowest threshold
    // bucket, which would silently exclude any event decided while the floor was below the lowest
    // bracket and would start disagreeing with itself the day somebody edits either threshold list.
    pool.query<{ population: OutcomePopulation; count: number }>(
      `SELECT ${POPULATION_SQL} AS population, count(*)::int AS count
         FROM analytical_outcomes o
         JOIN threat_events e ON e.id = o.event_id
        WHERE o.published_at > now() - ($1 || ' days')::interval
        GROUP BY 1`,
      [String(windowDays)]
    ),
    pendingEvaluationCount()
  ]);

  const evaluatedBy: Record<OutcomePopulation, number> = { promotion: 0, codex_primary: 0 };
  for (const row of evaluated.rows) evaluatedBy[row.population] = row.count;

  const populations = (Object.keys(POPULATION_THRESHOLDS) as OutcomePopulation[]).map((population) => ({
    population,
    ...POPULATION_LABELS[population],
    currentThreshold: population === 'promotion'
      ? config.ANALYTICAL_THREAT_MIN_CONFIDENCE
      : config.CODEX_PRIMARY_MIN_CONFIDENCE,
    evaluated: evaluatedBy[population],
    pending: pending[population],
    thresholds: buckets.rows.filter((row) => row.population === population).map((row) => {
      const confirmed = row.confirmed_official + row.confirmed_independent;
      const decidable = row.scored - row.undecidable;
      return {
        threshold: Number(row.threshold),
        scored: row.scored,
        confirmedOfficial: row.confirmed_official,
        confirmedIndependent: row.confirmed_independent,
        unconfirmed: row.unconfirmed,
        undecidable: row.undecidable,
        precisionPercent: decidable > 0 ? Math.round((confirmed / decidable) * 1000) / 10 : null,
        medianLeadSeconds: row.median_lead_seconds == null
          ? null : Math.round(Number(row.median_lead_seconds))
      };
    })
  }));

  return {
    windowDays,
    evaluated: evaluatedBy.promotion + evaluatedBy.codex_primary,
    pending: pending.promotion + pending.codex_primary,
    populations,
    recentUnconfirmed: recent.rows.map((row) => ({
      eventId: row.event_id,
      shadowId: row.shadow_classification_id,
      publishedAt: new Date(row.published_at).toISOString(),
      confidence: Number(row.confidence),
      model: row.model,
      threatType: row.threat_type,
      locationIds: row.location_ids ?? [],
      title: row.title,
      text: row.message_text,
      alertActiveAtPublication: row.alert_active_at_publication,
      population: row.population
    }))
  };
}

// ------------------------------------------------------------------------------------------------
// Scheduler
// ------------------------------------------------------------------------------------------------

/**
 * Evaluates the backlog on a timer, in the shape every scheduler in this project has: a guard
 * against overlapping passes, an `unref()`ed interval so the process can still exit, and a stop
 * function that clears both timers.
 *
 * Ten minutes is a third of the validity window, which is the resolution the reading actually needs
 * — the precision figure is read by a human deciding where to put a threshold, not by anything that
 * reacts within a minute — and it keeps the pass rate far below the rate at which promotions can
 * possibly appear. A pass on an installation that never enabled promotion touches an empty partial
 * index and returns immediately, so the timer costs nothing when the feature is off.
 *
 * The first run is delayed for the same reason `startSourceTrustScheduler` delays its own: startup
 * already has the migrations, the collector and the first risk pass competing for the pool, and
 * nothing here is urgent. The timeout is held and cleared alongside the interval so a process that
 * shuts down inside its first minute cannot open a connection on the way out.
 */
export function startAnalyticalOutcomeScheduler(
  log: { info: Function; error: Function },
  intervalMs = OUTCOME_INTERVAL_MS
): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await evaluateAnalyticalOutcomes();
      // Silent when there was nothing to do: an installation with the feature off would otherwise
      // write one identical zero line every ten minutes forever, and the lines that matter — the
      // ones that say the model was wrong — would be the hardest to find in the log.
      if (summary.evaluated > 0) log.info(summary, 'analytical promotions evaluated');
    } catch (error) {
      log.error({ error }, 'analytical outcome evaluation failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  const firstRun = setTimeout(run, 90_000);
  firstRun.unref();
  return () => { clearInterval(timer); clearTimeout(firstRun); };
}
