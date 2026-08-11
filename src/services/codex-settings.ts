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
  'narrative', 'digest', 'attacks', 'shadow', 'analytical_threats', 'retrospective_gate', 'tactics',
  'attack_research'
] as const;
export type CodexFeature = (typeof CODEX_FEATURES)[number];

export type CodexFeatureFlags = Record<CodexFeature, boolean>;

export interface CodexSettings {
  /** The operator's explicit choice, or null when they have deferred to `CODEX_MODEL`. */
  model: string | null;
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
  narrative_enabled: boolean;
  digest_enabled: boolean;
  attacks_enabled: boolean;
  shadow_enabled: boolean;
  analytical_threats_enabled: boolean;
  retrospective_gate_enabled: boolean;
  tactics_enabled: boolean;
  attack_research_enabled: boolean;
  updated_at: Date;
}

const DEFAULTS: CodexSettings = {
  model: null,
  features: {
    narrative: false, digest: false, attacks: false, shadow: false, analytical_threats: false,
    retrospective_gate: false, tactics: false, attack_research: false
  },
  updatedAt: null
};

function fromRow(row: SettingsRow): CodexSettings {
  return {
    model: row.model && row.model.trim() ? row.model.trim() : null,
    features: {
      narrative: row.narrative_enabled,
      digest: row.digest_enabled,
      attacks: row.attacks_enabled,
      shadow: row.shadow_enabled,
      analytical_threats: row.analytical_threats_enabled,
      retrospective_gate: row.retrospective_gate_enabled,
      tactics: row.tactics_enabled,
      attack_research: row.attack_research_enabled
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
  return {
    model,
    features: {
      narrative: patch.features?.narrative ?? current.features.narrative,
      digest: patch.features?.digest ?? current.features.digest,
      attacks: patch.features?.attacks ?? current.features.attacks,
      shadow: patch.features?.shadow ?? current.features.shadow,
      analytical_threats: patch.features?.analytical_threats ?? current.features.analytical_threats,
      retrospective_gate: patch.features?.retrospective_gate ?? current.features.retrospective_gate,
      tactics: patch.features?.tactics ?? current.features.tactics,
      attack_research: patch.features?.attack_research ?? current.features.attack_research
    },
    updatedAt: current.updatedAt
  };
}

export async function readCodexSettings(): Promise<CodexSettings> {
  const result = await pool.query<SettingsRow>(
    `SELECT model,narrative_enabled,digest_enabled,attacks_enabled,shadow_enabled,analytical_threats_enabled,
            retrospective_gate_enabled,tactics_enabled,attack_research_enabled,updated_at
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
    `INSERT INTO codex_settings(singleton,model,narrative_enabled,digest_enabled,attacks_enabled,
                                shadow_enabled,analytical_threats_enabled,retrospective_gate_enabled,
                                tactics_enabled,attack_research_enabled,updated_at)
     VALUES (true,$1,$2,$3,$4,$5,$6,$7,$8,$9,now())
     ON CONFLICT (singleton) DO UPDATE SET
       model=EXCLUDED.model, narrative_enabled=EXCLUDED.narrative_enabled,
       digest_enabled=EXCLUDED.digest_enabled, attacks_enabled=EXCLUDED.attacks_enabled,
       shadow_enabled=EXCLUDED.shadow_enabled,
       analytical_threats_enabled=EXCLUDED.analytical_threats_enabled,
       retrospective_gate_enabled=EXCLUDED.retrospective_gate_enabled,
       tactics_enabled=EXCLUDED.tactics_enabled,
       attack_research_enabled=EXCLUDED.attack_research_enabled, updated_at=now()
     RETURNING model,narrative_enabled,digest_enabled,attacks_enabled,shadow_enabled,analytical_threats_enabled,
               retrospective_gate_enabled,tactics_enabled,attack_research_enabled,updated_at`,
    [next.model, next.features.narrative, next.features.digest, next.features.attacks,
      next.features.shadow, next.features.analytical_threats, next.features.retrospective_gate,
      next.features.tactics, next.features.attack_research]
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
