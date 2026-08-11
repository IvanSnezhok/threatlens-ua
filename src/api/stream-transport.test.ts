import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Транспорт свіжості з боку браузера: потік подій, повтори й опитування знімка.
 *
 * Сервер тримає щонайбільше `SSE_MAX_STREAMS` стрімів і відповідає 503 на наступний, а рідний
 * EventSource на не-200 закривається назавжди й повторює живий розрив рівно через `retry: 3000`
 * без розкиду. Обидві межі — серверна й браузерна — сходяться в `web/app.js`, і саме там ціна
 * помилки найбільша: синхронний фронт клієнтів кладе щойно піднятий процес, а мертвий потік у
 * вкладці не видно взагалі, доки хтось не перезавантажить сторінку.
 *
 * `web/app.js` — браузерний бандл: він починається з `import maplibregl`, чіпає `document` на рівні
 * модуля й закінчується викликом `boot()`, тож у node-тест його не імпортувати. Тому розклад
 * повторів вирізається з шипованого тексту й виконується — під тестом сам файл, а не його копія.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const APP_SOURCE = readFileSync(resolve(ROOT, 'web/app.js'), 'utf8');
const SERVER_SOURCE = readFileSync(resolve(ROOT, 'src/api/server.ts'), 'utf8');

/** Довжина збалансованої дужки, що відкривається на `start`, разом з обома дужками. */
function balanced(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === `'` || character === '"' || character === '`') { quote = character; continue; }
    if (character === open) depth += 1;
    else if (character === close) { depth -= 1; if (depth === 0) return index; }
  }
  throw new Error('unbalanced source');
}

/** Повне оголошення `function NAME(…) { … }` зі шипованого файлу. */
function functionSource(name: string): string {
  const declaration = APP_SOURCE.indexOf(`function ${name}(`);
  if (declaration === -1) throw new Error(`function ${name} not found in web/app.js`);
  const brace = APP_SOURCE.indexOf('{', APP_SOURCE.indexOf(')', declaration));
  return APP_SOURCE.slice(declaration, balanced(APP_SOURCE, brace, '{', '}') + 1);
}

/** Оголошення числової сталої разом з крапкою з комою; хвостовий коментар відкидається. */
function constDeclaration(name: string): string {
  const start = APP_SOURCE.search(new RegExp(`const ${name}\\s*=`));
  if (start === -1) throw new Error(`const ${name} not found in web/app.js`);
  return APP_SOURCE.slice(start, APP_SOURCE.indexOf('\n', start)).replace(/\s*\/\/.*$/, '');
}

function evaluate<T>(constants: string[], name: string): T {
  const source = `${constants.map(constDeclaration).join('\n')}\n${functionSource(name)}`;
  return new Function(`${source}\nreturn ${name};`)() as T;
}

type Delay = (first: unknown, random?: () => number) => number;

const streamRetryDelay = evaluate<Delay>(['STREAM_RETRY_BASE_MS', 'STREAM_RETRY_CEILING_MS'], 'streamRetryDelay');
const snapshotPollDelay = evaluate<Delay>(['SNAPSHOT_POLL_LIVE_MS', 'SNAPSHOT_POLL_FALLBACK_MS'], 'snapshotPollDelay');
const refreshDelay = evaluate<Delay>(['REFRESH_DEBOUNCE_MS', 'REFRESH_SPREAD_MS', 'REFRESH_SPREAD_ALERT_MS'], 'refreshDelay');

const FLOOR = () => 0;
const CEILING = () => 1;

describe('розклад повторів потоку', () => {
  it('росте експонентою й упирається в стелю', () => {
    expect(streamRetryDelay(1, CEILING)).toBe(2000);
    expect(streamRetryDelay(2, CEILING)).toBe(4000);
    expect(streamRetryDelay(3, CEILING)).toBe(8000);
    // Стеля не дає розкладу піти в години: вкладка мусить повернутися сама, без перезавантаження.
    expect(streamRetryDelay(20, CEILING)).toBe(60000);
    expect(streamRetryDelay(20, FLOOR)).toBe(30000);
  });

  it('ніколи не повертається миттєво — саме в той сервер, який щойно відмовив', () => {
    // Повний розкид ([0, ceiling]) на першій же невдачі дозволяв би повтор за десятки мілісекунд,
    // а 503 «стріми скінчилися» за таку паузу не розсмоктується.
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      expect(streamRetryDelay(attempt, FLOOR)).toBeGreaterThanOrEqual(1000);
      expect(streamRetryDelay(attempt, FLOOR)).toBe(streamRetryDelay(attempt, CEILING) / 2);
    }
  });

  it('розводить клієнтів замість того, щоб вертати їх одним фронтом', () => {
    const samples = new Set(Array.from({ length: 300 }, () => streamRetryDelay(3)));
    // Розсип у вікні [4000, 8000] проти рівно одного значення, яке дав би рідний `retry: 3000`.
    expect(samples.size).toBeGreaterThan(50);
    for (const value of samples) {
      expect(value).toBeGreaterThanOrEqual(4000);
      expect(value).toBeLessThanOrEqual(8000);
    }
  });
});

