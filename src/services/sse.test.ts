import { describe, expect, it } from 'vitest';
import { createEventRelay, type SystemEvent } from './sse.js';

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
