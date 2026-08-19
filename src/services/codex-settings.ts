import { config } from '../config.js';
import { pool } from '../db/pool.js';

/**
 * What the operator chose in `/ops`: one model and its independently controlled call sites.
 *
 * ================================================================================================
 * Why this is separate from `codex-auth.ts`
 * ================================================================================================
 *
 * `codex-auth.ts` answers "may we call a model at all" and holds bearer credentials. This module
 * answers "should we, for this particular thing, and with which model" and holds nothing secret.
 * Keeping them apart means a caller that only needs the second question — the analytics narrative
 * deciding whether to bother — never touches a module that can spend a refresh token, and a reader
 * auditing where credentials go has one file to read rather than two.
 *
 * ================================================================================================
 * Failure is "off", never an exception
 * ================================================================================================
 *
 * Every read here is on the path of something that must finish without a model: the analytics
 * numbers, the nightly digest, the extrapolation arithmetic. A database hiccup while reading a
 * feature flag must therefore mean "the feature is off for this run", not "the run fails". That is
 * why {@link codexFeatureEnabled} swallows errors and why {@link resolveCodexSettings} falls back
 * to the environment-only view rather than propagating.
 */

/**
 * The call sites an operator may switch on and off, in the order the console shows them.
 *
 * `shadow` joined the first three in migration 020 and is deliberately fourth: the other three add
 * text to something a human is already looking at, while this one spends a call on every ingested
 * message and produces nothing anybody sees except a comparison table in `/ops`. Same mechanism,
 * very different cost, and the ordering is the only place that says so before the labels do.
 *
 * `analytical_threats` is independent from `shadow`: shadow collects the verdict corpus, while this
 * switch grants a narrow publication path for high-confidence misses. It is off by default, forces
 * `unverified`, resolves every location deterministically, and cannot create a withdrawal or touch
 * official alerts.
 *
 * `analytical_enrichment` (migration 045) sits beside `analytical_threats` and is the smaller of the
 * two despite the similar name. Promotion creates a public event where the rules created none; this
 * one only records what the model read ON TOP of an event the rules did publish — a course, a further
 * settlement, a sharper class — into a table `/ops` reads and no public surface joins. It is separate
 * because the authorities are separate: granting the model the right to fill a gap is not granting it
 * the right to annotate a human channel's published claim, and in an incident an operator turns off
 * whichever one is misbehaving.
 *
 * `retrospective_gate` joined them in migration 025 and is different in kind
 * from all four. Every switch above it buys *text*: turn it off and a paragraph disappears, turn it
 * on and a paragraph appears, and the numbers underneath are the same either way. This one is the
 * suppression path where a model's answer changes what the pipeline does — it may convert
 * a threat the rules would have published into an archive-only row, and nothing else. It is off by
 * default, it is bounded by a per-minute budget and a hard timeout, and every one of its failure
 * modes resolves to the deterministic verdict. An operator reading this list from the top is
 * reading it in order of how much authority they are granting.
 *
 * `tactics` and `attack_research` joined them in migration 033 and are placed after the gate rather
 * than beside their neighbours, because the ordering claim above is about authority and neither of
 * them has any: both buy text over numbers that were computed without a model. What separates them
 * from each other is the audience. `tactics` is the first switch whose text lands on a PUBLIC page
 * directly — the tactical block on `/attacks`, whose detections are published either way and whose
 * commentary is rejected wholesale if it invents a digit, a threat class, an oblast or a forecast.
 * `attack_research` is the opposite extreme: an operator-only memo, never scheduled, produced only
 * when somebody presses a button, and never quotable outside the console.
 *
 * Note what `attacks` is NOT, since its name has outlived its meaning: it gates `refineWithCodex()`
 * in `vector-projection.ts` and nothing else, which is the operator-only extrapolation note. It has
 * never gated the public attacks page — `tactics` does, and only the commentary on it.
 */
export const CODEX_FEATURES = [
  'narrative', 'digest', 'attacks', 'shadow', 'analytical_threats', 'analytical_enrichment',
  'retrospective_gate', 'tactics', 'attack_research',
  // Переказ руху однієї загрози з кількох каналів, у сповіщення передплатникам. Вимкнено за
  // замовчуванням, як і решта: модельний текст біля попередження вмикають свідомо.
  'movement_summary',
  // Статистика ударів і пуассонівський прогноз по регіонах з відкритих джерел (міграція 048).
  // Єдиний перемикач, який публікує РОЗРАХУНОК ПРО МАЙБУТНЄ: ймовірність дня атаки, з дисклеймером,
  // на публічній сторінці атак і в нічній аналітиці бота. Вимкнено за замовчуванням.
  'attack_stats',
  // Оцінка ризику по локаціях моделлю Codex (міграція 049) — замість окремого AI_*-ендпоінта або
  // правил, з контекстом локації в запиті. Та сама межа, що й у AI_*: індекс, не ймовірність; числа
  // затискає `clampAssessment`. Вимкнено за замовчуванням.
  'risk'
] as const;
export type CodexFeature = (typeof CODEX_FEATURES)[number];

