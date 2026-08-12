import { z } from 'zod';

/**
 * Exported since migration 030: this schema is no longer only the boot check, it is the ONE
 * validator every write to `app_settings` has to pass, run inside the advisory-lock transaction that
 * performs the write (`saveAppSettings`, `src/services/app-settings.ts`). Nothing else in the
 * codebase is allowed to decide whether a setting is legal, which is why the table has no CHECK
 * constraints — see the header of `migrations/030_app_settings.sql`.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_TIMEZONE: z.string().default('Europe/Kyiv'),
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1).default('postgresql://threatlens:threatlens@localhost:5432/threatlens'),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_BOT_USERNAME: z.string().default(''),
  TELEGRAM_MODE: z.enum(['polling', 'disabled']).default('polling'),
  TELEGRAM_ADMIN_CHAT_ID: z.string().default(''),
  TELEGRAM_DELIVERY_RATE_PER_SECOND: z.coerce.number().int().min(1).max(30).default(25),
  TELEGRAM_DELIVERY_BURST: z.coerce.number().int().min(1).max(30).default(25),
  TELEGRAM_API_ID: z.string().default(''),
  TELEGRAM_API_HASH: z.string().default(''),
  TELEGRAM_SESSION: z.string().default(''),
  UKRAINE_ALARM_API_TOKEN: z.string().default(''),
  UKRAINE_ALARM_API_URL: z.string().url().default('https://api.ukrainealarm.com/api/v3/alerts'),
  ALERTS_IN_UA_TOKEN: z.string().default(''),
  ALERTS_IN_UA_URL: z.string().url().default('https://api.alerts.in.ua/v1/alerts/active.json'),

  // ---- Community aerial-alert mirror ------------------------------------------------------------
  // The tokenless third-party republication of the same alert state the two APIs above serve, and
  // the only one of the three that needs no written application. Registered by
  // `migrations/027_aerial_alert_mirror.sql`; see docs/ARCHITECTURE.md for why it carries its own
  // independence group.
  //
  // Default ON, unlike every other credentialed source, because there is no credential to withhold:
  // the deployment-level kill switch is the only "off" this source has, exactly as
  // ALERT_CHANNEL_ENABLED is for the alert channels. It must keep working without database access,
  // which is why it is here and not a `sources.enabled` flip.
  AERIAL_MIRROR_ENABLED: z.string().default('true').transform((value) => value === 'true'),
  AERIAL_MIRROR_URL: z.string().url().default('https://ubilling.net.ua/aerialalerts/'),
  // How old the mirror's own `cachedat` stamp may be before a poll is refused outright.
  //
  // The bound is a safety device, not a tuning knob. Past it the response is treated as a source
  // ERROR and nothing is written, so the alerts the mirror is holding stay on the map; the failure
  // it exists to prevent is a frozen mirror serving `alertnow: false` for the whole country and the
  // snapshot reconciler dutifully clearing it. Measured behaviour: the feed regenerates on demand
  // behind a three-second cache, and across thirteen consecutive polls (at the fifteen-second
  // cadence in force when that was measured; see ALERT_POLL_INTERVAL_SECONDS for the current one)
  // `cachedat` was never more than two seconds behind the request. Nothing about the bound changes
  // with a faster poll — it is measured against the cache, not against us. 300s is roughly a hundred times the
  // observed lag — wide enough that ordinary upstream churn cannot trip it, narrow enough that a
  // genuine freeze is caught inside five minutes. The floor is one minute: below that the mirror's
  // own cache and a slow upstream switch would start reading as an outage.
  AERIAL_MIRROR_STALE_SECONDS: z.coerce.number().int()
    .min(60, 'Aerial mirror staleness bound must be at least a minute').default(300),
  // Which upstream to read through the mirror's documented `?source=<x>&raw` passthrough, which
  // returns that upstream's NATIVE body instead of the aggregated oblast-only `states` object.
  //
  // `ual` — Ukraine Alarm — is the default because it is the only probed upstream that publishes all
  // three administrative levels: `State`, `District` (raion) and `Community` (hromada, folded into
  // its raion by the catalogue). Measured on one live poll: 3 State + 26 District + 5 Community
  // entries where the aggregated feed had nine oblasts and nothing finer, and a Crimea row the
  // aggregated feed does not carry at all. `klimenko` serves the envelope but its district list was
  // empty when probed, `jaam` returned `[]`, and `aiu` 429s readily — none is a drop-in.
  //
  // **Empty string turns the passthrough off** and restores oblast-only behaviour: one request per
  // poll against the aggregated feed, exactly as this source shipped. That is the setting to reach
  // for if the upstream reshapes its body — it is a full retreat to a known-good path, not a
  // degradation — and it is why this is a string rather than a boolean.
  AERIAL_MIRROR_RAW_SOURCE: z.string().default('ual'),
  // Pause between the raw poll and the aggregated cross-check, when a cross-check is needed at all.
  //
  // The endpoint publishes two requests per second per host, and during research a probe loop that
  // put two requests inside one second was answered with a truncated body — the exact failure the
  // parser now refuses. The two requests this adapter can make in one poll are therefore SEQUENCED,
  // never fired together, and this is the gap between them. 600ms is comfortably over the 500ms the
  // limit implies while staying well inside the poll interval itself: even at the mirror's 3s floor
  // a worst-case poll spends 600ms of a 3000ms gap, and the gap is measured from the END of the poll
  // (see `src/services/leg-scheduler.ts`), so the cross-check can never crowd the next one. Zero is
  // allowed so tests need not wait.
  AERIAL_MIRROR_REQUEST_GAP_MS: z.coerce.number().int()
    .min(0, 'Aerial mirror request gap cannot be negative').default(600),
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
  // ---- Alert acquisition cadence -----------------------------------------------------------------
  // How long the scheduler waits between two passes of an alert-STATE leg — the two token APIs and
  // the community mirror. It is the front of the end-to-end budget: everything downstream of it (the
  // 1 s event hub, the 1 s fan-out, the browser's 250 ms debounce) is already inside two seconds,
  // and before this setting existed the acquisition step alone was worth up to fifteen.
  //
  // It is a REQUEST GAP, not a period: `startLegScheduler` arms the next pass when the previous one
  // finishes, so a slow poll pushes the next one out instead of firing it immediately. See
  // `src/services/leg-scheduler.ts` for why the conservative direction is the right one against a
  // rate limit.
  //
  // **Per-provider floors clamp this from below and cannot be configured away.** They are compiled
  // constants in `src/services/ingestion.ts`, not settings, because each of them is a published
  // property of somebody else's server rather than a preference of ours:
  //
  //   * the community mirror — 3 s. «Наразі таймаут кешування сирих даних з боку нашої імплементації
  //     - 3 секунди», wiki.ubilling.net.ua/doku.php?id=aerialalertsapi. Polling faster than the
  //     upstream regenerates buys a repeat of the byte-identical body and spends the published
  //     two-requests-per-second-per-host budget from the same page to learn nothing.
  //   * alerts.in.ua — 7 s, i.e. 8.6 requests a minute against the hard limit of 12 and inside the
  //     8–10 soft band published at devs.alerts.in.ua. Note what that floor is NOT derived from:
  //     the vendor documents no cache TTL at all, only conditional requests
  //     (`If-Modified-Since`/`Last-Modified` → 304). The remaining 3.4 req/min of the hard limit are
  //     deliberate headroom, and the reason to leave them is a second, undefined clause on the same
  //     page — «при аномальній кількості запитів на день, Ваш токен може бути заблокований».
  //   * Ukraine Alarm — 15 s. Unlike the other two this is not derived from a published number: the
  //     v3 API documents no rate limit and no cache guidance anywhere in its OpenAPI spec, and a
  //     floor invented against an undocumented budget is a floor that finds out it was wrong by
  //     being throttled during an attack. It stays where the old shared `setInterval` had it until
  //     there is evidence to move it. There IS a documented cheaper way to go faster on that API
  //     when its token arrives — `GET /api/v3/alerts/status` returns one `lastActionIndex` and is
  //     described as «використовувати для перевірки необхідності оновлювати дані», and the v3
  //     webhook endpoints remove polling altogether. Both are noted in docs/OPERATIONS.md as the
  //     next step rather than implemented here, because neither can be exercised without the token.
  //
  // The default of 4 s is the mirror's cadence in practice (its floor is 3), which is the leg that
  // actually decides how fast an oblast, raion or hromada turns red: it is tokenless, it publishes
  // all three administrative levels, and it is the only one of the three this deployment can read
  // today. The floor of 2 s exists so an operator cannot set a value below every provider floor and
  // conclude the setting does nothing; the ceiling of 60 s is the point at which the acquisition lag
  // would exceed `ALERT_END_DEBOUNCE_SECONDS` and a single missed poll could end an alert.
  ALERT_POLL_INTERVAL_SECONDS: z.coerce.number().int()
    .min(2, 'Alert poll interval must be at least 2 seconds')
    .max(60, 'An alert poll interval above 60s would exceed the end debounce it is measured against')
    .default(4),
  // How long a source may stay silent about an alert it was holding before that alert is allowed to
  // end. The SLOWEST alert leg is Ukraine Alarm at 15 seconds, so the default tolerates three
  // consecutive missed polls of the slowest source — and correspondingly more of the faster ones —
  // and ends the alert on the fourth. The floor is two of those polls: anything shorter would let a
  // single incomplete response trigger a false "Офіційний відбій" again.
  ALERT_END_DEBOUNCE_SECONDS: z.coerce.number().int()
    .min(30, 'Alert end debounce must span at least two 15-second polls of the slowest alert leg')
    .default(60),
  /**
   * How long a source may hold an air-raid alert while showing no sign of life.
   *
   * The mirror image of the debounce above, and the half that was missing until 2026-08-12. The
   * debounce says a source that goes briefly quiet keeps holding its alerts, so one missed poll
   * cannot clear the map. This says the same source stops holding them once it has been silent long
   * enough that "briefly" no longer describes it.
   *
   * That day the MTProto collector held Kyiv under alert from 09:53 UTC while receiving nothing at
   * all; the independent HTTP mirror cleared Kyiv at 11:33 UTC, on time and correctly, and the map
   * still showed an alert at 16:23 — because the aggregate weighed a five-hour-old row exactly as
   * heavily as a one-minute-old one.
   *
   * An hour is deliberately generous: sixty times the collector's heartbeat interval and twice its
   * own silence guard (`TELEGRAM_SILENCE_ALERT_SECONDS`), so a source has to be comprehensively dead
   * rather than merely late. Raise it — never lower it — if a legitimately slow source starts being
   * discounted; `threatlens_alert_stale_sources_ignored_total` is where that shows up first.
   *
   * The floor is ten minutes. Below that this stops being a liveness check and becomes a second,
   * much blunter debounce, with a false "Офіційний відбій" as its failure mode.
   */
  ALERT_SOURCE_LIVENESS_SECONDS: z.coerce.number().int()
    .min(600, 'Alert source liveness window must be at least ten minutes')
    .default(3600),

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
  //
  // Lowered from 86400 to 43200 on 2026-08-12, after a stuck Kyiv alert sat on the map for hours
  // with a full day still to run before this could have touched it. The reasoning above has NOT
  // changed and the trade-off is real: a frontline raion can genuinely hold an alert most of a day,
  // and at twelve hours this guard will end some of those early — which is the failure mode the
  // paragraph above calls unrecoverable. What changed is that the backstop is no longer the first
  // line of defence. `TELEGRAM_SILENCE_ALERT_SECONDS` below now catches a collector that has stopped
  // receiving within half an hour, which is the fault that actually produced the stuck alert, so
  // this bound can be what it was always meant to be — a last resort — instead of the only one.
  //
  // If a frontline deployment reports a premature відбій, raise this back rather than reaching for
  // the silence guard: they protect against different failures and neither substitutes for the other.
  ALERT_CHANNEL_MAX_ALERT_SECONDS: z.coerce.number().int()
    .min(3600, 'Alert channel maximum alert duration must be at least one hour').default(43200),
  /**
   * How long the collector may receive NOTHING before it stops claiming its sources are fresh.
   *
   * Measured across every subscribed channel at once, which is what makes the number safe to keep
   * this low: one channel silent for half an hour is an ordinary night, while all of them silent
   * together is a dead updates loop. On 2026-08-12 that state lasted four and a half hours while
   * `collector_ready` stayed 1 and `last_success_at` advanced every minute, and an air-raid
   * all-clear published inside it never reached the map.
   *
   * Thirty minutes is roughly ten times the longest gap observed between updates across the
   * fifty-four collected channels, so a real lull cannot trip it, and it is short enough that the
   * operator learns about a dead transport within one alert cycle rather than one working day.
   * Zero disables the guard and restores the old unconditional heartbeat.
   */
  TELEGRAM_SILENCE_ALERT_SECONDS: z.coerce.number().int().min(0).default(1800),
  // Reconnect backfill. Bounded twice, by count and by age; the window is folded to one terminal
  // state per location before anything is written, so old events are never replayed as new ones.
  //
  // The count is a per-channel *ceiling*, not a target: history is read a page at a time and the
  // read stops as soon as it runs past the age bound. 300 is calibrated to the busiest channel —
  // @air_alert_ua publishes about fifty messages an hour, so ~300 fill the six-hour window — while
  // an oblast administration publishes one to three an hour and finishes in a single page. That is
  // what keeps the cost of enabling another channel proportional to what it actually publishes.
  //
  // Both bounds were raised on 2026-08-12, after a reconnect window stopped twenty-three minutes
  // short of the newest stored message and the all-clear for Kyiv fell into the hole. 300 messages
  // and six hours were calibrated to a collector that reconnects promptly; they are the wrong size
  // for one that has been silent for hours, which is precisely when the backfill is the only thing
  // that can repair the state. 500 and twelve hours cost one extra history request per channel on a
  // quiet one — paging stops as soon as it runs past the age bound — and cover an outage long enough
  // to matter. `threatlens_alert_backfill_gaps_total` says when they are still not enough.
  ALERT_CHANNEL_BACKFILL_MESSAGES: z.coerce.number().int().min(0).max(500).default(500),
  ALERT_CHANNEL_BACKFILL_SECONDS: z.coerce.number().int().min(0).default(43200),

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

  // Whether the fan-out may queue anything for the project's own Telegram channel (migration 044).
  //
  // *Which* channels exist is data, not configuration — every `publication_channels` row with
  // `enabled=true` is published to — exactly as ALERT_CHANNEL_ENABLED sits above the `sources`
  // registry. This flag is the deployment-level switch above that table, and it is the one that must
  // work when the database is the thing going wrong.
  //
  // Off by default, and the third switch in front of the same behaviour: nothing is published unless
  // `codex_settings.analytical_threats_enabled` (migration 040) lets a model create an event at all,
  // an operator has enabled a channel row, and this is true. They are not redundant — the first is
  // «may a model publish», the second is «to whom», this one is «at all, from this deployment» — and
  // only the last of the three is reachable without a working `codex_settings` read.
  PUBLICATION_CHANNEL_ENABLED: z.string().default('false').transform((value) => value === 'true'),

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
  SHADOW_CONTEXT_MESSAGES: z.coerce.number().int().min(0).max(20).default(8),
  SHADOW_CONTEXT_MINUTES: z.coerce.number().int().min(1).max(120).default(30),
  SHADOW_IMAGE_MAX_BYTES: z.coerce.number().int().min(0).max(20_000_000).default(8_000_000),
  SHADOW_AUDIO_MAX_BYTES: z.coerce.number().int().min(0).max(25_000_000).default(25_000_000),
  AI_TRANSCRIPTION_MODEL: z.string().default('gpt-transcribe'),
  // Below this confidence a model verdict remains comparison material only. Publication is also
  // independently gated by `codex_settings.analytical_threats_enabled` and forced to `unverified`.
  ANALYTICAL_THREAT_MIN_CONFIDENCE: z.coerce.number().min(0.5).max(1).default(0.9),
  // A second budget, spent only by the half of the shadow classifier that PUBLISHES. The per-minute
  // limit above buys model calls; this one buys unverified pins on the public map and messages in the
  // Telegram channel. They are deliberately not the same window: while promotions lived inside the
  // per-minute call budget, a mass attack — the hour when the labelling corpus is worth the most —
  // made collecting more material and publishing more analytical events the same spend, so an
  // operator could not raise one without raising the other.
  //
  // Counted per hour rather than per minute because the failure this guards against is not a burst.
  // It is a model whose calibration has drifted, which produces a steady drip that even a per-minute
  // cap of 1 passes at sixty events an hour. Twelve — one every five minutes — is chosen against what
  // the layer IS: analytical events are the residue of what the deterministic rules refused, so a
  // night that wants more than a dozen an hour is telling an operator that the rules need a new
  // pattern (which `/ops` shows), not that the map needs more unverified pins. The ceiling of 120 is
  // the point past which the unverified layer stops being a residue and becomes what the map mostly
  // shows; no confidence threshold makes that reviewable by a human.
  //
  // Zero stops promotions entirely and is the reason this is a number and not a boolean: it is the
  // same stop as `codex_settings.analytical_threats_enabled`, reachable from the environment when
  // `/ops` is not, and it leaves corpus collection running — the `shadow_classifications` row is
  // written before this budget is consulted (src/services/shadow-classifier.ts).
  ANALYTICAL_PROMOTIONS_MAX_PER_HOUR: z.coerce.number().int().min(0).max(120).default(12),
  // How long a model-authored event may stand with nothing corroborating it before the system closes
  // it itself (`withdrawUnconfirmedAnalyticalEvents`, src/repositories/events.ts). The budget above
  // bounds how many analytical pins may appear per hour; this bounds how long each wrong one stays.
  //
  // **0 disables the sweep and is the shipped default**, because switching it on makes a published
  // pin disappear sooner than the reader was told it would — `valid_until` on the row states thirty
  // minutes, and a surface that quietly stops honouring its own stated deadline is the kind of
  // inconsistency `docs/ARCHITECTURE.md` §Consistency rules is written against. An installation that
  // wants the shorter leash is stating that it would rather lose a true analytical warning early
  // than keep a false one, which is a real position but not one to take on somebody's behalf.
  //
  // Bounded at 29 rather than at 30: `THREAT_VALIDITY_MS` retires the event at thirty minutes
  // anyway, so 30 and above is a setting that reads as configured and does nothing — the worst kind
  // of switch. The floor of 5 is what keeps it from becoming a way to publish a pin and remove it
  // before anyone can read it; below that the honest change is to stop promoting, which
  // ANALYTICAL_PROMOTIONS_MAX_PER_HOUR=0 already does.
  ANALYTICAL_UNCONFIRMED_CLOSE_MINUTES: z.coerce.number().int().min(0).max(29).default(0)
    .refine((value) => value === 0 || value >= 5, {
      message: 'ANALYTICAL_UNCONFIRMED_CLOSE_MINUTES must be 0 (off) or at least 5 minutes'
    }),

  // ---- Retrospective gate (model confirmation for the grey band) --------------------------------
  // The only model call in this codebase that sits *inside* the ingestion path, and the only one
  // whose answer is acted on. It is asked one question — «is this message reporting a threat
  // happening now, or a retrospective account?» — about a message the `v5` rules have already
  // flagged as `suspect`, and the single thing it can do with the answer is turn a would-publish
  // into an archive-only row. See `src/services/retrospective-gate.ts` for why it can do nothing
  // else, structurally.
  //
  // Being on the ingestion path is what makes the timeout a safety bound rather than a preference.
  // A message that waits on a model is a message that is not on the map yet, so the budget has to be
  // small enough that the worst case is invisible next to the thirty-minute validity window an event
  // carries and next to the seconds these channels are ahead of the official alert. 2.5 s is roughly
  // one tenth of `AI_TIMEOUT_MS`, which bounds the surfaces that face a human who can wait. The
  // floor of 250 ms exists so a misconfiguration cannot make every call a timeout — that would be
  // harmless (the deterministic verdict stands) but would spend a call to learn nothing. The ceiling
  // of 10 s is the point at which a burst of suspect messages during an attack would start to
  // serialise behind the model rather than behind the database.
  RETROSPECTIVE_GATE_TIMEOUT_MS: z.coerce.number().int().min(250).max(10_000).default(2500),
  // A spending ceiling per rolling minute, exactly like the shadow classifier's and for the same
  // reason. Over budget the gate returns the deterministic verdict, which is to publish: running out
  // of quota must never be a way to lose a warning, only a way to lose a suppression.
  RETROSPECTIVE_GATE_MAX_PER_MINUTE: z.coerce.number().int().min(0).max(120).default(6),

  // ---- Operator research governance ------------------------------------------------------------
  // The two bounds on the operator-only oblast research memo. Both are counted from the request
  // table migration 035 creates rather than from a module variable, which is the whole reason they
  // are settings and not constants: a cap that a `docker compose restart` resets is not a cap, and
  // the moment somebody would want to change either of these is the middle of an attack, when
  // editing `.env` and restarting is the worst available move.
  //
  // Twenty a day is the number of oblasts a single operator can meaningfully read memos for in one
  // shift. The ceiling of 200 is not a recommendation: it is high enough that an installation with
  // several operators is not silently throttled, and low enough that a stuck client cannot spend a
  // quota overnight. Zero means the surface is closed — every request refuses with `refused_daily_cap`
  // — which is a deliberate second off-switch beside the Codex one.
  ATTACK_RESEARCH_MAX_PER_DAY: z.coerce.number().int().min(0).max(200).default(20),
  // Per (oblast, window), not global: two operators researching two different oblasts are not
  // competing, and a cooldown that made them wait for each other would be measuring the wrong thing.
  // Two minutes is longer than reading one memo takes and shorter than a wave, so the second press is
  // usually a genuinely new question rather than an impatient repeat of the same one. 0 disables it.
  ATTACK_RESEARCH_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(3600).default(120),

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

