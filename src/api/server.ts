import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { Registry, collectDefaultMetrics, Counter, Gauge, Histogram } from 'prom-client';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { composeTerritoryStates } from '../domain/territory-state.js';
import { activeAlerts, assessmentDetails, currentAssessments, liveThreats, locationTimeline, relatedLocationsCte, territoryAncestry, threatDetails } from '../repositories/events.js';
import { createEventRelay, eventHub, publishedEnvelope, type SystemEvent } from '../services/sse.js';
import { delaySecondsFor, observeSseDeliveryLag, publicationSlice, registerPublicationMetrics, sliceMeta } from '../services/publication.js';
import { registerAnalyticsSchedulerMetrics } from '../services/analytics-scheduler.js';
import { registerDeploymentMetrics } from '../services/deployment.js';
import { registerBackfillMetrics } from '../services/source-backfill.js';
import { registerAppSettingsMetrics } from '../services/app-settings.js';
import { registerOutboxMetrics } from '../bot/outbox.js';
import { resolveRuntimeSettings } from '../services/runtime-settings.js';
import { registerAlertChannelMetrics } from '../services/ingestion.js';
import { registerTelegramCollectorMetrics, telegramCollectorStatus } from '../sources/telegram.js';
import { hasValidOpsAuth, opsUnauthorized, safeEqual } from './ops-auth.js';
import analyticsRoutes from './analytics-routes.js';
import attackAnalyticsRoutes from './attack-analytics-routes.js';
import occupationRoutes from './occupation-routes.js';
import opsAiRunsRoutes from './ops-ai-runs-routes.js';
import opsCodexRoutes from './ops-codex-routes.js';
import opsBackfillRoutes from './ops-backfill-routes.js';
import opsCoverageRoutes from './ops-coverage-routes.js';
import opsDeployRoutes from './ops-deploy-routes.js';
import opsRuntimeRoutes from './ops-runtime-routes.js';
import opsSettingsRoutes from './ops-settings-routes.js';
import opsSourceTrustRoutes from './ops-source-trust-routes.js';
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
  const mtproto = Boolean(config.TELEGRAM_API_ID && config.TELEGRAM_API_HASH && config.TELEGRAM_SESSION);
  switch (row.adapter_type) {
    case 'mtproto':
    case 'mtproto_alert_channel':
    case 'mtproto_monitor':
      return mtproto && row.enabled;
    case 'ukraine_alarm': return Boolean(config.UKRAINE_ALARM_API_TOKEN);
    case 'alerts_in_ua': return Boolean(config.ALERTS_IN_UA_TOKEN);
    case 'demo': return config.DEMO_SOURCE_ENABLED;
    default: return row.enabled;
  }
}

/** Adapter types the MTProto collector, and only the MTProto collector, is responsible for. */
const MTPROTO_ADAPTERS = new Set(['mtproto', 'mtproto_alert_channel', 'mtproto_monitor']);

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
      ...row, configured, status: configured ? row.health_status : 'unconfigured',
      // ADDITIVE, and null for every non-MTProto row: `status` keeps its existing vocabulary
      // (`current`/`stale`/`error`/`unknown`/`unconfigured`) because the web console maps those by
      // name. What this adds is the in-process fact the database cannot hold — whether the live
      // handlers exist at all — so a flood wait is visible before `stale_after_seconds` elapses.
      collector: MTPROTO_ADAPTERS.has(row.adapter_type) ? collector : null
    };
  });
}

