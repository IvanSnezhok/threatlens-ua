import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

const OPS = `Basic ${Buffer.from('operator:change-me').toString('base64')}`;
const MONITOR = 'osint-eradar';
const ALERT_CHANNEL = 'air-alert-ua';
const MIRROR = 'aerial-alerts-mirror';
const TOUCHED = [MONITOR, ALERT_CHANNEL, MIRROR, 'ukraine-alarm', 'alerts-in-ua'];
let originalEnabled = new Map<string, boolean>();

async function buildApp(): Promise<FastifyInstance> {
  const Fastify = (await import('fastify')).default;
  const routes = (await import('../../src/api/ops-sources-routes.js')).default;
  const app = Fastify({ logger: false });
  await app.register(routes);
  await app.ready();
  return app;
}

async function get(app: FastifyInstance) {
  return app.inject({ method: 'GET', url: '/ops/api/sources', headers: { authorization: OPS } });
}

async function put(app: FastifyInstance, sourceId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'PUT', url: `/ops/api/sources/${sourceId}`, headers: { authorization: OPS }, payload
  });
}

async function restoreFlags(): Promise<void> {
  for (const [id, enabled] of originalEnabled) {
    await sql(`UPDATE sources SET enabled=$2 WHERE id=$1`, [id, enabled]);
  }
}

