import { describe, expect, it } from 'vitest';
import {
  ASSESSMENT_COOLDOWN_MINUTES, EVIDENCE_ORDER, decideAssessmentNotification, decideThreatNotification,
  evidenceRank, geographyKey, mergePublishedState, riskRank, threatContentHash,
  type ThreatPublishedState, type ThreatSnapshot
} from './notification-policy.js';

const BASE = '2026-08-08T01:00:00.000Z';
function minutesAfter(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

function snapshot(overrides: Partial<ThreatSnapshot> = {}): ThreatSnapshot {
  return {
    threatType: 'uav',
    evidenceLevel: 'monitoring',
    locationIds: ['ua-32'],
    validUntil: minutesAfter(BASE, 60),
    ...overrides
  };
}

/** The published state a chat would hold after being told about `snapshot()`. */
function published(overrides: Partial<ThreatPublishedState> = {}): ThreatPublishedState {
  const sent = snapshot();
  return {
    threatType: sent.threatType,
    evidenceLevel: sent.evidenceLevel,
    geographyKey: geographyKey(sent.locationIds),
    validUntil: sent.validUntil,
    contentHash: threatContentHash(sent),
    telegramMessageId: 4242,
    ...overrides
  };
}

describe('threat notification policy', () => {
  it('sends the full message when the chat has never been told about this threat', () => {
    const decision = decideThreatNotification(null, snapshot());
    expect(decision).toMatchObject({ action: 'send', kind: 'initial', changes: ['initial'] });
  });

  it('stays quiet when a source merely re-confirms the same threat', () => {
    const decision = decideThreatNotification(published(), snapshot());
    expect(decision.action).toBe('skip');
    expect(decision.changes).toEqual([]);
  });

  it('stays quiet when only the summary text was reworded', () => {
    // The hash deliberately ignores the summary: a source restating the same warning in other words
    // is not news, and it used to produce a byte-identical push for every subscriber.
    const decision = decideThreatNotification(published(), snapshot());
    expect(decision.action).toBe('skip');
  });

  it('sends a fresh message for every upward step of the evidence ladder', () => {
    for (let step = 1; step < EVIDENCE_ORDER.length; step += 1) {
      const previous = EVIDENCE_ORDER[step - 1]!;
      const next = EVIDENCE_ORDER[step]!;
      const decision = decideThreatNotification(
        published({ evidenceLevel: previous, contentHash: null }),
        snapshot({ evidenceLevel: next })
      );
      expect(decision, `${previous} -> ${next}`).toMatchObject({ action: 'send', kind: 'escalation' });
      expect(decision.changes).toContain('evidence_raised');
    }
  });

  it('stays quiet when the evidence level is weakened', () => {
    const decision = decideThreatNotification(
      published({ evidenceLevel: 'confirmed', contentHash: null }),
      snapshot({ evidenceLevel: 'monitoring' })
    );
    expect(decision.action).toBe('skip');
  });

  it('sends when the threat type is corrected', () => {
    const decision = decideThreatNotification(
      published({ contentHash: null }),
      snapshot({ threatType: 'cruise_missile' })
    );
    expect(decision).toMatchObject({ action: 'send', kind: 'change' });
    expect(decision.changes).toEqual(['threat_type_changed']);
  });

  it('sends when the threat reaches a location the chat was not told about', () => {
    const decision = decideThreatNotification(
      published({ contentHash: null }),
      snapshot({ locationIds: ['ua-32', 'ua-city-bila-tserkva'] })
    );
    expect(decision).toMatchObject({ action: 'send', kind: 'change' });
    expect(decision.changes).toEqual(['geography_changed']);
  });

  it('stays quiet when the threat only stops covering a location', () => {
    const decision = decideThreatNotification(
      published({ geographyKey: 'ua-32,ua-city-bila-tserkva', contentHash: null }),
      snapshot({ locationIds: ['ua-32'] })
    );
    expect(decision.action).toBe('skip');
  });

  it('ignores a validity window that creeps forward by a few minutes', () => {
    const decision = decideThreatNotification(
      published({ contentHash: null }),
      snapshot({ validUntil: minutesAfter(BASE, 75) })
    );
    expect(decision.action).toBe('skip');
  });

  it('edits the standing message when the window is extended past the threshold', () => {
    const decision = decideThreatNotification(
      published({ contentHash: null }),
      snapshot({ validUntil: minutesAfter(BASE, 95) })
    );
    expect(decision).toMatchObject({ action: 'edit', kind: 'soft', editMessageId: 4242 });
    expect(decision.changes).toEqual(['validity_extended']);
  });

  it('sends an extension as a new message when no delivered message is known', () => {
    const decision = decideThreatNotification(
      published({ contentHash: null, telegramMessageId: null }),
      snapshot({ validUntil: minutesAfter(BASE, 95) })
    );
    expect(decision).toMatchObject({ action: 'send', kind: 'soft', editMessageId: null });
  });

  it('treats an escalation that also extends the window as an escalation, never an edit', () => {
    const decision = decideThreatNotification(
      published({ contentHash: null }),
      snapshot({ evidenceLevel: 'official', validUntil: minutesAfter(BASE, 180) })
    );
    expect(decision).toMatchObject({ action: 'send', kind: 'escalation' });
    expect(decision.changes).toEqual(['evidence_raised', 'validity_extended']);
  });

  it('treats the first known validity window as an extension', () => {
    const decision = decideThreatNotification(
      published({ validUntil: null, contentHash: null }),
      snapshot({ validUntil: minutesAfter(BASE, 60) })
    );
    expect(decision.changes).toEqual(['validity_extended']);
  });

  it('stays quiet when the window disappears from the source data', () => {
    const decision = decideThreatNotification(
      published({ contentHash: null }),
      snapshot({ validUntil: null })
    );
    expect(decision.action).toBe('skip');
  });

  it('ranks an unknown evidence level as the weakest so it can never read as an escalation', () => {
    expect(evidenceRank('made-up')).toBe(0);
    const decision = decideThreatNotification(
      published({ evidenceLevel: 'confirmed', contentHash: null }),
      snapshot({ evidenceLevel: 'made-up' })
    );
    expect(decision.action).toBe('skip');
  });
});

describe('assessment notification policy', () => {
  const now = minutesAfter(BASE, 0);
  function state(overrides: Partial<{ riskLevel: string; score: number; notifiedAt: string }> = {}) {
    return { riskLevel: 'elevated', score: 3, notifiedAt: minutesAfter(BASE, -5), ...overrides };
  }

  it('sends the first assessment a chat sees', () => {
    expect(decideAssessmentNotification(null, { riskLevel: 'elevated', score: 3, at: now }))
      .toMatchObject({ action: 'send', kind: 'initial', silent: false });
  });

  it('sends an escalation immediately, ignoring the cooldown', () => {
    const decision = decideAssessmentNotification(
      state({ notifiedAt: minutesAfter(BASE, -1) }),
      { riskLevel: 'high', score: 3.1, at: now }
    );
    expect(decision).toMatchObject({ action: 'send', kind: 'escalation', silent: false });
  });

  it('delivers a de-escalation without a sound', () => {
    const decision = decideAssessmentNotification(
      state({ riskLevel: 'high', score: 7, notifiedAt: minutesAfter(BASE, -ASSESSMENT_COOLDOWN_MINUTES - 1) }),
      { riskLevel: 'elevated', score: 3, at: now }
    );
    expect(decision).toMatchObject({ action: 'send', kind: 'deescalation', silent: true });
  });

  it('holds a de-escalation back while the cooldown is running', () => {
    const decision = decideAssessmentNotification(
      state({ riskLevel: 'high', score: 7, notifiedAt: minutesAfter(BASE, -10) }),
      { riskLevel: 'elevated', score: 3, at: now }
    );
    expect(decision.action).toBe('skip');
  });

  it('ignores drift below the message threshold even though the database stores it', () => {
    // 0.6 clears the 0.5 storage threshold in risk.ts and stays under the 1.0 message threshold:
    // exactly the oscillation that used to produce a stream of near-identical pushes.
    const decision = decideAssessmentNotification(
      state({ notifiedAt: minutesAfter(BASE, -120) }),
      { riskLevel: 'elevated', score: 3.6, at: now }
    );
    expect(decision).toMatchObject({ action: 'skip' });
  });

  it('sends same-level drift once the score moves by a full point', () => {
    const decision = decideAssessmentNotification(
      state({ notifiedAt: minutesAfter(BASE, -120) }),
      { riskLevel: 'elevated', score: 4, at: now }
    );
    expect(decision).toMatchObject({ action: 'send', kind: 'drift', silent: false });
  });

  it('holds same-level drift back while the cooldown is running', () => {
    const decision = decideAssessmentNotification(
      state({ notifiedAt: minutesAfter(BASE, -10) }),
      { riskLevel: 'elevated', score: 5, at: now }
    );
    expect(decision.action).toBe('skip');
  });

  it('orders the risk ladder from background to very high', () => {
    expect(riskRank('background')).toBeLessThan(riskRank('very_high'));
    expect(riskRank('unknown-level')).toBe(0);
  });
});

describe('what a chat is recorded as having been told', () => {
  it('keeps the announced evidence level when the source walks it back', () => {
    // The downgrade itself is never sent, so it must not be written down either: recording it would
    // let the level returning to where it already was read as a fresh escalation.
    const merged = mergePublishedState(
      published({ evidenceLevel: 'confirmed' }),
      snapshot({ evidenceLevel: 'unverified', validUntil: minutesAfter(BASE, 120) })
    );
    expect(merged.evidenceLevel).toBe('confirmed');

    const decision = decideThreatNotification(
      published({
        evidenceLevel: merged.evidenceLevel, validUntil: merged.validUntil,
        contentHash: threatContentHash(merged)
      }),
      snapshot({ evidenceLevel: 'confirmed', validUntil: minutesAfter(BASE, 120) })
    );
    expect(decision.action).toBe('skip');
  });

  it('records a genuine escalation as the new level', () => {
    const merged = mergePublishedState(published(), snapshot({ evidenceLevel: 'official' }));
    expect(merged.evidenceLevel).toBe('official');
  });

  it('keeps directions a chat was warned about after the threat narrows', () => {
    const merged = mergePublishedState(
      published({ geographyKey: geographyKey(['ua-32', 'ua-51']) }),
      snapshot({ locationIds: ['ua-32'], validUntil: minutesAfter(BASE, 120) })
    );
    expect([...merged.locationIds].sort()).toEqual(['ua-32', 'ua-51']);

    const decision = decideThreatNotification(
      published({
        geographyKey: geographyKey(merged.locationIds), validUntil: merged.validUntil,
        contentHash: threatContentHash(merged)
      }),
      snapshot({ locationIds: ['ua-32', 'ua-51'], validUntil: minutesAfter(BASE, 120) })
    );
    expect(decision.action).toBe('skip');
  });

  it('adds newly covered directions to the published geography', () => {
    const merged = mergePublishedState(published(), snapshot({ locationIds: ['ua-32', 'ua-51'] }));
    expect([...merged.locationIds].sort()).toEqual(['ua-32', 'ua-51']);
  });

  it('keeps the furthest deadline a chat was given', () => {
    const merged = mergePublishedState(
      published({ evidenceLevel: 'confirmed' }),
      snapshot({ evidenceLevel: 'official', validUntil: minutesAfter(BASE, 10) })
    );
    expect(merged.validUntil).toBe(minutesAfter(BASE, 60));

    // Restoring the original window is therefore not an extension, and stays quiet.
    const decision = decideThreatNotification(
      published({
        evidenceLevel: 'official', validUntil: merged.validUntil, contentHash: threatContentHash(merged)
      }),
      snapshot({ evidenceLevel: 'official', validUntil: minutesAfter(BASE, 60) })
    );
    expect(decision.action).toBe('skip');
  });

  it('takes the snapshot whole when the chat has heard nothing yet', () => {
    expect(mergePublishedState(null, snapshot())).toEqual(snapshot());
  });

  it('takes the new threat type, which is always announced', () => {
    const merged = mergePublishedState(published(), snapshot({ threatType: 'cruise_missile' }));
    expect(merged.threatType).toBe('cruise_missile');
  });
});
