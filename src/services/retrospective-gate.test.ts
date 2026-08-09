import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyMessage } from '../domain/classifier.js';
import type { ClassifiedMessage } from '../types.js';
import {
  resetRetrospectiveGateMetrics, resetRetrospectiveGateRateLimit, retrospectiveGate,
  retrospectiveGateMetrics, withinRateLimit
} from './retrospective-gate.js';

const locations = [
  { id: 'ua-80', name: 'Київ', aliases: ['києва', 'києві', 'києвом'] },
  { id: 'ua-city-odesa', name: 'Одеса', aliases: ['одеси', 'одесі', 'одесу'] }
];

const classify = (text: string): ClassifiedMessage => classifyMessage(text, locations);

// The feature switch is a database read and this suite has no database. `codexFeatureEnabled`
// answers `false` when the query fails, which is also the stored default — so it is mocked on, and
// the "off" case gets its own test.
vi.mock('./codex-settings.js', () => ({ codexFeatureEnabled: vi.fn(async () => true) }));
const { codexFeatureEnabled } = await import('./codex-settings.js');

/**
 * A message the `v5` rules put in the grey band: narration plus one weak operational word.
 *
 * Built by running the real classifier rather than by hand-assembling a `ClassifiedMessage`. The
 * band is the classifier's judgement, and a fixture that asserted the flag itself would keep passing
 * on the day the classifier stopped setting it.
 */
const SUSPECT_TEXT = 'Цієї ночі БпЛА атакували Київ, і місто знову не спало. Атака триває.';

/** The same shape the rules refuse outright, and the shape they publish outright. */
const CURRENT_TEXT = 'БпЛА курсом на Київ';

function suspectInput(text = SUSPECT_TEXT) {
  return { sourceId: 'osint-eradar', text, classified: classify(text) };
}

/**
 * A stand-in for `codexChat` with its real contract: never throws, never parses, hands back the raw
 * model text on `content`. Mocking that shape rather than a parsed object is the point — a mock that
 * returned an object would let a change in how this module reads a reply pass every test here.
 */
function chatReturning(value: unknown) {
  return vi.fn(async () => ({
    ok: true as const, content: JSON.stringify(value), model: 'test-model', durationMs: 5
  }));
}

function chatFailing(reason: string) {
  return vi.fn(async () => ({
    ok: false as const, reason, detail: 'деталь для оператора', model: 'test-model', durationMs: 5
  }));
}

beforeEach(() => {
  resetRetrospectiveGateRateLimit();
  resetRetrospectiveGateMetrics();
  vi.mocked(codexFeatureEnabled).mockResolvedValue(true);
});

describe('the band the gate is reachable from', () => {
  it('is exactly what the classifier marks suspect', () => {
    expect(classify(SUSPECT_TEXT).retrospective?.verdict).toBe('suspect');
    // Vetoed messages never reach this module: the pipeline has already archived them.
    expect(classify('Цієї ночі БпЛА атакували Київ, і місто знову не спало.').retrospective?.verdict)
      .toBe('vetoed');
    expect(classify(CURRENT_TEXT).retrospective).toBeUndefined();
  });

  it('refuses to act on anything else, whatever the model would have said', async () => {
    // Guard 2 of the four in the module header, tested directly: a mis-call from a future call site
    // cannot archive a message the rules never put in the band. The model is not even asked.
    const chat = chatReturning({ current: false, confidence: 1 });
    for (const text of [CURRENT_TEXT, 'Цієї ночі БпЛА атакували Київ, і місто знову не спало.']) {
      const outcome = await retrospectiveGate({ sourceId: 's', text, classified: classify(text) }, { chat });
      expect(outcome, text).toEqual({ verdict: 'publish', reason: 'not_suspect' });
    }
    expect(chat).not.toHaveBeenCalled();
  });
});

describe('the one thing the model is allowed to do', () => {
  it('archives a suspect message the model reads as retrospective', async () => {
    const chat = chatReturning({ current: false, confidence: 0.9 });
    const outcome = await retrospectiveGate(suspectInput(), { chat });
    expect(outcome).toEqual({
      verdict: 'archive', reason: 'model_says_retrospective', confidence: 0.9
    });
  });

  it('asks one question, on its own surface, stamped with the classifier version', async () => {
    const chat = chatReturning({ current: false, confidence: 0.9 });
    await retrospectiveGate(suspectInput(), { chat });
    const request = chat.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(request.surface).toBe('retrospective_gate');
    expect(request.promptVersion).toBe('retrospective-gate-v1');
    expect(request.json).toBe(true);
    expect(request.classifierVersion).toBe('v5');
    // The whole message, not the classifier's 500-character summary: the essays this layer exists
    // for say what they are in their last paragraph as often as in their first.
    expect(request.user).toBe(SUSPECT_TEXT);
    // The audit row records what the answer might have overturned, which is the only way an operator
    // reading `ai_runs` months later can tell a good suppression from a bad one.
    expect(request.auditInput).toMatchObject({
      sourceId: 'osint-eradar',
      wouldPublish: { threatType: 'uav', locations: ['Київ'] }
    });
  });
});

