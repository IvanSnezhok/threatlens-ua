import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The paragraph a model may write under the public tactical block, and the four ways it loses that
 * right.
 *
 * Every case here is about the same asymmetry. A rejected paragraph costs a reader nothing — the
 * deterministic sentences underneath were already written and are already complete — while a
 * published one that invented a number, a weapon class, an oblast or a future tense is exactly the
 * failure this project exists not to have. So the tests are written from the offending text
 * backwards: given this sentence, does the verifier name the reason.
 *
 * `CODEX_BASE_URL` has to exist before `../config.js` is parsed, and that happens at import time,
 * which is why the module under test is pulled in dynamically below.
 */

const db = vi.hoisted(() => ({ statements: [] as string[] }));

vi.mock('../db/pool.js', () => ({
  pool: {
    query: async (text: string) => {
      db.statements.push(text);
      return { rows: [{ id: 'run-1' }], rowCount: 1 };
    }
  }
}));

process.env.CODEX_BASE_URL = 'https://codex.test/v1';

const {
  TACTICS_AI_MARKER, TACTICS_DETERMINISTIC_MARKER, allowedSubjects, deterministicTacticsCommentary,
  oblastMentions, resetTacticsCommentaryClock, verifyTacticsCommentary, withTacticsAiMarker,
  writeTacticsCommentary
} = await import('./attack-tactics-commentary.js');
const { CODEX_COOLDOWN_REJECTION, groundedNumbers, ungroundedNumber } =
  await import('./analytics-narrative.js');
const { firstForecastLexeme } = await import('../domain/forecast-guard.js');

type Facts = Parameters<typeof deterministicTacticsCommentary>[0];
type Detection = Facts['detections'][number];

const mixShift: Detection = {
  detectionType: 'weapon_mix_shift',
  subjectKey: 'uav',
  subjectLabel: 'ударні БпЛА',
  unit: 'share',
  currentValue: 0.52,
  baselineValue: 0.31,
  currentSupport: 52,
  baselineSupport: 310,
  effect: 0.21,
  evidence: {
    currentPercent: 52, baselinePercent: 31, currentMessages: 52, baselineMessages: 310,
    currentClassMentions: 100, baselineClassMentions: 1000, baselineDays: 14
  },
  sentence: 'Частка класу «ударні БпЛА» серед згадок засобів становить 52% проти 31% у попередні '
    + '14 діб (52 з 100 проти 310 з 1000).',
  rank: 1
};

const concentration: Detection = {
  detectionType: 'territory_concentration',
  subjectKey: 'ua-53',
  subjectLabel: 'Полтавська область',
  unit: 'share',
  currentValue: 0.6,
  baselineValue: 0.4,
  currentSupport: 60,
  baselineSupport: 400,
  effect: 0.2,
  evidence: {
    currentPercent: 60, baselinePercent: 40, currentMessages: 60, baselineMessages: 400,
    currentTerritoryMentions: 100, baselineTerritoryMentions: 1000, baselineDays: 14
  },
  sentence: 'На найчастіше названу територію (Полтавська область) припадає 60% усіх згадок '
    + 'територій за добу проти 40% у попередні 14 діб.',
  rank: 2
};

const facts: Facts = {
  methodologyVersion: 'tactics-v1',
  windows: {
    currentFrom: '2026-02-28T12:00:00.000Z',
    currentTo: '2026-03-01T12:00:00.000Z',
    baselineFrom: '2026-02-14T12:00:00.000Z',
    baselineTo: '2026-02-28T12:00:00.000Z',
    currentHours: 24,
    baselineDays: 14
  },
  totals: { currentMessages: 100, baselineMessages: 1400 },
  classifierVersions: ['v1'],
  detections: [mixShift, concentration]
};

const good = {
  headline: 'Частка ударних БпЛА становить 52% проти 31%.',
  findings: ['На Полтавщину припадає 60% згадок територій проти 40% раніше.'],
  caveats: ['Порівняння спирається на 100 повідомлень за добу.']
};

const settings = async () => ({
  model: 'gpt-5.2' as string | null,
  features: {
    narrative: false, digest: false, attacks: false, shadow: false, retrospective_gate: false,
    tactics: true, attack_research: false
  },
  updatedAt: null,
  effectiveModel: 'gpt-5.2' as string | null,
  modelSource: 'stored' as const
});
const credentials = async () => ({ accessToken: 'token', accountId: null });

