import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The memo tests drive `narrativeFor` over a stubbed provider, so the two edges it would otherwise
 * touch — the `ai_runs` insert and the six-slice archive fan-out — are replaced here. The insert is
 * counted rather than discarded: "one model call leaves one transport row" is one of the properties
 * under test, and a mock that swallowed the write could not show it.
 */
const db = vi.hoisted(() => ({ statements: [] as string[] }));

vi.mock('../db/pool.js', () => ({
  pool: {
    query: async (text: string) => { db.statements.push(text); return { rows: [], rowCount: 0 }; }
  }
}));

const archive = vi.hoisted(() => ({ overview: null as unknown }));

vi.mock('./analytics-archive.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./analytics-archive.js')>()),
  strategicOverview: async () => archive.overview
}));

import {
  CODEX_COOLDOWN_REJECTION, NARRATIVE_MEMO_TTL_MS, NARRATIVE_WINDOW_QUANTUM_MS,
  canonicalNarrativeWindow, deterministicNarrative, groundedNumbers, narrateOverview, narrativeFacts,
  narrativeFor, narrativeProvider, narrativeWindowKey, resetAnalyticsNarrativeMemo, ungroundedNumber,
  warmNarrative, withAiMarker, withinCodexCooldown,
  type NarrativeFacts, type NarrativeProvider
} from './analytics-narrative.js';
import type { ResolvedCodexSettings } from './codex-settings.js';
import { resolveWindow, type StrategicOverview } from './analytics-archive.js';

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

// ------------------------------------------------------------------------------------------------
// The memo, the cooldown and the concurrency the operator's minimum interval has to survive
// ------------------------------------------------------------------------------------------------

/**
 * A minimal overview whose only moving part is the number of events raised, which is what the
 * `factsKey` is there to notice.
 */
function overviewWith(eventsRaised: number): StrategicOverview {
  return {
    window: {
      from: '2026-02-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z', bucket: 'day',
      days: 28, classifierVersions: null, threatType: null, oblastId: null, timezone: 'Europe/Kyiv'
    },
    coverage: { versions: [], messages: 0, overlappingVersions: [], generatedAt: '2026-03-01T00:00:00.000Z' },
    versionSafety: { versionsInWindow: ['v2'], splitByVersion: false, comparable: true, unattributed: 0, notes: [] },
    dynamics: {
      series: [{ bucket: '2026-02-01', classifierVersion: 'v2', threatType: 'uav', messages: 4, eventsRaised, events: eventsRaised }],
      byOblast: [], withoutGeography: 0
    },
    geography: { rows: [] },
    loss: { interception: { asserted: 0, withdrawn: 0, withdrawnShare: 0, medianHeldSeconds: null }, byOblast: [] },
    sources: { rows: [] },
    composition: { indicators: [] }
  } as unknown as StrategicOverview;
}

const window = resolveWindow({ from: '2026-02-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' });
const provider: NarrativeProvider = {
  kind: 'ai', baseUrl: 'https://model.test/v1', model: 'test-model',
  headers: { 'Content-Type': 'application/json' }
};

/** A model that answers with text containing only numbers the facts already hold. */
function modelSaying(headline: string) {
  let calls = 0;
  let hold: ((value: Response) => void) | null = null;
  const fetchImpl = (async () => {
    calls += 1;
    const body = JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ headline, findings: ['Одне джерело.'], caveats: [] }) } }]
    });
    const response = new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (!hold) return response;
    return new Promise<Response>(() => undefined);
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    get calls() { return calls; },
    neverResolve() { hold = () => undefined; }
  };
}

beforeEach(() => {
  resetAnalyticsNarrativeMemo();
  db.statements = [];
  archive.overview = overviewWith(4);
});

const aiRunInserts = () => db.statements.filter((text) => text.includes('INSERT INTO ai_runs')).length;