export async function buildServer() {
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
  // `threatlens_app_settings_read_failures_total` (a boot that fell back to `.env`) and
  // `threatlens_app_settings_overrides` (how many settings the database is currently deciding).
  // `docs/OPERATIONS.md` names the first as an incident condition and the second as the number that
  // explains why a deployment does not behave like its own `.env`.
  registerAppSettingsMetrics(registry);
  // Without this line `threatlens_notifications_suppressed_total` never appears on /metrics, and
  // `docs/OPERATIONS.md` names an incident condition — a fanout more than thirty minutes behind the
  // events it is reading — that nobody could observe.
  registerOutboxMetrics(registry);

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
    if (reply.getHeader('content-type')?.toString().includes('application/json')) reply.header('Cache-Control', 'no-store');
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
  await app.register(vectorRoutes);
  await app.register(opsVectorRoutes);
  await app.register(opsCodexRoutes);
  await app.register(opsAiRunsRoutes);
  await app.register(opsSourceTrustRoutes);
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
   * One slice per request, taken before anything it describes.
   *
   * `version` and `generatedAt` now come from the same statement as the three row queries below
   * them. That also repairs a pre-existing defect: `systemVersion()` used to be evaluated BEFORE the
   * rows, so the snapshot already advertised a version older than its own data.
   *
   * The three row queries stay sequential, matching what was here before. Under `NODE_ENV=test` the
   * application pool is capped at two connections, and the correctness of the slice does not depend
   * on the fan-out — `Promise.all` is available if a profile ever justifies it.
   *
   * `Cache-Control: no-store` stays on this response (the server-wide `onSend` provides it and this
   * route installs no child hook): caching a held payload for 120 s would make the hold unbounded.
   */
  app.get('/api/v1/snapshot', async () => {
    const slice = await publicationSlice();
    const health = await sourceHealth();
    const officialConfigured = health.filter((source) => source.official && source.configured);
    const systemStatus = officialConfigured.some((source) => source.status === 'current') ? 'current'
      : officialConfigured.length ? 'degraded' : config.DEMO_SOURCE_ENABLED ? 'demo' : 'unconfigured';
    const alerts = await activeAlerts(slice.cutoffAt);
    const threats = await liveThreats(slice.cutoffAt);
    const assessments = await currentAssessments(slice.cutoffAt);
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
    return {
      version: slice.cutoffVersion,
      generatedAt: slice.cutoffAt.toISOString(),
      systemStatus,
      sourceHealth: health, alerts, threats, assessments,
      // `publication.mode` is NOT itself gated — it reports the setting in force right now, so the
      // UI can never claim to be live while data is being held back.
      publication: sliceMeta(slice, now),
      territories: composeTerritoryStates({
        publishedAt: slice.cutoffAt.toISOString(),
        now,
        nodes: await territoryAncestry(referencedLocationIds),
        alerts, threats, assessments
      })
    };
  });

  app.get('/api/v1/locations', async () => (await pool.query(
    `SELECT id,parent_id,type,name_uk,latitude,longitude FROM locations ORDER BY type,name_uk`
  )).rows);
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
              e.evidence_level,e.title,e.summary,e.started_at,e.last_observed_at,
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

  app.get<{ Querystring: { since?: string } }>('/api/v1/stream', async (request, reply) => {
    reply.hijack();
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
    const writeFrame = (frame: string) => { if (!closed) reply.raw.write(frame); };
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
    const relay = createEventRelay(lastEventId, (event) => {
      writeFrame(`id: ${event.version}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const send = (event: SystemEvent) => relay.buffer(event);
    const heartbeat = setInterval(() => writeFrame(`: heartbeat ${Date.now()}\n\n`), 15_000);
    eventHub.on('event', send);
    request.raw.on('close', () => { closed = true; clearInterval(heartbeat); eventHub.off('event', send); sseConnections.dec(); });
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
    const [sources, outbox, ai, database, channels] = await Promise.all([
      pool.query(`SELECT id,name,tier,last_success_at,last_error_at,last_error FROM sources ORDER BY tier,id`),
      pool.query(`SELECT status,priority,count(*)::integer FROM notification_outbox GROUP BY status,priority ORDER BY priority,status`),
      pool.query(`SELECT id,model,status,error,duration_ms,created_at FROM ai_runs ORDER BY created_at DESC LIMIT 20`),
      pool.query(`SELECT pg_size_pretty(pg_database_size(current_database())) size,now() database_time`),
      listRecommendedChannels(null, true)
    ]);
    return { sources: sources.rows, outbox: outbox.rows, aiRuns: ai.rows, database: database.rows[0], channels };
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
