import { describe, expect, it } from 'vitest';
import {
  applySettingsPatch, FALLBACK_CODEX_MODELS, mergeModelCatalogue, resolveSettings, type CodexSettings
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
  features: { narrative: false, digest: false, attacks: false, shadow: false },
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
      ...stored, model: 'o5', features: { narrative: true, digest: true, attacks: false, shadow: true }
    };
    const next = applySettingsPatch(current, { features: { digest: false } });
    expect(next.model).toBe('o5');
    expect(next.features).toEqual({ narrative: true, digest: false, attacks: false, shadow: true });
  });

  it('reads a cleared model field as "defer to CODEX_MODEL", not as a model named ""', () => {
    const next = applySettingsPatch({ ...stored, model: 'o5' }, { model: '   ' });
    expect(next.model).toBeNull();
  });

  it('distinguishes an absent model from an explicit null', () => {
    expect(applySettingsPatch({ ...stored, model: 'o5' }, {}).model).toBe('o5');
    expect(applySettingsPatch({ ...stored, model: 'o5' }, { model: null }).model).toBeNull();
  });

  it('switches a feature on without touching the other three', () => {
    const next = applySettingsPatch(stored, { features: { attacks: true } });
    expect(next.features).toEqual({ narrative: false, digest: false, attacks: true, shadow: false });
  });

  it('treats the shadow switch as one of the four, not as a special case', () => {
    // It arrived a migration later than its neighbours and is the only per-message call site, which
    // is precisely why it must go through the same patch path: a switch with its own code path is a
    // switch that will one day be forgotten by a change made to the other three.
    const next = applySettingsPatch(stored, { features: { shadow: true } });
    expect(next.features).toEqual({ narrative: false, digest: false, attacks: false, shadow: true });
  });
});
