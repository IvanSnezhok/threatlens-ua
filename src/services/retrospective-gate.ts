import { Counter } from 'prom-client';
import { z } from 'zod';
import { config } from '../config.js';
import { CLASSIFIER_VERSION } from '../domain/classifier.js';
import type { ClassifiedMessage } from '../types.js';
import { codexChat, type CodexFailureReason } from './codex-client.js';
import { codexFeatureEnabled } from './codex-settings.js';

/**
 * One narrow question to a model about a message the rules could not settle on their own.
 *
 * ================================================================================================
 * The band this is for, and nothing else
 * ================================================================================================
 *
 * `src/domain/classifier.ts` (`v5`) reads the *register* a message is written in. A summary bulletin
 * («у ніч на 08 серпня», «станом на 09:00», «збито/подавлено») or narration with nothing operational
 * anywhere in it is refused outright, deterministically, with no model involved. A message that
 * narrates last night *and* states a course, an arrow, a time-to-impact or a verb of motion in the
 * present tense publishes outright, also with no model involved.
 *
 * What is left is the grey band: narration beside a word that might mean "now" and might be part of
 * the story — «Атака триває», «у повітряному просторі», «пуски». The rules mark those `suspect` and
 * resolve them the safe way, which is to publish. This module is the one place allowed to change
 * that answer, and only in the one direction.
 *
 * ================================================================================================
 * Why the model can never make anything more visible
 * ================================================================================================
 *
 * Four independent structures, each sufficient on its own:
 *
 *  1. **The input is already a suppression candidate.** `retrospective.verdict === 'suspect'` is set
 *     by the classifier only on a classification that has passed `significanceRejection` — i.e. on a
 *     message that was about to become an event. There is no path by which a message the rules
 *     discarded reaches this function, so there is nothing here to resurrect.
 *  2. **The guard is re-checked here.** {@link retrospectiveGate} answers `publish` immediately for
 *     any input that is not in the band, so a future mis-call from somewhere else cannot archive
 *     anything.
 *  3. **The result type has one `archive` constructor.** Exactly one `return` in this file produces
 *     it, reached only when the model answers «retrospective» with confidence at or above
 *     {@link MINIMUM_CONFIDENCE}. Every other exit — feature off, over budget, no session, transport
 *     failure, timeout, prose where JSON was asked for, an answer of «current» — returns `publish`.
 *  4. **The caller acts on one value.** `src/services/ingestion.ts` branches on
 *     `verdict === 'archive'` and does nothing at all otherwise; `publish` is literally the absence
 *     of an effect, so a bug that produced it everywhere would restore `v4`'s behaviour for this
 *     band and could not invent a threat.
 *
 * The asymmetry is the point. A model having a bad night can cost this system a *suppression*, which
 * costs a reader one wrong line they were already getting last week. It cannot cost them a warning.
 *
 * ================================================================================================
 * Why it is synchronous, and why the alternative is worse
 * ================================================================================================
 *
 * The gate runs inside `classifyAndIngest`, before `ingestThreat`, with a hard timeout
 * (`RETROSPECTIVE_GATE_TIMEOUT_MS`, default 2500 ms). It is not inside the ingestion *transaction* —
 * `ingestThreat` opens its own, after this returns — so a slow model holds no database connection
 * and no row lock.
 *
 * The alternative shapes were considered and rejected:
 *
 *   * **Post-publication withdrawal** — publish, ask afterwards, retract on «retrospective». This is
 *     forbidden. `docs/ARCHITECTURE.md` §Consistency rules already treats a published fact that
 *     later vanishes as unrecoverable, and it is worse here than anywhere: a threat that appears on
 *     the map and in a subscriber's Telegram and then disappears teaches that subscriber the app
 *     guesses. A false positive that stands is a smaller injury than a retraction.
 *   * **Gating only the notification leg** — publish to the map, hold the Telegram fan-out. This
 *     splits one fact into two truths and makes the map and the bot disagree for as long as the
 *     model takes. It also does not help: the event is the durable artefact, the notification is
 *     downstream of it, and it is the event this layer exists to not create.
 *
 * So: synchronous, bounded, and every failure resolves to the deterministic verdict. The cost of
 * being wrong about the budget is that a grey-band message reaches the map 2.5 s later than it
 * otherwise would, against a validity window of thirty minutes.
 *
 * ================================================================================================
 * One client, one audit row
 * ================================================================================================
 *
 * The call goes through {@link codexChat} like every other model call here, which is where the
 * transport decision lives and where the `ai_runs` row is written — including for the pre-flight
 * failures an operator cannot otherwise see. This module writes no audit row of its own: one call,
 * one row, `surface = 'retrospective_gate'`, `prompt_version = 'retrospective-gate-v1'`.
 */

