import { config } from '../config.js';
import { processMessage } from '../services/ingestion.js';
import { markSourceError, markSourceSuccess } from '../services/operations.js';

export async function startTelegramCollector(log: { info: Function; error: Function }): Promise<(() => Promise<void>) | undefined> {
  if (!config.TELEGRAM_API_ID || !config.TELEGRAM_API_HASH || !config.TELEGRAM_SESSION) return undefined;
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
      try {
        const message = event.message;
        if (!message?.message) return;
        const chat = await message.getChat();
        const username = chat?.username?.toLowerCase();
        if (username !== 'kpszsu') return;
        await processMessage({
          sourceId: 'air-force',
          externalId: String(message.id),
          publishedAt: new Date(Number(message.date) * 1000),
          editedAt: message.editDate ? new Date(Number(message.editDate) * 1000) : undefined,
          text: message.message,
          rawPayload: { channel: username, id: message.id }
        });
      } catch (error) {
        await markSourceError('air-force', error).catch(() => undefined);
        log.error({ error }, 'MTProto message processing failed');
      }
    };
    client.addEventHandler(processEvent, new NewMessage({ chats: ['kpszsu'] }));
    client.addEventHandler(processEvent, new EditedMessage({ chats: ['kpszsu'] }));
    const heartbeat = setInterval(() => markSourceSuccess('air-force').catch((error) => log.error({ error }, 'MTProto heartbeat failed')), 60_000);
    heartbeat.unref();
    log.info('MTProto collector connected');
    return async () => { clearInterval(heartbeat); await client.disconnect(); };
  } catch (error) {
    log.error({ error }, 'MTProto collector failed to start');
    return undefined;
  }
}