function chatReturning(payload: unknown) {
  return vi.fn(async () => ({
    ok: true as const, content: JSON.stringify(payload), model: 'gpt-5.2', durationMs: 5
  }));
}

const base = {
  featureEnabled: async () => true,
  settings: settings as never,
  credentials: credentials as never,
  cooldownMs: 0
};

beforeEach(() => {
  db.statements.length = 0;
  resetTacticsCommentaryClock();
});

// ------------------------------------------------------------------------------------------------
// The baseline
// ------------------------------------------------------------------------------------------------

describe('the deterministic commentary', () => {
  it('is the detection sentences verbatim, under a headline made of the two totals', () => {
    const text = deterministicTacticsCommentary(facts);
    expect(text.findings).toEqual([mixShift.sentence, concentration.sentence]);
    expect(text.headline).toContain('100');
    expect(text.caveats.at(-1)).toBe(TACTICS_DETERMINISTIC_MARKER);
    expect(text.caveats).not.toContain(TACTICS_AI_MARKER);
  });

  it('says plainly that nothing crossed a threshold rather than saying nothing', () => {
    const text = deterministicTacticsCommentary({ ...facts, detections: [] });
    expect(text.findings).toHaveLength(1);
    expect(text.headline).toContain('змін');
  });

  it('would survive its own verifier: no invented number and no future tense', () => {
    const text = deterministicTacticsCommentary(facts);
    const allowed = groundedNumbers(facts);
    for (const line of [text.headline, ...text.findings, ...text.caveats]) {
      expect([line, ungroundedNumber(line, allowed)]).toEqual([line, null]);
    }
    expect(firstForecastLexeme([text.headline, ...text.findings, ...text.caveats])).toBeNull();
  });

  it('names the classifier versions when the two windows disagree about them', () => {
    const text = deterministicTacticsCommentary({ ...facts, classifierVersions: ['v1', 'v2'] });
    expect(text.caveats.some((line) => line.includes('v1, v2'))).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------
// The four checks
// ------------------------------------------------------------------------------------------------

describe('the verifier', () => {
  it('passes a paragraph that only restates what it was given', () => {
    expect(verifyTacticsCommentary(good, facts)).toBeNull();
  });

  it('rejects a number the detections do not carry', () => {
    expect(verifyTacticsCommentary(
      { ...good, findings: ['Зафіксовано 47 ударних БпЛА.'] }, facts
    )).toBe('ungrounded_number:47');
  });

  it('rejects a forecast even when every number in it is correct', () => {
    expect(verifyTacticsCommentary(
      { ...good, findings: ['Частка 52% означає, що наступна ціль — Полтавська область.'] }, facts
    )).toBe('forecast_lexeme:наступн ціл');
  });

  it('rejects a weapon class that was not in the detections', () => {
    expect(verifyTacticsCommentary(
      { ...good, findings: ['Разом із цим зросла балістика.'] }, facts
    )).toBe('threat_class_outside_set:ballistic_missile');
  });

  it('rejects an oblast that was not in the detections', () => {
    expect(verifyTacticsCommentary(
      { ...good, findings: ['Найбільше згадок припадає на Одеську область.'] }, facts
    )).toBe('oblast_outside_set:одеську');
  });

  it('allows a pass with no territory detection to mention no territory at all', () => {
    // Poltava is only nameable because a territory detection named it. Drop that detection and the
    // very same sentence is a claim about data the model never saw.
    const classOnly: Facts = { ...facts, detections: [mixShift] };
    const sentence = { ...good, findings: ['Частка ударних БпЛА зросла найпомітніше на Полтавщині.'] };
    expect(verifyTacticsCommentary(sentence, facts)).toBeNull();
    expect(verifyTacticsCommentary(sentence, classOnly)).toBe('oblast_outside_set:полтавщині');
  });

  it('reads an oblast written either way', () => {
    expect(oblastMentions('на Полтавщині та в Одеській області')).toEqual(['полтавщині', 'одеській']);
    expect(oblastMentions('за добу зросла частка')).toEqual([]);
  });

  it('derives what may be named from the detections and from nothing else', () => {
    const subjects = allowedSubjects(facts.detections);
    expect([...subjects.threatTypes]).toEqual(['uav']);
    expect(subjects.oblasts).toEqual(['полтавська область']);
  });
});

describe('the AI marker', () => {
  it('is appended once, never twice', () => {
    expect(withTacticsAiMarker(['a'])).toEqual(['a', TACTICS_AI_MARKER]);
    expect(withTacticsAiMarker(['a', TACTICS_AI_MARKER])).toEqual(['a', TACTICS_AI_MARKER]);
  });
});

// ------------------------------------------------------------------------------------------------
// The call
// ------------------------------------------------------------------------------------------------

describe('writeTacticsCommentary', () => {
  it('does not call the model at all when the operator switch is off', async () => {
    const chat = chatReturning(good);
    const result = await writeTacticsCommentary(facts, {
      ...base, featureEnabled: async () => false, chat: chat as never
    });
    expect(chat).not.toHaveBeenCalled();
    expect([result.generatedBy, result.aiGenerated, result.model, result.rejectionReason])
      .toEqual(['deterministic', false, null, null]);
    expect(result.findings).toEqual([mixShift.sentence, concentration.sentence]);
  });

  it('publishes the model text with the disclosure appended after validation', async () => {
    const chat = chatReturning(good);
    const result = await writeTacticsCommentary(facts, { ...base, chat: chat as never });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0]![0]).toMatchObject({
      promptVersion: 'attack-tactics-commentary-v1', surface: 'tactics', json: true
    });
    // Exactly the detections, and nothing else, is what the model was shown.
    expect(JSON.parse((chat.mock.calls[0]![0] as { user: string }).user)).toEqual(facts);
    expect([result.generatedBy, result.aiGenerated, result.rejectionReason])
      .toEqual(['model', true, null]);
    expect(result.headline).toBe(good.headline);
    expect(result.caveats.at(-1)).toBe(TACTICS_AI_MARKER);
    expect(result.aiRunId).toBe('run-1');
  });

  it.each([
    ['ungrounded_number:47', { ...good, findings: ['Зафіксовано 47 ударних БпЛА.'] }],
    ['forecast_lexeme:прогноз', { ...good, findings: ['Це прогноз на добу.'] }],
    ['threat_class_outside_set:ballistic_missile', { ...good, findings: ['Зросла балістика.'] }],
    ['oblast_outside_set:одеську', { ...good, findings: ['Найбільше — на Одеську область.'] }]
  ])('falls back to the deterministic text and records «%s»', async (reason, payload) => {
    const result = await writeTacticsCommentary(facts, {
      ...base, chat: chatReturning(payload) as never
    });
    expect([result.generatedBy, result.rejectionReason]).toEqual(['deterministic', reason]);
    expect(result.findings).toEqual([mixShift.sentence, concentration.sentence]);
    expect(result.caveats).not.toContain(TACTICS_AI_MARKER);
  });

  it('falls back when the reply does not fit the schema', async () => {
    const result = await writeTacticsCommentary(facts, {
      ...base, chat: chatReturning({ headline: 'сам лише заголовок' }) as never
    });
    expect(result.generatedBy).toBe('deterministic');
    expect(result.rejectionReason).toBeTruthy();
  });

  it('falls back when the transport fails, keeping the reason an operator can read', async () => {
    const chat = vi.fn(async () => ({
      ok: false as const, reason: 'transport_error' as const, detail: 'timeout',
      model: 'gpt-5.2', durationMs: 1
    }));
    const result = await writeTacticsCommentary(facts, { ...base, chat: chat as never });
    expect([result.generatedBy, result.rejectionReason])
      .toEqual(['deterministic', 'transport_error: timeout']);
  });

  it('holds a second call inside the cooldown without spending a request', async () => {
    const chat = chatReturning(good);
    const options = { ...base, cooldownMs: 900_000, chat: chat as never };
    const first = await writeTacticsCommentary(facts, { ...options, now: 1_000_000 });
    const second = await writeTacticsCommentary(facts, { ...options, now: 1_400_000 });
    const third = await writeTacticsCommentary(facts, { ...options, now: 1_900_000 });
    expect(chat).toHaveBeenCalledTimes(2);
    expect([first.aiGenerated, second.aiGenerated, third.aiGenerated]).toEqual([true, false, true]);
    expect(second.rejectionReason).toBe(CODEX_COOLDOWN_REJECTION);
    expect(second.findings).toEqual([mixShift.sentence, concentration.sentence]);
  });
});
