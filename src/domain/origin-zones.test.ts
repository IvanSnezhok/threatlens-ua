import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { detectOriginZone, originZoneById, ORIGIN_ZONES } from './origin-zones.js';

/**
 * Зона походження — єдине місце в системі, де на карту потрапляє точка поза Україною, тож межа тут
 * вужча, ніж деінде: показуємо рівно те, що написало джерело, і жодного разу не добудовуємо.
 */
describe('origin zones are read, never inferred', () => {
  it('reads the sea a source actually named', () => {
    expect(detectOriginZone('Пуски крилатих ракет з акваторії Чорного моря.')?.id).toBe('black_sea');
    expect(detectOriginZone('Ворожі БпЛА з Азовського моря')?.id).toBe('azov_sea');
  });

  it('reads a compass approach a source actually named', () => {
    expect(detectOriginZone('БпЛА з півночі на Чернігівщину')?.id).toBe('northern_approach');
    expect(detectOriginZone('Ворожі цілі зі сходу')?.id).toBe('eastern_approach');
  });

  it('stays silent when the message names no origin at all', () => {
    // Найважливіший тест набору. «Зліт стратегічної авіації» не каже, ЗВІДКИ злетіли, і спокуса
    // дописати зону за класом зброї — це рівно та вигадка, заради заборони якої існує правило
    // «напрямки відображаються лише тоді, коли їх повідомило джерело».
    expect(detectOriginZone('Зліт стратегічної авіації')).toBeNull();
    expect(detectOriginZone('Активність МіГ-31К')).toBeNull();
    expect(detectOriginZone('Загроза застосування балістики')).toBeNull();
  });

  it('does not mistake the place of interception for the place of launch', () => {
    // «Збито над Чорним морем» — це де ціль впала, а не звідки вийшла. Патерни вимагають прийменника
    // походження саме тому: без нього зона пуску засвітилася б від повідомлення про збиття.
    expect(detectOriginZone('Збито над Чорним морем')).toBeNull();
    expect(detectOriginZone('Уламки впали в Азовському морі')).toBeNull();
  });

  it('carries an anchor that is off Ukrainian land, checked against the real border', () => {
    // Якір — це «десь там», а не позиція носія. Якби він лежав НА УКРАЇНСЬКІЙ СУШІ, іконка походження
    // стала б іконкою загрози на нашій території, тобто змінила б власне значення.
    //
    // Перевірка йде по справжньому контуру, а не по рамці координат, і це не педантизм: Азовське
    // море цілком лежить усередині прямокутника України (22.1–40.3 × 44.1–52.4), тож рамковий тест
    // оголосив би морський якір «усередині країни» й змусив би зсувати його туди, де він уже нічого
    // не означає. Межа держави — не прямокутник, і саме її тут і питають.
    const border = JSON.parse(readFileSync(
      new URL('../../public/data/ukraine-adm0.geojson', import.meta.url), 'utf8'
    )) as { features: Array<{ geometry: { type: string; coordinates: number[][][] | number[][][][] } }> };

    /** Ray casting по одному кільцю. */
    const inRing = (ring: number[][], lon: number, lat: number): boolean => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        const [xi, yi] = ring[i] as [number, number];
        const [xj, yj] = ring[j] as [number, number];
        if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };
    const onLand = (lon: number, lat: number): boolean => {
      for (const feature of border.features) {
        const polygons = feature.geometry.type === 'MultiPolygon'
          ? feature.geometry.coordinates as number[][][][]
          : [feature.geometry.coordinates as number[][][]];
        for (const polygon of polygons) {
          const [outer, ...holes] = polygon;
          if (!outer || !inRing(outer, lon, lat)) continue;
          if (holes.some((hole) => inRing(hole, lon, lat))) continue;
          return true;
        }
      }
      return false;
    };

    for (const zone of ORIGIN_ZONES) {
      const [lon, lat] = zone.anchor;
      expect(onLand(lon, lat), `${zone.id} має якір на українській суші`).toBe(false);
    }
  });

  it('names no military object anywhere in the catalogue', () => {
    // Заборона на точні військові координати діє незалежно від того, чи назвало об'єкт джерело.
    const forbidden = /енгельс|оленья|міллеров|ахтарськ|аеродром|авіабаз|полігон/iu;
    for (const zone of ORIGIN_ZONES) {
      expect(zone.name).not.toMatch(forbidden);
      expect(zone.id).not.toMatch(forbidden);
      for (const pattern of zone.patterns) expect(pattern.source).not.toMatch(forbidden);
    }
  });

  it('resolves an id back to its zone, and an unknown id to nothing', () => {
    expect(originZoneById('black_sea')?.name).toBe('акваторія Чорного моря');
    expect(originZoneById('engels')).toBeNull();
    expect(originZoneById(null)).toBeNull();
    expect(originZoneById(undefined)).toBeNull();
  });
});
