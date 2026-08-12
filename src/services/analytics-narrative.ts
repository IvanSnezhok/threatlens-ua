import { Counter } from 'prom-client';
import { z } from 'zod';
import { config } from '../config.js';
import { CLASSIFIER_VERSION } from '../domain/classifier.js';
import { pool } from '../db/pool.js';
import { codexCredentials, type CodexCredentials } from './codex-auth.js';
import { codexChat } from './codex-client.js';
import { resolveCodexSettings, type ResolvedCodexSettings } from './codex-settings.js';
import {
  DEFAULT_WINDOW_DAYS, resolveWindow, strategicOverview, type AnalyticsWindow, type StrategicOverview
} from './analytics-archive.js';

/**
 * Prose about the analytics — the only part of this feature a model touches.
 *
 * The division of labour is the point. `src/services/analytics-archive.ts` computes every number in
 * deterministic SQL and is complete on its own; this module takes those finished numbers and asks a
 * model to say what they mean. Switch the model off and the analytics lose a paragraph, not a
 * figure. That is why `ANALYTICS_NARRATIVE_ENABLED` defaults to false and why {@link narrateOverview}
 * always returns a narrative — the deterministic one is not an error path, it is the baseline the
 * model has to beat.
 *
 * ## The model is not allowed to invent numbers
 *
 * It never sees the archive, only {@link NarrativeFacts}: a small, already-rounded digest. Its output
 * is then checked digit by digit — every numeric token in the returned text must appear in the facts
 * it was given, in one of the renderings {@link groundedNumbers} accepts. One ungrounded number
 * rejects the whole narrative and the deterministic text is used instead, with the reason recorded.
 * A model that hallucinates "23 events in Sumy oblast" fails closed rather than putting a number the
 * database never produced in front of an operator.
 *
 * The call itself follows `src/services/risk.ts`: structured output, `zod` validation, an `ai_runs`
 * row for every attempt, a timeout, and a deterministic fallback on any failure.
 */

const narrativeSchema = z.object({
  headline: z.string().min(1).max(240),
  findings: z.array(z.string().min(1).max(600)).min(1).max(8),
  caveats: z.array(z.string().min(1).max(400)).max(6)
});

export type ModelNarrative = z.infer<typeof narrativeSchema>;

export interface AnalyticsNarrative extends ModelNarrative {
  generatedBy: 'model' | 'deterministic';
  /**
   * Whether a model wrote this text. Redundant with `generatedBy` on purpose: consumers that only
   * need the yes/no — a template deciding whether to print the "написано моделлю" badge — should not
   * have to know the vocabulary of the enum, and a boolean is the one thing that cannot be forgotten
   * to be checked.
   */
  aiGenerated: boolean;
  model: string | null;
  /** Why the model's text was not used. `null` when it was, or when no model was configured. */
  rejectionReason: string | null;
  /** The numbers the text is about. Always present, always from SQL. */
  facts: NarrativeFacts;
}

// ------------------------------------------------------------------------------------------------
// Facts: the deterministic digest a narrative is allowed to talk about
// ------------------------------------------------------------------------------------------------

export interface NarrativeFacts {
  window: { from: string; to: string; bucket: string; days: number };
  classifierVersions: string[];
  versionComparable: boolean;
  unattributedRows: number;
  totals: { messages: number; eventsRaised: number };
  threatTypes: Array<{ threatType: string; eventsRaised: number; sharePercent: number }>;
  risingOblasts: Array<{ oblastId: string; oblastName: string; current: number; previous: number; delta: number }>;
  fallingOblasts: Array<{ oblastId: string; oblastName: string; current: number; previous: number; delta: number }>;
  interception: { asserted: number; withdrawn: number; withdrawnPercent: number; medianHeldMinutes: number | null };
  lossOblasts: Array<{ oblastId: string; oblastName: string; withdrawals: number; medianHeldMinutes: number | null }>;
  fastestSources: Array<{ sourceId: string; firstReports: number; messages: number }>;
  laggingSources: Array<{ sourceId: string; followUps: number; medianLagSeconds: number | null }>;
  unreadableSources: Array<{ sourceId: string; messages: number; unreadablePercent: number }>;
  indicators: Array<{ indicator: string; messages: number }>;
  /**
   * How much of this window a model authored rather than the rules. `0` on any installation that
   * has never switched `analytical_threats_enabled` on (migration 040 ships it false), which is
   * what keeps this field invisible by default.
   */
  modelSignals: { messages: number };
}

