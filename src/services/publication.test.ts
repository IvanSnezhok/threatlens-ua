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
const { delaySecondsFor, sliceMeta } = await import('./publication.js');

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
