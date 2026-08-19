import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';
import type { CatalogImportSummary, KatottgEntry } from '../../src/services/location-catalog.js';

/**
 * The raion and hromada tiers against live PostgreSQL.
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
const HROMADA_ID = `katottg-${HROMADA_CODE.toLocaleLowerCase()}`;
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
  // Тільки рядки, які створив імпорт ЦЬОГО тесту. Голе `LIKE 'katottg-%'` зносило й рядки,
  // посіяні міграціями 024/026/027, — а ensureMigrated() на повторно використаній базі бачить
  // міграції застосованими і не відновлює їх, тож наступний прогін падав у чужому файлі.
  await sql(
    `DELETE FROM locations WHERE id = ANY($1::text[])`,
    [[RAION_CODE, HROMADA_CODE, CITY_CODE].map((code) => `katottg-${code.toLocaleLowerCase()}`)]
  );
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

  it('carries the raion spellings the alert channel uses, and no hromada of its own', async () => {
    const aliases = await sql<{ aliases: string[] }>('SELECT aliases FROM locations WHERE id=$1', [RAION_ID]);
    expect(aliases.rows[0]!.aliases).toEqual(expect.arrayContaining([
      'мелітопольський район', 'мелітопольського району'
    ]));
    // Міграція 051: назва громади належить рядкові громади. Аліас, залишений тут, змагався б із
    // ним за той самий текст — і забирав би його, бо район у каталозі стоїть вище.
    expect(aliases.rows[0]!.aliases).not.toContain('веселівська територіальна громада');
  });

  it('inserts the hromada between the raion and the city, under both spellings', async () => {
    const hromada = await sql<{ parent_id: string; type: string; name_uk: string; aliases: string[] }>(
      'SELECT parent_id,type,name_uk,aliases FROM locations WHERE id=$1', [HROMADA_ID]
    );
    expect(hromada.rows[0]).toMatchObject({
      parent_id: RAION_ID, type: 'hromada', name_uk: 'Веселівська територіальна громада'
    });
    expect(hromada.rows[0]!.aliases).toEqual([
      'веселівська територіальна громада', 'веселівська громада'
    ]);
  });

  it('re-points an oblast-parented city at its hromada and stamps the official code', async () => {
    const city = await sql<{ parent_id: string; official_code: string }>(
      'SELECT parent_id,official_code FROM locations WHERE id=$1', [SEEDED_CITY]
    );
    // Не район: розсилка тривоги обходить предків СТВЕРДЖЕНОЇ локації, тож місто під районом
    // не почуло б тривоги громади, у якій воно стоїть.
    expect(city.rows[0]).toEqual({ parent_id: HROMADA_ID, official_code: CITY_CODE });
    expect(first.reparentedCities).toBe(1);
    // The row was reused rather than duplicated under a katottg- id.
    expect(await count('locations', `name_uk='Мелітополь'`)).toBe(1);
  });

  it('resolves a four-level chain from city to oblast', async () => {
    const chain = await sql<{ city: string; hromada: string; raion: string; oblast: string }>(
      `SELECT c.name_uk AS city, h.name_uk AS hromada, r.name_uk AS raion, o.name_uk AS oblast
         FROM locations c JOIN locations h ON h.id=c.parent_id
                          JOIN locations r ON r.id=h.parent_id
                          JOIN locations o ON o.id=r.parent_id
        WHERE c.id=$1`, [SEEDED_CITY]
    );
    expect(chain.rows[0]).toEqual({
      city: 'Мелітополь', hromada: 'Веселівська територіальна громада',
      raion: 'Мелітопольський район', oblast: 'Запорізька область'
    });
  });

  it('is idempotent: the second import writes the same rows and moves nothing', async () => {
    expect(first).toEqual({ raions: 1, hromadas: 1, cities: 1, reparentedCities: 1 });
    expect(second).toEqual({ raions: 1, hromadas: 1, cities: 1, reparentedCities: 0 });
    // Лише рядок, який створив цей імпорт: у каталозі є й міграційно посіяні райони (026),
    // і рахувати їх тут означало б знову вимагати їх знесення перед прогоном.
    expect(await count('locations', `type='raion' AND id='${RAION_ID}'`)).toBe(1);
    const sync = await sql<{ imported_rows: number; status: string }>(
      `SELECT imported_rows,status FROM reference_dataset_syncs WHERE dataset_id='katottg'`
    );
    expect(sync.rows[0]).toEqual({ imported_rows: 3, status: 'success' });
  });
});
