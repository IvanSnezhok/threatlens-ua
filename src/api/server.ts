import { resolve } from 'node:path';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { Registry, collectDefaultMetrics, Counter, Gauge, Histogram } from 'prom-client';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { activeAlerts, assessmentDetails, currentAssessments, liveThreats, locationTimeline, relatedLocationsCte, systemVersion, threatDetails } from '../repositories/events.js';
import { createEventRelay, eventHub, type SystemEvent } from '../services/sse.js';
import { registerAlertChannelMetrics } from '../services/ingestion.js';
import { hasValidOpsAuth, safeEqual } from './ops-auth.js';
import analyticsRoutes from './analytics-routes.js';
import occupationRoutes from './occupation-routes.js';
import opsAiRunsRoutes from './ops-ai-runs-routes.js';
import opsCodexRoutes from './ops-codex-routes.js';
import opsVectorRoutes from './ops-vector-routes.js';
import vectorRoutes from './vector-routes.js';
import { runRiskAssessments } from '../services/risk.js';
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

async function sourceHealth() {
  const rows = (await pool.query(
    `SELECT id,name,tier,official,enabled,adapter_type,last_success_at,last_error_at,last_error,
      health_status,stale_after_seconds FROM sources ORDER BY tier,id`
  )).rows;
  return rows.map((row) => {
    const configured = sourceIsConfigured(row);
    return { ...row, configured, status: configured ? row.health_status : 'unconfigured' };
  });
}

