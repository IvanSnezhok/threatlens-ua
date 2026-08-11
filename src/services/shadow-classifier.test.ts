import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyMessage } from '../domain/classifier.js';
import type { ClassifiedMessage } from '../types.js';
import {
  buildAnalyticalClassification, deterministicVerdict, disagreementFields, normalizePlace,
  resetShadowMetrics, resetShadowRateLimit, scheduleShadowClassification, shadowClassifierMetrics,
  shadowClassify, shadowSkipCounts,
  withinRateLimit, type ShadowVerdict
} from './shadow-classifier.js';

const locations = [
  { id: 'ua-80', name: 'Київ', aliases: ['києва', 'києві'] },
  { id: 'ua-city-odesa', name: 'Одеса', aliases: ['одеси', 'одесі', 'одесу'] },
  { id: 'ua-59', name: 'Сумська область', aliases: ['сумщина', 'сумщині'] }
];

const classify = (text: string): ClassifiedMessage => classifyMessage(text, locations);

// The feature switch is a database read, and this suite has no database. `codexFeatureEnabled`
// answers `false` when the query fails, and `false` is also the stored default for `shadow` — so the
// switch is mocked on, and the "off" case gets its own test below.
vi.mock('./codex-settings.js', () => ({
  codexFeatureEnabled: vi.fn(async () => true)
}));
const { codexFeatureEnabled } = await import('./codex-settings.js');

// The database write is the last thing `shadowClassify` does and is not what these tests are about;
// what matters is that a failed write is reported as a skip and never thrown.
const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
vi.mock('../db/pool.js', () => ({ pool: { query: (...args: unknown[]) => query(...args as []) } }));

function verdict(overrides: Partial<ShadowVerdict> = {}): ShadowVerdict {
  return { threatType: 'uav', locations: ['Київ'], significant: true, confidence: 0.8, ...overrides };
}

