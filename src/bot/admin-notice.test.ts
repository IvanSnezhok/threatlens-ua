import { Registry } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config.js';
import {
  ADMIN_NOTICE_COOLDOWN_MS, notifyAdmin, registerAdminNoticeMetrics, resetAdminNotices,
  setAdminNoticeBot, type AdminNoticeReason
} from './admin-notice.js';

/**
 * The one consumer `TELEGRAM_ADMIN_CHAT_ID` finally has, tested without a bot and without a clock.
 *
 * Three properties, and each of them is a way this could have gone wrong in production rather than
 * an implementation detail:
 *
 *   1. **An empty chat id is a configuration, not a fault.** The overwhelming majority of
 *      deployments will never set it, and every reason that calls `notifyAdmin` sits on a path that
 *      is already degraded. A notifier that threw, retried or logged an error there would turn "no
 *      operator configured" into a second incident on top of the first.
 *   2. **A cooldown per reason, not per process.** The reasons are independent conditions: a
 *      collector flood wait must not silence a settings degrade half an hour later.
 *   3. **A refused send is counted, never thrown.** The caller is `setCollectorStatus` or the boot
 *      sequence; neither has anywhere to put an exception, and a rejected promise floating out of a
 *      `void` call would be an unhandled rejection in a process that is already in trouble.
 *
 * The state-flip debounce that keeps a retry loop from calling this every ten minutes belongs to the
 * collector and is pinned in `src/sources/telegram.test.ts`; the two bounds are deliberately
 * separate, because either alone leaves a hole.
 */

/** A bot double that records the text it was handed, or refuses like a real API error would. */
function recorder(behaviour: 'ok' | 'throw' = 'ok') {
  const sent: Array<{ chatId: string; text: string }> = [];
  setAdminNoticeBot({
    api: {
      async sendMessage(chatId: string, text: string) {
        sent.push({ chatId, text });
        if (behaviour === 'throw') throw Object.assign(new Error('Forbidden'), { error_code: 403 });
        return {};
      }
    }
  });
  return sent;
}

const ADMIN_CHAT_ID = config.TELEGRAM_ADMIN_CHAT_ID;

beforeEach(() => {
  resetAdminNotices();
  config.TELEGRAM_ADMIN_CHAT_ID = '4242';
});

afterEach(() => {
  vi.useRealTimers();
  resetAdminNotices();
  config.TELEGRAM_ADMIN_CHAT_ID = ADMIN_CHAT_ID;
});

describe('who gets a notice at all', () => {
  it('sends one plain-text line carrying a timestamp to the configured chat', async () => {
    const sent = recorder();
    expect(await notifyAdmin('collector_degraded', 'колектор Telegram деградував')).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).toBe('4242');
    expect(sent[0]?.text).toContain('колектор Telegram деградував');
    // Kyiv wall-clock, through the same `humanMoment` every other reader-facing time goes through.
    expect(sent[0]?.text).toMatch(/⚠️ ThreatLens, \d{2}:\d{2} — /);
  });

  it('does nothing when TELEGRAM_ADMIN_CHAT_ID is empty', async () => {
    const sent = recorder();
    config.TELEGRAM_ADMIN_CHAT_ID = '';
    expect(await notifyAdmin('collector_failed', 'колектор Telegram не працює')).toBe('disabled');
    expect(sent).toEqual([]);
  });

  it('treats whitespace as empty rather than as a chat id', async () => {
    const sent = recorder();
    config.TELEGRAM_ADMIN_CHAT_ID = '   ';
    expect(await notifyAdmin('collector_failed', 'колектор Telegram не працює')).toBe('disabled');
    expect(sent).toEqual([]);
  });

  it('does nothing when createBot() declined and there is no bot to send with', async () => {
    // `TELEGRAM_MODE=disabled`, or a deployment with no token: `src/index.ts` hands over `null`.
    setAdminNoticeBot(null);
    expect(await notifyAdmin('app_settings_read_failed', 'app_settings не прочитано')).toBe('disabled');
  });

  it('reads the chat id at the moment of the event, which is what makes the key hot', async () => {
    const sent = recorder();
    config.TELEGRAM_ADMIN_CHAT_ID = '';
    expect(await notifyAdmin('collector_degraded', 'перше')).toBe('disabled');
    // /ops writes a value into the live `config` object; the very next notice must use it, with no
    // restart and no cache in between. That is the whole of `apply: 'hot'` for this key.
    config.TELEGRAM_ADMIN_CHAT_ID = '777';
    expect(await notifyAdmin('collector_failed', 'друге')).toBe('sent');
    expect(sent.map((entry) => entry.chatId)).toEqual(['777']);
  });
});