/**
 * The indicator a promoted model verdict carries, and the reason this file counts it instead of
 * joining `threat_events.origin`.
 *
 * `buildAnalyticalClassification` in `./shadow-classifier.ts` writes exactly this one indicator on
 * every promotion, and `strikeComposition` in `./analytics-archive.ts` already aggregates
 * `message_classifications.indicators` inside the same window, under the same version filter, as
 * every other number here. So the count comes out of the overview this module was handed rather
 * than out of a query of its own — which matters more than tidiness: {@link narrateOverview} is a
 * pure function of a {@link StrategicOverview}, `narrativeFor` memoises on the facts it produces,
 * and a database read hidden inside it would make the memo key depend on something the memo cannot
 * see.
 *
 * The count is of MESSAGES the model raised, not of events, and the field name says so. Migration
 * 041's `threat_events.origin` answers a different question — who authored the event — and
 * deliberately keeps `model` when a human report later merges into a model-created event, so
 * counting events by origin would describe corroborated ground as model guesswork.
 *
 * Bounded by `window.limit` (100 by default) like every other indicator row, and the classifier's
 * indicator vocabulary is a closed list an order of magnitude smaller than that, so the truncation
 * is theoretical. If it ever bit, the count would be understated and the disclosure would go
 * missing — never the other way round, which is the failure direction a disclosure may have.
 */
export const MODEL_ANALYTICAL_INDICATOR = 'model_analytical_threat';

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function minutes(seconds: number | null | undefined): number | null {
  return seconds == null ? null : round(seconds / 60, 1);
}

/**
 * Collapses a {@link StrategicOverview} into the handful of numbers a paragraph can carry.
 *
 * Everything is rounded here rather than in the prompt so the grounding check has a finite set of
 * acceptable renderings to compare against — a model repeating "31.4%" is grounded, a model
 * producing "31.42%" from an unrounded share would not have been.
 *
 * Per-version series are summed only across the versions the window contains, and
 * `versionComparable` is carried through verbatim from the geography slice so the narrative can be
 * required to say when a period comparison is not version-safe.
 */
export function narrativeFacts(overview: StrategicOverview): NarrativeFacts {
  const versions = overview.versionSafety.versionsInWindow;

  const byThreatType = new Map<string, number>();
  let messages = 0;
  let eventsRaised = 0;
  for (const point of overview.dynamics.series) {
    messages += point.messages;
    eventsRaised += point.eventsRaised;
    byThreatType.set(point.threatType, (byThreatType.get(point.threatType) ?? 0) + point.eventsRaised);
  }
  const threatTypes = [...byThreatType.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([threatType, raised]) => ({
      threatType, eventsRaised: raised, sharePercent: eventsRaised ? round((raised / eventsRaised) * 100, 1) : 0
    }));

  const geography = overview.geography.rows.map((row) => ({
    oblastId: row.oblastId, oblastName: row.oblastName,
    current: row.current.eventsRaised, previous: row.previous.eventsRaised, delta: row.deltaEventsRaised
  }));

  const lossByOblast = new Map<string, { label: string; withdrawals: number; median: number | null }>();
  for (const row of overview.loss.byOblast) {
    const existing = lossByOblast.get(row.key);
    lossByOblast.set(row.key, {
      label: row.label,
      withdrawals: (existing?.withdrawals ?? 0) + row.withdrawals,
      median: row.medianHeldSeconds ?? existing?.median ?? null
    });
  }

  const sources = overview.sources.rows;

  return {
    window: {
      from: overview.window.from, to: overview.window.to,
      bucket: overview.window.bucket, days: round(overview.window.days)
    },
    classifierVersions: versions,
    versionComparable: overview.versionSafety.comparable,
    unattributedRows: overview.versionSafety.unattributed,
    totals: { messages, eventsRaised },
    threatTypes,
    risingOblasts: geography.filter((row) => row.delta > 0).slice(0, 5),
    fallingOblasts: [...geography].filter((row) => row.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 5),
    interception: {
      asserted: overview.loss.interception.asserted,
      withdrawn: overview.loss.interception.withdrawn,
      withdrawnPercent: round(overview.loss.interception.withdrawnShare * 100, 1),
      medianHeldMinutes: minutes(overview.loss.interception.medianHeldSeconds)
    },
    lossOblasts: [...lossByOblast.entries()]
      .sort((a, b) => b[1].withdrawals - a[1].withdrawals || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([oblastId, value]) => ({
        oblastId, oblastName: value.label, withdrawals: value.withdrawals, medianHeldMinutes: minutes(value.median)
      })),
    fastestSources: [...sources].sort((a, b) => b.firstReports - a.firstReports || a.sourceId.localeCompare(b.sourceId))
      .slice(0, 5).map((row) => ({ sourceId: row.sourceId, firstReports: row.firstReports, messages: row.messages })),
    laggingSources: [...sources].filter((row) => row.medianLagSeconds != null)
      .sort((a, b) => (b.medianLagSeconds ?? 0) - (a.medianLagSeconds ?? 0)).slice(0, 5)
      .map((row) => ({
        sourceId: row.sourceId, followUps: row.followUps, medianLagSeconds: round(row.medianLagSeconds ?? 0, 1)
      })),
    unreadableSources: [...sources].sort((a, b) => b.unreadableShare - a.unreadableShare || a.sourceId.localeCompare(b.sourceId))
      .slice(0, 5).map((row) => ({
        sourceId: row.sourceId, messages: row.messages, unreadablePercent: round(row.unreadableShare * 100, 1)
      })),
    indicators: overview.composition.indicators.slice(0, 8)
      .map((row) => ({ indicator: row.indicator, messages: row.messages })),
    // Summed over the WHOLE indicator list, not over the eight rows above, and over every classifier
    // version in the window. The eight are a top-N for a paragraph to talk about; this is a
    // disclosure, and a disclosure that disappears because the model was the ninth most common
    // indicator that month is not one.
    modelSignals: {
      messages: overview.composition.indicators
        .filter((row) => row.indicator === MODEL_ANALYTICAL_INDICATOR)
        .reduce((sum, row) => sum + row.messages, 0)
    }
  };
}