/**
 * A stand-in for {@link codexChat} with its real contract.
 *
 * The client never throws and never parses: it returns a discriminated result whose `content` is the
 * raw model text. Mocking that shape rather than a convenience wrapper is the whole point — a mock
 * that handed back a parsed object would let a change in how this module reads the reply pass every
 * test here and fail in production.
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

const input = (text: string) => ({
  sourceMessageId: '00000000-0000-4000-8000-000000000001',
  publishedAt: new Date('2026-03-01T20:00:00Z'),
  text,
  classified: classify(text)
});

beforeEach(() => {
  resetShadowRateLimit();
  query.mockClear();
  vi.mocked(codexFeatureEnabled).mockResolvedValue(true);
});

describe('normalizePlace', () => {
  it('brings the two spellings of an oblast together', () => {
    expect(normalizePlace('Сумська область')).toBe(normalizePlace('Сумській області'));
    expect(normalizePlace('Сумська область')).toBe(normalizePlace('Сумщина'));
  });

  it('ignores the settlement prefix and the case ending', () => {
    expect(normalizePlace('м. Одеса')).toBe(normalizePlace('Одесу'));
  });

  it('keeps two different places apart', () => {
    expect(normalizePlace('Київ')).not.toBe(normalizePlace('Одеса'));
  });
});

describe('disagreementFields', () => {
  const deterministic = { threatType: 'uav', locationNames: ['Одеса'], significant: true };
  const said = (overrides: Partial<ShadowVerdict> = {}) => verdict({ locations: ['Одеса'], ...overrides });

  it('reports agreement when all three axes match', () => {
    expect(disagreementFields(deterministic, said())).toEqual([]);
  });

  it('tolerates a different inflection of the same place', () => {
    expect(disagreementFields(deterministic, said({ locations: ['Одесі'] }))).toEqual([]);
  });

  it('tolerates the oblast written the short way', () => {
    expect(disagreementFields(
      { ...deterministic, locationNames: ['Сумська область'] }, said({ locations: ['Сумщина'] })
    )).toEqual([]);
  });

  it('names the class when the model filed the message differently', () => {
    expect(disagreementFields(deterministic, said({ threatType: 'ballistic_missile' }))).toEqual(['threat_type']);
  });

  it('names significance when the two sides disagree about raising anything', () => {
    expect(disagreementFields(deterministic, said({ significant: false }))).toContain('significance');
  });

  it('does not also count locations when significance already differs', () => {
    // A withdrawal and a threat naming different places are one disagreement, not two: counting the
    // location axis as well would inflate the disagreement report with a derived fact.
    const fields = disagreementFields(deterministic, said({ significant: false, locations: ['Київ'] }));
    expect(fields).toEqual(['significance']);
  });

  it('names locations when both agree the message matters but not about where', () => {
    expect(disagreementFields(deterministic, said({ locations: ['Київ'] }))).toEqual(['locations']);
  });
});

describe('deterministicVerdict', () => {
  it('reads the three axes off a live classification', () => {
    expect(deterministicVerdict(classify('Ударні БпЛА у напрямку Києва'))).toEqual({
      threatType: 'uav', locationNames: ['Київ'], significant: true
    });
  });

  it('marks a message that names no place as insignificant', () => {
    expect(deterministicVerdict(classify('Шахед')).significant).toBe(false);
  });
});

describe('buildAnalyticalClassification', () => {
  it('turns a verified destination into a labelled unverified-event payload', () => {
    const classified = buildAnalyticalClassification(verdict({
      confidence: 0.96,
      threatState: 'redirected',
      locations: ['Черкаси'],
      destinationLocations: ['Київ'],
      directionText: 'у напрямку Києва'
    }), locations, 'Картка: БпЛА прямує на Київ');
    expect(classified).toMatchObject({
      intent: 'threat', threatType: 'uav', title: 'Аналітична загроза: Київ',
      locations: [{ id: 'ua-80', relationType: 'reported_direction' }]
    });
    expect(classified?.retraction).toBeUndefined();
  });

  it.each([
    verdict({ confidence: 0.89 }),
    verdict({ confidence: 0.99, threatState: 'withdrawn' }),
    verdict({ confidence: 0.99, locations: ['Атлантида'], threatState: 'asserted' }),
    verdict({ confidence: 0.99, significant: false, threatState: 'asserted' })
  ])('rejects a verdict outside the publication contract', (modelVerdict) => {
    expect(buildAnalyticalClassification(modelVerdict, locations, 'джерело')).toBeNull();
  });
});

describe('withinRateLimit', () => {
  it('allows exactly the budget and refuses the next call', () => {
    const now = 1_000_000;
    for (let call = 0; call < 3; call += 1) expect(withinRateLimit(now, 3)).toBe(true);
    expect(withinRateLimit(now, 3)).toBe(false);
  });

  it('lets the budget recover once the minute has rolled past', () => {
    const now = 1_000_000;
    expect(withinRateLimit(now, 1)).toBe(true);
    expect(withinRateLimit(now + 59_000, 1)).toBe(false);
    expect(withinRateLimit(now + 61_000, 1)).toBe(true);
  });
});

describe('shadowClassify', () => {
  it('records agreement when the model reaches the same verdict', async () => {
    const chat = chatReturning(verdict());
    const outcome = await shadowClassify(input('Ударні БпЛА у напрямку Києва'), { chat: chat as never });
    expect(outcome).toMatchObject({ status: 'recorded', agrees: true, fields: [] });
    expect(chat).toHaveBeenCalledOnce();
    expect(chat.mock.calls[0]![0]).toMatchObject({ promptVersion: 'shadow-classifier-v1', json: true });
  });

  it('audits the digest rather than the rendered prompt', async () => {
    // `ai_runs.input` is what an operator reads back weeks later. The system prompt is a constant on
    // every row; the message and the verdict it was compared against are the part worth storing.
    const chat = chatReturning(verdict());
    await shadowClassify(input('Ударні БпЛА у напрямку Києва'), { chat: chat as never });
    expect(chat.mock.calls[0]![0].auditInput).toMatchObject({
      text: 'Ударні БпЛА у напрямку Києва',
      deterministic: { threatType: 'uav', locationNames: ['Київ'], significant: true }
    });
  });

  it('shows bounded same-channel history as context, not as the current assertion', async () => {
    const chat = chatReturning(verdict({
      originLocations: ['Черкаси'], destinationLocations: ['Київ'],
      directionText: 'з Черкас у напрямку Києва', threatState: 'redirected'
    }));
    await shadowClassify(input('далі на Київ'), {
      chat: chat as never,
      loadContext: async () => [{
        id: '00000000-0000-4000-8000-000000000099',
        publishedAt: new Date('2026-03-01T19:58:00Z'), text: 'БпЛА над Черкасами'
      }]
    });
    const prompt = JSON.parse(chat.mock.calls[0]![0].user);
    expect(prompt.currentMessage).toBe('далі на Київ');
    expect(prompt.previousMessages).toEqual([{
      at: '2026-03-01T19:58:00.000Z', text: 'БпЛА над Черкасами'
    }]);
    const insert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO shadow_classifications'))!;
    expect(JSON.parse((insert[1] as unknown[])[14] as string)).toMatchObject({
      threatState: 'redirected', originLocations: ['Черкаси'], destinationLocations: ['Київ']
    });
  });

  it('transcribes audio and sends images only to the advisory model', async () => {
    const chat = chatReturning(verdict());
    await shadowClassify({
      ...input(''),
      media: [
        { kind: 'audio', mimeType: 'audio/ogg', bytes: new Uint8Array([1, 2]) },
        { kind: 'image', mimeType: 'image/png', bytes: new Uint8Array([3, 4]) }
      ]
    }, {
      chat: chat as never, loadContext: async () => [],
      transcribe: async () => ({ ok: true, text: 'БпЛА курсом на Київ' })
    });
    const request = chat.mock.calls[0]![0];
    expect(JSON.parse(request.user).audioTranscripts).toEqual(['БпЛА курсом на Київ']);
    expect(request.images).toHaveLength(1);
    expect(request.images[0].dataUrl).toMatch(/^data:image\/png;base64,/u);
  });

  it('does not ask the classifier to guess when a media-only transcription failed', async () => {
    const chat = chatReturning(verdict());
    const outcome = await shadowClassify({
      ...input(''), media: [{ kind: 'audio', mimeType: 'audio/ogg', bytes: new Uint8Array([1]) }]
    }, {
      chat: chat as never, loadContext: async () => [],
      transcribe: async () => ({ ok: false, reason: 'endpoint_error' })
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'model_failed' });
    expect(chat).not.toHaveBeenCalled();
  });

  it('records a disagreement and the axis it is on', async () => {
    const chat = chatReturning(verdict({ threatType: 'ballistic_missile' }));
    const outcome = await shadowClassify(input('Ударні БпЛА у напрямку Києва'), { chat: chat as never });
    expect(outcome).toMatchObject({ status: 'recorded', agrees: false, fields: ['threat_type'] });
  });

  it('records and returns the analytical event created by the bounded promotion', async () => {
    const promote = vi.fn(async () => '00000000-0000-4000-8000-000000000777');
    const base = input('Картка загроз');
    const outcome = await shadowClassify({
      ...base,
      allowAnalyticalPromotion: true,
      message: {
        sourceId: 'monitor', externalId: '42', publishedAt: base.publishedAt,
        text: 'Картка загроз', rawPayload: {}
      }
    }, { chat: chatReturning(verdict({ confidence: 0.96 })) as never, promote });
    expect(promote).toHaveBeenCalledOnce();
    expect(outcome.promotedEventId).toBe('00000000-0000-4000-8000-000000000777');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('analytical_event_id'))).toBe(true);
  });

  it('collects shadow comparisons without publication when that separate switch is off', async () => {
    vi.mocked(codexFeatureEnabled).mockImplementation(async (feature) => feature === 'shadow');
    const promote = vi.fn(async () => 'should-not-run');
    await shadowClassify({ ...input('Картка загроз'), allowAnalyticalPromotion: true }, {
      chat: chatReturning(verdict({ confidence: 0.96 })) as never, promote
    });
    expect(promote).not.toHaveBeenCalled();
  });

  it('writes the comparison with agrees and both verdicts', async () => {
    await shadowClassify(input('Ударні БпЛА у напрямку Києва'), { chat: chatReturning(verdict()) as never });
    const [sql, params] = query.mock.calls[0]! as unknown as [string, unknown[]];
    expect(sql).toContain('INSERT INTO shadow_classifications');
    expect(params).toContain(true); // agrees
    expect(params).toContain('uav');
    expect(params).toContain('test-model'); // the model the client says it actually used
  });

  it('stays silent when the client reports a failed call, and never rethrows', async () => {
    const chat = chatFailing('endpoint_error');
    const outcome = await shadowClassify(input('Ударні БпЛА у напрямку Києва'), { chat: chat as never });
    expect(outcome).toEqual({ status: 'skipped', reason: 'model_failed' });
    expect(query).not.toHaveBeenCalled();
  });

  it('tells a missing configuration apart from a misbehaving model', async () => {
    // The distinction costs one set lookup and is the difference between "nobody ever signed in" and
    // "the model is having a bad night" — which decide whether an operator opens /ops or their quota.
    const outcome = await shadowClassify(input('Ударні БпЛА у напрямку Києва'), { chat: chatFailing('no_session') as never });
    expect(outcome).toEqual({ status: 'skipped', reason: 'no_provider' });
  });

  it('stays silent when the model answers with something that is not a verdict', async () => {
    // Prose where JSON was asked for, or a threat class that does not exist. Both are the same kind
    // of failure and neither may reach the table: a corpus with invented labels is worse than none.
    const outcome = await shadowClassify(input('Ударні БпЛА у напрямку Києва'), {
      chat: chatReturning({ threatType: 'дрони', locations: [], significant: 'yes' }) as never
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'model_failed' });
    expect(query).not.toHaveBeenCalled();
  });

  it('stays silent when the reply is not JSON at all', async () => {
    const chat = vi.fn(async () => ({ ok: true as const, content: 'Схоже на шахед.', model: 'test-model', durationMs: 5 }));
    expect(await shadowClassify(input('Ударні БпЛА у напрямку Києва'), { chat: chat as never }))
      .toEqual({ status: 'skipped', reason: 'model_failed' });
    expect(query).not.toHaveBeenCalled();
  });

  it('does not call the model at all when the switch is off', async () => {
    vi.mocked(codexFeatureEnabled).mockResolvedValue(false);
    const chat = chatReturning(verdict());
    expect(await shadowClassify(input('Ударні БпЛА у напрямку Києва'), { chat: chat as never }))
      .toEqual({ status: 'skipped', reason: 'disabled' });
    expect(chat).not.toHaveBeenCalled();
  });

  it('asks the switch by its own name and not by another feature\'s', async () => {
    await shadowClassify(input('Ударні БпЛА у напрямку Києва'), { chat: chatReturning(verdict()) as never });
    expect(vi.mocked(codexFeatureEnabled)).toHaveBeenCalledWith('shadow');
  });

  it('drops messages over the per-minute budget instead of queueing them', async () => {
    const chat = chatReturning(verdict());
    const message = input('Ударні БпЛА у напрямку Києва');
    const limit = 6; // SHADOW_CLASSIFIER_MAX_PER_MINUTE default
    for (let call = 0; call < limit; call += 1) {
      expect((await shadowClassify(message, { chat: chat as never })).status).toBe('recorded');
    }
    expect(await shadowClassify(message, { chat: chat as never }))
      .toEqual({ status: 'skipped', reason: 'rate_limited' });
    expect(chat).toHaveBeenCalledTimes(limit);
  });

  it('reports a failed write as a skip rather than breaking the caller', async () => {
    query.mockRejectedValueOnce(new Error('relation does not exist'));
    const outcome = await shadowClassify(input('Ударні БпЛА у напрямку Києва'), { chat: chatReturning(verdict()) as never });
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'write_failed', agrees: true });
  });

  it('never spends a call on an empty message', async () => {
    const chat = chatReturning(verdict());
    expect(await shadowClassify({ ...input('Шахед'), text: '   ' }, { chat: chat as never }))
      .toEqual({ status: 'skipped', reason: 'empty_text' });
    expect(chat).not.toHaveBeenCalled();
  });
});

/**
 * The entry point the pipeline actually calls.
 *
 * Two properties are worth pinning down here and are not covered by the suite above, because both
 * are about what the *caller* can observe rather than about what the model said. First, it hands
 * back nothing: `void` is the guarantee that no future edit in `ingestion.ts` can start branching on
 * a model's opinion. Second, the counter behind it distinguishes a loss from a decision — a switch
 * an operator turned off is not a missing row, and counting it would make the log say the feature is
 * failing when it is merely unused.
 */
