import { Counter, Gauge, Histogram, type Registry } from 'prom-client';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { PUBLICATION_MODES, type PublicationMode } from '../types.js';
import { resolveRuntimeSettings, settingsReadFailures } from './runtime-settings.js';

/**
 * The publication slice: one instant, computed in Postgres, that every public read path is a
 * snapshot of.
 *
 * ================================================================================================
 * What this module is for
 * ================================================================================================
 *
 * An operator may hold the public presentation back by `PUBLICATION_DELAY_SECONDS` («delayed_15s»).
 * The hold is expressed as a moving *bound on the SELECT*, never as a queue in this process: a queue
 * is lost on restart, double-delivers against the reconnect backfill, and has to be re-sorted after
 * a mode flip. A bound cannot be lost, cannot be replayed and cannot be re-ordered, because
 * `system_event_log` is the only state.
 *
 * Nothing here gates collection, classification, `alert_periods`, the audit tables, `/ops`,
 * `/metrics`, `/health/*` or the Telegram fan-out. `src/bot/outbox.ts` keeps its own durable cursor
 * in `worker_state` and never reads this module — the bot exemption is the default and requires no
 * code (CONTRACT §2.4, `docs/METHODOLOGY.md` §Publication).
 *
 * The import list is deliberately short — `../config.js`, `../db/pool.js`, `./runtime-settings.js`,
 * `../types.js` and `prom-client`, nothing ops-only. `src/api/vector-isolation.test.ts` walks the
 * module graph from `src/services/sse.ts` and `src/repositories/events.ts`, both of which now reach
 * this file, and lists this file itself as a public entry point.
 */

export interface PublicationSlice {
  mode: PublicationMode;
  /** 0 in live, `config.PUBLICATION_DELAY_SECONDS` in delayed_15s. */
  delaySeconds: number;
  /** Postgres `now()` − delaySeconds, clamped to `mode_changed_at`. */
  cutoffAt: Date;
  /** The highest version below the OLDEST row still being held — see {@link publicationSlice}. */
  cutoffVersion: number;
  /** max(created_at) among rows with `created_at <= cutoffAt`. */
  lastPublishedEventAt: Date | null;
  /** max(version), unbounded — for the backlog metric only, never for a public bound. */
  headVersion: number;
}

export interface PublicationMeta {
  mode: PublicationMode;
  delaySeconds: number;
  /** ISO 8601 — the instant the public view is a snapshot of. */
  cutoffAt: string;
  cutoffVersion: number;
  /** ISO 8601 — newest event inside the slice, or null when the log is empty. */
  lastPublishedEventAt: string | null;
  /** round(now − cutoffAt); 0 in live mode. */
  behindSeconds: number;
}

/**
 * Pure. The hold length in force for a mode.
 *
 * Exported so the hub can bound its one-second tick without paying for a whole slice, and so
 * `/api/v1/methodology` can answer without touching `system_event_log` at all.
 */
export function delaySecondsFor(mode: PublicationMode): number {
  return mode === 'delayed_15s' ? config.PUBLICATION_DELAY_SECONDS : 0;
}

/** The hold length in force right now. One memoised settings read, no log query. */
export async function publicationDelaySeconds(): Promise<number> {
  return delaySecondsFor((await resolveRuntimeSettings()).publicationMode);
}

// ------------------------------------------------------------------------------------------------
// Metrics
// ------------------------------------------------------------------------------------------------
//
// Constructed DETACHED (`registers: []`) at module scope so importing this service never mutates a
// shared registry, and attached by `registerPublicationMetrics(registry)` — the shape
// `registerAlertChannelMetrics` and `registerOccupationMetrics` already use.

