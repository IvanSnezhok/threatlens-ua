import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { Registry, collectDefaultMetrics, Counter, Gauge, Histogram } from 'prom-client';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { composeTerritoryStates } from '../domain/territory-state.js';
import { activeAlerts, assessmentDetails, currentAssessments, liveThreats, locationTimeline, relatedLocationsCte, territoryAncestry, threatDetails } from '../repositories/events.js';
import { createEventRelay, eventHub, publishedEnvelope, type SystemEvent } from '../services/sse.js';
import { activeOriginZones } from '../services/origin-activity.js';
import { delaySecondsFor, observeSseDeliveryLag, publicationSlice, registerPublicationMetrics, sliceMeta } from '../services/publication.js';
import { registerAnalyticsSchedulerMetrics } from '../services/analytics-scheduler.js';
import { registerDeploymentMetrics } from '../services/deployment.js';
import { registerBackfillMetrics } from '../services/source-backfill.js';
import { registerAnalyticalOutcomeMetrics } from '../services/analytical-outcomes.js';
import { registerAppSettingsMetrics } from '../services/app-settings.js';
import { registerAdminNoticeMetrics } from '../bot/admin-notice.js';
import { registerAttackResearchMetrics } from '../services/attack-research.js';
import { registerAttackStatsMetrics } from '../services/attack-stats.js';
import { registerCodexClassifierMetrics } from '../services/codex-classifier.js';
import { registerModelContextMetrics } from '../services/model-context.js';
import { registerOutboxMetrics } from '../bot/outbox.js';
import { telegramDeliveryGovernorStatus } from '../bot/delivery-governor.js';
import { resolveRuntimeSettings } from '../services/runtime-settings.js';
import { registerAlertChannelMetrics } from '../services/ingestion.js';
import { registerTelegramCollectorMetrics, telegramCollectorStatus } from '../sources/telegram.js';
import { hasValidOpsAuth, opsUnauthorized, safeEqual } from './ops-auth.js';
import analyticsRoutes from './analytics-routes.js';
import attackAnalyticsRoutes from './attack-analytics-routes.js';
import attackStatsRoutes from './attack-stats-routes.js';
import occupationRoutes from './occupation-routes.js';
import opsAiRunsRoutes from './ops-ai-runs-routes.js';
import opsCodexRoutes from './ops-codex-routes.js';
import opsAttackResearchRoutes from './ops-attack-research-routes.js';
import opsAttackStatsRoutes from './ops-attack-stats-routes.js';
import opsBackfillRoutes from './ops-backfill-routes.js';
import opsCoverageRoutes from './ops-coverage-routes.js';
import opsDeployRoutes from './ops-deploy-routes.js';
import opsRuntimeRoutes from './ops-runtime-routes.js';
import opsSettingsRoutes from './ops-settings-routes.js';
import opsSourceTrustRoutes from './ops-source-trust-routes.js';
import opsSourcesRoutes from './ops-sources-routes.js';
import opsVectorRoutes from './ops-vector-routes.js';
import vectorRoutes from './vector-routes.js';
import { runRiskAssessments } from '../services/risk.js';
import { TRUST_MODIFIER_CEILING, TRUST_MODIFIER_FLOOR, trustLabel } from '../services/source-trust.js';
import { createChannelSchema, createRecommendedChannel, listRecommendedChannels, updateChannelSchema, updateRecommendedChannel } from '../services/recommended-channels.js';

const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'threatlens_' });
registerAlertChannelMetrics(registry);
const httpRequests = new Counter({ name: 'threatlens_http_requests_total', help: 'HTTP requests', labelNames: ['method', 'route', 'status'], registers: [registry] });
const httpDuration = new Histogram({ name: 'threatlens_http_duration_seconds', help: 'HTTP request duration', labelNames: ['route'], registers: [registry] });
const sseConnections = new Gauge({ name: 'threatlens_sse_connections', help: 'Active SSE clients', registers: [registry] });
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const locationIdPattern = /^[a-z0-9-]{1,64}$/i;

/**
 * Whether a source can actually collect, decided per adapter rather than per id.
 *
 * This used to be a map of five source ids. The catalogue is now dozens of rows and grows by
 * migration alone, so an id list would silently classify every new source as configured and the ops
 * page would report sources as healthy-but-idle that nothing is even subscribed to. What decides
 * the answer is the adapter's prerequisite: every MTProto adapter needs the one set of API
 * credentials, each polled API needs its own token, and the demo source follows its flag.
 */
function sourceIsConfigured(row: { id: string; adapter_type: string | null; enabled: boolean }): boolean {
  if (!row.enabled) return false;
  const mtproto = Boolean(config.TELEGRAM_API_ID && config.TELEGRAM_API_HASH && config.TELEGRAM_SESSION);
  switch (row.adapter_type) {
    case 'mtproto':
    case 'mtproto_alert_channel':
    case 'mtproto_monitor':
      return mtproto;
    case 'ukraine_alarm': return Boolean(config.UKRAINE_ALARM_API_TOKEN);
    case 'alerts_in_ua': return Boolean(config.ALERTS_IN_UA_TOKEN);
    case 'demo': return config.DEMO_SOURCE_ENABLED;
    case 'aerial_alerts_mirror': return config.AERIAL_MIRROR_ENABLED;
    default: return true;
  }
}

/** Adapter types the MTProto collector, and only the MTProto collector, is responsible for. */
const MTPROTO_ADAPTERS = new Set(['mtproto', 'mtproto_alert_channel', 'mtproto_monitor']);

// ------------------------------------------------------------------------------------------------
// HTTP caching for the public read routes declared in this file
// ------------------------------------------------------------------------------------------------

/**
 * Per-reply override for the server-wide `Cache-Control: no-store`.
 *
 * `occupation-routes.ts` and `attack-analytics-routes.ts` solve the same problem with a child `onSend`
 * hook, because they are encapsulated plugins and a child hook runs after the inherited one. The two
 * routes below are declared directly on the root instance, where that trick is unavailable — a root
 * hook has nothing to run after. So the root hook itself reads the override, and every route that
 * does not set it keeps `no-store`, byte for byte as before.
 */
const CACHE_CONTROL = Symbol('cacheControl');

