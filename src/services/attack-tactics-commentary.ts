import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { firstForecastLexeme } from '../domain/forecast-guard.js';
import {
  CODEX_COOLDOWN_REJECTION, codexCooldownSkips, groundedNumbers, ungroundedNumber, withinCodexCooldown
} from './analytics-narrative.js';
import { plural } from './attack-analytics.js';
import type {
  TacticsCommentaryOutcome, TacticsCommentaryText, TacticsDetection, TacticsPassFacts
} from './attack-tactics.js';
import { codexCredentials } from './codex-auth.js';
import { codexChat } from './codex-client.js';
import { codexFeatureEnabled, resolveCodexSettings } from './codex-settings.js';
import { resolveRuntimeSettings } from './runtime-settings.js';

/**
 * The paragraph under the tactical block, and the four ways a model loses the right to write it.
 *
 * ================================================================================================
 * The deterministic text is the product; the model is a rewording of it
 * ================================================================================================
 *
 * `attack-tactics.ts` has already produced a finished Ukrainian sentence for every detection. This
 * module's default output is those sentences, verbatim, under a headline made of the two window
 * totals. That text is complete, correct and publishable with no model configured anywhere, and it
 * is what an installation gets until an operator switches `codex_settings.tactics_enabled` on.
 *
 * What the switch buys is one paragraph that reads like a person wrote it. What it must never buy is
 * a single new fact, and the four checks in {@link verifyTacticsCommentary} are how that is
 * enforced rather than hoped for:
 *
 *   1. **A number the detections do not contain.** The same {@link groundedNumbers} walk the
 *      narrative and the nightly digest use — one implementation of grounding in this codebase, not
 *      three.
 *   2. **A forecast.** `src/domain/forecast-guard.ts`. A model handed "the share rose from 31% to
 *      52%" will, in good faith, write the sentence that follows from it — «отже, найближчої ночі
 *      очікується…» — and every number in that sentence can be correct. The grounding check cannot
 *      see it because it is a mistake of tense.
 *   3. **A weapon class it was not given.** The detections name the classes that moved; a paragraph
 *      that mentions ballistics when no ballistic detection fired is describing a different day.
 *   4. **An oblast it was not given.** The same, and the one with the sharpest consequence: an
 *      invented place name on a public page about attacks is the failure mode this whole project is
 *      built to avoid.
 *
 * Any one of them rejects the WHOLE text — not the offending sentence. A paragraph is an argument,
 * and deleting the third sentence of an argument leaves something that reads as though it were
 * checked. The fallback is the deterministic text, which was already written.
 *
 * ================================================================================================
 * The marker is added, never asked for
 * ================================================================================================
 *
 * {@link withTacticsAiMarker} appends the disclosure AFTER validation. A model asked to disclose
 * that it wrote something can decline, and a disclosure that can be declined is not one.
 */

// ------------------------------------------------------------------------------------------------
// The reply
// ------------------------------------------------------------------------------------------------

export const TACTICS_PROMPT_VERSION = 'attack-tactics-commentary-v1';

const commentarySchema = z.object({
  headline: z.string().min(1).max(240),
  findings: z.array(z.string().min(1).max(500)).min(1).max(6),
  caveats: z.array(z.string().min(1).max(300)).max(4)
});

export type ModelTacticsCommentary = z.infer<typeof commentarySchema>;

export const TACTICS_AI_MARKER =
  'Текст написала мовна модель за переліком спостережень вище; усі числа звірено з детермінованим '
  + 'розрахунком, а згадані класи засобів і території — з переліком спостережень.';

/**
 * The sentence the deterministic text carries instead.
 *
 * The mirror image of the marker, so a reader is told which of the two they are looking at in both
 * directions rather than having to infer it from an absence.
 */
export const TACTICS_DETERMINISTIC_MARKER =
  'Текст сформовано детерміновано з наведених спостережень; модель не залучалася.';

export function withTacticsAiMarker(caveats: readonly string[]): string[] {
  return caveats.includes(TACTICS_AI_MARKER) ? [...caveats] : [...caveats, TACTICS_AI_MARKER];
}

// ------------------------------------------------------------------------------------------------
// The deterministic text
// ------------------------------------------------------------------------------------------------

