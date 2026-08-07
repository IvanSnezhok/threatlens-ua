import { buildServer } from './api/server.js';
import { createBot } from './bot/bot.js';
import { startNotificationWorkers } from './bot/outbox.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { seedDemoData, startIngestionScheduler } from './services/ingestion.js';
import { startAnalyticsScheduler } from './services/analytics.js';
import { startRiskScheduler } from './services/risk.js';
import { startOperationsScheduler } from './services/operations.js';
import { startNightlyDigestScheduler } from './services/nightly-digest.js';
import { startLocationCatalogScheduler } from './services/location-catalog.js';
import { startOccupationScheduler } from './services/occupation.js';
import { eventHub } from './services/sse.js';
import { startTelegramCollector } from './sources/telegram.js';

await migrate();
const app = await buildServer();
await seedDemoData();
eventHub.start();
const stopAnalytics = startAnalyticsScheduler(app.log);
const stopIngestion = startIngestionScheduler(app.log);
const stopRisk = startRiskScheduler(app.log);
const stopOperations = startOperationsScheduler(app.log);
const stopNightlyDigests = startNightlyDigestScheduler(app.log);
const stopLocationCatalog = startLocationCatalogScheduler(app.log);
const stopOccupation = startOccupationScheduler(app.log);
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
  stopIngestion(); stopRisk(); stopOperations(); stopNightlyDigests(); stopLocationCatalog(); stopOccupation(); stopAnalytics(); stopNotifications(); eventHub.stop();
  bot?.stop();
  await stopCollector?.();
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
