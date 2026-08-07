import { config } from '../config.js';
import {
  ALERT_CHANNEL_SOURCE_ID, MONITOR_ADAPTER_TYPE, ingestAlertChannelMessages, loadAlertChannels,
  loadMonitoredTelegramChannels, processMessage,
  type AlertChannelMessage, type AlertTelegramChannel, type MonitoredTelegramChannel
} from '../services/ingestion.js';
import { markSourceError, markSourceSuccess } from '../services/operations.js';

/**
 * Last-resort definition of the Air Force channel.
 *
 * The channel list is read from `sources`, but the Air Force channel is an official Tier A source
 * that has been collected since the first release and must keep working exactly as it does now. If
 * the registry query fails, or the row has lost its `telegram_username`, the collector falls back to
 * this pair rather than starting up subscribed to nothing. The OSINT monitors have no such fallback:
 * a monitor the database does not list is a monitor that is not read.
 */
const AIR_FORCE_SOURCE_ID = 'air-force';
const AIR_FORCE_CHANNEL = 'kpszsu';

interface CollectorLogger { info: Function; warn?: Function; error: Function }

/**
 * What one subscribed username is for.
 *
 * `kind` is the routing decision, made once at connect time from the registry and never re-derived
 * from the text of a message. An `alert` route reaches the alert reconciler and nothing else; a
 * `classifier` route reaches `processMessage` and nothing else. Comparing a username against a
 * single configured handle — which is what this used to do — could only ever protect one channel.
 */
export type ChannelRoute =
  | { kind: 'alert'; sourceId: string; username: string }
  | { kind: 'classifier'; sourceId: string; username: string; adapterType: string };

/**
 * Resolves the channels the collector subscribes to, keyed by lower-cased username.
 *
 * The alert channels are inserted first and the classifier channels can never overwrite them: a
 * handle that somehow appears on both an `mtproto_alert_channel` row and a monitoring row stays an
 * alert route. That is the whole routing guarantee, and it is the one that stops an official
 * administration channel from being processed as OSINT and having its air-raid alerts filed as
 * unverified threat events.
 */
export async function resolveChannelRoutes(log: CollectorLogger): Promise<Map<string, ChannelRoute>> {
  const routes = new Map<string, ChannelRoute>();

  // A failed registry read must not leave the deployment subscribed to nothing on the alert path.
  // `null` means "the query failed", which is the only case the configured fallback covers; an
  // empty list means the catalogue says no alert channel is switched on, and that is obeyed.
  const alertChannels = await loadAlertChannels().catch((error) => {
    log.error({ error }, 'alert channel registry could not be read; falling back to the configured channel');
    return null;
  });
  const alertFallback: AlertTelegramChannel[] =
    config.ALERT_CHANNEL_ENABLED && config.ALERT_CHANNEL_USERNAME
      ? [{ sourceId: ALERT_CHANNEL_SOURCE_ID, username: config.ALERT_CHANNEL_USERNAME }]
      : [];
  for (const channel of alertChannels ?? alertFallback) {
    routes.set(channel.username, { kind: 'alert', sourceId: channel.sourceId, username: channel.username });
  }

  const monitored = await loadMonitoredTelegramChannels().catch((error) => {
    log.error({ error }, 'monitored channel registry could not be read; falling back to the Air Force channel');
    return [] as MonitoredTelegramChannel[];
  });
  const classifier = new Map<string, MonitoredTelegramChannel>();
  for (const channel of monitored) classifier.set(channel.username, channel);
  if (![...classifier.values()].some((channel) => channel.sourceId === AIR_FORCE_SOURCE_ID)) {
    classifier.set(AIR_FORCE_CHANNEL, {
      sourceId: AIR_FORCE_SOURCE_ID, username: AIR_FORCE_CHANNEL, adapterType: 'mtproto'
    });
  }
  for (const channel of classifier.values()) {
    if (routes.has(channel.username)) {
      log.warn?.({ username: channel.username, sourceId: channel.sourceId },
        'classifier row claims a handle an alert channel already owns; the alert route wins');
      continue;
    }
    routes.set(channel.username, {
      kind: 'classifier', sourceId: channel.sourceId, username: channel.username,
      adapterType: channel.adapterType
    });
  }
  return routes;
}

