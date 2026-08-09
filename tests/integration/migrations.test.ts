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
  '015_analytics.sql',
  '016_threat_vectors.sql',
  '017_codex_oauth.sql',
  '018_codex_settings.sql',
  '019_notification_state.sql',
  '020_shadow_classifications.sql',
  '021_source_trust.sql',
  '022_publication_runtime.sql',
  '023_deployment_and_backfill.sql',
  '024_settlement_catalogue_gaps.sql',
  '025_retrospective_gate.sql',
  '026_renamed_toponym_aliases.sql',
  '027_aerial_alert_mirror.sql'
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

  it('leaves every migration shipped in the image applied, which is what /health/ready now asks', async () => {
    // This replaces a test that named ONE filename. `/health/ready` used to gate on that hard-coded
    // string, so readiness answered 200 with a newer migration unapplied — and the deployment runner
    // in `src/deployer/runner.ts` treats a 200 from `/health/ready` as proof that the update landed.
    // A readiness gate that cannot see a pending migration would let a half-migrated deployment be
    // recorded as a success, so the probe now compares the *set* of `*.sql` files shipped in the
    // image against `schema_migrations`, and so does this test.
    const { readdir } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const shipped = (await readdir(resolve(process.cwd(), 'migrations')))
      .filter((file) => file.endsWith('.sql')).sort();
    // The literal list at the top of this file is the human-readable half: a migration added without
    // touching it fails here rather than silently widening the set the next assertion checks.
    expect(shipped).toEqual(MIGRATION_FILES);

    const applied = await sql<{ filename: string }>('SELECT filename FROM schema_migrations');
    const appliedSet = new Set(applied.rows.map((row) => row.filename));
    const missing = shipped.filter((file) => !appliedSet.has(file));
    expect(missing, 'shipped migrations that /health/ready would report as pending').toEqual([]);
    // Newest on disk specifically: `ensureMigrated()` probes exactly this file to decide whether a
    // reused database is current, and the readiness gate fails the moment it is absent.
    expect(appliedSet.has(shipped.at(-1)!)).toBe(true);
  });

  it('registers the deployment journal, its single-active lock and the backfill cursor index', async () => {
    // Migration 023 carries two independent sections and a half-applied pair would leave /ops
    // rendering a card whose table does not exist.
    const tables = await sql<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public'
          AND table_name IN ('deployment_runs','deployment_run_events','deployment_state','source_backfill_state')
        ORDER BY table_name`
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'deployment_run_events', 'deployment_runs', 'deployment_state', 'source_backfill_state'
    ]);
    const indexes = await sql<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE indexname IN ('deployment_runs_single_active_uidx','source_messages_source_published_idx')
        ORDER BY indexname`
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      'deployment_runs_single_active_uidx', 'source_messages_source_published_idx'
    ]);
    // Singleton, seeded by the migration: reading it must never be "no row, therefore unknown".
    const state = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM deployment_state`);
    expect(Number(state.rows[0]!.n)).toBe(1);
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
