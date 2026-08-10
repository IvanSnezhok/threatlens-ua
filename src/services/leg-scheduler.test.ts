import { describe, expect, it } from 'vitest';
import { LEG_BACKOFF_CAP_MS, legDelayMs, startLegScheduler, type SchedulerLeg } from './leg-scheduler.js';

/**
 * The scheduler split, without a clock and without a database.
 *
 * The timer seam is the whole reason these properties are testable at all: the interesting cases are
 * "a leg at four seconds ran four times while a leg at fifteen ran once" and "a dead upstream backed
 * off to two minutes", and both take minutes of real time. The harness below runs them in
 * microseconds by keeping an ordered queue of armed callbacks and advancing a fake clock over it.
 *
 * What it deliberately does NOT fake: the promises. `leg.run()` really is awaited, so the property
 * that matters most — a chain arms nothing while its own pass is in flight — is exercised against
 * real microtask ordering rather than against an assumption about it.
 */

interface Armed { at: number; fn: () => void; leg: string; id: number }

/**
 * A deterministic timer seam over a virtual clock.
 *
 * `advance` drains callbacks in due order, re-entering as they arm new ones, and yields to the
 * microtask queue between each so an `await`ing leg body can settle before the next callback is due.
 */
function harness() {
  let now = 0;
  let nextId = 0;
  const armed: Armed[] = [];
  const timers = {
    set(fn: () => void, ms: number, leg: string): unknown {
      const entry: Armed = { at: now + ms, fn, leg, id: nextId++ };
      armed.push(entry);
      return entry;
    },
    clear(handle: unknown): void {
      const index = armed.indexOf(handle as Armed);
      if (index >= 0) armed.splice(index, 1);
    }
  };
  /** Lets every pending microtask (and therefore every awaited leg body) settle. */
  const settle = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
  const advance = async (ms: number) => {
    const deadline = now + ms;
    for (;;) {
      await settle();
      armed.sort((left, right) => left.at - right.at || left.id - right.id);
      const next = armed[0];
      if (!next || next.at > deadline) break;
      armed.shift();
      now = next.at;
      next.fn();
    }
    await settle();
    now = deadline;
  };
  return { timers, advance, settle, pending: () => armed.map((entry) => ({ leg: entry.leg, at: entry.at })) };
}

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

function countingLeg(name: string, intervalMs: () => number, body?: () => Promise<unknown>): {
  leg: SchedulerLeg; calls: () => number;
} {
  let calls = 0;
  return {
    leg: { name, intervalMs, run: async () => { calls += 1; return body?.(); } },
    calls: () => calls
  };
}

describe('legDelayMs', () => {
  it('is the configured gap while the leg is healthy', () => {
    expect(legDelayMs(4000, 0)).toBe(4000);
    expect(legDelayMs(15_000, 0)).toBe(15_000);
  });

  it('doubles per consecutive failure', () => {
    expect(legDelayMs(4000, 1)).toBe(8000);
    expect(legDelayMs(4000, 2)).toBe(16_000);
    expect(legDelayMs(4000, 3)).toBe(32_000);
  });

  it('stops at the cap', () => {
    expect(legDelayMs(4000, 5)).toBe(LEG_BACKOFF_CAP_MS);
    expect(legDelayMs(4000, 40)).toBe(LEG_BACKOFF_CAP_MS);
    expect(Number.isFinite(legDelayMs(4000, 4000))).toBe(true);
  });

  it('never speeds a leg up that is configured slower than the cap', () => {
    // The backoff may only ever push a leg further apart. A leg configured at five minutes that
    // starts failing must not be pulled in to the two-minute cap.
    expect(legDelayMs(300_000, 3)).toBe(300_000);
    expect(legDelayMs(300_000, 1)).toBe(300_000);
  });
});