/**
 * Parse an environment-shaped object into a configuration, or throw `ZodError`.
 *
 * Extracted from the `config` initialiser below so that the boot parse and the validation of an
 * operator's write are literally the same call. `saveAppSettings` runs this against
 * `candidateEnv(process.env, {...store, ...patch})` inside its transaction and refuses the write on
 * a `ZodError`; `loadAppSettings` runs it at boot and, on a `ZodError`, drops the offending stored
 * keys and runs it again. Neither path has its own idea of what is valid.
 */
export function parseAppConfig(env: Record<string, string | undefined>): AppConfig {
  return envSchema.parse(env);
}

// ================================================================================================
// The settings registry
// ================================================================================================
//
// Every key above, classified. This is what `GET /ops/api/settings` renders and what
// `candidateEnv()` filters on, and it is `Record<keyof AppConfig, SettingMeta>` so that adding a
// variable to the schema without deciding these questions does not compile.
//
// ---- `scope` -----------------------------------------------------------------------------------
// `db_tunable` and `db_secret` may be overridden from /ops. `env` may not, ever, and the reason is
// written down per key in `envReason` — the page shows it beside the value so «чому це не можна
// змінити тут» is answered where the question is asked. The three arguments that put a key in `env`:
//
//   * **lockout** — a bad write locks the operator out of the page that would fix it (OPS_*), or
//     out of the observability they would need to see that they had (METRICS_TOKEN), or out of the
//     process entirely (DATABASE_URL, NODE_ENV).
//   * **escalation** — the write would hand the ops session authority the ops session does not have.
//     The whole DEPLOY_* block is this: `app` never touches the Docker socket, it proxies a bearer
//     to a process that does, and a settings page that could repoint that proxy and mint its own
//     bearer would BE the socket.
//   * **compose-only** — the value is one half of a pair whose other half is in `compose.yaml` or in
//     a build arg, so changing it here would silently desynchronise the two. `PORT` and
//     `CODEX_OAUTH_REDIRECT_PORT` are published ports; `APP_COMMIT`/`APP_BUILT_AT` are build args
//     the deploy gate compares against.
//
// ---- `apply` -----------------------------------------------------------------------------------
// Derived from ACTUAL consumption, one grep per key, not from how the value feels:
//
//   * `hot` — every consumer reads `config.KEY` at the moment it uses it, so `Object.assign(config,
//     next)` is the whole of applying it.
//   * `restart` — at least one consumer captured the value at module load, at scheduler start or
//     into a closure, so the running process keeps the old one. These are the keys `pendingRestart`
//     is computed for and the banner names. Where a key is BOTH (the ingestion path reads it per
//     call, the collector froze it at subscribe time) the answer is `restart` and `applyNote` says
//     which half moved, because a banner that appears when nothing needed a restart is noise and a
//     banner that fails to appear when something did is the bug.
//
// ---- `confirm` ---------------------------------------------------------------------------------
// True for anything that can stop a warning or make one false. The console requires a second press
// and the API requires the key in `confirm[]`, so «випадково натиснув» is not a way to silence an
// air-raid channel.