describe('крок опитування знімка', () => {
  it('частішає, коли потоку немає, і ніколи не збігається з живим кроком', () => {
    const liveFloor = snapshotPollDelay(true, FLOOR);
    const fallbackCeiling = snapshotPollDelay(false, CEILING);
    expect(fallbackCeiling).toBeLessThan(liveFloor);
    // Друга нога свіжості не має права мовчати довше за півхвилини: у затриманому режимі на
    // спокійній системі кадрів потоку не буває взагалі, і вся свіжість тримається на ній одній.
    expect(fallbackCeiling).toBeLessThanOrEqual(30000);
  });

  it('розкидає обидва кроки навколо номіналу', () => {
    for (const live of [true, false]) {
      const nominal = live ? 60000 : 20000;
      expect(snapshotPollDelay(live, FLOOR)).toBe(Math.round(nominal * 0.85));
      expect(snapshotPollDelay(live, CEILING)).toBe(Math.round(nominal * 1.15));
      const samples = new Set(Array.from({ length: 300 }, () => snapshotPollDelay(live)));
      expect(samples.size).toBeGreaterThan(50);
    }
  });
});

describe('перечитування знімка після кадру', () => {
  it('тримає офіційну тривогу попереду решти подій', () => {
    // Розводити фронт треба й тут, але секунда з чвертю на alert.started — це секунда з чвертю
    // затримки саме того сигналу, який мусить випереджати аналітику.
    expect(refreshDelay('alert.started', CEILING)).toBeLessThan(refreshDelay('threat.updated', CEILING));
    expect(refreshDelay('alert.ended', CEILING)).toBeLessThanOrEqual(700);
  });

  it('ніколи не бʼє в знімок раніше за спільне вікно склеювання', () => {
    for (const name of ['alert.started', 'threat.updated', 'analytics.updated', undefined]) {
      expect(refreshDelay(name, FLOOR)).toBeGreaterThanOrEqual(250);
      expect(refreshDelay(name, CEILING)).toBeLessThanOrEqual(1450);
    }
  });

  it('розводить однакову подію в різних вкладках', () => {
    const samples = new Set(Array.from({ length: 300 }, () => refreshDelay('threat.created')));
    expect(samples.size).toBeGreaterThan(50);
  });
});