/**
 * Two sentences that are true of the numbers whoever wrote the paragraph over them.
 *
 * Worded so they themselves survive `forecast-guard.ts`. That is not a formality: the honest way to
 * say "this is not a forecast" reaches for exactly the vocabulary the guard is a closed list of, and
 * a caveat that tripped it would be a caveat this module could never attach to a model's text. So
 * the claim is made in the positive — what the page describes — rather than by naming the thing it
 * refuses to do.
 */
const STANDING_CAVEATS = [
  'Це порівняння двох вікон уже класифікованих повідомлень із відкритих джерел. Тут описано те, що '
  + 'вже сталося; тверджень про майбутнє система не робить.',
  'Одиниця підрахунку — повідомлення, а не засіб ураження: одну загрозу можуть згадати кілька разів, '
  + 'а частина подій у відкриті джерела не потрапляє взагалі.'
];

/**
 * The baseline, not the error path.
 *
 * `findings` are the detection sentences verbatim. Not paraphrased and not re-templated here: they
 * are the text the model's version is checked against, and two renderings of the same detection
 * would eventually disagree.
 */
export function deterministicTacticsCommentary(facts: TacticsPassFacts): TacticsCommentaryText {
  const found = facts.detections.length;
  const headline = found === 0
    ? `За ${facts.windows.currentHours} години — ${facts.totals.currentMessages} повідомлень про `
      + `загрозу; проти попередніх ${facts.windows.baselineDays} діб помітних змін у тактиці не `
      + 'зафіксовано.'
    : `За ${facts.windows.currentHours} години — ${facts.totals.currentMessages} повідомлень про `
      + `загрозу; проти попередніх ${facts.windows.baselineDays} діб змінилося ${found} `
      + `${plural(found, 'позиція', 'позиції', 'позицій')}.`;

  const caveats = [...STANDING_CAVEATS];
  if (facts.classifierVersions.length > 1) {
    caveats.push(
      `Вікна охоплюють ${facts.classifierVersions.length} версії правил розпізнавання `
      + `(${facts.classifierVersions.join(', ')}). Частину різниці могли створити зміни в наших `
      + 'правилах, а не в діях противника.'
    );
  }
  caveats.push(TACTICS_DETERMINISTIC_MARKER);

  return {
    headline,
    findings: found === 0
      ? ['Жодне з семи порівнянь не перетнуло свого порога. Це не означає, що нічого не відбувалося — '
        + 'це означає, що добу від попередніх двох тижнів не відрізняє нічого з того, що ми вміємо '
        + 'вимірювати.']
      : facts.detections.map((row) => row.sentence),
    caveats
  };
}

// ------------------------------------------------------------------------------------------------
// The four checks
// ------------------------------------------------------------------------------------------------

/**
 * How a weapon class is recognised in free text.
 *
 * Stems rather than the labels themselves, because the labels are nominative («крилаті ракети») and
 * prose declines them («крилатих ракет»). Keyed by the class ids in `THREAT_LABELS`, so a class
 * added there without an entry here fails loudly in the unit test rather than quietly stopping being
 * checked.
 */
const CLASS_STEMS: Record<string, readonly string[]> = {
  uav: ['бпла', 'дрон', 'шахед'],
  ballistic_missile: ['балісти'],
  cruise_missile: ['крилат'],
  guided_air_bomb: ['авіабомб'],
  aviation: ['авіаці', 'літак'],
  mlrs: ['рсзв', 'реактивн'],
  artillery: ['артилер'],
  mortar: ['міномет'],
  combined: ['комбінован'],
  unknown: ['невизначен']
};

/**
 * Words as the checks below count them. Same rule as the forecast guard: letters and digits only,
 * everything else a separator.
 */
function tokenise(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Oblast mentions, found by shape rather than by a national list.
 *
 * Ukrainian names an oblast in exactly two ways — the adjective beside «область» in some case, or
 * the `-щина` noun — and both are recognisable without knowing which oblasts exist. That matters:
 * the alternative is a hard-coded list of twenty-seven names in a file whose job is to be a
 * verifier, and a verifier that has to be edited when the catalogue changes is a verifier that will
 * one day be out of date without anybody noticing.
 */
export function oblastMentions(text: string): string[] {
  const tokens = tokenise(text);
  const found: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.startsWith('област') && index > 0) found.push(tokens[index - 1]!);
    else if (token.length > 6 && /щин[аиіуоею]?$/u.test(token)) found.push(token);
  }
  return found;
}

