import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { parseKatottgWorkbook, planCatalogImport, raionAliases } from './location-catalog.js';

const DNIPRO_OBLAST = 'UA12000000000090473';
const DNIPRO_RAION = 'UA12020000000059864';
const DNIPRO_HROMADA = 'UA12020010000063889';
const DNIPRO_CITY = 'UA12020010010066750';
const ZAPORIZHZHIA_OBLAST = 'UA23000000000064947';
const MELITOPOL_RAION = 'UA23080000000090746';
const MELITOPOL_HROMADA = 'UA23080070000048181';
const MELITOPOL_CITY = 'UA23080070010092407';
const VESELE_HROMADA = 'UA23080030000079111';

/** `[A, B, C, D, E, category, name]` — the seven columns the classifier sheet uses. */
type SheetRow = [string, string, string, string, string, string, string];

/**
 * Builds a workbook shaped like the published classifier: every level column is present on every
 * data row, and the levels below the row's own are written as self-closing (empty) cells.
 */
function workbook(rows: SheetRow[]): Uint8Array {
  const strings: string[] = [];
  const intern = (value: string): number => {
    const existing = strings.indexOf(value);
    return existing >= 0 ? existing : strings.push(value) - 1;
  };
  const columns = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const body = rows.map((row, offset) => {
    const line = offset + 5;
    const cells = row.map((value, column) => (value
      ? `<c r="${columns[column]}${line}" t="s"><v>${intern(value)}</v></c>`
      : `<c r="${columns[column]}${line}"/>`)).join('');
    return `<row r="${line}">${cells}</row>`;
  }).join('');
  const sheet = `<?xml version="1.0"?><worksheet><sheetData>${body}</sheetData></worksheet>`;
  const shared = `<?xml version="1.0"?><sst>${strings.map((value) => `<si><t>${value}</t></si>`).join('')}</sst>`;
  return zipSync({ 'xl/sharedStrings.xml': strToU8(shared), 'xl/worksheets/sheet1.xml': strToU8(sheet) });
}

const FIXTURE: SheetRow[] = [
  [DNIPRO_OBLAST, '', '', '', '', 'O', 'Дніпропетровська'],
  [DNIPRO_OBLAST, DNIPRO_RAION, '', '', '', 'P', 'Дніпровський'],
  [DNIPRO_OBLAST, DNIPRO_RAION, DNIPRO_HROMADA, '', '', 'H', 'Дніпровська'],
  [DNIPRO_OBLAST, DNIPRO_RAION, DNIPRO_HROMADA, DNIPRO_CITY, '', 'M', 'Дніпро'],
  [ZAPORIZHZHIA_OBLAST, '', '', '', '', 'O', 'Запорізька'],
  [ZAPORIZHZHIA_OBLAST, MELITOPOL_RAION, '', '', '', 'P', 'Мелітопольський'],
  [ZAPORIZHZHIA_OBLAST, MELITOPOL_RAION, MELITOPOL_HROMADA, '', '', 'H', 'Мелітопольська'],
  [ZAPORIZHZHIA_OBLAST, MELITOPOL_RAION, MELITOPOL_HROMADA, MELITOPOL_CITY, '', 'M', 'Мелітополь'],
  [ZAPORIZHZHIA_OBLAST, MELITOPOL_RAION, VESELE_HROMADA, '', '', 'H', 'Веселівська']
];

const parsed = parseKatottgWorkbook(workbook(FIXTURE), FIXTURE.length);
const entry = (code: string) => parsed.find((candidate) => candidate.code === code);

