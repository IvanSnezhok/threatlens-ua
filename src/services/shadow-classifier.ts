import { Counter } from 'prom-client';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import {
  CLASSIFIER_VERSION, classifyMessage, significanceRejection, type LocationLexeme
} from '../domain/classifier.js';
import { cachedLocationLexemes, ingestThreat } from '../repositories/events.js';
import { THREAT_TYPES, type ClassifiedMessage, type NormalizedMessage, type ThreatType } from '../types.js';
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
  reason?: 'disabled' | 'rate_limited' | 'empty_text' | 'no_provider' | 'model_failed' | 'write_failed';
  agrees?: boolean;
  fields?: DisagreementField[];
  promotedEventId?: string;
}

const THREAT_LABELS: Record<Exclude<ThreatType, 'unknown'>, string> = {
  uav: 'ударних БпЛА',
  ballistic_missile: 'балістичних ракет',
  cruise_missile: 'крилатих ракет',
  guided_air_bomb: 'керованих авіабомб',
  aviation: 'бойової авіації',
  mlrs: 'реактивних систем залпового вогню',
  artillery: 'артилерії',
  mortar: 'мінометного обстрілу',
  combined: 'комбінованої повітряної атаки'
};

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
    const check = classifyMessage(`Загроза ${label} для ${name}.`, lexemes);
    if (significanceRejection(check) !== null || check.nationalScope || check.locations.length !== 1) {
      return null;
    }
    const location = check.locations[0]!;
    resolved.set(location.id, { id: location.id, name: location.name });
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
 * This module's metrics, for whoever owns the registry.
 *
 * Handed over as data rather than as a `register(registry)` function of its own so that the call
 * site stays where the other services' registrations already are; `registerAlertChannelMetrics`
 * attaches them, the same way it attaches the monitoring-channel counters.
 */
export function shadowClassifierMetrics(): ReadonlyArray<[string, Counter<string>]> {
  return [
    ['threatlens_shadow_attempts_total', shadowAttempts as Counter<string>],
    ['threatlens_shadow_outcomes_total', shadowOutcomes]
  ];
}

/** Test seam: the counters are process-global and a suite asserting on them needs a clean slate. */
export function resetShadowMetrics(): void {
  shadowAttempts.reset();
  shadowOutcomes.reset();
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
  const [shadowEnabled, analyticalEnabled] = await Promise.all([
    codexFeatureEnabled('shadow'), codexFeatureEnabled('analytical_threats')
  ]);
  if (!shadowEnabled && !analyticalEnabled) {
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
  for (const media of input.media ?? []) {
    if (media.kind !== 'audio') continue;
    const result = await transcribe(media).catch(() => ({ ok: false as const }));
    if (result.ok && result.text) transcripts.push(result.text);
  }
  const images = (input.media ?? [])
    .map(imageDataUrl).filter((dataUrl): dataUrl is string => Boolean(dataUrl))
    .slice(0, 2).map((dataUrl) => ({ dataUrl, detail: 'high' as const }));
  if (!text && !transcripts.length && !images.length) {
    return countOutcome({ status: 'skipped', reason: 'model_failed' });
  }
  const prompt = JSON.stringify({
    previousMessages: context.map((item) => ({ at: item.publishedAt.toISOString(), text: item.text })),
    currentMessage: text.slice(0, TEXT_LIMIT),
    audioTranscripts: transcripts
  });
  const deterministic = deterministicVerdict(input.classified);

  const result = await chat({
    promptVersion: 'shadow-classifier-v1',
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
  let promotedEventId: string | null = null;
  if (analyticalEnabled && input.allowAnalyticalPromotion) {
    promotedEventId = await (options.promote ?? promoteAnalyticalThreat)(input, verdict, result.model)
      .catch(() => null);
    if (promotedEventId) {
      await pool.query(
        `UPDATE shadow_classifications SET analytical_event_id=$3
          WHERE source_message_id=$1 AND classifier_version=$2`,
        [input.sourceMessageId, CLASSIFIER_VERSION, promotedEventId]
      ).catch(() => undefined);
    }
  }
  return countOutcome({
    status: 'recorded', agrees, fields, ...(promotedEventId ? { promotedEventId } : {})
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