describe('everything else resolves to the deterministic verdict, which is to publish', () => {
  it('publishes when the operator has not switched the gate on', async () => {
    vi.mocked(codexFeatureEnabled).mockResolvedValue(false);
    const chat = chatReturning({ current: false, confidence: 1 });
    expect(await retrospectiveGate(suspectInput(), { chat }))
      .toEqual({ verdict: 'publish', reason: 'disabled' });
    expect(chat).not.toHaveBeenCalled();
  });

  it('publishes when the per-minute budget is spent', async () => {
    const chat = chatReturning({ current: false, confidence: 1 });
    // The default budget is six; the seventh message of the minute must publish rather than queue.
    for (let call = 0; call < 6; call += 1) await retrospectiveGate(suspectInput(), { chat });
    expect(await retrospectiveGate(suspectInput(), { chat }))
      .toEqual({ verdict: 'publish', reason: 'rate_limited' });
    expect(chat).toHaveBeenCalledTimes(6);
  });

  it('publishes when no model is configured, and says so as a separate reason', async () => {
    for (const reason of ['not_configured', 'model_not_selected', 'no_session']) {
      resetRetrospectiveGateRateLimit();
      expect(await retrospectiveGate(suspectInput(), { chat: chatFailing(reason) }))
        .toEqual({ verdict: 'publish', reason: 'no_provider' });
    }
  });

  it('publishes when the model is reachable and broken', async () => {
    for (const reason of ['session_expired', 'endpoint_error', 'transport_error']) {
      resetRetrospectiveGateRateLimit();
      expect(await retrospectiveGate(suspectInput(), { chat: chatFailing(reason) }))
        .toEqual({ verdict: 'publish', reason: 'model_failed' });
    }
  });

  it('publishes when the call itself throws', async () => {
    const chat = vi.fn(async () => { throw new Error('socket hang up'); });
    expect(await retrospectiveGate(suspectInput(), { chat: chat as never }))
      .toEqual({ verdict: 'publish', reason: 'model_failed' });
  });

  it('publishes when the model answers prose where JSON was asked for', async () => {
    const chat = vi.fn(async () => ({
      ok: true as const, content: 'Це ретроспектива, я впевнений.', model: 'test-model', durationMs: 5
    }));
    expect(await retrospectiveGate(suspectInput(), { chat }))
      .toEqual({ verdict: 'publish', reason: 'model_failed' });
  });

  it('publishes when the answer is well-formed JSON of the wrong shape', async () => {
    // A schema violation must be indistinguishable from a refusal to suppress. `current` is the
    // field that has to be affirmed, so a model that omits it cannot suppress by accident.
    for (const answer of [{ retrospective: true }, { current: 'ні' }, { current: false }, {}]) {
      resetRetrospectiveGateRateLimit();
      expect(await retrospectiveGate(suspectInput(), { chat: chatReturning(answer) }), JSON.stringify(answer))
        .toEqual({ verdict: 'publish', reason: 'model_failed' });
    }
  });

  it('publishes when the model reads the message as current', async () => {
    expect(await retrospectiveGate(suspectInput(), { chat: chatReturning({ current: true, confidence: 0.95 }) }))
      .toEqual({ verdict: 'publish', reason: 'model_says_current', confidence: 0.95 });
  });

  it('publishes when the model is not sure enough to overrule a warning', async () => {
    expect(await retrospectiveGate(suspectInput(), { chat: chatReturning({ current: false, confidence: 0.69 }) }))
      .toEqual({ verdict: 'publish', reason: 'low_confidence', confidence: 0.69 });
    resetRetrospectiveGateRateLimit();
    // …and exactly at the floor it is.
    expect(await retrospectiveGate(suspectInput(), { chat: chatReturning({ current: false, confidence: 0.7 }) }))
      .toEqual({ verdict: 'archive', reason: 'model_says_retrospective', confidence: 0.7 });
  });

  it('publishes when the model takes longer than the budget', async () => {
    const chat = vi.fn(() => new Promise<never>(() => undefined));
    const started = Date.now();
    const outcome = await retrospectiveGate(suspectInput(), { chat: chat as never, timeoutMs: 20 });
    expect(outcome).toEqual({ verdict: 'publish', reason: 'timeout' });
    // The bound is real: a gate that waited on the default 2.5 s here would take two orders of
    // magnitude longer than the 20 ms it was given.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('bounds a slow call even when the client ignores its own timeout', async () => {
    // `codexChat` bounds the fetch, not the function — a best-effort audit insert runs afterwards.
    // The outer race is what keeps a database in trouble from becoming an ingestion stall.
    const chat = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return { ok: true as const, content: '{"current":false,"confidence":1}', model: 'm', durationMs: 5_000 };
    });
    expect(await retrospectiveGate(suspectInput(), { chat: chat as never, timeoutMs: 20 }))
      .toEqual({ verdict: 'publish', reason: 'timeout' });
  });
});