describe('KATOTTG XLSX parser', () => {
  it('parses shared strings and ignores self-closing cells without swallowing later values', () => {
    expect(parsed).toHaveLength(FIXTURE.length);
    expect(entry(DNIPRO_OBLAST)).toEqual({
      code: DNIPRO_OBLAST, regionCode: DNIPRO_OBLAST, raionCode: null, hromadaCode: null,
      category: 'O', name: 'Дніпропетровська'
    });
    expect(entry(DNIPRO_CITY)).toEqual({
      code: DNIPRO_CITY, regionCode: DNIPRO_OBLAST, raionCode: DNIPRO_RAION, hromadaCode: DNIPRO_HROMADA,
      category: 'M', name: 'Дніпро'
    });
  });

  it('exposes the raion and hromada a row sits under, and clears them at an oblast boundary', () => {
    expect(entry(MELITOPOL_RAION)).toEqual({
      code: MELITOPOL_RAION, regionCode: ZAPORIZHZHIA_OBLAST, raionCode: MELITOPOL_RAION, hromadaCode: null,
      category: 'P', name: 'Мелітопольський'
    });
    expect(entry(VESELE_HROMADA)?.raionCode).toBe(MELITOPOL_RAION);
    // The row after a raion block must not inherit the previous oblast's raion.
    expect(entry(ZAPORIZHZHIA_OBLAST)?.raionCode).toBeNull();
  });

  it('rejects a workbook that yields fewer rows than the caller expects', () => {
    expect(() => parseKatottgWorkbook(workbook(FIXTURE))).toThrow(/yielded only 9 entries/);
  });
});

describe('raion aliases', () => {
  it('covers the spellings the official alert channel uses', () => {
    expect(raionAliases('Мелітопольський')).toEqual([
      'мелітопольський', 'мелітопольський район', 'мелітопольського району', 'мелітопольському районі'
    ]);
  });

  it('folds the hromadas of a raion in as full forms only', () => {
    const aliases = raionAliases('Харківський', ['Харківська', 'Мереф’янська']);
    expect(aliases).toContain('харківська територіальна громада');
    expect(aliases).toContain('мереф’янська громада');
    // A bare feminine adjective would outrank the "Харківська область" prefix match and steal
    // oblast-level alerts, so hromadas contribute qualified forms only.
    expect(aliases).not.toContain('харківська');
  });
});

describe('catalogue import plan', () => {
  const plan = planCatalogImport(parsed);

  it('hangs every raion off its oblast and names it the way a message spells it', () => {
    expect(plan.raions).toHaveLength(2);
    const melitopol = plan.raions.find((raion) => raion.officialCode === MELITOPOL_RAION);
    expect(melitopol).toMatchObject({
      id: `katottg-${MELITOPOL_RAION.toLocaleLowerCase()}`,
      nameUk: 'Мелітопольський район',
      parentCodes: [ZAPORIZHZHIA_OBLAST]
    });
    expect(melitopol?.aliases).toEqual(expect.arrayContaining([
      'мелітопольський район', 'мелітопольського району',
      'мелітопольська територіальна громада', 'веселівська територіальна громада'
    ]));
    // Hromadas belong to exactly one raion; the neighbouring oblast must not pick them up.
    expect(plan.raions.find((raion) => raion.officialCode === DNIPRO_RAION)?.aliases)
      .not.toContain('веселівська територіальна громада');
  });

  it('prefers the raion as a city parent and keeps the oblast as a fallback', () => {
    expect(plan.cities).toHaveLength(2);
    expect(plan.cities.find((city) => city.officialCode === MELITOPOL_CITY)).toEqual({
      id: `katottg-${MELITOPOL_CITY.toLocaleLowerCase()}`,
      nameUk: 'Мелітополь',
      officialCode: MELITOPOL_CITY,
      aliases: ['мелітополь'],
      parentCodes: [MELITOPOL_RAION, ZAPORIZHZHIA_OBLAST]
    });
  });

  it('falls back to the oblast for a city that sits outside any raion', () => {
    const zone: SheetRow[] = [
      ['UA32000000000030281', '', '', '', '', 'O', 'Київська'],
      ['UA32000000000030281', '', '', 'UA32000000020050699', '', 'M', 'Чорнобиль']
    ];
    const outside = planCatalogImport(parseKatottgWorkbook(workbook(zone), zone.length));
    expect(outside.cities[0]?.parentCodes).toEqual(['UA32000000000030281']);
  });

  it('is deterministic, so a re-import addresses the rows the previous run wrote', () => {
    expect(planCatalogImport(parsed)).toEqual(plan);
    const rows = [...plan.raions, ...plan.cities];
    expect(rows.map((row) => row.id))
      .toEqual(rows.map((row) => `katottg-${row.officialCode.toLocaleLowerCase()}`));
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });
});
