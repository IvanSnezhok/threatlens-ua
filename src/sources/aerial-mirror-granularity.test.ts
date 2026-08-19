import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AERIAL_MIRROR_UPSTREAMS, aerialMirrorUpstream, parseAerialMirrorKlimenkoPayload,
  parseAerialMirrorSkogPayload, toAlarmSnapshotBody
} from './aerial-mirror.js';

/**
 * Дві свіжі витяжки дзеркала, і одна межа, заради якої вони й розділені.
 *
 * Фікстури — справжні тіла, зняті з живого ендпоінта 19.08.2026 і обрізані до чотирьох областей, у
 * яких видно все, що має значення: область-згортка з ввімкненими районами (Харківщина), область без
 * жодної тривоги (Тернопільщина), громада без свого району (Марганецька) і оголошена ціла область
 * (Луганщина, Крим). Числа в тестах — із того самого зрізу, тож вони перевіряються, а не вигадані.
 */

const FIXTURES = resolve(import.meta.dirname, '../../tests/fixtures');
const skogBody = JSON.parse(readFileSync(resolve(FIXTURES, 'aerial-mirror-raw-skog.json'), 'utf8')) as unknown;
const klimenkoBody = JSON.parse(readFileSync(resolve(FIXTURES, 'aerial-mirror-raw-klimenko.json'), 'utf8')) as unknown;

// Обидві фікстури мають `cachedat` 19.08.2026 ~17:10 за Києвом; `now` береться поруч, щоб перевірка
// свіжості не відкинула тіло й не перетворила кожен тест на перевірку staleness.
const NOW = new Date('2026-08-19T14:11:00Z');
const STALE = 300;

describe('skog: райони й громади, без обласної згортки', () => {
  const snapshot = parseAerialMirrorSkogPayload(skogBody, NOW, STALE);
  const names = snapshot.regions.map((region) => region.name);

  it('carries every lit raion and hromada of the capture', () => {
    expect(names).toEqual(expect.arrayContaining([
      'Синельниківський район', 'Запорізький район', 'Бердянський район', 'Пологівський район',
      'Василівський район', 'Мелітопольський район', 'Богодухівський район', 'Харківський район',
      'Чугуївський район', 'Ізюмський район', "Куп'янський район",
      'Марганецька територіальна громада', 'Запорізька територіальна громада',
      'Харківська територіальна громада'
    ]));
    expect(snapshot.byLevel).toEqual({ State: 0, District: 11, Community: 3, other: 0 });
  });

  it('refuses the oblast layer, and counts what it refused', () => {
    // Харківщина, Дніпропетровщина і Запоріжжя стоять у цьому тілі alert:true — але лише тому, що
    // світиться їхня частина. Це і є «тривога в X області», якої влада не оголошувала.
    expect(names).not.toContain('Харківська область');
    expect(names).not.toContain('Дніпропетровська область');
    expect(names).not.toContain('Запорізька область');
    expect(snapshot.droppedRollupOblasts).toBe(3);
    expect(snapshot.regions.every((region) => region.level !== 'State')).toBe(true);
  });

  it('leaves a quiet oblast out entirely', () => {
    expect(names.some((name) => name.includes('Тернопіль'))).toBe(false);
  });

  it('dates a region from the feed’s own `changed`, read as Kyiv wall clock', () => {
    const izium = snapshot.regions.find((region) => region.name === 'Ізюмський район')!;
    expect(izium.active).toBe(true);
    // 14:30:20 у тілі — київський настінний час; парсер зводить його до UTC, і саме це тут пінять.
    expect(izium.changedAt.toISOString()).toBe('2026-08-19T11:30:20.000Z');
  });

  it('refuses a body that is not this feed', () => {
    expect(() => parseAerialMirrorSkogPayload({ states: {} }, NOW, STALE)).toThrow(/no `raw` collection/);
    expect(() => parseAerialMirrorSkogPayload('nope', NOW, STALE)).toThrow(/not a JSON object/);
    expect(() => parseAerialMirrorSkogPayload({ ...(skogBody as object), cachedat: '2020-01-01 00:00:00' }, NOW, STALE))
      .toThrow();
  });
});

