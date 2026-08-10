import { describe, expect, it, vi } from 'vitest';

/**
 * The pure half of the publication gate: what a reader is TOLD about the slice they were served.
 *
 * `publicationSlice()` itself is an integration concern — it exists to make Postgres compute the
 * cutoff, and a mocked pool would only assert that the mock was called. What can go silently wrong
 * without a database is `sliceMeta`: it is the only place where a Node clock and a Postgres clock
 * meet, and a negative or unrounded freshness is a number the browser renders straight to a reader.
 *
 * `pool` is mocked rather than reached, so this file stays in the unit project.
 */

vi.mock('../db/pool.js', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));

const { config } = await import('../config.js');
const {
  ALERT_PROPAGATION_CAP_SECONDS, alertPropagationSeconds, delaySecondsFor, lastAlertPropagation,
  observeAlertPropagation, resetPublicationCache, sliceMeta
} = await import('./publication.js');

type Slice = Parameters<typeof sliceMeta>[0];

const NOW = new Date('2026-08-08T10:00:00.000Z');

function slice(overrides: Partial<Slice> = {}): Slice {
  return {
    mode: 'live',
    delaySeconds: 0,
    cutoffAt: NOW,
    cutoffVersion: 41_233,
    lastPublishedEventAt: new Date('2026-08-08T09:59:58.100Z'),
    headVersion: 41_233,
    ...overrides
  };
}

describe('the hold length in force', () => {
  it('delaySecondsFor is zero in live and the configured hold in delayed', () => {
    // The equivalence the whole delivery is shipped on: in live mode the cutoff is Postgres now()
    // and every new predicate degenerates to the one that was already in the tree.
    expect(delaySecondsFor('live')).toBe(0);
    expect(delaySecondsFor('delayed_15s')).toBe(config.PUBLICATION_DELAY_SECONDS);
  });
});

describe('sliceMeta', () => {
  it('reports zero freshness lag in live mode', () => {
    // Even with three seconds of clock disagreement between Node and Postgres: in live mode there is
    // no hold to report, and a nonzero number here would be read as a fault by the client's strip.
    const meta = sliceMeta(slice({ cutoffAt: new Date(NOW.getTime() - 3000) }), NOW);
    expect(meta.behindSeconds).toBe(0);
  });

  it('rounds the delayed lag to whole seconds', () => {
    const meta = sliceMeta(
      slice({ mode: 'delayed_15s', delaySeconds: 15, cutoffAt: new Date(NOW.getTime() - 15_400) }),
      NOW
    );
    expect(meta.behindSeconds).toBe(15);
  });

  it('never reports a negative lag', () => {
    // `cutoffAt` comes from Postgres and `now` from Node. A host whose two clocks disagree by half a
    // second would otherwise advertise a delay of minus one, which the UI would have to render.
    const meta = sliceMeta(
      slice({ mode: 'delayed_15s', delaySeconds: 15, cutoffAt: new Date(NOW.getTime() + 500) }),
      NOW
    );
    expect(meta.behindSeconds).toBe(0);
  });

  it('passes the mode and the delay through unchanged', () => {
    const meta = sliceMeta(slice({ mode: 'delayed_15s', delaySeconds: 15 }), NOW);
    expect(meta.mode).toBe('delayed_15s');
    expect(meta.delaySeconds).toBe(15);
    expect(meta.cutoffVersion).toBe(41_233);
  });

  it('serialises lastPublishedEventAt as ISO or null', () => {
    expect(sliceMeta(slice(), NOW).lastPublishedEventAt).toBe('2026-08-08T09:59:58.100Z');
    expect(sliceMeta(slice({ lastPublishedEventAt: null }), NOW).lastPublishedEventAt).toBeNull();
  });

  it('emits ISO 8601 for cutoffAt', () => {
    const meta = sliceMeta(slice(), NOW);
    expect(meta.cutoffAt).toBe('2026-08-08T10:00:00.000Z');
    expect(new Date(Date.parse(meta.cutoffAt)).toISOString()).toBe(meta.cutoffAt);
  });
});

/**
 * The end-to-end acquisition number, and the two clamps that keep it from lying.
 *
 * `upstreamAt` is a THIRD party's clock — the mirror prints a bare Europe/Kyiv wall clock and the
 * alert channels print Telegram's publication time — so both directions of disagreement are real
 * inputs, not hypotheticals, and a histogram can represent neither.
 */
describe('alert propagation', () => {
  const published = (offsetSeconds: number) => new Date(NOW.getTime() + offsetSeconds * 1000);

  it('is the distance from the upstream instant to ours', () => {
    expect(alertPropagationSeconds(published(4.2), NOW)).toBeCloseTo(4.2, 6);
    expect(alertPropagationSeconds(published(0), NOW)).toBe(0);
  });

  it('clamps a future upstream stamp to zero rather than recording a negative', () => {
    // A DST resolution that lands an hour the wrong way, or a provider simply running fast.
    expect(alertPropagationSeconds(NOW, published(3600))).toBe(0);
    expect(alertPropagationSeconds(NOW, published(0.4))).toBe(0);
  });

  it('saturates at the cap instead of putting a four-hour sample in +Inf', () => {
    // A provider re-listing an alert with the start timestamp it used four hours ago reopens the
    // same `alert_periods` row; a reconnect backfill replays a six-hour window by design.
    expect(alertPropagationSeconds(published(4 * 3600), NOW)).toBe(ALERT_PROPAGATION_CAP_SECONDS);
    expect(alertPropagationSeconds(published(301), NOW)).toBe(ALERT_PROPAGATION_CAP_SECONDS);
    expect(alertPropagationSeconds(published(299), NOW)).toBe(299);
  });

  it('measures nothing when no source offered a start timestamp', () => {
    // `reconcileAggregateAlert` stamps the period `now()` in that case, so the difference would be a
    // meaningless zero rather than a fast acquisition.
    expect(alertPropagationSeconds(published(10), null)).toBeNull();
  });

  it('refuses an unreadable instant instead of observing NaN', () => {
    expect(alertPropagationSeconds(published(10), new Date('nonsense'))).toBeNull();
    expect(alertPropagationSeconds(new Date('nonsense'), NOW)).toBeNull();
  });

  it('records the last reading for the ops chip, and the reset seam clears it', () => {
    resetPublicationCache();
    expect(lastAlertPropagation()).toBeNull();
    expect(observeAlertPropagation('aerial-alerts-mirror', published(3.5), NOW)).toBeCloseTo(3.5, 6);
    expect(lastAlertPropagation()).toEqual({
      seconds: 3.5, source: 'aerial-alerts-mirror', at: published(3.5).toISOString()
    });
    // An unmeasurable start must not overwrite the last real reading with nothing.
    expect(observeAlertPropagation('ukraine-alarm', published(9), null)).toBeNull();
    expect(lastAlertPropagation()?.source).toBe('aerial-alerts-mirror');
    resetPublicationCache();
    expect(lastAlertPropagation()).toBeNull();
  });

  it('hands back a copy, so a caller cannot rewrite what /ops serves next', () => {
    resetPublicationCache();
    observeAlertPropagation('aerial-alerts-mirror', published(2), NOW);
    const reading = lastAlertPropagation()!;
    reading.seconds = 999;
    expect(lastAlertPropagation()!.seconds).toBe(2);
    resetPublicationCache();
  });
});