const ingestionLag = new Histogram({
  name: 'threatlens_ingestion_lag_seconds',
  help: 'Seconds between a source message\'s publication time and the moment ingestion accepted it',
  labelNames: ['source'], buckets: [0.5, 1, 2, 5, 10, 30, 60, 300], registers: []
});
const classificationDuration = new Histogram({
  name: 'threatlens_classification_duration_seconds',
  help: 'Seconds spent classifying and persisting one message, by pipeline path',
  labelNames: ['path'], buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5], registers: []
});
const publicationLag = new Gauge({
  name: 'threatlens_publication_lag_seconds',
  help: 'How far behind wall clock the public view is at the last slice. 0 in live mode',
  registers: []
});
const publicationBacklog = new Gauge({
  name: 'threatlens_publication_backlog_events',
  help: 'System events written but not yet publicly released (head version minus cutoff version)',
  registers: []
});
const publicationMode = new Gauge({
  name: 'threatlens_publication_mode',
  help: 'One for the publication mode in force, zero for every other mode',
  labelNames: ['mode'], registers: []
});
const publicationDelay = new Gauge({
  name: 'threatlens_publication_delay_seconds',
  help: 'The configured hold length in force', registers: []
});
const sseDeliveryLag = new Histogram({
  name: 'threatlens_sse_delivery_lag_seconds',
  help: 'Seconds between an event being recorded and the frame carrying it being released',
  labelNames: ['kind'], buckets: [0.25, 0.5, 1, 2, 5, 15, 20, 30, 60], registers: []
});
const channelErrors = new Counter({
  name: 'threatlens_channel_errors_total',
  help: 'Errors attributed to one collection channel, by the stage that failed',
  labelNames: ['source', 'stage'], registers: []
});
/**
 * The end-to-end acquisition number: upstream said «тривога» at T, we recorded it at T+x.
 *
 * This is the ONE series that answers the question the whole fast-cadence delivery exists for, and
 * it answers it about the real world rather than about our own timers: `threatlens_ingestion_lag_seconds`
 * measures a *message's* age and only Telegram sources produce one, while this measures the distance
 * between a provider's own `changed`/`lastUpdate` stamp and the `system_event_log` row we wrote from
 * it. It composes with `threatlens_sse_delivery_lag_seconds`, which starts from the same
 * `created_at`, so the two summed are «from the authority's clock to the browser».
 *
 * Buckets straddle both cadences deliberately: 5 s is roughly the floor cadence's typical case, 20 s
 * is roughly the old fifteen-second scheduler's worst case, and a dashboard comparing before and
 * after wants both sides of that on one graph.
 *
 * `alert.started` only. Ends are unhurried by design and would only dilute the histogram.
 */
const alertPropagation = new Histogram({
  name: 'threatlens_alert_propagation_seconds',
  help: 'Seconds between an upstream reporting an alert start and our system_event_log row for it',
  labelNames: ['source'], buckets: [1, 2, 3, 5, 8, 12, 20, 30, 60, 120, 300], registers: []
});
/**
 * Вік даних, які провайдер сам оголосив у відповіді, на момент нашого читання.
 *
 * Окрема серія від `threatlens_alert_propagation_seconds`, і різниця між ними — це і є відповідь на
 * питання «хто саме гальмує». Propagation вимірює ВСЮ дорогу від годинника влади до нашого рядка й
 * не розрізняє в ній наших доданків і чужих. Ця ж читає єдине число, яке провайдер друкує про себе
 * самого: наскільки застаріле те, що він щойно віддав.
 *
 * Чому це варте власної серії. `?source=ual&raw` — єдиний фід дзеркала з громадною деталізацією —
 * виміряно оновлюється рівно раз на 121 с, тобто в середньому віддає стан хвилинної давності; решта
 * його фідів оновлюються за три секунди, але знають лише область. Ціна деталізації — хвилина
 * затримки попередження — досі не була видна ніде: `ageSeconds` рахувався тільки для того, щоб
 * кинути виняток на замерзлому дзеркалі, і зникав. Ставити швидкість опитування, поріг застарілості
 * чи вибір фіда, не бачачи цього числа, означає налаштовувати наш бік дороги наосліп.
 */
const sourceCacheAge = new Gauge({
  name: 'threatlens_source_cache_age_seconds',
  help: 'How old the data in a provider response was, by the provider own cache stamp',
  labelNames: ['source', 'feed'], registers: []
});

const METRICS: ReadonlyArray<[string, Counter<string> | Gauge<string> | Histogram<string>]> = [
  ['threatlens_ingestion_lag_seconds', ingestionLag],
  ['threatlens_classification_duration_seconds', classificationDuration],
  ['threatlens_publication_lag_seconds', publicationLag],
  ['threatlens_publication_backlog_events', publicationBacklog],
  ['threatlens_publication_mode', publicationMode],
  ['threatlens_publication_delay_seconds', publicationDelay],
  ['threatlens_sse_delivery_lag_seconds', sseDeliveryLag],
  ['threatlens_channel_errors_total', channelErrors],
  ['threatlens_alert_propagation_seconds', alertPropagation],
  ['threatlens_source_cache_age_seconds', sourceCacheAge],
  // Declared in `runtime-settings.ts` — the failure it counts happens inside
  // `resolveRuntimeSettings()`, and declaring it here would close an import cycle. Registered here
  // because this is the registrar `buildServer()` calls; without this row the series never appears
  // on /metrics and `docs/OPERATIONS.md` names an incident condition nobody can observe.
  ['threatlens_publication_settings_read_failures_total', settingsReadFailures]
];