/**
 * Reads one channel's alert-relevant history that the collector missed while it was disconnected.
 *
 * These channels publish events, so a gap in the stream is a gap in the state: a raion whose 🔴
 * arrived while the process was down would otherwise stay clear on the map until its 🟢, and a raion
 * whose 🟢 was missed would stay under alert until the maximum-duration backstop fires. Reading the
 * tail of each channel closes both.
 *
 * The window is bounded twice — by message count and by age — and `ingestAlertChannelMessages` folds
 * it to one terminal state per location before writing anything, so nothing in the window is
 * replayed as a fresh event. An alert that both started and ended inside the window produces no
 * notification at all; only what is still true right now reaches the reconciler.
 *
 * ## Why this pages by hand instead of asking for `ALERT_CHANNEL_BACKFILL_MESSAGES` in one call
 *
 * The two bounds are not equally binding, and they are not equally binding *per channel*. The
 * national channel publishes about fifty messages an hour, so 300 messages is roughly the six-hour
 * window it is calibrated to. An oblast administration publishes one to three an hour: 300 messages
 * reaches back the better part of a week, and everything beyond the age cutoff is fetched, decoded
 * and thrown away. Requesting a page at a time and stopping as soon as a page runs past the cutoff
 * makes the count the ceiling it was meant to be and the age the bound that actually decides —
 * one round trip for a quiet channel, as many as the window needs for a busy one. With six channels
 * enabled that is roughly nine history requests per connect rather than eighteen.
 */
const BACKFILL_PAGE = 100;

async function backfillAlertChannel(
  client: any, route: ChannelRoute, log: CollectorLogger
): Promise<void> {
  if (!config.ALERT_CHANNEL_BACKFILL_MESSAGES) return;
  const cutoff = Date.now() - config.ALERT_CHANNEL_BACKFILL_SECONDS * 1000;
  const messages: AlertChannelMessage[] = [];
  let read = 0;
  let offsetId = 0;
  let reachedCutoff = false;
  while (read < config.ALERT_CHANNEL_BACKFILL_MESSAGES && !reachedCutoff) {
    const limit = Math.min(BACKFILL_PAGE, config.ALERT_CHANNEL_BACKFILL_MESSAGES - read);
    const page = await client.getMessages(route.username, offsetId ? { limit, offsetId } : { limit });
    if (!page?.length) break;
    for (const message of page) {
      read += 1;
      offsetId = Number(message.id);
      if (!message?.message) continue;
      const publishedAt = new Date(Number(message.date) * 1000);
      // Telegram returns history newest-first, so the first message older than the cutoff ends the
      // useful window and every page after it would be discarded whole.
      if (publishedAt.getTime() < cutoff) { reachedCutoff = true; break; }
      messages.push({
        externalId: String(message.id),
        publishedAt,
        editedAt: message.editDate ? new Date(Number(message.editDate) * 1000) : null,
        text: message.message,
        rawPayload: { channel: route.username, id: message.id, backfill: true }
      });
    }
    if (page.length < limit) break;
  }
  const summary = await ingestAlertChannelMessages(route.sourceId, messages, log as { warn: Function });
  log.info({
    sourceId: route.sourceId, channel: route.username, read, inWindow: messages.length,
    events: summary.events, applied: summary.applied, skippedStale: summary.skippedStale,
    unrecognized: summary.unrecognized, unresolved: summary.unresolved.length
  }, 'alert channel backlog reconciled after connect');
}

