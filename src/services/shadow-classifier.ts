import { Counter } from 'prom-client';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import {
  CLASSIFIER_VERSION, significanceRejection, type LocationLexeme
} from '../domain/classifier.js';
import { THREAT_LABELS, resolveModelPlace } from '../domain/model-place.js';
import { describeAge, momentIn } from '../domain/threat-timing.js';
import { cachedLocationLexemes, ingestThreat } from '../repositories/events.js';
import { THREAT_TYPES, type ClassifiedMessage, type NormalizedMessage } from '../types.js';
import {
  buildEnrichments, recordAnalyticalEnrichments, type PublishedClaim
} from './analytical-enrichment.js';
import { codexChat, type CodexFailureReason } from './codex-client.js';
import { codexFeatureEnabled } from './codex-settings.js';
import { imageDataUrl, transcribeAudio } from './media-enrichment.js';

/**
 * A model's second opinion on a message the rules have already judged.
 *
 * ## The contract with the live pipeline
 *
 * By default this module only records a second opinion. A separate, off-by-default Ops switch may
 * promote a narrowly bounded verdict to an `unverified` analytical threat: only when deterministic
 * rules rejected the current message, confidence is high, state is asserted/redirected, and every
 * destination resolves through the deterministic location catalogue. Promotion uses the ordinary
 * event log, so the result reaches both API/map and Telegram. It cannot reach official-alert tables
 * and it deliberately strips all model retractions, so a model can never issue an all-clear.
 *
 * A second, independent Ops switch (`analytical_enrichment`, migration 045) covers the opposite
 * case: a message the rules DID publish, about which the model read something more — a course, a
 * further settlement, a sharper weapon class. That path writes one row into a table of its own
 * (`./analytical-enrichment.ts`) and reaches no public surface at all: not the event, not the map,
 * not `system_event_log` and therefore not Telegram. It exists so that what the model sees beyond
 * the rules stops being lost, without any of it becoming something a reader is told.
 *
 * Every failure is silence. A model that is unreachable, slow, over quota, or answering with prose
 * where JSON was asked for produces no row and no exception. That is the correct severity: what is
 * lost is one line of labelling material, and the alternative — letting a model's bad day surface as
 * a log storm during an attack — costs attention that belongs on the map.
 *
 * ## Why the second opinion is worth having at all
 *
 * The rules are a few dozen regexes over a vocabulary that changes whenever the enemy fields a new
 * weapon or a channel changes its house style. Nobody has time to read a night's worth of messages
 * looking for the ones the regexes missed. A model reading the same messages and disagreeing is a
 * cheap way of producing that list: `/ops` shows the disagreements, a human sorts them, and the ones
 * that are real become new patterns and new tests. The model's verdict is never right by
 * construction — it is a *question*, and the answer is a regex somebody wrote deliberately.
 *
 * ## One client, one audit row
 *
 * The call goes through {@link codexChat} like every other model call in this codebase. That is
 * where the transport decision lives (Responses API against the ChatGPT backend, `chat/completions`
 * against a proxy), and it is where the `ai_runs` row is written — including for the pre-flight
 * failures, which are exactly the ones an operator cannot otherwise see. This module therefore
 * writes no audit row of its own: one call, one row, under `shadow-classifier-v1`.
 *
 * ## The rate limit is not an optimisation
 *
 * A mass attack is exactly when the message rate peaks and exactly when the account's quota must
 * still be there for the features that face users. The limiter is a fixed budget per minute
 * (`SHADOW_CLASSIFIER_MAX_PER_MINUTE`, default 6) applied before the call, and messages over budget
 * are dropped rather than queued: a queue would hand back the spend it was meant to prevent, one
 * minute late, and label a night's material with the wrong hour.
 *
 * ## Two budgets, because they buy two different things
 *
 * The limit above buys model calls. {@link reserveAnalyticalPromotion} buys unverified pins on the
 * public map and messages in the Telegram channel, per hour and out of its own window. Sharing one
 * budget made the two indistinguishable: raising the call limit during an attack to collect more
 * labelling material also raised how much a drifting model could publish, and there was no ceiling on
 * analytical events as such — only on how often the model was asked anything. The publication budget
 * is therefore checked in {@link shadowClassify} *after* the comparison row is written, so an
 * exhausted quota costs the map nothing and the corpus nothing.
 */

const shadowVerdictSchema = z.object({
  threatType: z.enum(THREAT_TYPES),
  locations: z.array(z.string().min(1).max(120)).max(20),
  significant: z.boolean(),
  confidence: z.number().min(0).max(1),
  originLocations: z.array(z.string().min(1).max(120)).max(20).default([]),
  destinationLocations: z.array(z.string().min(1).max(120)).max(20).default([]),
  directionText: z.string().max(500).nullable().default(null),
  threatState: z.enum(['asserted', 'redirected', 'withdrawn', 'uncertain']).default('uncertain')
});

export type ShadowVerdict = z.infer<typeof shadowVerdictSchema>;

