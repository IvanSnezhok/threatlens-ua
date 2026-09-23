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

/**
 * Другий зріз того самого фіда — 22.09.2026 19:06 за Києвом, уже З КОЛЬОРОМ.
 *
 * Окрема фікстура, а не оновлення попередньої, і це навмисно. Зріз 19.08.2026 знятий ДО того, як
 * Уряд запровадив диференційоване оповіщення (06.09.2026), тож поля `alert_level` у ньому немає
 * взагалі — і саме тому він цінний: він доводить, що тіло без кольору парситься точно так, як
 * парсилося завжди, і жодна тривога від цього не зникає. Перезняти його означало б цю перевірку
 * втратити, а заразом переписати п'ять тверджень про ГРАНУЛЯРНІСТЬ (п'ять районів Харківщини,
 * `enabled_at` Богодухівського, три оголошені області), які до кольору не мають стосунку: у
 * вересневому зрізі Харківщина має один район, а Луганщина — вісім.
 *
 * Обрізано до п'яти областей, у яких видно кожну форму, що має значення: оголошена ціла область із
 * червоним (Луганщина), вимкнена область із вісьмома червоними районами (Донеччина), вимкнена
 * область із жовтими районами й одним тихим (Чернігівщина), ввімкнена область БЕЗ кольору
 * (АР Крим — постійний запис із 2022 року) і тиха область (Тернопільщина).
 */
const klimenkoLevelsBody = JSON.parse(
  readFileSync(resolve(FIXTURES, 'aerial-mirror-raw-klimenko-levels.json'), 'utf8')
) as unknown;

// Обидві серпневі фікстури мають `cachedat` 19.08.2026 ~17:10 за Києвом; `now` береться поруч, щоб
// перевірка свіжості не відкинула тіло й не перетворила кожен тест на перевірку staleness.
const NOW = new Date('2026-08-19T14:11:00Z');
const STALE = 300;

/** Поруч із `cachedat` вересневої фікстури: 19:06:10 за Києвом — це 16:06:10 UTC. */
const NOW_LEVELS = new Date('2026-09-22T16:07:00Z');

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

  it('reads a body captured before differentiated alerting as a body with no colour at all', () => {
    // Зріз 19.08.2026 не має поля `alert_level` ніде. Це не збій і не привід нічого відкинути:
    // тривоги лишаються всі до одної, просто жодна з них не має кольору. Саме так має виглядати
    // будь-яка тривога, про колір якої джерело мовчить, — і саме це найчастіший випадок.
    expect(snapshot.regions).toHaveLength(8);
    expect(snapshot.regions.every((region) => region.threatLevel === undefined)).toBe(true);
    expect(snapshot.byThreatLevel).toEqual({ yellow: 0, red: 0, unknown: 0 });
  });
});

/**
 * Колір тривоги, прочитаний із живого тіла.
 *
 * Числа взяті з того самого зрізу, у якому вони виміряні, тож вони перевіряються, а не вигадані:
 * повне тіло 22.09.2026 19:06 мало 153 вузли, 34 ввімкнених, 12 `red`, 20 `yellow` і 2 ввімкнених
 * без кольору. Фікстура — п'ять областей із нього.
 */