export async function buildServer() {
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

  app.get('/health/live', async () => ({ status: 'ok', version: process.env.npm_package_version ?? 'dev' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      const migration = await pool.query(`SELECT 1 FROM schema_migrations WHERE filename='017_codex_oauth.sql'`);
      if (!migration.rowCount) return reply.code(503).send({ status: 'not_ready', reason: 'migrations_pending' });
      return { status: 'ready' };
    }
    catch { return reply.code(503).send({ status: 'not_ready' }); }
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
  await app.register(vectorRoutes);
  await app.register(opsVectorRoutes);
  await app.register(opsCodexRoutes);
  await app.register(opsAiRunsRoutes);

  app.get('/api/v1/config', async () => ({
    mapStyleUrl: config.MAP_STYLE_URL,
    timezone: config.APP_TIMEZONE,
    demoMode: config.DEMO_SOURCE_ENABLED,
    telegramBotUsername: config.TELEGRAM_BOT_USERNAME,
    methodologyVersion: 'v2'
  }));
  app.get('/api/v1/methodology', async () => ({
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
      signalHalfLifeHours: 2
    },
    caveats: [
      'Індикативний відсоток є шкалою індексу, а не статистичною ймовірністю.',
      'Система не прогнозує ціль, влучання або точну траєкторію.',
      'Низький індекс не означає безпеку та не скасовує офіційні вказівки.'
    ]
  }));

  app.get('/api/v1/snapshot', async () => {
    const health = await sourceHealth();
    const officialConfigured = health.filter((source) => source.official && source.configured);
    const systemStatus = officialConfigured.some((source) => source.status === 'current') ? 'current'
      : officialConfigured.length ? 'degraded' : config.DEMO_SOURCE_ENABLED ? 'demo' : 'unconfigured';
    return {
      version: await systemVersion(), generatedAt: new Date().toISOString(), systemStatus,
      sourceHealth: health, alerts: await activeAlerts(), threats: await liveThreats(), assessments: await currentAssessments()
    };
  });

  app.get('/api/v1/locations', async () => (await pool.query(
    `SELECT id,parent_id,type,name_uk,latitude,longitude FROM locations ORDER BY type,name_uk`
  )).rows);
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/v1/locations/:id/timeline', async (request, reply) => {
    if (!locationIdPattern.test(request.params.id)) return reply.code(400).send({ error: 'invalid_location_id' });
    const requestedLimit = Number(request.query.limit ?? 100);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) return reply.code(400).send({ error: 'invalid_limit' });
    return (await locationTimeline(request.params.id, Math.min(200, requestedLimit)))
      ?? reply.code(404).send({ error: 'location_not_found' });
  });
  app.get<{ Querystring: { location?: string } }>('/api/v1/channels', async (request, reply) => {
    if (request.query.location && !locationIdPattern.test(request.query.location)) {
      return reply.code(400).send({ error: 'invalid_location_id' });
    }
    return { items: await listRecommendedChannels(request.query.location ?? null) };
  });
  app.get('/api/v1/alerts', async () => activeAlerts());
  app.get('/api/v1/threats', async () => liveThreats());
  app.get<{ Params: { id: string } }>('/api/v1/threats/:id', async (request, reply) =>
    uuidPattern.test(request.params.id)
      ? (await threatDetails(request.params.id)) ?? reply.code(404).send({ error: 'not_found' })
      : reply.code(400).send({ error: 'invalid_id' }));
  app.get('/api/v1/assessments', async () => currentAssessments());
  app.get<{ Params: { id: string } }>('/api/v1/assessments/:id', async (request, reply) =>
    uuidPattern.test(request.params.id)
      ? (await assessmentDetails(request.params.id)) ?? reply.code(404).send({ error: 'not_found' })
      : reply.code(400).send({ error: 'invalid_id' }));
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
    const result = await pool.query(
      `${relatedLocationsCte()}
       SELECT DISTINCT e.id,e.threat_type,e.status,e.evidence_level,e.title,e.summary,e.started_at,e.last_observed_at,e.ended_at
       FROM threat_events e LEFT JOIN threat_event_locations el ON el.event_id=e.id
       WHERE ($1::text IS NULL OR EXISTS (SELECT 1 FROM related_locations r WHERE r.id=el.location_id))
         AND ($2::text IS NULL OR e.threat_type=$2)
         AND ($3::text IS NULL OR e.evidence_level=$3) AND ($4::timestamptz IS NULL OR e.started_at >= $4)
         AND ($5::timestamptz IS NULL OR e.started_at <= $5)
       ORDER BY e.started_at DESC LIMIT $6 OFFSET $7`, [location, threatType, evidence, from, to, limit, offset]
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

  app.get('/api/v1/stream', async (request, reply) => {
    reply.hijack();
    sseConnections.inc();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
    });
    const lastEventId = Math.max(0, Number(request.headers['last-event-id'] ?? 0) || 0);
    let closed = false;
    const writeFrame = (frame: string) => { if (!closed) reply.raw.write(frame); };
    const relay = createEventRelay(lastEventId, (event) => {
      writeFrame(`id: ${event.version}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const send = (event: SystemEvent) => relay.buffer(event);
    const heartbeat = setInterval(() => writeFrame(`: heartbeat ${Date.now()}\n\n`), 15_000);
    eventHub.on('event', send);
    request.raw.on('close', () => { closed = true; clearInterval(heartbeat); eventHub.off('event', send); sseConnections.dec(); });
    writeFrame(`retry: 3000\nevent: connected\ndata: ${JSON.stringify({ at: new Date().toISOString(), version: await systemVersion() })}\n\n`);
    try {
      if (lastEventId) {
        const missed = await pool.query(
          `SELECT version,event_type,payload,created_at FROM system_event_log
           WHERE version>$1 ORDER BY version LIMIT 500`, [lastEventId]
        );
        for (const row of missed.rows) relay.deliver({
          version: Number(row.version), eventType: row.event_type, payload: row.payload, createdAt: row.created_at.toISOString()
        });
      }
    } catch (error) {
      request.log.error({ error }, 'sse backfill failed');
    } finally {
      relay.flush();
    }
  });

  app.get('/ops/api', async (request, reply) => {
    if (!hasValidOpsAuth(request.headers.authorization)) {
      return reply.header('WWW-Authenticate', 'Basic realm="ThreatLens Ops"').code(401).send({ error: 'unauthorized' });
    }
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
    if (!hasValidOpsAuth(request.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
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
    if (!hasValidOpsAuth(request.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' });
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
    if (!hasValidOpsAuth(request.headers.authorization)) {
      return reply.header('WWW-Authenticate', 'Basic realm="ThreatLens Ops"').code(401).send({ error: 'unauthorized' });
    }
    return { published: await runRiskAssessments() };
  });

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
