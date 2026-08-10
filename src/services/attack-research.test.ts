import { describe, expect, it } from 'vitest';
import {
  RESEARCH_BANDS,
  RESEARCH_FRAMING,
  RESEARCH_TYPICAL_MIN_COUNT,
  RESEARCH_TYPICAL_MIN_SHARE,
  classifyBand,
  composeResearchPack,
  deterministicMemo,
  memoForecastLexeme,
  researchCaveats,
  researchMemoSchema,
  researchRefusal,
  resolveResearchWindow,
  verifyResearchMemo,
  withResearchMarker,
  type ComposeResearchInput,
  type ResearchMemo,
  type ResearchPack
} from './attack-research.js';
import { groundedNumbers, ungroundedNumber } from './analytics-narrative.js';
import { firstForecastLexeme } from '../domain/forecast-guard.js';

/**
 * Everything in this file is pure. The database half — the four statements, the request rows, the
 * caps counted from them — is exercised against a live PostgreSQL in
 * `tests/integration/attack-research.test.ts`, and the isolation half in
 * `src/api/vector-isolation.test.ts`.
 *
 * The tests are grouped by the thing they protect rather than by the function they call, because the
 * three things worth protecting here are not functions:
 *
 *   1. **The band never becomes a probability.** `classifyBand` answers with one of four phrases
 *      about the past, on stated thresholds, and nothing about a trend or a rate enters it.
 *   2. **The fallback is a complete memo and says nothing the arithmetic did not.** It carries the
 *      framing first, contains no band word, invents no number and trips no forecast lexeme.
 *   3. **The verifier refuses a model reply for any one of five reasons**, and refuses the whole of
 *      it rather than the offending sentence.
 */

// ------------------------------------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------------------------------------

const NOW = new Date('2026-08-10T18:30:00.000Z');

function historyRow(
  kind: 'class' | 'hour' | 'version' | 'total' | 'indicator',
  key: string, inBand: number, all: number, lastAt: Date | null = null
) {
  return { kind, key, in_band_messages: inBand, all_messages: all, last_in_band_at: lastAt };
}

/**
 * One oblast, one night band, a shape a real query would produce: two classes that fill the band, one
 * that has happened once, one indicator list and a single classifier version.
 */
function composeInput(overrides: Partial<ComposeResearchInput> = {}): ComposeResearchInput {
  return {
    oblast: { id: 'ua-oblast-poltava', name: 'Полтавська область' },
    window: resolveResearchWindow('night', NOW, 'Europe/Kyiv'),
    now: NOW,
    nowRow: {
      alerts: [{ locationName: 'Полтавська область', alertType: 'air_raid', startedAt: '2026-08-10T18:00:00.000Z' }],
      live_threats: [{ eventId: 'e1', threatType: 'uav', status: 'active', evidenceLevel: 'monitoring' }],
      risk: [{ locationName: 'Полтавська область', threatType: 'uav', score: '6.5', level: 'significant' }],
      live_classes: ['uav'],
      signals_3h: 4, signals_6h: 9, signals_12h: 15
    },
    history: [
      historyRow('total', 'all', 40, 120),
      historyRow('class', 'uav', 24, 70, new Date('2026-08-09T23:10:00.000Z')),
      historyRow('class', 'ballistic_missile', 8, 20, new Date('2026-08-08T01:00:00.000Z')),
      historyRow('class', 'cruise_missile', 1, 4, new Date('2026-07-30T02:00:00.000Z')),
      historyRow('hour', '22', 9, 9),
      historyRow('hour', '23', 11, 11),
      historyRow('hour', '02', 20, 20),
      historyRow('version', 'v5', 40, 120),
      historyRow('indicator', 'mass_launch', 0, 12),
      historyRow('indicator', 'strategic_aviation', 0, 3)
    ],
    timeline: [
      { at: '2026-08-09T22:00:00.000Z', threatType: null, messages: 6, eventsRaised: 1, firstAt: '2026-08-09T22:01:00.000Z', lastAt: '2026-08-09T22:40:00.000Z' },
      { at: '2026-08-09T23:00:00.000Z', threatType: null, messages: 4, eventsRaised: 0, firstAt: '2026-08-09T23:05:00.000Z', lastAt: '2026-08-09T23:20:00.000Z' },
      { at: '2026-08-08T00:00:00.000Z', threatType: null, messages: 5, eventsRaised: 1, firstAt: '2026-08-08T00:02:00.000Z', lastAt: '2026-08-08T00:50:00.000Z' }
    ],
    upstream: [{ location_name: 'Сумська область', occurrences: 4 }],
    chains: [{ threatType: 'uav', label: 'ударні БпЛА', places: ['Суми', 'Полтава'] }],
    ...overrides
  };
}