/** Two Ukrainian word forms of the same place agree on their first four letters. */
function sameStem(a: string, b: string): boolean {
  return a.startsWith(b.slice(0, 4)) || b.startsWith(a.slice(0, 4));
}

/**
 * Everything the commentary is allowed to name, taken from the detections and from nothing else.
 *
 * A pass whose only detection is an hour shift allows no class and no oblast at all, which is
 * correct and deliberately strict: the model was given a statement about time, and a sentence it
 * adds about Poltava is a sentence about data it never saw.
 */
export function allowedSubjects(detections: readonly TacticsDetection[]): {
  threatTypes: Set<string>;
  oblasts: string[];
} {
  const threatTypes = new Set<string>();
  const oblasts: string[] = [];
  for (const row of detections) {
    if (row.detectionType === 'weapon_mix_shift' || row.detectionType === 'new_weapon_class') {
      threatTypes.add(row.subjectKey);
    }
    if (row.detectionType === 'territory_expansion' || row.detectionType === 'territory_concentration') {
      oblasts.push(row.subjectLabel);
    }
    if (row.detectionType === 'redirect_corridor') {
      const evidence = row.evidence as { fromOblastName?: unknown; toOblastName?: unknown };
      if (typeof evidence.fromOblastName === 'string') oblasts.push(evidence.fromOblastName);
      if (typeof evidence.toOblastName === 'string') oblasts.push(evidence.toOblastName);
    }
  }
  return { threatTypes, oblasts: oblasts.map((name) => name.toLowerCase()) };
}

/**
 * The verdict on a model's text: a rejection reason, or null when every check passed.
 *
 * The reason is returned rather than a boolean because it is written down — into
 * `attack_tactic_passes.commentary_rejection_reason` and into the ops console — and
 * «forecast_lexeme: наступн ціл» is something an operator can act on while «rejected» is not.
 */
export function verifyTacticsCommentary(
  candidate: ModelTacticsCommentary, facts: TacticsPassFacts
): string | null {
  const texts = [candidate.headline, ...candidate.findings, ...candidate.caveats];

  const allowed = groundedNumbers(facts);
  for (const text of texts) {
    const invented = ungroundedNumber(text, allowed);
    if (invented) return `ungrounded_number:${invented}`;
  }

  const forecast = firstForecastLexeme(texts);
  if (forecast) return `forecast_lexeme:${forecast}`;

  const subjects = allowedSubjects(facts.detections);
  const joined = texts.join(' ');
  const tokens = tokenise(joined);
  for (const [threatType, stems] of Object.entries(CLASS_STEMS)) {
    if (subjects.threatTypes.has(threatType)) continue;
    for (const stem of stems) {
      if (tokens.some((token) => token.startsWith(stem))) return `threat_class_outside_set:${threatType}`;
    }
  }
  for (const mention of oblastMentions(joined)) {
    if (!subjects.oblasts.some((name) => sameStem(name, mention))) {
      return `oblast_outside_set:${mention}`;
    }
  }
  return null;
}

// ------------------------------------------------------------------------------------------------
// The call
// ------------------------------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'Ти переказуєш українською вже пораховані спостереження про те, чим остання доба відрізняється',
  'від попередніх двох тижнів, для публічної сторінки «Аналіз атак».',
  'Тобі надано ЛИШЕ перелік спостережень із числами. Сирих даних у тебе немає.',
  'Заборонено: вигадувати або перераховувати числа — використовуй лише ті, що є у вхідному JSON.',
  'Заборонено: називати клас засобів або область, яких немає у вхідних спостереженнях.',
  'Заборонено: писати про майбутнє — жодних прогнозів, наступних цілей, ймовірностей удару',
  'чи найближчих годин. Пиши тільки в минулому й теперішньому часі.',
  'Тон спокійний, без драматизації; це читають цивільні, часто вночі.',
  'Поверни лише JSON: {"headline": string, "findings": string[1..6], "caveats": string[0..4]}.'
].join(' ');

/** Module clock: this surface's own minimum gap between two calls. */
let lastTacticsCodexAt = 0;

/** Test seam. The clock would otherwise carry one test's call into the next. */
export function resetTacticsCommentaryClock(): void {
  lastTacticsCodexAt = 0;
}

export interface TacticsCommentaryOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  cooldownMs?: number;
  now?: number;
  /** Injected in tests so the gate can be exercised without a database. */
  featureEnabled?: () => Promise<boolean>;
  credentials?: typeof codexCredentials;
  settings?: typeof resolveCodexSettings;
  /** Injected in tests; production goes through `codexChat`. */
  chat?: typeof codexChat;
}

