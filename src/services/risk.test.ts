import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * One group, one location, one signal — the smallest shape a pass can have.
 *
 * The budget assertion below is about how many times the pass reaches the network, so the database
 * it walks through on the way there is a dispatching fake rather than a container. Every branch
 * `runRiskAssessmentsPass` takes is represented: the group query, the location, the signals, the
 * absent previous assessment, and the transaction that publishes the new one.
 */
const db = vi.hoisted(() => ({
  statements: [] as string[],
  /** The published assessment the group already has, as `runRiskAssessmentsPass` would read it. */
  previous: [] as Array<Record<string, unknown>>
}));

vi.mock('../db/pool.js', () => {
  // Three signals rather than one: the pass writes their `risk_assessment_signals` rows in a single
  // batched statement, and a group of one cannot tell a batch from a loop.
  const signals = ['one', 'two', 'three'].map((id) => ({
    id, signal_type: 'explicit_threat', source_tier: 'A', independence_group: 'a',
    reliability: 1, freshness: 1, geographic_relevance: 1, contribution: 1.5,
    observed_at: new Date(), source_id: null, source_trust: null
  }));
  const answer = (text: string) => {
    db.statements.push(text);
    if (text.includes('FROM risk_signals rs')) return { rows: signals, rowCount: signals.length };
    if (text.includes('FROM risk_signals')) {
      return { rows: [{ location_id: 'ua-80', threat_type: 'uav', signal_ids: signals.map((s) => s.id) }], rowCount: 1 };
    }
    if (text.includes('FROM locations')) return { rows: [{ id: 'ua-80', name_uk: 'Київ' }], rowCount: 1 };
    if (text.includes('FROM risk_assessments WHERE location_id')) {
      return { rows: db.previous, rowCount: db.previous.length };
    }
    if (text.includes('INSERT INTO risk_assessments(')) return { rows: [{ id: 'assessment-1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return {
    pool: {
      query: async (text: string) => answer(text),
      connect: async () => ({ query: async (text: string) => answer(text), release: () => undefined })
    }
  };
});

import { config } from '../config.js';
import {
  clampAssessment, effectiveContribution, fallbackAssessment, resetRiskRunGuard,
  runRiskAssessmentsGuarded, signalTypeLabel, type ModelAssessment, type RiskSignalRow
} from './risk.js';

const candidate: ModelAssessment = {
  locationId: 'wrong', threatType: 'wrong', horizonHours: 6, score: 9,
  confidence: 'high', supportingSignalIds: ['one', 'invented'],
  raisingFactors: ['signal'], limitingFactors: [], summary: 'summary'
};

function signal(overrides: Partial<RiskSignalRow> = {}): RiskSignalRow {
  return {
    id: 'one', signal_type: 'reported_direction', source_tier: 'C',
    independence_group: 'same', reliability: 0.4, freshness: 1,
    geographic_relevance: 1, contribution: 2, observed_at: new Date(), ...overrides
  };
}

describe('risk guardrails', () => {
  it('caps a single C-tier source and forces low confidence', () => {
    const result = clampAssessment(candidate, [signal()], 'ua-80', 'uav');
    expect(result.score).toBe(3.9);
    expect(result.confidence).toBe('low');
    expect(result.locationId).toBe('ua-80');
    expect(result.threatType).toBe('uav');
    expect(result.supportingSignalIds).toEqual(['one']);
  });

  it('caps assessments without an A-tier source', () => {
    const result = clampAssessment(candidate, [
      signal({ source_tier: 'B', independence_group: 'a' }),
      signal({ id: 'two', source_tier: 'B', independence_group: 'b' })
    ], 'ua-53', 'ballistic_missile');
    expect(result.score).toBe(5.9);
    expect(result.confidence).toBe('medium');
  });

  it('decays older signals with a two-hour half life', () => {
    const now = Date.now();
    const current = effectiveContribution(signal({ reliability: 1, contribution: 2, observed_at: new Date(now) }), now);
    const old = effectiveContribution(signal({ reliability: 1, contribution: 2, observed_at: new Date(now - 2 * 3_600_000) }), now);
    expect(current).toBeCloseTo(2, 3);
    expect(old).toBeCloseTo(1, 3);
  });
});

const location = { id: 'ua-80', name_uk: 'Київ' };

describe('пояснення оцінки читається людиною', () => {
  it('перекладає технічні типи сигналу і лишає назви індикаторів як є', () => {
    expect(signalTypeLabel('child_location_signal')).toBe('сигнал із населеного пункту всередині території');
    expect(signalTypeLabel('зліт стратегічної авіації')).toBe('зліт стратегічної авіації');
  });

  it('не пропускає жодного технічного ідентифікатора у чинники й підсумок', () => {
    const result = fallbackAssessment(location, 'uav', [
      signal({ id: 'a', signal_type: 'child_location_signal', independence_group: 'one' }),
      signal({ id: 'b', signal_type: 'child_location_signal', independence_group: 'one' }),
      signal({ id: 'c', signal_type: 'explicit_threat', independence_group: 'two', source_tier: 'A', reliability: 1 })
    ]);
    const text = [result.summary, ...result.raisingFactors, ...result.limitingFactors].join(' ');
    expect(text).not.toMatch(/child_location_signal|explicit_threat|reported_direction/);
    expect(result.summary).toContain('Київ');
    expect(result.summary).toContain('ударних БпЛА');
  });

  it('групує однотипні повідомлення в один чинник із правильним відмінюванням', () => {
    const result = fallbackAssessment(location, 'uav', [
      signal({ id: 'a', signal_type: 'reported_direction' }),
      signal({ id: 'b', signal_type: 'reported_direction' }),
      signal({ id: 'c', signal_type: 'reported_direction' })
    ]);
    const grouped = result.raisingFactors.filter((factor) => factor.startsWith('Ціль рухається в цьому напрямку —'));
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toContain('3 повідомлення');
  });

  it('називає офіційне джерело і друге незалежне підтвердження окремими чинниками', () => {
    const result = fallbackAssessment(location, 'ballistic_missile', [
      signal({ id: 'a', source_tier: 'A', independence_group: 'one', reliability: 1 }),
      signal({ id: 'b', source_tier: 'B', independence_group: 'two', reliability: 0.75 })
    ]);
    expect(result.raisingFactors).toContain('Серед джерел є офіційне повідомлення.');
    expect(result.raisingFactors).toContain('Повідомлення надійшли щонайменше з двох незалежних груп джерел.');
    expect(result.confidence).toBe('medium');
  });

  it('кожен чинник — завершене речення в межах ліміту схеми', () => {
    const result = fallbackAssessment(location, 'uav', [signal()]);
    for (const factor of [...result.raisingFactors, ...result.limitingFactors]) {
      expect(factor).toMatch(/[.!?]$/);
      expect(factor.length).toBeLessThanOrEqual(240);
    }
  });

  it('обмеження індексу пояснює причину словами, а не кодом рівня', () => {
    const result = clampAssessment(candidate, [signal()], 'ua-80', 'uav');
    expect(result.limitingFactors.some((factor) => factor.includes('допоміжних каналів'))).toBe(true);
    expect(result.limitingFactors.join(' ')).not.toMatch(/tier|рівня C/i);
  });
});

// ------------------------------------------------------------------------------------------------
// The model budget one pass is given
// ------------------------------------------------------------------------------------------------

/** `src/config.ts` freezes nothing and every consumer reads the live object. */
function withAiConfigured<T>(body: () => Promise<T>): Promise<T> {
  const mutable = config as unknown as Record<string, unknown>;
  const saved = { AI_BASE_URL: mutable.AI_BASE_URL, AI_API_KEY: mutable.AI_API_KEY, AI_MODEL: mutable.AI_MODEL };
  Object.assign(mutable, {
    AI_BASE_URL: 'https://model.test/v1', AI_API_KEY: 'token', AI_MODEL: 'test-model'
  });
  return body().finally(() => Object.assign(mutable, saved));
}

describe('the model budget a risk pass is given', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetRiskRunGuard();
    db.statements = [];
    db.previous = [];
  });

  it('spends one model call per group when the pass is allowed to', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 });
    });

    const outcome = await withAiConfigured(() => runRiskAssessmentsGuarded());

    expect(calls).toBe(1);
    expect(outcome.skipped).toBe(false);
  });

  it('makes no model call at all when it is not, and still publishes an assessment', async () => {
    // The bound the event-driven recompute uses on its intermediate passes: the model is called once
    // per `(location_id, threat_type)` group and one nationwide message fans out to every oblast for
    // six hours, so a caller running up to once a minute has to be able to say "re-score everything,
    // but not with the model". Declining it is not a degradation — `fallbackAssessment` is the
    // deployed default wherever `AI_*` is unset, and the row it writes is a complete one.
    let calls = 0;
    vi.stubGlobal('fetch', async () => { calls += 1; return new Response('{}', { status: 200 }); });

    const outcome = await withAiConfigured(() => runRiskAssessmentsGuarded({ allowModel: false }));

    expect(calls).toBe(0);
    expect(outcome).toEqual({ published: 1, skipped: false });
    expect(db.statements.some((text) => text.includes('INSERT INTO risk_assessments('))).toBe(true);
  });

  it('defaults to allowing the model, so the fifteen-minute scheduler is unchanged', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 });
    });

    await withAiConfigured(() => runRiskAssessmentsGuarded({}));

    expect(calls).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------
