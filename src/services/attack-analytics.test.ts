import { describe, expect, it } from 'vitest';
import {
  clusterWaves,
  composeAttackAnalytics,
  deltaPercent,
  describeAttacks,
  median,
  nightShare,
  peakHour,
  plural,
  repeatedCombinations,
  resolveAttackWindow,
  trendOf,
  WAVE_GAP_MINUTES,
  type AttackWave,
  type DimensionRow,
  type TimelinePoint
} from './attack-analytics.js';

/**
 * Everything between the database and the response, on fixtures.
 *
 * The two SQL statements are proven by the integration suite against a real archive; what needs a
 * fixture is the judgement layered on top of them — where one wave ends and the next begins, what
 * counts as a repeating combination, and what the deterministic conclusion is allowed to claim. All
 * of it is pure, so none of it needs Postgres.
 */

const BUCKET = 5;

/** Builds the spine row plus its per-class rows for one bucket. */
function point(minutesFromStart: number, messages: number, types: Record<string, number> = {}): TimelinePoint[] {
  const at = new Date(Date.UTC(2026, 1, 10, 20, 0, 0) + minutesFromStart * 60_000).toISOString();
  return [
    { at, threatType: null, messages, eventsRaised: 1 },
    ...Object.entries(types).map(([threatType, count]) => ({ at, threatType, messages: count, eventsRaised: 0 }))
  ];
}

describe('resolveAttackWindow', () => {
  it('places the comparison window immediately before the requested one', () => {
    const now = new Date('2026-02-10T12:00:00.000Z');
    const week = resolveAttackWindow('week', now);
    expect(week.from.toISOString()).toBe('2026-02-03T12:00:00.000Z');
    expect(week.previousFrom.toISOString()).toBe('2026-01-27T12:00:00.000Z');
    // The halves must abut exactly, or the "проти попереднього періоду" comparison is between two
    // spans of different length and every trend on the page is arithmetic nonsense.
    expect(week.to.getTime() - week.from.getTime()).toBe(week.from.getTime() - week.previousFrom.getTime());
  });

  it('gives a longer period a coarser timeline so the payload stays bounded', () => {
    expect(resolveAttackWindow('day').bucketMinutes).toBe(5);
    expect(resolveAttackWindow('month').bucketMinutes).toBe(30);
  });
});

describe('trendOf', () => {
  it('ignores drift smaller than the dead band', () => {
    expect(trendOf(104, 100)).toBe('steady');
    expect(trendOf(90, 100)).toBe('steady');
  });

  it('names a real move', () => {
    expect(trendOf(140, 100)).toBe('rising');
    expect(trendOf(60, 100)).toBe('falling');
  });

  it('distinguishes an appearance and a disappearance from a change', () => {
    expect(trendOf(5, 0)).toBe('new');
    expect(trendOf(0, 5)).toBe('gone');
    expect(trendOf(0, 0)).toBe('steady');
  });

  it('reports no percentage when there is no baseline to divide by', () => {
    expect(deltaPercent(5, 0)).toBeNull();
    expect(deltaPercent(150, 100)).toBe(50);
  });
});

