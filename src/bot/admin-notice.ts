import { Counter, type Registry } from 'prom-client';
import { config } from '../config.js';
import { humanMoment } from './humanize.js';

/**
 * `TELEGRAM_ADMIN_CHAT_ID`, finally consumed: one plain-text line to the operator when the process
 * enters a state nobody would otherwise see until they opened /ops.
 *
 * ================================================================================================
 * Why this does NOT go through `notification_outbox`
 * ================================================================================================
 *
 * The outbox is subscriber machinery, top to bottom, and every part of it would be wrong here:
 *
 *   * Its fan-out selects `FROM subscriptions s JOIN telegram_users u` — an admin chat that never
 *     pressed /start has neither row, so no query in that module could ever produce a row for it.
 *   * `formatMessage` dispatches on a closed set of `notification_type` values over domain payloads
 *     (threat, alert, assessment). An operator notice is none of them.
 *   * A `403` on delivery flips `telegram_users.enabled=false`. Pointed at an operator chat that is
 *     not a user row, that is at best a no-op and at worst a write about the wrong person.
 *   * `notification_deliveries` has a foreign key to the outbox row, and the retry ladder exists to
 *     make a subscriber's warning eventually arrive. An operator notice is worth exactly one
 *     attempt: it is already stale by the second one, and the condition it reports is visible on
 *     /ops and on /metrics regardless.
 *
 * And the decisive one: every reason below is a DEGRADATION. Routing a "the collector is degraded"
 * line through a database-backed queue makes the notice least likely to arrive at precisely the
 * moment it matters. A direct `bot.api.sendMessage` inside a `try/catch` that increments a counter
 * is the honest minimal path, and the counter is what stops "the notice failed" from being silent.
 *
 * ================================================================================================
 * Anti-spam: a state flip is not enough
 * ================================================================================================
 *
 * The callers already debounce on their own transition (the collector notifies only when
 * `TelegramCollectorState` actually changes, never per tick). The cooldown here is the second
 * bound, for the case the transition itself flaps: a leg that oscillates
 * `ready → degraded → ready → degraded` produces one message per half hour per reason, not one per
 * oscillation. In-process and per reason, exactly like every other budget in this codebase
 * (`shadow-classifier.ts`, `analytics-scheduler.ts`) and for the same single-replica reason.
 *
 * The mark is written BEFORE the send and is NOT rolled back when the send fails. Two calls racing
 * on the same reason must not both reach Telegram, and a failing send that reset the mark would
 * turn a broken bot into a retry loop paced by the very transitions this is trying to summarise.
 */

/** What a notice is about. One cooldown bucket per value — see the note above. */
export type AdminNoticeReason =
  | 'collector_degraded'
  | 'collector_flood_wait'
  | 'collector_failed'
  | 'app_settings_read_failed';

export type AdminNoticeOutcome = 'sent' | 'failed' | 'suppressed' | 'disabled';

/** Thirty minutes. Long enough that a flap is one line; short enough that a real outage repeats. */
export const ADMIN_NOTICE_COOLDOWN_MS = 30 * 60_000;

/**
 * Notices, by what they were about and how they ended.
 *
 * `disabled` is a series worth having rather than a silent return: it is the answer to «чому мені
 * нічого не приходить» — the transitions are happening and `TELEGRAM_ADMIN_CHAT_ID` is empty.
 * Constructed DETACHED (`registers: []`) like every metric here; attached by
 * {@link registerAdminNoticeMetrics}.
 */
const adminNotices = new Counter({
  name: 'threatlens_admin_notices_total',
  help: 'Operator notices addressed to TELEGRAM_ADMIN_CHAT_ID, by reason and outcome',
  labelNames: ['reason', 'outcome'], registers: []
});

/** Attaches this module's counter to the one HTTP registry. Idempotent, like its neighbours. */
export function registerAdminNoticeMetrics(registry: Registry): void {
  if (!registry.getSingleMetric('threatlens_admin_notices_total')) registry.registerMetric(adminNotices);
}

/**
 * The only part of grammy this module needs.
 *
 * A structural port rather than `Bot`, so a unit test can hand in a recording double and so the
 * degraded paths that call {@link notifyAdmin} never import the bot's transitive world.
 */
export interface AdminNoticeBot {
  api: { sendMessage(chatId: string, text: string): Promise<unknown> };
}

let sender: AdminNoticeBot | null = null;
const lastSentAt = new Map<AdminNoticeReason, number>();

/**
 * Hands the notifier the process's one bot, from `src/index.ts` and nowhere else.
 *
 * Null when `createBot()` declined (no token, or `TELEGRAM_MODE=disabled`), which is a `disabled`
 * outcome and not an error: a deployment without a bot has nothing to send a notice with.
 */
export function setAdminNoticeBot(bot: AdminNoticeBot | null): void {
  sender = bot;
}

/** Test seam, the counterpart of `resetTelegramCollectorStatus()`. Production sets the bot once. */
export function resetAdminNotices(): void {
  sender = null;
  lastSentAt.clear();
}

/**
 * One line to the operator, fire and forget.
 *
 * Never rejects and never throws into its caller — every caller is on a degraded path that must
 * carry on regardless of whether Telegram answered. The returned outcome exists for the tests and
 * for a caller that wants to log the decision; ignoring it with `void` is the expected usage.
 */
export async function notifyAdmin(
  reason: AdminNoticeReason, text: string, log?: { warn?: Function; error?: Function }
): Promise<AdminNoticeOutcome> {
  const chatId = config.TELEGRAM_ADMIN_CHAT_ID.trim();
  const bot = sender;
  if (!chatId || !bot) {
    adminNotices.inc({ reason, outcome: 'disabled' });
    return 'disabled';
  }
  const now = Date.now();
  const previous = lastSentAt.get(reason);
  if (previous != null && now - previous < ADMIN_NOTICE_COOLDOWN_MS) {
    adminNotices.inc({ reason, outcome: 'suppressed' });
    return 'suppressed';
  }
  lastSentAt.set(reason, now);
  // Plain text, deliberately: no `parse_mode`, so no escaping rule stands between a machine-made
  // detail string (a username, an error code) and the operator reading it.
  const stamp = humanMoment(new Date(now)) ?? '';
  try {
    await bot.api.sendMessage(chatId, `⚠️ ThreatLens${stamp ? `, ${stamp}` : ''} — ${text}`);
    adminNotices.inc({ reason, outcome: 'sent' });
    return 'sent';
  } catch (error) {
    adminNotices.inc({ reason, outcome: 'failed' });
    log?.error?.({ error, reason }, 'admin notice could not be delivered');
    return 'failed';
  }
}