export function registerPublicationMetrics(registry: Registry): void {
  for (const [name, metric] of METRICS) {
    if (!registry.getSingleMetric(name)) registry.registerMetric(metric);
  }
}

/**
 * Called by {@link publicationSlice} on every slice.
 *
 * The gauges therefore describe the last thing a reader was actually served, not a value a separate
 * scheduler sampled — which is what makes `threatlens_publication_lag_seconds` answerable during an
 * incident: it is nonzero exactly when somebody was shown held data.
 */
function observePublicationSlice(slice: PublicationSlice): void {
  publicationLag.set(Math.max(0, (Date.now() - slice.cutoffAt.getTime()) / 1000) * (slice.mode === 'live' ? 0 : 1));
  publicationBacklog.set(Math.max(0, slice.headVersion - slice.cutoffVersion));
  publicationDelay.set(slice.delaySeconds);
  // Every mode gets a series, so a dashboard can graph `sum by (mode)` without the "no data" gap a
  // single-series gauge produces the moment the mode changes.
  for (const mode of PUBLICATION_MODES) publicationMode.set({ mode }, mode === slice.mode ? 1 : 0);
}

export function observeIngestionLag(sourceId: string, seconds: number): void {
  // A provider that back-dates a message would otherwise skew p99 towards a lag nobody experienced.
  if (!Number.isFinite(seconds) || seconds < 0) return;
  ingestionLag.observe({ source: sourceId }, seconds);
}

export function observeClassificationDuration(path: 'alert' | 'classifier', seconds: number): void {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  classificationDuration.observe({ path }, seconds);
}

export function observeSseDeliveryLag(kind: 'live' | 'backfill', seconds: number): void {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  sseDeliveryLag.observe({ kind }, seconds);
}

export function countChannelError(sourceId: string, stage: 'collect' | 'parse' | 'persist'): void {
  channelErrors.inc({ source: sourceId, stage });
}

// ------------------------------------------------------------------------------------------------
// Alert propagation
// ------------------------------------------------------------------------------------------------

/**
 * Ceiling on one propagation observation.
 *
 * Not a bucket boundary — a CLAMP, and the difference matters. Two things produce values far above
 * any real acquisition lag and neither is the thing being measured:
 *
 *  * a provider that back-dates. `reconcileAggregateAlert` reopens an `alert_periods` row on its
 *    unique `(location, type, started_at)`, so a provider re-listing an alert with the start
 *    timestamp it used four hours ago produces a four-hour "propagation".
 *  * a catch-up. The alert-channel reconnect backfill replays a bounded history window, and the
 *    first message in it can be six hours old by design (`ALERT_CHANNEL_BACKFILL_SECONDS`).
 *
 * Left unclamped, one of those puts a five-figure sample in the +Inf bucket and drags every average
 * a dashboard draws. Clamping saturates the top finite bucket instead, which reads honestly as
 * «щось дуже старе» without pretending to a number. Five minutes is comfortably above every legitimate
 * case: the slowest leg polls at 15 s and the widest end debounce is 60 s.
 */
export const ALERT_PROPAGATION_CAP_SECONDS = 300;

/**
 * Pure. Seconds from the upstream's instant to ours, clamped at both ends, or `null` when there is
 * nothing to measure.
 *
 * The negative clamp is not defensive noise. `publishedAt` is Postgres `now()` at the start of the
 * writing transaction and `upstreamAt` is a THIRD party's clock — the mirror's `changed` field is a
 * bare Europe/Kyiv wall clock, and `kyivWallClockToUtc` resolving it one DST hour the wrong way,
 * or a provider simply running fast, both produce a start timestamp in our future. A histogram
 * cannot represent that and `prom-client` would happily record it, so it becomes 0: «наскільки ми
 * встигли» is never less than none.
 */