function setCacheControl(reply: FastifyReply, value: string): void {
  (reply as unknown as Record<symbol, string>)[CACHE_CONTROL] = value;
}

/** RFC 9110 §8.8.3.2 weak comparison — the only comparison `If-None-Match` is defined to use. */
function etagMatches(header: string, etag: string): boolean {
  if (header.trim() === '*') return true;
  const normalize = (value: string) => value.trim().replace(/^W\//, '');
  const wanted = normalize(etag);
  return header.split(',').some((candidate) => normalize(candidate) === wanted);
}

function ifNoneMatch(request: FastifyRequest, etag: string): boolean {
  const header = request.headers['if-none-match'];
  const value = Array.isArray(header) ? header[0] : header;
  return Boolean(value) && etagMatches(value, etag);
}

/**
 * A body already committed to bytes, with everything a conditional GET needs.
 *
 * The SERIALISED body is what is held, never the row objects: both routes below answer with
 * megabytes, and caching the rows would still pay `JSON.stringify` per request and would still let
 * the old-space high-water mark grow with every coinciding request.
 *
 * A `Buffer`, not a string, and that is the difference between the memo bounding memory and merely
 * bounding CPU. `socket.write(string)` ENCODES, so a cached string is copied to fresh bytes once per
 * reader; `socket.write(buffer)` queues the buffer by reference, so every reader of a burst shares
 * the one allocation. Measured with `scripts/memory-benchmark.ts` against a 31 000-row catalogue
 * (3.84 MiB body): 100 coinciding readers took the old-space high-water mark to 815 MiB as strings
 * — past `--max-old-space-size=640` and fatal — against 39 MiB as a buffer. The route was safe for
 * many concurrent readers in statements long before it was safe in bytes.
 */
interface CachedBody {
  body: Buffer;
  /** Strong validator: the bytes are hashed, so equality really is byte equality. */
  etag: string;
  expiresAt: number;
  cacheControl: string;
}

function strongEtag(body: Buffer): string {
  return `"${createHash('sha1').update(body).digest('base64url')}"`;
}

/**
 * A memo that is also a single flight.
 *
 * The single flight is the half that matters for «безпечно для багатьох одночасних читачів»: without
 * it, N readers arriving inside one computation each run the whole computation, so a refresh burst
 * multiplies the pool load by N exactly when the pool is least able to absorb it. With it, at most
 * one computation is ever in the air and the N−1 late arrivals await the same promise — which is
 * sound here because both bodies are pure functions of database state read at a single instant, and
 * the publication cutoff is monotonic (`GREATEST(now() - delay, mode_changed_at)`), so a shared
 * answer is always an EARLIER valid slice, never a later one. Serving something slightly older can
 * never publish held material; only serving something newer could, and nothing here can.
 *
 * A rejected load is not cached and does not stick: the flight is cleared in `finally`, so the next
 * request retries rather than inheriting a failure for the length of the TTL.
 */
function cachedBody(load: () => Promise<CachedBody>): () => Promise<CachedBody> {
  let cached: CachedBody | null = null;
  let inFlight: Promise<CachedBody> | null = null;
  return () => {
    if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached);
    if (inFlight) return inFlight;
    const flight = load().then((view) => { cached = view; return view; });
    inFlight = flight;
    // `catch` before `finally` so this bookkeeping chain can never surface as an unhandled rejection;
    // the rejection itself still reaches every caller through `flight`.
    void flight.catch(() => undefined).finally(() => { if (inFlight === flight) inFlight = null; });
    return flight;
  };
}

/** 304 when the client already holds these bytes, the bytes themselves otherwise. */
function sendCached(request: FastifyRequest, reply: FastifyReply, view: CachedBody) {
  setCacheControl(reply, view.cacheControl);
  reply.header('ETag', view.etag);
  reply.header('Vary', 'Accept-Encoding');
  if (ifNoneMatch(request, view.etag)) return reply.code(304).send();
  return reply.type('application/json; charset=utf-8').send(view.body);
}

/**
 * One serialisation per live event, not one per connection.
 *
 * `EventHub` emits ONE envelope object to every listener, so with 500 streams open the old code ran
 * `JSON.stringify` 500 times over the same object for the same bytes — per event, at up to one tick
 * a second. Keyed on the envelope identity, so the entry dies with the event and a reconnect
 * backfill (whose envelopes are built per connection) simply misses and pays what it always paid.
 */
const liveFrames = new WeakMap<SystemEvent, string>();

function sseFrame(event: SystemEvent): string {
  let frame = liveFrames.get(event);
  if (frame === undefined) {
    frame = `id: ${event.version}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`;
    liveFrames.set(event, frame);
  }
  return frame;
}

/**
 * Ceiling on the snapshot memo, enforced here rather than trusted to callers.
 *
 * One second is the cadence of `EventHub`'s own poll, so a memo of at most that length cannot make a
 * reader see anything staler than the feed that tells them to refetch in the first place.
 */
const SNAPSHOT_MEMO_CEILING_MS = 1000;

export interface BuildServerOptions {
  /**
   * How long `/api/v1/snapshot` may serve an already-computed body, clamped to
   * {@link SNAPSHOT_MEMO_CEILING_MS}.
   *
   * Zero under `NODE_ENV=test` by default, and that is not timidity. The integration harness seeds
   * `alert_periods`, `threat_events` and `risk_assessments` with direct INSERTs that append nothing
   * to `system_event_log`, so NO key derivable from the publication slice changes between one test's
   * data and the next's — a time-based memo would hand the following test the previous test's
   * territories whenever the two land inside the same second. The single flight is unaffected and
   * stays on everywhere; only the across-request TTL is stood down, and
   * `tests/integration/snapshot-cache.test.ts` passes an explicit value to exercise it.
   */
  snapshotMemoMs?: number;
}