describe('життєвий цикл зʼєднання', () => {
  it('відкриває рівно один EventSource і закриває його перед новим', () => {
    expect(APP_SOURCE.match(/new EventSource\(/g)).toHaveLength(1);
    const connect = functionSource('connectStream');
    // closeStream() стоїть ПЕРЕД конструктором: інакше повернення на видиму вкладку посеред уже
    // запланованого повтору лишало б два стріми, обидва в межі SSE_MAX_STREAMS.
    expect(connect.indexOf('closeStream()')).toBeGreaterThan(-1);
    expect(connect.indexOf('closeStream()')).toBeLessThan(connect.indexOf('new EventSource('));
    expect(connect).toContain('clearTimeout(streamRetryTimer)');
  });

  it('глушить рідний повтор EventSource, а не накладається на нього', () => {
    const close = functionSource('closeStream');
    // Знімати onerror треба до close(), інакше закриття, зроблене нами, повернеться в retryStream()
    // і підніме лічильник спроб на рівному місці.
    expect(close.indexOf('onerror = null')).toBeLessThan(close.indexOf('.close()'));
  });

  it('не рахує спробу за помилкою вже закритого стріму', () => {
    // close() не скасовує вже поставленої в чергу події, тож обробник переживає власний стрім.
    expect(functionSource('connectStream')).toContain('if (stream !== source) return;');
  });

  it('опитує знімок ланцюжком таймаутів, а не інтервалом', () => {
    // setInterval не чекає завершення запиту: клієнт, у якого знімок під навантаженням іде вісім
    // секунд, тримав би кілька паралельних відповідей — і тим більше, чим гірше серверу.
    expect(APP_SOURCE).not.toMatch(/setInterval\([^)]*loadSnapshot/);
    expect(functionSource('schedulePoll')).toContain('setTimeout');
  });

  it('віддає зʼєднання прихованої вкладки, але не кіоску й не миттєво', () => {
    const suspend = functionSource('suspendStreaming');
    expect(suspend).toContain(`document.body.classList.contains('tv-mode')`);
    expect(suspend).toContain('HIDDEN_GRACE_MS');
    // Кожен таймер вкладки має бути знятий: інакше присипляння лишало б за собою роботу, заради
    // прибирання якої воно й робиться.
    for (const timer of ['pollTimer', 'refreshTimer', 'streamRetryTimer']) {
      expect(suspend).toContain(`clearTimeout(${timer})`);
    }
    expect(suspend).toContain('closeStream()');
    // Стан міг змінитися за хвилину відстрочки — перевірка стоїть у момент засинання, не до нього.
    expect(suspend).toContain('if (!document.hidden) return;');
  });

  it('повертає вкладку до життя разом зі свіжістю', () => {
    const resume = functionSource('resumeStreaming');
    // updateFreshness() — ДО знімка: повернення через десять хвилин мусить показати «ДАНІ
    // ЗАСТАРІЛИ» одразу, а не після відповіді сервера.
    expect(resume.indexOf('updateFreshness()')).toBeLessThan(resume.indexOf('loadSnapshot()'));
    expect(resume).toContain('streamAttempt = 0');
    expect(resume).toContain('connectStream()');
    expect(APP_SOURCE).toContain(`document.addEventListener('visibilitychange'`);
  });
});

describe('чесність смуги свіжості', () => {
  const freshness = functionSource('updateFreshness');

  it('не ховає віку знімка за написом про обірваний звʼязок', () => {
    const offline = freshness.slice(freshness.indexOf('connectionLost'));
    expect(offline).toContain('показано останній відомий стан · оновлено ${Math.round(age)} с тому');
    expect(freshness).toContain(`ЗВʼЯЗОК ПЕРЕРВАНО`);
  });

  it('тримає «звʼязок перервано» довше за один тик годинника', () => {
    // Раніше напис ставив лише markOffline(), а updateFreshness() щосекунди перемальовує обидва
    // рядки — тобто через секунду посеред обірваного звʼязку поверталося «ДАНІ АКТУАЛЬНІ».
    expect(functionSource('markOffline')).toContain('connectionLost = true');
    expect(functionSource('loadSnapshot')).toContain('connectionLost = false');
    expect(freshness).toMatch(/dataset\.state = connectionLost \|\|/);
  });

  it('називає опитування опитуванням, а не мовчить про втрачений потік', () => {
    expect(freshness).toContain('без потоку, оновлення кожні');
    // Не на першій секунді завантаження: «потоку ще немає» — це не «потік підвів».
    expect(freshness).toContain('streamAttempt > 0');
  });

  it('лишає межу публікації недоторканою', () => {
    // Зріз і «остання подія» — контракт затриманого режиму; транспорт дописується поруч, не замість.
    expect(freshness).toContain('зріз о ${shortTime(publication.cutoffAt)}');
    expect(freshness).toContain('остання подія о ${shortTime(publication.lastPublishedEventAt)}');
  });
});

describe('контракт із сервером', () => {
  it('відновлюється з точки, яку сервер трактує як Last-Event-ID', () => {
    expect(APP_SOURCE).toContain('/api/v1/stream?since=${snapshot?.version ?? 0}');
    expect(SERVER_SOURCE).toContain(`request.query.since`);
  });

  it('має клієнтський повтор саме тому, що сервер відмовляє за межею стрімів', () => {
    // Рідний EventSource на не-200 закривається назавжди: без клієнтського повтору 503 означав би
    // вкладку з мертвим потоком до перезавантаження сторінки.
    expect(SERVER_SOURCE).toContain(`reply.code(503).header('Retry-After', '30').send({ error: 'stream_capacity' })`);
    expect(APP_SOURCE).toContain('function retryStream()');
  });
});
