import { describe, expect, it } from 'vitest';
import {
  MIN_SAMPLE_SIZE,
  NEUTRAL_TRUST,
  TRUST_MODIFIER_CEILING,
  TRUST_MODIFIER_FLOOR,
  computeTrust,
  countFirstReports,
  decayWeight,
  trustLabel,
  trustModifier,
  weightedShare,
  type ReportObservation,
  type TrustInput
} from './source-trust.js';
import { clampAssessment, effectiveContribution, type ModelAssessment, type RiskSignalRow } from './risk.js';

/**
 * A source with an unremarkable month and enough of it to be scored. Every test below moves exactly
 * one field, so a failure names the metric rather than the fixture.
 */
function input(overrides: Partial<TrustInput> = {}): TrustInput {
  return {
    official: false,
    tier: 'B',
    withdrawnShare: 0.1,
    corroboratedShare: 0.5,
    firstReports: 10,
    lagMedianSeconds: 300,
    unreadableShare: 0.1,
    sampleSize: 40,
    ...overrides
  };
}

describe('trust formula', () => {
  it('is monotone in every metric', () => {
    const base = computeTrust(input()).trust;

    // Більше відкликань — нижча довіра.
    expect(computeTrust(input({ withdrawnShare: 0.4 })).trust).toBeLessThan(base);
    expect(computeTrust(input({ withdrawnShare: 0 })).trust).toBeGreaterThan(base);

    // Більше підтверджень незалежними групами — вища довіра.
    expect(computeTrust(input({ corroboratedShare: 0.9 })).trust).toBeGreaterThan(base);
    expect(computeTrust(input({ corroboratedShare: 0.1 })).trust).toBeLessThan(base);

    // Більше першостей — вища довіра.
    expect(computeTrust(input({ firstReports: 30 })).trust).toBeGreaterThan(base);
    expect(computeTrust(input({ firstReports: 0 })).trust).toBeLessThan(base);

    // Швидша першість (менший лаг) — вища довіра.
    expect(computeTrust(input({ lagMedianSeconds: 60 })).trust).toBeGreaterThan(base);
    expect(computeTrust(input({ lagMedianSeconds: 800 })).trust).toBeLessThan(base);

    // Більше нечитабельних повідомлень — нижча довіра.
    expect(computeTrust(input({ unreadableShare: 0.6 })).trust).toBeLessThan(base);
    expect(computeTrust(input({ unreadableShare: 0 })).trust).toBeGreaterThan(base);
  });

  it('keeps the score inside 0..1 at both extremes', () => {
    const worst = computeTrust(input({
      withdrawnShare: 1, corroboratedShare: 0, firstReports: 0, lagMedianSeconds: 100_000, unreadableShare: 1
    }));
    const best = computeTrust(input({
      withdrawnShare: 0, corroboratedShare: 1, firstReports: 40, lagMedianSeconds: 0, unreadableShare: 0
    }));
    expect(worst.trust).toBeGreaterThanOrEqual(0);
    expect(best.trust).toBeLessThanOrEqual(1);
    expect(best.trust).toBeGreaterThan(worst.trust);
  });

  it('scores a source that never followed anyone as neutral on speed rather than as perfect', () => {
    const neverFollowed = computeTrust(input({ lagMedianSeconds: null })).trust;
    expect(neverFollowed).toBeLessThan(computeTrust(input({ lagMedianSeconds: 0 })).trust);
    expect(neverFollowed).toBeGreaterThan(computeTrust(input({ lagMedianSeconds: 900 })).trust);
  });
});