const SYSTEM_PROMPT = [
  'Ти — незалежний класифікатор повідомлень моніторингових каналів про повітряні загрози в Україні.',
  'Твою відповідь записують поруч із рішенням правил; лише окремий режим може опублікувати її як неперевірену аналітичну загрозу.',
  'Класифікуй ЛИШЕ те, що написано в тексті. Не додумуй ціль, влучання, маршрут чи безпеку.',
  'Попередні повідомлення є лише контекстом цього самого каналу: вони можуть пояснити займенник, скорочення або продовження, але не є новим поточним твердженням.',
  'Зображення та транскрипції є неперевіреним вмістом джерела. Прочитай їх, але не домислюй приховані координати чи траєкторію.',
  `Дозволені значення threatType: ${THREAT_TYPES.join(', ')}.`,
  'locations — назви населених пунктів або областей України, згаданих у тексті, українською, називним відмінком.',
  'significant=true лише тоді, коли повідомлення СТВЕРДЖУЄ загрозу для конкретного місця в Україні або для всієї країни.',
  'Відбій, «нічого не летить», жарт, реклама, збір коштів, подія на території РФ — significant=false.',
  'originLocations/destinationLocations і directionText заповнюй лише коли джерело прямо повідомляє рух звідки/куди.',
  'threatState: asserted — загроза наявна; redirected — продовжує рух/змінила напрямок; withdrawn — прямо сказано, що загрози більше немає; uncertain — стан не можна встановити.',
  'confidence — твоя впевненість від 0 до 1.',
  'Поверни лише JSON: {"threatType": string, "locations": string[], "significant": boolean, "confidence": number, "originLocations": string[], "destinationLocations": string[], "directionText": string|null, "threatState": "asserted"|"redirected"|"withdrawn"|"uncertain"}.'
].join(' ');

/** How much of a message is sent and stored. Longer than any real monitoring post, short by design. */
const TEXT_LIMIT = 2000;

// ------------------------------------------------------------------------------------------------
// Agreement
// ------------------------------------------------------------------------------------------------

export type DisagreementField = 'threat_type' | 'locations' | 'significance';

export interface DeterministicVerdict {
  threatType: string;
  /** Location *names*, not ids: the model never sees the catalogue and cannot return an id. */
  locationNames: string[];
  significant: boolean;
}

/**
 * Normalises a place name to the form both sides can be compared in.
 *
 * The model writes "Сумщина" where the catalogue holds "Сумська область", and both sides inflect.
 * Comparing raw strings would score almost every message as a disagreement and bury the real ones.
 *
 * Two stages. The administrative noun goes first ("область", "району"), then either the regional
 * suffix — which is what makes "Сумська" and "Сумщина" meet at "сум" — or, when there is none, a
 * plain case ending. Deliberately coarse: this number exists to point a human at messages worth
 * reading, and a false *agreement* costs less than a disagreement list nobody gets through.
 *
 * It does not attempt the о/і and е/є alternations Ukrainian applies inside a stem ("Київ" /
 * "Києва"), because the rules for those are not expressible as a suffix strip and a wrong guess
 * would merge two real place names. Such a pair reads as a disagreement, which is the safe
 * direction — it costs a human one glance.
 */
const ADMIN_NOUNS = /(?<!\p{L})(?:м|смт|с|селище|місто|області|область|обл|району|районі|район|громаді|громада)(?!\p{L})/gu;
const REGION_SUFFIX = /(?:ська|ський|ське|ській|ською|щина|щині|щину|щини|щиною)$/u;
const CASE_ENDING = /(?:ою|ею|ами|ями|ові|еві|ої|ій|ий|ом|а|я|и|і|у|ю|е|ь|й)$/u;