describe('cooldown', () => {
  it('suppresses a repeat of the same reason inside the window and lets it through after', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T09:00:00Z'));
    const sent = recorder();

    expect(await notifyAdmin('collector_degraded', 'перше')).toBe('sent');
    vi.advanceTimersByTime(ADMIN_NOTICE_COOLDOWN_MS - 1_000);
    expect(await notifyAdmin('collector_degraded', 'друге')).toBe('suppressed');
    expect(sent).toHaveLength(1);

    // A condition that is still true half an hour later is worth saying again — this is the bound
    // on a flapping transition, not a mute.
    vi.advanceTimersByTime(2_000);
    expect(await notifyAdmin('collector_degraded', 'третє')).toBe('sent');
    expect(sent.map((entry) => entry.text.split(' — ')[1])).toEqual(['перше', 'третє']);
  });

  it('holds one window per reason, so one condition cannot silence another', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T09:00:00Z'));
    const sent = recorder();
    const reasons: AdminNoticeReason[] = [
      'collector_degraded', 'collector_flood_wait', 'collector_failed', 'app_settings_read_failed'
    ];
    for (const reason of reasons) expect(await notifyAdmin(reason, reason)).toBe('sent');
    expect(sent).toHaveLength(4);
    for (const reason of reasons) expect(await notifyAdmin(reason, reason)).toBe('suppressed');
    expect(sent).toHaveLength(4);
  });

  it('lets only one of two concurrent calls on the same reason reach Telegram', async () => {
    // The mark is written before the `await`, so two degradations landing in the same tick cannot
    // both pass the window check. Without that ordering the cooldown would be advisory.
    const sent = recorder();
    const outcomes = await Promise.all([
      notifyAdmin('collector_flood_wait', 'перше'),
      notifyAdmin('collector_flood_wait', 'друге')
    ]);
    expect(outcomes.sort()).toEqual(['sent', 'suppressed']);
    expect(sent).toHaveLength(1);
  });
});

describe('a send Telegram refused', () => {
  it('counts the failure, returns it, and never throws into the degraded caller', async () => {
    const registry = new Registry();
    registerAdminNoticeMetrics(registry);
    const before = await counted(registry, 'app_settings_read_failed', 'failed');
    const logged: unknown[] = [];
    recorder('throw');

    const outcome = await notifyAdmin(
      'app_settings_read_failed', 'app_settings не прочитано',
      { error: (fields: unknown) => { logged.push(fields); } }
    );

    expect(outcome).toBe('failed');
    expect(await counted(registry, 'app_settings_read_failed', 'failed')).toBe(before + 1);
    expect(logged).toHaveLength(1);
  });

  it('does not reopen the window for a reason whose send failed', async () => {
    // Deliberate: a bot that refuses every call would otherwise retry on every transition, which is
    // the spam the cooldown exists to prevent — and the operator is no better informed either way.
    const sent = recorder('throw');
    expect(await notifyAdmin('collector_failed', 'перше')).toBe('failed');
    expect(await notifyAdmin('collector_failed', 'друге')).toBe('suppressed');
    expect(sent).toHaveLength(1);
  });
});

describe('metric registration', () => {
  it('attaches the counter and is safe to call twice on the same registry', () => {
    const registry = new Registry();
    registerAdminNoticeMetrics(registry);
    expect(() => registerAdminNoticeMetrics(registry)).not.toThrow();
    expect(registry.getMetricsAsArray().map((metric) => metric.name))
      .toEqual(['threatlens_admin_notices_total']);
  });
});

/** One series of the counter, or zero when it has never been incremented. */
async function counted(registry: Registry, reason: string, outcome: string): Promise<number> {
  const metric = registry.getSingleMetric('threatlens_admin_notices_total') as unknown as {
    get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }>;
  };
  const { values } = await metric.get();
  return values.find((entry) => entry.labels.reason === reason && entry.labels.outcome === outcome)?.value ?? 0;
}
