import { Registry } from 'prom-client';
import { afterEach, describe, expect, it } from 'vitest';
import { alertPokeMetrics, onAlertPoke, pokeAlertStarted, resetAlertPoke } from './alert-poke.js';

/**
 * The coalescing half of instant propagation.
 *
 * The other half — that a poked hub still refuses to release a held row — cannot be shown here,
 * because it is a property of a SQL predicate; `tests/integration/alert-poke.test.ts` pins it
 * against a live database. What this file proves is the bound that keeps a nationwide raid from
 * turning the signal into a load source: however many callers fire inside one macrotask turn, the
 * listeners are called once.
 */

/** One turn of the macrotask queue — the window `pokeAlertStarted` coalesces over. */
const nextTurn = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

afterEach(() => { resetAlertPoke(); });

describe('poke coalescing', () => {
  it('calls every listener once for one poke', async () => {
    let hub = 0;
    let fanout = 0;
    onAlertPoke(() => { hub += 1; });
    onAlertPoke(() => { fanout += 1; });
    pokeAlertStarted();
    expect(hub).toBe(0);                 // not synchronous: the caller's `finally` must not run a pass
    await nextTurn();
    expect([hub, fanout]).toEqual([1, 1]);
  });

  it('collapses a burst inside one turn into a single call', async () => {
    let fired = 0;
    onAlertPoke(() => { fired += 1; });
    // Twenty-five oblasts going alight in one nationwide snapshot, if every one of them poked.
    for (let i = 0; i < 25; i += 1) pokeAlertStarted();
    await nextTurn();
    expect(fired).toBe(1);
  });

  it('lets the next turn poke again', async () => {
    let fired = 0;
    onAlertPoke(() => { fired += 1; });
    pokeAlertStarted();
    await nextTurn();
    pokeAlertStarted();
    await nextTurn();
    expect(fired).toBe(2);
  });

  it('counts what it fired and what it dropped', async () => {
    const registry = new Registry();
    for (const [, metric] of alertPokeMetrics()) registry.registerMetric(metric);
    const before = await scrape(registry);
    pokeAlertStarted();
    pokeAlertStarted();
    pokeAlertStarted();
    await nextTurn();
    const after = await scrape(registry);
    expect(after.fired - before.fired).toBe(1);
    expect(after.coalesced - before.coalesced).toBe(2);
  });

  it('survives a listener that throws, and still tells the others', async () => {
    const told: string[] = [];
    onAlertPoke(() => { told.push('first'); throw new Error('hub exploded'); });
    onAlertPoke(() => { told.push('second'); });
    pokeAlertStarted();
    await nextTurn();
    expect(told).toEqual(['first', 'second']);
  });
});

describe('subscription lifecycle', () => {
  it('detaches through the returned closure', async () => {
    let fired = 0;
    const detach = onAlertPoke(() => { fired += 1; });
    pokeAlertStarted();
    await nextTurn();
    detach();
    pokeAlertStarted();
    await nextTurn();
    expect(fired).toBe(1);
  });

  it('resetAlertPoke drops every listener and disarms a pending poke', async () => {
    let fired = 0;
    onAlertPoke(() => { fired += 1; });
    pokeAlertStarted();
    resetAlertPoke();
    await nextTurn();
    expect(fired).toBe(0);
    // And the pending slot really was released, not merely orphaned: a later poke still works.
    onAlertPoke(() => { fired += 1; });
    pokeAlertStarted();
    await nextTurn();
    expect(fired).toBe(1);
  });
});

async function scrape(registry: Registry): Promise<{ fired: number; coalesced: number }> {
  const text = await registry.metrics();
  const read = (outcome: string) => {
    const match = new RegExp(`^threatlens_alert_pokes_total\\{outcome="${outcome}"\\} (\\d+)$`, 'm').exec(text);
    return match ? Number(match[1]) : 0;
  };
  return { fired: read('fired'), coalesced: read('coalesced') };
}
