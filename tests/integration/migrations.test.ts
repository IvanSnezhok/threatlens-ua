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
  '027_aerial_alert_mirror.sql',
  '028_analytics_min_pass_interval.sql',
  '029_disabled_channel_reaudit.sql',
  '030_app_settings.sql',
  '031_homonym_settlement_gaps.sql',
  '032_silent_drop_and_audited_homonyms.sql',
  '033_tactics_and_research_switches.sql',
  '034_attack_tactics.sql',
  '035_attack_research.sql',
  '036_resource_efficiency.sql',
  '037_ops_source_management.sql',
  '038_telegram_delivery_governor.sql',
  '039_contextual_multimodal_shadow.sql',
  '040_model_analytical_threats.sql',
  '041_threat_event_origin.sql',
  '042_analytical_withdrawal.sql',
  '043_analytical_outcomes.sql',
  '044_publication_channels.sql',
  '045_model_enrichment.sql',
  '046_origin_zone.sql'
];

/**
 * Every settlement a migration inserts by hand, and the oblast its KATOTTG code says it is in.
 *
 * This is the audit the 2026-08-10 incident asked for. A UAV corridor across Dnipropetrovsk oblast
 * was rendered on Обухівський район, Київська область, and the first suspicion was that one of
 * migration 024's eighteen rows carried a parent in the wrong oblast — a defect no unit test could
 * see, because the parent is chosen by a subquery against rows the KATOTTG sync creates. It did not:
 * all eighteen were correct, and the cause was a missing homonym instead (see migration 031). The
 * table stays because the *class* of defect is real and silent: a settlement pointed at the wrong
 * raion looks perfectly healthy in `locations` and only shows up as a polygon 400 km away.
 *
 * The expected value is the oblast, not the raion, because both are correct answers depending on
 * the database: migrations 024, 031 and 032 attach a settlement to its raion when the sync has already
 * created that row and to its oblast when it has not, which is the case in a freshly migrated test
 * database. Walking up to the oblast is the assertion that holds either way — and it is exactly the
 * walk `listLocationLexemes` and the territory climb make.
 */