export async function startTelegramCollector(log: CollectorLogger): Promise<(() => Promise<void>) | undefined> {
  if (!config.TELEGRAM_API_ID || !config.TELEGRAM_API_HASH || !config.TELEGRAM_SESSION) return undefined;
  try {
    const [{ TelegramClient }, { StringSession }, { NewMessage }, { EditedMessage }] = await Promise.all([
      import('teleproto'), import('teleproto/sessions/index.js'), import('teleproto/events/index.js'),
      import('teleproto/events/EditedMessage.js')
    ]);
    const client = new TelegramClient(
      new StringSession(config.TELEGRAM_SESSION), Number(config.TELEGRAM_API_ID), config.TELEGRAM_API_HASH,
      { connectionRetries: 5 }
    );
    await client.connect();
    const routes = await resolveChannelRoutes(log);
    for (const route of routes.values()) {
      await markSourceSuccess(route.sourceId)
        .catch((error) => log.error({ error, sourceId: route.sourceId }, 'source could not be marked connected'));
    }

    const processEvent = async (event: any) => {
      const message = event.message;
      if (!message?.message) return;
      let route: ChannelRoute | undefined;
      try {
        const chat = await message.getChat();
        const username = chat?.username?.toLowerCase();
        if (!username) return;
        route = routes.get(username);
        if (!route) return;
        // An edit is re-processed with the *original* publication time, not the edit time. The
        // corrected text is what matters; treating the edit as a fresh event would let a correction
        // to an hours-old message restart an alert, and would break the ordering guard that makes
        // out-of-order delivery safe. Removing a location from an edited message is deliberately not
        // an all-clear: absence never ends an alert on this path, only an explicit 🟢 does.
        const publishedAt = new Date(Number(message.date) * 1000);
        const editedAt = message.editDate ? new Date(Number(message.editDate) * 1000) : undefined;
        // One username, one destination, decided from the registry before anything is parsed. An
        // alert route returns here and can never fall through to the classifier; a classifier route
        // never reaches the alert reconciler, because it is a different branch entirely.
        if (route.kind === 'alert') {
          await ingestAlertChannelMessages(route.sourceId, [{
            externalId: String(message.id),
            publishedAt,
            editedAt: editedAt ?? null,
            text: message.message,
            rawPayload: { channel: username, id: message.id }
          }], log as { warn: Function });
          return;
        }
        await processMessage({
          sourceId: route.sourceId,
          externalId: String(message.id),
          publishedAt,
          editedAt,
          text: message.message,
          rawPayload: { channel: username, id: message.id }
        }, { monitor: route.adapterType === MONITOR_ADAPTER_TYPE });
      } catch (error) {
        // Only the source the message actually belongs to is marked in error. Attributing a failure
        // to a default source would report an outage on a channel that is working, and — worse for
        // an alert channel — would hide the one that is not.
        if (route) await markSourceError(route.sourceId, error).catch(() => undefined);
        log.error({ error, sourceId: route?.sourceId ?? null }, 'MTProto message processing failed');
      }
    };

    const chats = [...routes.keys()];
    client.addEventHandler(processEvent, new NewMessage({ chats }));
    client.addEventHandler(processEvent, new EditedMessage({ chats }));

    for (const route of routes.values()) {
      if (route.kind !== 'alert') continue;
      // A failed backlog read must not take the live stream down with it, and must not stop the
      // other channels being backfilled: the collector is already receiving new messages, and the
      // maximum-duration backstop covers whatever the gap left behind.
      await backfillAlertChannel(client, route, log).catch((error) =>
        log.error({ error, sourceId: route.sourceId }, 'alert channel backlog reconciliation failed'));
    }

    // Every channel the collector is subscribed to, alert and classifier alike. A source that is
    // never marked successful reports `unknown` health forever — `updateSourceFreshness` only moves
    // rows from `current` to `stale` — so its silence during a quiet night is indistinguishable
    // from a dead connection, and a newly enabled Tier A row would never leave `unknown` at all.
    const heartbeatSources = [...new Set([...routes.values()].map((route) => route.sourceId))];
    const heartbeat = setInterval(() => {
      for (const sourceId of heartbeatSources) {
        markSourceSuccess(sourceId).catch((error) => log.error({ error, sourceId }, 'MTProto heartbeat failed'));
      }
    }, 60_000);
    heartbeat.unref();
    log.info({
      chats,
      alertChannels: [...routes.values()].filter((route) => route.kind === 'alert').length,
      sources: heartbeatSources.length
    }, 'MTProto collector connected');
    return async () => { clearInterval(heartbeat); await client.disconnect(); };
  } catch (error) {
    log.error({ error }, 'MTProto collector failed to start');
    return undefined;
  }
}