const PACK = composeResearchPack(composeInput());

// ------------------------------------------------------------------------------------------------
// The band
// ------------------------------------------------------------------------------------------------

describe('classifyBand', () => {
  it('puts anything airborne on the top rung regardless of what the archive says', () => {
    expect(classifyBand({ observedNow: true, windowMessages: 0, windowShare: 0 })).toBe('спостерігається');
    expect(classifyBand({ observedNow: true, windowMessages: 900, windowShare: 1 })).toBe('спостерігається');
  });

  it('needs BOTH the count and the share to call a class typical', () => {
    // On both thresholds exactly: the boundary belongs to «типово», which is what `>=` means.
    expect(classifyBand({
      observedNow: false, windowMessages: RESEARCH_TYPICAL_MIN_COUNT, windowShare: RESEARCH_TYPICAL_MIN_SHARE
    })).toBe('типово для цього вікна');
    // One message short.
    expect(classifyBand({
      observedNow: false, windowMessages: RESEARCH_TYPICAL_MIN_COUNT - 1, windowShare: 0.9
    })).toBe('нетипово, але траплялося');
    // A hundred messages that are still a rounding error of the band.
    expect(classifyBand({
      observedNow: false, windowMessages: 100, windowShare: RESEARCH_TYPICAL_MIN_SHARE - 0.0001
    })).toBe('нетипово, але траплялося');
  });

  it('separates «once» from «never», because they are different answers', () => {
    expect(classifyBand({ observedNow: false, windowMessages: 1, windowShare: 0.01 }))
      .toBe('нетипово, але траплялося');
    expect(classifyBand({ observedNow: false, windowMessages: 0, windowShare: 0 }))
      .toBe('у цьому вікні не фіксували');
  });

  it('answers with one of the four closed phrases and never with anything else', () => {
    for (const observedNow of [true, false]) {
      for (const windowMessages of [0, 1, 3, 40]) {
        for (const windowShare of [0, 0.1, 0.15, 0.8]) {
          expect(RESEARCH_BANDS).toContain(classifyBand({ observedNow, windowMessages, windowShare }));
        }
      }
    }
  });
});

// ------------------------------------------------------------------------------------------------
// Windows
// ------------------------------------------------------------------------------------------------

