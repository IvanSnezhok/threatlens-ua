import { describe, expect, it } from 'vitest';
import { firstForecastLexeme } from '../domain/forecast-guard.js';
import { groundedNumbers, ungroundedNumber } from './analytics-narrative.js';
import type { AttackWave } from './attack-analytics.js';
import {
  MIN_BASELINE_SUPPORT, TACTICS_BASELINE_DAYS, bandTotal, clockDistance, detectTactics,
  modalBandStart, nightShareOf, resolveTacticsWindows, tacticsDigest,
  type TacticsDetection, type TacticsSample
} from './attack-tactics.js';

/**
 * The engine, tested where it decides.
 *
 * Every case below is a threshold: one sample that is one step over it and one that is one step
 * under. That shape is deliberate — the thresholds are the only opinions this module holds, and a
 * test that fed it an obviously extreme fixture would pass whatever the numbers were changed to.
 *
 * The two properties that are NOT about a threshold are the ones the storage depends on: a sentence
 * may contain no number the detection does not carry (otherwise the model's grounding check is
 * checking against a text that is itself ungrounded), and the digest must ignore order while
 * noticing values (otherwise insert-on-change either never inserts or never stops inserting).
 */

const NOW = new Date('2026-03-01T12:00:00.000Z');

function sample(overrides: Partial<TacticsSample> = {}): TacticsSample {
  return {
    windows: resolveTacticsWindows(NOW),
    currentMessages: 100,
    baselineMessages: 1400,
    classifierVersions: ['v1'],
    classes: [],
    oblasts: [],
    hours: Array.from({ length: 24 }, (_unused, hour) => ({ hour, current: 0, baseline: 0 })),
    currentWaves: [],
    baselineWaves: [],
    corridors: [],
    ...overrides
  };
}

function hours(current: Partial<Record<number, number>>, baseline: Partial<Record<number, number>>) {
  return Array.from({ length: 24 }, (_unused, hour) => ({
    hour, current: current[hour] ?? 0, baseline: baseline[hour] ?? 0
  }));
}

function wave(durationMinutes: number, messages = 10): AttackWave {
  return {
    startedAt: '2026-02-20T20:00:00.000Z',
    endedAt: '2026-02-20T21:00:00.000Z',
    durationMinutes,
    messages,
    eventsRaised: 1,
    threatTypes: []
  };
}

const typesOf = (detections: TacticsDetection[]) => detections.map((row) => row.detectionType);

// ------------------------------------------------------------------------------------------------
// Windows
// ------------------------------------------------------------------------------------------------

describe('tactics windows', () => {
  it('puts a whole fortnight behind a day, with no overlap between them', () => {
    const windows = resolveTacticsWindows(NOW);
    expect(windows.currentTo.toISOString()).toBe('2026-03-01T12:00:00.000Z');
    expect(windows.currentFrom.toISOString()).toBe('2026-02-28T12:00:00.000Z');
    expect(windows.baselineTo.toISOString()).toBe(windows.currentFrom.toISOString());
    expect(windows.baselineFrom.toISOString()).toBe('2026-02-14T12:00:00.000Z');
    const days = (windows.baselineTo.getTime() - windows.baselineFrom.getTime()) / 86_400_000;
    expect(days).toBe(TACTICS_BASELINE_DAYS);
  });
});

// ------------------------------------------------------------------------------------------------
// The seven detections, each at its edge
// ------------------------------------------------------------------------------------------------

describe('weapon_mix_shift', () => {
  it('fires exactly at a fifteen-point move and not a step under it', () => {
    const over = detectTactics(sample({
      classes: [
        { threatType: 'uav', label: 'ударні БпЛА', current: 50, baseline: 350 },
        { threatType: 'cruise_missile', label: 'крилаті ракети', current: 50, baseline: 650 }
      ]
    }));
    expect(typesOf(over)).toContain('weapon_mix_shift');
    const shift = over.find((row) => row.subjectKey === 'uav')!;
    expect([shift.currentValue, shift.baselineValue, shift.effect]).toEqual([0.5, 0.35, 0.15]);

    const under = detectTactics(sample({
      classes: [
        { threatType: 'uav', label: 'ударні БпЛА', current: 49, baseline: 350 },
        { threatType: 'cruise_missile', label: 'крилаті ракети', current: 51, baseline: 650 }
      ]
    }));
    expect(under.filter((row) => row.subjectKey === 'uav')).toEqual([]);
  });

  it('ignores a class with too little current support to be a share of anything', () => {
    const found = detectTactics(sample({
      classes: [
        { threatType: 'mortar', label: 'міномети', current: 4, baseline: 1 },
        { threatType: 'uav', label: 'ударні БпЛА', current: 96, baseline: 999 }
      ]
    }));
    expect(found.filter((row) => row.subjectKey === 'mortar')).toEqual([]);
  });
});