function fallback(base: TacticsCommentaryText, model: string | null, reason: string | null): TacticsCommentaryOutcome {
  return {
    ...base,
    generatedBy: 'deterministic',
    aiGenerated: false,
    model,
    rejectionReason: reason === null ? null : reason.slice(0, 200),
    aiRunId: null
  };
}

/**
 * The transport row this call produced.
 *
 * `codexChat` writes the `ai_runs` row and returns content, not an id. The newest row on this
 * surface is the call that just finished — the deployed shape is one process and this pass holds
 * the only path that writes `surface='tactics'` — so the lookup is a link for an operator to follow,
 * not a correctness dependency. A miss costs a null column and nothing else.
 */
async function newestTacticsRun(): Promise<string | null> {
  const row = (await pool.query<{ id: string }>(
    `SELECT id FROM ai_runs WHERE surface='tactics' ORDER BY created_at DESC LIMIT 1`
  ).catch(() => ({ rows: [] as Array<{ id: string }> }))).rows[0];
  return row?.id ?? null;
}

/**
 * Writes the commentary for a pass.
 *
 * Never throws and never returns without text. Ordered so the cheapest refusal happens first: the
 * operator's switch is one indexed read of a singleton row, and a deployment that has never turned
 * the feature on pays exactly that and nothing else — no credential refresh, no settings resolution,
 * no cooldown bookkeeping.
 */
export async function writeTacticsCommentary(
  facts: TacticsPassFacts, options: TacticsCommentaryOptions = {}
): Promise<TacticsCommentaryOutcome> {
  const base = deterministicTacticsCommentary(facts);

  const enabled = await (options.featureEnabled ?? (() => codexFeatureEnabled('tactics')))();
  // Not a rejection and not an incident: it is the deployment's baseline, and the deterministic text
  // already says «модель не залучалася» in as many words.
  if (!enabled) return fallback(base, null, null);

  const settings = await (options.settings ?? resolveCodexSettings)().catch(() => null);
  const model = settings?.effectiveModel ?? (config.CODEX_MODEL || null);
  if (!config.CODEX_BASE_URL || !model) return fallback(base, model, null);
  const session = await (options.credentials ?? codexCredentials)().catch(() => null);
  if (!session?.accessToken && !config.CODEX_API_KEY) return fallback(base, model, null);

  const at = options.now ?? Date.now();
  const cooldownMs = options.cooldownMs
    ?? (await resolveRuntimeSettings().catch(() => null))?.codexCooldownMs
    ?? 0;
  if (withinCodexCooldown(at, lastTacticsCodexAt, cooldownMs)) {
    codexCooldownSkips.inc({ surface: 'tactics' });
    return fallback(base, model, CODEX_COOLDOWN_REJECTION);
  }
  // Reserved BEFORE the await, like the narrative's: the setting is a minimum gap between call
  // STARTS, and stamping on completion would enforce it against sequence but not concurrency.
  lastTacticsCodexAt = at;

  const result = await (options.chat ?? codexChat)({
    promptVersion: TACTICS_PROMPT_VERSION,
    surface: 'tactics',
    system: SYSTEM_PROMPT,
    user: JSON.stringify(facts),
    json: true,
    model,
    timeoutMs: options.timeoutMs,
    auditInput: facts
  }, { fetchImpl: options.fetchImpl, credentials: options.credentials, settings: options.settings });
  if (!result.ok) return fallback(base, model, `${result.reason}: ${result.detail}`);

  let parsed: ModelTacticsCommentary;
  try {
    parsed = commentarySchema.parse(JSON.parse(result.content));
  } catch (error) {
    return fallback(base, model, String(error));
  }

  const rejection = verifyTacticsCommentary(parsed, facts);
  if (rejection) return fallback(base, model, rejection);

  return {
    headline: parsed.headline,
    findings: parsed.findings,
    // The disclosure is appended here, after every check has passed, and never requested from the
    // model. The standing caveats ride along because they are true of the numbers underneath
    // whoever wrote the paragraph over them.
    caveats: withTacticsAiMarker([...parsed.caveats, ...STANDING_CAVEATS]),
    generatedBy: 'model',
    aiGenerated: true,
    model,
    rejectionReason: null,
    aiRunId: await newestTacticsRun()
  };
}