describe('clusterWaves', () => {
  it('splits on a quiet gap longer than the threshold and joins across a shorter one', () => {
    const timeline = [
      ...point(0, 4, { uav: 4 }),
      ...point(20, 3, { uav: 3 }),
      // 90 minutes of silence exactly — still one wave, the gap has to *exceed* the threshold.
      ...point(115, 2, { uav: 2 }),
      // Now a gap of 120 minutes: a new wave.
      ...point(240, 5, { ballistic_missile: 5 })
    ];
    const waves = clusterWaves(timeline, { bucketMinutes: BUCKET, gapMinutes: WAVE_GAP_MINUTES });
    expect(waves).toHaveLength(2);
    expect(waves[0]!.messages).toBe(9);
    expect(waves[0]!.durationMinutes).toBe(120);
    expect(waves[1]!.messages).toBe(5);
  });

  it('counts a message once towards the size and once per class towards the composition', () => {
    // Three messages, all combined reports naming drones and ballistic missiles.
    const waves = clusterWaves(point(0, 3, { uav: 3, ballistic_missile: 3 }), { bucketMinutes: BUCKET });
    expect(waves[0]!.messages).toBe(3);
    expect(waves[0]!.threatTypes.map((entry) => entry.threatType)).toEqual(['ballistic_missile', 'uav']);
    expect(waves[0]!.threatTypes.every((entry) => entry.messages === 3)).toBe(true);
  });

  it('does not call a single report a wave', () => {
    expect(clusterWaves(point(0, 1, { uav: 1 }), { bucketMinutes: BUCKET })).toEqual([]);
    expect(clusterWaves(point(0, 2, { uav: 2 }), { bucketMinutes: BUCKET })).toHaveLength(1);
  });

  it('gives the same answer for the same night at two timeline resolutions', () => {
    // The gap is measured from the end of a bucket, so a coarser bucket must not merge waves that a
    // finer one separates. Otherwise "скільки було хвиль" would depend on which tab is open.
    const fine = clusterWaves(
      [...point(0, 4, { uav: 4 }), ...point(200, 4, { uav: 4 })], { bucketMinutes: 5 }
    );
    const coarse = clusterWaves(
      [...point(0, 4, { uav: 4 }), ...point(200, 4, { uav: 4 })], { bucketMinutes: 30 }
    );
    expect(fine).toHaveLength(2);
    expect(coarse).toHaveLength(2);
  });

  it('measures the silence between the messages, not between the bucket edges', () => {
    // Regression. Two messages 100 minutes apart are two waves at any resolution. Off bucket starts
    // alone a 30-minute bucket subtracts its own width from the gap, reads it as 70 minutes and
    // merges the pair — which is how one night came out as three waves under «Доба» and two under
    // «Місяць» on the project's own archive.
    const exact = (minutesFromStart: number, messages: number): TimelinePoint[] => {
      const at = new Date(Date.UTC(2026, 1, 10, 20, 0, 0) + minutesFromStart * 60_000);
      return [{
        at: at.toISOString(), threatType: null, messages, eventsRaised: 1,
        firstAt: at.toISOString(), lastAt: at.toISOString()
      }, { at: at.toISOString(), threatType: 'uav', messages, eventsRaised: 0 }];
    };
    const night = [...exact(0, 4), ...exact(100, 4)];
    for (const bucketMinutes of [5, 15, 30]) {
      expect(clusterWaves(night, { bucketMinutes })).toHaveLength(2);
    }
    // And a silence shorter than the threshold still joins, at every resolution.
    const joined = [...exact(0, 4), ...exact(80, 4)];
    for (const bucketMinutes of [5, 15, 30]) {
      expect(clusterWaves(joined, { bucketMinutes })).toHaveLength(1);
    }
  });

  it('spans a wave from its first message to its last', () => {
    const at = (minutes: number) => new Date(Date.UTC(2026, 1, 10, 20, 0, 0) + minutes * 60_000).toISOString();
    const waves = clusterWaves([
      { at: at(0), threatType: null, messages: 3, eventsRaised: 1, firstAt: at(2), lastAt: at(4) },
      { at: at(30), threatType: null, messages: 3, eventsRaised: 1, firstAt: at(31), lastAt: at(47) }
    ], { bucketMinutes: 30 });
    expect(waves).toHaveLength(1);
    expect(waves[0]!.startedAt).toBe(at(2));
    expect(waves[0]!.endedAt).toBe(at(47));
    expect(waves[0]!.durationMinutes).toBe(45);
  });

  it('returns nothing for an empty window', () => {
    expect(clusterWaves([], { bucketMinutes: BUCKET })).toEqual([]);
  });
});