describe.skipIf(!integrationDatabaseAvailable)('Ops source management', () => {
  beforeAll(async () => {
    await ensureMigrated();
    const rows = await sql<{ id: string; enabled: boolean }>(
      `SELECT id,enabled FROM sources WHERE id=ANY($1::text[])`, [TOUCHED]
    );
    originalEnabled = new Map(rows.rows.map((row) => [row.id, row.enabled]));
  });
  beforeEach(async () => {
    await resetDatabase();
    await restoreFlags();
  });
  afterAll(async () => { await restoreFlags(); });

  it('is private and reports freshness, holding alerts and both kinds of catalogue gap', async () => {
    await sql(`UPDATE sources SET enabled=true,health_status='error',last_error='fixture failure',
               last_error_at=now(),last_success_at=now()-interval '10 minutes' WHERE id=$1`, [MONITOR]);
    await sql(
      `INSERT INTO alert_source_states(source_id,location_id,alert_type,active,provider_started_at)
       VALUES ($1,'ua-32','air_raid',true,now()-interval '1 hour')`,
      [ALERT_CHANNEL]
    );
    const messageId = (await sql<{ id: string }>(
      `INSERT INTO source_messages(source_id,external_id,published_at,raw_text,content_hash,processing_status)
       VALUES ($1,'ops-gap',now(),'БпЛА курсом на невідоме місце','ops-gap','ignored') RETURNING id`,
      [MONITOR]
    )).rows[0]!.id;
    await sql(
      `INSERT INTO message_classifications(source_message_id,source_id,classifier_version,published_at,
         decision,intent,ignored_reason,threat_type,candidate_threat_types)
       VALUES ($1,$2,'test','now','ignored','threat','no_location','uav',ARRAY['uav'])`,
      [messageId, MONITOR]
    );

    const app = await buildApp();
    try {
      expect((await app.inject({ method: 'GET', url: '/ops/api/sources' })).statusCode).toBe(401);
      const response = await get(app);
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.notice).toContain('не стирає стан тривоги');
      expect(body.sources.length).toBeGreaterThan(50);
      expect(body.sources.find((source: any) => source.id === MONITOR)).toMatchObject({
        // No MTProto credentials in the integration process: configuration truth outranks the
        // stored health word, while the failure remains visible in its own field.
        status: 'unconfigured', lastError: 'fixture failure',
        catalogueGaps: { ignoredMessages24h: 1 }
      });
      const holder = body.sources.find((source: any) => source.id === ALERT_CHANNEL);
      expect(holder.holdingCount).toBe(1);
      expect(holder.holding[0]).toMatchObject({ locationId: 'ua-32', alertType: 'air_raid' });
      expect(body.totals.holding).toBeGreaterThanOrEqual(1);
      expect(body.totals.withGaps).toBeGreaterThanOrEqual(1);
    } finally {
      await app.close();
    }
  });

  it('requires a reason and optimistic state match for an ordinary Telegram source', async () => {
    await sql(`UPDATE sources SET enabled=true WHERE id=$1`, [MONITOR]);
    const app = await buildApp();
    try {
      expect((await put(app, MONITOR, {
        enabled: false, expectedEnabled: true, reason: 'short'
      })).statusCode).toBe(400);
      const stale = await put(app, MONITOR, {
        enabled: false, expectedEnabled: false, reason: 'Перевірено недоступний канал'
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error).toBe('source_state_changed');

      const changed = await put(app, MONITOR, {
        enabled: false, expectedEnabled: true, reason: 'Перевірено недоступний канал'
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toMatchObject({ enabled: false, holdingCount: 0, holdsPreserved: false });
      const stored = await sql<{ enabled: boolean; health_status: string }>(
        `SELECT enabled,health_status FROM sources WHERE id=$1`, [MONITOR]
      );
      expect(stored.rows[0]).toEqual({ enabled: false, health_status: 'disabled' });
      const audit = await sql<{ reason: string; previous_enabled: boolean; enabled: boolean }>(
        `SELECT reason,previous_enabled,enabled FROM source_enabled_audit WHERE source_id=$1`, [MONITOR]
      );
      expect(audit.rows).toEqual([{
        reason: 'Перевірено недоступний канал', previous_enabled: true, enabled: false
      }]);
    } finally {
      await app.close();
    }
  });

  it('requires official and hold acknowledgements and never clears held alert state', async () => {
    await sql(`UPDATE sources SET enabled=true WHERE id=ANY($1::text[])`, [[ALERT_CHANNEL, MIRROR]]);
    await sql(
      `INSERT INTO alert_source_states(source_id,location_id,alert_type,active,provider_started_at)
       VALUES ($1,'ua-32','air_raid',true,now()-interval '1 hour')`,
      [ALERT_CHANNEL]
    );
    const app = await buildApp();
    const base = { enabled: false, expectedEnabled: true, reason: 'Формат каналу більше не читається' };
    try {
      const noOfficial = await put(app, ALERT_CHANNEL, base);
      expect(noOfficial.json().error).toBe('official_confirmation_required');

      const noHold = await put(app, ALERT_CHANNEL, {
        ...base, confirmation: ALERT_CHANNEL, acknowledgeOfficialAuthority: true
      });
      expect(noHold.json()).toMatchObject({
        error: 'held_alerts_acknowledgement_required', holdingCount: 1
      });

      const changed = await put(app, ALERT_CHANNEL, {
        ...base, confirmation: ALERT_CHANNEL, acknowledgeOfficialAuthority: true,
        acknowledgeHeldAlerts: true
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toMatchObject({ enabled: false, holdingCount: 1, holdsPreserved: true });
      const held = await sql<{ active: boolean }>(
        `SELECT active FROM alert_source_states WHERE source_id=$1 AND location_id='ua-32'`,
        [ALERT_CHANNEL]
      );
      expect(held.rows[0]!.active).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('does not allow Ops to disable the last enabled official alert source', async () => {
    await sql(
      `UPDATE sources SET enabled=(id=$1)
        WHERE official=true AND adapter_type=ANY($2::text[])`,
      [MIRROR, ['ukraine_alarm', 'alerts_in_ua', 'aerial_alerts_mirror', 'mtproto_alert_channel']]
    );
    const app = await buildApp();
    try {
      const response = await put(app, MIRROR, {
        enabled: false, expectedEnabled: true, reason: 'Тривала відмова провайдера',
        confirmation: MIRROR, acknowledgeOfficialAuthority: true
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('last_official_alert_source');
      const source = await sql<{ enabled: boolean }>(`SELECT enabled FROM sources WHERE id=$1`, [MIRROR]);
      expect(source.rows[0]!.enabled).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('serializes two official switches so concurrent requests cannot disable the final pair', async () => {
    await sql(
      `UPDATE sources SET enabled=(id=ANY($1::text[]))
        WHERE official=true AND adapter_type=ANY($2::text[])`,
      [[MIRROR, ALERT_CHANNEL], ['ukraine_alarm', 'alerts_in_ua', 'aerial_alerts_mirror', 'mtproto_alert_channel']]
    );
    const app = await buildApp();
    try {
      const change = (id: string) => put(app, id, {
        enabled: false, expectedEnabled: true, reason: 'Паралельна перевірка захисного блокування',
        confirmation: id, acknowledgeOfficialAuthority: true
      });
      const responses = await Promise.all([change(MIRROR), change(ALERT_CHANNEL)]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      expect(responses.find((response) => response.statusCode === 409)?.json().error)
        .toBe('last_official_alert_source');
      const enabled = await sql<{ count: number }>(
        `SELECT count(*)::int AS count FROM sources WHERE official=true AND enabled=true
          AND adapter_type=ANY($1::text[])`,
        [['ukraine_alarm', 'alerts_in_ua', 'aerial_alerts_mirror', 'mtproto_alert_channel']]
      );
      expect(enabled.rows[0]!.count).toBe(1);
    } finally {
      await app.close();
    }
  });
});
