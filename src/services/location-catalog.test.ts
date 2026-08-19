import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { hromadaAliases, parseKatottgWorkbook, planCatalogImport, raionAliases } from './location-catalog.js';

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

  it('no longer answers for the hromadas inside it', () => {
    // Until migration 051 these were folded in here. They are rows of their own now, and an alias
    // left behind on the raion would compete with the hromada's own name for the same text.
    expect(raionAliases('Харківський')).not.toContain('харківська територіальна громада');
  });
});

describe('hromada aliases', () => {
  it('spells both forms the alert mirrors publish', () => {
    expect(hromadaAliases('Мереф’янська')).toEqual([
      'мереф’янська територіальна громада', 'мереф’янська громада'
    ]);
  });

  it('never emits the bare adjective, which would shadow the oblast', () => {
    // `normalizeForCatalogue` strips the «область» affix before matching, so «Харківська область»
    // reaches the query as exactly `харківська`. A hromada alias spelt that way would be an exact
    // rank-1 hit against the oblast's rank-2 prefix hit and would take every oblast declaration.
    expect(hromadaAliases('Харківська').every((alias) => alias.endsWith('громада'))).toBe(true);
    expect(hromadaAliases('Харківська')).not.toContain('харківська');
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
    expect(melitopol?.aliases).toEqual([
      'мелітопольський', 'мелітопольський район', 'мелітопольського району', 'мелітопольському районі'
    ]);
  });

  it('gives every hromada a row of its own, under its raion', () => {
    expect(plan.hromadas).toHaveLength(3);
    expect(plan.hromadas.find((hromada) => hromada.officialCode === VESELE_HROMADA)).toEqual({
      id: `katottg-${VESELE_HROMADA.toLocaleLowerCase()}`,
      nameUk: 'Веселівська територіальна громада',
      officialCode: VESELE_HROMADA,
      aliases: ['веселівська територіальна громада', 'веселівська громада'],
      parentCodes: [MELITOPOL_RAION, ZAPORIZHZHIA_OBLAST]
    });
  });

  it('parents a city on its hromada, keeping raion and oblast as fallbacks', () => {
    expect(plan.cities).toHaveLength(2);
    // The order matters and is not cosmetic: the alert fan-out walks the ancestors of the ALERTED
    // row, so a city parented on the raion would never hear the alert of the hromada it sits in.
    expect(plan.cities.find((city) => city.officialCode === MELITOPOL_CITY)).toEqual({
      id: `katottg-${MELITOPOL_CITY.toLocaleLowerCase()}`,
      nameUk: 'Мелітополь',
      officialCode: MELITOPOL_CITY,
      aliases: ['мелітополь'],
      parentCodes: [MELITOPOL_HROMADA, MELITOPOL_RAION, ZAPORIZHZHIA_OBLAST]
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
    const rows = [...plan.raions, ...plan.hromadas, ...plan.cities];
    expect(rows.map((row) => row.id))
      .toEqual(rows.map((row) => `katottg-${row.officialCode.toLocaleLowerCase()}`));
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });
});
