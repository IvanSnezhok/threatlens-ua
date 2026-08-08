import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { CLASSIFIER_VERSION, significanceRejection } from '../domain/classifier.js';
import { THREAT_TYPES, type ClassifiedMessage } from '../types.js';
import { codexChat } from './codex-client.js';
import { codexFeatureEnabled } from './codex-settings.js';

/**
 * A model's second opinion on a message the rules have already judged.
 *
 * ## The contract with the live pipeline
 *
 * This module cannot change what anybody sees. It runs *after* the deterministic classification has
 * been made and archived, outside the ingestion transaction, on a promise nobody waits for. Its only
 * product is a row in `shadow_classifications`. There is no branch anywhere in this file that could
 * alter a threat event, an alert, a risk signal or a notification, and there is no return value a
 * caller could act on — {@link scheduleShadowClassification} returns void by design, so that no
 * future edit can quietly start consuming the model's answer.
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
  confidence: z.number().min(0).max(1)
});

export type ShadowVerdict = z.infer<typeof shadowVerdictSchema>;

const SYSTEM_PROMPT = [
  'Ти — незалежний класифікатор повідомлень моніторингових каналів про повітряні загрози в Україні.',
  'Твоя відповідь НЕ впливає на оповіщення: її записують поруч із рішенням детермінованих правил для звірки.',
  'Класифікуй ЛИШЕ те, що написано в тексті. Не додумуй ціль, влучання, маршрут чи безпеку.',
  `Дозволені значення threatType: ${THREAT_TYPES.join(', ')}.`,
  'locations — назви населених пунктів або областей України, згаданих у тексті, українською, називним відмінком.',
  'significant=true лише тоді, коли повідомлення СТВЕРДЖУЄ загрозу для конкретного місця в Україні або для всієї країни.',
  'Відбій, «нічого не летить», жарт, реклама, збір коштів, подія на території РФ — significant=false.',
  'confidence — твоя впевненість від 0 до 1.',
  'Поверни лише JSON: {"threatType": string, "locations": string[], "significant": boolean, "confidence": number}.'
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
  publishedAt: Date;
  text: string;
  classified: ClassifiedMessage;
}

export interface ShadowOptions {
  /** Injected in tests. Defaults to the shared {@link codexChat}. */
  chat?: typeof codexChat;
  now?: () => number;
}

export interface ShadowOutcome {
  status: 'recorded' | 'skipped';
  /** Why nothing was recorded. Present only for `skipped`, and never surfaced to a user. */
  reason?: 'disabled' | 'rate_limited' | 'empty_text' | 'no_provider' | 'model_failed' | 'write_failed';
  agrees?: boolean;
  fields?: DisagreementField[];
}

/**
 * The pre-flight failures, which say "nothing is configured" rather than "the model misbehaved".
 *
 * Kept apart because they are the difference between an installation that never switched this on and
 * one whose model is broken, and because that difference is what decides whether an operator should
 * go looking at `/ops` or at their quota. `codexChat` has already recorded either kind in `ai_runs`.
 */
const PREFLIGHT_REASONS = new Set(['not_configured', 'model_not_selected', 'no_session']);

/**
 * Runs the shadow classification for one message and records the comparison.
 *
 * Awaitable so tests can assert on it. Production code calls
 * {@link scheduleShadowClassification} instead, which is the same work with the promise
 * deliberately dropped.
 */
export async function shadowClassify(input: ShadowInput, options: ShadowOptions = {}): Promise<ShadowOutcome> {
  if (!(await codexFeatureEnabled('shadow'))) return { status: 'skipped', reason: 'disabled' };
  const text = input.text.trim();
  if (!text) return { status: 'skipped', reason: 'empty_text' };
  const now = options.now ?? Date.now;
  if (!withinRateLimit(now())) return { status: 'skipped', reason: 'rate_limited' };

  const chat = options.chat ?? codexChat;
  const prompt = text.slice(0, TEXT_LIMIT);
  const deterministic = deterministicVerdict(input.classified);

  const result = await chat({
    promptVersion: 'shadow-classifier-v1',
    system: SYSTEM_PROMPT,
    user: prompt,
    json: true,
    // The audit row carries the digest rather than the rendered prompt: the system prompt is a
    // constant that would be repeated on every row, and what is actually worth reading back is the
    // message together with the verdict it was being compared against.
    auditInput: { text: prompt, deterministic, classifierVersion: CLASSIFIER_VERSION }
  }).catch(() => null);

  if (!result) return { status: 'skipped', reason: 'model_failed' };
  if (!result.ok) {
    return { status: 'skipped', reason: PREFLIGHT_REASONS.has(result.reason) ? 'no_provider' : 'model_failed' };
  }

  // Prose where JSON was asked for, and a threat class that does not exist, are the same kind of
  // failure and neither may reach the table: a corpus with invented labels is worse than no corpus.
  let verdict: ShadowVerdict;
  try {
    verdict = shadowVerdictSchema.parse(JSON.parse(result.content) as unknown);
  } catch {
    return { status: 'skipped', reason: 'model_failed' };
  }

  const fields = disagreementFields(deterministic, verdict);
  const agrees = fields.length === 0;
  try {
    await pool.query(
      `INSERT INTO shadow_classifications(
         source_message_id, classifier_version, published_at,
         deterministic_threat_type, deterministic_locations, deterministic_significant,
         model, model_threat_type, model_locations, model_significant, model_confidence,
         agrees, disagreement_fields, message_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (source_message_id, classifier_version) DO NOTHING`,
      [
        input.sourceMessageId, CLASSIFIER_VERSION, input.publishedAt,
        deterministic.threatType, deterministic.locationNames, deterministic.significant,
        result.model, verdict.threatType, verdict.locations, verdict.significant, verdict.confidence,
        agrees, fields, prompt
      ]
    );
  } catch {
    return { status: 'skipped', reason: 'write_failed', agrees, fields };
  }
  return { status: 'recorded', agrees, fields };
}

/**
 * Fire-and-forget entry point for the ingestion path.
 *
 * The promise is dropped on purpose and the return type is void: nothing upstream may wait on a
 * model, and nothing upstream may read what it said. `shadowClassify` already swallows every
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
  /** Null rather than zero when nothing was compared: "0% agreement" and "no data" are opposites. */
  agreementPercent: number | null;
  byField: Array<{ field: string; count: number }>;
  recentDisagreements: Array<{
    id: string;
    publishedAt: string;
    text: string;
    deterministic: { threatType: string; locations: string[]; significant: boolean };
    model: { threatType: string; locations: string[]; significant: boolean; confidence: number | null };
    fields: string[];
  }>;
}

export async function shadowAgreement(windowHours = 24, examples = 10): Promise<ShadowAgreementReport> {
  const totals = await pool.query<{ total: number; agreed: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE agrees)::int AS agreed
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
            model_threat_type, model_locations, model_significant, model_confidence, disagreement_fields
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
    agreementPercent: total ? Math.round((agreed / total) * 1000) / 10 : null,
    byField: fields.rows,
    recentDisagreements: recent.rows.map((row) => ({
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
        confidence: row.model_confidence == null ? null : Number(row.model_confidence)
      },
      fields: row.disagreement_fields ?? []
    }))
  };
}
