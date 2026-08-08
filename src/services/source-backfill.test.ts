import { describe, expect, it } from 'vitest';
import {
  decideBackfill, selectWindowMessages,
  type BackfillDecisionInput, type BackfillRawMessage, type BackfillWindowBounds
} from './source-backfill.js';

/**
 * The two pure decisions the catch-up backfill is built out of, tested without a database, without a
 * Telegram session and without a clock.
 *
 * Both functions exist so that the parts of this feature an operator will argue about — «чому не
 * дозібрало?», «чому обмежено?» — are decidable by reading a table rather than by reproducing a
 * three-hour outage. Everything impure around them (paging, replay, state) is exercised in
 * `tests/integration/classifier-backfill.test.ts` against a live PostgreSQL.
 */

const NOW = new Date('2026-08-08T12:00:00.000Z');

function decisionInput(overrides: Partial<BackfillDecisionInput> = {}): BackfillDecisionInput {
  return {
    sourceId: 'osint-test',
    now: NOW,
    enabled: true,
    sourceEnabled: true,
    cursorPublishedAt: new Date(NOW.getTime() - 61 * 60_000),
    archiveEmpty: false,
    lastRunAt: null,
    consecutiveFailures: 0,
    minGapSeconds: 3600,
    minRerunSeconds: 3600,
    ...overrides
  };
}

/** A gap of exactly `minutes`, expressed the way the sweep sees it: as a cursor timestamp. */
function cursorMinutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

describe('decideBackfill', () => {
  it('skips a 59-minute gap, skips 60 exactly, and runs at 61', () => {
    // The acceptance criterion is «розрив ПОНАД 60 хвилин», and the boundary is the whole of it: an
    // installation restarted every hour by a supervisor must not replay its own history on every
    // restart, and a genuine hour-long outage must not be silently dropped. `<=` is the difference.
    expect(decideBackfill(decisionInput({ cursorPublishedAt: cursorMinutesAgo(59) })).action)
      .toBe('skipped_small_gap');
    expect(decideBackfill(decisionInput({ cursorPublishedAt: cursorMinutesAgo(60) })).action)
      .toBe('skipped_small_gap');
    expect(decideBackfill(decisionInput({ cursorPublishedAt: cursorMinutesAgo(61) })).action)
      .toBe('run');
  });

  it('reports the gap it measured whatever it decides', () => {
    const skipped = decideBackfill(decisionInput({ cursorPublishedAt: cursorMinutesAgo(59) }));
    expect(skipped.gapSeconds).toBe(59 * 60);
    expect(skipped.cursorPublishedAt).toEqual(cursorMinutesAgo(59));
    const running = decideBackfill(decisionInput({ cursorPublishedAt: cursorMinutesAgo(180) }));
    expect(running.gapSeconds).toBe(180 * 60);
    expect(running.sourceId).toBe('osint-test');
  });

  it('reports no_cursor for a source whose archive is empty, and calls the gap zero', () => {
    // `baseline_at` defaults to now() the first time a source is seen, so the effective cursor of a
    // never-collected channel is the present. Without that, a newly registered channel would look
    // like a gap since the epoch and the first sweep after adding one would try to read all of it.
    const decision = decideBackfill(decisionInput({
      archiveEmpty: true, cursorPublishedAt: NOW
    }));
    expect(decision.action).toBe('no_cursor');
    expect(decision.gapSeconds).toBe(0);
  });

  it('refuses before it measures when the feature or the source is switched off', () => {
    // Ordered first on purpose: a disabled source with a twelve-hour gap must read «вимкнено», not
    // «розрив 12 год» beside a feature nobody turned on.
    const wideGap = { cursorPublishedAt: cursorMinutesAgo(720) };
    expect(decideBackfill(decisionInput({ ...wideGap, enabled: false })).action).toBe('skipped_disabled');
    expect(decideBackfill(decisionInput({ ...wideGap, sourceEnabled: false })).action).toBe('skipped_disabled');
    // …and it still reports the gap, so the console can show what is being left alone.
    expect(decideBackfill(decisionInput({ ...wideGap, enabled: false })).gapSeconds).toBe(720 * 60);
  });

  it('holds a source off for MIN_RERUN_SECONDS after an attempt', () => {
    const recent = decideBackfill(decisionInput({
      cursorPublishedAt: cursorMinutesAgo(180), lastRunAt: new Date(NOW.getTime() - 59 * 60_000)
    }));
    expect(recent.action).toBe('skipped_recent');
    const elapsed = decideBackfill(decisionInput({
      cursorPublishedAt: cursorMinutesAgo(180), lastRunAt: new Date(NOW.getTime() - 61 * 60_000)
    }));
    expect(elapsed.action).toBe('run');
  });

  it('doubles the quiet period per consecutive failure and caps it at 24 hours', () => {
    // A message that always throws would otherwise be retried on every sweep forever. Three failures
    // means the eighth hour, not the first — and the cap keeps the backoff from growing into weeks.
    const afterFailures = (consecutiveFailures: number, lastRunHoursAgo: number) =>
      decideBackfill(decisionInput({
        cursorPublishedAt: cursorMinutesAgo(600),
        lastRunAt: new Date(NOW.getTime() - lastRunHoursAgo * 3_600_000),
        consecutiveFailures
      })).action;
    expect(afterFailures(3, 7)).toBe('skipped_recent');   // 2^3 = 8 hours
    expect(afterFailures(3, 9)).toBe('run');
    expect(afterFailures(10, 25)).toBe('run');            // min(2^10, 24) = 24 hours
    expect(afterFailures(10, 23)).toBe('skipped_recent');
  });
});