// ------------------------------------------------------------------------------------------------
// Grounding: every number in the text has to come from the facts
// ------------------------------------------------------------------------------------------------

function addNumber(target: Set<string>, value: number): void {
  if (!Number.isFinite(value)) return;
  const magnitude = Math.abs(value);
  target.add(String(value));
  target.add(String(round(magnitude)));
  target.add(round(magnitude, 1).toFixed(1));
  target.add(String(round(magnitude, 1)));
  // Shares are handed to the model as percentages, but a model may still restate a fraction it was
  // given as a percentage or the other way round; both renderings of the same quantity are the same
  // claim and neither is an invention.
  if (magnitude <= 1) {
    target.add(String(round(magnitude * 100)));
    target.add(round(magnitude * 100, 1).toFixed(1));
  }
  if (magnitude >= 1) target.add(String(round(magnitude / 100, 2)));
}

/**
 * Every rendering of every number in the facts that a narrative is allowed to contain.
 *
 * Typed as `unknown` rather than `NarrativeFacts` because the walk is structural — it descends any
 * object and collects any number it finds — and the nightly digest needs exactly the same guarantee
 * over a differently shaped digest. Narrowing the parameter would have meant a second copy of the
 * one function in this codebase whose job is to be paranoid.
 */
export function groundedNumbers(facts: unknown): Set<string> {
  const allowed = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'number') return addNumber(allowed, value);
    if (typeof value === 'string') {
      for (const token of value.match(/\d+/g) ?? []) {
        allowed.add(token);
        allowed.add(String(Number(token)));
      }
      return;
    }
    if (Array.isArray(value)) {
      // A count the model can legitimately state without being handed it: "три області зросли".
      addNumber(allowed, value.length);
      value.forEach(walk);
      return;
    }
    if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(facts);
  // 0, 1 and 2 are structural rather than factual — "жодного", "одне джерело", "обидві версії".
  for (const trivial of [0, 1, 2]) addNumber(allowed, trivial);
  return allowed;
}

/** The first numeric token in `text` that the facts do not support, or `null` when all are grounded. */
export function ungroundedNumber(text: string, allowed: Set<string>): string | null {
  for (const match of text.match(/\d+(?:[.,]\d+)?/g) ?? []) {
    const normalised = match.replace(',', '.');
    const numeric = Number(normalised);
    if (!Number.isFinite(numeric)) continue;
    if (allowed.has(normalised) || allowed.has(String(numeric)) || allowed.has(String(round(numeric, 1)))) continue;
    return match;
  }
  return null;
}