describe('klimenko: колір тривоги', () => {
  const snapshot = parseAerialMirrorKlimenkoPayload(klimenkoLevelsBody, NOW_LEVELS, STALE);
  const byName = new Map(snapshot.regions.map((region) => [region.name, region]));

  it('carries the colour the feed declared, on the oblast and on the raion alike', () => {
    expect(byName.get('Луганська область')?.threatLevel).toBe('red');
    expect(byName.get('Покровський район')?.threatLevel).toBe('red');
    expect(byName.get('Ніжинський район')?.threatLevel).toBe('yellow');
    // Щабель адміністративний і колір — дві різні осі, і поля в них різні. Луганщина тут State і
    // водночас red; якби це було одне поле, одне зі значень довелося б втратити.
    expect(byName.get('Луганська область')?.level).toBe('State');
  });

  it('leaves a holding region without a colour when the feed named none', () => {
    // АР Крим і Севастополь стоять ввімкненими з 2022 року й кольору не мають. Це НЕ означає «менша
    // небезпека» — лише «кольору не назвали», і тривога від цього нікуди не дівається.
    expect(byName.get('АР Крим')?.active).toBe(true);
    expect(byName.get('АР Крим')).not.toHaveProperty('threatLevel');
  });

  it('counts holding nodes by colour, and only holding ones', () => {
    // Донеччина: сама область вимкнена, під нею вісім червоних районів. Чернігівщина: область
    // вимкнена, чотири жовті райони й один тихий. Плюс червона Луганщина.
    expect(snapshot.byThreatLevel).toEqual({ yellow: 4, red: 9, unknown: 0 });
    // Рівно стільки ж кольорових записів, скільки регіонів із кольором у знімку: лічильник не
    // може розійтися з тим, що поїде далі.
    expect(snapshot.regions.filter((region) => region.threatLevel).length).toBe(13);
    expect(snapshot.regions).toHaveLength(14);
  });

  it('never reads a colour off a region that is switched off', () => {
    expect(byName.has('Донецька область')).toBe(false);
    expect(byName.has('Тернопільська область')).toBe(false);
    expect(byName.has('Прилуцький район')).toBe(false);
  });

  it('drops a colour the domain does not know instead of widening the enum', () => {
    // Не з фікстури, бо апстрім такого не віддає — і саме тому це треба перевірити окремо. Колір,
    // якого немає в переліку, не має права доїхати ні до знімка, ні до CHECK у міграції 054:
    // перелік домену розширюється міграцією, а не тілом, яке приїхало вночі.
    const invented = parseAerialMirrorKlimenkoPayload({
      source: 'klimenko', cachedat: '2026-09-22 19:06:10',
      raw: {
        'Сумська область': {
          enabled: true, 'type:': 'state', alert_level: 'crimson',
          districts: {
            'Сумський район': { enabled: true, alert_level: 'red', enabled_at: '2026-09-22T14:00:00.000Z' }
          },
          enabled_at: '2026-09-22T14:00:00.000Z'
        }
      }
    }, NOW_LEVELS, STALE);
    const oblast = invented.regions.find((region) => region.name === 'Сумська область')!;
    // Тривога лишається — відкинуто ЛИШЕ колір. Втратити тривогу через незнайоме значення прикмети
    // було б рівно тим, чого ця система не має права робити.
    expect(oblast.active).toBe(true);
    expect(oblast).not.toHaveProperty('threatLevel');
    expect(invented.byThreatLevel).toEqual({ yellow: 0, red: 1, unknown: 1 });
  });

  it('emits the colour into the snapshot body, and omits the field where there is none', () => {
    const body = toAlarmSnapshotBody(snapshot, 'declaration') as {
      states: Array<{ regionName: string; alertLevel?: string }>;
    };
    const state = (name: string) => body.states.find((row) => row.regionName === name)!;
    expect(state('Луганська область').alertLevel).toBe('red');
    expect(state('Ніжинський район').alertLevel).toBe('yellow');
    // Тіло тривоги без кольору — байт у байт те саме, що й до 06.09.2026.
    expect(state('АР Крим')).not.toHaveProperty('alertLevel');
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

  it('passes a raion through unchanged, carrying the oblast it was nested under', () => {
    const body = toAlarmSnapshotBody(parseAerialMirrorSkogPayload(skogBody, NOW, STALE), 'rollup') as {
      states: Array<{ regionName: string; active: boolean; startedAt: string; parentName?: string }>;
    };
    // `parentName` — не рівень і не твердження: область тут лишається згорткою й тривоги не
    // піднімає. Це підказка резолверу, чию однойменну громаду мали на увазі (міграція 051).
    expect(body.states).toEqual(expect.arrayContaining([
      {
        regionName: 'Ізюмський район', active: true, startedAt: '2026-08-19T11:30:20.000Z',
        parentName: 'Харківська область'
      }
    ]));
  });
});