// ------------------------------------------------------------------------------------------------

const HOUR = 3600;
/** Telegram publishes seconds, so every fixture below is built in seconds and never in Date. */
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

function message(secondsAgo: number, id: number, text: string | null = 'текст'): BackfillRawMessage {
  return { id, date: NOW_SECONDS - secondsAgo, message: text };
}

/** `count` messages, newest first, one every `stepSeconds`, ids descending from `firstId`. */
function page(count: number, firstId: number, firstSecondsAgo: number, stepSeconds = 10): BackfillRawMessage[] {
  return Array.from({ length: count }, (_, index) =>
    message(firstSecondsAgo + index * stepSeconds, firstId - index));
}

function bounds(overrides: Partial<BackfillWindowBounds> = {}): BackfillWindowBounds {
  return {
    from: new Date(NOW.getTime() - 3 * HOUR * 1000),
    to: NOW,
    cursorExternalId: null,
    ageTruncated: false,
    maxMessages: 300,
    maxPages: 5,
    pageSize: 100,
    ...overrides
  };
}

describe('selectWindowMessages', () => {
  it('keeps only what is newer than the cursor and replays it oldest first', () => {
    // Telegram answers newest-first; the issue requires chronological processing, because an
    // all-clear read before the alert it cancels is a stand-down applied to nothing.
    const selection = selectWindowMessages([[
      message(600, 105), message(1800, 104), message(3000, 103),
      message(3 * HOUR, 102), message(4 * HOUR, 101)
    ]], bounds());
    expect(selection.replay.map((entry) => entry.id)).toEqual([103, 104, 105]);
    expect(selection.window.truncatedReason).toBeNull();
    expect(selection.done).toBe(true);
    // Everything Telegram returned is counted as read, including the two past the cutoff up to and
    // including the one that ended the walk.
    expect(selection.messagesRead).toBe(4);
  });

  it('breaks a tie at the cursor second with the message id', () => {
    // A channel that publishes twice inside one second gives both posts the same `date`. Without the
    // id tie-break the second of them is either replayed forever or lost forever, depending on which
    // way the comparison rounds.
    const at = new Date(NOW.getTime() - 2 * HOUR * 1000);
    const selection = selectWindowMessages([[
      { id: 42, date: Math.floor(at.getTime() / 1000), message: 'друге' },
      { id: 41, date: Math.floor(at.getTime() / 1000), message: 'перше' }
    ]], bounds({ from: at, cursorExternalId: 41 }));
    expect(selection.replay.map((entry) => entry.id)).toEqual([42]);
  });

  it('counts a text-free post as read and never replays it', () => {
    const selection = selectWindowMessages([[
      message(600, 9, null), message(700, 8, '   '), message(800, 7, 'справжнє')
    ]], bounds({ pageSize: 3 }));
    expect(selection.replay.map((entry) => entry.id)).toEqual([7]);
    expect(selection.messagesRead).toBe(3);
  });

  it('stops at MAX_PAGES and says so: 250 messages, MAX_PAGES=2', () => {
    // Three full pages are offered; two are read. The remaining history is not lost silently — the
    // status is `truncated` and `/ops` shows «дозбір обмежено».
    const pages = [page(100, 1000, 60), page(100, 900, 1060), page(50, 800, 2060)];
    const selection = selectWindowMessages(pages, bounds({ maxPages: 2, pageSize: 100 }));
    expect(selection.pagesRead).toBe(2);
    expect(selection.replay).toHaveLength(200);
    expect(selection.window.truncatedReason).toBe('pages');
    expect(selection.done).toBe(true);
  });

  it('stops at MAX_MESSAGES and says so', () => {
    const selection = selectWindowMessages([page(100, 1000, 60, 1)], bounds({ maxMessages: 40, pageSize: 100 }));
    expect(selection.replay).toHaveLength(40);
    expect(selection.window.truncatedReason).toBe('count');
    // The newest forty, not the oldest: the walk is newest-first, and what a reader needs back most
    // is the recent end of the gap.
    expect(selection.replay.at(-1)!.id).toBe(1000);
    expect(selection.replay[0]!.id).toBe(961);
    expect(selection.done).toBe(true);
  });

  it('reports the age cutoff when it landed mid-page, and prefers the tighter cap when both fired', () => {
    const midPage = [message(600, 5), message(1200, 4), message(4 * HOUR, 3), message(5 * HOUR, 2)];
    const aged = selectWindowMessages([midPage], bounds({ ageTruncated: true, pageSize: 100 }));
    expect(aged.replay.map((entry) => entry.id)).toEqual([4, 5]);
    expect(aged.window.truncatedReason).toBe('age');

    // `count` is strictly tighter than `age`: hitting it means the age floor was never reached, so
    // reporting «обмежено віком» there would send an operator to the wrong setting.
    const both = selectWindowMessages([page(100, 1000, 60, 1)],
      bounds({ ageTruncated: true, maxMessages: 10, pageSize: 100 }));
    expect(both.window.truncatedReason).toBe('count');
  });

  it('treats a short page as the natural end of the channel, not as truncation', () => {
    const selection = selectWindowMessages([page(7, 500, 60)], bounds({ pageSize: 100 }));
    expect(selection.replay).toHaveLength(7);
    expect(selection.window.truncatedReason).toBeNull();
    expect(selection.done).toBe(true);
  });

  it('asks for another page while a full page is still entirely inside the window', () => {
    const first = page(100, 1000, 60, 1);
    const selection = selectWindowMessages([first], bounds({ pageSize: 100, maxPages: 5 }));
    expect(selection.done).toBe(false);
    // The offset for the next request is the oldest id seen — Telegram returns strictly smaller ids.
    expect(selection.nextOffsetId).toBe(901);
  });

  it('is empty and done when the cursor is already at the head', () => {
    // The rerun case, and the reason a replayed window is free: the archive cursor has moved past
    // everything the channel published, so the selection is empty before any message is touched.
    const selection = selectWindowMessages([[message(600, 105), message(1800, 104)]],
      bounds({ from: new Date(NOW.getTime() - 300 * 1000) }));
    expect(selection.replay).toEqual([]);
    expect(selection.done).toBe(true);
    expect(selection.window.truncatedReason).toBeNull();
  });

  it('stops cleanly on an empty page', () => {
    const selection = selectWindowMessages([[]], bounds());
    expect(selection.replay).toEqual([]);
    expect(selection.pagesRead).toBe(1);
    expect(selection.done).toBe(true);
  });
});
