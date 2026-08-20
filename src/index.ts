import { buildServer } from './api/server.js';
import { notifyAdmin, setAdminNoticeBot } from './bot/admin-notice.js';
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
import { startAnalyticalOutcomeScheduler } from './services/analytical-outcomes.js';
import { startAttackStatsScheduler } from './services/attack-stats.js';
import { startModelContextScheduler } from './services/model-context.js';
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
const settings = await loadAppSettings({
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
// Раз на десять хвилин: оцінює, чим закінчилися вже неактуальні аналітичні промоції моделі. Нічого
// не публікує й нічого не змінює — лише пише рядок у `analytical_outcomes`, з якого /ops рахує
// точність за порогом упевненості. На інсталяції, де промоції ніколи не вмикали, прохід читає
// порожній частковий індекс і завершується одразу.
const stopAnalyticalOutcomes = startAnalyticalOutcomeScheduler(app.log);
// Раз на хвилину: плановий прохід статистики ударів після ATTACK_STATS_RUN_TIME (регіони, які обрали
// користувачі або на які підписані чати з аналітикою) і осушення черги — один запуск моделі водночас,
// без таймауту на сам запуск. З вимкненим перемикачем у /ops тик читає одну таблицю й виходить.
const stopAttackStats = startAttackStatsScheduler(app.log);
// Контексти по локаціях для запитів моделі (міграція 049): пише початок і кінець офіційних тривог із
// внутрішньої шини і раз на шість годин прибирає локації, про які давно не згадували. Самі записи про
// повідомлення робить конвеєр класифікації. ПІСЛЯ eventHub.start() з тієї самої причини, що й
// перерахунок аналітики: слухач хаба, який не опитує, не спрацює ніколи.
const stopModelContext = startModelContextScheduler(app.log);
const bot = createBot();
// BEFORE the collector starts, because the collector's very first pass can land in `failed` or
// `flood_wait` and that transition is one of the three this notifier exists for.
setAdminNoticeBot(bot);
// The settings degrade is announced HERE and not from the `catch` that increments
// `threatlens_app_settings_read_failures_total`, for one ordering reason: `loadAppSettings()` runs
// before `createBot()` — it has to, because the token it would build the bot from may be a stored
// row — so at the moment of the failure there is no bot to send anything with. `degraded` is the
// same fact, carried forward the four lines it takes for one to exist. There is exactly one caller
// of `loadAppSettings`, so nothing else can increment that counter unobserved.
if (settings.degraded) {
  void notifyAdmin(
    'app_settings_read_failed',
    'app_settings не прочитано на старті: процес працює на .env, збережені налаштування не діють',
    app.log
  );
}
const stopNotifications = startNotificationWorkers(bot, app.log);
const stopCollector = await startTelegramCollector(app.log);

if (bot) {
  void bot.start({ onStart: async (info) => {
    await bot.api.setMyCommands([
      { command: 'start', description: 'Запустити або відновити бот' },
      { command: 'status', description: 'Поточний стан підписок' },
      { command: 'city', description: 'Додати область або місто' },
      { command: 'analytics', description: 'Оцінка ризику на 6 годин' },
      { command: 'debrief', description: 'Розбір останньої тривоги' },
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
  stopIngestion(); stopRisk(); stopOperations(); stopNightlyDigests(); stopLocationCatalog(); stopOccupation(); stopSourceTrust(); stopAnalyticalOutcomes(); stopAttackStats(); stopModelContext(); stopAnalytics(); stopAnalyticsRecompute(); stopNotifications(); eventHub.stop();
  bot?.stop();
  await stopCollector?.();
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