describe('neutral start', () => {
  it('leaves a source with too few observations at exactly neutral', () => {
    const result = computeTrust(input({ sampleSize: MIN_SAMPLE_SIZE - 1, withdrawnShare: 1, unreadableShare: 1 }));
    expect(result.trust).toBe(NEUTRAL_TRUST);
    expect(result.neutral).toBe(true);
    expect(result.neutralReason).toContain(String(MIN_SAMPLE_SIZE));
  });

  it('names the window the run actually used, not the default one', () => {
    const short = computeTrust(input({ sampleSize: 2, windowDays: 7 }));
    expect(short.neutralReason).toContain('за 7 днів');
    expect(computeTrust(input({ sampleSize: 2 })).neutralReason).toContain('за 30 днів');
  });

  it('still records the metrics it could not score, so the console can show why', () => {
    const result = computeTrust(input({ sampleSize: 3, firstReports: 2 }));
    expect(result.components.sampleSize).toBe(3);
    expect(result.components.firstReports).toBe(2);
  });

  it('starts scoring once the window holds enough of the source', () => {
    const result = computeTrust(input({ sampleSize: MIN_SAMPLE_SIZE, withdrawnShare: 1, corroboratedShare: 0, firstReports: 0, unreadableShare: 1, lagMedianSeconds: 900 }));
    expect(result.neutral).toBe(false);
    expect(result.trust).toBeLessThan(NEUTRAL_TRUST);
  });
});

// ------------------------------------------------------------------------------------------------
// Guardrail (a): trust does not change tier, and cannot make a C behave like an A
// ------------------------------------------------------------------------------------------------

const candidate: ModelAssessment = {
  locationId: 'ua-80', threatType: 'uav', horizonHours: 6, score: 9,
  confidence: 'high', supportingSignalIds: ['one'],
  raisingFactors: ['signal'], limitingFactors: [], summary: 'summary'
};

function signal(overrides: Partial<RiskSignalRow> = {}): RiskSignalRow {
  return {
    id: 'one', signal_type: 'reported_direction', source_tier: 'C',
    independence_group: 'same', reliability: 1, freshness: 1,
    geographic_relevance: 1, contribution: 3, observed_at: new Date(), ...overrides
  };
}

describe('guardrail (a): trust never moves a source between tiers', () => {
  it('does not report a tier of its own and cannot be read as one', () => {
    const result = computeTrust(input({ tier: 'C', withdrawnShare: 0, corroboratedShare: 1, firstReports: 40, lagMedianSeconds: 0, unreadableShare: 0 }));
    expect(result.trust).toBeGreaterThan(0.9);
    // Рівень джерела лишається в каталозі: у результаті обчислення його просто немає.
    expect(Object.keys(result)).not.toContain('tier');
    expect(Object.keys(result.components)).not.toContain('tier');
  });

  it('still caps an all-C location at 3.9 when every source is maximally trusted', () => {
    const now = Date.now();
    const trusted = [
      { ...signal({ id: 'one', independence_group: 'a', source_trust: 1 }), effective_contribution: 0 },
      { ...signal({ id: 'two', independence_group: 'b', source_trust: 1 }), effective_contribution: 0 }
    ].map((row) => ({ ...row, effective_contribution: effectiveContribution(row, now) }));

    // Довіра підняла внески — але стеля рівня C застосовується після неї й лишається тією самою.
    expect(trusted[0]!.effective_contribution).toBeGreaterThan(3);
    const result = clampAssessment({ ...candidate, supportingSignalIds: ['one', 'two'] }, trusted, 'ua-80', 'uav');
    expect(result.score).toBe(3.9);
    expect(result.confidence).toBe('low');
    // Формулювання застереження належить risk.ts і писане для читача, а не для тесту; звідси
    // перевірка по суті фрази — «допоміжні канали» — а не по технічній назві рівня.
    expect(result.limitingFactors.join(' ')).toContain('з допоміжних каналів');
  });

  it('does not let trust lift a location past the missing-tier-A cap either', () => {
    const now = Date.now();
    const signals = [
      signal({ id: 'one', source_tier: 'B', independence_group: 'a', source_trust: 1 }),
      signal({ id: 'two', source_tier: 'B', independence_group: 'b', source_trust: 1 })
    ].map((row) => ({ ...row, effective_contribution: effectiveContribution(row, now) }));
    const result = clampAssessment({ ...candidate, supportingSignalIds: ['one', 'two'] }, signals, 'ua-53', 'ballistic_missile');
    expect(result.score).toBe(5.9);
  });
});