/**
 * The one question, and the shape of the one answer.
 *
 * `current` rather than `retrospective` on purpose: the model is asked to affirm the *dangerous*
 * reading, so the answer that lets a message through is the default a confused model falls into, and
 * a schema violation is indistinguishable from a refusal to suppress. Naming the field the other way
 * round would make silence mean suppression.
 */
const gateVerdictSchema = z.object({
  current: z.boolean(),
  confidence: z.number().min(0).max(1)
});

export type RetrospectiveGateVerdict = z.infer<typeof gateVerdictSchema>;

/**
 * How sure the model has to be before a suppression is allowed.
 *
 * A constant rather than a setting: it is not an operational dial, it is the price of the asymmetry.
 * Below it the answer is treated as «no opinion», and no opinion means publish. Deliberately high —
 * the model is being asked to overrule a positive classification, and a hesitant overrule of a
 * warning is worth less than nothing.
 */
const MINIMUM_CONFIDENCE = 0.7;

const SYSTEM_PROMPT = [
  'Ти читаєш повідомлення українського моніторингового каналу про повітряні загрози.',
  'Дай відповідь РІВНО на одне питання: це повідомлення повідомляє про загрозу, яка триває ПРЯМО ЗАРАЗ,',
  'чи це ретроспектива — підсумок ночі, аналітика, спогад, розповідь про те, що вже сталося?',
  'current=true — якщо в тексті є хоч щось про поточну загрозу: курс, напрямок, ціль у повітрі,',
  'підлітний час, вимога йти в укриття, оголошення тривоги зараз.',
  'current=false — якщо текст описує лише те, що вже завершилося, або міркує про війну загалом,',
  'навіть якщо в ньому названо зброю та міста.',
  'Якщо сумніваєшся — current=true.',
  'Не додумуй нічого, чого немає в тексті. Не пояснюй.',
  'Поверни лише JSON: {"current": boolean, "confidence": number}.'
].join(' ');

/** How much of a message is sent. Longer than any real monitoring post, short by design. */
const TEXT_LIMIT = 2000;

/**
 * Slack on top of the configured budget before this module stops waiting on its own.
 *
 * `codexChat` already bounds the fetch with `AbortSignal.timeout`, but that bounds the *request*,
 * not the function: a best-effort audit insert runs after it, and a database that is itself in
 * trouble is exactly when this path must not become the thing holding up ingestion. The race below
 * is the outer bound, and the slack is what stops it from firing on a call that was about to return
 * normally and reporting a transport timeout as a gate timeout.
 */
const TIMEOUT_SLACK_MS = 500;

// ------------------------------------------------------------------------------------------------
// Rate limit
// ------------------------------------------------------------------------------------------------

/**
 * A fixed budget of calls per rolling minute, held in memory, mirroring the shadow classifier's.
 *
 * Its own array and not a shared one: the two features protect the same quota but answer different
 * questions about it, and a shared limiter would let a night of shadow classification silently
 * switch the gate off. Over budget, the gate returns the deterministic verdict — which is to
 * publish, so an exhausted quota can only ever cost a suppression.
 */
const callTimes: number[] = [];

