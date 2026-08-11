import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { unresolvedLocationReports } from '../services/ingestion.js';
import { requestTelegramCollectorReload, telegramCollectorStatus } from '../sources/telegram.js';
import { hasValidOpsAuth, opsUnauthorized } from './ops-auth.js';

const MANAGED_ADAPTERS = [
  'ukraine_alarm', 'alerts_in_ua', 'aerial_alerts_mirror',
  'mtproto', 'mtproto_alert_channel', 'mtproto_monitor'
] as const;
const TELEGRAM_ADAPTERS = new Set(['mtproto', 'mtproto_alert_channel', 'mtproto_monitor']);
const ALERT_ADAPTERS = new Set([
  'ukraine_alarm', 'alerts_in_ua', 'aerial_alerts_mirror', 'mtproto_alert_channel'
]);

const sourceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,95}$/i);
const changeSchema = z.object({
  enabled: z.boolean(),
  expectedEnabled: z.boolean(),
  reason: z.string().trim().min(8).max(500),
  confirmation: z.string().max(120).optional(),
  acknowledgeOfficialAuthority: z.boolean().optional().default(false),
  acknowledgeHeldAlerts: z.boolean().optional().default(false)
}).strict();

function authorised(request: FastifyRequest): boolean {
  return hasValidOpsAuth(request.headers.authorization);
}

function sourceConfigured(row: { adapter_type: string; enabled: boolean }): boolean {
  if (!row.enabled) return false;
  const mtproto = Boolean(config.TELEGRAM_API_ID && config.TELEGRAM_API_HASH && config.TELEGRAM_SESSION);
  switch (row.adapter_type) {
    case 'mtproto':
    case 'mtproto_alert_channel':
    case 'mtproto_monitor': return mtproto;
    case 'ukraine_alarm': return Boolean(config.UKRAINE_ALARM_API_TOKEN);
    case 'alerts_in_ua': return Boolean(config.ALERTS_IN_UA_TOKEN);
    case 'aerial_alerts_mirror': return config.AERIAL_MIRROR_ENABLED;
    default: return false;
  }
}

const SOURCE_LEDGER_SQL = `
WITH latest_message AS (
  SELECT source_id,max(received_at) AS received_at,max(published_at) AS published_at
    FROM source_messages GROUP BY source_id
), holds AS (
  SELECT ass.source_id,
         count(*) FILTER (WHERE ass.active OR COALESCE(
           ass.missing_since > now()-($1::int * interval '1 second'),false))::int AS holding_count,
         min(COALESCE(ass.provider_started_at,ass.last_event_at,ass.updated_at)) FILTER (
           WHERE ass.active OR COALESCE(
             ass.missing_since > now()-($1::int * interval '1 second'),false)) AS oldest_hold_at,
         jsonb_agg(jsonb_build_object(
           'locationId',ass.location_id,'locationName',l.name_uk,'alertType',ass.alert_type,
           'active',ass.active,'missingSince',ass.missing_since,
           'startedAt',COALESCE(ass.provider_started_at,ass.last_event_at,ass.updated_at)
         ) ORDER BY l.name_uk) FILTER (WHERE ass.active OR COALESCE(
           ass.missing_since > now()-($1::int * interval '1 second'),false)) AS holding
    FROM alert_source_states ass JOIN locations l ON l.id=ass.location_id GROUP BY ass.source_id
), gaps AS (
  SELECT mc.source_id,count(*)::int AS ignored_no_location_24h,max(mc.published_at) AS last_gap_at
    FROM message_classifications mc
   WHERE mc.ignored_reason='no_location' AND mc.published_at >= now()-interval '24 hours'
   GROUP BY mc.source_id
), latest_audit AS (
  SELECT DISTINCT ON (source_id) source_id,reason,changed_by,changed_at
    FROM source_enabled_audit ORDER BY source_id,changed_at DESC
)
SELECT s.id,s.name,s.source_type,s.tier,s.official,s.enabled,s.adapter_type,s.independence_group,
       s.expected_update_interval_seconds,s.stale_after_seconds,s.public_url,s.telegram_username,
       s.health_status,s.last_success_at,s.last_error_at,s.last_error,
       lm.received_at AS last_message_received_at,lm.published_at AS last_message_published_at,
       COALESCE(h.holding_count,0)::int AS holding_count,h.oldest_hold_at,
       COALESCE(h.holding,'[]'::jsonb) AS holding,
       COALESCE(g.ignored_no_location_24h,0)::int AS ignored_no_location_24h,g.last_gap_at,
       la.reason AS last_change_reason,la.changed_by AS last_changed_by,la.changed_at AS last_changed_at
  FROM sources s
  LEFT JOIN latest_message lm ON lm.source_id=s.id
  LEFT JOIN holds h ON h.source_id=s.id
  LEFT JOIN gaps g ON g.source_id=s.id
  LEFT JOIN latest_audit la ON la.source_id=s.id
 WHERE s.adapter_type = ANY($2::text[])
 ORDER BY CASE WHEN s.official THEN 0 ELSE 1 END,s.tier,s.name,s.id`;