export type SettingScope = 'env' | 'db_tunable' | 'db_secret';
export type SettingGroup = 'telegram' | 'official' | 'publication' | 'analytics' | 'map' | 'system';
export type SettingApply = 'hot' | 'restart';
/** Which subsystem an operator should watch after changing this. Rendered as a badge. */
export type SettingImpact = 'collector' | 'alerts' | 'publication';

export type SettingUi =
  | { kind: 'boolean' }
  | { kind: 'number'; min?: number; max?: number; unit?: string }
  | { kind: 'text'; placeholder?: string }
  | { kind: 'url' }
  | { kind: 'select'; options: readonly string[] }
  /**
   * Never serialised. The payload carries `isSet` and `source` for these and nothing else — one
   * function decides that (`serialiseSetting`) and one test proves it by searching the whole
   * response body for the value. Note this is the UI kind rather than the scope: four `env`-scoped
   * keys are credentials too (DATABASE_URL, OPS_PASSWORD, METRICS_TOKEN, DEPLOY_RUNNER_TOKEN), and
   * being unwritable is not the same as being safe to print.
   */
  | { kind: 'secret' };

export interface SettingMeta {
  scope: SettingScope;
  group: SettingGroup;
  apply: SettingApply;
  /** Why `restart`, or what part of a `hot` key is not as immediate as it looks. */
  applyNote?: string;
  ui: SettingUi;
  confirm?: true;
  impact?: SettingImpact;
  /** Required for `scope: 'env'`, meaningless otherwise. One sentence, shown on the page. */
  envReason?: string;
}