describe('new_weapon_class', () => {
  it('needs five current messages and an empty baseline', () => {
    const fires = detectTactics(sample({
      classes: [{ threatType: 'ballistic_missile', label: 'балістика', current: 5, baseline: 0 }]
    }));
    expect(typesOf(fires)).toEqual(['new_weapon_class']);

    const quiet = detectTactics(sample({
      classes: [{ threatType: 'ballistic_missile', label: 'балістика', current: 4, baseline: 0 }]
    }));
    expect(quiet).toEqual([]);

    const seenBefore = detectTactics(sample({
      classes: [{ threatType: 'ballistic_missile', label: 'балістика', current: 9, baseline: 1 }]
    }));
    expect(typesOf(seenBefore)).not.toContain('new_weapon_class');
  });
});

describe('launch_hour_shift', () => {
  it('fires on a twenty-point night move', () => {
    const found = detectTactics(sample({
      hours: hours({ 23: 60, 12: 40 }, { 23: 400, 12: 600 })
    }));
    const night = found.find((row) => row.subjectKey === 'night')!;
    expect([night.currentValue, night.baselineValue, night.effect]).toEqual([0.6, 0.4, 0.2]);
  });

  it('does not fire a step under it', () => {
    const found = detectTactics(sample({
      hours: hours({ 23: 59, 12: 41 }, { 23: 400, 12: 600 })
    }));
    expect(found.filter((row) => row.subjectKey === 'night')).toEqual([]);
  });

  it('fires on a three-hour band shift that carries a quarter of the day', () => {
    const found = detectTactics(sample({
      hours: hours({ 22: 35, 23: 10, 8: 20, 14: 40 }, { 8: 500, 9: 400, 14: 100 })
    }));
    const band = found.find((row) => row.subjectKey === 'band')!;
    expect([band.evidence.baselineBandStartHour, band.evidence.currentBandStartHour]).toEqual([6, 21]);
    expect(band.evidence.shiftHours).toBe(9);
  });

  it('does not call a two-hour band move a shift', () => {
    const found = detectTactics(sample({
      hours: hours({ 8: 60, 14: 40 }, { 6: 500, 14: 300 })
    }));
    expect(found.filter((row) => row.subjectKey === 'band')).toEqual([]);
  });
});

describe('territory_expansion', () => {
  it('names a territory at three mentions and not at two', () => {
    const fires = detectTactics(sample({
      oblasts: [
        { oblastId: 'ua-51', oblastName: 'Одеська область', current: 3, baseline: 0 },
        { oblastId: 'ua-32', oblastName: 'Київська область', current: 40, baseline: 400 }
      ]
    }));
    expect(typesOf(fires)).toContain('territory_expansion');

    const quiet = detectTactics(sample({
      oblasts: [
        { oblastId: 'ua-51', oblastName: 'Одеська область', current: 2, baseline: 0 },
        { oblastId: 'ua-32', oblastName: 'Київська область', current: 40, baseline: 400 }
      ]
    }));
    expect(typesOf(quiet)).not.toContain('territory_expansion');
  });
});

describe('territory_concentration', () => {
  it('fires when the busiest territory gains twenty points of the total', () => {
    const found = detectTactics(sample({
      oblasts: [
        { oblastId: 'ua-53', oblastName: 'Полтавська область', current: 60, baseline: 400 },
        { oblastId: 'ua-32', oblastName: 'Київська область', current: 40, baseline: 600 }
      ]
    }));
    const row = found.find((entry) => entry.detectionType === 'territory_concentration')!;
    expect([row.subjectKey, row.currentValue, row.baselineValue, row.effect]).toEqual(
      ['ua-53', 0.6, 0.4, 0.2]
    );
  });

  it('stays quiet a step under the threshold', () => {
    const found = detectTactics(sample({
      oblasts: [
        { oblastId: 'ua-53', oblastName: 'Полтавська область', current: 59, baseline: 400 },
        { oblastId: 'ua-32', oblastName: 'Київська область', current: 41, baseline: 600 }
      ]
    }));
    expect(typesOf(found)).not.toContain('territory_concentration');
  });
});

