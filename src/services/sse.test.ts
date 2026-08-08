import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemEvent } from './sse.js';

/**
 * The relay's monotonicity contract, the envelope every frame is built by, and the head bound that
 * makes the hold a property of the SELECT rather than of a queue in this process.
 *
 * The five relay tests are unchanged: `createEventRelay` is the compatibility contract between the
 * reconnect backfill and the live leg, and nothing in the publication gate touches it.
 *
 * `pool` is mocked rather than reached, so this file stays in the unit project. The hub is driven a
 * tick at a time through `start()`/`stop()` instead of through timers: `start()` calls `poll()`
 * synchronously before installing the interval, so stopping immediately afterwards gives one
 * deterministic tick with no wall clock involved.
 */

const query = vi.fn();
vi.mock('../db/pool.js', () => ({ pool: { query: (...args: unknown[]) => query(...args), connect: vi.fn() } }));

const { config } = await import('../config.js');
const { resetRuntimeSettingsCache } = await import('./runtime-settings.js');
const {
  SSE_ENVELOPE_VERSION, createEventRelay, eventHub, publishedEnvelope, resetEventHubCursor
} = await import('./sse.js');

const ROOT = resolve(import.meta.dirname, '../..');
const SSE_SOURCE = readFileSync(resolve(ROOT, 'src/services/sse.ts'), 'utf8');

function event(version: number): SystemEvent {
  return { version, eventType: 'alert.started', payload: { version }, createdAt: '2026-01-02T03:04:05.000Z' };
}

describe('SSE event relay', () => {
  it('holds live events until the backfill is flushed', () => {
    const written: number[] = [];
    const relay = createEventRelay(0, (received) => written.push(received.version));
    relay.buffer(event(7));
    relay.deliver(event(5));
    expect(written).toEqual([5]);
    relay.flush();
    expect(written).toEqual([5, 7]);
  });

  it('drops events already covered by the backfill', () => {
    const written: number[] = [];
    const relay = createEventRelay(0, (received) => written.push(received.version));
    relay.buffer(event(4));
    relay.buffer(event(5));
    relay.deliver(event(4));
    relay.deliver(event(5));
    relay.deliver(event(6));
    relay.flush();
    expect(written).toEqual([4, 5, 6]);
  });

  it('emits buffered events in monotonic version order regardless of arrival order', () => {
    const written: number[] = [];
    const relay = createEventRelay(0, (received) => written.push(received.version));
    relay.buffer(event(12));
    relay.buffer(event(10));
    relay.buffer(event(11));
    relay.flush();
    expect(written).toEqual([10, 11, 12]);
  });

  it('never replays events at or below Last-Event-ID', () => {
    const written: number[] = [];
    const relay = createEventRelay(9, (received) => written.push(received.version));
    relay.deliver(event(9));
    relay.buffer(event(8));
    relay.buffer(event(10));
    relay.flush();
    expect(written).toEqual([10]);
  });

  it('passes events straight through after the flush', () => {
    const written: number[] = [];
    const relay = createEventRelay(0, (received) => written.push(received.version));
    relay.flush();
    relay.buffer(event(1));
    relay.buffer(event(1));
    relay.buffer(event(2));
    expect(written).toEqual([1, 2]);
  });
});

describe('the outbound envelope', () => {
  const row = {
    version: 41_234,
    event_type: 'threat.created',
    payload: { eventId: 'e1' },
    created_at: new Date('2026-08-08T10:00:00.000Z')
  };
  const releasedAt = new Date('2026-08-08T10:00:15.014Z');

  it('publishedEnvelope populates all eight fields', () => {
    expect(publishedEnvelope(row, 'delayed_15s', releasedAt)).toEqual({
      version: 41_234,
      eventType: 'threat.created',
      payload: { eventId: 'e1' },
      createdAt: '2026-08-08T10:00:00.000Z',
      envelopeVersion: SSE_ENVELOPE_VERSION,
      occurredAt: '2026-08-08T10:00:00.000Z',
      publishedAt: '2026-08-08T10:00:15.014Z',
      delayMode: 'delayed_15s'
    });
    expect(SSE_ENVELOPE_VERSION).toBe(2);
  });

  it('publishedEnvelope coerces a bigint version string to a number', () => {
    // `system_event_log.version` is a bigserial and pg hands it over as a string; `createEventRelay`
    // compares versions with `<=`, and '9' <= '10' is false for strings.
    const envelope = publishedEnvelope({ ...row, version: '41234' }, 'live', releasedAt);
    expect(envelope.version).toBe(41_234);
    expect(typeof envelope.version).toBe('number');
  });

  it('publishedEnvelope never emits a forbidden vector token', () => {
    // The same nine tokens `tests/integration/threat-vector.test.ts` pins. Nothing added to this
    // envelope, ever, may collide with them.
    const serialised = JSON.stringify(publishedEnvelope(row, 'delayed_15s', releasedAt));
    for (const token of [
      'calculated', 'bearingDegrees', 'groundSpeedKmh', 'horizonMinutes', 'narrative',
      'uncertainty', 'candidates', 'centerline', 'cone'
    ]) {
      expect(serialised, `envelope names ${token}`).not.toContain(token);
    }
  });
});

