import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { parseKatottgWorkbook } from './location-catalog.js';

describe('KATOTTG XLSX parser', () => {
  it('parses shared strings and ignores self-closing cells without swallowing later values', () => {
    const strings = ['UA12000000000090473', 'O', 'Дніпропетровська', 'UA12000000000090473',
      'UA12020010010066750', 'M', 'Дніпро'];
    const shared = `<?xml version="1.0"?><sst>${strings.map((value) => `<si><t>${value}</t></si>`).join('')}</sst>`;
    const sheet = `<?xml version="1.0"?><worksheet><sheetData>
      <row r="5"><c r="A5" t="s"><v>0</v></c><c r="B5"/><c r="F5" t="s"><v>1</v></c><c r="G5" t="s"><v>2</v></c></row>
      <row r="6"><c r="A6" t="s"><v>3</v></c><c r="B6"/><c r="C6"/><c r="D6" t="s"><v>4</v></c><c r="E6"/><c r="F6" t="s"><v>5</v></c><c r="G6" t="s"><v>6</v></c></row>
    </sheetData></worksheet>`;
    const workbook = zipSync({
      'xl/sharedStrings.xml': strToU8(shared), 'xl/worksheets/sheet1.xml': strToU8(sheet)
    });
    expect(parseKatottgWorkbook(workbook, 2)).toEqual([
      { code: 'UA12000000000090473', regionCode: 'UA12000000000090473', category: 'O', name: 'Дніпропетровська' },
      { code: 'UA12020010010066750', regionCode: 'UA12000000000090473', category: 'M', name: 'Дніпро' }
    ]);
  });
});
