import { config } from '../config.js';
import {
  ALERT_CHANNEL_SOURCE_ID, MONITOR_ADAPTER_TYPE, enableAlertChannelSource,
  ingestAlertChannelMessages, loadMonitoredTelegramChannels, processMessage,
  type AlertChannelMessage, type MonitoredTelegramChannel
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
 * Resolves the channels the collector subscribes to, keyed by lower-cased username.
 *
 * The alert channel is never in this map — `loadMonitoredTelegramChannels` excludes it by adapter
 * type and by name — so no entry here can reach the alert reconciler.
 */
async function resolveChannelRoutes(log: CollectorLogger): Promise<Map<string, MonitoredTelegramChannel>> {
  const channels = await loadMonitoredTelegramChannels().catch((error) => {
    log.error({ error }, 'monitored channel registry could not be read; falling back to the Air Force channel');
    return [] as MonitoredTelegramChannel[];
  });
  const routes = new Map<string, MonitoredTelegramChannel>();
  for (const channel of channels) routes.set(channel.username, channel);
  if (![...routes.values()].some((channel) => channel.sourceId === AIR_FORCE_SOURCE_ID)) {
    routes.set(AIR_FORCE_CHANNEL, {
      sourceId: AIR_FORCE_SOURCE_ID, username: AIR_FORCE_CHANNEL, adapterType: 'mtproto'
    });
  }
  routes.delete(config.ALERT_CHANNEL_USERNAME);
  return routes;
}

/**
 * Reads the alert-relevant history the collector missed while it was disconnected.
 *
 * The channel publishes events, so a gap in the stream is a gap in the state: a raion whose 🔴
 * arrived while the process was down would otherwise stay clear on the map until its 🟢, and a raion
 * whose 🟢 was missed would stay under alert until the maximum-duration backstop fires. Reading the
 * tail of the channel closes both.
 *
 * The window is bounded twice — by message count and by age — and `ingestAlertChannelMessages` folds
 * it to one terminal state per location before writing anything, so nothing in the window is
 * replayed as a fresh event. An alert that both started and ended inside the window produces no
 * notification at all; only what is still true right now reaches the reconciler.
 */
async function backfillAlertChannel(client: any, log: CollectorLogger): Promise<void> {
  if (!config.ALERT_CHANNEL_BACKFILL_MESSAGES) return;
  const cutoff = Date.now() - config.ALERT_CHANNEL_BACKFILL_SECONDS * 1000;
  const history = await client.getMessages(config.ALERT_CHANNEL_USERNAME, {
    limit: config.ALERT_CHANNEL_BACKFILL_MESSAGES
  });
  const messages: AlertChannelMessage[] = [];
  for (const message of history ?? []) {
    if (!message?.message) continue;
    const publishedAt = new Date(Number(message.date) * 1000);
    if (publishedAt.getTime() < cutoff) continue;
    messages.push({
      externalId: String(message.id),
      publishedAt,
      editedAt: message.editDate ? new Date(Number(message.editDate) * 1000) : null,
      text: message.message,
      rawPayload: { channel: config.ALERT_CHANNEL_USERNAME, id: message.id, backfill: true }
    });
  }
  const summary = await ingestAlertChannelMessages(messages, log as { warn: Function });
  log.info({
    sourceId: ALERT_CHANNEL_SOURCE_ID, read: messages.length, events: summary.events,
    applied: summary.applied, skippedStale: summary.skippedStale,
    unrecognized: summary.unrecognized, unresolved: summary.unresolved.length
  }, 'alert channel backlog reconciled after connect');
}

export async function startTelegramCollector(log: CollectorLogger): Promise<(() => Promise<void>) | undefined> {
  if (!config.TELEGRAM_API_ID || !config.TELEGRAM_API_HASH || !config.TELEGRAM_SESSION) return undefined;
  const alertChannel = config.ALERT_CHANNEL_USERNAME;
  const alertChannelEnabled = config.ALERT_CHANNEL_ENABLED && Boolean(alertChannel);
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
      let username: string | undefined;
      let route: MonitoredTelegramChannel | undefined;
      try {
        const chat = await message.getChat();
        username = chat?.username?.toLowerCase();
        if (!username) return;
        // An edit is re-processed with the *original* publication time, not the edit time. The
        // corrected text is what matters; treating the edit as a fresh event would let a correction
        // to an hours-old message restart an alert, and would break the ordering guard that makes
        // out-of-order delivery safe. Removing a location from an edited message is deliberately not
        // an all-clear: absence never ends an alert on this path, only an explicit 🟢 does.
        const publishedAt = new Date(Number(message.date) * 1000);
        const editedAt = message.editDate ? new Date(Number(message.editDate) * 1000) : undefined;
        // The alert channel is matched first and returns unconditionally, so its messages can never
        // fall through to the classifier — and, because `routes` never contains its username, no
        // other channel can reach the alert reconciler either. That is the whole routing guarantee:
        // one username, one destination, decided before anything is parsed.
        if (username === alertChannel) {
          if (!alertChannelEnabled) return;
          await ingestAlertChannelMessages([{
            externalId: String(message.id),
            publishedAt,
            editedAt: editedAt ?? null,
            text: message.message,
            rawPayload: { channel: username, id: message.id }
          }], log as { warn: Function });
          return;
        }
        route = routes.get(username);
        if (!route) return;
        await processMessage({
          sourceId: route.sourceId,
          externalId: String(message.id),
          publishedAt,
          editedAt,
          text: message.message,
          rawPayload: { channel: username, id: message.id }
        }, { monitor: route.adapterType === MONITOR_ADAPTER_TYPE });
      } catch (error) {
        const sourceId = username === alertChannel ? ALERT_CHANNEL_SOURCE_ID
          : route?.sourceId ?? AIR_FORCE_SOURCE_ID;
        await markSourceError(sourceId, error).catch(() => undefined);
        log.error({ error, sourceId }, 'MTProto message processing failed');
      }
    };

    const chats = [...routes.keys(), ...(alertChannelEnabled ? [alertChannel] : [])];
    client.addEventHandler(processEvent, new NewMessage({ chats }));
    client.addEventHandler(processEvent, new EditedMessage({ chats }));

    if (alertChannelEnabled) {
      await enableAlertChannelSource();
      await markSourceSuccess(ALERT_CHANNEL_SOURCE_ID);
      // A failed backlog read must not take the live stream down with it: the collector is already
      // receiving new messages, and the maximum-duration backstop covers whatever the gap left behind.
      await backfillAlertChannel(client, log)
        .catch((error) => log.error({ error }, 'alert channel backlog reconciliation failed'));
    }

    // Every channel the collector is subscribed to, not just the two it started with. A monitoring
    // source that is never marked successful reports `unknown` health forever and its silence during
    // a quiet night is indistinguishable from a dead connection.
    const heartbeatSources = [
      ...[...routes.values()].map((route) => route.sourceId),
      ...(alertChannelEnabled ? [ALERT_CHANNEL_SOURCE_ID] : [])
    ];
    const heartbeat = setInterval(() => {
      for (const sourceId of heartbeatSources) {
        markSourceSuccess(sourceId).catch((error) => log.error({ error, sourceId }, 'MTProto heartbeat failed'));
      }
    }, 60_000);
    heartbeat.unref();
    log.info({ chats }, 'MTProto collector connected');
    return async () => { clearInterval(heartbeat); await client.disconnect(); };
  } catch (error) {
    log.error({ error }, 'MTProto collector failed to start');
    return undefined;
  }
}