describe('the scheduler split', () => {
  it('runs every leg once immediately, exactly as the old setInterval + void run() did', async () => {
    const h = harness();
    const fast = countingLeg('fast', () => 4000);
    const slow = countingLeg('slow', () => 15_000);
    const stop = startLegScheduler([fast.leg, slow.leg], silent, { timers: h.timers });
    await h.settle();
    expect(fast.calls()).toBe(1);
    expect(slow.calls()).toBe(1);
    stop();
  });

  it('ticks a fast leg independently of a slow one', async () => {
    const h = harness();
    const fast = countingLeg('aerial-mirror', () => 4000);
    const slow = countingLeg('alert-channel-backstop', () => 15_000);
    const stop = startLegScheduler([fast.leg, slow.leg], silent, { timers: h.timers });

    await h.advance(60_000);
    // t=0 plus one every 4 s of quiet time. The gap is measured from the END of a pass, and these
    // bodies are instantaneous, so 60 s holds 15 further passes.
    expect(fast.calls()).toBe(16);
    // The slow leg is untouched by the split: 60 s at fifteen is four further passes.
    expect(slow.calls()).toBe(5);
    stop();
  });

  it('does not let one hung leg stop the others — the shared overlap guard is gone', async () => {
    const h = harness();
    let release: (() => void) | null = null;
    const hung = countingLeg('ukraine-alarm', () => 15_000, () =>
      new Promise<void>((resolve) => { release = resolve; }));
    const healthy = countingLeg('aerial-mirror', () => 4000);
    const stop = startLegScheduler([hung.leg, healthy.leg], silent, { timers: h.timers });

    await h.advance(40_000);
    // The old scheduler shared one `running` flag: this is the case that used to suppress every
    // other leg for as long as one upstream hung.
    expect(hung.calls()).toBe(1);
    expect(healthy.calls()).toBe(11);
    release?.();
    stop();
  });

  it('arms nothing while a pass is in flight, so a leg cannot overlap itself', async () => {
    const h = harness();
    let release: (() => void) | null = null;
    let concurrent = 0;
    let maxConcurrent = 0;
    const leg: SchedulerLeg = {
      name: 'slow-poll',
      intervalMs: () => 1000,
      run: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise<void>((resolve) => { release = resolve; });
        concurrent -= 1;
      }
    };
    const stop = startLegScheduler([leg], silent, { timers: h.timers });
    await h.settle();
    // Ten intervals' worth of virtual time with the first pass still hanging: no second pass, and
    // no timer waiting to start one.
    await h.advance(10_000);
    expect(maxConcurrent).toBe(1);
    expect(h.pending()).toHaveLength(0);
    release?.();
    await h.settle();
    // And the chain resumes the moment the pass finishes.
    expect(h.pending()).toEqual([{ leg: 'slow-poll', at: 10_000 + 1000 }]);
    stop();
  });

  it('reads the interval on every tick, so a hot change applies from the next one', async () => {
    const h = harness();
    let interval = 4000;
    const leg = countingLeg('aerial-mirror', () => interval);
    const stop = startLegScheduler([leg.leg], silent, { timers: h.timers });

    await h.advance(12_000);
    expect(leg.calls()).toBe(4);                 // t = 0, 4, 8, 12

    // The operator's PUT. `applyAppSettings` mutates `config` in place; nothing is rebuilt.
    interval = 20_000;
    await h.advance(12_000);
    // The gap already being waited out finishes at the OLD value — that is the applyNote — and every
    // gap after it uses the new one. t=16 at the old 4 s, then nothing until t=36.
    expect(leg.calls()).toBe(5);
    await h.advance(24_000);
    expect(leg.calls()).toBe(6);
    stop();
  });

  it('applies a hot change downwards on the next tick too', async () => {
    const h = harness();
    let interval = 15_000;
    const leg = countingLeg('aerial-mirror', () => interval);
    const stop = startLegScheduler([leg.leg], silent, { timers: h.timers });
    await h.advance(15_000);
    expect(leg.calls()).toBe(2);
    interval = 3000;
    await h.advance(15_000);
    // The 15 s gap armed at t=15 000 runs out at t=30 000; every gap after it is 3 s.
    expect(leg.calls()).toBe(3);
    await h.advance(9000);
    expect(leg.calls()).toBe(6);
    stop();
  });
});

describe('per-leg failure backoff', () => {
  it('backs a failing leg off exponentially and resets it on the first success', async () => {
    const h = harness();
    let failing = true;
    const at: number[] = [];
    let clock = 0;
    const leg: SchedulerLeg = {
      name: 'aerial-mirror',
      intervalMs: () => 4000,
      run: async () => {
        at.push(clock);
        if (failing) throw new Error('upstream is down');
      }
    };
    // The harness advances in one call, so the leg records the virtual instants itself by reading
    // the same schedule the timers use: the deltas below are what the assertion is about.
    const stop = startLegScheduler([leg], silent, { timers: h.timers });
    const step = async (ms: number) => { await h.advance(ms); clock += ms; };
    await h.settle();
    // t=0 fails → 8 s. t=8 fails → 16 s. t=24 fails → 32 s. t=56 fails → 64 s. t=120 fails → cap.
    for (const delta of [8000, 16_000, 32_000, 64_000]) await step(delta);
    expect(at).toHaveLength(5);
    expect(h.pending()).toEqual([{ leg: 'aerial-mirror', at: 120_000 + LEG_BACKOFF_CAP_MS }]);

    // The upstream comes back. The backoff is not a mode the leg has to be let out of.
    failing = false;
    await step(LEG_BACKOFF_CAP_MS);
    expect(at).toHaveLength(6);
    expect(h.pending()).toEqual([{ leg: 'aerial-mirror', at: 240_000 + 4000 }]);
    stop();
  });

  it('backs off one leg without touching the cadence of another', async () => {
    const h = harness();
    const dead: SchedulerLeg = {
      name: 'ukraine-alarm', intervalMs: () => 15_000,
      run: async () => { throw new Error('down'); }
    };
    const healthy = countingLeg('aerial-mirror', () => 4000);
    const stop = startLegScheduler([dead, healthy.leg], silent, { timers: h.timers });
    await h.advance(120_000);
    // 4 s cadence, unaffected: t=0 plus thirty more.
    expect(healthy.calls()).toBe(31);
    stop();
  });
});

describe('stopping', () => {
  it('clears every armed timer and arms no more', async () => {
    const h = harness();
    const first = countingLeg('a', () => 4000);
    const second = countingLeg('b', () => 15_000);
    const stop = startLegScheduler([first.leg, second.leg], silent, { timers: h.timers });
    await h.settle();
    expect(h.pending()).toHaveLength(2);
    stop();
    expect(h.pending()).toHaveLength(0);
    await h.advance(120_000);
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(1);
  });

  it('does not re-arm from a pass that was still in flight when it was stopped', async () => {
    const h = harness();
    let release: (() => void) | null = null;
    const leg: SchedulerLeg = {
      name: 'in-flight', intervalMs: () => 1000,
      run: () => new Promise<void>((resolve) => { release = resolve; })
    };
    const stop = startLegScheduler([leg], silent, { timers: h.timers });
    await h.settle();
    stop();
    release?.();
    await h.settle();
    // The `finally` ran after the stop; the chain must be dead, not merely quiet for one gap.
    expect(h.pending()).toHaveLength(0);
  });
});