// The round trips one pass costs the database
// ------------------------------------------------------------------------------------------------

const matching = (text: string) => (statement: string) => statement.includes(text);

/**
 * The published assessment the fake hands back, scored so it is indistinguishable from what this
 * pass computes: three signals worth 1.5 each, none of them decayed, so the index is 4.5 and the
 * level is `significant` for anything in [4, 6). Fresh, and inside the six hours it claims.
 */
const steadyPrevious = {
  id: 'previous-1', risk_score: '4.5', risk_level: 'significant',
  model_version: 'rule-fallback-v2', methodology_version: 'v2',
  live: true, within_own_horizon: true
};

describe('what a pass writes for one group', () => {
  afterEach(() => {
    resetRiskRunGuard();
    db.statements = [];
    db.previous = [];
  });

  it('links every contributing signal in one statement rather than one per signal', async () => {
    await runRiskAssessmentsGuarded({ allowModel: false });

    const linkWrites = db.statements.filter(matching('INSERT INTO risk_assessment_signals'));
    expect(linkWrites).toHaveLength(1);
    // The batch is a single `unnest` of parallel arrays — a `VALUES` list per signal would be the
    // same round trip count as the loop it replaced once the group has tens of signals.
    expect(linkWrites[0]).toContain('unnest');
  });

  it('extends the published assessment instead of depositing an unread duplicate', async () => {
    db.previous = [steadyPrevious];

    const outcome = await runRiskAssessmentsGuarded({ allowModel: false });

    // Nothing was published, because nothing changed — and nothing was written to either of the two
    // tables that have no retention policy.
    expect(outcome).toEqual({ published: 0, skipped: false });
    expect(db.statements.filter(matching('INSERT INTO risk_assessments('))).toHaveLength(0);
    expect(db.statements.filter(matching('INSERT INTO risk_assessment_signals'))).toHaveLength(0);
    expect(db.statements.filter(matching('assessment.updated'))).toHaveLength(0);

    const extension = db.statements.find(matching('extended_at=now()'));
    expect(extension).toBeDefined();
    // Both ends of the extension are re-checked by the UPDATE itself: the row it read may have been
    // superseded or may have expired between the two statements, and an extension of an expired or
    // superseded horizon is exactly what must never reach a reader.
    expect(extension).toContain('expires_at > now()');
    expect(extension).toContain("generated_at > now() - interval '6 hours'");
    expect(extension).toContain('superseded_by IS NULL');
  });

  it('publishes rather than extends once the published row has expired', async () => {
    db.previous = [{ ...steadyPrevious, live: false }];

    const outcome = await runRiskAssessmentsGuarded({ allowModel: false });

    expect(outcome).toEqual({ published: 1, skipped: false });
    expect(db.statements.filter(matching('INSERT INTO risk_assessments('))).toHaveLength(1);
    expect(db.statements.filter(matching('extended_at=now()'))).toHaveLength(0);
  });

  it('publishes rather than extends once the row is older than the horizon it claims', async () => {
    db.previous = [{ ...steadyPrevious, within_own_horizon: false }];

    const outcome = await runRiskAssessmentsGuarded({ allowModel: false });

    expect(outcome).toEqual({ published: 1, skipped: false });
    expect(db.statements.filter(matching('INSERT INTO risk_assessments('))).toHaveLength(1);
    expect(db.statements.filter(matching('extended_at=now()'))).toHaveLength(0);
  });

  it('publishes when the index moves by half a point', async () => {
    db.previous = [{ ...steadyPrevious, risk_score: '3.9', risk_level: 'elevated' }];

    const outcome = await runRiskAssessmentsGuarded({ allowModel: false });

    expect(outcome).toEqual({ published: 1, skipped: false });
    expect(db.statements.filter(matching('SET superseded_by'))).toHaveLength(1);
  });
});