export const SETTING_GROUPS: ReadonlyArray<{ id: SettingGroup; label: string }> = [
  { id: 'telegram', label: 'Telegram: бот і збір' },
  { id: 'official', label: 'Джерела тривог і загроз' },
  { id: 'publication', label: 'Публікація' },
  { id: 'analytics', label: 'Аналітика і моделі' },
  { id: 'map', label: 'Карта і довідники' },
  { id: 'system', label: 'Система і доступ' }
];

export const APP_SETTINGS: Record<keyof AppConfig, SettingMeta> = {
  // ---- system ----------------------------------------------------------------------------------
  NODE_ENV: {
    scope: 'env', group: 'system', apply: 'restart',
    ui: { kind: 'select', options: ['development', 'test', 'production'] },
    envReason: 'Вирішує, чи діють production-перевірки самої схеми — довжина OPS_PASSWORD і '
      + 'METRICS_TOKEN, https у PUBLIC_URL, заборона демо-джерела. Значення в БД дозволило б '
      + 'вимкнути записом у таблицю той самий захист, який цю таблицю стереже.'
  },
  PORT: {
    scope: 'env', group: 'system', apply: 'restart', ui: { kind: 'number', min: 1, max: 65535 },
    envReason: 'compose публікує «${APP_HTTP_PORT}:3000». Інший порт у БД пересунув би слухач із '
      + '3000, а проброс лишився б на 3000: сайт зник би без жодної зміни в compose.yaml.'
  },
  APP_TIMEZONE: {
    scope: 'db_tunable', group: 'system', apply: 'hot', ui: { kind: 'text', placeholder: 'Europe/Kyiv' },
    applyNote: 'Форматувальники в src/bot/humanize.ts перебудовуються на першому виклику після зміни '
      + '— решта споживачів (нічний дайджест, аналітика, /api/v1/config) читають зону щоразу.'
  },
  PUBLIC_URL: {
    scope: 'env', group: 'publication', apply: 'restart', ui: { kind: 'url' },
    envReason: 'Має збігатися з SITE_ADDRESS у Caddy і з сертифікатом; у production схема ще й '
      + 'вимагає https. Розбіжність ламає кнопку «Відкрити карту» в боті, і полагодити її з /ops '
      + 'не вийде — сторінка живе за тією ж адресою.'
  },
  DATABASE_URL: {
    scope: 'env', group: 'system', apply: 'restart', ui: { kind: 'secret' },
    envReason: 'Рядок, яким відкривається пул, що тримає саму таблицю налаштувань. Курка і яйце: '
      + 'значення, потрібне, щоб прочитати значення.'
  },
  OPS_USER: {
    scope: 'env', group: 'system', apply: 'restart', ui: { kind: 'text' },
    envReason: 'Половина облікових даних до цієї ж сторінки. Помилковий запис зачиняє двері зсередини '
      + '— виправити його можна лише там, де він і живе, у .env.'
  },
  OPS_PASSWORD: {
    scope: 'env', group: 'system', apply: 'restart', ui: { kind: 'secret' },
    envReason: 'Друга половина тих самих дверей, і єдиний захист /ops. Запис у БД означав би, що '
      + 'сесія оператора може змінити умову власного входу — і, помилившись, вийти назавжди.'
  },
  METRICS_TOKEN: {
    scope: 'env', group: 'system', apply: 'restart', ui: { kind: 'secret' },
    envReason: 'Єдиний облік, яким Prometheus дістає /metrics. Помилковий запис осліплює моніторинг '
      + 'саме тоді, коли за ним і дивляться, а докази того, що щось пішло не так, — на /metrics.'
  },
  APP_COMMIT: {
    scope: 'env', group: 'system', apply: 'restart', ui: { kind: 'text' },
    envReason: 'Build-arg, який запікає «docker compose build». Runner оновлення вважає деплой '
      + 'успішним лише тоді, коли /health/ready віддає саме цей комміт, — значення, яке можна '
      + 'дописати з вебсторінки, перетворило б цю перевірку на самопідтвердження.'
  },
  APP_BUILT_AT: {
    scope: 'env', group: 'system', apply: 'restart', ui: { kind: 'text' },
    envReason: 'Другий із пари build-arg. Час збірки, який контейнер може собі призначити, — не час '
      + 'збірки.'
  },
  DEPLOY_ENABLED: {
    scope: 'env', group: 'system', apply: 'restart', ui: { kind: 'boolean' },
    envReason: 'Вмикає кнопку, що доручає оновлення процесу з Docker-сокетом хоста. Перемикач у БД '
      + 'означав би, що сесія /ops може сама собі видати цю авторитетність.'
  },
  DEPLOY_RUNNER_URL: {
    scope: 'env', group: 'system', apply: 'restart', ui: { kind: 'url' },
    envReason: 'Адреса того самого процесу. Разом із токеном нижче це весь канал до Docker-сокета: '
      + 'можливість перенаправити його з вебсторінки дорівнює можливості підставити свій runner.'
  },
  DEPLOY_RUNNER_TOKEN: {
    scope: 'env', group: 'system', apply: 'restart', ui: { kind: 'secret' },
    envReason: 'Спільний bearer до процесу з Docker-сокетом, з підлогою в 32 символи в production. '
      + 'Секрет, який можна переписати через ту саму сторінку, що ним і користується, нічого не '
      + 'стереже.'
  },
  DEPLOY_RUNNER_TIMEOUT_MS: {
    scope: 'env', group: 'system', apply: 'restart', ui: { kind: 'number', min: 500, max: 30000, unit: 'мс' },
    envReason: 'Третє з трьох значень, що описують один канал до runner-а. Розділяти їх між .env і '
      + 'БД означало б, що частину каналу до Docker-сокета все ж таки можна переписати з вебсторінки.'
  },

  // ---- telegram: бот -----------------------------------------------------------------------------
  TELEGRAM_BOT_TOKEN: {
    scope: 'db_secret', group: 'telegram', apply: 'restart', confirm: true, impact: 'alerts',
    ui: { kind: 'secret' },
    applyNote: 'createBot() виконується один раз у src/index.ts: новий токен підхопиться лише після '
      + 'перезапуску, до того сповіщення йдуть старим ботом.'
  },
  TELEGRAM_BOT_USERNAME: {
    scope: 'db_tunable', group: 'telegram', apply: 'hot', ui: { kind: 'text' }
  },
  TELEGRAM_MODE: {
    scope: 'db_tunable', group: 'telegram', apply: 'restart', confirm: true, impact: 'alerts',
    ui: { kind: 'select', options: ['polling', 'disabled'] },
    applyNote: 'Читається один раз, у createBot(). «disabled» після перезапуску означає, що бот не '
      + 'створюється взагалі — жодного сповіщення.'
  },
  TELEGRAM_ADMIN_CHAT_ID: {
    scope: 'db_tunable', group: 'telegram', apply: 'hot', ui: { kind: 'text' },
    applyNote: 'Читається на місці, у мить самої події (src/bot/admin-notice.ts): новий chat id діє '
      + 'з наступного сповіщення, без перезапуску. Порожнє значення вимикає їх повністю.'
  },
  TELEGRAM_DELIVERY_RATE_PER_SECOND: {
    scope: 'db_tunable', group: 'telegram', apply: 'hot', impact: 'alerts',
    ui: { kind: 'number', min: 1, max: 30, unit: 'повід./с' },
    applyNote: 'Спільний для всіх процесів бюджет зберігається в PostgreSQL; нова межа діє з '
      + 'наступного циклу доставки без перезапуску.'
  },
  TELEGRAM_DELIVERY_BURST: {
    scope: 'db_tunable', group: 'telegram', apply: 'hot', impact: 'alerts',
    ui: { kind: 'number', min: 1, max: 30, unit: 'повідомлень' },
    applyNote: 'Максимальний короткий сплеск спільного кошика. Офіційні та ескалаційні '
      + 'сповіщення завжди вибираються першими, але теж дотримуються межі Telegram.'
  },
  TELEGRAM_API_ID: {
    scope: 'db_secret', group: 'telegram', apply: 'restart', confirm: true, impact: 'collector',
    ui: { kind: 'secret' },
    applyNote: 'MTProto-клієнт будується один раз, на старті колектора.'
  },
  TELEGRAM_API_HASH: {
    scope: 'db_secret', group: 'telegram', apply: 'restart', confirm: true, impact: 'collector',
    ui: { kind: 'secret' },
    applyNote: 'MTProto-клієнт будується один раз, на старті колектора.'
  },
  TELEGRAM_SESSION: {
    scope: 'db_secret', group: 'telegram', apply: 'restart', confirm: true, impact: 'collector',
    ui: { kind: 'secret' },
    applyNote: 'Сесія передається в StringSession на старті колектора. Заміна на живому процесі '
      + 'нічого не змінює до перезапуску; після нього збір іде з нового акаунта.'
  },
  NIGHTLY_DIGEST_TIME: {
    scope: 'db_tunable', group: 'telegram', apply: 'hot',
    ui: { kind: 'text', placeholder: '23:20' }
  },

  // ---- telegram: дозбір після простою ------------------------------------------------------------
  CLASSIFIER_BACKFILL_ENABLED: {
    scope: 'db_tunable', group: 'telegram', apply: 'hot', ui: { kind: 'boolean' }, impact: 'collector'
  },
  CLASSIFIER_BACKFILL_MIN_GAP_SECONDS: {
    scope: 'db_tunable', group: 'telegram', apply: 'hot', ui: { kind: 'number', min: 300, unit: 'с' }
  },
  CLASSIFIER_BACKFILL_MAX_AGE_SECONDS: {
    scope: 'db_tunable', group: 'telegram', apply: 'hot',
    ui: { kind: 'number', min: 600, max: 172800, unit: 'с' }
  },
  CLASSIFIER_BACKFILL_MAX_MESSAGES: {
    scope: 'db_tunable', group: 'telegram', apply: 'hot', ui: { kind: 'number', min: 1, max: 1000 }
  },
  CLASSIFIER_BACKFILL_MAX_PAGES: {
    scope: 'db_tunable', group: 'telegram', apply: 'hot', ui: { kind: 'number', min: 1, max: 20 }
  },
  CLASSIFIER_BACKFILL_PAGE_SIZE: {
    scope: 'db_tunable', group: 'telegram', apply: 'hot', ui: { kind: 'number', min: 10, max: 100 }
  },
  CLASSIFIER_BACKFILL_MAX_SOURCES_PER_SWEEP: {
    scope: 'db_tunable', group: 'telegram', apply: 'hot', ui: { kind: 'number', min: 1, max: 100 }
  },
  CLASSIFIER_BACKFILL_SOURCE_DELAY_MS: {
    scope: 'db_tunable', group: 'telegram', apply: 'hot',
    ui: { kind: 'number', min: 0, max: 60000, unit: 'мс' }
  },
  CLASSIFIER_BACKFILL_MIN_RERUN_SECONDS: {
    scope: 'db_tunable', group: 'telegram', apply: 'hot', ui: { kind: 'number', min: 60, unit: 'с' }
  },
  CLASSIFIER_BACKFILL_CHECK_INTERVAL_SECONDS: {
    scope: 'db_tunable', group: 'telegram', apply: 'restart',
    ui: { kind: 'number', min: 0, unit: 'с' },
    applyNote: 'Період циклічного дозбору задається один раз, у setInterval() на старті колектора. '
      + 'Решта меж дозбору читається щоразу — тільки цей інтервал чекає перезапуску.'
  },

  // ---- official: опитувані API -------------------------------------------------------------------
  UKRAINE_ALARM_API_TOKEN: {
    scope: 'db_secret', group: 'official', apply: 'hot', confirm: true, impact: 'alerts',
    ui: { kind: 'secret' }
  },
  UKRAINE_ALARM_API_URL: {
    scope: 'db_tunable', group: 'official', apply: 'hot', confirm: true, impact: 'alerts',
    ui: { kind: 'url' }
  },
  ALERTS_IN_UA_TOKEN: {
    scope: 'db_secret', group: 'official', apply: 'hot', confirm: true, impact: 'alerts',
    ui: { kind: 'secret' }
  },
  ALERTS_IN_UA_URL: {
    scope: 'db_tunable', group: 'official', apply: 'hot', confirm: true, impact: 'alerts',
    ui: { kind: 'url' }
  },
  AERIAL_MIRROR_ENABLED: {
    scope: 'db_tunable', group: 'official', apply: 'hot', confirm: true, impact: 'alerts',
    ui: { kind: 'boolean' }
  },
  AERIAL_MIRROR_URL: {
    scope: 'db_tunable', group: 'official', apply: 'hot', impact: 'alerts', ui: { kind: 'url' }
  },
  AERIAL_MIRROR_STALE_SECONDS: {
    scope: 'db_tunable', group: 'official', apply: 'hot', impact: 'alerts',
    ui: { kind: 'number', min: 60, unit: 'с' }
  },
  AERIAL_MIRROR_RAW_SOURCE: {
    scope: 'db_tunable', group: 'official', apply: 'hot', impact: 'alerts',
    ui: { kind: 'text', placeholder: 'ual' }
  },
  AERIAL_MIRROR_REQUEST_GAP_MS: {
    scope: 'db_tunable', group: 'official', apply: 'hot', ui: { kind: 'number', min: 0, unit: 'мс' }
  },
  DEMO_SOURCE_ENABLED: {
    scope: 'env', group: 'official', apply: 'restart', ui: { kind: 'boolean' },
    envReason: 'У production схема відхиляє його беззастережно, тож перемикач у БД у єдиному '
      + 'середовищі, яке має значення, не міг би зробити нічого — а те, що він вмикає, це вигадані '
      + 'тривоги на публічній карті.'
  },
  ALERT_POLL_INTERVAL_SECONDS: {
    scope: 'db_tunable', group: 'official', apply: 'hot', confirm: true, impact: 'alerts',
    ui: { kind: 'number', min: 2, max: 60, unit: 'с' },
    applyNote: 'Планувальник читає значення на КОЖНОМУ такті, тож перезапуск не потрібен — але '
      + 'нове число діє з наступного такту, а не миттєво: пауза, яку зараз відлічують, доходить до '
      + 'кінця за старим значенням. Нижче за поріг провайдера опуститися не можна: дзеркало — 3 с '
      + '(його власний кеш), alerts.in.ua — 7 с (жорсткий ліміт 12 запитів/хв), Ukraine Alarm — '
      + '15 с. Пороги зашиті в код, а не в налаштування. Поточну паузу кожної ноги видно на '
      + '/metrics: threatlens_ingestion_leg_interval_seconds.'
  },
  ALERT_END_DEBOUNCE_SECONDS: {
    scope: 'db_tunable', group: 'official', apply: 'hot', confirm: true, impact: 'alerts',
    ui: { kind: 'number', min: 30, unit: 'с' }
  },
  ALERT_SOURCE_LIVENESS_SECONDS: {
    scope: 'db_tunable', group: 'official', apply: 'hot', confirm: true, impact: 'alerts',
    ui: { kind: 'number', min: 600, unit: 'с' },
    applyNote: 'Скільки джерело може тримати тривогу, не подаючи ознак життя (last_success_at). '
      + 'Понад це вікно його рядок не враховується в агрегаті, і живе джерело може зняти тривогу. '
      + 'Піднімати, а не знижувати: занизьке вікно дає хибний «Офіційний відбій». Слідкуйте за '
      + 'threatlens_alert_stale_sources_ignored_total.'
  },

  // ---- official: канал офіційних тривог ----------------------------------------------------------
  ALERT_CHANNEL_ENABLED: {
    scope: 'db_tunable', group: 'official', apply: 'restart', confirm: true, impact: 'collector',
    ui: { kind: 'boolean' },
    applyNote: 'Обробка повідомлень зважає на прапорець одразу, але перелік каналів, на які колектор '
      + 'підписаний, будується один раз — resolveChannelRoutes() на старті. Увімкнення без '
      + 'перезапуску не підпише колектор на канал.'
  },
  ALERT_CHANNEL_USERNAME: {
    scope: 'db_tunable', group: 'official', apply: 'restart', impact: 'collector',
    ui: { kind: 'text', placeholder: 'air_alert_ua' },
    applyNote: 'Резервний хендл на випадок, коли реєстр джерел не читається; підставляється при '
      + 'побудові підписок на старті колектора.'
  },
  ALERT_CHANNEL_MAX_ALERT_SECONDS: {
    scope: 'db_tunable', group: 'official', apply: 'hot', confirm: true, impact: 'alerts',
    ui: { kind: 'number', min: 3600, unit: 'с' }
  },
  TELEGRAM_SILENCE_ALERT_SECONDS: {
    scope: 'db_tunable', group: 'official', apply: 'hot', confirm: true, impact: 'alerts',
    ui: { kind: 'number', min: 0, unit: 'с' },
    applyNote: 'Скільки колектор може не отримувати ЖОДНОГО оновлення, перш ніж перестане '
      + 'позначати джерела свіжими. Рахується по всіх каналах разом. Нуль вимикає перевірку й '
      + 'повертає стару поведінку, коли heartbeat щохвилини стверджував успіх незалежно від того, '
      + 'чи щось надходило.'
  },
  ALERT_CHANNEL_BACKFILL_MESSAGES: {
    scope: 'db_tunable', group: 'official', apply: 'hot', ui: { kind: 'number', min: 0, max: 500 }
  },
  ALERT_CHANNEL_BACKFILL_SECONDS: {
    scope: 'db_tunable', group: 'official', apply: 'hot', ui: { kind: 'number', min: 0, unit: 'с' }
  },
  OSINT_MONITOR_ENABLED: {
    scope: 'db_tunable', group: 'official', apply: 'hot', confirm: true, impact: 'collector',
    ui: { kind: 'boolean' }
  },
  OSINT_MONITOR_COALESCE_SECONDS: {
    scope: 'db_tunable', group: 'official', apply: 'hot', ui: { kind: 'number', min: 0, max: 900, unit: 'с' }
  },

  // ---- publication -------------------------------------------------------------------------------
  PUBLICATION_DELAY_SECONDS: {
    scope: 'db_tunable', group: 'publication', apply: 'restart', confirm: true, impact: 'publication',
    ui: { kind: 'number', min: 5, max: 60, unit: 'с' },
    applyNote: 'Позначено «потребує перезапуску», хоча delaySecondsFor() читає значення щоразу: '
      + 'ця ж тривалість уже зашита в рішення про alert_periods.published_at, ухвалені під час '
      + 'повторних відкриттів тривог. Єдиний стан, у якому нове значення узгоджене з усім, що вже '
      + 'записано, — свіжий процес. Змінюється лише в режимі «наживо»: у delayed_15s збільшення '
      + 'затримки відсунуло б зріз назад і зняло б із карти вже опубліковані тривоги, тож запис '
      + 'відхиляється з 409.'
  },
  PUBLICATION_CHANNEL_ENABLED: {
    scope: 'db_tunable', group: 'publication', apply: 'hot', confirm: true, impact: 'publication',
    ui: { kind: 'boolean' },
    applyNote: 'Читається у мить фанауту, тож вимкнення діє з наступної події без перезапуску — але '
      + 'уже поставлені в чергу повідомлення каналу воно не відкликає: їх треба зняти з '
      + 'notification_outbox. Публікує лише події з origin=model і лише в увімкнені рядки '
      + 'publication_channels; офіційні тривоги цим шляхом не йдуть узагалі. Одна подія — одне '
      + 'повідомлення в канал: повторне вмикання не переопубліковує те, що вже опубліковано.'
  },

  // ---- analytics ---------------------------------------------------------------------------------
  ANALYTICS_EVENT_DRIVEN_ENABLED: {
    scope: 'db_tunable', group: 'analytics', apply: 'restart', confirm: true,
    ui: { kind: 'boolean' },
    applyNote: 'Перевіряється до підписки на шину подій: вимкнений воркер не простоює, його немає. '
      + 'Тому і вмикання, і вимикання чекають перезапуску; п’ятнадцятихвилинні таймери працюють у '
      + 'будь-якому разі.'
  },
  ANALYTICS_NARRATIVE_ENABLED: {
    scope: 'db_tunable', group: 'analytics', apply: 'hot', ui: { kind: 'boolean' }
  },
  AI_BASE_URL: { scope: 'db_tunable', group: 'analytics', apply: 'hot', ui: { kind: 'text' } },
  AI_API_KEY: { scope: 'db_secret', group: 'analytics', apply: 'hot', ui: { kind: 'secret' } },
  AI_MODEL: { scope: 'db_tunable', group: 'analytics', apply: 'hot', ui: { kind: 'text' } },
  AI_TIMEOUT_MS: {
    scope: 'db_tunable', group: 'analytics', apply: 'hot', ui: { kind: 'number', min: 1, unit: 'мс' }
  },
  CODEX_BASE_URL: { scope: 'db_tunable', group: 'analytics', apply: 'hot', ui: { kind: 'text' } },
  CODEX_API_KEY: { scope: 'db_secret', group: 'analytics', apply: 'hot', ui: { kind: 'secret' } },
  CODEX_MODEL: { scope: 'db_tunable', group: 'analytics', apply: 'hot', ui: { kind: 'text' } },
  CODEX_ACCOUNT_ID: {
    scope: 'db_secret', group: 'analytics', apply: 'hot', ui: { kind: 'secret' }
    // Не токен, але ідентифікатор чужого акаунта ChatGPT, який разом із токеном і становить пару.
    // Показувати «встановлено» замість значення тут нічого не коштує, а зворотне рішення друкує
    // чиюсь особисту прив’язку в кожному знімку сторінки.
  },
  CODEX_API_STYLE: {
    scope: 'db_tunable', group: 'analytics', apply: 'hot',
    ui: { kind: 'select', options: ['auto', 'chat', 'responses'] }
  },
  SHADOW_CLASSIFIER_MAX_PER_MINUTE: {
    scope: 'db_tunable', group: 'analytics', apply: 'hot', ui: { kind: 'number', min: 0, max: 120 }
  },
  SHADOW_CONTEXT_MESSAGES: {
    scope: 'db_tunable', group: 'analytics', apply: 'hot', ui: { kind: 'number', min: 0, max: 20 }
  },
  SHADOW_CONTEXT_MINUTES: {
    scope: 'db_tunable', group: 'analytics', apply: 'hot', ui: { kind: 'number', min: 1, max: 120, unit: 'хв' }
  },
  SHADOW_IMAGE_MAX_BYTES: {
    scope: 'db_tunable', group: 'analytics', apply: 'hot', ui: { kind: 'number', min: 0, max: 20000000, unit: 'байт' }
  },
  SHADOW_AUDIO_MAX_BYTES: {
    scope: 'db_tunable', group: 'analytics', apply: 'hot', ui: { kind: 'number', min: 0, max: 25000000, unit: 'байт' }
  },
  AI_TRANSCRIPTION_MODEL: {
    scope: 'db_tunable', group: 'analytics', apply: 'hot', ui: { kind: 'text' }
  },
  ANALYTICAL_THREAT_MIN_CONFIDENCE: {
    scope: 'db_tunable', group: 'analytics', apply: 'hot',
    ui: { kind: 'number', min: 0.5, max: 1 }
  },
  ANALYTICAL_PROMOTIONS_MAX_PER_HOUR: {
    scope: 'db_tunable', group: 'analytics', apply: 'hot', impact: 'publication',
    ui: { kind: 'number', min: 0, max: 120, unit: 'на годину' },
    applyNote: 'Вікно ковзне й лежить у памʼяті процесу, тож нове значення діє з наступної промоції, '
      + 'але вже опубліковане за останню годину не забувається: зниження нижче за кількість уже '
      + 'зроблених промоцій закриває публікацію до кінця цієї години. 0 зупиняє аналітичні промоції '
      + 'повністю й не чіпає збір корпусу — тіньові порівняння пишуться далі. Підтвердження свідомо '
      + 'немає: єдина зміна, яку роблять поспіхом, — це нуль, і вона має коштувати одне натискання.'
  },
  ANALYTICAL_UNCONFIRMED_CLOSE_MINUTES: {
    scope: 'db_tunable', group: 'analytics', apply: 'hot', impact: 'publication', confirm: true,
    ui: { kind: 'number', min: 0, max: 29, unit: 'хв' },
    // `confirm`, unlike the ceiling above, and для протилежного напрямку. Там поспішають до нуля —
    // це зупинка, і вона має бути дешевою. Тут поспішають ВІД нуля, і кожен крок від нуля забирає з
    // карти позначки раніше, ніж їх власне `valid_until` пообіцяло читачеві.
    applyNote: 'Значення читається на кожному проході, тож зміна діє з наступного — але вже відкликані '
      + 'події не повертаються: «відкликано» термінальне. 0 (типове) вимикає прибирання повністю. '
      + 'Дозволені значення — 0 або 5..29: від 30 і вище налаштування виглядало б увімкненим і не '
      + 'робило б нічого, бо тридцятихвилинне вікно чинності закриває подію й без нього. Прибирання '
      + 'не працює, доки прохід не викликано з планувальника.'
  },
  RETROSPECTIVE_GATE_TIMEOUT_MS: {
    scope: 'db_tunable', group: 'analytics', apply: 'hot',
    ui: { kind: 'number', min: 250, max: 10000, unit: 'мс' }
  },
  RETROSPECTIVE_GATE_MAX_PER_MINUTE: {
    scope: 'db_tunable', group: 'analytics', apply: 'hot', ui: { kind: 'number', min: 0, max: 120 }
  },
  ATTACK_RESEARCH_MAX_PER_DAY: {
    scope: 'db_tunable', group: 'analytics', apply: 'hot', ui: { kind: 'number', min: 0, max: 200 },
    applyNote: 'Ліміт рахується з таблиці запитів, а не з лічильника в пам’яті, тож зміна діє з '
      + 'наступного натискання й переживає перезапуск. 0 закриває поверхню повністю.'
  },
  ATTACK_RESEARCH_COOLDOWN_SECONDS: {
    scope: 'db_tunable', group: 'analytics', apply: 'hot',
    ui: { kind: 'number', min: 0, max: 3600, unit: 'с' },
    applyNote: 'Пауза рахується для пари «область + вікно» з часу останнього запиту в таблиці, '
      + 'тож зменшення ліміту одразу відкриває ті пари, які вже його вичекали.'
  },
  CODEX_OAUTH_ISSUER: { scope: 'db_tunable', group: 'analytics', apply: 'hot', ui: { kind: 'url' } },
  CODEX_OAUTH_CLIENT_ID: { scope: 'db_tunable', group: 'analytics', apply: 'hot', ui: { kind: 'text' } },
  CODEX_OAUTH_SCOPE: { scope: 'db_tunable', group: 'analytics', apply: 'hot', ui: { kind: 'text' } },
  CODEX_OAUTH_REDIRECT_PORT: {
    scope: 'env', group: 'analytics', apply: 'restart', ui: { kind: 'number', min: 1, max: 65535 },
    envReason: 'compose пробрасує «${CODEX_OAUTH_REDIRECT_PORT}:${CODEX_OAUTH_REDIRECT_PORT}» — '
      + 'обидві половини з одного значення. Інший порт у БД перевів би слухач туди, куди хост нічого '
      + 'не пересилає, і вхід просто ніколи б не завершився.'
  },
  CODEX_OAUTH_REDIRECT_HOST: { scope: 'db_tunable', group: 'analytics', apply: 'hot', ui: { kind: 'text' } },
  CODEX_OAUTH_BIND_ADDRESS: {
    scope: 'env', group: 'analytics', apply: 'restart', ui: { kind: 'text' },
    envReason: 'Усередині контейнера опублікований порт приходить на мостовий інтерфейс, тож '
      + '0.0.0.0 тут — факт топології, а не вподобання. Прив’язка до loopback тихо викидала б '
      + 'callback, і зламати це можна було б із вебсторінки.'
  },
  CODEX_OAUTH_LOGIN_TIMEOUT_SECONDS: {
    scope: 'db_tunable', group: 'analytics', apply: 'hot',
    ui: { kind: 'number', min: 30, max: 1800, unit: 'с' }
  },

  // ---- map ---------------------------------------------------------------------------------------
  MAP_STYLE_URL: { scope: 'db_tunable', group: 'map', apply: 'hot', ui: { kind: 'text' } },
  KATOTTG_SYNC_ENABLED: { scope: 'db_tunable', group: 'map', apply: 'hot', ui: { kind: 'boolean' } },
  KATOTTG_URL: { scope: 'db_tunable', group: 'map', apply: 'hot', ui: { kind: 'url' } },
  KATOTTG_VERSION: { scope: 'db_tunable', group: 'map', apply: 'hot', ui: { kind: 'text' } },
  OCCUPATION_SOURCE_ENABLED: {
    scope: 'db_tunable', group: 'map', apply: 'hot', confirm: true, ui: { kind: 'boolean' }
  },
  DEEPSTATE_API_URL: { scope: 'db_tunable', group: 'map', apply: 'hot', ui: { kind: 'url' } },
  OCCUPATION_SYNC_INTERVAL_SECONDS: {
    scope: 'db_tunable', group: 'map', apply: 'restart',
    ui: { kind: 'number', min: 3600, unit: 'с' },
    applyNote: 'Період задається один раз, у setInterval() на старті планувальника.'
  },
  OCCUPATION_STALE_AFTER_SECONDS: {
    scope: 'db_tunable', group: 'map', apply: 'hot', ui: { kind: 'number', min: 1, unit: 'с' }
  }
};

export const config = parseAppConfig(process.env);
