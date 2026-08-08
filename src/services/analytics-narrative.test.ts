import { describe, expect, it } from 'vitest';
import {
  deterministicNarrative, groundedNumbers, narrativeFacts, narrativeProvider, ungroundedNumber,
  withAiMarker, type NarrativeFacts
} from './analytics-narrative.js';
import type { ResolvedCodexSettings } from './codex-settings.js';
import type { StrategicOverview } from './analytics-archive.js';

/**
 * The rule that makes the optional model layer safe to switch on: a narrative may only contain
 * numbers that came out of the SQL.
 *
 * These are pure functions over an already-computed digest, so they need no database. The
 * integration suite proves the digest is built from real aggregates; this file proves that once it
 * is, a model cannot slip a figure past it.
 */

const facts: NarrativeFacts = {
  window: { from: '2026-02-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z', bucket: 'month', days: 28 },
  classifierVersions: ['v1'],
  versionComparable: true,
  unattributedRows: 0,
  totals: { messages: 6, eventsRaised: 4 },
  threatTypes: [
    { threatType: 'uav', eventsRaised: 3, sharePercent: 75 },
    { threatType: 'ballistic_missile', eventsRaised: 1, sharePercent: 25 }
  ],
  risingOblasts: [{ oblastId: 'ua-63', oblastName: 'Харківська область', current: 2, previous: 1, delta: 1 }],
  fallingOblasts: [{ oblastId: 'ua-53', oblastName: 'Полтавська область', current: 1, previous: 3, delta: -2 }],
  interception: { asserted: 4, withdrawn: 2, withdrawnPercent: 50, medianHeldMinutes: 60 },
  lossOblasts: [{ oblastId: 'ua-53', oblastName: 'Полтавська область', withdrawals: 2, medianHeldMinutes: 60 }],
  fastestSources: [{ sourceId: 'osint-war-monitor', firstReports: 3, messages: 5 }],
  laggingSources: [{ sourceId: 'osint-aeris-rimor', followUps: 1, medianLagSeconds: 600 }],
  unreadableSources: [{ sourceId: 'osint-aeris-rimor', messages: 2, unreadablePercent: 50 }],
  indicators: [{ indicator: 'активність МіГ-31К', messages: 1 }]
};

describe('narrative grounding', () => {
  it('accepts every number the aggregates contain', () => {
    const allowed = groundedNumbers(facts);
    for (const text of [
      'Знято 2 з 4 тверджень (50%).',
      'Харківщина: 1 → 2 події.',
      'Медіана утримання 60 хв.',
      'Найповільніший — 600 с позаду.'
    ]) {
      expect([text, ungroundedNumber(text, allowed)]).toEqual([text, null]);
    }
  });

  it('rejects a number that appears nowhere in the aggregates', () => {
    const allowed = groundedNumbers(facts);
    expect(ungroundedNumber('Зафіксовано 47 ударних БпЛА.', allowed)).toBe('47');
    expect(ungroundedNumber('Частка зросла до 83%.', allowed)).toBe('83');
    // A plausible-looking arithmetic result the model derived rather than received is still an
    // invention: nothing downstream can tell it apart from a hallucination.
    expect(ungroundedNumber('Разом 10 подій.', allowed)).toBe('10');
  });

  it('treats a share and its percentage as the same claim', () => {
    const allowed = groundedNumbers({
      ...facts, interception: { asserted: 4, withdrawn: 2, withdrawnPercent: 50, medianHeldMinutes: null }
    });
    expect(ungroundedNumber('Знято 50% тверджень.', allowed)).toBeNull();
    expect(ungroundedNumber('Знято 0.5 від усіх тверджень.', allowed)).toBeNull();
    expect(ungroundedNumber('Знято 0,5 від усіх тверджень.', allowed)).toBeNull();
  });

  it('allows the small structural numbers a sentence needs', () => {
    const allowed = groundedNumbers(facts);
    for (const text of ['Жодного зняття: 0.', 'Одна версія класифікатора.', 'Обидві половини: 2.']) {
      expect(ungroundedNumber(text, allowed)).toBeNull();
    }
  });
});