describe('scheduleShadowClassification', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('hands the pipeline nothing it could act on', () => {
    expect(scheduleShadowClassification(
      input('Ударні БпЛА у напрямку Києва'), { chat: chatReturning(verdict()) as never }
    )).toBeUndefined();
  });

  it('counts a lost comparison under the reason it was lost for', async () => {
    const before = shadowSkipCounts().model_failed ?? 0;
    scheduleShadowClassification(
      input('Ударні БпЛА у напрямку Києва'), { chat: chatFailing('endpoint_error') as never }
    );
    await vi.waitFor(() => expect(shadowSkipCounts().model_failed ?? 0).toBe(before + 1));
  });

  it('does not count an operator switching the feature off', async () => {
    vi.mocked(codexFeatureEnabled).mockResolvedValue(false);
    const before = shadowSkipCounts().disabled ?? 0;
    scheduleShadowClassification(
      input('Ударні БпЛА у напрямку Києва'), { chat: chatReturning(verdict()) as never }
    );
    await flush();
    expect(shadowSkipCounts().disabled ?? 0).toBe(before);
  });

  it('swallows a rejection instead of leaving it unhandled', async () => {
    // The belt to `shadowClassify`'s braces: a client that starts throwing must not become an
    // unhandled rejection that takes the ingestion process down during an attack.
    const chat = vi.fn(async () => { throw new Error('клієнт зламався'); });
    expect(() => scheduleShadowClassification(
      input('Ударні БпЛА у напрямку Києва'), { chat: chat as never }
    )).not.toThrow();
    await flush();
  });
});

