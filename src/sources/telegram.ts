import { config } from '../config.js';
import {
  ALERT_CHANNEL_SOURCE_ID, enableAlertChannelSource, ingestAlertChannelMessages, processMessage,
  type AlertChannelMessage
} from '../services/ingestion.js';
import { markSourceError, markSourceSuccess } from '../services/operations.js';

const AIR_FORCE_CHANNEL = 'kpszsu';

interface CollectorLogger { info: Function; warn?: Function; error: Function }

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
      import('telegram'), import('telegram/sessions/index.js'), import('telegram/events/index.js'),
      import('telegram/events/EditedMessage.js')
    ]);
    const client = new TelegramClient(
      new StringSession(config.TELEGRAM_SESSION), Number(config.TELEGRAM_API_ID), config.TELEGRAM_API_HASH,
      { connectionRetries: 5 }
    );
    await client.connect();
    await markSourceSuccess('air-force');

    const processEvent = async (event: any) => {
      const message = event.message;
      if (!message?.message) return;
      let username: string | undefined;
      try {
        const chat = await message.getChat();
        username = chat?.username?.toLowerCase();
        if (username !== AIR_FORCE_CHANNEL && username !== alertChannel) return;
        // An edit is re-processed with the *original* publication time, not the edit time. The
        // corrected text is what matters; treating the edit as a fresh event would let a correction
        // to an hours-old message restart an alert, and would break the ordering guard that makes
        // out-of-order delivery safe. Removing a location from an edited message is deliberately not
        // an all-clear: absence never ends an alert on this path, only an explicit 🟢 does.
        const publishedAt = new Date(Number(message.date) * 1000);
        const editedAt = message.editDate ? new Date(Number(message.editDate) * 1000) : undefined;
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
        await processMessage({
          sourceId: 'air-force',
          externalId: String(message.id),
          publishedAt,
          editedAt,
          text: message.message,
          rawPayload: { channel: username, id: message.id }
        });
      } catch (error) {
        const sourceId = username === alertChannel ? ALERT_CHANNEL_SOURCE_ID : 'air-force';
        await markSourceError(sourceId, error).catch(() => undefined);
        log.error({ error, sourceId }, 'MTProto message processing failed');
      }
    };

    const chats = alertChannelEnabled ? [AIR_FORCE_CHANNEL, alertChannel] : [AIR_FORCE_CHANNEL];
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

    const heartbeatSources = alertChannelEnabled ? ['air-force', ALERT_CHANNEL_SOURCE_ID] : ['air-force'];
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
