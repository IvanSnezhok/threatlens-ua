import { describe, expect, it } from 'vitest';
import {
  applySettingsPatch, CODEX_FEATURES, FALLBACK_CODEX_MODELS, mergeModelCatalogue, resolveSettings,
  type CodexSettings
} from './codex-settings.js';

/**
 * The decisions an operator makes in the console, resolved without a database.
 *
 * All three functions here are the seam between "what the operator typed" and "what the request
 * will actually send". They are the place where a wrong answer is silent: a patch that clears a flag
 * nobody asked to clear, a dropdown that has lost the model currently in use, or a `model` field
 * that resolves to the empty string and turns every call into `model_not_selected`. The storage
 * around them is a single `INSERT ... ON CONFLICT` and needs the integration database; these do not.
 */

const stored: CodexSettings = {
  model: null,
  features: {
    narrative: false, digest: false, attacks: false, shadow: false, analytical_threats: false,
    analytical_enrichment: false, retrospective_gate: false, tactics: false, attack_research: false, movement_summary: false, attack_stats: false
  },
  updatedAt: '2026-08-08T00:00:00.000Z'
};

describe('resolving the effective model', () => {
  it('prefers the operator choice over the environment', () => {
    const resolved = resolveSettings({ ...stored, model: 'o5-mini' });
    expect([resolved.effectiveModel, resolved.modelSource]).toEqual(['o5-mini', 'stored']);
  });

  it('falls back to CODEX_MODEL when nothing was chosen', () => {
    // The default test environment leaves CODEX_MODEL empty, so this is the "nothing anywhere" case
    // and it must resolve to null rather than to '' — an empty string would be sent as a model name.
    const resolved = resolveSettings(stored);
    expect(resolved.effectiveModel).toBeNull();
    expect(resolved.modelSource).toBe('none');
  });
});

describe('the model catalogue', () => {
  it('uses what the service reported, in the order the service reported it', () => {
    expect(mergeModelCatalogue(['b-model', 'a-model'], null, '')).toEqual(['b-model', 'a-model']);
  });

  it('stands in the static list only when the service answered with nothing', () => {
    expect(mergeModelCatalogue([], null, '')).toEqual([...FALLBACK_CODEX_MODELS]);
  });

  it('never drops the model that is currently in use', () => {
    // An operator who opens the console while /models is unreachable must not find their own
    // selection missing from the dropdown and conclude it was lost.
    const merged = mergeModelCatalogue(['gpt-5.2'], 'internal-preview', 'pinned-by-env');
    expect(merged).toContain('internal-preview');
    expect(merged).toContain('pinned-by-env');
  });

  it('lists each model once even when three sources name it', () => {
    const merged = mergeModelCatalogue(['gpt-5.2', 'gpt-5.2'], 'gpt-5.2', 'gpt-5.2');
    expect(merged.filter((model) => model === 'gpt-5.2')).toHaveLength(1);
  });

  it('ignores blank entries rather than offering an empty option', () => {
    expect(mergeModelCatalogue(['  '], '   ', '  ')).toEqual([]);
  });
});

describe('applying a patch', () => {
  it('leaves untouched fields exactly as they were', () => {
    const current: CodexSettings = {
      ...stored,
      model: 'o5',
      features: {
        narrative: true, digest: true, attacks: false, shadow: true, analytical_threats: true,
        analytical_enrichment: false, retrospective_gate: true, tactics: true, attack_research: false, movement_summary: false, attack_stats: false
      }
    };
    const next = applySettingsPatch(current, { features: { digest: false } });
    expect(next.model).toBe('o5');
    expect(next.features).toEqual({
      narrative: true, digest: false, attacks: false, shadow: true, analytical_threats: true,
      analytical_enrichment: false, retrospective_gate: true, tactics: true, attack_research: false, movement_summary: false, attack_stats: false
    });
  });

  it('reads a cleared model field as "defer to CODEX_MODEL", not as a model named ""', () => {
    const next = applySettingsPatch({ ...stored, model: 'o5' }, { model: '   ' });
    expect(next.model).toBeNull();
  });

  it('distinguishes an absent model from an explicit null', () => {
    expect(applySettingsPatch({ ...stored, model: 'o5' }, {}).model).toBe('o5');
    expect(applySettingsPatch({ ...stored, model: 'o5' }, { model: null }).model).toBeNull();
  });

  it('switches a feature on without touching the others', () => {
    const next = applySettingsPatch(stored, { features: { attacks: true } });
    expect(next.features).toEqual({
      narrative: false, digest: false, attacks: true, shadow: false, analytical_threats: false,
      analytical_enrichment: false, retrospective_gate: false, tactics: false, attack_research: false, movement_summary: false, attack_stats: false
    });
  });

  it('treats every switch the same way, however late it arrived', () => {
    // `shadow` arrived in migration 020, `retrospective_gate` in 025, and `tactics` and
    // `attack_research` in 033. None of them is a per-page call site like the first three — which is
    // precisely why they must go through the same patch path. A switch with its own code path is a
    // switch that will one day be forgotten by a change made to the rest.
    for (const feature of CODEX_FEATURES) {
      const next = applySettingsPatch(stored, { features: { [feature]: true } });
      expect(next.features[feature], feature).toBe(true);
      const others = CODEX_FEATURES.filter((name) => name !== feature);
      expect(others.map((name) => next.features[name]), feature).toEqual(others.map(() => false));
    }
  });

  it('defaults the retrospective suppression gate off', () => {
    // Every other switch buys text. This one lets a model convert a threat the rules would have
    // published into an archive-only row, so an installation that upgrades into migration 025 must
    // find it off — see `src/services/retrospective-gate.ts`.
    expect(stored.features.retrospective_gate).toBe(false);
    expect(applySettingsPatch(stored, { features: { narrative: true } }).features.retrospective_gate)
      .toBe(false);
  });

  it('defaults analytical threat publication off independently from shadow collection', () => {
    expect(stored.features.analytical_threats).toBe(false);
    expect(applySettingsPatch(stored, { features: { shadow: true } }).features.analytical_threats)
      .toBe(false);
  });

  it('defaults model enrichment off, and grants it separately from publication', () => {
    // Migration 045. The two names are similar and the authorities are not: `analytical_threats`
    // creates a public event where the rules made none, `analytical_enrichment` only records what the
    // model read on top of one the rules did publish. An operator granting the first must not
    // discover they granted the second, in either direction — which is exactly what a shared flag,
    // or a default of "follow the neighbour", would do.
    expect(stored.features.analytical_enrichment).toBe(false);
    expect(applySettingsPatch(stored, { features: { analytical_threats: true } })
      .features.analytical_enrichment).toBe(false);
    expect(applySettingsPatch(stored, { features: { analytical_enrichment: true } })
      .features.analytical_threats).toBe(false);
  });

  it('defaults the tactical commentary off, because it is the only switch that writes in public', () => {
    // `tactics` (migration 033) is the first switch whose text lands on a public page directly
    // rather than in the console or in Telegram. An installation that upgrades into that migration
    // must not discover a model writing on its attacks page; the detections underneath are published
    // either way.
    expect(stored.features.tactics).toBe(false);
    expect(stored.features.attack_research).toBe(false);
    expect(applySettingsPatch(stored, { features: { attack_research: true } }).features.tactics)
      .toBe(false);
  });
});