describe('the deterministic narrative', () => {
  it('states the leading class, the geography move and the interception rate', () => {
    const narrative = deterministicNarrative(facts);
    expect(narrative.headline).toBe('За 28 днів: 4 подій з 6 повідомлень.');
    expect(narrative.findings).toEqual([
      'Найбільше подій підняв клас uav: 3 з 4 (75%).',
      'Найбільше зростання — Харківська область: 1 → 2 подій (+1).',
      'Найбільше спадання — Полтавська область: 3 → 1 подій.',
      'Знято 2 з 4 тверджень (50%), медіана утримання 60 хв.',
      'Найчастіше загрози знімають по Полтавська область: 2 зняттів.',
      'Найчастіше першим повідомляє osint-war-monitor: 3 подій.',
      'Найбільша частка нерозпізнаного — osint-aeris-rimor: 50% з 2 повідомлень.'
    ]);
  });

  it('never states a number of its own', () => {
    const allowed = groundedNumbers(facts);
    const narrative = deterministicNarrative(facts);
    for (const line of [narrative.headline, ...narrative.findings, ...narrative.caveats]) {
      expect([line, ungroundedNumber(line, allowed)]).toEqual([line, null]);
    }
  });

  it('says out loud when a period comparison is not version-safe', () => {
    const mixed = deterministicNarrative({ ...facts, classifierVersions: ['v1', 'v2'], versionComparable: false });
    expect(mixed.caveats.join(' ')).toContain('v1, v2');
    expect(mixed.caveats.join(' ')).toContain('не є версійно-безпечним');
  });

  it('reports an empty window as empty rather than as a quiet month', () => {
    const empty = deterministicNarrative({
      ...facts, totals: { messages: 0, eventsRaised: 0 }, threatTypes: [], risingOblasts: [],
      fallingOblasts: [], lossOblasts: [], fastestSources: [], unreadableSources: [],
      interception: { asserted: 0, withdrawn: 0, withdrawnPercent: 0, medianHeldMinutes: null }
    });
    expect(empty.findings).toEqual(['За вибране вікно журнал класифікацій не містить жодного рішення.']);
  });
});

describe('facts built from an overview', () => {
  it('sums the per-version series and carries version safety through untouched', () => {
    const overview = {
      window: {
        from: '2026-02-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z', bucket: 'month',
        days: 28, classifierVersions: null, threatType: null, oblastId: null, timezone: 'Europe/Kyiv'
      },
      coverage: { versions: [], messages: 0, overlappingVersions: [], generatedAt: '2026-03-01T00:00:00.000Z' },
      versionSafety: { versionsInWindow: ['v1', 'v2'], splitByVersion: true, comparable: false, unattributed: 3, notes: [] },
      dynamics: {
        series: [
          { bucket: '2026-02-01', classifierVersion: 'v1', threatType: 'uav', messages: 4, eventsRaised: 2, events: 2 },
          { bucket: '2026-02-01', classifierVersion: 'v2', threatType: 'uav', messages: 3, eventsRaised: 3, events: 2 }
        ],
        byOblast: [], withoutGeography: 0
      },
      geography: { rows: [] },
      loss: { interception: { asserted: 0, withdrawn: 0, withdrawnShare: 0, medianHeldSeconds: null }, byOblast: [] },
      sources: { rows: [] },
      composition: { indicators: [] }
    } as unknown as StrategicOverview;

    const built = narrativeFacts(overview);
    expect(built.totals).toEqual({ messages: 7, eventsRaised: 5 });
    expect(built.classifierVersions).toEqual(['v1', 'v2']);
    expect(built.versionComparable).toBe(false);
    expect(built.unattributedRows).toBe(3);
    // The model is handed the mixed total *and* told it is mixed, so the sentence it writes has to
    // carry the caveat rather than the reader having to know.
    expect(deterministicNarrative(built).caveats.join(' ')).toContain('не є версійно-безпечним');
  });
});

// ------------------------------------------------------------------------------------------------
// Who is allowed to call a model, and how the result is labelled
// ------------------------------------------------------------------------------------------------

function settingsWith(features: Partial<ResolvedCodexSettings['features']>): () => Promise<ResolvedCodexSettings> {
  return async () => ({
    model: 'gpt-5.2',
    features: { narrative: false, digest: false, attacks: false, ...features },
    updatedAt: null,
    effectiveModel: 'gpt-5.2',
    modelSource: 'stored'
  });
}

describe('the gate in front of the model', () => {
  it('calls nothing when neither the deployment nor the operator asked for it', async () => {
    expect(await narrativeProvider({ settings: settingsWith({}) })).toBeNull();
  });

  it('still calls nothing when the operator switched the narrative on but no endpoint is configured', async () => {
    // The switch grants permission, not capability. `CODEX_BASE_URL` is empty in the test
    // environment, so there is a token with nowhere to send it â which must read as "off", not as a
    // request that fails somewhere later.
    expect(await narrativeProvider({ settings: settingsWith({ narrative: true }) })).toBeNull();
  });

  it('does not let the Codex switch spend the risk engine credential', async () => {
    // `AI_*` belongs to the risk engine. A console switch labelled "Codex" must not quietly start
    // billing a different provider on a different code path; only ANALYTICS_NARRATIVE_ENABLED,
    // which is off here, opens that branch.
    expect(await narrativeProvider({ settings: settingsWith({ narrative: true, digest: true, attacks: true }) })).toBeNull();
  });
});

describe('labelling machine-written text', () => {
  it('appends the disclosure rather than asking the model to include it', () => {
    // A disclosure the model could choose to omit is not a disclosure.
    const caveats = withAiMarker(['Вікно охоплює одну версію.']);
    expect(caveats).toHaveLength(2);
    expect(caveats.at(-1)).toContain('мовною моделлю');
  });

  it('does not repeat itself if applied twice', () => {
    expect(withAiMarker(withAiMarker([]))).toHaveLength(1);
  });

  it('says the opposite thing in the deterministic text, so neither state is inferred from silence', () => {
    expect(deterministicNarrative(facts).caveats.join(' ')).toContain('модель не залучалася');
  });
});
