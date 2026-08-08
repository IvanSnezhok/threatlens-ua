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
    .min(30, 'Alert end debounce must span at least two 15-second polls').default(60),

  // ---- Official alert channels, collected over MTProto -----------------------------------------
  // These sources publish events, not snapshots, so they have their own reconciliation path and
  // their own safeguards. See docs/ARCHITECTURE.md, "Event-driven official alert source".
  //
  // *Which* channels are read is data, not configuration: every `sources` row with
  // adapter_type='mtproto_alert_channel' and enabled=true is subscribed to and may start and end
  // alert periods. This flag is the deployment-level kill switch above that registry, exactly as
  // OSINT_MONITOR_ENABLED is for the monitors — it must work without database access.
  ALERT_CHANNEL_ENABLED: z.string().default('true').transform((value) => value === 'true'),
  // Fallback only. If the registry query fails, the collector subscribes to this one channel rather
  // than starting up with no official alert source at all; when the query succeeds, the table
  // decides and this value is not consulted. It is also still the handle no monitoring row may
  // claim, which is why it stays normalised here rather than being read straight from the row.
  ALERT_CHANNEL_USERNAME: z.string().default('air_alert_ua')
    .transform((value) => value.trim().replace(/^@/, '').toLowerCase()),
  // Longest an alert from the channel may stay active without an explicit all-clear.
  //
  // The event model has exactly one failure mode the snapshot model does not: a 🟢 that is never
  // delivered, or that arrives in a shape the parser does not recognise, leaves the alert active
  // forever. This bound is the backstop. It is deliberately far longer than any single air-raid
  // alert observed on the channel — including overnight mass-attack alerts and frontline raions
  // that stay under alert most of a day — because ending a *real* alert early would produce the one
  // failure this system treats as unrecoverable, a false "Офіційний відбій". If it ever fires, a
  // message was missed: it is logged at warn level and counted, not swallowed. The floor is one
  // hour so a misconfiguration cannot turn the backstop into a routine all-clear.
  ALERT_CHANNEL_MAX_ALERT_SECONDS: z.coerce.number().int()
    .min(3600, 'Alert channel maximum alert duration must be at least one hour').default(86400),
  // Reconnect backfill. Bounded twice, by count and by age; the window is folded to one terminal
  // state per location before anything is written, so old events are never replayed as new ones.
  //
  // The count is a per-channel *ceiling*, not a target: history is read a page at a time and the
  // read stops as soon as it runs past the age bound. 300 is calibrated to the busiest channel —
  // @air_alert_ua publishes about fifty messages an hour, so ~300 fill the six-hour window — while
  // an oblast administration publishes one to three an hour and finishes in a single page. That is
  // what keeps the cost of enabling another channel proportional to what it actually publishes.
  ALERT_CHANNEL_BACKFILL_MESSAGES: z.coerce.number().int().min(0).max(500).default(300),
  ALERT_CHANNEL_BACKFILL_SECONDS: z.coerce.number().int().min(0).default(21600),

  // ---- OSINT air-threat monitoring channels ----------------------------------------------------
  // Which channels are read is data, not configuration: the list lives in `sources` and each row is
  // gated by its own `enabled` column. These two settings are the deployment-level controls that
  // must work without database access.
  //
  // Nothing collected through this path can start or end an official alert. The monitors are
  // `official=false` Tier B sources on the classifier path; their messages become `threat_events`.
  OSINT_MONITOR_ENABLED: z.string().default('true').transform((value) => value === 'true'),
  // Longest a monitoring channel may go on restating the same threat type over the same places
  // before it raises the event again.
  //
  // During a mass attack these channels post continuously, and a restatement that reaches
  // `ingestThreat` re-notifies every subscriber of that location, because the outbox idempotency key
  // carries the event-log version. The window suppresses the restatement, not the message: the text
  // is still stored against the source. Two minutes is far below the 30-minute validity window an
  // event carries, so a suppressed repeat cannot let a live threat expire. 0 disables coalescing;
  // above 900 the window starts approaching the validity window itself and is rejected.
  OSINT_MONITOR_COALESCE_SECONDS: z.coerce.number().int().min(0).max(900).default(120),

  // ---- Publication mode and event-driven analytics ---------------------------------------------
  // How long `delayed_15s` holds the public presentation. The MODE is an operator decision and lives
  // in `runtime_settings`; this is only the length, so a staging deployment can prove the mechanism
  // at five seconds without a code change.
  //
  // Below 5 s the hold is inside the event hub's 1 s tick plus the browser's 250 ms refetch debounce
  // and is indistinguishable from jitter. Above 60 s it would cross the client's own 60 s
  // «МОЖЛИВА ЗАТРИМКА» threshold and a deliberate hold would be reported to users as a fault.
  PUBLICATION_DELAY_SECONDS: z.coerce.number().int()
    .min(5, 'Publication delay must exceed the 1s event poll and the 250ms client debounce')
    .max(60, 'A publication delay above 60s would be reported to users as stale data')
    .default(15),

  // Deployment-level kill switch for the whole event-driven recompute path. When false the worker
  // never subscribes to the event hub at all, whatever `runtime_settings.analytics_event_driven`
  // says, and the existing fifteen-minute timers are the only trigger. This exists because the
  // reason to stop event-driven recomputation is usually that it is amplifying a database problem —
  // and that is the worst possible moment to need the database to read a flag.
  ANALYTICS_EVENT_DRIVEN_ENABLED: z.string().default('true').transform((value) => value === 'true'),

  // ---- Analytics narrative (optional model layer) ----------------------------------------------
  // Everything in `src/services/analytics-archive.ts` is deterministic SQL and never reads any of
  // these. They only control whether a model is asked to *write prose about* numbers that have
  // already been computed. Off by default: the analytics have to be complete without a model, and a
  // model that is quietly on is a model whose failures are quietly absorbed.
  ANALYTICS_NARRATIVE_ENABLED: z.string().default('false').transform((value) => value === 'true'),
  // Codex over ChatGPT OAuth. Deliberately separate from `AI_*`, which the risk engine uses with a
  // plain API key: the two can point at different providers, and adding an auth mode to the existing
  // variables would change the meaning of a production value that is already set.
  //
  // `CODEX_API_KEY` holds the OAuth access token; it is sent as `Authorization: Bearer`, exactly as
  // an API key would be, so nothing downstream has to know which of the two it got.
  // `CODEX_ACCOUNT_ID` is the ChatGPT account the token belongs to and is sent as
  // `ChatGPT-Account-Id` when present. When `CODEX_*` is unset the narrative falls back to `AI_*`,
  // and when neither is configured it falls back to the deterministic summary.
  CODEX_BASE_URL: z.string().default(''),
  CODEX_API_KEY: z.string().default(''),
  CODEX_MODEL: z.string().default(''),
  CODEX_ACCOUNT_ID: z.string().default(''),
  // The ChatGPT Codex backend speaks the Responses API over SSE; an OpenAI-compatible proxy speaks
  // `chat/completions`. `auto` decides by the base URL, which is right for both known deployments;
  // the explicit values exist for a proxy that happens to live on a chatgpt.com path or vice versa.
  CODEX_API_STYLE: z.enum(['auto', 'chat', 'responses']).default('auto'),

  // ---- Shadow classification (model second opinion) --------------------------------------------
  // How many messages per minute may be sent for a shadow classification. This is a spending limit,
  // not a throughput setting: a mass attack is when the message rate peaks and when the account's
  // quota must still be there for the features that face users, so messages over budget are dropped
  // rather than queued. The switch that turns the feature on at all is `shadow` in `codex_settings`,
  // not an environment variable — see `src/services/codex-settings.ts`.
  SHADOW_CLASSIFIER_MAX_PER_MINUTE: z.coerce.number().int().min(0).max(120).default(6),

  // ---- Codex sign-in over OAuth ----------------------------------------------------------------
  // The operator presses a button in `/ops` instead of copying a token out of `~/.codex/auth.json`.
  // Everything here describes *where* the browser is sent and *where it comes back to*; whether a
  // model is called at all is still `ANALYTICS_NARRATIVE_ENABLED`, unchanged.
  //
  // The client id and issuer below are the ones the public Codex CLI uses. They are not ours.
  // The sign-in they drive was exercised end to end against the live service on 2026-08-07 and
  // returned a session with a refresh token; the Responses transport was exercised with that
  // session on 2026-08-08 and returned model text, as `docs/EXTERNAL_SETUP.md` records. Override
  // both if the values move.
  //
  // The redirect is loopback by necessity, not by preference: that client only accepts
  // `http://localhost:<port>/auth/callback`, so the browser completing the sign-in and the server
  // receiving the code must resolve the same `localhost`. Behind Caddy on a remote host they do not,
  // and the callback will never arrive. `/ops/codex` reports that as a precondition, not as a bug.
  CODEX_OAUTH_ISSUER: z.string().url().default('https://auth.openai.com'),
  CODEX_OAUTH_CLIENT_ID: z.string().default('app_EMoamEEZ73f0CkXaXp7hrann'),
  CODEX_OAUTH_SCOPE: z.string().default('openid profile email offline_access'),
  CODEX_OAUTH_REDIRECT_PORT: z.coerce.number().int().min(1).max(65535).default(1455),
  // What the *browser* is told to return to. Must match the registered redirect exactly.
  CODEX_OAUTH_REDIRECT_HOST: z.string().default('localhost'),
  // What the *server* listens on. Inside a container the published port arrives on the bridge
  // interface, so binding to loopback there would drop the callback on the floor.
  CODEX_OAUTH_BIND_ADDRESS: z.string().default('0.0.0.0'),
  // How long a started sign-in stays valid before the listener closes itself.
  CODEX_OAUTH_LOGIN_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(1800).default(300),

  // ---- Build identity ---------------------------------------------------------------------------
  // What this image is. Baked in by `docker compose build` through the `APP_COMMIT`/`APP_BUILT_AT`
  // build args (see `Dockerfile` and `compose.yaml`), never read from the working tree at runtime —
  // a container that reported the checkout's HEAD rather than its own would report the *new* commit
  // the instant the tree moved, which is the one moment the difference matters.
  //
  // `/health/ready` returns this value, and the deployment runner refuses to call an update
  // successful until a ready response carries the commit it just deployed. `unknown` is therefore
  // not a cosmetic default: an image built outside compose is an image the runner will never accept
  // as the target, which is the honest outcome — it cannot prove what it is running.
  APP_COMMIT: z.string().default('unknown'),
  APP_BUILT_AT: z.string().default(''),

  // ---- Operator-controlled deployment -----------------------------------------------------------
  // The app never touches the Docker socket. It proxies a confirmed button press to the `deployer`
  // service, which holds the socket, runs ONE frozen scenario and writes its own journal straight
  // into PostgreSQL. Everything here is about reaching that service; nothing here describes what the
  // scenario does — the branch (`refs/heads/main`) and the restarted service list (`app`, `caddy`)
  // are frozen constants in `src/deployer/runner.ts` and are deliberately not configurable.
  //
  // Off by default. A deployment that has not created the runner container must not offer a button
  // that 502s, and a deployment that never wanted the feature should not have to opt out of it.
  DEPLOY_ENABLED: z.string().default('false').transform((value) => value === 'true'),
  // Compose-network name. The runner never publishes a host port (`expose:`, never `ports:`), so
  // this address is unreachable from the internet by construction.
  DEPLOY_RUNNER_URL: z.string().url().default('http://deployer:9000'),
  // Shared bearer, compared with `timingSafeEqual` on the runner side. See the production guard in
  // the refinement below: a 32-character floor is enforced when the feature is on.
  DEPLOY_RUNNER_TOKEN: z.string().default(''),
  // The app NEVER waits for a deployment: the trigger returns 202 with a run id and the runner works
  // detached. This bounds the proxy hop itself, so a hung runner turns into a named 502 on the ops
  // page instead of a request the operator's browser sits on while the site restarts underneath it.
  DEPLOY_RUNNER_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5000),

  // ---- Catch-up backfill for classifier Telegram sources ----------------------------------------
  // After downtime the collector reads what it missed for every enabled classifier source. Official
  // alert channels are NOT covered here: they have their own reconnect path with its own bounds
  // (`ALERT_CHANNEL_BACKFILL_*` above), because their messages are state transitions that get folded
  // to one terminal state per location, and these are events that get archived one by one.
  //
  // The names live in this file, with everything else the deployment decides, even though the
  // service that reads them is `src/services/source-backfill.ts`.
  CLASSIFIER_BACKFILL_ENABLED: z.string().default('true').transform((value) => value === 'true'),
  // The gap that separates "the collector blinked" from "the collector was down". Below it nothing
  // extra happens at all — live collection alone covers a short interruption, and a catch-up read
  // after every reconnect would be a history burst on every flap. The floor is five minutes for the
  // same reason: shorter, and a routine reconnect storm becomes a self-inflicted flood wait.
  CLASSIFIER_BACKFILL_MIN_GAP_SECONDS: z.coerce.number().int().min(300).default(3600),
  // How far back a single catch-up may reach, whatever the gap says. Six hours matches the risk
  // engine's horizon: older than that, a message is archive material and can no longer describe
  // anything current. The ceiling is 48 hours so a misconfiguration cannot ask for a week.
  CLASSIFIER_BACKFILL_MAX_AGE_SECONDS: z.coerce.number().int().min(600).max(172_800).default(21_600),
  // Per-source ceilings on one catch-up. Hitting either is `truncated` — a bounded success that the
  // ops card reports as «дозбір обмежено», not as a failure.
  CLASSIFIER_BACKFILL_MAX_MESSAGES: z.coerce.number().int().min(1).max(1000).default(300),
  CLASSIFIER_BACKFILL_MAX_PAGES: z.coerce.number().int().min(1).max(20).default(5),
  // Telegram's own history page size; 100 is the library's maximum per request.
  CLASSIFIER_BACKFILL_PAGE_SIZE: z.coerce.number().int().min(10).max(100).default(100),
  // How many sources one sweep may touch, and how long it pauses between them. Together these are
  // the request budget: ten sources at one page each, spaced 1.5 s apart, is a minute of gentle
  // traffic rather than a burst that earns a flood wait on the account the live collector shares.
  CLASSIFIER_BACKFILL_MAX_SOURCES_PER_SWEEP: z.coerce.number().int().min(1).max(100).default(10),
  CLASSIFIER_BACKFILL_SOURCE_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(1500),
  // Base of the exponential re-run guard: a source is not re-read sooner than this, and a failing
  // one waits MIN_RERUN_SECONDS * min(2^consecutive_failures, 24). A poison message therefore costs
  // one read a day, not one every sweep.
  CLASSIFIER_BACKFILL_MIN_RERUN_SECONDS: z.coerce.number().int().min(60).default(3600),
  // How often the sweep re-evaluates every source. 0 means "only once, at collector start" — the
  // kill switch for the periodic path that keeps the startup catch-up working.
  CLASSIFIER_BACKFILL_CHECK_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(300)
}).superRefine((env, ctx) => {
  if (env.NODE_ENV !== 'production') return;
  // The runner token is the only thing standing between somebody who can reach the compose network
  // and a process that holds the host's Docker socket. The floor is enforced at boot, where it is
  // visible, rather than at the first press of the button — and only when the feature is actually
  // on, so a deployment that never created the runner container is not asked for a secret it has no
  // use for.
  if (env.DEPLOY_ENABLED && env.DEPLOY_RUNNER_TOKEN.length < 32) {
    ctx.addIssue({
      code: 'custom', path: ['DEPLOY_RUNNER_TOKEN'],
      message: 'Production DEPLOY_ENABLED requires a DEPLOY_RUNNER_TOKEN of at least 32 characters'
    });
  }
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