describe('the narrative memo', () => {
  it('serves the memo for the same window and the same facts', async () => {
    const model = modelSaying('Перший текст.');
    const overview = overviewWith(4);
    const first = await narrativeFor(window, overview, { provider, fetchImpl: model.fetchImpl, now: 1_000 });
    const second = await narrativeFor(window, overview, { provider, fetchImpl: model.fetchImpl, now: 2_000 });

    expect(model.calls).toBe(1);
    expect(second).toBe(first);
    expect(second.aiGenerated).toBe(true);
  });

  it('recomputes when a number in the facts moved', async () => {
    // The one failure mode a *grounded* narrative may not have: prose about numbers standing next to
    // an overview that no longer produces them.
    const model = modelSaying('Перший текст.');
    await narrativeFor(window, overviewWith(4), { provider, fetchImpl: model.fetchImpl, now: 1_000 });
    await narrativeFor(window, overviewWith(9), { provider, fetchImpl: model.fetchImpl, now: 2_000 });
    expect(model.calls).toBe(2);
  });

  it('recomputes after the memo TTL', async () => {
    const model = modelSaying('Перший текст.');
    const overview = overviewWith(4);
    await narrativeFor(window, overview, { provider, fetchImpl: model.fetchImpl, now: 1_000 });
    await narrativeFor(window, overview, { provider, fetchImpl: model.fetchImpl, now: 1_000 + NARRATIVE_MEMO_TTL_MS });
    expect(model.calls).toBe(2);
  });

  it('does not memoise a deterministic answer when no provider is configured', async () => {
    const model = modelSaying('Перший текст.');
    const overview = overviewWith(4);
    const value = await narrativeFor(window, overview, { provider: null, fetchImpl: model.fetchImpl, now: 1_000 });
    expect(value).toMatchObject({ generatedBy: 'deterministic', aiGenerated: false, model: null, rejectionReason: null });
    expect(model.calls).toBe(0);

    // Nothing was memoised, so the very next call with a provider still reaches the model.
    await narrativeFor(window, overview, { provider, fetchImpl: model.fetchImpl, now: 2_000 });
    expect(model.calls).toBe(1);
  });
});

describe('the Codex cooldown', () => {
  it('labels a cooldown fallback without calling the model', async () => {
    const model = modelSaying('Перший текст.');
    await narrativeFor(window, overviewWith(4), {
      provider, fetchImpl: model.fetchImpl, now: 1_000_000, cooldownMs: 900_000
    });
    expect(model.calls).toBe(1);

    const held = await narrativeFor(window, overviewWith(9), {
      provider, fetchImpl: model.fetchImpl, now: 1_000_001, cooldownMs: 900_000
    });
    expect(model.calls).toBe(1);
    expect(held).toMatchObject({
      generatedBy: 'deterministic', aiGenerated: false, model: 'test-model',
      rejectionReason: CODEX_COOLDOWN_REJECTION
    });
  });

  it('does not memoise a cooldown fallback', async () => {
    const model = modelSaying('Перший текст.');
    const overview = overviewWith(4);
    await narrativeFor(window, overview, { provider, fetchImpl: model.fetchImpl, now: 1_000_000, cooldownMs: 900_000 });
    expect(model.calls).toBe(1);

    const held = await narrativeFor(window, overviewWith(9), {
      provider, fetchImpl: model.fetchImpl, now: 1_000_100, cooldownMs: 900_000
    });
    expect(held.rejectionReason).toBe(CODEX_COOLDOWN_REJECTION);

    // Once the gap has elapsed the next call reaches the provider: a memoised fallback would keep
    // being served after the cooldown it describes had expired.
    await narrativeFor(window, overviewWith(9), {
      provider, fetchImpl: model.fetchImpl, now: 1_900_000, cooldownMs: 900_000
    });
    expect(model.calls).toBe(2);
  });

  it('reserves the cooldown slot before the call, not after', async () => {
    // A call that never resolves still has to block the next one. Stamping only on resolution
    // enforces the operator's minimum interval against sequence but not against concurrency, which
    // is the one axis a mass attack does not respect.
    const model = modelSaying('Перший текст.');
    model.neverResolve();
    void narrativeFor(window, overviewWith(4), {
      provider, fetchImpl: model.fetchImpl, now: 1_000_000, cooldownMs: 900_000
    });
    await new Promise((resolve) => setImmediate(resolve));

    const held = await narrativeFor(window, overviewWith(9), {
      provider, fetchImpl: model.fetchImpl, now: 1_000_100, cooldownMs: 900_000
    });
    expect(held.rejectionReason).toBe(CODEX_COOLDOWN_REJECTION);
    expect(model.calls).toBe(1);
  });

  it('narrateOverview is unchanged by the cooldown', async () => {
    // The cooldown lives next to the narrative, not inside `narrateOverview`: putting it there would
    // make the second call in any test file silently deterministic.
    const model = modelSaying('Перший текст.');
    await narrativeFor(window, overviewWith(4), {
      provider, fetchImpl: model.fetchImpl, now: 1_000_000, cooldownMs: 900_000
    });
    const direct = await narrateOverview(overviewWith(4), { provider, fetchImpl: model.fetchImpl });
    expect(model.calls).toBe(2);
    expect(direct.aiGenerated).toBe(true);
  });
});