/**
 * Every migration THIS IMAGE ships, read once at module load.
 *
 * Readiness used to name one filename — `022_publication_runtime.sql` — which meant a container
 * carrying migration 023 answered `ready` with 023 unapplied. That was tolerable while readiness was
 * only a human-facing probe. It stopped being tolerable the moment `src/deployer/runner.ts` began
 * treating a 200 from `/health/ready` as the proof that an update landed: a hard-coded marker turns
 * the deploy gate into a check that the PREVIOUS release's schema is present, and a failed migration
 * would be recorded as a successful deployment.
 *
 * The image's own `migrations/` directory is the only honest statement of what this build requires.
 * Read from disk once rather than per request — the directory cannot change under a running
 * container, and a readiness probe that stats a directory ten times a minute is a probe that fails
 * when the disk does.
 *
 * An empty list (no directory, e.g. a unit test running from another cwd) degrades to "no migration
 * requirement", never to "not ready": the database round trip below still proves reachability, which
 * is the other half of what this endpoint has always answered.
 */
const SHIPPED_MIGRATIONS: readonly string[] = (() => {
  try {
    return readdirSync(resolve(process.cwd(), 'migrations')).filter((file) => file.endsWith('.sql')).sort();
  } catch {
    return [];
  }
})();

/**
 * States in which the collector cannot deliver a message from any channel at all.
 *
 * `degraded` is deliberately not among them: it means the handlers are live and some channels are
 * bound, so the deployment is collecting — the unbound handles are reported per source through
 * `health_status`, which the collector itself writes with `markSourceError`.
 */
const COLLECTOR_BLOCKED: ReadonlySet<string> = new Set(['starting', 'flood_wait', 'failed']);

async function sourceHealth() {
  const rows = (await pool.query(
    `SELECT id,name,tier,official,enabled,adapter_type,last_success_at,last_error_at,last_error,
      health_status,stale_after_seconds FROM sources ORDER BY tier,id`
  )).rows;
  // One reading for the whole response: two calls a few statements apart could report two different
  // collector states inside a single payload.
  const collector = telegramCollectorStatus();
  return rows.map((row) => {
    const configured = sourceIsConfigured(row);
    return {
      ...row, configured, status: !row.enabled ? 'disabled' : configured ? row.health_status : 'unconfigured',
      // ADDITIVE, and null for every non-MTProto row: `status` keeps its existing vocabulary
      // (`current`/`stale`/`error`/`unknown`/`unconfigured`) because the web console maps those by
      // name. What this adds is the in-process fact the database cannot hold — whether the live
      // handlers exist at all — so a flood wait is visible before `stale_after_seconds` elapses.
      collector: MTPROTO_ADAPTERS.has(row.adapter_type) ? collector : null
    };
  });
}