describe('the hub statements', () => {
  // The two statements bind the mode-flip clamp at different positions — the poll carries the cursor
  // as `$1` — so the placeholder is a parameter of the check rather than part of it.
  const headBound = (statement: string, modeChangedAtParam: string) => {
    // The head is the version just BELOW the OLDEST row still held, never `max(version) WHERE
    // created_at <= cutoff`. Those two differ whenever version order and created_at order diverge —
    // a long write transaction takes a HIGH version at INSERT while carrying its transaction-START
    // created_at — and the `max` shape then releases every lower-versioned, newer-created row that
    // committed in between, with no time check of its own. Asserting the DIRECTION of the comparison
    // is what pins that: `created_at >` cannot be rewritten back to `created_at <=` by accident.
    expect(statement).toContain('created_at > GREATEST(now() - make_interval');
    expect(statement).toContain(`${modeChangedAtParam}::timestamptz`);
    expect(statement).toContain('version - 1');
    expect(statement).toContain('ORDER BY version LIMIT 1');
    // The fallback branch: with nothing held (live mode, or an empty tail) the bound degenerates to
    // the unbounded max(version), which is the byte-identical-behaviour argument for the switch-off
    // state.
    expect(statement).toContain('ORDER BY version DESC LIMIT 1');
    expect(statement).not.toContain('created_at <=');
  };

  it('the hub query is head-bounded in both directions', () => {
    // A per-row `created_at` predicate would let the cursor advance past a row that was not yet
    // releasable and drop it forever. Both halves of the bound have to be in the statement.
    const poll = SSE_SOURCE.slice(SSE_SOURCE.indexOf('WITH head AS'), SSE_SOURCE.indexOf('ORDER BY l.version LIMIT 200'));
    expect(poll).toContain('l.version > ');
    expect(poll).toContain('l.version <= head.v');
    expect(poll).toContain('GREATEST(');
    headBound(poll, '$3');
  });

  it('the first-tick cursor query carries the same cutoff, in the same direction', () => {
    // Initialising to the unbounded max(version) while the stored mode is delayed_15s would put the
    // cursor above everything written in the last `delaySeconds` before the restart, and
    // `lastVersion` only ever increases. The two statements must also agree with each other: a
    // first tick bounded differently from every later tick is a hold that depends on uptime.
    const start = SSE_SOURCE.indexOf('SELECT COALESCE((SELECT version - 1 FROM system_event_log');
    expect(start, 'the first-tick cursor query must still be one template literal').toBeGreaterThan(-1);
    headBound(SSE_SOURCE.slice(start, start + 400), '$2');
  });
});

// ------------------------------------------------------------------------------------------------
// The hub, driven a tick at a time against a fake pool
// ------------------------------------------------------------------------------------------------

interface LogRow { version: number; event_type: string; payload: unknown; created_at: Date }

const CREATED_AT = new Date('2026-08-08T10:00:00.000Z');

function logRow(version: number): LogRow {
  return { version, event_type: 'threat.created', payload: { version }, created_at: CREATED_AT };
}

function settingsRow(mode: string) {
  return {
    publication_mode: mode,
    mode_changed_at: new Date('2026-08-08T09:00:00.000Z'),
    analytics_event_driven: true,
    analytics_debounce_ms: 20_000,
    analytics_max_delay_ms: 120_000,
    codex_cooldown_ms: 900_000,
    updated_at: new Date('2026-08-08T09:00:00.000Z'),
    updated_by: 'operator'
  };
}

/** Lets every awaited step of one poll resolve before the next tick is driven. */
async function settle(): Promise<void> {
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
}

/**
 * One deterministic poll. `start()` invokes `poll()` synchronously and only then installs the
 * interval, so stopping immediately afterwards leaves exactly one tick in flight.
 */
async function tick(): Promise<void> {
  eventHub.start();
  eventHub.stop();
  await settle();
}

beforeEach(() => {
  query.mockReset();
  resetRuntimeSettingsCache();
  resetEventHubCursor();
  eventHub.removeAllListeners('event');
  eventHub.removeAllListeners('internal-event');
});

afterEach(() => {
  eventHub.stop();
  eventHub.removeAllListeners('event');
  eventHub.removeAllListeners('internal-event');
  resetEventHubCursor();
  resetRuntimeSettingsCache();
});