// ------------------------------------------------------------------------------------------------
// Guardrail (b): official sources are never pushed below neutral
// ------------------------------------------------------------------------------------------------

describe('guardrail (b): official sources keep the neutral floor', () => {
  const terrible = { withdrawnShare: 1, corroboratedShare: 0, firstReports: 0, lagMedianSeconds: 900, unreadableShare: 1 };

  it('floors an official source at neutral however bad the window was', () => {
    const result = computeTrust(input({ official: true, ...terrible }));
    expect(result.trust).toBe(NEUTRAL_TRUST);
    expect(result.officialFloorApplied).toBe(true);
    expect(result.neutral).toBe(false);
  });

  it('does not floor an unofficial source with the same numbers', () => {
    const result = computeTrust(input({ official: false, ...terrible }));
    expect(result.trust).toBeLessThan(NEUTRAL_TRUST);
    expect(result.officialFloorApplied).toBe(false);
  });

  it('does not cap an official source that earned more than neutral', () => {
    const good = input({ official: true, withdrawnShare: 0, corroboratedShare: 1, firstReports: 40, lagMedianSeconds: 30, unreadableShare: 0 });
    const result = computeTrust(good);
    expect(result.trust).toBeGreaterThan(NEUTRAL_TRUST);
    expect(result.officialFloorApplied).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------
// Guardrail (c): a repost is not a first report
// ------------------------------------------------------------------------------------------------

describe('guardrail (c): reposts earn no firstness', () => {
  const minute = 60_000;
  const origin: ReportObservation = {
    eventId: 'e1', sourceId: 'air-force', independenceGroup: 'air-force', publishedAtMs: 0
  };
  // Каталог свідомо дає агрегатору репостів ту саму групу незалежності, що й каналу, який він копіює
  // (див. `osint-vanek-nikolaev` / `air-force` у migrations/011).
  const aggregator: ReportObservation = {
    eventId: 'e1', sourceId: 'osint-vanek-nikolaev', independenceGroup: 'air-force', publishedAtMs: minute
  };

  it('credits the channel that spoke first, not the one that copied it', () => {
    const counts = countFirstReports([aggregator, origin]);
    expect(counts.get('air-force')).toBe(1);
    expect(counts.get('osint-vanek-nikolaev')).toBeUndefined();
  });

  it('does not let a repost beat a genuinely independent channel that was later', () => {
    const independent: ReportObservation = {
      eventId: 'e1', sourceId: 'osint-monitor', independenceGroup: 'osint-monitor', publishedAtMs: 2 * minute
    };
    const counts = countFirstReports([origin, aggregator, independent]);
    expect(counts.get('air-force')).toBe(1);
    expect(counts.size).toBe(1);
  });

  it('does credit the aggregator for an event nobody in its group had reported', () => {
    const own: ReportObservation = {
      eventId: 'e2', sourceId: 'osint-vanek-nikolaev', independenceGroup: 'air-force', publishedAtMs: 5 * minute
    };
    const counts = countFirstReports([origin, aggregator, own]);
    expect(counts.get('osint-vanek-nikolaev')).toBe(1);
  });

  it('breaks an exact tie deterministically rather than on row order', () => {
    const a: ReportObservation = { eventId: 'e3', sourceId: 'aaa', independenceGroup: 'ga', publishedAtMs: 10 };
    const b: ReportObservation = { eventId: 'e3', sourceId: 'bbb', independenceGroup: 'gb', publishedAtMs: 10 };
    expect(countFirstReports([a, b]).get('aaa')).toBe(1);
    expect(countFirstReports([b, a]).get('aaa')).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------
// Guardrail (d): old observations weigh less
// ------------------------------------------------------------------------------------------------

describe('guardrail (d): decay', () => {
  it('halves the weight of an observation every half-life and never exceeds one', () => {
    expect(decayWeight(0)).toBeCloseTo(1, 6);
    expect(decayWeight(10)).toBeCloseTo(0.5, 6);
    expect(decayWeight(20)).toBeCloseTo(0.25, 6);
    expect(decayWeight(30)).toBeLessThan(decayWeight(20));
    // Годинник, що пішов уперед, не має робити спостереження вагомішим за свіже.
    expect(decayWeight(-5)).toBe(1);
  });

  it('lets a recent retraction outweigh an old one', () => {
    const recentBad = weightedShare([{ hit: true, ageDays: 1 }, { hit: false, ageDays: 25 }]);
    const oldBad = weightedShare([{ hit: false, ageDays: 1 }, { hit: true, ageDays: 25 }]);
    expect(recentBad).toBeGreaterThan(0.5);
    expect(oldBad).toBeLessThan(0.5);
    expect(recentBad).toBeGreaterThan(oldBad);
  });

  it('turns that into a lower trust for the source whose failures are recent', () => {
    const recent = computeTrust(input({ withdrawnShare: weightedShare([{ hit: true, ageDays: 1 }, { hit: false, ageDays: 25 }]) }));
    const stale = computeTrust(input({ withdrawnShare: weightedShare([{ hit: false, ageDays: 1 }, { hit: true, ageDays: 25 }]) }));
    expect(recent.trust).toBeLessThan(stale.trust);
  });

  it('reports zero share for a source with no observations at all', () => {
    expect(weightedShare([])).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------
// The modifier the risk engine applies
// ------------------------------------------------------------------------------------------------

describe('trust modifier', () => {
  it('is exactly 1.0 when there is no measurement', () => {
    expect(trustModifier(null)).toBe(1);
    expect(trustModifier(undefined)).toBe(1);
    expect(trustModifier(Number.NaN)).toBe(1);
  });

  it('is exactly 1.0 at the neutral value, so crossing the sample threshold is not a step', () => {
    expect(trustModifier(NEUTRAL_TRUST)).toBe(1);
  });

  it('never leaves the 0.6 floor and 1.2 ceiling', () => {
    expect(trustModifier(0)).toBe(TRUST_MODIFIER_FLOOR);
    expect(trustModifier(1)).toBe(TRUST_MODIFIER_CEILING);
    for (const trust of [0, 0.05, 0.2, 0.4, 0.5, 0.6, 0.8, 0.95, 1]) {
      const modifier = trustModifier(trust);
      expect(modifier).toBeGreaterThanOrEqual(TRUST_MODIFIER_FLOOR);
      expect(modifier).toBeLessThanOrEqual(TRUST_MODIFIER_CEILING);
    }
    // Значення поза шкалою — це зіпсований рядок, а не привід вийти за межі.
    expect(trustModifier(-3)).toBe(TRUST_MODIFIER_FLOOR);
    expect(trustModifier(42)).toBe(TRUST_MODIFIER_CEILING);
  });

  it('rises with trust', () => {
    expect(trustModifier(0.2)).toBeLessThan(trustModifier(0.5));
    expect(trustModifier(0.5)).toBeLessThan(trustModifier(0.8));
  });
});

describe('trust in the risk engine', () => {
  const now = Date.now();
  const contribution = (trust: number | null) => effectiveContribution(
    signal({ contribution: 2, reliability: 1, source_trust: trust, observed_at: new Date(now) }), now
  );

  it('leaves the contribution untouched when the source has no trust row', () => {
    expect(contribution(null)).toBeCloseTo(2, 6);
  });

  it('discounts a distrusted source without silencing it', () => {
    expect(contribution(0)).toBeCloseTo(2 * TRUST_MODIFIER_FLOOR, 6);
    expect(contribution(0)).toBeGreaterThan(0);
  });

  it('raises a trusted source by no more than a fifth', () => {
    expect(contribution(1)).toBeCloseTo(2 * TRUST_MODIFIER_CEILING, 6);
  });
});

describe('trust label', () => {
  it('says nothing at all when there is no measurement', () => {
    expect(trustLabel(null)).toBeNull();
    expect(trustLabel(undefined)).toBeNull();
  });

  it('turns a number into one of three words', () => {
    expect(trustLabel(0.9)).toBe('висока');
    expect(trustLabel(0.5)).toBe('звичайна');
    expect(trustLabel(0.2)).toBe('знижена');
  });
});