/** Test seam: the window is wall-clock, and a suite that runs several cases in one tick needs it. */
export function resetRetrospectiveGateRateLimit(): void {
  callTimes.length = 0;
}

export function withinRateLimit(
  now = Date.now(), limit = config.RETROSPECTIVE_GATE_MAX_PER_MINUTE
): boolean {
  while (callTimes.length && callTimes[0]! <= now - 60_000) callTimes.shift();
  if (callTimes.length >= limit) return false;
  callTimes.push(now);
  return true;
}

// ------------------------------------------------------------------------------------------------
// Metrics
// ------------------------------------------------------------------------------------------------

/**
 * What the gate cost and what it bought.
 *
 * `attempts` is one per message that entered the grey band, whether or not a call was made, so it is
 * the denominator for "how often do the rules fail to decide" — a number that says whether the band
 * is drawn in the right place. The outcomes carry both the verdict and the reason, because the
 * distinction that matters operationally is not «how many did the model suppress» but «how many
 * publications happened because the model could not be reached», and those are two labels on one
 * series rather than two metrics that have to be joined by hand.
 */
const gateAttempts = new Counter({
  name: 'threatlens_retrospective_gate_attempts_total',
  help: 'Messages that entered the retrospective grey band, one per suspect classification',
  registers: []
});
const gateOutcomes = new Counter({
  name: 'threatlens_retrospective_gate_outcomes_total',
  help: 'Retrospective gate outcomes, by verdict and the reason it was reached',
  labelNames: ['verdict', 'reason'],
  registers: []
});

/** This module's metrics, for whoever owns the registry. See `registerAlertChannelMetrics`. */
export function retrospectiveGateMetrics(): ReadonlyArray<[string, Counter<string>]> {
  return [
    ['threatlens_retrospective_gate_attempts_total', gateAttempts as Counter<string>],
    ['threatlens_retrospective_gate_outcomes_total', gateOutcomes]
  ];
}

/** Test seam: the counters are process-global and a suite asserting on them needs a clean slate. */
export function resetRetrospectiveGateMetrics(): void {
  gateAttempts.reset();
  gateOutcomes.reset();
}

// ------------------------------------------------------------------------------------------------
// The call
// ------------------------------------------------------------------------------------------------

export interface RetrospectiveGateInput {
  sourceId: string;
  /** The raw message. The classifier's 500-character summary is not enough to judge a long essay. */
  text: string;
  classified: ClassifiedMessage;
}