export function alertPropagationSeconds(publishedAt: Date, upstreamAt: Date | null): number | null {
  if (!upstreamAt) return null;
  const seconds = (publishedAt.getTime() - upstreamAt.getTime()) / 1000;
  if (!Number.isFinite(seconds)) return null;
  return Math.min(Math.max(0, seconds), ALERT_PROPAGATION_CAP_SECONDS);
}

/**
 * The last observation, kept so `/ops` can print one number without scraping Prometheus.
 *
 * In-process and therefore lost on restart, and only written when an alert actually starts — which
 * on a quiet night is never. That is why the KPI chip renders the age beside the value and shows a
 * dash when there is nothing: a stale number presented as current would be worse than no number.
 */
export interface AlertPropagationReading {
  seconds: number;
  source: string;
  /** ISO 8601 — when the observation was taken, i.e. when that alert was recorded. */
  at: string;
}

let lastPropagation: AlertPropagationReading | null = null;

export function lastAlertPropagation(): AlertPropagationReading | null {
  return lastPropagation ? { ...lastPropagation } : null;
}

/**
 * Records one `alert.started`. Total: never throws, and returns what it observed so a test does not
 * have to read the registry to find out.
 */
export function observeAlertPropagation(
  sourceId: string, publishedAt: Date, upstreamAt: Date | null
): number | null {
  const seconds = alertPropagationSeconds(publishedAt, upstreamAt);
  if (seconds === null) return null;
  alertPropagation.observe({ source: sourceId }, seconds);
  lastPropagation = { seconds, source: sourceId, at: publishedAt.toISOString() };
  return seconds;
}

/**
 * Записує вік відповіді провайдера. `feed` розрізняє два тіла одного джерела — деталізоване й
 * агреговане, — бо саме між ними й пролягає вибір, який ця серія має зробити видимим.
 *
 * Відʼємне значення (годинник провайдера попереду нашого) записується як нуль з тієї самої причини,
 * що й у `alertPropagationSeconds`: «наскільки застаріле» не буває менше за «не застаріле».
 */
export function observeSourceCacheAge(sourceId: string, feed: string, ageSeconds: number): void {
  if (!Number.isFinite(ageSeconds)) return;
  sourceCacheAge.set({ source: sourceId, feed }, Math.max(0, ageSeconds));
}

/**
 * Test seam. There is no slice memo to clear — the gauges are the only state this module keeps, and
 * a suite that asserts on `/metrics` must be able to put them back to their zero reading.
 */
export function resetPublicationCache(): void {
  publicationLag.set(0);
  publicationBacklog.set(0);
  publicationDelay.set(0);
  publicationMode.reset();
  // The last propagation reading is module state that outlives a TRUNCATE, exactly like the gauges
  // above, and `/ops/api/runtime` serves it — so one file's alert must not become the next file's
  // KPI chip.
  lastPropagation = null;
}

// ------------------------------------------------------------------------------------------------
// The slice
// ------------------------------------------------------------------------------------------------