export type CodexFeatureFlags = Record<CodexFeature, boolean>;

/**
 * Глибина міркування моделі, як її називає бекенд `/responses`.
 *
 * Їде вкладеним полем `reasoning.effort`. Це не про якість відповіді як таку, а про те, скільки
 * модель думатиме перед нею — і для переказу вже зібраних фактів різниця між `medium` і `high`
 * купується секундами затримки.
 */
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type CodexEffort = (typeof CODEX_EFFORTS)[number];

/**
 * Черга обслуговування. `priority` — це те, що Codex CLI зве fast-режимом.
 *
 * Поле ВЕРХНЬОГО рівня в тілі запиту, на відміну від `reasoning`. Для сповіщень про загрозу воно
 * важливіше за глибину: текст, який приходить після того, як загроза минула, не вартий нічого, хоч
 * би як добре був написаний.
 */
export const CODEX_SERVICE_TIERS = ['priority', 'default', 'flex'] as const;
export type CodexServiceTier = (typeof CODEX_SERVICE_TIERS)[number];

/**
 * Хто класифікує повідомлення (міграція 049).
 *
 * `rules` — детерміновані правила, модель лише тіньова й промоційна, як було завжди. `codex` — модель
 * класифікує кожне повідомлення: клас, локації, актуальність (зараз / за годину / увечері / за добу /
 * за дві доби), ймовірність; правила — запасний шлях, коли модель недоступна, повільна, поза
 * бюджетом чи невпевнена, і єдине джерело відбоїв. Не булевий перемикач, а режим: «хто основний» —
 * це не «чи є ще один текст», і консоль мусить показати його як вибір, а не як галочку.
 */
export const CLASSIFIER_MODES = ['rules', 'codex'] as const;
export type ClassifierMode = (typeof CLASSIFIER_MODES)[number];

export interface CodexSettings {
  /** The operator's explicit choice, or null when they have deferred to `CODEX_MODEL`. */
  model: string | null;
  effort: CodexEffort;
  serviceTier: CodexServiceTier;
  classifierMode: ClassifierMode;
  features: CodexFeatureFlags;
  updatedAt: string | null;
}

export interface ResolvedCodexSettings extends CodexSettings {
  /** What a call will actually send. Null means no model is selected anywhere and none can run. */
  effectiveModel: string | null;
  modelSource: 'stored' | 'env' | 'none';
}

/**
 * The catalogue shown when the service will not tell us what it has.
 *
 * These are the model ids the Codex surface exposed when this was written. They are a *fallback*,
 * not a source of truth: `GET /models` is asked first on every settings read, and whatever it
 * answers replaces this list entirely. The list exists so that a console opened while the session
 * is expired still offers something to pick, rather than an empty dropdown that reads as a bug.
 */
export const FALLBACK_CODEX_MODELS = ['gpt-5.6-luna', 'gpt-5.2', 'gpt-5.2-codex', 'o5', 'o5-mini'] as const;

interface SettingsRow {
  model: string | null;
  reasoning_effort: string;
  service_tier: string;
  narrative_enabled: boolean;
  digest_enabled: boolean;
  attacks_enabled: boolean;
  shadow_enabled: boolean;
  analytical_threats_enabled: boolean;
  analytical_enrichment_enabled: boolean;
  retrospective_gate_enabled: boolean;
  tactics_enabled: boolean;
  attack_research_enabled: boolean;
  movement_summary_enabled: boolean;
  attack_stats_enabled: boolean;
  classifier_mode: string;
  risk_enabled: boolean;
  updated_at: Date;
}

const DEFAULTS: CodexSettings = {
  model: null,
  effort: 'medium',
  serviceTier: 'priority',
  classifierMode: 'rules',
  features: {
    narrative: false, digest: false, attacks: false, shadow: false, analytical_threats: false,
    analytical_enrichment: false, retrospective_gate: false, tactics: false, attack_research: false,
    movement_summary: false, attack_stats: false, risk: false
  },
  updatedAt: null
};