describe('the rate limit', () => {
  it('is a rolling minute, and lets the budget back after it', () => {
    const start = 1_700_000_000_000;
    for (let call = 0; call < 6; call += 1) expect(withinRateLimit(start, 6)).toBe(true);
    expect(withinRateLimit(start, 6)).toBe(false);
    expect(withinRateLimit(start + 60_001, 6)).toBe(true);
  });

  it('refuses every call when the budget is zero', () => {
    expect(withinRateLimit(1_700_000_000_000, 0)).toBe(false);
  });
});

describe('metrics', () => {
  it('counts one attempt per grey-band message and one outcome per verdict', async () => {
    await retrospectiveGate(suspectInput(), { chat: chatReturning({ current: false, confidence: 0.9 }) });
    await retrospectiveGate(suspectInput(), { chat: chatReturning({ current: true, confidence: 0.9 }) });
    // Not in the band: no attempt, no outcome, because neither would mean anything.
    await retrospectiveGate(
      { sourceId: 's', text: CURRENT_TEXT, classified: classify(CURRENT_TEXT) },
      { chat: chatReturning({ current: false, confidence: 1 }) }
    );

    const metrics = Object.fromEntries(retrospectiveGateMetrics());
    const attempts = await metrics.threatlens_retrospective_gate_attempts_total!.get();
    expect(attempts.values[0]?.value).toBe(2);

    const outcomes = await metrics.threatlens_retrospective_gate_outcomes_total!.get();
    expect(outcomes.values.map((value) => ({ ...value.labels, value: value.value })))
      .toEqual(expect.arrayContaining([
        { verdict: 'archive', reason: 'model_says_retrospective', value: 1 },
        { verdict: 'publish', reason: 'model_says_current', value: 1 }
      ]));
  });

  it('names both metrics so the registry wiring cannot drift', () => {
    expect(retrospectiveGateMetrics().map(([name]) => name)).toEqual([
      'threatlens_retrospective_gate_attempts_total',
      'threatlens_retrospective_gate_outcomes_total'
    ]);
  });
});

/**
 * Structural proof of the two claims the header makes about where this module may act.
 *
 * Both are properties of *source*, not of behaviour, so they are checked as source. A runtime test
 * cannot express "there is no second call site" or "this file can never write alert state" — it can
 * only fail to find one, which is exactly the shape of assurance that stops being true the day
 * somebody adds a branch. `src/api/vector-isolation.test.ts` pins the operator-only extrapolation
 * the same way and for the same reason.
 */
describe('structural isolation', () => {
  const read = (path: string) =>
    readFileSync(resolve(import.meta.dirname, '..', '..', path), 'utf8');

  it('has exactly one place that can produce an archive verdict', () => {
    const source = read('src/services/retrospective-gate.ts');
    const archives = source.match(/verdict: 'archive'/gu) ?? [];
    expect(archives).toHaveLength(1);
  });

  it('cannot write anything, least of all alert state', () => {
    // The alert path is Tier A and is reconciled from official sources alone. Nothing here may
    // reach it, and the cheapest durable way to say so is that this module names none of the tables,
    // repositories or transports that could.
    //
    // Comments are stripped first: the header explains at length where this module sits relative to
    // `ingestThreat`, and a check that could not tell prose from code would have to choose between
    // being wrong and being undocumented.
    const source = read('src/services/retrospective-gate.ts')
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/(^|\s)\/\/[^\n]*/gu, '$1');
    for (const forbidden of ['alert_source_states', 'alert_periods', 'threat_events',
      'system_event_log', 'notification_outbox', 'ingestThreat', 'applyDeEscalation',
      'reconcileAggregateAlert', 'pool.query', 'INSERT', 'UPDATE']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('is reached from one call site, inside the classifier path and before the event is ingested', () => {
    const ingestion = read('src/services/ingestion.ts');
    const calls = ingestion.match(/\bretrospectiveGate\(/gu) ?? [];
    expect(calls).toHaveLength(1);

    const callSite = ingestion.indexOf('retrospectiveGate({');
    const classifierPath = ingestion.indexOf('async function classifyAndIngest(');
    const ingest = ingestion.indexOf('await ingestThreat(');
    expect(callSite).toBeGreaterThan(-1);
    // Every alert-channel function in that file is declared above `classifyAndIngest`, so a call
    // site after it is a call site none of them can reach: an official alert channel's message can
    // never enter this gate.
    expect(callSite).toBeGreaterThan(classifierPath);
    // …and before the event exists, which is what makes this a gate rather than a withdrawal.
    expect(callSite).toBeLessThan(ingest);
  });

  it('is guarded at the call site by the same flag it re-checks itself', () => {
    const ingestion = read('src/services/ingestion.ts');
    expect(ingestion).toContain("classified.retrospective?.verdict === 'suspect'");
  });
});