describe('klimenko: оголошення рівня області', () => {
  const snapshot = parseAerialMirrorKlimenkoPayload(klimenkoBody, NOW, STALE);
  const names = snapshot.regions.map((region) => region.name);

  it('keeps an oblast only when the whole oblast is declared', () => {
    // У цьому зрізі оголошені цілими рівно три постійні; Харківщина — ні, при пʼятьох ввімкнених
    // районах. Саме ця пара робить фід придатним для рівня області.
    expect(names).toEqual(expect.arrayContaining(['АР Крим', "Севастополь'", 'Луганська область']));
    expect(names).not.toContain('Харківська область');
    expect(names).not.toContain('Тернопільська область');
    expect(snapshot.byLevel.State).toBe(3);
  });

  it('carries the raions too, dated from `enabled_at`', () => {
    expect(names).toEqual(expect.arrayContaining([
      'Ізюмський район', 'Харківський район', 'Богодухівський район', "Куп'янський район", 'Чугуївський район'
    ]));
    expect(snapshot.byLevel.District).toBe(5);
    const bohodukhiv = snapshot.regions.find((region) => region.name === 'Богодухівський район')!;
    expect(bohodukhiv.changedAt.toISOString()).toBe('2026-08-19T14:08:29.000Z');
  });

  it('reads an empty district list as «no raions», not as a broken body', () => {
    // Крим і Севастополь приходять із `districts: []`, а не з обʼєктом.
    expect(names).toContain('АР Крим');
    expect(snapshot.readableCount).toBeGreaterThan(snapshot.byLevel.State);
  });

  it('refuses a body that is not this feed', () => {
    expect(() => parseAerialMirrorKlimenkoPayload({ raw: [] }, NOW, STALE)).toThrow(/no `raw` object/);
    expect(() => parseAerialMirrorKlimenkoPayload(null, NOW, STALE)).toThrow(/not a JSON object/);
  });
});

describe('the registry, and the guard that outlives it', () => {
  it('knows which feeds may speak for an oblast and which may not', () => {
    expect(aerialMirrorUpstream('skog')?.oblastLayer).toBe('rollup');
    expect(aerialMirrorUpstream('klimenko')?.oblastLayer).toBe('declaration');
    expect(aerialMirrorUpstream('ual')?.oblastLayer).toBe('declaration');
    expect(aerialMirrorUpstream('nope')).toBeNull();
    // Виміряні періоди оновлення кешу — те, заради чого типовий апстрім і змінили.
    expect(AERIAL_MIRROR_UPSTREAMS.ual!.observedRefreshSeconds).toBe(121);
    expect(AERIAL_MIRROR_UPSTREAMS.skog!.observedRefreshSeconds).toBeLessThan(30);
  });

  it('refuses to build a snapshot body in which a rollup feed asserts an oblast', () => {
    const rollupWithOblast = {
      upstream: 'skog', cachedAt: NOW, ageSeconds: 1,
      regions: [{ name: 'Харківська область', active: true, changedAt: NOW, level: 'State' as const }]
    };
    expect(() => toAlarmSnapshotBody(rollupWithOblast, 'rollup'))
      .toThrow(/rollup feed may not assert an oblast: Харківська область/);
    // Той самий запис від фіда-оголошення проходить: різниця не в записі, а в тому, хто його сказав.
    expect(() => toAlarmSnapshotBody(rollupWithOblast, 'declaration')).not.toThrow();
  });

  it('passes a raion through unchanged, whichever feed it came from', () => {
    const body = toAlarmSnapshotBody(parseAerialMirrorSkogPayload(skogBody, NOW, STALE), 'rollup') as {
      states: Array<{ regionName: string; active: boolean; startedAt: string }>;
    };
    expect(body.states).toEqual(expect.arrayContaining([
      { regionName: 'Ізюмський район', active: true, startedAt: '2026-08-19T11:30:20.000Z' }
    ]));
  });
});