function fromRow(row: SettingsRow): CodexSettings {
  return {
    model: row.model && row.model.trim() ? row.model.trim() : null,
    // Значення з-поза словника читається як замовчування, а не кидає: CHECK у міграції не пускає
    // такого рядка, але база може бути старішою за код під час викочування.
    effort: (CODEX_EFFORTS as readonly string[]).includes(row.reasoning_effort)
      ? row.reasoning_effort as CodexEffort : 'medium',
    serviceTier: (CODEX_SERVICE_TIERS as readonly string[]).includes(row.service_tier)
      ? row.service_tier as CodexServiceTier : 'priority',
    // Невідоме значення читається як `rules`: безпечний бік — правила, як було завжди.
    classifierMode: (CLASSIFIER_MODES as readonly string[]).includes(row.classifier_mode)
      ? row.classifier_mode as ClassifierMode : 'rules',
    features: {
      narrative: row.narrative_enabled,
      digest: row.digest_enabled,
      attacks: row.attacks_enabled,
      shadow: row.shadow_enabled,
      analytical_threats: row.analytical_threats_enabled,
      analytical_enrichment: row.analytical_enrichment_enabled,
      retrospective_gate: row.retrospective_gate_enabled,
      tactics: row.tactics_enabled,
      attack_research: row.attack_research_enabled,
      movement_summary: row.movement_summary_enabled,
      attack_stats: row.attack_stats_enabled,
      risk: row.risk_enabled
    },
    updatedAt: row.updated_at.toISOString()
  };
}

/** Pure: what the stored row plus the environment mean together. Exported so tests need no database. */
export function resolveSettings(stored: CodexSettings): ResolvedCodexSettings {
  const envModel = config.CODEX_MODEL.trim();
  if (stored.model) return { ...stored, effectiveModel: stored.model, modelSource: 'stored' };
  if (envModel) return { ...stored, effectiveModel: envModel, modelSource: 'env' };
  return { ...stored, effectiveModel: null, modelSource: 'none' };
}

/**
 * The catalogue an operator may choose from.
 *
 * Three sources are merged rather than one winning: what the service reported, what the environment
 * pins, and what is currently selected. The last two matter because a model that is *in use* must
 * never disappear from the dropdown — an operator who opens the console while `/models` is
 * unreachable would otherwise see their own choice missing and conclude it had been lost.
 * Order is preserved and duplicates dropped, so the service's own ordering survives.
 */
export function mergeModelCatalogue(
  apiModels: readonly string[], storedModel: string | null, envModel: string
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | null | undefined) => {
    const name = value?.trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    merged.push(name);
  };
  apiModels.forEach(push);
  if (!apiModels.length) FALLBACK_CODEX_MODELS.forEach(push);
  push(envModel);
  push(storedModel);
  return merged;
}

export interface CodexSettingsPatch {
  model?: string | null;
  effort?: string | null;
  serviceTier?: string | null;
  classifierMode?: string | null;
  features?: Partial<CodexFeatureFlags>;
}

/**
 * Pure: the settings that result from applying a patch to the current ones.
 *
 * A patch is partial by design — the console sends the whole form, but the API is also reachable by
 * hand, and "switch off the digest" should not require restating the model. An empty string for
 * `model` means the same as null: the operator cleared the field, which is the explicit choice to
 * defer to `CODEX_MODEL`.
 */
export function applySettingsPatch(current: CodexSettings, patch: CodexSettingsPatch): CodexSettings {
  const model = patch.model === undefined ? current.model : (patch.model?.trim() || null);
  // Невідоме значення лишає поточне, а не падає на замовчування: форма, надіслана старим клієнтом
  // або рукою, не має тихо перемкнути швидкість виклику на щось інше, ніж оператор бачив на екрані.
  const pick = <T extends string>(value: string | null | undefined, allowed: readonly T[], fallback: T): T =>
    (value != null && (allowed as readonly string[]).includes(value)) ? value as T : fallback;
  return {
    model,
    effort: pick(patch.effort, CODEX_EFFORTS, current.effort),
    serviceTier: pick(patch.serviceTier, CODEX_SERVICE_TIERS, current.serviceTier),
    classifierMode: pick(patch.classifierMode, CLASSIFIER_MODES, current.classifierMode),
    features: {
      narrative: patch.features?.narrative ?? current.features.narrative,
      digest: patch.features?.digest ?? current.features.digest,
      attacks: patch.features?.attacks ?? current.features.attacks,
      shadow: patch.features?.shadow ?? current.features.shadow,
      analytical_threats: patch.features?.analytical_threats ?? current.features.analytical_threats,
      analytical_enrichment: patch.features?.analytical_enrichment ?? current.features.analytical_enrichment,
      retrospective_gate: patch.features?.retrospective_gate ?? current.features.retrospective_gate,
      tactics: patch.features?.tactics ?? current.features.tactics,
      attack_research: patch.features?.attack_research ?? current.features.attack_research,
      movement_summary: patch.features?.movement_summary ?? current.features.movement_summary,
      attack_stats: patch.features?.attack_stats ?? current.features.attack_stats,
      risk: patch.features?.risk ?? current.features.risk
    },
    updatedAt: current.updatedAt
  };
}