describe('one question, one model call', () => {
  it('two concurrent narrativeFor calls make one model call', async () => {
    // `cooldownMs: 0` — «без обмеження» — on purpose: with a cooldown configured the second caller
    // is already refused by the interval check one line earlier, so the dedupe is the ONLY thing
    // standing between two ops tabs and two model calls exactly when the operator turned the
    // interval off.
    const model = modelSaying('Перший текст.');
    const overview = overviewWith(4);
    const options = { provider, fetchImpl: model.fetchImpl, now: 1_000_000, cooldownMs: 0 };
    const [first, second] = await Promise.all([
      narrativeFor(window, overview, options),
      narrativeFor(window, overview, options)
    ]);
    expect(model.calls).toBe(1);
    expect(second).toBe(first);
  });

  it('a warmNarrative racing an ops GET makes one call and one ai_runs transport row', async () => {
    const model = modelSaying('Перший текст.');
    const at = Date.UTC(2026, 2, 1, 10, 3, 12);
    const canonical = canonicalNarrativeWindow(new Date(at));
    archive.overview = overviewWith(4);

    const [warm, route] = await Promise.all([
      warmNarrative({ provider, fetchImpl: model.fetchImpl, now: at, cooldownMs: 0 }),
      // The route resolves the same canonical window, which is the whole point of quantising it.
      narrativeFor(canonical, overviewWith(4), { provider, fetchImpl: model.fetchImpl, now: at, cooldownMs: 0 })
    ]);

    expect(model.calls).toBe(1);
    expect(aiRunInserts()).toBe(1);
    expect(warm).toMatchObject({ codex: 'used', fallback: false });
    expect(route.aiGenerated).toBe(true);
  });

  it('warmNarrative reports a missing provider as disabled without touching the archive', async () => {
    const model = modelSaying('Перший текст.');
    archive.overview = null;                        // any read of it would throw
    const outcome = await warmNarrative({ provider: null, fetchImpl: model.fetchImpl, now: 1_000, cooldownMs: 0 });
    expect(outcome).toEqual({ codex: 'disabled', fallback: false, narrative: null });
    expect(model.calls).toBe(0);
  });
});

describe('the canonical window', () => {
  it('floors `to` to the quantum and spans thirty days', () => {
    const inside = canonicalNarrativeWindow(new Date(Date.UTC(2026, 2, 1, 10, 3, 12, 481)));
    const alsoInside = canonicalNarrativeWindow(new Date(Date.UTC(2026, 2, 1, 10, 7, 55, 2)));
    const across = canonicalNarrativeWindow(new Date(Date.UTC(2026, 2, 1, 10, 11, 0, 0)));

    expect(narrativeWindowKey(inside)).toBe(narrativeWindowKey(alsoInside));
    expect(narrativeWindowKey(across)).not.toBe(narrativeWindowKey(inside));
    expect(inside.to.getTime() % NARRATIVE_WINDOW_QUANTUM_MS).toBe(0);
    expect(inside.days).toBe(30);
    expect(inside.bucket).toBe('day');
  });

  it('is what makes the memo reachable at all', () => {
    // `resolveWindow` defaults `to` to millisecond precision, so a key built from two ordinary calls
    // one millisecond apart would never match and the memo would be dead code.
    expect(narrativeWindowKey(resolveWindow({ to: new Date(1) })))
      .not.toBe(narrativeWindowKey(resolveWindow({ to: new Date(2) })));
  });
});

describe('the cooldown predicate', () => {
  it('never holds the first call, allows one at exactly the interval, and is off at zero', () => {
    expect(withinCodexCooldown(1_000, 0, 900_000)).toBe(false);
    expect(withinCodexCooldown(1_900_000, 1_000_000, 900_000)).toBe(false);
    expect(withinCodexCooldown(1_899_999, 1_000_000, 900_000)).toBe(true);
    expect(withinCodexCooldown(1_000_001, 1_000_000, 0)).toBe(false);
  });
});