describe('repeatedCombinations', () => {
  const wave = (types: string[]): AttackWave => ({
    startedAt: '2026-02-10T20:00:00.000Z',
    endedAt: '2026-02-10T22:00:00.000Z',
    durationMinutes: 120,
    messages: 10,
    eventsRaised: 2,
    threatTypes: types.map((threatType) => ({ threatType, label: threatType, messages: 5 }))
  });

  it('reports a pair only once it has repeated', () => {
    const once = repeatedCombinations([wave(['uav', 'ballistic_missile'])]);
    expect(once).toEqual([]);
    const twice = repeatedCombinations([wave(['uav', 'ballistic_missile']), wave(['uav', 'ballistic_missile'])]);
    expect(twice[0]!.threatTypes).toEqual(['ballistic_missile', 'uav']);
    expect(twice[0]!.waves).toBe(2);
    expect(twice[0]!.share).toBe(1);
  });

  it('ignores the aggregate and the placeholder classes', () => {
    const waves = [wave(['uav', 'combined', 'unknown']), wave(['uav', 'combined', 'unknown'])];
    expect(repeatedCombinations(waves)).toEqual([]);
  });

  it('orders the busiest pair first', () => {
    const waves = [
      wave(['uav', 'ballistic_missile']),
      wave(['uav', 'ballistic_missile']),
      wave(['uav', 'cruise_missile']),
      wave(['uav', 'cruise_missile']),
      wave(['uav', 'ballistic_missile'])
    ];
    const pairs = repeatedCombinations(waves);
    expect(pairs[0]!.threatTypes).toEqual(['ballistic_missile', 'uav']);
    expect(pairs[0]!.waves).toBe(3);
    expect(pairs[1]!.waves).toBe(2);
  });
});