export async function publicationSlice(): Promise<PublicationSlice> {
  const settings = await resolveRuntimeSettings();
  const delaySeconds = delaySecondsFor(settings.publicationMode);
  // ONE statement, and every value in it comes from the SAME Postgres `now()`. Taking `cutoffAt`
  // from `Date.now()` and `cutoffVersion` from the database would mean two clocks: a Node process a
  // second ahead of the database would advertise a cutoff newer than the rows it selected, and
  // `behindSeconds` could go negative — a "delay" the UI would have to render as a lie.
  //
  // GREATEST(..., mode_changed_at) makes the cutoff MONOTONIC. `now() - delay` alone jumps fifteen
  // seconds backwards at a live→delayed_15s flip and retracts rows that were already published: an
  // air-raid alert opened five seconds before the flip fails `published_at <= cutoff` and vanishes
  // from the public map for the length of the hold. That is the one thing this system may never do.
  //
  // `cutoff_version` is the version just BELOW the OLDEST row still being held, not the newest row
  // already releasable. The two differ because `version` is a sequence value taken at INSERT while
  // `created_at` defaults to `now()` = transaction START: a long write transaction that appends its
  // log rows at the end of its life produces HIGH versions carrying an OLD created_at, and the
  // moment they become visible `max(version) WHERE created_at <= cutoff` jumps above every
  // short-transaction row that committed in between with a LOWER version and a NEWER created_at.
  // Those rows are then released by `version <= cutoff_version` with no time check of their own —
  // published before their own hold elapsed, which is the whole thing this module exists to prevent.
  // Stopping strictly before the first held row makes that impossible by construction: every version
  // at or below the bound is below every row whose created_at is past the cutoff, so its own
  // created_at is necessarily at or before the cutoff.
  //
  // Drop-free as well as leak-free: `src/services/sse.ts` only ever advances its cursor to a version
  // it actually emitted, and the bound is monotone as the cutoff advances, so it stops before a held
  // row instead of straddling it. In `live` mode the cutoff is `now()`, no VISIBLE row can carry a
  // created_at newer than the reading transaction's own start, the first subselect is NULL and the
  // expression degenerates to `max(version)` — today's value, byte for byte.
  //
  // NO `max(...) FILTER (...)` and no `min(...)`. PostgreSQL's MIN/MAX→index rewrite
  // (preprocess_minmax_aggregates / can_minmax_aggs) bails out for any aggregate carrying an
  // aggfilter, and it is all-or-nothing for the whole query — so the FILTER form plans as a Seq Scan
  // + Aggregate over the WHOLE `system_event_log`, a table with no retention that grows one row per
  // event forever, on every snapshot, every stream connection and every GET /ops/api/runtime,
  // against `max: 12` connections under a 15 s statement_timeout. Each subselect below is one index
  // probe: the primary key on `version` and `system_event_log_created_idx (created_at DESC)` from
  // migration 003. If this ever needs changing, run EXPLAIN first —
  // `tests/integration/publication-mode.test.ts` asserts the plan contains no Seq Scan on
  // system_event_log.
  const result = await pool.query<{
    cutoff_at: Date; cutoff_version: string; last_published_at: Date | null; head_version: string;
  }>(
    `WITH bound AS (
       SELECT GREATEST(now() - make_interval(secs => $1::int), $2::timestamptz) AS cutoff_at
     )
     SELECT b.cutoff_at,
            COALESCE((SELECT l.version - 1 FROM system_event_log l
                       WHERE l.created_at > b.cutoff_at
                       ORDER BY l.version LIMIT 1),
                     (SELECT l.version FROM system_event_log l
                       ORDER BY l.version DESC LIMIT 1), 0)::bigint    AS cutoff_version,
            (SELECT l.created_at FROM system_event_log l
              WHERE l.created_at <= b.cutoff_at
              ORDER BY l.created_at DESC LIMIT 1)                      AS last_published_at,
            COALESCE((SELECT l.version FROM system_event_log l
                       ORDER BY l.version DESC LIMIT 1), 0)::bigint    AS head_version
     FROM bound b`,
    [delaySeconds, settings.modeChangedAt]
  );
  const row = result.rows[0]!;
  const slice: PublicationSlice = {
    mode: settings.publicationMode,
    delaySeconds,
    cutoffAt: row.cutoff_at,
    cutoffVersion: Number(row.cutoff_version),
    lastPublishedEventAt: row.last_published_at,
    headVersion: Number(row.head_version)
  };
  observePublicationSlice(slice);
  return slice;
}

/**
 * Pure. What a reader is told about the slice they were just served.
 *
 * No memo sits in front of {@link publicationSlice}: a 250 ms memo would let two requests inside the
 * same window disagree with the hub by a whole tick, and one index probe on a table the hub already
 * probes every second is not a cost worth that.
 */
export function sliceMeta(slice: PublicationSlice, now: Date): PublicationMeta {
  // `Math.max(0, …)` is not defensive noise: `cutoffAt` comes from Postgres and `now` from Node. On
  // a host whose two clocks disagree by a few hundred milliseconds a live-mode slice would otherwise
  // report a negative freshness, and the browser renders this number to a reader.
  const behindSeconds = slice.mode === 'live'
    ? 0
    : Math.max(0, Math.round((now.getTime() - slice.cutoffAt.getTime()) / 1000));
  return {
    mode: slice.mode,
    delaySeconds: slice.delaySeconds,
    cutoffAt: slice.cutoffAt.toISOString(),
    cutoffVersion: slice.cutoffVersion,
    lastPublishedEventAt: slice.lastPublishedEventAt?.toISOString() ?? null,
    behindSeconds
  };
}