describe('resolveResearchWindow', () => {
  it('reads the night as a band of eight hours, not as an interval', () => {
    const window = resolveResearchWindow('night', NOW, 'Europe/Kyiv');
    expect(window.hours).toEqual([22, 23, 0, 1, 2, 3, 4, 5]);
    expect(window.hours).toHaveLength(8);
  });

  it('means the night the operator is standing in when it is already past midnight', () => {
    // 02:30 Kyiv on 11 August. The night under way started at 22:00 on the 10th.
    const insideTheNight = new Date('2026-08-10T23:30:00.000Z');
    const window = resolveResearchWindow('night', insideTheNight, 'Europe/Kyiv');
    expect(window.from).toBe(new Date('2026-08-10T19:00:00.000Z').toISOString());
    expect(window.to).toBe(new Date('2026-08-11T03:00:00.000Z').toISOString());
  });

  it('means the coming night when the evening has not reached 22:00 yet', () => {
    // 21:30 Kyiv on 10 August: the night named is the one starting half an hour later.
    const evening = new Date('2026-08-10T18:30:00.000Z');
    const window = resolveResearchWindow('night', evening, 'Europe/Kyiv');
    expect(window.from).toBe(new Date('2026-08-10T19:00:00.000Z').toISOString());
  });

  it('rolls the day band to tomorrow only once the clock has passed 22:00', () => {
    const beforeTen = resolveResearchWindow('day', new Date('2026-08-10T18:30:00.000Z'), 'Europe/Kyiv');
    expect(beforeTen.from).toBe(new Date('2026-08-10T03:00:00.000Z').toISOString());
    const afterTen = resolveResearchWindow('day', new Date('2026-08-10T20:30:00.000Z'), 'Europe/Kyiv');
    expect(afterTen.from).toBe(new Date('2026-08-11T03:00:00.000Z').toISOString());
    expect(afterTen.hours).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  });

  it('maps the rolling twelve hours onto twelve consecutive Kyiv hours', () => {
    // 21:30 Kyiv → the band is 21..08.
    const window = resolveResearchWindow('next12h', new Date('2026-08-10T18:30:00.000Z'), 'Europe/Kyiv');
    expect(window.hours).toEqual([21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Date(window.to).getTime() - new Date(window.from).getTime()).toBe(12 * 3_600_000);
  });

  it('survives the winter side of the Kyiv clock', () => {
    // January: UTC+2 rather than UTC+3, so the same wall clock is a different instant.
    const winter = resolveResearchWindow('night', new Date('2026-01-15T18:30:00.000Z'), 'Europe/Kyiv');
    expect(winter.from).toBe(new Date('2026-01-15T20:00:00.000Z').toISOString());
    expect(winter.to).toBe(new Date('2026-01-16T04:00:00.000Z').toISOString());
  });
});

// ------------------------------------------------------------------------------------------------
// The pack
// ------------------------------------------------------------------------------------------------

describe('composeResearchPack', () => {
  it('is a function of its input and of nothing else', () => {
    expect(composeResearchPack(composeInput())).toEqual(composeResearchPack(composeInput()));
  });

  it('gives the same answer when the rows arrive in another order', () => {
    const input = composeInput();
    const shuffled = composeInput({ history: [...input.history].reverse() });
    expect(composeResearchPack(shuffled)).toEqual(composeResearchPack(input));
  });

  it('bands every class from the counts, strongest first', () => {
    expect(PACK.history.perClass.map((entry) => [entry.threatType, entry.band])).toEqual([
      ['uav', 'спостерігається'],
      ['ballistic_missile', 'типово для цього вікна'],
      ['cruise_missile', 'нетипово, але траплялося']
    ]);
    // 8 of 40 messages in the band: over the share threshold, over the count threshold.
    expect(PACK.history.perClass[1]!.windowShare).toBe(0.2);
  });

  it('keeps a class that is airborne now but has never filled these hours', () => {
    const input = composeInput();
    input.nowRow.live_classes = ['uav', 'guided_air_bomb'];
    const pack = composeResearchPack(input);
    const bomb = pack.history.perClass.find((entry) => entry.threatType === 'guided_air_bomb')!;
    expect(bomb.band).toBe('спостерігається');
    expect(bomb.windowMessages).toBe(0);
    expect(bomb.baselineSupport).toBe(0);
  });

  it('fills all twenty-four hours, including the empty ones', () => {
    expect(PACK.history.hours).toHaveLength(24);
    expect(PACK.history.hours.find((hour) => hour.hour === '02')!.messages).toBe(20);
    expect(PACK.history.hours.find((hour) => hour.hour === '13')!.messages).toBe(0);
  });

  it('refuses `medium` without a sample, without one classifier version, or without anything live', () => {
    expect(PACK.confidence).toBe('medium');
    const thin = composeResearchPack(composeInput({
      history: [historyRow('total', 'all', 4, 10), historyRow('version', 'v5', 4, 10)]
    }));
    expect(thin.confidence).toBe('low');

    const twoVersions = composeInput();
    twoVersions.history = [...twoVersions.history, historyRow('version', 'v4', 2, 6)];
    expect(composeResearchPack(twoVersions).confidence).toBe('low');

    const quiet = composeInput();
    quiet.nowRow = { ...quiet.nowRow, alerts: [], live_threats: [], live_classes: [] };
    expect(composeResearchPack(quiet).confidence).toBe('low');
  });

  it('carries the public chain and no candidate location, bearing or cone', () => {
    expect(PACK.now.chains).toEqual([{ threatType: 'uav', label: 'ударні БпЛА', places: ['Суми', 'Полтава'] }]);
    const serialised = JSON.stringify(PACK);
    for (const forbidden of ['bearingDegrees', 'cone', 'centerline', 'candidates', 'horizonMinutes']) {
      expect(serialised, `the pack carried «${forbidden}»`).not.toContain(forbidden);
    }
  });

  it('names its own admissions rather than leaving them to the reader', () => {
    expect(researchCaveats({
      baselineMessages: 4, windowMessages: 2, classifierVersions: ['v4', 'v5'],
      somethingLive: false, upstream: 0
    })).toHaveLength(5);
    // A full pack still carries the one caveat that is never optional.
    expect(PACK.caveats[0]).toContain('це не інтервал, у якому щось станеться');
  });
});

// ------------------------------------------------------------------------------------------------
// The deterministic memo
// ------------------------------------------------------------------------------------------------

describe('deterministicMemo', () => {
  const memo = deterministicMemo(PACK);

  it('opens with the framing sentence, verbatim and first', () => {
    expect(memo.summary.startsWith(RESEARCH_FRAMING)).toBe(true);
  });

  it('contains no band word anywhere', () => {
    const text = [memo.summary, ...memo.classes.map((entry) => entry.rationale), ...memo.caveats].join(' ');
    for (const band of RESEARCH_BANDS) {
      expect(text, `the deterministic memo said «${band}»`).not.toContain(band);
    }
    // And the structured field is null rather than the computed value, so the audit table stays the
    // only place the band is recorded for a memo no model wrote.
    expect(memo.classes.every((entry) => entry.band === null)).toBe(true);
  });

  it('states no number the pack does not contain', () => {
    const allowed = groundedNumbers(PACK);
    for (const text of [memo.summary, ...memo.classes.map((entry) => entry.rationale), ...memo.caveats]) {
      expect(ungroundedNumber(text, allowed), `ungrounded number in: ${text}`).toBeNull();
    }
  });

  it('trips no forecast lexeme', () => {
    expect(memoForecastLexeme(memo)).toBeNull();
  });

  it('says that no model was involved', () => {
    expect(memo.caveats.at(-1)).toContain('модель не залучалася');
  });

  it('passes the same verifier a model reply has to pass', () => {
    expect(verifyResearchMemo(memo, PACK)).toBeNull();
  });

  it('fits the schema the model is held to, so the two are comparable', () => {
    // Except `band`, which the model must fill and the fallback deliberately leaves null.
    const asModelWould = { ...memo, classes: memo.classes.map((entry, index) => ({
      ...entry, band: PACK.history.perClass[index]!.band
    })) };
    expect(() => researchMemoSchema.parse(asModelWould)).not.toThrow();
  });

  it('is still a complete memo for an oblast the archive has nothing on', () => {
    const empty = composeResearchPack(composeInput({
      history: [historyRow('total', 'all', 0, 0)],
      timeline: [],
      upstream: [],
      chains: [],
      nowRow: {
        alerts: [], live_threats: [], risk: [], live_classes: [],
        signals_3h: 0, signals_6h: 0, signals_12h: 0
      }
    }));
    const written = deterministicMemo(empty);
    expect(written.summary.startsWith(RESEARCH_FRAMING)).toBe(true);
    expect(written.classes).toEqual([]);
    expect(verifyResearchMemo(written, empty)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------
// The verifier
// ------------------------------------------------------------------------------------------------

function modelMemo(overrides: Partial<ResearchMemo> = {}): ResearchMemo {
  return {
    summary: `${RESEARCH_FRAMING} У нічній смузі переважають ударні БпЛА.`,
    classes: [
      { threatType: 'uav', band: 'спостерігається', rationale: 'Зараз у роботі, і смуга ними заповнена.' },
      { threatType: 'ballistic_missile', band: 'типово для цього вікна', rationale: 'Вісім повідомлень у смузі.' }
    ],
    watchIndicators: ['mass_launch'],
    caveats: ['Це операторський матеріал.'],
    ...overrides
  };
}

describe('verifyResearchMemo', () => {
  it('accepts a reply that stays inside the pack', () => {
    expect(verifyResearchMemo(modelMemo(), PACK)).toBeNull();
  });

  it('refuses a number the pack does not support', () => {
    expect(verifyResearchMemo(modelMemo({
      summary: 'За ніч 137 повідомлень про БпЛА.'
    }), PACK)).toBe('ungrounded_number:137');
  });

  it('refuses a threat class the archive never filed here', () => {
    expect(verifyResearchMemo(modelMemo({
      classes: [{ threatType: 'naval_drone', band: 'спостерігається', rationale: 'Щось про море.' }]
    }), PACK)).toBe('unknown_class:naval_drone');
  });

  it('refuses a band moved by one rung, which is the whole point of the enum', () => {
    expect(verifyResearchMemo(modelMemo({
      classes: [{
        threatType: 'ballistic_missile', band: 'спостерігається',
        rationale: 'Підняли на щабель вище, ніж дала арифметика.'
      }]
    }), PACK)).toBe('band_mismatch:ballistic_missile');
  });

  it('refuses an indicator that is not verbatim from the pack', () => {
    expect(verifyResearchMemo(modelMemo({
      watchIndicators: ['mass_launch', 'нічний виліт носіїв']
    }), PACK)).toBe('unknown_indicator:нічний виліт носіїв');
  });

  it('refuses a forecast however grounded its numbers are', () => {
    expect(verifyResearchMemo(modelMemo({
      caveats: ['Найближчої ночі очікується активність ударних БпЛА.']
    }), PACK)).toBe('forecast_lexeme:очікуєть');
  });

  /**
   * The framing sentence contains the word «прогноз» — as a denial — and the guard is a closed list
   * of stems that cannot read a denial. So the constant is exempt, and this pins the exemption to
   * the exact string rather than to the word: a memo that reasons about a forecast in its own words
   * is still refused, and a memo that merely repeats our sentence is not.
   */
  it('exempts the framing sentence itself and nothing that resembles it', () => {
    expect(verifyResearchMemo(modelMemo({
      summary: `${RESEARCH_FRAMING} ${RESEARCH_FRAMING} У смузі переважають ударні БпЛА.`
    }), PACK)).toBeNull();

    expect(verifyResearchMemo(modelMemo({
      summary: 'Це майже прогноз, але не зовсім.'
    }), PACK)).toBe('forecast_lexeme:прогноз');

    expect(verifyResearchMemo(modelMemo({
      caveats: ['Прогнозована активність по області.']
    }), PACK)).toBe('forecast_lexeme:прогноз');
  });

  it('reads every field, including the one a hurried verifier would forget', () => {
    // The caveats array is last in the memo and first to be skipped by a verifier written in a hurry.
    expect(verifyResearchMemo(modelMemo({ caveats: ['Було 137 пусків.'] }), PACK))
      .toBe('ungrounded_number:137');
    expect(verifyResearchMemo(modelMemo({ watchIndicators: ['mass_launch', '999'] }), PACK))
      .toBe('ungrounded_number:999');
  });
});

describe('withResearchMarker', () => {
  it('adds the disclosure after validation, and only once', () => {
    const once = withResearchMarker(['Перше застереження.']);
    expect(once).toHaveLength(2);
    expect(once.at(-1)).toContain('мовна модель');
    expect(withResearchMarker(once)).toEqual(once);
  });
});

// ------------------------------------------------------------------------------------------------
// Governance
// ------------------------------------------------------------------------------------------------

describe('researchRefusal', () => {
  const base = {
    featureEnabled: true, usedToday: 0, perDay: 20,
    lastRequestAt: null, cooldownSeconds: 120, now: NOW
  };

  it('lets an ordinary request through', () => {
    expect(researchRefusal(base)).toBeNull();
  });

  it('refuses on the switch before it mentions any quota', () => {
    const refusal = researchRefusal({ ...base, featureEnabled: false, usedToday: 99, perDay: 20 })!;
    expect(refusal.status).toBe('refused_disabled');
    expect(refusal.retryAfterSeconds).toBeNull();
  });

  it('refuses on the daily cap before the cooldown, because waiting will not help', () => {
    const refusal = researchRefusal({
      ...base, usedToday: 20, perDay: 20, lastRequestAt: new Date(NOW.getTime() - 1000)
    })!;
    expect(refusal.status).toBe('refused_daily_cap');
    expect(refusal.retryAfterSeconds).toBeNull();
  });

  it('treats a cap of zero as a closed surface', () => {
    expect(researchRefusal({ ...base, perDay: 0 })!.status).toBe('refused_daily_cap');
  });

  it('counts the cooldown down in whole seconds and never to zero', () => {
    const refusal = researchRefusal({
      ...base, lastRequestAt: new Date(NOW.getTime() - 90_000)
    })!;
    expect(refusal.status).toBe('refused_cooldown');
    expect(refusal.retryAfterSeconds).toBe(30);

    // One millisecond short of the full cooldown is still inside it, and rounds up to a second.
    const almost = researchRefusal({
      ...base, lastRequestAt: new Date(NOW.getTime() - 119_999)
    })!;
    expect(almost.retryAfterSeconds).toBe(1);
  });

  it('lets the request through at exactly the cooldown, so a minimum gap is a minimum', () => {
    expect(researchRefusal({ ...base, lastRequestAt: new Date(NOW.getTime() - 120_000) })).toBeNull();
  });

  it('disables the cooldown at zero without disabling the daily cap', () => {
    expect(researchRefusal({
      ...base, cooldownSeconds: 0, lastRequestAt: new Date(NOW.getTime() - 1)
    })).toBeNull();
    expect(researchRefusal({
      ...base, cooldownSeconds: 0, usedToday: 20, lastRequestAt: new Date(NOW.getTime() - 1)
    })!.status).toBe('refused_daily_cap');
  });
});

// ------------------------------------------------------------------------------------------------
// The one claim the whole surface rests on
// ------------------------------------------------------------------------------------------------

describe('the memo is never a forecast', () => {
  it('has no band phrase that a forecast lexeme would recognise', () => {
    for (const band of RESEARCH_BANDS) {
      expect(firstForecastLexeme([band]), `the band «${band}» reads as a forecast`).toBeNull();
    }
  });

  it('has no band phrase in the future tense, checked as a closed list', () => {
    // Four phrases, no fifth. A phrase added without this test being edited is the failure mode.
    expect(RESEARCH_BANDS).toEqual([
      'спостерігається',
      'типово для цього вікна',
      'нетипово, але траплялося',
      'у цьому вікні не фіксували'
    ]);
  });

  it('keeps the pack itself free of any probability wording', () => {
    const pack: ResearchPack = PACK;
    const serialised = JSON.stringify(pack);
    for (const forbidden of ['ймовірн', 'прогноз', 'очікув']) {
      expect(serialised, `the pack contained «${forbidden}»`).not.toContain(forbidden);
    }
  });
});
