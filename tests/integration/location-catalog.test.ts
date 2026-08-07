import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';
import type { CatalogImportSummary, KatottgEntry } from '../../src/services/location-catalog.js';

/**
 * The raion tier against live PostgreSQL.
 *
 * The classifier is never downloaded here — the entries below are the shape `parseKatottgWorkbook`
 * produces, so the test exercises the writer and the resulting hierarchy without touching the
 * network. The oblast row is deliberately the *seeded* Запорізька область: the importer has to find
 * it by name, hang the raion off it, and pull the city out from under it.
 */

const OBLAST_CODE = 'UA23000000000064947';
const RAION_CODE = 'UA23080000000090746';
const HROMADA_CODE = 'UA23080070000048181';
const CITY_CODE = 'UA23080070010092407';
const RAION_ID = `katottg-${RAION_CODE.toLocaleLowerCase()}`;
const SEEDED_CITY = 'test-city-melitopol';

const ENTRIES: KatottgEntry[] = [
  {
    code: OBLAST_CODE, regionCode: OBLAST_CODE, raionCode: null, hromadaCode: null,
    category: 'O', name: 'Запорізька'
  },
  {
    code: RAION_CODE, regionCode: OBLAST_CODE, raionCode: RAION_CODE, hromadaCode: null,
    category: 'P', name: 'Мелітопольський'
  },
  {
    code: HROMADA_CODE, regionCode: OBLAST_CODE, raionCode: RAION_CODE, hromadaCode: HROMADA_CODE,
    category: 'H', name: 'Веселівська'
  },
  {
    code: CITY_CODE, regionCode: OBLAST_CODE, raionCode: RAION_CODE, hromadaCode: HROMADA_CODE,
    category: 'M', name: 'Мелітополь'
  }
];

async function importOnce(): Promise<CatalogImportSummary> {
  const { importKatottgEntries } = await import('../../src/services/location-catalog.js');
  return importKatottgEntries(ENTRIES, 'integration-checksum');
}

async function cleanup(): Promise<void> {
  await sql(`DELETE FROM locations WHERE id LIKE 'test-%'`);
  await sql(`DELETE FROM locations WHERE id LIKE 'katottg-%'`);
  await sql(`UPDATE locations SET official_code=NULL WHERE id='ua-23'`);
}

describe.skipIf(!integrationDatabaseAvailable)('KATOTTG raion import against live PostgreSQL', () => {
  let first: CatalogImportSummary;
  let second: CatalogImportSummary;

  beforeAll(async () => {
    await ensureMigrated();
    await resetDatabase();
    await cleanup();
    await sql(
      `INSERT INTO locations(id,parent_id,type,name_uk,aliases)
       VALUES ($1,'ua-23','city','Мелітополь',ARRAY['мелітополь'])`, [SEEDED_CITY]
    );
    first = await importOnce();
    second = await importOnce();
  });

  afterAll(cleanup);

  it('inserts the raion between the oblast and the city', async () => {
    const raion = await sql<{ parent_id: string; type: string; name_uk: string; official_code: string }>(
      'SELECT parent_id,type,name_uk,official_code FROM locations WHERE id=$1', [RAION_ID]
    );
    expect(raion.rows[0]).toMatchObject({
      parent_id: 'ua-23', type: 'raion', name_uk: 'Мелітопольський район', official_code: RAION_CODE
    });
  });

  it('carries the raion and hromada spellings the alert channel uses', async () => {
    const aliases = await sql<{ aliases: string[] }>('SELECT aliases FROM locations WHERE id=$1', [RAION_ID]);
    expect(aliases.rows[0]!.aliases).toEqual(expect.arrayContaining([
      'мелітопольський район', 'мелітопольського району', 'веселівська територіальна громада'
    ]));
  });

  it('re-points an oblast-parented city at its raion and stamps the official code', async () => {
    const city = await sql<{ parent_id: string; official_code: string }>(
      'SELECT parent_id,official_code FROM locations WHERE id=$1', [SEEDED_CITY]
    );
    expect(city.rows[0]).toEqual({ parent_id: RAION_ID, official_code: CITY_CODE });
    expect(first.reparentedCities).toBe(1);
    // The row was reused rather than duplicated under a katottg- id.
    expect(await count('locations', `name_uk='Мелітополь'`)).toBe(1);
  });

  it('resolves a three-level chain from city to oblast', async () => {
    const chain = await sql<{ city: string; raion: string; oblast: string }>(
      `SELECT c.name_uk AS city, r.name_uk AS raion, o.name_uk AS oblast
         FROM locations c JOIN locations r ON r.id=c.parent_id JOIN locations o ON o.id=r.parent_id
        WHERE c.id=$1`, [SEEDED_CITY]
    );
    expect(chain.rows[0]).toEqual({
      city: 'Мелітополь', raion: 'Мелітопольський район', oblast: 'Запорізька область'
    });
  });

  it('is idempotent: the second import writes the same rows and moves nothing', async () => {
    expect(first).toEqual({ raions: 1, cities: 1, reparentedCities: 1 });
    expect(second).toEqual({ raions: 1, cities: 1, reparentedCities: 0 });
    expect(await count('locations', `type='raion'`)).toBe(1);
    const sync = await sql<{ imported_rows: number; status: string }>(
      `SELECT imported_rows,status FROM reference_dataset_syncs WHERE dataset_id='katottg'`
    );
    expect(sync.rows[0]).toEqual({ imported_rows: 2, status: 'success' });
  });
});
