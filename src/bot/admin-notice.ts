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
  | 'collector_unsubscribed'
  | 'app_settings_read_failed';

/**
 * `clear` is emitted by {@link notifyUnsubscribedChannels} and by nothing else.
 *
 * It is the same argument `disabled` makes one paragraph below: a check that ran and found nothing
 * must be distinguishable from a check that never ran. Without the series, «жодного повідомлення
 * про непідписані канали» is ambiguous between «усі канали підписані» and «детектор не
 * викликається», and those two are one broken call site apart.
 */
export type AdminNoticeOutcome = 'sent' | 'failed' | 'suppressed' | 'disabled' | 'clear';

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
 * Останній оголошений набір непідписаних каналів, рядком.
 *
 * Один рядок, не множина: сам перелік уже обмежений реєстром, а тут потрібне лише «той самий набір
 * чи інший». Пусто — коли непідписаних немає; тоді наступна поява оголошується негайно, не чекаючи
 * півгодини, бо саме ця поява і є подією.
 */
let unsubscribedSignature = '';

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
  unsubscribedSignature = '';
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

/** Один зв'язаний маршрут, якого немає серед діалогів акаунта колектора. */
export interface UnsubscribedChannel {
  /** Хендл у нижньому регістрі, як його зберігає `sources.telegram_username`. */
  username: string;
  sourceId: string;
  /** `alert` іде в реконсиляцію тривог, `classifier` — у `processMessage`. Ціна мовчання різна. */
  kind: 'alert' | 'classifier';
}

/**
 * Скільки каналів називаємо поіменно, перш ніж дописати «та ще N».
 *
 * Вісім — це рядок, який ще читається в сповіщенні Telegram. Реєстр має 54 маршрути; без межі
 * невдалий прохід резолву перетворив би повідомлення оператору на дамп реєстру.
 */
const UNSUBSCRIBED_NAMED_LIMIT = 8;

const UNSUBSCRIBED_KIND_WORDS: Record<UnsubscribedChannel['kind'], string> = {
  alert: 'тривоги', classifier: 'моніторинг'
};

/**
 * Канал зв'язано, але акаунт на нього не підписаний — тобто джерело є, а повідомлень не буде.
 *
 * ================================================================================================
 * Чому це окрема причина, а не `collector_degraded`
 * ================================================================================================
 *
 * `degraded` означає «маршрут НЕ зв'язано»: його видно одразу, він не рахується ніде й лікується
 * виправленням хендла. Тут протилежне: `resolveChannelPeers` дістає peer id через
 * `contacts.ResolveUsername`, маршрут потрапляє в `byPeerId`, колектор лишається `ready`, а
 * heartbeat щохвилини пише джерелу `last_success_at`. Джерело звітує «актуальне» і не доставляє
 * нічого. Сховати це під словом «деградував» означало б віддати його кулдауну чужої причини — і
 * втратити рівно тоді, коли колектор здоровий, а канал мовчить.
 *
 * ================================================================================================
 * Чому зміна набору пробиває кулдаун
 * ================================================================================================
 *
 * Кулдаун {@link notifyAdmin} — півгодинний і по причині. Для цього детектора це дало б рівно ту
 * поведінку, заради якої він і писався: оператор реєструє канал А (не підписаний) — лінія пішла;
 * через п'ять хвилин реєструє канал Б (теж не підписаний) — лінію проковтнуло, і оператор вважає,
 * що з Б усе гаразд. Тому НОВИЙ набір скидає позначку часу й оголошується негайно, а незмінний
 * лишається під звичайним кулдауном: постійна умова повторюється раз на півгодини, як і решта.
 *
 * Порожній список — не «нічого не робимо»: він гасить підпис, тож наступна поява буде оголошена
 * одразу, і піднімає серію `clear`, яка відрізняє «перевірили й усе добре» від «не перевіряли».
 *
 * Ніколи не кидає у викликача: як і {@link notifyAdmin}, це побічна лінія на шляху, який мусить
 * тривати. Очікуваний виклик — `void notifyUnsubscribedChannels(...)`.
 */
export async function notifyUnsubscribedChannels(
  channels: readonly UnsubscribedChannel[], log?: { warn?: Function; error?: Function }
): Promise<AdminNoticeOutcome> {
  const reason: AdminNoticeReason = 'collector_unsubscribed';
  // Сортуємо, бо підпис має залежати від НАБОРУ, а не від порядку, у якому цей прохід резолву
  // перебирав діалоги: інакше та сама трійка каналів оголошувалася б щопроходу як нова.
  const sorted = [...channels].sort((left, right) => left.username.localeCompare(right.username));
  const signature = sorted.map((channel) => `${channel.kind}:${channel.username}`).join(',');
  if (!signature) {
    unsubscribedSignature = '';
    adminNotices.inc({ reason, outcome: 'clear' });
    return 'clear';
  }
  if (signature !== unsubscribedSignature) lastSentAt.delete(reason);
  unsubscribedSignature = signature;
  const named = sorted.slice(0, UNSUBSCRIBED_NAMED_LIMIT)
    .map((channel) => `@${channel.username} (${UNSUBSCRIBED_KIND_WORDS[channel.kind]})`).join(', ');
  const rest = sorted.length - Math.min(sorted.length, UNSUBSCRIBED_NAMED_LIMIT);
  // Дія стоїть у тексті, бо вона єдина: підписати акаунт колектора. Кодом це не лікується, і
  // повідомлення, яке цього не каже, відправляє оператора шукати помилку там, де її немає.
  return notifyAdmin(reason, `${sorted.length} канал(ів) зв'язано, але акаунт колектора на них не `
    + `підписаний: ${named}${rest > 0 ? ` та ще ${rest}` : ''}. Живих оновлень від них не буде, `
    + 'а джерела звітують як здорові — підпишіть акаунт на канал.', log);
}