export interface RetrospectiveGateOptions {
  /** Injected in tests. Defaults to the shared {@link codexChat}. */
  chat?: typeof codexChat;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Why the gate reached the verdict it reached.
 *
 * Every value except `model_says_retrospective` belongs to a `publish`, and that is the whole
 * catalogue: there is no reason string that can accompany an `archive` other than the model having
 * said so, with confidence, in a well-formed answer.
 */
export type RetrospectiveGateReason =
  | 'not_suspect' | 'disabled' | 'empty_text' | 'rate_limited' | 'no_provider'
  | 'model_failed' | 'timeout' | 'low_confidence' | 'model_says_current'
  | 'model_says_retrospective';

export interface RetrospectiveGateOutcome {
  verdict: 'publish' | 'archive';
  reason: RetrospectiveGateReason;
  /** The model's own confidence, when there was a well-formed answer. Recorded, never re-derived. */
  confidence?: number;
}

/**
 * The pre-flight failures, which say "nothing is configured" rather than "the model misbehaved".
 *
 * Typed as {@link CodexFailureReason} rather than as strings so a rename in the client breaks this
 * file loudly instead of quietly reclassifying an unconfigured installation as a broken model.
 */
const PREFLIGHT_REASONS: ReadonlySet<CodexFailureReason> =
  new Set<CodexFailureReason>(['not_configured', 'model_not_selected', 'no_session']);

function publish(reason: RetrospectiveGateReason, confidence?: number): RetrospectiveGateOutcome {
  return count({ verdict: 'publish', reason, ...(confidence === undefined ? {} : { confidence }) });
}

/**
 * Counts an outcome and hands it straight back.
 *
 * A pass-through so that every `return` is also the place the outcome is counted; the alternative —
 * an `.inc()` before each of the nine returns — is one edit away from a branch that returns without
 * counting, and an unreachable branch in the metric that watches a model's authority is worse than
 * no metric at all.
 */
function count(outcome: RetrospectiveGateOutcome): RetrospectiveGateOutcome {
  gateOutcomes.inc({ verdict: outcome.verdict, reason: outcome.reason });
  return outcome;
}

/**
 * Asks the model whether a grey-band message is current, and answers what the pipeline should do.
 *
 * Never throws. Every failure is a `publish`, which is the deterministic verdict the rules already
 * reached — this function's contract is that calling it can only ever *remove* a publication, and
 * that includes the case where calling it does not work.
 */
export async function retrospectiveGate(
  input: RetrospectiveGateInput, options: RetrospectiveGateOptions = {}
): Promise<RetrospectiveGateOutcome> {
  // Guard 2 of the four in the header. The caller checks this too; checking it again is what makes
  // "the gate cannot archive a message outside the band" a property of this file rather than a
  // property of one call site.
  if (input.classified.retrospective?.verdict !== 'suspect') {
    return { verdict: 'publish', reason: 'not_suspect' };
  }
  gateAttempts.inc();
  if (!(await codexFeatureEnabled('retrospective_gate'))) return publish('disabled');
  const text = input.text.trim();
  if (!text) return publish('empty_text');
  const now = options.now ?? Date.now;
  if (!withinRateLimit(now())) return publish('rate_limited');

  const chat = options.chat ?? codexChat;
  const prompt = text.slice(0, TEXT_LIMIT);
  const budget = options.timeoutMs ?? config.RETROSPECTIVE_GATE_TIMEOUT_MS;

  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), budget + TIMEOUT_SLACK_MS);
    // The process must be able to exit with this pending: a gate call in flight is never a reason to
    // hold a container open, and the answer is worthless once nobody is waiting for it.
    timer.unref?.();
  });
  const call = chat({
    promptVersion: 'retrospective-gate-v1',
    surface: 'retrospective_gate',
    classifierVersion: CLASSIFIER_VERSION,
    system: SYSTEM_PROMPT,
    user: prompt,
    json: true,
    timeoutMs: budget,
    // The audit row carries the digest rather than the rendered prompt: the system prompt is a
    // constant repeated on every row, and what is worth reading back is the message together with
    // the markers that put it in the band and the classification the answer might overturn.
    auditInput: {
      text: prompt,
      sourceId: input.sourceId,
      markers: input.classified.retrospective.markers,
      wouldPublish: {
        threatType: input.classified.threatType,
        locations: input.classified.locations.map((location) => location.name)
      },
      classifierVersion: CLASSIFIER_VERSION
    }
  }).catch(() => null);

  let result: Awaited<typeof call> | 'timeout';
  try {
    result = await Promise.race([call, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (result === 'timeout') {
    // The promise the race abandoned is left to finish on its own: `codexChat` writes its own
    // `ai_runs` row either way, so a timed-out gate is still visible in the audit log rather than
    // being a call that never happened.
    void call.catch(() => undefined);
    return publish('timeout');
  }
  if (!result) return publish('model_failed');
  if (!result.ok) {
    return publish(PREFLIGHT_REASONS.has(result.reason) ? 'no_provider' : 'model_failed');
  }

  let verdict: RetrospectiveGateVerdict;
  try {
    verdict = gateVerdictSchema.parse(JSON.parse(result.content) as unknown);
  } catch {
    return publish('model_failed');
  }
  if (verdict.current) return publish('model_says_current', verdict.confidence);
  if (verdict.confidence < MINIMUM_CONFIDENCE) return publish('low_confidence', verdict.confidence);
  // The only `archive` in this file.
  return count({
    verdict: 'archive', reason: 'model_says_retrospective', confidence: verdict.confidence
  });
}