export async function buildServer(options: BuildServerOptions = {}) {
  const snapshotMemoMs = Math.min(
    SNAPSHOT_MEMO_CEILING_MS,
    Math.max(0, options.snapshotMemoMs ?? (config.NODE_ENV === 'test' ? 0 : SNAPSHOT_MEMO_CEILING_MS))
  );
  // The publication gauges and the recompute counters are constructed DETACHED in their own service
  // modules — importing a service must never mutate a shared registry — and attached here, where the
  // one Registry lives. Both registrars are idempotent (`registry.getSingleMetric` guards every
  // name), so building a second server in a test does not throw. Without these two lines
  // `threatlens_publication_*`, `threatlens_publication_settings_read_failures_total` and
  // `threatlens_analytics_recompute_total` never appear on /metrics, and `docs/OPERATIONS.md` names
  // incident conditions nobody can observe.
  registerPublicationMetrics(registry);
  registerAnalyticsSchedulerMetrics(registry);
  registerTelegramCollectorMetrics(registry);
  registerDeploymentMetrics(registry);
  registerBackfillMetrics(registry);
  // `threatlens_analytical_outcomes_total{outcome}` — what became of the events the model was
  // allowed to publish — and `threatlens_analytical_outcomes_pending`, the backlog that separates
  // «promotion is switched off, so there is nothing to score» from «the evaluator stopped running
  // and the precision on /ops has been frozen since». Without this line the only calibration
  // evidence for `ANALYTICAL_THREAT_MIN_CONFIDENCE` lives behind an operator's manual refresh.
  registerAnalyticalOutcomeMetrics(registry);
  // `threatlens_app_settings_read_failures_total` (a boot that fell back to `.env`) and
  // `threatlens_app_settings_overrides` (how many settings the database is currently deciding).
  // `docs/OPERATIONS.md` names the first as an incident condition and the second as the number that
  // explains why a deployment does not behave like its own `.env`.
  registerAppSettingsMetrics(registry);
  // Without this line `threatlens_notifications_suppressed_total` never appears on /metrics, and
  // `docs/OPERATIONS.md` names an incident condition — a fanout more than thirty minutes behind the
  // events it is reading — that nobody could observe.
  registerOutboxMetrics(registry);
  // `threatlens_admin_notices_total`: the operator lines addressed to `TELEGRAM_ADMIN_CHAT_ID`, by
  // reason and by outcome. The `disabled` series is the answer to «чому мені нічого не приходить»
  // and the `failed` one is the only trace of a notice Telegram refused — both are invisible
  // without this line.
  registerAdminNoticeMetrics(registry);
  // `threatlens_attack_research_runs_total{outcome}`: how the operator research surface answered.
  // The refusal series are the point — `refused_daily_cap` and `refused_cooldown` are the governance
  // working and are the only way to see that a console is pressing the button harder than the caps
  // allow, while `model_rejected` is the verifier turning down a memo the model wrote.
  registerAttackResearchMetrics(registry);
  // `threatlens_attack_stats_runs_total{outcome}` and `threatlens_attack_stats_run_duration_seconds`:
  // the open-source attack statistics surface — queued, fresh, refused, ok, inconsistent, rejected,
  // failed — and how long one unbounded model run actually took, which is the only place that
  // number exists once `ATTACK_STATS_TIMEOUT_MS` is zero.
  registerAttackStatsMetrics(registry);
  // `threatlens_codex_classifier_outcomes_total{outcome}` — which messages the model classified, which
  // it suppressed, and which fell back to the rules and why; `threatlens_model_context_operations_total`
  // — appends, compactions and trims of the per-location contexts (migration 049).
  registerCodexClassifierMetrics(registry);
  registerModelContextMetrics(registry);

  const app = Fastify({ logger: { level: config.NODE_ENV === 'development' ? 'debug' : 'info' }, trustProxy: true });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(fastifyStatic, { root: resolve(process.cwd(), 'public'), prefix: '/' });

  app.addHook('onRequest', async (request) => { (request as any).startedAt = performance.now(); });
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unknown';
    httpRequests.inc({ method: request.method, route, status: reply.statusCode });
    httpDuration.observe({ route }, (performance.now() - (request as any).startedAt) / 1000);
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    // The override is honoured whatever the content type is, because a 304 carries none — and a 304
    // that inherited `no-store` would tell the client to throw away the very bytes it just revalidated.
    const override = (reply as unknown as Record<symbol, string | undefined>)[CACHE_CONTROL];
    if (override) reply.header('Cache-Control', override);
    else if (reply.getHeader('content-type')?.toString().includes('application/json')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  /**
   * `commit` and `builtAt` are ADDITIVE; `version` keeps its meaning and its place.
   *
   * This is the endpoint the deployment runner reads before it touches anything, to record what was
   * running when the operator pressed the button (`running_commit_before`). It is also the container
   * healthcheck, so it must stay a constant-time answer that touches nothing.
   */
  app.get('/health/live', async () => ({
    status: 'ok',
    version: process.env.npm_package_version ?? 'dev',
    commit: config.APP_COMMIT,
    builtAt: config.APP_BUILT_AT || null
  }));
  /**
   * Readiness answers for the schema, for the MTProto collector — and, since the update button
   * exists, for the identity of the code answering.
   *
   * The container healthcheck probes `/health/live` (`compose.yaml`), so a not-ready answer here
   * neither restarts the process nor takes the site down — which is what makes it safe to tell the
   * truth: a collector sitting out a Telegram flood wait delivers nothing from any channel, and the
   * whole point of the incident this endpoint covers is that a `healthy` container and fresh
   * `last_success_at` values hid exactly that. `disabled` (no MTProto credentials) and `degraded`
   * (handlers live, some handles unbound) stay ready; `collector` is reported either way, so the
   * probe is additive for every deployment that never runs a collector at all.
   *
   * **`commit` closes the deploy gate.** The runner polls this endpoint after `compose up` and
   * requires both a 200 AND `commit === target`. Without the field, a `up -d` that silently kept the
   * OLD container — because the build produced no new image, because the recreate failed, because
   * compose matched a stale content hash — would answer 200 from the previous release and the run
   * would be recorded as a success. The old container answers truthfully here, which is exactly what
   * makes the check work: it reports the commit IT was built from, and the mismatch is caught.
   *
   * The migration set, not one filename: see {@link SHIPPED_MIGRATIONS}.
   */
  app.get('/health/ready', async (_request, reply) => {
    try {
      const applied = await pool.query<{ filename: string }>(
        `SELECT filename FROM schema_migrations WHERE filename = ANY($1::text[])`,
        [[...SHIPPED_MIGRATIONS]]
      );
      if (applied.rowCount !== SHIPPED_MIGRATIONS.length) {
        // Both lists, not a count: an operator reading this 503 during an update needs to know which
        // file is missing, and the diff is the whole answer.
        return reply.code(503).send({
          status: 'not_ready', reason: 'migrations_pending',
          required: [...SHIPPED_MIGRATIONS],
          applied: applied.rows.map((row) => row.filename).sort(),
          commit: config.APP_COMMIT
        });
      }
      const collector = telegramCollectorStatus();
      if (COLLECTOR_BLOCKED.has(collector.state)) {
        return reply.code(503).send({
          status: 'not_ready', reason: `collector_${collector.state}`, collector, commit: config.APP_COMMIT
        });
      }
      return {
        status: 'ready', commit: config.APP_COMMIT,
        migration: SHIPPED_MIGRATIONS.at(-1) ?? null, collector
      };
    }
    catch { return reply.code(503).send({ status: 'not_ready', commit: config.APP_COMMIT }); }
  });
  app.get('/metrics', async (request, reply) => {
    const bearer = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    const allowed = config.NODE_ENV !== 'production'
      || (Boolean(config.METRICS_TOKEN) && safeEqual(bearer, config.METRICS_TOKEN))
      || hasValidOpsAuth(request.headers.authorization);
    if (!allowed) return reply.code(401).send({ error: 'unauthorized' });
    return reply.type(registry.contentType).send(await registry.metrics());
  });

  // Each of these is registered WITHOUT fastify-plugin on purpose. The encapsulation is what keeps
  // their hooks — the occupation cache headers, the ops auth guards — scoped to their own routes
  // instead of leaking onto every response the server sends.
  await app.register(occupationRoutes, { metricsRegistry: registry });
  await app.register(analyticsRoutes);
  // Public, unlike `analyticsRoutes` above — see the header of the file for why the two cannot share
  // a plugin scope.
  await app.register(attackAnalyticsRoutes);
  // Public as well: the attack statistics block on the same page, its own plugin for its own cache
  // headers and its own per-route rate limit on the one POST.
  await app.register(attackStatsRoutes);
  await app.register(vectorRoutes);
  await app.register(opsVectorRoutes);
  await app.register(opsAttackResearchRoutes);
  await app.register(opsAttackStatsRoutes);
  await app.register(opsCodexRoutes);
  await app.register(opsAiRunsRoutes);
  await app.register(opsSourceTrustRoutes);
  await app.register(opsSourcesRoutes);
  await app.register(opsRuntimeRoutes);
  await app.register(opsSettingsRoutes);
  await app.register(opsDeployRoutes);
  await app.register(opsBackfillRoutes);
  await app.register(opsCoverageRoutes);

  app.get('/api/v1/config', async () => ({
    mapStyleUrl: config.MAP_STYLE_URL,
    timezone: config.APP_TIMEZONE,
    demoMode: config.DEMO_SOURCE_ENABLED,
    telegramBotUsername: config.TELEGRAM_BOT_USERNAME,
    methodologyVersion: 'v2'
  }));
  /**
   * No log query here, only the memoised settings: the mode and the hold length are the two things
   * this document has to state, and neither depends on what is in `system_event_log`.
   */
  app.get('/api/v1/methodology', async () => {
    const mode = (await resolveRuntimeSettings()).publicationMode;
    const delaySeconds = delaySecondsFor(mode);
    return {
      version: 'v2', horizonHours: 6,
      scoreBands: [
        { min: 0, maxExclusive: 2, level: 'background' },
        { min: 2, maxExclusive: 4, level: 'elevated' },
        { min: 4, maxExclusive: 6, level: 'significant' },
        { min: 6, maxExclusive: 8, level: 'high' },
        { min: 8, maxExclusive: 10.1, level: 'very_high' }
      ],
      guardrails: {
        onlyTierCMaximum: 3.9, withoutTierAMaximum: 5.9,
        highConfidenceRequiresTierA: true, independentGroupsForConfidence: 2,
        signalHalfLifeHours: 2,
        // Trust modulates a signal's contribution and nothing else. Published here because a reader
        // who is told "довіра джерела: знижена" on a card is entitled to know how much that changed —
        // and the honest answer is "at most a fifth up, at most two fifths down, and never the tier".
        sourceTrustModifier: { floor: TRUST_MODIFIER_FLOOR, ceiling: TRUST_MODIFIER_CEILING, withoutMeasurement: 1 }
      },
      publication: { mode, delaySeconds },
      // The three existing caveats keep their text and their order; the fourth is APPENDED, never
      // inserted, so a client that renders `caveats[2]` keeps rendering the same sentence.
      //
      // The hold length is INTERPOLATED, never spelled out: `PUBLICATION_DELAY_SECONDS` is validated
      // at 5..60 in `src/config.ts` precisely so a staging deployment can prove the mechanism at five
      // seconds, and a hardcoded «15 секунд» would make this document contradict the
      // `publication.delaySeconds` field two lines above it in the same response. «с» rather than
      // «секунд» sidesteps Ukrainian plural agreement at 22/33/…; the `delayed_15s` enum name is an
      // identifier, not a claim, and stays as it is.
      caveats: [
        'Індикативний відсоток є шкалою індексу, а не статистичною ймовірністю.',
        'Система не прогнозує ціль, влучання або точну траєкторію.',
        'Низький індекс не означає безпеку та не скасовує офіційні вказівки.',
        ...(mode === 'delayed_15s'
          ? [`Публічний показ затримано на ${delaySeconds} с за рішенням оператора. Збір і класифікація не затримуються.`]
          : [])
      ]
    };
  });

  /**
   * One slice per computation, taken before anything it describes.
   *
   * `version` and `generatedAt` come from the same statement as the row queries below them. That
   * also repairs a pre-existing defect: `systemVersion()` used to be evaluated BEFORE the rows, so
   * the snapshot already advertised a version older than its own data.
   *
   * **The four reads are now concurrent.** They were sequential, with a note that `Promise.all` was
   * available if a profile ever justified it; the profile is the endpoint itself, which runs on every
   * page load and paid four serial round trips for four independent statements. None of them holds a
   * pool client across an await — `pool.query()` checks one out and returns it — so with the pool
   * capped at two under `NODE_ENV=test` the surplus queries queue and no query can be waiting on a
   * connection another query of the same batch is holding. The fan-out is also FIXED rather than
   * per-reader, because the single flight in {@link cachedBody} means at most one batch is ever in
   * the air however many readers are waiting.
   *
   * `territoryAncestry` stays sequential after them: it climbs exactly the ids those rows reference.
   *
   * **Publication semantics are untouched.** Every read is still bounded by `slice.cutoffAt`, and the
   * memo can only ever hand back an EARLIER slice — see {@link cachedBody}. `Cache-Control` is
   * `no-store` while the hold is on, so a held body is never written down anywhere; in `live` mode it
   * is `no-cache`, which permits storage but REQUIRES revalidation before every reuse. That is what
   * makes the `ETag` worth emitting, and it is still not a licence to serve an unrevalidated body: a
   * mode flip is caught by the very next conditional request, unlike a `max-age` that cannot be
   * withdrawn once issued.
   */
  const snapshotView = cachedBody(async () => {
    const slice = await publicationSlice();
    const [health, alerts, threats, assessments, originZones] = await Promise.all([
      sourceHealth(),
      activeAlerts(slice.cutoffAt),
      liveThreats(slice.cutoffAt),
      currentAssessments(slice.cutoffAt),
      // Окремим запитом і поруч із рештою: зона походження нічого не стверджує про територію, тож
      // вона не входить ні у `territories`, ні в дерево предків, ні в набір referenced-локацій.
      activeOriginZones()
    ]);
    const officialConfigured = health.filter((source) => source.official && source.configured);
    const systemStatus = officialConfigured.some((source) => source.status === 'current') ? 'current'
      : officialConfigured.length ? 'degraded' : config.DEMO_SOURCE_ENABLED ? 'demo' : 'unconfigured';
    // ONE clock for the whole payload. `sliceMeta` and the territory fold both bucket by freshness,
    // and two `new Date()` calls a few milliseconds apart could land either side of a bucket edge —
    // which would make two consecutive snapshots of identical rows differ in their icon order.
    const now = new Date();
    // Only the ids the rows actually reference are climbed. `SELECT id,parent_id,type FROM locations`
    // is tens of thousands of rows after the KATOTTG import and this endpoint runs on every page
    // load; the ancestry walk is bounded by the referenced set instead.
    const referencedLocationIds = [...new Set([
      ...alerts.map((alert) => alert.location_id as string),
      ...threats.flatMap((threat) => threat.locations.map((location) => location.id)),
      ...assessments.map((assessment) => assessment.location_id as string)
    ])].filter(Boolean);
    const body = Buffer.from(JSON.stringify({
      version: slice.cutoffVersion,
      generatedAt: slice.cutoffAt.toISOString(),
      systemStatus,
      sourceHealth: health, alerts, threats, assessments, originZones,
      // `publication.mode` is NOT itself gated — it reports the setting in force right now, so the
      // UI can never claim to be live while data is being held back.
      publication: sliceMeta(slice, now),
      territories: composeTerritoryStates({
        publishedAt: slice.cutoffAt.toISOString(),
        now,
        nodes: await territoryAncestry(referencedLocationIds),
        alerts, threats, assessments
      })
    }));
    return {
      body,
      etag: strongEtag(body),
      expiresAt: Date.now() + snapshotMemoMs,
      cacheControl: slice.mode === 'delayed_15s' ? 'no-store' : 'no-cache'
    };
  });
  app.get('/api/v1/snapshot', async (request, reply) => sendCached(request, reply, await snapshotView()));

  // Каталог для фронтенду: десятки тисяч рядків після KATOTTG-імпорту, і цей маршрут викликається
  // на кожне завантаження сторінки. Таблицю пише лише добова синхронізація, тож 15 хвилин
  // застарілості невидимі, а кешується вже СЕРІАЛІЗОВАНИЙ рядок: без цього кожен запит платив і за
  // ~30k обʼєктів рядків, і за багатомегабайтний JSON.stringify, і high-water mark старого простору
  // V8 ріс із кожним збігом запитів.
  //
  // Тепер це кешується і ПО HTTP — і тільки тут, бо це єдиний публічний маршрут у цьому файлі без
  // жодної семантики публікації: довідник не залежить від `cutoffAt`, не буває «притриманим» і
  // однаковий для всіх читачів. Глобальний onSend ставив `no-store`, тож кожне завантаження сторінки
  // тягло весь каталог мережею заново; `max-age=900` збігається з внутрішнім TTL, а ETag робить
  // ревалідацію після нього 304-кою замість повторної передачі мегабайтів.
  const LOCATIONS_TTL_MS = 15 * 60_000;
  const locationsView = cachedBody(async () => {
    const result = await pool.query(
      `SELECT id,parent_id,type,name_uk,latitude,longitude FROM locations ORDER BY type,name_uk`
    );
    const body = Buffer.from(JSON.stringify(result.rows));
    return {
      body,
      etag: strongEtag(body),
      expiresAt: Date.now() + LOCATIONS_TTL_MS,
      cacheControl: 'public, max-age=900, stale-while-revalidate=3600'
    };
  });
  app.get('/api/v1/locations', async (request, reply) => sendCached(request, reply, await locationsView()));
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/v1/locations/:id/timeline', async (request, reply) => {
    if (!locationIdPattern.test(request.params.id)) return reply.code(400).send({ error: 'invalid_location_id' });
    const requestedLimit = Number(request.query.limit ?? 100);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) return reply.code(400).send({ error: 'invalid_limit' });
    const slice = await publicationSlice();
    return (await locationTimeline(request.params.id, slice.cutoffAt, Math.min(200, requestedLimit)))
      ?? reply.code(404).send({ error: 'location_not_found' });
  });
  app.get<{ Querystring: { location?: string } }>('/api/v1/channels', async (request, reply) => {
    if (request.query.location && !locationIdPattern.test(request.query.location)) {
      return reply.code(400).send({ error: 'invalid_location_id' });
    }
    return { items: await listRecommendedChannels(request.query.location ?? null) };
  });
  app.get('/api/v1/alerts', async () => activeAlerts((await publicationSlice()).cutoffAt));
  app.get('/api/v1/threats', async () => liveThreats((await publicationSlice()).cutoffAt));
  app.get<{ Params: { id: string } }>('/api/v1/threats/:id', async (request, reply) =>
    uuidPattern.test(request.params.id)
      // An event created after the cutoff 404s exactly as an event that never existed does: the
      // hold must not be distinguishable from absence, or it becomes a probe for held material.
      ? (await threatDetails(request.params.id, (await publicationSlice()).cutoffAt)) ?? reply.code(404).send({ error: 'not_found' })
      : reply.code(400).send({ error: 'invalid_id' }));
  app.get('/api/v1/assessments', async () => currentAssessments((await publicationSlice()).cutoffAt));
  /**
   * The signals behind one assessment, each carrying the word for its publisher's trust.
   *
   * The word is attached here rather than in the repository or in the browser so that there is one
   * definition of where «висока» starts — `trustLabel` in `src/services/source-trust.ts`, the same
   * function the ops API uses. `source_trust` stays on the row for the collapsed technical block the
   * map dialog renders; the main flow of the card shows only the word.
   */
  app.get<{ Params: { id: string } }>('/api/v1/assessments/:id', async (request, reply) => {
    if (!uuidPattern.test(request.params.id)) return reply.code(400).send({ error: 'invalid_id' });
    const slice = await publicationSlice();
    const item = await assessmentDetails(request.params.id, slice.cutoffAt);
    if (!item) return reply.code(404).send({ error: 'not_found' });
    return {
      ...item,
      signals: item.signals.map((signal: Record<string, unknown>) => ({
        ...signal,
        source_trust_label: trustLabel(signal.source_trust as number | null)
      }))
    };
  });
  app.get<{ Querystring: { limit?: string; offset?: string; location?: string; threatType?: string; evidence?: string; from?: string; to?: string } }>('/api/v1/history', async (request, reply) => {
    const limit = Math.min(200, Math.max(1, Number(request.query.limit ?? 50)));
    const offset = Math.max(0, Number(request.query.offset ?? 0));
    if (!Number.isFinite(limit) || !Number.isFinite(offset)) return reply.code(400).send({ error: 'invalid_pagination' });
    const location = request.query.location ?? null;
    const threatType = request.query.threatType ?? null;
    const evidence = request.query.evidence ?? null;
    const from = request.query.from && !Number.isNaN(Date.parse(request.query.from)) ? request.query.from : null;
    const to = request.query.to && !Number.isNaN(Date.parse(request.query.to)) ? request.query.to : null;
    // The location filter matches the whole ancestor/descendant chain, so filtering by an oblast
    // still returns the events of its raions and their cities. With `$1` null the walk starts from
    // nothing and the empty CTE costs a single index probe.
    //
    // `$8` is the publication cutoff, and it gates `created_at`, never `started_at`: `started_at` is
    // the reported real-world time and can precede our discovery of the event by minutes, so a
    // back-dated report would walk straight past any hold.
    //
    // `status` and `ended_at` carry the same as-of-cutoff projection `liveThreats` applies, for the
    // same reason: a threat withdrawn three seconds ago is still on the map as «активна загроза» in
    // this slice, and shipping the raw terminal value here would publish the all-clear ahead of the
    // SSE frame that carries it. `actual_status` keeps the truth for /ops and for tests.
    const slice = await publicationSlice();
    const result = await pool.query(
      `${relatedLocationsCte()}
       SELECT DISTINCT e.id,e.threat_type,
              CASE WHEN e.status IN ('expired','withdrawn','corrected') AND e.ended_at > $8
                   THEN 'active' ELSE e.status END AS status,
              e.status AS actual_status,
              -- origin travels with evidence_level on every public read, never without it: the
              -- archive is where a reader checks what was claimed and by whom, and an entry that
              -- says only «не перевірено» hides that a model wrote it. threatDetails() gets the
              -- column for free through its e.* expansion; this list is explicit and has to name it.
              e.evidence_level,e.origin,e.title,e.summary,e.started_at,e.last_observed_at,
              -- Актуальність і ймовірність (міграція 049) — з тієї самої причини, що й origin: архів
              -- має казати, що «увечері очікується» було очікуванням, а не загрозою на ту мить.
              e.timing,e.probability,e.expected_from,e.expected_until,e.classified_by,
              CASE WHEN e.ended_at > $8 THEN NULL ELSE e.ended_at END AS ended_at
       FROM threat_events e LEFT JOIN threat_event_locations el ON el.event_id=e.id
       WHERE ($1::text IS NULL OR EXISTS (SELECT 1 FROM related_locations r WHERE r.id=el.location_id))
         AND ($2::text IS NULL OR e.threat_type=$2)
         AND ($3::text IS NULL OR e.evidence_level=$3) AND ($4::timestamptz IS NULL OR e.started_at >= $4)
         AND ($5::timestamptz IS NULL OR e.started_at <= $5)
         AND e.created_at <= $8
       ORDER BY e.started_at DESC LIMIT $6 OFFSET $7`,
      [location, threatType, evidence, from, to, limit, offset, slice.cutoffAt]
    );
    return { items: result.rows, limit, offset };
  });
  app.get('/api/v1/sources/health', async () => sourceHealth());
  app.get<{ Querystring: { month?: string; location?: string } }>('/api/v1/analytics/monthly', async (request, reply) => {
    const month = request.query.month ?? new Date().toISOString().slice(0, 7) + '-01';
    if (!/^\d{4}-\d{2}-01$/.test(month)) return reply.code(400).send({ error: 'invalid_month' });
    const location = request.query.location ?? null;
    const [alerts, threats] = await Promise.all([
      pool.query(`SELECT m.*,l.name_uk FROM monthly_alert_summary m JOIN locations l ON l.id=m.location_id WHERE month=$1 AND ($2::text IS NULL OR location_id=$2)`, [month, location]),
      pool.query(`SELECT m.*,l.name_uk FROM monthly_threat_summary m JOIN locations l ON l.id=m.location_id WHERE month=$1 AND ($2::text IS NULL OR location_id=$2)`, [month, location])
    ]);
    return { month, alerts: alerts.rows, threats: threats.rows };
  });

  // Межі повільного споживача для /api/v1/stream. Захоплена (hijacked) SSE-відповідь не має
  // власного таймауту: heartbeat раз на 15 с тримає зʼєднання живим на рівні застосунку навіть коли
  // TCP-вікно клієнта закрите, тож кожен кадр для завислого клієнта осідає в writable-буфері сокета
  // — у heap — без стелі. Межа нижче і є стелею: клієнт, що відстав на пів мегабайта, не читає, і
  // розрив сокета йому нічого не коштує — EventSource перепідключиться з Last-Event-ID, а backfill
  // дошле до 500 пропущених подій.
  const SSE_MAX_BUFFERED_BYTES = 512 * 1024;
  // Ліміт одночасних стрімів: rate limiter рахує запити за хвилину, а не відкриті стріми, тож без
  // цього один клієнт міг би тримати тисячі захоплених відповідей — кожну зі своїм слухачем хаба,
  // інтервалом і буфером запису. 500 × 512 КіБ обмежує найгірший випадок завислих стрімів 256 МіБ.
  const SSE_MAX_STREAMS = 500;
  let openSseStreams = 0;
  app.get<{ Querystring: { since?: string } }>('/api/v1/stream', async (request, reply) => {
    if (openSseStreams >= SSE_MAX_STREAMS) {
      return reply.code(503).header('Retry-After', '30').send({ error: 'stream_capacity' });
    }
    reply.hijack();
    openSseStreams += 1;
    sseConnections.inc();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
    });
    // `?since=` is treated exactly as `Last-Event-ID`. `boot()` in the browser does
    // `await loadSnapshot(); connectStream();` and used to open a bare EventSource with no resume
    // point, so every event committed between the snapshot's cutoff and the handshake was invisible
    // to that tab until some later event happened to arrive. The backfill bound below is still
    // `slice.cutoffVersion`, so this cannot leak past the cutoff.
    const lastEventId = Math.max(0, Number(request.headers['last-event-id'] ?? request.query.since ?? 0) || 0);
    let closed = false;
    const writeFrame = (frame: string) => {
      if (closed) return;
      reply.raw.write(frame);
      // `write()` повертає false задовго до реальної небезпеки; рветься зʼєднання лише коли сокет
      // накопичив більше за межу. destroy() підніме 'close', і прибирання нижче зробить решту.
      if ((reply.raw.socket?.writableLength ?? 0) > SSE_MAX_BUFFERED_BYTES) request.raw.destroy();
    };
    // ============================================================================================
    // THE SUBSCRIPTION IS THE FIRST THING THAT HAPPENS AFTER HIJACK. Every await below it is
    // protected by relay.buffer.
    //
    // Registering `eventHub.on` after the first await opens a window in which the hub emits to every
    // OTHER connection but not to this one — and those versions are also above this connection's
    // backfill upper bound, so they are lost for it PERMANENTLY. (Reconnect with Last-Event-ID: 100;
    // the slice query takes a pool round trip; the slice puts cutoffVersion at 105; version 106
    // commits; the hub's one-second tick emits 106 with `send` not yet registered; the backfill then
    // delivers 101…105 and 106 is never seen. The browser only refetches the snapshot on an SSE
    // event, so if 106 was the `alert.ended` the map keeps drawing the alert.)
    //
    // The `close` handler is registered here for the same reason: a client that disconnects during
    // the await would otherwise leak a hub listener.
    // ============================================================================================
    // `sseFrame`, not an inline template: the hub hands the SAME envelope object to every open
    // stream, so the bytes are built once per event instead of once per event per connection.
    const relay = createEventRelay(lastEventId, (event) => { writeFrame(sseFrame(event)); });
    const send = (event: SystemEvent) => relay.buffer(event);
    const heartbeat = setInterval(() => writeFrame(`: heartbeat ${Date.now()}\n\n`), 15_000);
    eventHub.on('event', send);
    const cleanup = () => {
      if (closed) return;
      closed = true; clearInterval(heartbeat); eventHub.off('event', send);
      openSseStreams -= 1; sseConnections.dec();
    };
    request.raw.on('close', cleanup);
    // Асинхронні onRequest-хуки (rate limit) відпрацьовують ДО тіла обробника: сокет міг померти ще
    // там, і тоді його 'close' уже відлунав — слухач вище не спрацює ніколи, а heartbeat-інтервал і
    // слухач хаба текли б до кінця життя процесу.
    if (request.raw.destroyed) cleanup();
    // ONE slice for this connection: the `connected` frame, the backfill bound and the mode label on
    // every backfilled envelope all come from it. Taking three separate readings would let a client
    // be told it is caught up to a version the backfill then refused to send.
    const slice = await publicationSlice();
    // The `at` / `version` field names are unchanged. This is the compatibility contract.
    writeFrame(`retry: 3000\nevent: connected\ndata: ${JSON.stringify({
      at: slice.cutoffAt.toISOString(), version: slice.cutoffVersion
    })}\n\n`);
    try {
      if (lastEventId) {
        const missed = await pool.query(
          `SELECT version,event_type,payload,created_at FROM system_event_log
           WHERE version > $1 AND version <= $2 ORDER BY version LIMIT 500`, [lastEventId, slice.cutoffVersion]
        );
        const releasedAt = new Date();
        for (const row of missed.rows) {
          observeSseDeliveryLag('backfill', (releasedAt.getTime() - row.created_at.getTime()) / 1000);
          relay.deliver(publishedEnvelope(row, slice.mode, releasedAt));
        }
      }
    } catch (error) {
      request.log.error({ error }, 'sse backfill failed');
    } finally {
      relay.flush();
    }
  });

  app.get('/ops/api', async (request, reply) => {
    if (!hasValidOpsAuth(request.headers.authorization)) return opsUnauthorized(request, reply);
    const [sources, outbox, ai, database, channels, telegramDelivery] = await Promise.all([
      pool.query(`SELECT id,name,tier,last_success_at,last_error_at,last_error FROM sources ORDER BY tier,id`),
      pool.query(`SELECT status,priority,count(*)::integer FROM notification_outbox GROUP BY status,priority ORDER BY priority,status`),
      pool.query(`SELECT id,model,status,error,duration_ms,created_at FROM ai_runs ORDER BY created_at DESC LIMIT 20`),
      pool.query(`SELECT pg_size_pretty(pg_database_size(current_database())) size,now() database_time`),
      listRecommendedChannels(null, true),
      telegramDeliveryGovernorStatus()
    ]);
    return {
      sources: sources.rows, outbox: outbox.rows, aiRuns: ai.rows,
      database: database.rows[0], channels, telegramDelivery
    };
  });
  app.post('/ops/channels', async (request, reply) => {
    if (!hasValidOpsAuth(request.headers.authorization)) return opsUnauthorized(request, reply);
    const parsed = createChannelSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_channel', issues: parsed.error.flatten().fieldErrors });
    try {
      const channel = await createRecommendedChannel(parsed.data, config.OPS_USER);
      return reply.code(201).send(channel);
    } catch (error: any) {
      if (error?.code === '23505') return reply.code(409).send({ error: 'channel_exists' });
      if (error?.code === '23503') return reply.code(400).send({ error: 'invalid_location' });
      throw error;
    }
  });
  app.patch<{ Params: { id: string } }>('/ops/channels/:id', async (request, reply) => {
    if (!hasValidOpsAuth(request.headers.authorization)) return opsUnauthorized(request, reply);
    if (!uuidPattern.test(request.params.id)) return reply.code(400).send({ error: 'invalid_id' });
    const parsed = updateChannelSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_channel', issues: parsed.error.flatten().fieldErrors });
    try {
      return (await updateRecommendedChannel(request.params.id, parsed.data))
        ?? reply.code(404).send({ error: 'not_found' });
    } catch (error: any) {
      if (error?.code === '23505') return reply.code(409).send({ error: 'channel_exists' });
      if (error?.code === '23503') return reply.code(400).send({ error: 'invalid_location' });
      throw error;
    }
  });
  app.post('/ops/run-assessment', async (request, reply) => {
    if (!hasValidOpsAuth(request.headers.authorization)) return opsUnauthorized(request, reply);
    return { published: await runRiskAssessments() };
  });

  /**
   * The settings console is a route of the single-page app, and it has to be declared BEFORE
   * `setNotFoundHandler` below.
   *
   * `/ops/settings` starts with `/ops/`, and the not-found handler JSON-404s exactly those prefixes
   * — so without this line a direct load or a browser refresh of the settings page would be answered
   * with `{"error":"not_found"}` instead of the application, while in-app navigation worked fine.
   * That is the shape of bug nobody meets until an operator bookmarks the page.
   */
  app.get('/ops/settings', async (_request, reply) => reply.type('text/html').sendFile('index.html'));

  app.setNotFoundHandler(async (request, reply) => {
    if (request.raw.url?.startsWith('/api/') || request.raw.url?.startsWith('/health/') || request.raw.url?.startsWith('/ops/')) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.type('text/html').sendFile('index.html');
  });
  app.setErrorHandler(async (error, request, reply) => {
    request.log.error({ error }, 'request failed');
    if (reply.sent) return;
    const failure = error as { statusCode?: number; name?: string };
    const statusCode = failure.statusCode && failure.statusCode < 500 ? failure.statusCode : 500;
    return reply.code(statusCode).send({
      error: statusCode < 500 ? failure.name ?? 'request_error' : 'internal_error'
    });
  });
  return app;
}
