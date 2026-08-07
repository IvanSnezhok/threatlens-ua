import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Ukraine sovereignty map assets', () => {
  it('contains Crimea and Sevastopol inside the Ukraine ADM1 dataset', () => {
    const geojson = JSON.parse(readFileSync(resolve('public/data/ukraine-adm1.geojson'), 'utf8'));
    const units = new Map(geojson.features.map((feature: any) => [feature.properties.shapeISO, feature.properties]));
    expect(units.get('UA-43')).toMatchObject({ shapeGroup: 'UKR', shapeName: 'Autonomous Republic of Crimea' });
    expect(units.get('UA-40')).toMatchObject({ shapeGroup: 'UKR', shapeName: 'Sevastopol' });
    expect(geojson.features).toHaveLength(27);
  });
});