export async function readCodexSettings(): Promise<CodexSettings> {
  const result = await pool.query<SettingsRow>(
    `SELECT model,reasoning_effort,service_tier,
            narrative_enabled,digest_enabled,attacks_enabled,shadow_enabled,analytical_threats_enabled,
            analytical_enrichment_enabled,retrospective_gate_enabled,tactics_enabled,attack_research_enabled,movement_summary_enabled,
            attack_stats_enabled,classifier_mode,risk_enabled,
            updated_at
       FROM codex_settings WHERE singleton`
  );
  const row = result.rows[0];
  return row ? fromRow(row) : DEFAULTS;
}

/** Read plus environment resolution, degrading to environment-only rather than raising. */
export async function resolveCodexSettings(): Promise<ResolvedCodexSettings> {
  const stored = await readCodexSettings().catch(() => DEFAULTS);
  return resolveSettings(stored);
}

export async function saveCodexSettings(patch: CodexSettingsPatch): Promise<CodexSettings> {
  const next = applySettingsPatch(await readCodexSettings(), patch);
  const result = await pool.query<SettingsRow>(
    `INSERT INTO codex_settings(singleton,model,reasoning_effort,service_tier,
                                narrative_enabled,digest_enabled,attacks_enabled,
                                shadow_enabled,analytical_threats_enabled,analytical_enrichment_enabled,
                                retrospective_gate_enabled,tactics_enabled,attack_research_enabled,movement_summary_enabled,
                                attack_stats_enabled,classifier_mode,risk_enabled,updated_at)
     VALUES (true,$1,$11,$12,$2,$3,$4,$5,$6,$7,$8,$9,$10,$13,$14,$15,$16,now())
     ON CONFLICT (singleton) DO UPDATE SET
       model=EXCLUDED.model,
       reasoning_effort=EXCLUDED.reasoning_effort, service_tier=EXCLUDED.service_tier,
       narrative_enabled=EXCLUDED.narrative_enabled,
       digest_enabled=EXCLUDED.digest_enabled, attacks_enabled=EXCLUDED.attacks_enabled,
       shadow_enabled=EXCLUDED.shadow_enabled,
       analytical_threats_enabled=EXCLUDED.analytical_threats_enabled,
       analytical_enrichment_enabled=EXCLUDED.analytical_enrichment_enabled,
       retrospective_gate_enabled=EXCLUDED.retrospective_gate_enabled,
       tactics_enabled=EXCLUDED.tactics_enabled,
       attack_research_enabled=EXCLUDED.attack_research_enabled,
       movement_summary_enabled=EXCLUDED.movement_summary_enabled,
       attack_stats_enabled=EXCLUDED.attack_stats_enabled,
       classifier_mode=EXCLUDED.classifier_mode, risk_enabled=EXCLUDED.risk_enabled, updated_at=now()
     RETURNING model,reasoning_effort,service_tier,
               narrative_enabled,digest_enabled,attacks_enabled,shadow_enabled,analytical_threats_enabled,
               analytical_enrichment_enabled,retrospective_gate_enabled,tactics_enabled,attack_research_enabled,movement_summary_enabled,
               attack_stats_enabled,classifier_mode,risk_enabled,
               updated_at`,
    [next.model, next.features.narrative, next.features.digest, next.features.attacks,
      next.features.shadow, next.features.analytical_threats, next.features.analytical_enrichment,
      next.features.retrospective_gate, next.features.tactics, next.features.attack_research,
      next.effort, next.serviceTier, next.features.movement_summary, next.features.attack_stats,
      next.classifierMode, next.features.risk]
  );
  return fromRow(result.rows[0]!);
}

/**
 * Whether a given surface is allowed to call the model right now.
 *
 * Deliberately answers only the operator's half of the question. Whether a *session* exists is
 * `codex-auth.ts`'s answer and is checked where the call is made, because a flag that was true when
 * it was read can still meet an expired token a second later — there is no point pretending the two
 * checks are one.
 */
export async function codexFeatureEnabled(feature: CodexFeature): Promise<boolean> {
  try {
    const settings = await readCodexSettings();
    return settings.features[feature];
  } catch {
    return false;
  }
}

/**
 * Хто класифікує зараз. Будь-яка помилка читання — `rules`: конвеєр, який не може прочитати свій
 * режим, має класифікувати правилами, а не зупинятися й не вгадувати, що оператор хотів модель.
 */
export async function codexClassifierMode(): Promise<ClassifierMode> {
  try {
    return (await readCodexSettings()).classifierMode;
  } catch {
    return 'rules';
  }
}
