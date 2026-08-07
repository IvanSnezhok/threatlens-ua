import { beforeAll, describe, expect, it } from 'vitest';
import { ensureMigrated, integrationDatabaseAvailable, sql } from '../helpers/db.js';

const MIGRATION_FILES = [
  '001_init.sql',
  '002_operational_completion.sql',
  '003_runtime_hardening.sql',
  '004_location_catalog.sql',
  '005_territory_channels.sql',
  '006_outbox_reclaim.sql',
  '007_occupation_layer.sql',
  '008_alert_end_debounce.sql',
  '009_raion_tier.sql',
  '010_alert_channel_source.sql',
  '011_osint_monitor_sources.sql',
  '012_threat_assertions_and_classification_log.sql',
  '013_source_catalog_expansion.sql',
  '014_multi_channel_alert_routing.sql',
  '015_analytics.sql'
];

describe.skipIf(!integrationDatabaseAvailable)('migration runner against live PostgreSQL', () => {
  beforeAll(async () => {
    // Start from an empty schema so the double run below is a genuine cold-start test rather than a
    // no-op against an already-migrated database. Files in this project run serially, and every
    // other integration file calls ensureMigrated() itself, so this is safe.
    await sql('DROP SCHEMA IF EXISTS public CASCADE');
    await sql('CREATE SCHEMA public');
    await ensureMigrated();
  });

  it('applies every migration exactly once', async () => {
    const applied = await sql<{ filename: string }>('SELECT filename FROM schema_migrations ORDER BY filename');
    expect(applied.rows.map((row) => row.filename)).toEqual(MIGRATION_FILES);
  });

  it('is idempotent: a second full run is a no-op and does not throw', async () => {
    const before = await sql<{ applied_at: string }>(
      'SELECT applied_at::text FROM schema_migrations ORDER BY filename'
    );
    const { migrate } = await import('../../src/db/migrate.js');
    await expect(migrate()).resolves.toBeUndefined();
    await expect(migrate()).resolves.toBeUndefined();
    const after = await sql<{ applied_at: string }>(
      'SELECT applied_at::text FROM schema_migrations ORDER BY filename'
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('creates the readiness marker the /health/ready probe queries', async () => {
    // src/api/server.ts gates readiness on this exact filename; a renamed migration must break here.
    const marker = await sql("SELECT 1 FROM schema_migrations WHERE filename='013_source_catalog_expansion.sql'");
    expect(marker.rowCount).toBe(1);
  });

  it('seeds the reference catalogue the ingestion and fanout paths depend on', async () => {
    const locations = await sql<{ n: string }>(
      "SELECT count(*)::text AS n FROM locations WHERE type IN ('oblast','special_city')"
    );
    expect(Number(locations.rows[0]!.n)).toBeGreaterThanOrEqual(27);
    const hierarchy = await sql<{ parent_id: string }>(
      "SELECT parent_id FROM locations WHERE id='ua-city-bila-tserkva'"
    );
    expect(hierarchy.rows[0]!.parent_id).toBe('ua-32');
    const sources = await sql<{ id: string }>(
      "SELECT id FROM sources WHERE id IN ('ukraine-alarm','alerts-in-ua') ORDER BY id"
    );
    expect(sources.rows.map((row) => row.id)).toEqual(['alerts-in-ua', 'ukraine-alarm']);
  });

  it('registers the occupation snapshot table with its revision uniqueness guarantee', async () => {
    const table = await sql("SELECT 1 FROM information_schema.tables WHERE table_name='occupation_snapshots'");
    expect(table.rowCount).toBe(1);
    const index = await sql("SELECT 1 FROM pg_indexes WHERE indexname='occupation_snapshots_revision_uidx'");
    expect(index.rowCount).toBe(1);
  });
});