describe('wave_cadence_change', () => {
  it('fires on a forty-percent move in the median wave, with three waves on each side', () => {
    const found = detectTactics(sample({
      currentWaves: [wave(140), wave(140), wave(140)],
      baselineWaves: [wave(100), wave(100), wave(100)]
    }));
    const row = found.find((entry) => entry.subjectKey === 'duration')!;
    expect([row.currentValue, row.baselineValue, row.unit]).toEqual([140, 100, 'minutes']);
  });

  it('refuses to compare medians with only two waves on one side', () => {
    const found = detectTactics(sample({
      currentWaves: [wave(200), wave(200)],
      baselineWaves: [wave(100), wave(100), wave(100)]
    }));
    expect(found.filter((row) => row.subjectKey === 'duration')).toEqual([]);
  });

  it('reports a whole extra wave a night on the count axis', () => {
    const found = detectTactics(sample({
      currentWaves: [wave(60), wave(60), wave(60)],
      baselineWaves: Array.from({ length: 28 }, () => wave(60))
    }));
    const row = found.find((entry) => entry.subjectKey === 'per_night')!;
    expect([row.currentValue, row.baselineValue, row.effect]).toEqual([3, 2, 1]);
  });
});

describe('redirect_corridor', () => {
  const corridor = (current: number, baseline: number) => ({
    fromOblastId: 'ua-53', fromOblastName: 'Полтавська область',
    toOblastId: 'ua-32', toOblastName: 'Київська область',
    current, baseline,
    directions: [{ text: 'курсом на Київщину', messages: 4 }]
  });

  it('needs three repetitions and a baseline rate no more than half of the current one', () => {
    const fires = detectTactics(sample({ corridors: [corridor(3, 21)] }));
    expect(typesOf(fires)).toContain('redirect_corridor');

    const tooRare = detectTactics(sample({ corridors: [corridor(2, 0)] }));
    expect(typesOf(tooRare)).not.toContain('redirect_corridor');

    // 22/14 = 1.57 a day against 3/2 = 1.5: an established corridor, not a new one.
    const established = detectTactics(sample({ corridors: [corridor(3, 22)] }));
    expect(typesOf(established)).not.toContain('redirect_corridor');
  });

  it('carries the verbatim formulations as evidence and never inside the sentence', () => {
    const found = detectTactics(sample({ corridors: [corridor(6, 0)] }));
    const row = found.find((entry) => entry.detectionType === 'redirect_corridor')!;
    expect(row.evidence.directions).toEqual([{ text: 'курсом на Київщину', messages: 4 }]);
    expect(row.sentence).not.toContain('курсом на');
  });
});

// ------------------------------------------------------------------------------------------------
// The baseline gate
// ------------------------------------------------------------------------------------------------

describe('a baseline too thin to compare against', () => {
  it('leaves only the detections that compare against nothing', () => {
    const thin = sample({
      baselineMessages: MIN_BASELINE_SUPPORT - 1,
      classes: [
        { threatType: 'ballistic_missile', label: 'балістика', current: 8, baseline: 0 },
        { threatType: 'uav', label: 'ударні БпЛА', current: 50, baseline: 5 }
      ],
      oblasts: [{ oblastId: 'ua-51', oblastName: 'Одеська область', current: 9, baseline: 0 }],
      hours: hours({ 23: 60, 12: 40 }, { 23: 4, 12: 6 })
    });
    expect(typesOf(detectTactics(thin))).toEqual(['new_weapon_class']);
    // The same sample with a baseline over the floor keeps everything it found.
    expect(typesOf(detectTactics({ ...thin, baselineMessages: MIN_BASELINE_SUPPORT })).length)
      .toBeGreaterThan(1);
  });
});

// ------------------------------------------------------------------------------------------------
// The two properties the storage and the model layer depend on
// ------------------------------------------------------------------------------------------------