describe('the hub cursor', () => {
  it('refuses to initialise on a degraded settings read and initialises under the delayed bound on the next tick', async () => {
    // `resolveRuntimeSettings` fails open to `live` by design — right for publication timing, wrong
    // for cursor initialisation: on process start the memo is empty, so one transient failure would
    // pin the cursor to the unbounded max(version) while the stored mode is delayed_15s, and the
    // last fifteen seconds written before the restart would never be emitted to anybody.
    let settingsReads = 0;
    query.mockImplementation(async (text: string) => {
      if (text.includes('runtime_settings')) {
        settingsReads += 1;
        if (settingsReads === 1) throw new Error('connection terminated');
        return { rows: [settingsRow('delayed_15s')] };
      }
      if (text.includes('max(version)')) return { rows: [{ version: '99' }] };
      if (text.includes('AS version')) return { rows: [{ version: '7' }] };
      return { rows: [] };
    });

    await tick();
    const boundedHeadCalls = () => query.mock.calls
      .filter(([text]) => String(text).includes('AS version') && String(text).includes('GREATEST('));
    // Tick 1: the settings read rejected, so nothing was initialised at all.
    expect(boundedHeadCalls()).toHaveLength(0);

    await tick();
    expect(boundedHeadCalls()).toHaveLength(1);
    // Under the delayed bound, not the unbounded head: the hold length is bound as `$1`.
    expect(boundedHeadCalls()[0]![1]).toEqual([config.PUBLICATION_DELAY_SECONDS, '2026-08-08T09:00:00.000Z']);
  });

  it('a rewound head never rewinds the cursor', async () => {
    // The head is monotone in production because of the `mode_changed_at` clamp; if a hand-edited
    // row or a restored dump ever moved it backwards, the cursor must stand still rather than
    // re-emit what it has already released.
    const log = [1, 2, 3, 4, 5, 6, 7, 8].map(logRow);
    let head = 5;
    query.mockImplementation(async (text: string, params: unknown[] = []) => {
      if (text.includes('runtime_settings')) return { rows: [settingsRow('live')] };
      if (text.includes('max(version)')) return { rows: [{ version: '8' }] };
      if (text.includes('AS version')) return { rows: [{ version: String(head) }] };
      if (text.includes('WITH head AS')) {
        const cursor = Number(params[0]);
        return { rows: log.filter((row) => row.version > cursor && row.version <= head) };
      }
      // The unbounded internal feed. Never gated, and irrelevant to this assertion.
      return { rows: [] };
    });

    const emitted: number[] = [];
    eventHub.on('event', (frame: SystemEvent) => emitted.push(frame.version));

    await tick();                 // first tick: the cursor initialises at the head, 5
    head = 3;
    await tick();                 // a rewound head releases nothing
    await tick();
    expect(emitted).toEqual([]);

    head = 8;
    await tick();
    expect(emitted).toEqual([6, 7, 8]);
    // Strictly increasing, no repeats — the property a per-row predicate would have broken.
    expect([...emitted].sort((left, right) => left - right)).toEqual(emitted);
    expect(new Set(emitted).size).toBe(emitted.length);
  });

  it('never gates the internal feed', async () => {
    // «внутрішнє збереження, класифікація, аудит і моніторинг не затримуються»: the recompute must
    // see a recorded fact at the instant it is recorded, whatever the publication mode is.
    const log = [1, 2, 3].map(logRow);
    query.mockImplementation(async (text: string, params: unknown[] = []) => {
      if (text.includes('runtime_settings')) return { rows: [settingsRow('delayed_15s')] };
      if (text.includes('max(version)')) return { rows: [{ version: '0' }] };
      if (text.includes('AS version')) return { rows: [{ version: '0' }] };
      if (text.includes('WITH head AS')) return { rows: [] };
      const cursor = Number(params[0]);
      return { rows: log.filter((row) => row.version > cursor) };
    });

    const published: number[] = [];
    const recorded: number[] = [];
    eventHub.on('event', (frame: SystemEvent) => published.push(frame.version));
    eventHub.on('internal-event', (frame: SystemEvent) => recorded.push(frame.version));

    await tick();   // initialise both cursors
    await tick();   // steady state: the published head is 0, the internal cursor is not bounded
    expect(published).toEqual([]);
    expect(recorded).toEqual([1, 2, 3]);
  });
});

describe('the stream handler', () => {
  it('registers eventHub.on before any promise is awaited', () => {
    // Registering the subscription after the first await opens a window in which the hub emits to
    // every OTHER connection but not to this one — and those versions are also above this
    // connection's backfill upper bound, so they are lost for it permanently.
    const source = readFileSync(resolve(ROOT, 'src/api/server.ts'), 'utf8');
    const start = source.indexOf(`'/api/v1/stream'`);
    expect(start).toBeGreaterThan(-1);
    const handler = source
      .slice(start, source.indexOf(`app.get('/ops/api'`))
      // Comments name `await` several times above the subscription; only real statements count.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const subscription = handler.indexOf(`eventHub.on('event', send)`);
    const firstAwait = handler.indexOf('await ');
    expect(subscription).toBeGreaterThan(-1);
    expect(firstAwait).toBeGreaterThan(-1);
    expect(subscription).toBeLessThan(firstAwait);
    // The close handler must be registered in the same synchronous block, or a client that
    // disconnects during the await leaks a hub listener.
    expect(handler.indexOf(`request.raw.on('close'`)).toBeLessThan(firstAwait);
  });
});