const SEEDED_SETTLEMENT_OBLASTS: ReadonlyArray<readonly [string, string, string]> = [
  // migration 024
  ['UA32060110010087428', 'Згурівка', 'ua-32'],
  ['UA32060070010067563', 'Велика Димерка', 'ua-32'],
  ['UA32060090010046220', 'Зазим’я', 'ua-32'],
  ['UA32060090040088774', 'Погреби', 'ua-32'],
  ['UA32080010010043861', 'Білогородка', 'ua-32'],
  ['UA32080030010080493', 'Бородянка', 'ua-32'],
  ['UA32080090020082865', 'Крюківщина', 'ua-32'],
  ['UA32140070010070369', 'Глеваха', 'ua-32'],
  ['UA32140170010072394', 'Чабани', 'ua-32'],
  ['UA74100190010032782', 'Козелець', 'ua-74'],
  ['UA74080150020098715', 'Дігтярі', 'ua-74'],
  ['UA74080090010045475', 'Мала Дівиця', 'ua-74'],
  ['UA12020170010095010', 'Обухівка', 'ua-12'],
  ['UA12040150020083955', 'Карнаухівка', 'ua-12'],
  ['UA59080310010046655', 'Юнаківка', 'ua-59'],
  ['UA59080290010046940', 'Хотінь', 'ua-59'],
  ['UA18040350030097353', 'Озерне', 'ua-18'],
  ['UA51040190010067512', 'Сарата', 'ua-51'],
  // migration 031
  ['UA12120010020096111', 'Богуслав', 'ua-12'],
  ['UA63020050010064235', 'Золочів', 'ua-63'],
  ['UA59080130010087968', 'Миколаївка', 'ua-59'],
  ['UA59060070010030190', 'Липова Долина', 'ua-59'],
  // migration 032 — two of these are guards rather than referents (the Kherson Степанівка and one of
  // the two Kyiv Калинівка can never be the answer on their own), and they are audited exactly like
  // the rest: a guard pointed at the wrong oblast would break the tie-break it exists to arm.
  ['UA12040010010084655', 'Божедарівка', 'ua-12'],
  ['UA59080250010051865', 'Степанівка', 'ua-59'],
  ['UA65100150090070661', 'Степанівка', 'ua-65'],
  ['UA32060130010033581', 'Калинівка', 'ua-32'],
  ['UA32140090010093169', 'Калинівка', 'ua-32']
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

  it('puts every hand-seeded settlement in the oblast its KATOTTG code names', async () => {
    const rows = await sql<{ official_code: string; name_uk: string; oblast_id: string | null }>(
      `WITH RECURSIVE ancestry(id, ancestor_id, ancestor_type) AS (
         SELECT id, id, type FROM locations
         UNION ALL
         SELECT ancestry.id, parent.id, parent.type
           FROM ancestry JOIN locations child ON child.id = ancestry.ancestor_id
                         JOIN locations parent ON parent.id = child.parent_id
       )
       SELECT l.official_code, l.name_uk,
              (SELECT ancestor_id FROM ancestry
                WHERE ancestry.id = l.id AND ancestor_type IN ('oblast','special_city') LIMIT 1) AS oblast_id
         FROM locations l WHERE l.official_code = ANY($1::text[])`,
      [SEEDED_SETTLEMENT_OBLASTS.map(([code]) => code)]
    );
    const byCode = new Map(rows.rows.map((row) => [row.official_code, row]));
    // Present at all: a row silently absent would make its messages resolve to nothing, which is the
    // gap migrations 024 and 031 exist to close.
    expect([...byCode.keys()].sort()).toEqual(SEEDED_SETTLEMENT_OBLASTS.map(([code]) => code).sort());
    expect(SEEDED_SETTLEMENT_OBLASTS.map(([code]) => `${code} ${byCode.get(code)?.oblast_id}`))
      .toEqual(SEEDED_SETTLEMENT_OBLASTS.map(([code, , oblast]) => `${code} ${oblast}`));
    // The name is asserted alongside so a code typed one digit wrong cannot pass by landing on some
    // other settlement that happens to sit in the same oblast.
    expect(SEEDED_SETTLEMENT_OBLASTS.map(([code]) => byCode.get(code)?.name_uk))
      .toEqual(SEEDED_SETTLEMENT_OBLASTS.map(([, name]) => name));
  });

  it('gives the codex switch row every switch, all of them off', async () => {
    // The singleton is seeded by migration 018 and every later migration widens it with ADD COLUMN.
    // A column added without a DEFAULT — or with a default of true — would reach an existing
    // installation as either a NULL an operator cannot read as "off" or a model that switched itself
    // on during an upgrade. `tactics_enabled` (033) is the one that would be visible to the public
    // if that happened, so the assertion is about the values, not merely about the columns existing.
    const row = await sql<Record<string, boolean>>(
      `SELECT narrative_enabled,digest_enabled,attacks_enabled,shadow_enabled,
              analytical_threats_enabled,analytical_enrichment_enabled,retrospective_gate_enabled,
              tactics_enabled,attack_research_enabled
         FROM codex_settings WHERE singleton`
    );
    expect(row.rowCount).toBe(1);
    expect(Object.values(row.rows[0]!))
      .toEqual([false, false, false, false, false, false, false, false, false]);
  });

  it('keeps contextual/media evidence and analytical event provenance on the shadow table', async () => {
    const columns = await sql<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='shadow_classifications'
          AND column_name = ANY($1::text[]) ORDER BY column_name`,
      [['analytical_event_id', 'context_message_ids', 'media_kinds', 'model_analysis']]
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'analytical_event_id', 'context_message_ids', 'media_kinds', 'model_analysis'
    ]);
  });

  it('registers the occupation snapshot table with its revision uniqueness guarantee', async () => {
    const table = await sql("SELECT 1 FROM information_schema.tables WHERE table_name='occupation_snapshots'");
    expect(table.rowCount).toBe(1);
    const index = await sql("SELECT 1 FROM pg_indexes WHERE indexname='occupation_snapshots_revision_uidx'");
    expect(index.rowCount).toBe(1);
  });
});