describe('hour statistics', () => {
  const hours = Array.from({ length: 24 }, (_unused, hour) => ({
    hour, messages: hour === 23 ? 40 : hour === 2 ? 30 : hour < 6 || hour >= 22 ? 5 : 1, eventsRaised: 0
  }));

  it('finds the busiest hour', () => {
    expect(peakHour(hours)!.hour).toBe(23);
  });

  it('breaks a tie towards the earlier hour', () => {
    expect(peakHour([
      { hour: 3, messages: 7, eventsRaised: 0 }, { hour: 21, messages: 7, eventsRaised: 0 }
    ])!.hour).toBe(3);
  });

  it('returns nothing when nothing was reported', () => {
    expect(peakHour(hours.map((row) => ({ ...row, messages: 0 })))).toBeNull();
  });

  it('measures the night window as 22:00–05:59', () => {
    expect(nightShare([
      { hour: 23, messages: 3, eventsRaised: 0 },
      { hour: 5, messages: 1, eventsRaised: 0 },
      { hour: 6, messages: 4, eventsRaised: 0 }
    ])).toBe(0.5);
  });

  it('has a median for an even and an odd count', () => {
    expect(median([10, 30, 20])).toBe(20);
    expect(median([10, 20, 30, 40])).toBe(25);
    expect(median([])).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------
// Composition and narrative
// ------------------------------------------------------------------------------------------------

const rows: DimensionRow[] = [
  { dimension: 'total', key: 'all', label: null, current_messages: 40, current_events: 12, previous_messages: 20, previous_events: 8 },
  { dimension: 'means', key: 'uav', label: null, current_messages: 30, current_events: 9, previous_messages: 18, previous_events: 7 },
  { dimension: 'means', key: 'ballistic_missile', label: null, current_messages: 10, current_events: 3, previous_messages: 2, previous_events: 1 },
  { dimension: 'oblast', key: 'ua-53', label: 'Полтавська область', current_messages: 25, current_events: 8, previous_messages: 5, previous_events: 2 },
  { dimension: 'oblast', key: 'ua-63', label: 'Харківська область', current_messages: 15, current_events: 4, previous_messages: 15, previous_events: 6 },
  { dimension: 'hour', key: '23', label: null, current_messages: 28, current_events: 8, previous_messages: 10, previous_events: 4 },
  { dimension: 'hour', key: '13', label: null, current_messages: 12, current_events: 4, previous_messages: 10, previous_events: 4 },
  { dimension: 'direction', key: 'курсом на Полтаву', label: null, current_messages: 6, current_events: 2, previous_messages: 1, previous_events: 0 },
  { dimension: 'direction', key: 'у напрямку Лубен', label: null, current_messages: 1, current_events: 0, previous_messages: 0, previous_events: 0 },
  { dimension: 'version', key: 'v1', label: null, current_messages: 40, current_events: 12, previous_messages: 20, previous_events: 8 }
];

const points: TimelinePoint[] = [
  ...point(0, 8, { uav: 8 }),
  ...point(25, 6, { uav: 4, ballistic_missile: 2 }),
  ...point(300, 5, { uav: 5 }),
  ...point(320, 4, { uav: 2, ballistic_missile: 2 })
];

const window = resolveAttackWindow('week', new Date('2026-02-11T12:00:00.000Z'));

describe('composeAttackAnalytics', () => {
  const analytics = composeAttackAnalytics(window, rows, points, new Date('2026-02-11T12:00:00.000Z'));

  it('shares are taken within the window and total one', () => {
    expect(analytics.means.map((row) => row.threatType)).toEqual(['uav', 'ballistic_missile']);
    expect(analytics.means.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 4);
    expect(analytics.means[0]!.share).toBe(0.75);
  });

  it('carries the trend of every dimension against the previous window', () => {
    expect(analytics.totals.trend).toBe('rising');
    expect(analytics.targets.find((row) => row.oblastId === 'ua-53')!.trend).toBe('rising');
    expect(analytics.targets.find((row) => row.oblastId === 'ua-63')!.trend).toBe('steady');
  });

  it('fills every hour of the clock, including the empty ones', () => {
    expect(analytics.hours).toHaveLength(24);
    expect(analytics.hours[23]).toEqual({ hour: 23, messages: 28, eventsRaised: 8 });
    expect(analytics.hours[4]).toEqual({ hour: 4, messages: 0, eventsRaised: 0 });
  });

  it('drops a direction quoted from a single message', () => {
    expect(analytics.directions.map((row) => row.direction)).toEqual(['курсом на Полтаву']);
  });

  it('clusters the timeline into waves and finds what repeats in them', () => {
    expect(analytics.waves).toHaveLength(2);
    expect(analytics.combinations[0]!.threatTypes).toEqual(['ballistic_missile', 'uav']);
    expect(analytics.combinations[0]!.waves).toBe(2);
  });
});

describe('describeAttacks', () => {
  const analytics = composeAttackAnalytics(window, rows, points, new Date('2026-02-11T12:00:00.000Z'));

  it('names the leading class, the peak hour, the waves and the shift', () => {
    const text = analytics.patterns.findings.join(' ');
    expect(text).toContain('ударні БпЛА');
    expect(text).toContain('23:00');
    expect(text).toContain('хвиль');
    expect(text).toContain('Полтавська область');
    expect(text).toContain('курсом на Полтаву');
  });

  it('always says the data is open-source, retrospective and counted in messages', () => {
    const caveats = analytics.patterns.caveats.join(' ');
    expect(caveats).toContain('відкритих джерел');
    expect(caveats).toContain('не прогнозує');
    expect(caveats).toContain('повідомлення, а не засіб ураження');
  });

  it('adds a version caveat only when the window mixes rule sets', () => {
    expect(analytics.patterns.caveats.some((line) => line.includes('версії правил'))).toBe(false);
    const mixed = composeAttackAnalytics(window, [
      ...rows,
      { dimension: 'version', key: 'v2', label: null, current_messages: 4, current_events: 1, previous_messages: 0, previous_events: 0 }
    ], points, new Date('2026-02-11T12:00:00.000Z'));
    expect(mixed.patterns.caveats.some((line) => line.includes('версії правил'))).toBe(true);
  });

  it('says plainly that a silent window is not a safe one', () => {
    const empty = composeAttackAnalytics(window, [], [], new Date('2026-02-11T12:00:00.000Z'));
    expect(empty.patterns.findings).toHaveLength(1);
    expect(empty.patterns.findings[0]).toContain('не означає, що нічого не відбувалося');
    expect(empty.patterns.caveats.length).toBeGreaterThanOrEqual(3);
  });

  it('never claims anything about the future', () => {
    const text = [analytics.patterns.headline, ...analytics.patterns.findings].join(' ').toLowerCase();
    for (const forbidden of ['прогноз', 'очікується', 'ймовірно буде', 'планує', 'наступн']) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe('describeAttacks headline', () => {
  it('states the comparison in words as well as numbers', () => {
    const patterns = describeAttacks({
      window: {
        period: 'day', from: '2026-02-10T12:00:00.000Z', to: '2026-02-11T12:00:00.000Z',
        previousFrom: '2026-02-09T12:00:00.000Z', bucketMinutes: 5, timezone: 'Europe/Kyiv'
      },
      totals: { messages: 4, eventsRaised: 2, previousMessages: 20, previousEventsRaised: 9, deltaPercent: -80, trend: 'falling' },
      means: [], targets: [], hours: [], directions: [], waves: [], combinations: [], classifierVersions: ['v1']
    });
    expect(patterns.headline).toContain('За добу');
    expect(patterns.headline).toContain('менше, ніж попереднього');
  });
});

describe('a window with nothing behind it', () => {
  // Regression, from the endpoint's own output against the project archive: the classifier had run
  // for a day and the previous day was empty, so the page announced «103 повідомлення про загрозу —
  // приблизно стільки ж, скільки попереднього періоду (0)». A page that says that has disproved
  // itself in its first sentence.
  const withoutBaseline = rows.map((row) => ({ ...row, previous_messages: 0, previous_events: 0 }));
  const analytics = composeAttackAnalytics(
    window, withoutBaseline, points, new Date('2026-02-11T12:00:00.000Z')
  );

  it('never calls an appearance from nothing a comparable quantity', () => {
    expect(analytics.totals.trend).toBe('new');
    expect(analytics.patterns.headline).not.toContain('приблизно стільки ж');
    expect(analytics.patterns.headline).toContain('порівняння тут не буде');
  });

  it('does not present the busiest oblast as a shift of focus', () => {
    const text = analytics.patterns.findings.join(' ');
    expect(text).not.toContain('зміщується');
    expect(text).toContain('Найчастіше в повідомленнях називали: Полтавська область');
  });

  it('still words an empty window against an empty one', () => {
    const empty = composeAttackAnalytics(window, [], [], new Date('2026-02-11T12:00:00.000Z'));
    expect(empty.patterns.headline).toContain('як і попереднього періоду, жодного');
  });

  it('reports a disappearance as a fall, not as a standstill', () => {
    const gone = describeAttacks({
      window: analytics.window,
      totals: { messages: 0, eventsRaised: 0, previousMessages: 30, previousEventsRaised: 9, deltaPercent: -100, trend: 'gone' },
      means: [], targets: [], hours: [], directions: [], waves: [], combinations: [], classifierVersions: ['v1']
    });
    expect(gone.headline).toContain('менше, ніж попереднього періоду (30)');
  });
});

describe('numeric agreement', () => {
  it('picks the form the numeral requires, including the teens exception', () => {
    expect(plural(1, 'хвиля', 'хвилі', 'хвиль')).toBe('хвиля');
    expect(plural(2, 'хвиля', 'хвилі', 'хвиль')).toBe('хвилі');
    expect(plural(5, 'хвиля', 'хвилі', 'хвиль')).toBe('хвиль');
    // 11–14 take the many form even though they end in 1–4, which is the rule a naive
    // `count === 1 ? … : …` gets wrong and the reason this function exists.
    expect(plural(11, 'хвиля', 'хвилі', 'хвиль')).toBe('хвиль');
    expect(plural(12, 'хвиля', 'хвилі', 'хвиль')).toBe('хвиль');
    expect(plural(21, 'хвиля', 'хвилі', 'хвиль')).toBe('хвиля');
    expect(plural(22, 'хвиля', 'хвилі', 'хвиль')).toBe('хвилі');
    expect(plural(0, 'хвиля', 'хвилі', 'хвиль')).toBe('хвиль');
  });

  it('agrees the noun with the count in the conclusion itself', () => {
    const twoWaves = composeAttackAnalytics(window, rows, points, new Date('2026-02-11T12:00:00.000Z'));
    expect(twoWaves.patterns.findings.join(' ')).toContain('у 2 хвилі');
    expect(twoWaves.patterns.headline).toContain('40 повідомлень');
    expect(twoWaves.patterns.headline).toContain('12 окремих подій');
  });
});

describe('the empty-window sentence', () => {
  // «За останню тиждень» is the mistake this asserts against: the adjective has to agree in gender
  // with the period noun, and the three periods do not share one.
  const phrases: Array<[Parameters<typeof resolveAttackWindow>[0], string]> = [
    ['day', 'За останню добу'], ['week', 'За останній тиждень'], ['month', 'За останній місяць']
  ];
  for (const [period, expected] of phrases) {
    it(`names the ${period} window in the right gender`, () => {
      const empty = composeAttackAnalytics(
        resolveAttackWindow(period, new Date('2026-02-11T12:00:00.000Z')), [], [],
        new Date('2026-02-11T12:00:00.000Z')
      );
      expect(empty.patterns.findings[0]).toContain(expected);
    });
  }
});
