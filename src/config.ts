import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_TIMEZONE: z.string().default('Europe/Kyiv'),
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1).default('postgresql://threatlens:threatlens@localhost:5432/threatlens'),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_BOT_USERNAME: z.string().default(''),
  TELEGRAM_MODE: z.enum(['polling', 'disabled']).default('polling'),
  TELEGRAM_ADMIN_CHAT_ID: z.string().default(''),
  TELEGRAM_API_ID: z.string().default(''),
  TELEGRAM_API_HASH: z.string().default(''),
  TELEGRAM_SESSION: z.string().default(''),
  UKRAINE_ALARM_API_TOKEN: z.string().default(''),
  UKRAINE_ALARM_API_URL: z.string().url().default('https://api.ukrainealarm.com/api/v3/alerts'),
  ALERTS_IN_UA_TOKEN: z.string().default(''),
  ALERTS_IN_UA_URL: z.string().url().default('https://api.alerts.in.ua/v1/alerts/active.json'),
  DEMO_SOURCE_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  AI_BASE_URL: z.string().default(''),
  AI_API_KEY: z.string().default(''),
  AI_MODEL: z.string().default(''),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  NIGHTLY_DIGEST_TIME: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('23:20'),
  OPS_USER: z.string().default('operator'),
  OPS_PASSWORD: z.string().default('change-me'),
  METRICS_TOKEN: z.string().default(''),
  MAP_STYLE_URL: z.string().default('https://tiles.openfreemap.org/styles/dark'),
  KATOTTG_SYNC_ENABLED: z.string().default('true').transform((value) => value === 'true'),
  KATOTTG_URL: z.string().url().default('https://mindev.gov.ua/storage/app/sites/1/uploaded-files/kodifikator-07-07.xlsx'),
  KATOTTG_VERSION: z.string().default('07.07.2026'),
  OCCUPATION_SOURCE_ENABLED: z.string().default('true').transform((value) => value === 'true'),
  DEEPSTATE_API_URL: z.string().url().default('https://deepstatemap.live/api/history/last'),
  OCCUPATION_SYNC_INTERVAL_SECONDS: z.coerce.number().int()
    .min(3600, 'Occupation source must not be polled more than once per hour').default(10800),
  OCCUPATION_STALE_AFTER_SECONDS: z.coerce.number().int().positive().default(21600),
  // How long a source may stay silent about an alert it was holding before that alert is allowed to
  // end. Official providers are polled every 15 seconds, so the default tolerates three consecutive
  // missed polls and ends the alert on the fourth. The floor is two polls: anything shorter would
  // let a single incomplete response trigger a false "Офіційний відбій" again.
  ALERT_END_DEBOUNCE_SECONDS: z.coerce.number().int()
    .min(30, 'Alert end debounce must span at least two 15-second polls').default(60)
}).superRefine((env, ctx) => {
  if (env.NODE_ENV !== 'production') return;
  if (env.OPS_PASSWORD === 'change-me' || env.OPS_PASSWORD.length < 16) {
    ctx.addIssue({ code: 'custom', path: ['OPS_PASSWORD'], message: 'Production OPS_PASSWORD must contain at least 16 characters' });
  }
  if (!env.METRICS_TOKEN || env.METRICS_TOKEN.length < 16) {
    ctx.addIssue({ code: 'custom', path: ['METRICS_TOKEN'], message: 'Production METRICS_TOKEN must contain at least 16 characters' });
  }
  if (!env.PUBLIC_URL.startsWith('https://')) {
    ctx.addIssue({ code: 'custom', path: ['PUBLIC_URL'], message: 'Production PUBLIC_URL must use HTTPS' });
  }
  if (env.DEMO_SOURCE_ENABLED) {
    ctx.addIssue({ code: 'custom', path: ['DEMO_SOURCE_ENABLED'], message: 'Production cannot run with demo source enabled' });
  }
  if (/change-me|threatlens:threatlens/i.test(env.DATABASE_URL)) {
    ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'Production DATABASE_URL must not use development credentials' });
  }
});

export type AppConfig = z.infer<typeof envSchema>;
export const config = envSchema.parse(process.env);
