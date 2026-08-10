import { buildServer } from './api/server.js';
import { createBot } from './bot/bot.js';
import { startNotificationWorkers } from './bot/outbox.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { seedDemoData, startIngestionScheduler } from './services/ingestion.js';
import { loadAppSettings } from './services/app-settings.js';
import { startAnalyticsScheduler } from './services/analytics.js';
import { startAnalyticsRecomputeScheduler } from './services/analytics-scheduler.js';
import { startRiskScheduler } from './services/risk.js';
import { startOperationsScheduler } from './services/operations.js';
import { startNightlyDigestScheduler } from './services/nightly-digest.js';
import { startLocationCatalogScheduler } from './services/location-catalog.js';
import { startOccupationScheduler } from './services/occupation.js';
import { startSourceTrustScheduler } from './services/source-trust.js';
import { eventHub } from './services/sse.js';
import { startTelegramCollector } from './sources/telegram.js';

await migrate();
// AFTER migrate(), because the table it reads is created by 030; BEFORE buildServer(), because a
// route that answered a request from `.env` and then from the store a moment later would be two
// different deployments inside one boot. Fails OPEN: an unreadable store leaves the environment's
// configuration standing and increments `threatlens_app_settings_read_failures_total`.
//
// `console` rather than `app.log`: the server, and therefore the pino instance, does not exist yet,
// and a boot-time degrade that left no line in `docker compose logs` would be discoverable only on
// /metrics.
await loadAppSettings({
  warn: (fields, message) => console.warn(message, fields),
  error: (fields, message) => console.error(message, fields)
});
const app = await buildServer();
await seedDemoData();
eventHub.start();
// After eventHub.start(): the recompute worker's only input is the hub's 'internal-event' emission,
// and a listener attached to a hub that is not polling would simply never fire.
const stopAnalyticsRecompute = startAnalyticsRecomputeScheduler(app.log);
const stopAnalytics = startAnalyticsScheduler(app.log);
const stopIngestion = startIngestionScheduler(app.log);
const stopRisk = startRiskScheduler(app.log);
const stopOperations = startOperationsScheduler(app.log);
const stopNightlyDigests = startNightlyDigestScheduler(app.log);
const stopLocationCatalog = startLocationCatalogScheduler(app.log);
const stopOccupation = startOccupationScheduler(app.log);
// Раз на добу: вікно довіри — тридцять днів, тож частіше перераховувати означало б писати історію
// заради третього знака після коми.
const stopSourceTrust = startSourceTrustScheduler(app.log);
const bot = createBot();
const stopNotifications = startNotificationWorkers(bot, app.log);
const stopCollector = await startTelegramCollector(app.log);

if (bot) {
  void bot.start({ onStart: async (info) => {
    await bot.api.setMyCommands([
      { command: 'start', description: 'Запустити або відновити бот' },
      { command: 'status', description: 'Поточний стан підписок' },
      { command: 'city', description: 'Додати область або місто' },
      { command: 'analytics', description: 'Оцінка ризику на 6 годин' },
      { command: 'channels', description: 'Рекомендовані Telegram-канали' },
      { command: 'settings', description: 'Налаштувати підписки' },
      { command: 'help', description: 'Довідка та правила безпеки' }
    ]);
    app.log.info({ username: info.username }, 'Telegram bot started');
  } });
} else app.log.warn('Telegram bot disabled: token not configured');

await app.listen({ port: config.PORT, host: '0.0.0.0' });

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  // `stopAnalyticsRecompute()` runs BEFORE `eventHub.stop()`: it detaches the listener while the hub
  // is still the thing that would call it, and bumps the generation token so an in-flight floor
  // callback cannot re-arm itself against a pool this function is about to end.
  stopIngestion(); stopRisk(); stopOperations(); stopNightlyDigests(); stopLocationCatalog(); stopOccupation(); stopSourceTrust(); stopAnalytics(); stopAnalyticsRecompute(); stopNotifications(); eventHub.stop();
  bot?.stop();
  await stopCollector?.();
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