const RICH = sample({
  classes: [
    { threatType: 'uav', label: 'ударні БпЛА', current: 50, baseline: 350 },
    { threatType: 'cruise_missile', label: 'крилаті ракети', current: 44, baseline: 650 },
    { threatType: 'ballistic_missile', label: 'балістика', current: 6, baseline: 0 }
  ],
  oblasts: [
    { oblastId: 'ua-53', oblastName: 'Полтавська область', current: 60, baseline: 400 },
    { oblastId: 'ua-32', oblastName: 'Київська область', current: 37, baseline: 600 },
    { oblastId: 'ua-51', oblastName: 'Одеська область', current: 3, baseline: 0 }
  ],
  hours: hours({ 23: 60, 12: 40 }, { 23: 400, 12: 600 }),
  currentWaves: [wave(140), wave(140), wave(140)],
  baselineWaves: Array.from({ length: 28 }, () => wave(100)),
  corridors: [{
    fromOblastId: 'ua-53', fromOblastName: 'Полтавська область',
    toOblastId: 'ua-32', toOblastName: 'Київська область',
    current: 5, baseline: 7,
    directions: [{ text: 'курсом на Київщину', messages: 3 }]
  }]
});

describe('the generated sentences', () => {
  const detections = detectTactics(RICH);

  it('covers all seven detection types in one sample', () => {
    expect([...new Set(typesOf(detections))].sort()).toEqual([
      'launch_hour_shift', 'new_weapon_class', 'redirect_corridor', 'territory_concentration',
      'territory_expansion', 'wave_cadence_change', 'weapon_mix_shift'
    ]);
  });

  it.each(detections.map((row) => [`${row.detectionType}/${row.subjectKey}`, row] as const))(
    '%s states no number it does not carry',
    (_label, row) => {
      expect(ungroundedNumber(row.sentence, groundedNumbers(row))).toBeNull();
    }
  );

  it.each(detections.map((row) => [`${row.detectionType}/${row.subjectKey}`, row] as const))(
    '%s is written in the past tense',
    (_label, row) => {
      expect(firstForecastLexeme([row.sentence, row.subjectLabel])).toBeNull();
    }
  );

  it('ranks by kind and hands out a dense rank', () => {
    expect(detections.map((row) => row.rank)).toEqual(detections.map((_row, index) => index + 1));
    expect(typesOf(detections)[0]).toBe('new_weapon_class');
  });
});

describe('the digest', () => {
  const detections = detectTactics(RICH);

  it('ignores the order of the findings', () => {
    const shuffled = [...detections].reverse().map((row, index) => ({ ...row, rank: index + 1 }));
    expect(tacticsDigest(shuffled)).toBe(tacticsDigest(detections));
  });

  it('notices a moved value', () => {
    const moved = detections.map((row, index) =>
      (index === 0 ? { ...row, currentValue: row.currentValue + 1 } : row));
    expect(tacticsDigest(moved)).not.toBe(tacticsDigest(detections));
  });

  it('notices a finding that appeared and one that went away', () => {
    expect(tacticsDigest(detections.slice(1))).not.toBe(tacticsDigest(detections));
    expect(tacticsDigest([])).not.toBe(tacticsDigest(detections));
  });

  it('does not notice a reworded sentence, which is derived from the values above it', () => {
    const reworded = detections.map((row) => ({ ...row, sentence: `${row.sentence} ` }));
    expect(tacticsDigest(reworded)).toBe(tacticsDigest(detections));
  });
});

// ------------------------------------------------------------------------------------------------
// The small pure helpers
// ------------------------------------------------------------------------------------------------

describe('hour arithmetic', () => {
  it('counts 22:00–05:59 as the night — eight hours of the twenty-four', () => {
    const counts = Array.from({ length: 24 }, (_unused, hour) => ({ hour, value: 1 }));
    expect(nightShareOf(counts)).toBe(0.3333);
    expect(nightShareOf([])).toBe(0);
  });

  it('picks the busiest fixed three-hour band, earliest on a tie', () => {
    expect(modalBandStart([{ hour: 4, value: 3 }, { hour: 13, value: 3 }])).toBe(3);
    expect(modalBandStart([{ hour: 22, value: 9 }])).toBe(21);
    expect(modalBandStart([])).toBeNull();
    expect(bandTotal([{ hour: 21, value: 2 }, { hour: 23, value: 5 }], 21)).toBe(7);
  });

  it('measures the clock the short way round', () => {
    expect([clockDistance(23, 2), clockDistance(2, 23), clockDistance(0, 12), clockDistance(6, 6)])
      .toEqual([3, 3, 12, 0]);
  });
});