export function normalizePlace(name: string): string {
  const bare = name
    .toLocaleLowerCase('uk-UA')
    .replace(/[«»"'’ʼ.,!?()]/gu, '')
    .replace(ADMIN_NOUNS, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const region = bare.replace(REGION_SUFFIX, '');
  if (region !== bare && region.length >= 3) return region;
  const stem = bare.replace(CASE_ENDING, '');
  return stem.length >= 3 ? stem : bare;
}

function samePlaces(left: string[], right: string[]): boolean {
  const normalise = (values: string[]) => new Set(values.map(normalizePlace).filter(Boolean));
  const a = normalise(left);
  const b = normalise(right);
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/**
 * Which axes the two verdicts disagree on. Empty means agreement.
 *
 * Significance is compared first in the report because it is the axis that decides whether anybody
 * is told anything at all; the other two only shape a message that is already going out.
 */
export function disagreementFields(
  deterministic: DeterministicVerdict, model: ShadowVerdict
): DisagreementField[] {
  const fields: DisagreementField[] = [];
  if (deterministic.significant !== model.significant) fields.push('significance');
  if (deterministic.threatType !== model.threatType) fields.push('threat_type');
  // Locations are only compared when both sides agree the message is about something. A withdrawal
  // and a threat naming the same city are not "the same locations" in any useful sense, and counting
  // them as an extra disagreement would double-count the significance one.
  if (deterministic.significant === model.significant
      && !samePlaces(deterministic.locationNames, model.locations)) fields.push('locations');
  return fields;
}

/** The deterministic side of the comparison, read off the classification the pipeline already made. */
export function deterministicVerdict(classified: ClassifiedMessage): DeterministicVerdict {
  return {
    threatType: classified.threatType,
    locationNames: classified.locations.map((location) => location.name),
    significant: significanceRejection(classified) === null
  };
}

// ------------------------------------------------------------------------------------------------
// Rate limit
// ------------------------------------------------------------------------------------------------

/**
 * A fixed budget of calls per rolling minute, held in memory.
 *
 * In memory and not in the database because it protects a quota that is per-process-family and
 * because a limiter that needs a round trip to decide whether to make a round trip is not a limiter.
 * One process is the deployed shape; if that ever changes, the budget is per process and the config
 * value has to be divided by hand — which is a smaller surprise than a distributed counter that adds
 * a database write to every ingested message.
 */
const callTimes: number[] = [];

/** Test seam: the window is wall-clock, and a suite that runs several cases in one tick needs it. */
export function resetShadowRateLimit(): void {
  callTimes.length = 0;
}

export function withinRateLimit(now = Date.now(), limit = config.SHADOW_CLASSIFIER_MAX_PER_MINUTE): boolean {
  while (callTimes.length && callTimes[0]! <= now - 60_000) callTimes.shift();
  if (callTimes.length >= limit) return false;
  callTimes.push(now);
  return true;
}

// ------------------------------------------------------------------------------------------------
// Publication quota
// ------------------------------------------------------------------------------------------------

/**
 * The second window, and the only ceiling that exists on analytical events as such.
 *
 * Deliberately not `callTimes` above. That budget is a spending limit on the model account and is
 * raised precisely when a night is worth labelling; this one is a limit on how much unverified
 * material a drifting model may put in front of users, and there is no night on which raising the
 * first should raise the second. One shared window made "collect more" and "publish more" the same
 * word.
 *
 * An hour rather than a minute because the failure being bounded is a drip, not a burst: a
 * miscalibrated model produces a steady trickle that a per-minute cap of 1 passes at sixty an hour.
 * In memory for the same reasons the minute window is (see above); one process is the deployed shape,
 * and the price of that assumption being wrong is a ceiling per process rather than a shared one,
 * which is the safe direction for a per-process cap on publishing.
 */
const promotionTimes: number[] = [];

/** Test seam, exactly like {@link resetShadowRateLimit} and for the same wall-clock reason. */
export function resetAnalyticalPromotionQuota(): void {
  promotionTimes.length = 0;
}

/**
 * Takes one slot out of the hour, or refuses.
 *
 * Reserve-and-release rather than the plain check-and-consume of {@link withinRateLimit}, because
 * these two limiters count different things. There, one call is one unit of spend and the answer is
 * known at the moment of asking. Here the unit is a *published event*, and most attempts publish
 * nothing: `promoteAnalyticalThreat` below refuses a verdict that is not asserted, not confident
 * enough, or names a place the deterministic catalogue cannot resolve, and `ingestThreat` refuses one
 * that deduplicates onto an event that already exists. Charging those to the budget would turn a
 * ceiling of twelve events an hour into a ceiling of twelve *questions*, and a night of near-misses
 * would spend the quota that the one real promotion needed.
 *
 * The slot is taken up front rather than after the fact because {@link scheduleShadowClassification}
 * drops the promise: several classifications are in flight at once, and a counter incremented only on
 * success lets every one of them pass a check that no longer reflects what the others are about to
 * do. Reserving first bounds the overshoot at zero; {@link releaseAnalyticalPromotion} hands the slot
 * back the moment the attempt is known to have produced nothing.
 *
 * A limit of 0 refuses before anything is recorded — the `>= limit` comparison is what makes zero an
 * off switch rather than a budget of one.
 */
export function reserveAnalyticalPromotion(
  now = Date.now(), limit = config.ANALYTICAL_PROMOTIONS_MAX_PER_HOUR
): boolean {
  while (promotionTimes.length && promotionTimes[0]! <= now - 3_600_000) promotionTimes.shift();
  if (promotionTimes.length >= limit) return false;
  promotionTimes.push(now);
  return true;
}

/**
 * Returns a reserved slot that bought nothing.
 *
 * Entries are bare timestamps and interchangeable, so removing *an* entry with this value is exactly
 * removing the one that was reserved; the window only ever asks how many there are and how old the
 * oldest is. Silently does nothing when the timestamp has already aged out of the window, which is
 * the correct behaviour for a promotion attempt that took longer than the hour it was charged to.
 */
export function releaseAnalyticalPromotion(reservedAt: number): void {
  const index = promotionTimes.lastIndexOf(reservedAt);
  if (index >= 0) promotionTimes.splice(index, 1);
}

// ------------------------------------------------------------------------------------------------
// The call
// ------------------------------------------------------------------------------------------------

export interface ShadowInput {
  sourceMessageId: string;
  sourceId?: string;
  publishedAt: Date;
  text: string;
  classified: ClassifiedMessage;
  media?: import('../types.js').MessageMediaAttachment[];
  /** Full original envelope; required to preserve source provenance if an analytical event is made. */
  message?: NormalizedMessage;
  /** True only for deterministic `unrecognized`/`no_location` refusals, never for withdrawals. */
  allowAnalyticalPromotion?: boolean;
  /**
   * What the deterministic rules published from this same message, when they published anything.
   *
   * The exact complement of {@link allowAnalyticalPromotion}, and never set together with it: that
   * flag marks the messages the rules REFUSED, this one the messages they accepted. Promotion fills
   * a gap; enrichment annotates a claim that exists. `./ingestion.ts` sets exactly one of the two per
   * message, which is why neither branch below has to defend against the other.
   *
   * Present does not mean anything is written: `codex_settings.analytical_enrichment_enabled` is off
   * by default, and the enrichment row lands in a table no public surface reads.
   */
  publishedClaim?: PublishedClaim;
  historical?: boolean;
}

export interface ShadowContextMessage { id: string; publishedAt: Date; text: string }

export interface ShadowOptions {
  /** Injected in tests. Defaults to the shared {@link codexChat}. */
  chat?: typeof codexChat;
  now?: () => number;
  loadContext?: (input: ShadowInput) => Promise<ShadowContextMessage[]>;
  transcribe?: typeof transcribeAudio;
  /** Test seam for the post-recording promotion. */
  promote?: (input: ShadowInput, verdict: ShadowVerdict, model: string) => Promise<string | null>;
  /** Test seam for the post-recording enrichment; answers how many remarks the event accepted. */
  enrich?: (input: ShadowInput, verdict: ShadowVerdict, model: string) => Promise<number>;
}

export async function loadShadowContext(input: ShadowInput): Promise<ShadowContextMessage[]> {
  if (!input.sourceId || config.SHADOW_CONTEXT_MESSAGES === 0) return [];
  const result = await pool.query<{ id: string; published_at: Date; raw_text: string }>(
    `SELECT id,published_at,raw_text FROM source_messages
      WHERE source_id=$1 AND id<>$2 AND published_at<=$3
        AND published_at >= $3 - ($4 || ' minutes')::interval
      ORDER BY published_at DESC LIMIT $5`,
    [input.sourceId, input.sourceMessageId, input.publishedAt, String(config.SHADOW_CONTEXT_MINUTES),
      config.SHADOW_CONTEXT_MESSAGES]
  );
  return result.rows.reverse().map((row) => ({
    id: row.id, publishedAt: new Date(row.published_at), text: row.raw_text.slice(0, 1000)
  }));
}

export interface ShadowOutcome {
  status: 'recorded' | 'skipped';
  /** Why nothing was recorded. Present only for `skipped`, and never surfaced to a user. */
  reason?: 'disabled' | 'rate_limited' | 'empty_text' | 'media_unusable' | 'transcription_failed'
    | 'no_provider' | 'model_failed' | 'write_failed';
  agrees?: boolean;
  fields?: DisagreementField[];
  promotedEventId?: string;
  /** Remarks filed beside an event the rules published. Absent when none was, or none accepted. */
  enrichments?: number;
}

/**
 * Turns a model verdict into the deliberately smaller event contract.
 *
 * Model-written ids are impossible: every name is fed back through the production classifier over
 * the production catalogue, and a name that does not resolve to exactly one location rejects the
 * whole promotion. Redirects assert only the destination and carry no retraction object.
 */
export function buildAnalyticalClassification(
  verdict: ShadowVerdict, lexemes: LocationLexeme[], sourceText: string
): ClassifiedMessage | null {
  if (!verdict.significant || verdict.threatType === 'unknown') return null;
  if (verdict.threatState !== 'asserted' && verdict.threatState !== 'redirected') return null;
  if (verdict.confidence < config.ANALYTICAL_THREAT_MIN_CONFIDENCE) return null;
  const names = verdict.threatState === 'redirected' && verdict.destinationLocations.length
    ? verdict.destinationLocations : verdict.locations;
  if (!names.length) return null;

  const resolved = new Map<string, { id: string; name: string }>();
  const label = THREAT_LABELS[verdict.threatType];
  for (const name of names) {
    // The resolution itself moved to `../domain/model-place.ts` when the enrichment path
    // (`./analytical-enrichment.ts`) needed the same guarantee. It is the same three refusals in the
    // same order — no threat read, national scope, or more than one candidate — and it is shared
    // rather than copied because «the model may name a place but never an id» must have exactly one
    // implementation: a second copy is a second place for a homonym to be resolved by a coin flip.
    const location = resolveModelPlace(name, verdict.threatType, lexemes);
    if (!location) return null;
    resolved.set(location.id, location);
  }
  const locations = [...resolved.values()];
  if (!locations.length) return null;
  const placeNames = locations.map((location) => location.name).join(', ');
  const excerpt = sourceText.replace(/\s+/gu, ' ').trim().slice(0, 300);
  return {
    intent: 'threat',
    threatType: verdict.threatType,
    signalThreatTypes: [verdict.threatType],
    locations: locations.map((location) => ({
      ...location,
      relationType: verdict.threatState === 'redirected' ? 'reported_direction' : 'explicit_threat'
    })),
    nationalScope: false,
    indicators: ['model_analytical_threat'],
    directionText: verdict.directionText ?? undefined,
    title: `Аналітична загроза: ${placeNames}`,
    summary: `Неперевірена оцінка моделі щодо ${label} для ${placeNames}.${excerpt ? ` Джерело: ${excerpt}` : ''}`
  };
}

async function promoteAnalyticalThreat(
  input: ShadowInput, verdict: ShadowVerdict, model: string
): Promise<string | null> {
  if (!input.allowAnalyticalPromotion || !input.message) return null;
  if (deterministicVerdict(input.classified).significant) return null;
  const classified = buildAnalyticalClassification(
    verdict, await cachedLocationLexemes(), input.message.text
  );
  if (!classified) return null;
  const message: NormalizedMessage = {
    ...input.message,
    rawPayload: {
      ...input.message.rawPayload,
      analyticalThreat: {
        model, confidence: verdict.confidence, threatState: verdict.threatState,
        shadowClassifierVersion: CLASSIFIER_VERSION
      }
    }
  };
  const event = await ingestThreat(message, classified, {
    historical: input.historical,
    modelPromotion: { model, confidence: verdict.confidence }
  });
  return event.created && event.published ? event.id : null;
}

/**
 * The other half of the same verdict: what the model saw ON TOP of what the rules published.
 *
 * Note what this function does NOT touch, because the contrast with `promoteAnalyticalThreat` above
 * is the whole design. That one calls `ingestThreat`, which is the writer of `threat_events`,
 * `threat_event_locations`, `threat_assertions`, `risk_signals` and `system_event_log` — the last of
 * which is the seam the public SSE stream and the Telegram fan-out walk. This one calls
 * {@link recordAnalyticalEnrichments}, whose entire vocabulary is one `INSERT` into
 * `analytical_enrichments`. A remark therefore cannot raise evidence, cannot extend `valid_until`,
 * cannot move `last_observed_at`, cannot add a district that `decideThreatNotification` would read as
 * `geography_changed`, and cannot append the lifecycle row without which nobody is told anything.
 *
 * See `./analytical-enrichment.ts` for the guards inside that statement, and
 * `migrations/045_model_enrichment.sql` for why the row lives in a table of its own rather than in
 * columns on the event it describes.
 */
async function enrichPublishedEvent(
  input: ShadowInput, verdict: ShadowVerdict, model: string
): Promise<number> {
  const published = input.publishedClaim;
  if (!published) return 0;
  const drafts = buildEnrichments(verdict, published, await cachedLocationLexemes());
  if (!drafts.length) return 0;
  const written = await recordAnalyticalEnrichments({
    eventId: published.eventId,
    sourceMessageId: input.sourceMessageId,
    classifierVersion: CLASSIFIER_VERSION,
    model,
    confidence: verdict.confidence
  }, drafts);
  return written.recorded;
}

/**
 * The pre-flight failures, which say "nothing is configured" rather than "the model misbehaved".
 *
 * Kept apart because they are the difference between an installation that never switched this on and
 * one whose model is broken, and because that difference is what decides whether an operator should
 * go looking at `/ops` or at their quota. `codexChat` has already recorded either kind in `ai_runs`.
 *
 * Typed as a set of {@link CodexFailureReason} rather than of strings on purpose: the client owns
 * these names, and a rename there has to break this file loudly instead of quietly reclassifying an
 * unconfigured installation as a misbehaving model.
 */
const PREFLIGHT_REASONS: ReadonlySet<CodexFailureReason> =
  new Set<CodexFailureReason>(['not_configured', 'model_not_selected', 'no_session']);

/**
 * How much labelling material this process is actually collecting, and why it is not collecting
 * more.
 *
 * The log line below counts skips one in a hundred, which answers "is something badly wrong" and
 * nothing finer. These two answer the question an operator actually has after switching the feature
 * on: **what fraction of classified messages got a second opinion, and where did the rest go**.
 *
 * `attempts` is incremented once per call and is therefore the denominator of coverage — one call
 * happens per archived deterministic decision, so
 *
 *     threatlens_shadow_outcomes_total{status="recorded"} / threatlens_classifications_total
 *
 * is the shadow coverage of the classified corpus, and `…/threatlens_shadow_attempts_total` is the
 * share of attempts that produced a row. Both are left to the query rather than exported as a
 * gauge: a ratio computed inside the process cannot be aggregated across replicas or restarts, and
 * a counter divided at query time can.
 *
 * `reason` is `none` rather than absent on the recorded path, because a label that appears on some
 * series of a metric and not others makes every `sum by (reason)` silently drop the successes.
 */
const shadowAttempts = new Counter({
  name: 'threatlens_shadow_attempts_total',
  help: 'Shadow classifications started, one per archived deterministic decision',
  registers: []
});
const shadowOutcomes = new Counter({
  name: 'threatlens_shadow_outcomes_total',
  help: 'Shadow classification outcomes, by status and the reason nothing was recorded',
  labelNames: ['status', 'reason'],
  registers: []
});

/**
 * Promotions the hourly publication quota refused.
 *
 * The only place this event is visible at all. It is not a `shadow_outcomes_total` skip — the shadow
 * row *was* written and the outcome is `recorded` — and it is not a row in `shadow_classifications`
 * either, since a refused promotion leaves `analytical_event_id` null exactly like the far more
 * common "the verdict did not qualify". Without a counter of its own, an operator comparing the
 * promotion rate before and after a config change has no way to tell a model that stopped producing
 * publishable verdicts from a ceiling that is now doing all the work, which are opposite problems
 * with opposite fixes.
 *
 * Unlabelled on purpose: there is one reason to be here. If a second ever appears, it belongs in a
 * label rather than in a second counter, so that `sum` keeps meaning "promotions the quota refused".
 */
const analyticalPromotionsBlocked = new Counter({
  name: 'threatlens_analytical_promotions_blocked_total',
  help: 'Analytical promotions refused because the hourly publication quota was already spent',
  registers: []
});

/**
 * This module's metrics, for whoever owns the registry.
 *
 * Handed over as data rather than as a `register(registry)` function of its own so that the call
 * site stays where the other services' registrations already are; `registerAlertChannelMetrics`
 * attaches them, the same way it attaches the monitoring-channel counters.
 */
export function shadowClassifierMetrics(): ReadonlyArray<[string, Counter<string>]> {
  return [
    ['threatlens_shadow_attempts_total', shadowAttempts as Counter<string>],
    ['threatlens_shadow_outcomes_total', shadowOutcomes],
    ['threatlens_analytical_promotions_blocked_total', analyticalPromotionsBlocked as Counter<string>]
  ];
}

/** Test seam: the counters are process-global and a suite asserting on them needs a clean slate. */
export function resetShadowMetrics(): void {
  shadowAttempts.reset();
  shadowOutcomes.reset();
  analyticalPromotionsBlocked.reset();
}

/**
 * Counts an outcome and hands it straight back.
 *
 * Written as a pass-through so that every `return` in {@link shadowClassify} is also the place the
 * outcome is counted. The alternative — one `.inc()` before each of the eight returns — is one edit
 * away from a branch that returns without counting, and a coverage metric with a silently
 * unreachable branch is worse than none.
 */
function countOutcome(outcome: ShadowOutcome): ShadowOutcome {
  shadowOutcomes.inc({ status: outcome.status, reason: outcome.reason ?? 'none' });
  return outcome;
}

/**
 * Runs the shadow classification for one message and records the comparison.
 *
 * Awaitable so tests can assert on it. Production code calls
 * {@link scheduleShadowClassification} instead, which is the same work with the promise
 * deliberately dropped.
 */
export async function shadowClassify(input: ShadowInput, options: ShadowOptions = {}): Promise<ShadowOutcome> {
  shadowAttempts.inc();
  // Three switches, one call. `analytical_enrichment` joins the other two here rather than gating
  // only the write below, because the verdict this module produces is the input all three consume:
  // an installation that wants only enrichment must still get the model asked, and one that wants
  // none of the three must not pay for a call whose answer nothing will read.
  const [shadowEnabled, analyticalEnabled, enrichmentEnabled] = await Promise.all([
    codexFeatureEnabled('shadow'), codexFeatureEnabled('analytical_threats'),
    codexFeatureEnabled('analytical_enrichment')
  ]);
  if (!shadowEnabled && !analyticalEnabled && !enrichmentEnabled) {
    return countOutcome({ status: 'skipped', reason: 'disabled' });
  }
  const text = input.text.trim();
  if (!text && !input.media?.length) return countOutcome({ status: 'skipped', reason: 'empty_text' });
  const now = options.now ?? Date.now;
  if (!withinRateLimit(now())) return countOutcome({ status: 'skipped', reason: 'rate_limited' });

  const chat = options.chat ?? codexChat;
  const context = await (options.loadContext ?? loadShadowContext)(input).catch(() => []);
  const transcribe = options.transcribe ?? transcribeAudio;
  const transcripts: string[] = [];
  let audioSeen = false;
  for (const media of input.media ?? []) {
    if (media.kind !== 'audio') continue;
    audioSeen = true;
    const result = await transcribe(media).catch(() => ({ ok: false as const }));
    if (result.ok && result.text) transcripts.push(result.text);
  }
  const images = (input.media ?? [])
    .map(imageDataUrl).filter((dataUrl): dataUrl is string => Boolean(dataUrl))
    .slice(0, 2).map((dataUrl) => ({ dataUrl, detail: 'high' as const }));
  /**
   * A media-only message the enrichment could not turn into anything to read.
   *
   * The `empty_text` gate above has already let this message through, because media *was* attached;
   * what fails here is the extraction. `imageDataUrl` (src/services/media-enrichment.ts:99-103)
   * answers null for anything that is not jpeg/png/webp/gif or is over `SHADOW_IMAGE_MAX_BYTES`, and
   * a voice note can come back without text for reasons that range from an unconfigured
   * transcription model to a missing `ffmpeg`. Either way there is nothing to send, so the call is
   * not made.
   *
   * This used to be counted as `model_failed` — the same label the three genuine provider failures
   * below carry. An operator watching
   * `threatlens_shadow_outcomes_total{status="skipped",reason="model_failed"}` therefore saw a rising
   * model-failure rate on a night with many stickers or oversized photos and went looking at the
   * provider, the quota and `ai_runs`, where nothing was wrong and no row existed at all: the model
   * had never been called. The separate reason is what makes those two nights distinguishable in the
   * one place an operator actually looks.
   *
   * Split in two because the two halves are fixed in different places and only one of them is worth
   * anybody's evening. `transcription_failed` means audio was attached and no attempt produced text —
   * an ops problem (credentials, `AI_TRANSCRIPTION_MODEL`, the ffmpeg conversion in
   * `convertTelegramVoice`) that a human can actually clear. `media_unusable` means nothing readable
   * was attached in the first place — a format or size the pipeline deliberately declines — and is
   * expected background noise on any channel that posts stickers or video. Audio wins when a message
   * carries both, because the actionable cause should not be hidden behind the inert one.
   */
  if (!text && !transcripts.length && !images.length) {
    return countOutcome({
      status: 'skipped', reason: audioSeen ? 'transcription_failed' : 'media_unusable'
    });
  }
  // Той самий часовий блок, що й у основного класифікатора (`./codex-classifier.ts`, рішення власника
  // 20.08.2026). Тінь порівнюють з правилами й з основною моделлю, і вердикт, ухвалений без знання
  // про те, коли канал це написав, порівнювати нема з чим: розбіжність читалася б як помилка моделі
  // там, де це була різниця у вхідних даних.
  const prompt = JSON.stringify({
    now: momentIn(new Date(), config.APP_TIMEZONE),
    publishedAt: momentIn(input.publishedAt, config.APP_TIMEZONE),
    messageAge: describeAge(input.publishedAt, new Date()),
    previousMessages: context.map((item) => ({ at: item.publishedAt.toISOString(), text: item.text })),
    currentMessage: text.slice(0, TEXT_LIMIT),
    audioTranscripts: transcripts
  });
  const deterministic = deterministicVerdict(input.classified);

  const result = await chat({
    promptVersion: 'shadow-classifier-v2',
    surface: 'shadow',
    classifierVersion: CLASSIFIER_VERSION,
    system: SYSTEM_PROMPT,
    user: prompt,
    images,
    json: true,
    // The audit row carries the digest rather than the rendered prompt: the system prompt is a
    // constant that would be repeated on every row, and what is actually worth reading back is the
    // message together with the verdict it was being compared against.
    auditInput: {
      text: text.slice(0, TEXT_LIMIT), deterministic, classifierVersion: CLASSIFIER_VERSION,
      contextMessageIds: context.map((item) => item.id), mediaKinds: (input.media ?? []).map((item) => item.kind)
    }
  }).catch(() => null);

  if (!result) return countOutcome({ status: 'skipped', reason: 'model_failed' });
  if (!result.ok) {
    return countOutcome({
      status: 'skipped', reason: PREFLIGHT_REASONS.has(result.reason) ? 'no_provider' : 'model_failed'
    });
  }

  // Prose where JSON was asked for, and a threat class that does not exist, are the same kind of
  // failure and neither may reach the table: a corpus with invented labels is worse than no corpus.
  let verdict: ShadowVerdict;
  try {
    verdict = shadowVerdictSchema.parse(JSON.parse(result.content) as unknown);
  } catch {
    return countOutcome({ status: 'skipped', reason: 'model_failed' });
  }

  const fields = disagreementFields(deterministic, verdict);
  const agrees = fields.length === 0;
  try {
    await pool.query(
      `INSERT INTO shadow_classifications(
         source_message_id, classifier_version, published_at,
         deterministic_threat_type, deterministic_locations, deterministic_significant,
         model, model_threat_type, model_locations, model_significant, model_confidence,
         agrees, disagreement_fields, message_text, model_analysis, context_message_ids, media_kinds)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (source_message_id, classifier_version) DO NOTHING`,
      [
        input.sourceMessageId, CLASSIFIER_VERSION, input.publishedAt,
        deterministic.threatType, deterministic.locationNames, deterministic.significant,
        result.model, verdict.threatType, verdict.locations, verdict.significant, verdict.confidence,
        agrees, fields, text.slice(0, TEXT_LIMIT), JSON.stringify(verdict),
        context.map((item) => item.id), (input.media ?? []).map((item) => item.kind)
      ]
    );
  } catch {
    return countOutcome({ status: 'skipped', reason: 'write_failed', agrees, fields });
  }
  /**
   * The publication half, and the two things it is gated on.
   *
   * The quota is asked here and not inside `promoteAnalyticalThreat` because the row above is already
   * written by the time this runs, and that ordering is the point: a spent publication budget must
   * cost the map an unverified pin and cost the corpus nothing. Putting the check inside the
   * promotion would put it inside a function that is only reached on the same path, which reads the
   * same until somebody moves the write — and then a full quota would quietly start eating the
   * labelling material collected during exactly the hours worth labelling.
   */
  let promotedEventId: string | null = null;
  if (analyticalEnabled && input.allowAnalyticalPromotion) {
    const reservedAt = now();
    if (!reserveAnalyticalPromotion(reservedAt)) {
      analyticalPromotionsBlocked.inc();
    } else {
      promotedEventId = await (options.promote ?? promoteAnalyticalThreat)(input, verdict, result.model)
        .catch(() => null);
      if (!promotedEventId) {
        releaseAnalyticalPromotion(reservedAt);
      } else {
        await pool.query(
          `UPDATE shadow_classifications SET analytical_event_id=$3
            WHERE source_message_id=$1 AND classifier_version=$2`,
          [input.sourceMessageId, CLASSIFIER_VERSION, promotedEventId]
        ).catch(() => undefined);
      }
    }
  }
  /**
   * The enrichment half, and why it is charged to no budget.
   *
   * `reserveAnalyticalPromotion` above meters unverified pins on a public map and messages in a
   * Telegram channel; there is nothing here for it to meter. An enrichment appends no lifecycle row,
   * so it reaches no reader — the ceiling that matters for it is the shape bound inside
   * `buildEnrichments` (at most `ENRICHMENT_MAX_LOCATIONS` + 2 rows per message, all of them
   * refused by the database unless they are genuinely additions), not an hourly publication quota.
   * Spending the publication budget here would do the opposite of what that budget is for: a night
   * of heavy enrichment would silence the promotions the quota exists to ration.
   *
   * Mutually exclusive with the promotion above by construction, not by an `else`: promotion needs
   * `allowAnalyticalPromotion` (the rules refused this message) and enrichment needs
   * `publishedClaim` (the rules published it), and `./ingestion.ts` sets exactly one of the two.
   */
  let enrichments = 0;
  if (enrichmentEnabled && input.publishedClaim) {
    enrichments = await (options.enrich ?? enrichPublishedEvent)(input, verdict, result.model)
      .catch(() => 0);
  }
  return countOutcome({
    status: 'recorded', agrees, fields, ...(promotedEventId ? { promotedEventId } : {}),
    ...(enrichments ? { enrichments } : {})
  });
}

/**
 * Fire-and-forget entry point for the ingestion path.
 *
 * The promise is dropped on purpose and the return type is void: ingestion never waits on a model.
 * When analytical publication is enabled, `shadowClassify` itself performs the bounded promotion
 * after recording the verdict; nothing upstream branches on the answer. It already swallows every
 * failure; the `catch` here is the belt to that braces, so a bug in the swallowing cannot become an
 * unhandled rejection that takes the process down during an attack.
 *
 * Skips are counted in the process log and nowhere else. A metric would be a fine thing to add the
 * day somebody watches this feature; a warning per message would not — the failure mode this guards
 * against is a model having a bad night, which is thousands of messages.
 */
export function scheduleShadowClassification(input: ShadowInput, options: ShadowOptions = {}): void {
  void shadowClassify(input, options)
    .then((outcome) => {
      if (outcome.status === 'recorded') return;
      if (outcome.reason === 'disabled' || outcome.reason === 'empty_text') return;
      countSkip(outcome.reason ?? 'unknown');
    })
    .catch(() => undefined);
}

/**
 * Skips since start-up, by reason, logged once a hundred rather than once each.
 *
 * The number an operator needs is "how much labelling material am I losing and why", and that is a
 * running total. Printing a line per dropped message would answer the same question by flooding the
 * log of a process whose other lines matter during exactly the same minutes.
 */
const skipCounts = new Map<string, number>();

function countSkip(reason: string): void {
  const total = (skipCounts.get(reason) ?? 0) + 1;
  skipCounts.set(reason, total);
  if (total % 100 !== 0) return;
  console.warn(JSON.stringify({
    level: 'warn', msg: 'shadow classification skipped', reason, total
  }));
}

/** Test seam, and the only reader of the counters outside the log line above. */
export function shadowSkipCounts(): Record<string, number> {
  return Object.fromEntries(skipCounts);
}

// ------------------------------------------------------------------------------------------------
// What /ops reads
// ------------------------------------------------------------------------------------------------

export interface ShadowAgreementReport {
  windowHours: number;
  total: number;
  agreed: number;
  disagreed: number;
  promoted: number;
  /** Null rather than zero when nothing was compared: "0% agreement" and "no data" are opposites. */
  agreementPercent: number | null;
  byField: Array<{ field: string; count: number }>;
  recentDisagreements: Array<{
    id: string;
    publishedAt: string;
    text: string;
    deterministic: { threatType: string; locations: string[]; significant: boolean };
    model: {
      threatType: string; locations: string[]; significant: boolean; confidence: number | null;
      originLocations: string[]; destinationLocations: string[]; directionText: string | null;
      threatState: 'asserted' | 'redirected' | 'withdrawn' | 'uncertain';
    };
    contextMessageIds: string[];
    mediaKinds: string[];
    fields: string[];
    analyticalEventId: string | null;
  }>;
}

export async function shadowAgreement(windowHours = 24, examples = 10): Promise<ShadowAgreementReport> {
  const totals = await pool.query<{ total: number; agreed: number; promoted: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE agrees)::int AS agreed,
            count(*) FILTER (WHERE analytical_event_id IS NOT NULL)::int AS promoted
       FROM shadow_classifications
      WHERE published_at > now() - ($1 || ' hours')::interval`,
    [String(windowHours)]
  );
  const fields = await pool.query<{ field: string; count: number }>(
    `SELECT field, count(*)::int AS count
       FROM shadow_classifications, unnest(disagreement_fields) AS field
      WHERE published_at > now() - ($1 || ' hours')::interval
      GROUP BY field ORDER BY count DESC`,
    [String(windowHours)]
  );
  const recent = await pool.query(
    `SELECT id, published_at, message_text,
            deterministic_threat_type, deterministic_locations, deterministic_significant,
            model_threat_type, model_locations, model_significant, model_confidence, disagreement_fields,
            model_analysis, context_message_ids, media_kinds, analytical_event_id
       FROM shadow_classifications
      WHERE agrees = false AND published_at > now() - ($1 || ' hours')::interval
      ORDER BY published_at DESC LIMIT $2`,
    [String(windowHours), examples]
  );

  const total = totals.rows[0]?.total ?? 0;
  const agreed = totals.rows[0]?.agreed ?? 0;
  return {
    windowHours,
    total,
    agreed,
    disagreed: total - agreed,
    promoted: totals.rows[0]?.promoted ?? 0,
    agreementPercent: total ? Math.round((agreed / total) * 1000) / 10 : null,
    byField: fields.rows,
    recentDisagreements: recent.rows.map((row) => {
      const parsed = shadowVerdictSchema.safeParse(row.model_analysis);
      const analysis = parsed.success ? parsed.data : null;
      return ({
        id: row.id,
        publishedAt: new Date(row.published_at).toISOString(),
        text: row.message_text,
        deterministic: {
          threatType: row.deterministic_threat_type,
          locations: row.deterministic_locations ?? [],
          significant: row.deterministic_significant
        },
        model: {
          threatType: row.model_threat_type,
          locations: row.model_locations ?? [],
          significant: row.model_significant,
          confidence: row.model_confidence == null ? null : Number(row.model_confidence),
          originLocations: analysis?.originLocations ?? [],
          destinationLocations: analysis?.destinationLocations ?? [],
          directionText: analysis?.directionText ?? null,
          threatState: analysis?.threatState ?? 'uncertain'
        },
        contextMessageIds: row.context_message_ids ?? [],
        mediaKinds: row.media_kinds ?? [],
        fields: row.disagreement_fields ?? [],
        analyticalEventId: row.analytical_event_id ?? null
      });
    })
  };
}