function verifyNarrative(narrative: ModelNarrative, facts: NarrativeFacts): string | null {
  const allowed = groundedNumbers(facts);
  for (const text of [narrative.headline, ...narrative.findings, ...narrative.caveats]) {
    const invented = ungroundedNumber(text, allowed);
    if (invented) return `ungrounded_number:${invented}`;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------
// The deterministic narrative — the baseline, not the error path
// ------------------------------------------------------------------------------------------------

function describe(facts: NarrativeFacts): ModelNarrative {
  const findings: string[] = [];
  const leading = facts.threatTypes[0];
  if (leading) {
    findings.push(
      `Найбільше подій підняв клас ${leading.threatType}: ${leading.eventsRaised} з ${facts.totals.eventsRaised} `
      + `(${leading.sharePercent}%).`
    );
  }
  const rising = facts.risingOblasts[0];
  if (rising) {
    findings.push(
      `Найбільше зростання — ${rising.oblastName}: ${rising.previous} → ${rising.current} подій `
      + `(${rising.delta > 0 ? '+' : ''}${rising.delta}).`
    );
  }
  const falling = facts.fallingOblasts[0];
  if (falling) {
    findings.push(`Найбільше спадання — ${falling.oblastName}: ${falling.previous} → ${falling.current} подій.`);
  }
  if (facts.interception.asserted > 0) {
    findings.push(
      `Знято ${facts.interception.withdrawn} з ${facts.interception.asserted} тверджень `
      + `(${facts.interception.withdrawnPercent}%)`
      + (facts.interception.medianHeldMinutes == null ? '.' : `, медіана утримання ${facts.interception.medianHeldMinutes} хв.`)
    );
  }
  const loss = facts.lossOblasts[0];
  if (loss) findings.push(`Найчастіше загрози знімають по ${loss.oblastName}: ${loss.withdrawals} зняттів.`);
  const fastest = facts.fastestSources[0];
  if (fastest && fastest.firstReports > 0) {
    findings.push(`Найчастіше першим повідомляє ${fastest.sourceId}: ${fastest.firstReports} подій.`);
  }
  const unreadable = facts.unreadableSources[0];
  if (unreadable && unreadable.unreadablePercent > 0) {
    findings.push(
      `Найбільша частка нерозпізнаного — ${unreadable.sourceId}: ${unreadable.unreadablePercent}% `
      + `з ${unreadable.messages} повідомлень.`
    );
  }
  if (!findings.length) findings.push('За вибране вікно журнал класифікацій не містить жодного рішення.');

  const caveats = [
    'Текст сформовано детерміновано з готових агрегатів; модель не залучалася.',
    facts.classifierVersions.length > 1
      ? `Вікно охоплює версії класифікатора ${facts.classifierVersions.join(', ')} — не порівнюйте періоди без фіксації версії.`
      : `Усі числа отримано під версією класифікатора ${facts.classifierVersions.join(', ') || '—'}.`
  ];
  if (!facts.versionComparable) {
    caveats.push('Порівняння з попереднім періодом не є версійно-безпечним: різницю могли створити зміни наших правил.');
  }

  return {
    headline: `За ${facts.window.days} днів: ${facts.totals.eventsRaised} подій з ${facts.totals.messages} повідомлень.`,
    findings,
    // The model-contribution line belongs to the deterministic text as much as to the model's,
    // because the numbers it qualifies are the same numbers either way. Applied here rather than at
    // each return site so that every deterministic path — no provider, a rejected answer, the
    // cooldown fallback in `narrativeFor` — carries it without having to remember to.
    caveats: withModelSignalMarker(caveats, facts)
  };
}

// ------------------------------------------------------------------------------------------------
// The model call
// ------------------------------------------------------------------------------------------------

/**
 * Two providers, two transports, on purpose.
 *
 * The Codex path carries no endpoint and no headers: the call goes through {@link codexChat}, which
 * owns the transport decision (Responses API against the ChatGPT backend, `chat/completions`
 * against a proxy) and the audit of the call itself. Keeping a URL here was how this module ended
 * up speaking `chat/completions` to a backend that never accepted it. The `AI_*` path keeps its
 * plain OpenAI-compatible request — that endpoint is the risk engine's and speaks nothing else.
 */
export type NarrativeProvider =
  | { kind: 'codex'; model: string }
  | { kind: 'ai'; baseUrl: string; model: string; headers: Record<string, string> };

/**
 * The settings and credential reads, injectable.
 *
 * A unit test asserting "with nothing configured, nothing is called" must not depend on whether a
 * PostgreSQL happens to be listening on the machine running it — that is a test that passes for the
 * wrong reason on a developer's laptop and hangs on a build agent. The credential read is here for
 * the same reason: with `CODEX_BASE_URL` set, deciding between the two providers requires knowing
 * whether a session exists, and that knowledge lives in a database table.
 */
export interface NarrateDeps {
  settings?: () => Promise<ResolvedCodexSettings>;
  credentials?: () => Promise<CodexCredentials | null>;
}

/**
 * Which endpoint, if any, is allowed to write the narrative.
 *
 * Codex wins when it is complete, then `AI_*`, then nothing. There are now two ways to open the
 * Codex gate and they mean different things:
 *
 *   * `ANALYTICS_NARRATIVE_ENABLED` — a deployment decision, made once by whoever owns the
 *     container. It opens both the Codex path and the `AI_*` path.
 *   * the `narrative` switch in `codex_settings` — an operational decision, made in `/ops` by
 *     somebody watching the output, and revocable in one click. It opens the Codex path only.
 *
 * The second deliberately does not reach `AI_*`. That path is the risk engine's credential pointed
 * at a second code path, and a console switch labelled "Codex" must not silently start spending it;
 * sharing credentials with the risk engine must not mean that configuring the risk engine switches
 * on a model call somewhere else.
 *
 * The chosen model comes from the settings row when there is one, falling back to `CODEX_MODEL`.
 * A deployment that never opens the console therefore behaves exactly as it did before the settings
 * table existed.
 *
 * Within Codex the *stored* OAuth session outranks `CODEX_API_KEY`. Both are bearer tokens for the
 * same account and nothing downstream can tell them apart, but only one of them can be renewed
 * without a human editing `.env` and restarting the container. When an operator has signed in
 * through `/ops`, that session is the live credential and the environment value is the stale copy
 * of an older one — so preferring the environment would mean going quiet at the first expiry the
 * refresh path was built to survive.
 *
 * Async for the same reason: obtaining the token may involve refreshing it. Failure there returns
 * null rather than raising, which lands on the deterministic narrative — the baseline that the
 * analytics are contractually complete without.
 */
export async function narrativeProvider(deps: NarrateDeps = {}): Promise<NarrativeProvider | null> {
  const settings = await (deps.settings ?? resolveCodexSettings)().catch(() => null);
  const codexAllowed = config.ANALYTICS_NARRATIVE_ENABLED || settings?.features.narrative === true;
  const codexModel = settings?.effectiveModel ?? (config.CODEX_MODEL || null);

  if (codexAllowed && config.CODEX_BASE_URL && codexModel) {
    // The token is looked at only to decide whether this provider is available; it travels no
    // further. `codexChat` re-reads the credential itself at call time, which also means a refresh
    // between this check and the call is the client's to perform, not ours to have pre-empted.
    const session = await (deps.credentials ?? codexCredentials)().catch(() => null);
    const token = session?.accessToken || config.CODEX_API_KEY;
    if (token) return { kind: 'codex', model: codexModel };
  }
  if (!config.ANALYTICS_NARRATIVE_ENABLED) return null;
  if (config.AI_BASE_URL && config.AI_API_KEY && config.AI_MODEL) {
    return {
      kind: 'ai',
      baseUrl: config.AI_BASE_URL,
      model: config.AI_MODEL,
      headers: { Authorization: `Bearer ${config.AI_API_KEY}`, 'Content-Type': 'application/json' }
    };
  }
  return null;
}

const SYSTEM_PROMPT = [
  'Ти пишеш аналітичний висновок українською для оператора системи повітряних загроз.',
  'Тобі надано ВЖЕ ПОРАХОВАНІ агрегати. Ти не маєш доступу до сирих даних.',
  'Заборонено: вигадувати або перераховувати числа. Використовуй ЛИШЕ ті числа, що є у вхідному JSON, дослівно.',
  'Заборонено: прогнозувати ціль, влучання, маршрут або безпеку.',
  'Якщо versionComparable=false — обов\'язково зазнач, що різницю між періодами могла спричинити зміна версії класифікатора.',
  'Поверни лише JSON: {"headline": string, "findings": string[1..8], "caveats": string[0..6]}.'
].join(' ');

async function audit(
  status: 'success' | 'failed', validation: 'passed' | 'rejected' | 'skipped',
  model: string, input: unknown, output: unknown, durationMs: number, error?: unknown
): Promise<void> {
  // A failed audit write must never cost the caller its analytics: the numbers were already
  // computed and are correct whether or not this row lands.
  //
  // `validation_status` is the point of this row, and it is an ARGUMENT rather than a function of
  // `status` because the two are not the same axis. Migration 022 defines `'rejected'` as "the model
  // text did not survive the number-grounding check", and `codexChat` writes `'skipped'` on every
  // transport row it produces precisely so a filter over the column means one thing whoever wrote
  // it. Deriving the verdict from `status` filed a legacy-provider fetch timeout — no model text, no
  // check run — under the same label as a hallucinated number, so an hour of network failures read
  // as an hour of hallucinations in `SELECT count(*) … WHERE surface='narrative' AND
  // validation_status='rejected'`, the one query the column was added for. `'rejected'` is now
  // written only where the model answered and this module refused the answer.
  await pool.query(
    `INSERT INTO ai_runs(model,prompt_version,input,output,status,error,duration_ms,
                         surface,classifier_version,validation_status,fallback_reason)
     VALUES ($1,'analytics-narrative-v1',$2,$3,$4,$5,$6,'narrative',$7,$8,$5)`,
    [
      model, JSON.stringify(input), output == null ? null : JSON.stringify(output), status,
      error == null ? null : String(error).slice(0, 800), durationMs,
      CLASSIFIER_VERSION, validation
    ]
  ).catch(() => undefined);
}

export interface NarrateOptions extends NarrateDeps {
  /** Injected in tests so the model path can be exercised without a network. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Already-resolved provider. Omitted everywhere except the cached wrapper, which has to look the
   * provider up before the cooldown check and must not pay for a second settings + credential read.
   */
  provider?: NarrativeProvider | null;
}

/**
 * Writes the narrative for an overview.
 *
 * Never throws and never returns without a narrative. Order of preference: a model-written text that
 * passed validation and grounding, otherwise the deterministic text with `rejectionReason` saying
 * why. Callers get the same shape in both cases, so nothing downstream has to branch on whether a
 * model was available.
 */
export async function narrateOverview(
  overview: StrategicOverview, options: NarrateOptions = {}
): Promise<AnalyticsNarrative> {
  const facts = narrativeFacts(overview);
  // `undefined` means "nobody has looked yet"; an explicit `null` means "looked, and there is none".
  // The cached wrapper has to resolve the provider before the cooldown check, and paying a second
  // settings read plus a second credential refresh here would make the memo cost what it saves.
  const provider = options.provider !== undefined ? options.provider : await narrativeProvider(options);
  if (!provider) {
    return {
      ...describe(facts), generatedBy: 'deterministic', aiGenerated: false, model: null,
      rejectionReason: null, facts
    };
  }

  const started = Date.now();
  const deterministic = (rejectionReason: string): AnalyticsNarrative => ({
    ...describe(facts), generatedBy: 'deterministic', aiGenerated: false, model: provider.model,
    rejectionReason: rejectionReason.slice(0, 200), facts
  });

  // What the model sent back, however it was transported. Parsing, schema, grounding and labelling
  // are identical for both providers — the only thing the branch below decides is the wire.
  const conclude = async (content: string): Promise<AnalyticsNarrative> => {
    try {
      const parsed = narrativeSchema.parse(JSON.parse(content));
      const rejection = verifyNarrative(parsed, facts);
      if (rejection) {
        // The grounding rejection itself: the one row `validation_status='rejected'` is defined for.
        await audit('failed', 'rejected', provider.model, facts, parsed, Date.now() - started, rejection);
        return deterministic(rejection);
      }
      if (provider.kind === 'ai') {
        await audit('success', 'passed', provider.model, facts, parsed, Date.now() - started);
      }
      return {
        ...parsed, caveats: withModelSignalMarker(withAiMarker(parsed.caveats), facts),
        generatedBy: 'model', aiGenerated: true, model: provider.model, rejectionReason: null, facts
      };
    } catch (error) {
      // Malformed JSON or a reply the schema refuses. Still `'rejected'`: the model answered and
      // this module declined to publish the answer, which is exactly what the label claims and what
      // an operator counting model-quality failures wants to see. Only the transport catch below is
      // outside that meaning.
      await audit('failed', 'rejected', provider.model, facts, null, Date.now() - started, error);
      return deterministic(String(error));
    }
  };

  if (provider.kind === 'codex') {
    // `codexChat` audits the call itself — including the transport and pre-flight failures — under
    // this same prompt version, so this path writes no success row of its own: one call, one row.
    // A grounding rejection still lands as its own `failed` row above, because "the model answered
    // and the answer was refused" is a fact the transport log alone cannot express.
    const result = await codexChat({
      promptVersion: 'analytics-narrative-v1',
      surface: 'narrative',
      classifierVersion: CLASSIFIER_VERSION,
      system: SYSTEM_PROMPT,
      user: JSON.stringify(facts),
      json: true,
      model: provider.model,
      timeoutMs: options.timeoutMs,
      auditInput: facts
    }, { fetchImpl: options.fetchImpl, credentials: options.credentials, settings: options.settings });
    if (!result.ok) return deterministic(`${result.reason}: ${result.detail}`);
    return conclude(result.content);
  }

  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: provider.headers,
      body: JSON.stringify({
        model: provider.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(facts) }
        ]
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? config.AI_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`narrative endpoint ${response.status}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error('narrative endpoint returned empty content');
    return conclude(content);
  } catch (error) {
    // The legacy provider's transport: a fetch throw, an `AbortSignal.timeout`, a non-2xx or an
    // empty body. No model text exists, so no grounding check ran and this row makes no grounding
    // claim — `'skipped'`, exactly as `codexChat` records the identical event on the Codex wire.
    // Labelling it `'rejected'` made the same physical failure mean two different things depending
    // on which provider was configured.
    await audit('failed', 'skipped', provider.model, facts, null, Date.now() - started, error);
    return deterministic(String(error));
  }
}

/**
 * The sentence that says a machine wrote this.
 *
 * Appended after validation, not asked of the model: a disclosure the model could choose to omit is
 * not a disclosure. The deterministic text carries the mirror-image line ("модель не залучалася"),
 * so a reader is told which of the two they are looking at in both directions rather than having to
 * infer it from the absence of a note.
 */
export function withAiMarker(caveats: string[]): string[] {
  const marker = 'Текст переписано мовною моделлю з готових агрегатів; усі числа перевірено на збіг із детермінованим розрахунком.';
  return caveats.includes(marker) ? caveats : [...caveats, marker];
}

/**
 * The sentence that says part of the count came from a model rather than from a source.
 *
 * A different disclosure from {@link withAiMarker} and the two are not interchangeable: that one is
 * about who wrote the PROSE, this one is about where the NUMBERS came from. A narrative can be
 * deterministic prose over partly model-authored figures, which is precisely the case a reader has
 * no way to spot — the paragraph reads like every other month.
 *
 * Nothing is said when the count is zero. The empty version («модельних сигналів: 0») would appear
 * on every installation that never switched promotion on, and a warning printed a hundred times
 * where it does not apply is a warning nobody reads the hundred-and-first time. Zero is also the
 * default state: `analytical_threats_enabled` ships false (migration 040), so on an untouched
 * deployment this function returns its input unchanged and no surface changes at all.
 *
 * ## Why the number here cannot break the grounding guard
 *
 * The guard rejects a narrative containing a number the facts do not support, and it runs in
 * {@link verifyNarrative} over the MODEL's text only, before this line is appended. The count is
 * nonetheless grounded by construction — it is read out of {@link NarrativeFacts}, which is exactly
 * what {@link groundedNumbers} walks — so appending it can never produce a text that would have
 * failed the check it bypasses. That equivalence is what the case «never states a number the guard
 * would have rejected» beside this file pins down; deriving the count here from anything other than
 * `facts` would silently break it.
 */
export function withModelSignalMarker(caveats: string[], facts: NarrativeFacts): string[] {
  const messages = facts.modelSignals.messages;
  if (messages <= 0) return caveats;
  const marker = `Частину сигналів у вікні дала модель (${messages}) — вони не підтверджені джерелом і лишаються неперевіреними.`;
  return caveats.includes(marker) ? caveats : [...caveats, marker];
}

/** Exposed for tests: the text produced when no model is available. */
export function deterministicNarrative(facts: NarrativeFacts): ModelNarrative {
  return describe(facts);
}

// ------------------------------------------------------------------------------------------------
// The memo, the cooldown, and the one path the route and the worker share
// ------------------------------------------------------------------------------------------------

/**
 * A memo, not a store.
 *
 * Migration 015's header argues at length against introducing a new staleness axis by persisting
 * derived analytics until a month-bucketed year query stops fitting the 15 s `statement_timeout`,
 * and storing prose is exactly that axis. So the prose lives in memory for ten minutes and nowhere
 * else, and a restart costs one model call.
 *
 * Two keys, not one. `windowKey` alone would serve prose about numbers next to a freshly recomputed
 * overview that no longer matches them — the one failure mode a *grounded* narrative is not allowed
 * to have. `factsKey` is the already-rounded digest the model was allowed to talk about, so an event
 * that changes nothing the narrative says leaves the memo standing and an event that moves a number
 * invalidates it by construction. That is the event-driven invalidation, and it needs no
 * invalidation call at all.
 */
interface NarrativeMemo {
  windowKey: string;
  factsKey: string;
  at: number;
  value: AnalyticsNarrative;
}

let memo: NarrativeMemo | null = null;
let lastCodexAt = 0;

/**
 * In-flight dedupe. {@link narrativeFor} is reachable from two ungated places at once —
 * `GET /ops/api/analytics/narrative`, whose only hook is ops auth, and {@link warmNarrative} inside
 * a recompute — so without this, two ops tabs opened together plus a debounced pass all read the
 * same stale `lastCodexAt`, all pass {@link withinCodexCooldown}, and all call the model: three
 * calls, three `ai_runs` transport rows, three `lastCodexAt` writes. The operator's «мінімальний
 * інтервал між Codex-запусками» would then be enforced against sequence but not against
 * concurrency, which is the one axis a mass attack does not respect.
 */
let inFlight: { key: string; promise: Promise<AnalyticsNarrative> } | null = null;

/** Ten minutes — the same length as the window quantum, so exactly one canonical window is live. */
export const NARRATIVE_MEMO_TTL_MS = 600_000;
export const NARRATIVE_WINDOW_QUANTUM_MS = 600_000;
export const CODEX_COOLDOWN_REJECTION = 'codex_cooldown';

/**
 * Declared here, next to the cooldown it counts, and registered by
 * `registerAnalyticsSchedulerMetrics` — the import the other way round would be a cycle, because the
 * scheduler already imports this module.
 */
export const codexCooldownSkips = new Counter({
  name: 'threatlens_codex_cooldown_skips_total',
  help: 'Model calls not made because the operator-set minimum interval had not elapsed',
  labelNames: ['surface'],
  registers: []
});

/**
 * Test seam. Clears the memo AND the cooldown clock AND the in-flight slot: a suite that could reset
 * only one of them would have a second case fail for a reason the first case caused.
 */
export function resetAnalyticsNarrativeMemo(): void {
  memo = null;
  lastCodexAt = 0;
  inFlight = null;
}

/**
 * The window the worker warms and the console reads, quantised so the two can agree.
 *
 * `resolveWindow` defaults `to` to `new Date()` at millisecond precision, so a key built from it
 * would never match between a warm written at 10:03:12.481 and a page loaded a second later — the
 * memo would be dead code. `to` is therefore floored to a ten-minute boundary, the same length as
 * the memo's own TTL. The cost is that the strategic narrative describes data up to ten minutes old,
 * which is nothing next to its thirty-day window and is already the staleness the memo grants.
 */
export function canonicalNarrativeWindow(now: Date = new Date()): AnalyticsWindow {
  const to = new Date(Math.floor(now.getTime() / NARRATIVE_WINDOW_QUANTUM_MS) * NARRATIVE_WINDOW_QUANTUM_MS);
  const from = new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);
  return resolveWindow({ from, to });
}

export function narrativeWindowKey(window: AnalyticsWindow): string {
  return `${window.from.toISOString()}|${window.to.toISOString()}|${window.bucket}`;
}

/**
 * Whether the minimum interval between two model calls on this surface has NOT yet elapsed.
 *
 * At exactly `cooldownMs` the call is allowed: the setting is a minimum gap, and `>=` would make a
 * fifteen-minute cooldown mean fifteen minutes plus a tick, drifting for ever. `cooldownMs === 0`
 * disables the cooldown — the column's CHECK allows 0 and the ops field documents it as «без
 * обмеження». `lastAt === 0` means nothing has been called yet, and a first call is never held.
 *
 * In memory, like `withinRateLimit` in `shadow-classifier.ts`, and for the same reason: a limiter
 * that needs a round trip to decide whether to make a round trip is not a limiter. Single process is
 * the deployed shape; over-budget work is DROPPED, never queued — a queued narrative would arrive
 * fifteen minutes later describing a wave that had ended.
 */
export function withinCodexCooldown(now: number, lastAt: number, cooldownMs: number): boolean {
  if (cooldownMs <= 0) return false;
  if (lastAt === 0) return false;
  return now - lastAt < cooldownMs;
}

export interface CachedNarrateOptions extends NarrateOptions {
  cooldownMs?: number;
  now?: number;
}

export interface WarmNarrativeOptions extends CachedNarrateOptions {
  cooldownMs: number;
}

export interface NarrativeWarmOutcome {
  codex: 'used' | 'cooldown' | 'disabled' | 'failed';
  fallback: boolean;
  narrative: AnalyticsNarrative | null;
}

/**
 * The one path the ops route and the recompute worker share.
 *
 * {@link narrateOverview} itself is deliberately left alone — no cooldown, no memo, same five unit
 * tests and the same three integration cases. Putting the cooldown inside it would make the second
 * call in any test file silently deterministic, and would hold a caller that explicitly asked for a
 * fresh narrative over a hand-picked window.
 */
export async function narrativeFor(
  window: AnalyticsWindow, overview: StrategicOverview, options: CachedNarrateOptions = {}
): Promise<AnalyticsNarrative> {
  const at = options.now ?? Date.now();
  const facts = narrativeFacts(overview);
  const windowKey = narrativeWindowKey(window);
  const factsKey = JSON.stringify(facts);

  if (memo && memo.windowKey === windowKey && memo.factsKey === factsKey
    && at - memo.at < NARRATIVE_MEMO_TTL_MS) {
    return memo.value;
  }

  const provider = options.provider !== undefined ? options.provider : await narrativeProvider(options);
  // No provider at all is not a fallback and not an incident: it is the deployment's baseline, and
  // `narrateOverview` already labels it («модель не залучалася»). Nothing is memoised — the
  // deterministic text is a pure function of facts we already hold.
  if (!provider) return narrateOverview(overview, { ...options, provider: null });

  const cooldownMs = options.cooldownMs ?? 0;
  if (withinCodexCooldown(at, lastCodexAt, cooldownMs)) {
    codexCooldownSkips.inc({ surface: 'narrative' });
    return {
      ...deterministicNarrative(facts), generatedBy: 'deterministic', aiGenerated: false,
      model: provider.model, rejectionReason: CODEX_COOLDOWN_REJECTION, facts
    };
  }

  // Two callers with the same window AND the same facts are asking the same question; the second
  // awaits the first's answer instead of buying a second model call.
  const key = `${windowKey}|${factsKey}`;
  if (inFlight && inFlight.key === key) return inFlight.promise;

  // RESERVE THE SLOT BEFORE THE AWAIT. The setting is a minimum gap between call STARTS — which is
  // what `withinCodexCooldown`'s own comment argues — and stamping only after the call resolves
  // enforces it against sequence but not against concurrency. On the reserve-then-fail path the
  // stamp stays: a failed call is spend (a timed-out endpoint costs the same wall clock and the same
  // connection as a good answer), and retrying a broken endpoint on every debounce window is the
  // outcome that costs the most.
  lastCodexAt = at;
  const promise = (async () => {
    const value = await narrateOverview(overview, { ...options, provider });
    // Memoised only when a provider was actually consulted. A deterministic answer is free to
    // recompute, and memoising a cooldown fallback would keep serving it after the cooldown expired.
    if (value.model !== null) memo = { windowKey, factsKey, at, value };
    return value;
  })().finally(() => { if (inFlight?.key === key) inFlight = null; });
  inFlight = { key, promise };
  return promise;
}

/**
 * The recompute's Codex leg: warm the memo so an operator opening `/ops` usually gets an
 * event-fresh narrative for free.
 */
export async function warmNarrative(options: WarmNarrativeOptions): Promise<NarrativeWarmOutcome> {
  const at = options.now ?? Date.now();
  // Same three-state rule as `narrativeFor`: `undefined` means "look it up", an explicit `null`
  // means "there is none". The lookup is a settings read plus a credential refresh, and a caller
  // that already paid for it must not pay again on the way into the same pass.
  const provider = options.provider !== undefined ? options.provider : await narrativeProvider(options);
  // Cheap checks BEFORE the six-slice fan-out. `strategicOverview` is the most expensive thing in a
  // recompute, and running it to produce prose we are not going to ask for would turn a twenty-second
  // debounce into a standing load on the archive.
  if (!provider) return { codex: 'disabled', fallback: false, narrative: null };
  if (withinCodexCooldown(at, lastCodexAt, options.cooldownMs)) {
    codexCooldownSkips.inc({ surface: 'narrative' });
    return { codex: 'cooldown', fallback: true, narrative: null };
  }

  const window = canonicalNarrativeWindow(new Date(at));
  let overview: StrategicOverview;
  try {
    overview = await strategicOverview(window);
  } catch {
    // `resolveWindow` and the slices raise `AnalyticsInputError` for a caller's mistake; a worker is
    // not a route and has to catch it itself rather than let it become a 500 nobody is looking at.
    return { codex: 'failed', fallback: true, narrative: null };
  }

  const value = await narrativeFor(window, overview, { ...options, provider, now: at });
  return {
    codex: value.aiGenerated ? 'used' : 'failed',
    fallback: !value.aiGenerated,
    narrative: value
  };
}
