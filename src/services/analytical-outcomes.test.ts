import { describe, expect, it } from 'vitest';
import {
  CONFIRMATION_WINDOW_MINUTES,
  OUTCOME_GRACE_MINUTES,
  PRECISION_THRESHOLDS,
  decideOutcome,
  type OutcomeEvidence
} from './analytical-outcomes.js';

/**
 * The verdict on the verdict, without a database.
 *
 * `decideOutcome` is the whole judgement of this module reduced to a pure function so that the three
 * outcomes an operator reads on `/ops` are provable here rather than only inside an integration run
 * that needs Postgres. The SQL that gathers the evidence is exercised in
 * `tests/integration/analytical-outcomes.test.ts`; what follows is the meaning assigned to it.
 */

const PUBLISHED_AT = new Date('2026-03-01T22:00:00.000Z');

/**
 * No corroboration of any kind, which is the case every other one is one field away from. Written as
 * an override helper for the same reason `source-trust.test.ts` writes one: a failure should name
 * the piece of evidence that changed, not the fixture.
 */
function evidence(overrides: Partial<OutcomeEvidence> = {}): OutcomeEvidence {
  return { official: null, independent: null, alertActiveAtPublication: false, ...overrides };
}

const OFFICIAL = {
  at: new Date(PUBLISHED_AT.getTime() + 4 * 60_000),
  locationId: 'ua-32',
  alertType: 'air_raid'
};

const INDEPENDENT = {
  at: new Date(PUBLISHED_AT.getTime() + 9 * 60_000),
  locationId: 'ua-city-bila-tserkva',
  group: 'osint-eradar'
};

describe('decideOutcome', () => {
  it('scores an official alert that started after publication as confirmed_official', () => {
    const decision = decideOutcome(evidence({ official: OFFICIAL }));

    expect(decision.outcome).toBe('confirmed_official');
    // The lead time is what the promotion actually bought, and it is only computable because the
    // corroborating instant — not merely the fact — is carried into the row.
    expect(decision.confirmedAt).toEqual(OFFICIAL.at);
    expect(decision.confirmedAt!.getTime() - PUBLISHED_AT.getTime()).toBe(4 * 60_000);
    // The alert's own location, which may be the oblast above the city the model named.
    expect(decision.confirmedLocationId).toBe('ua-32');
    // `confirmed_by` is the alert type on this branch and the independence group on the other.
    expect(decision.confirmedBy).toBe('air_raid');
  });

  it('scores another independence group asserting the same threat as confirmed_independent', () => {
    const decision = decideOutcome(evidence({ independent: INDEPENDENT }));

    expect(decision.outcome).toBe('confirmed_independent');
    expect(decision.confirmedAt).toEqual(INDEPENDENT.at);
    expect(decision.confirmedLocationId).toBe('ua-city-bila-tserkva');
    expect(decision.confirmedBy).toBe('osint-eradar');
  });

  it('scores a window that closed with nothing as unconfirmed, and leaves every confirmation field empty', () => {
    const decision = decideOutcome(evidence());

    expect(decision.outcome).toBe('unconfirmed');
    // The table's CHECK ties these together — `(outcome='unconfirmed') = (confirmed_at IS NULL)` —
    // so a decision that returned an instant here would be rejected by the database rather than
    // stored as a contradiction. Asserted in both places on purpose: this is the invariant the
    // precision figure is built on.
    expect(decision.confirmedAt).toBeNull();
    expect(decision.confirmedLocationId).toBeNull();
    expect(decision.confirmedBy).toBeNull();
  });

  it('puts an official confirmation above an independent one when both exist', () => {
    // `CONTEXT.md` §Межі безпеки: the official signal outranks every analytical one. It also keeps
    // the two series disjoint, so `confirmed_independent` keeps meaning «the officials never
    // declared this, but somebody else saw it» rather than «one of the two happened».
    const decision = decideOutcome(evidence({ official: OFFICIAL, independent: INDEPENDENT }));

    expect(decision.outcome).toBe('confirmed_official');
    expect(decision.confirmedBy).toBe('air_raid');
  });

  it('carries the standing-alert qualifier through every outcome without changing it', () => {
    // A promotion published under an alert that was already running cannot be confirmed officially
    // by construction, so the condition has to reach the row: `/ops` takes exactly these rows out of
    // the precision denominator instead of scoring an undecidable case as a failure. It must never
    // become an outcome of its own — that would be this module deciding the model was right.
    expect(decideOutcome(evidence({ alertActiveAtPublication: true })))
      .toMatchObject({ outcome: 'unconfirmed', alertActiveAtPublication: true });
    expect(decideOutcome(evidence({ official: OFFICIAL, alertActiveAtPublication: true })))
      .toMatchObject({ outcome: 'confirmed_official', alertActiveAtPublication: true });
    expect(decideOutcome(evidence({ independent: INDEPENDENT, alertActiveAtPublication: true })))
      .toMatchObject({ outcome: 'confirmed_independent', alertActiveAtPublication: true });
  });
});

describe('methodology constants', () => {
  it('waits less time than it accepts corroboration for', () => {
    // The grace period decides WHEN a promotion is judged; the confirmation window decides WHAT
    // still counts. If the grace ever exceeded the window, every pass would score events whose
    // corroboration window had already been fully searched minutes earlier — harmless — but the
    // reverse mistake is not: a grace SHORTER than the window means the evaluation runs before the
    // last minutes of the window have elapsed, and a late official alert would be scored as a miss.
    expect(30 + OUTCOME_GRACE_MINUTES).toBe(CONFIRMATION_WINDOW_MINUTES);
  });

  it('brackets the shipped confidence floor', () => {
    // The reading is a comparison, so the default (0.9, `src/config.ts:271`) has to sit between two
    // neighbours. A threshold list that drifted above or below it would answer a question the
    // operator is not asking.
    expect(PRECISION_THRESHOLDS).toContain(0.9);
    expect(Math.min(...PRECISION_THRESHOLDS)).toBeLessThan(0.9);
    expect(Math.max(...PRECISION_THRESHOLDS)).toBeGreaterThan(0.9);
  });
});