/**
 * The coverage counters.
 *
 * "How much labelling material am I actually collecting, and where is the rest going" is the first
 * question after switching this feature on, and the running total is the only answer that survives a
 * night of thousands of messages. Attempts must count every call — including the ones that never
 * reach the model — or the denominator of coverage silently excludes the failures it exists to
 * measure.
 */
describe('shadow coverage metrics', () => {
  beforeEach(() => {
    resetShadowMetrics();
    resetShadowRateLimit();
  });

  const value = async (name: string, labels?: Record<string, string>) => {
    const metric = shadowClassifierMetrics().find(([metricName]) => metricName === name)![1];
    const { values } = await metric.get();
    const row = labels
      ? values.find((entry) => Object.entries(labels).every(([key, expected]) => entry.labels[key] === expected))
      : values[0];
    return row?.value ?? 0;
  };

  it('counts an attempt and a recorded outcome for a successful call', async () => {
    await shadowClassify(input('Ударні БпЛА у напрямку Києва'), { chat: chatReturning(verdict()) as never });
    expect(await value('threatlens_shadow_attempts_total')).toBe(1);
    expect(await value('threatlens_shadow_outcomes_total', { status: 'recorded', reason: 'none' })).toBe(1);
  });

  it('counts an attempt for a skip too, labelled with why', async () => {
    // The attempt is the denominator: a rate-limited message is one that got no second opinion, and
    // leaving it out of the count would report the coverage of the calls that happened rather than
    // of the corpus.
    await shadowClassify(input('Ударні БпЛА у напрямку Києва'), { chat: chatFailing('endpoint_error') as never });
    expect(await value('threatlens_shadow_attempts_total')).toBe(1);
    expect(await value('threatlens_shadow_outcomes_total', { status: 'skipped', reason: 'model_failed' })).toBe(1);
  });
});
