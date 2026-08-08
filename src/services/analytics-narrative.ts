import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { codexCredentials } from './codex-auth.js';
import { resolveCodexSettings, type ResolvedCodexSettings } from './codex-settings.js';
import type { StrategicOverview } from './analytics-archive.js';

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
}

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
      .map((row) => ({ indicator: row.indicator, messages: row.messages }))
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
    caveats
  };
}

// ------------------------------------------------------------------------------------------------
// The model call
// ------------------------------------------------------------------------------------------------

interface NarrativeProvider {
  baseUrl: string;
  model: string;
  headers: Record<string, string>;
}

/**
 * The settings read, injectable.
 *
 * A unit test asserting "with nothing configured, nothing is called" must not depend on whether a
 * PostgreSQL happens to be listening on the machine running it — that is a test that passes for the
 * wrong reason on a developer's laptop and hangs on a build agent.
 */
export interface NarrateDeps {
  settings?: () => Promise<ResolvedCodexSettings>;
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
    const session = await codexCredentials().catch(() => null);
    const token = session?.accessToken || config.CODEX_API_KEY;
    if (token) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      };
      const accountId = session?.accountId || config.CODEX_ACCOUNT_ID;
      if (accountId) headers['ChatGPT-Account-Id'] = accountId;
      return { baseUrl: config.CODEX_BASE_URL, model: codexModel, headers };
    }
  }
  if (!config.ANALYTICS_NARRATIVE_ENABLED) return null;
  if (config.AI_BASE_URL && config.AI_API_KEY && config.AI_MODEL) {
    return {
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
  status: 'success' | 'failed', model: string, input: unknown, output: unknown, durationMs: number, error?: unknown
): Promise<void> {
  // A failed audit write must never cost the caller its analytics: the numbers were already
  // computed and are correct whether or not this row lands.
  await pool.query(
    `INSERT INTO ai_runs(model,prompt_version,input,output,status,error,duration_ms)
     VALUES ($1,'analytics-narrative-v1',$2,$3,$4,$5,$6)`,
    [
      model, JSON.stringify(input), output == null ? null : JSON.stringify(output), status,
      error == null ? null : String(error).slice(0, 800), durationMs
    ]
  ).catch(() => undefined);
}

export interface NarrateOptions extends NarrateDeps {
  /** Injected in tests so the model path can be exercised without a network. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
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
  const provider = await narrativeProvider(options);
  if (!provider) {
    return {
      ...describe(facts), generatedBy: 'deterministic', aiGenerated: false, model: null,
      rejectionReason: null, facts
    };
  }

  const started = Date.now();
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
    const parsed = narrativeSchema.parse(JSON.parse(content));
    const rejection = verifyNarrative(parsed, facts);
    if (rejection) {
      await audit('failed', provider.model, facts, parsed, Date.now() - started, rejection);
      return {
        ...describe(facts), generatedBy: 'deterministic', aiGenerated: false, model: provider.model,
        rejectionReason: rejection, facts
      };
    }
    await audit('success', provider.model, facts, parsed, Date.now() - started);
    return {
      ...parsed, caveats: withAiMarker(parsed.caveats), generatedBy: 'model', aiGenerated: true,
      model: provider.model, rejectionReason: null, facts
    };
  } catch (error) {
    await audit('failed', provider.model, facts, null, Date.now() - started, error);
    return {
      ...describe(facts), generatedBy: 'deterministic', aiGenerated: false, model: provider.model,
      rejectionReason: String(error).slice(0, 200), facts
    };
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

/** Exposed for tests: the text produced when no model is available. */
export function deterministicNarrative(facts: NarrativeFacts): ModelNarrative {
  return describe(facts);
}