async function readSources() {
  const rows = (await pool.query(SOURCE_LEDGER_SQL, [
    config.ALERT_END_DEBOUNCE_SECONDS, [...MANAGED_ADAPTERS]
  ])).rows;
  const reports = new Map(unresolvedLocationReports().map((report) => [report.sourceId, report]));
  const collector = telegramCollectorStatus();
  return rows.map((row) => {
    const configured = sourceConfigured(row);
    const report = reports.get(row.id);
    return {
      id: row.id,
      name: row.name,
      sourceType: row.source_type,
      tier: row.tier,
      official: row.official,
      enabled: row.enabled,
      adapterType: row.adapter_type,
      independenceGroup: row.independence_group,
      telegramUsername: row.telegram_username,
      publicUrl: row.public_url,
      configured,
      status: !row.enabled ? 'disabled' : configured ? row.health_status : 'unconfigured',
      expectedUpdateIntervalSeconds: row.expected_update_interval_seconds,
      staleAfterSeconds: row.stale_after_seconds,
      lastSuccessAt: row.last_success_at,
      lastErrorAt: row.last_error_at,
      lastError: row.last_error,
      lastMessageReceivedAt: row.last_message_received_at,
      lastMessagePublishedAt: row.last_message_published_at,
      holdingCount: row.holding_count,
      oldestHoldAt: row.oldest_hold_at,
      holding: row.holding,
      catalogueGaps: {
        ignoredMessages24h: row.ignored_no_location_24h,
        lastIgnoredAt: row.last_gap_at,
        providerCount: report?.count ?? 0,
        providerSamples: report?.samples ?? [],
        observedAt: report?.observedAt ?? null
      },
      lastChange: row.last_changed_at ? {
        reason: row.last_change_reason, changedBy: row.last_changed_by, changedAt: row.last_changed_at
      } : null,
      collector: TELEGRAM_ADAPTERS.has(row.adapter_type) ? collector : null
    };
  });
}

const opsSourcesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/ops/api/sources', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    const sources = await readSources();
    return {
      generatedAt: new Date().toISOString(),
      notice: 'Вимкнення зупиняє майбутній збір, але не стирає стан тривоги, який джерело вже тримає. Аналітичні Telegram-джерела не можуть змінювати alert_source_states або alert_periods.',
      totals: {
        sources: sources.length,
        enabled: sources.filter((source) => source.enabled).length,
        failing: sources.filter((source) => ['error', 'stale'].includes(source.status)).length,
        holding: sources.filter((source) => source.holdingCount > 0).length,
        withGaps: sources.filter((source) => source.catalogueGaps.providerCount > 0
          || source.catalogueGaps.ignoredMessages24h > 0).length
      },
      sources
    };
  });

  app.put<{ Params: { id: string } }>('/ops/api/sources/:id', async (request, reply) => {
    if (!authorised(request)) return opsUnauthorized(request, reply);
    if (!sourceIdSchema.safeParse(request.params.id).success) {
      return reply.code(400).send({ error: 'invalid_source_id' });
    }
    const parsed = changeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_source_change', issues: parsed.error.flatten().fieldErrors });
    }
    const client = await pool.connect();
    let adapterType: string;
    try {
      await client.query('BEGIN');
      // One decision at a time. Row locks on two different source ids would still let two requests
      // both observe "one other official source" and disable the final pair concurrently.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('ops-source-enabled-change'))`);
      const source = await client.query<{
        id: string; name: string; enabled: boolean; official: boolean; adapter_type: string;
      }>(
        `SELECT id,name,enabled,official,adapter_type FROM sources
          WHERE id=$1 AND adapter_type=ANY($2::text[]) FOR UPDATE`,
        [request.params.id, [...MANAGED_ADAPTERS]]
      );
      if (!source.rowCount) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'source_not_found' });
      }
      const row = source.rows[0]!;
      adapterType = row.adapter_type;
      if (row.enabled !== parsed.data.expectedEnabled) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'source_state_changed', enabled: row.enabled });
      }
      if (row.enabled === parsed.data.enabled) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'source_state_unchanged', enabled: row.enabled });
      }

      const held = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM alert_source_states
          WHERE source_id=$1 AND (active OR COALESCE(
            missing_since > now()-($2::int * interval '1 second'),false))`,
        [row.id, config.ALERT_END_DEBOUNCE_SECONDS]
      );
      const holdingCount = held.rows[0]?.count ?? 0;
      if (row.official && (parsed.data.confirmation !== row.id
        || !parsed.data.acknowledgeOfficialAuthority)) {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          error: 'official_confirmation_required', confirmation: row.id
        });
      }
      if (!parsed.data.enabled && holdingCount > 0 && !parsed.data.acknowledgeHeldAlerts) {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          error: 'held_alerts_acknowledgement_required', holdingCount
        });
      }
      if (!parsed.data.enabled && row.official && ALERT_ADAPTERS.has(row.adapter_type)) {
        const remaining = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM sources
            WHERE id<>$1 AND official=true AND enabled=true
              AND adapter_type=ANY($2::text[])`,
          [row.id, [...ALERT_ADAPTERS]]
        );
        if ((remaining.rows[0]?.count ?? 0) === 0) {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error: 'last_official_alert_source' });
        }
      }

      await client.query(
        `UPDATE sources SET enabled=$2,health_status=CASE WHEN $2 THEN 'unknown' ELSE 'disabled' END
          WHERE id=$1`,
        [row.id, parsed.data.enabled]
      );
      await client.query(
        `INSERT INTO source_enabled_audit(
           source_id,previous_enabled,enabled,reason,changed_by,
           official_authority_acknowledged,held_alerts_acknowledged,held_alerts_at_change
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [row.id, row.enabled, parsed.data.enabled, parsed.data.reason, config.OPS_USER,
          parsed.data.acknowledgeOfficialAuthority, parsed.data.acknowledgeHeldAlerts, holdingCount]
      );
      await client.query(
        `INSERT INTO system_event_log(event_type,payload) VALUES ('source.configuration_changed',$1)`,
        [JSON.stringify({
          sourceId: row.id, enabled: parsed.data.enabled, previousEnabled: row.enabled,
          holdingCount, changedBy: config.OPS_USER
        })]
      );
      await client.query('COMMIT');

      const collectorReloadRequested = TELEGRAM_ADAPTERS.has(adapterType)
        ? requestTelegramCollectorReload() : false;
      return {
        sourceId: row.id,
        enabled: parsed.data.enabled,
        holdingCount,
        holdsPreserved: holdingCount > 0,
        collectorReloadRequested
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });
};

export default opsSourcesRoutes;
export { opsSourcesRoutes, MANAGED_ADAPTERS, SOURCE_LEDGER_SQL };
