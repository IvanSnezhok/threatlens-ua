import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyMessage } from '../domain/classifier.js';
import type { NormalizedMessage } from '../types.js';

/**
 * Codex як основний класифікатор — чиста частина і виклик із заглушками.
 *
 * Без бази: `pool.query` відповідає порожньо, а контексти й попередні повідомлення підставляються
 * через параметри. Те, що тут пінять: вердикт стає класифікацією з географією каталогу; кожен
 * запасний вихід лишає правила; придушення вимагає більшої впевненості; бюджети — без черги.
 */

process.env.CODEX_PRIMARY_MAX_PER_MINUTE = '3';
process.env.CODEX_PRIMARY_MAX_CONCURRENT = '2';

const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
vi.mock('../db/pool.js', () => ({ pool: { query: (...args: unknown[]) => query(...args as []) } }));

const {
  classificationFromVerdict, classifyWithCodex, codexVerdictSchema, resetCodexClassifier, contextLineForVerdict
} = await import('./codex-classifier.js');
// Динамічно й саме тут, як і модуль під тестом: статичний `import` виконався б ДО двох присвоєнь
// вище, і бюджети, які цей файл звужує, читалися б типовими.
const { config } = await import('../config.js');

const lexemes = [
  { id: 'ua-80', name: 'Київ', aliases: ['києва', 'києві'] },
  { id: 'ua-53', name: 'Полтавська область', aliases: ['полтавщина', 'полтавщині'] },
  { id: 'ua-city-kremenchuk', name: 'Кременчук', aliases: ['кременчука', 'кременчуці'] }
];

/**
 * Момент «зараз» для кожного виклику.
 *
 * Явний, а не годинник машини, і це не косметика: `classifyWithCodex` порівнює вік повідомлення зі
 * стелею доставки, тож фіксована дата публікації плюс справжній `Date.now()` означала б, що з
 * кожним днем після написання тесту повідомлення старішає, і одного дня всі ці перевірки почали б
 * питати в моделі те, чого вона вже не отримує. Пʼять хвилин — свіже повідомлення за будь-якої
 * стелі.
 */
const PUBLISHED_AT = new Date('2026-08-18T12:00:00Z');
const now = () => new Date(PUBLISHED_AT.getTime() + 5 * 60_000);

function message(text: string): NormalizedMessage {
  return { sourceId: 'osint-eradar', externalId: 'm-1', publishedAt: PUBLISHED_AT, text, rawPayload: {} };
}

function verdict(overrides: Record<string, unknown> = {}) {
  return codexVerdictSchema.parse({
    threatType: 'uav', significant: true, confidence: 0.85, locations: ['Полтавщина'], nationalScope: false,
    originLocations: [], destinationLocations: [], directionText: null, threatState: 'asserted',
    timing: 'now', probability: 0.7, expectedFrom: null, expectedUntil: null, note: 'Джерело категоричне.',
    ...overrides
  });
}

const chatReturning = (value: unknown) => vi.fn(async () => ({ ok: true as const, content: JSON.stringify(value), model: 'gpt-5.2', durationMs: 3 }));
const noPrevious = async () => [];
const noContexts = async () => [];

beforeEach(() => { resetCodexClassifier(); query.mockClear(); });

describe('classificationFromVerdict', () => {
  it('builds the event contract from the model class with the catalogue geography', () => {
    const rules = classifyMessage('Шахеди на Полтавщині.', lexemes);
    const built = classificationFromVerdict(verdict({ threatType: 'ballistic_missile', locations: ['Полтавщина', 'Кременчук'] }), rules, lexemes, 'Балістика на Полтавщину, Кременчук.');
    expect(built.resolvedLocations).toBe(2);
    expect(built.classified.intent).toBe('threat');
    expect(built.classified.threatType).toBe('ballistic_missile');
    expect(built.classified.locations.map((location) => location.id).sort()).toEqual(['ua-53', 'ua-city-kremenchuk']);
    expect(built.classified.locations.every((location) => location.relationType === 'explicit_threat')).toBe(true);
    expect(built.classified.title).toBe('Балістична загроза');
    expect(built.classified.indicators[0]).toBe('model_classified');
  });

  it('marks redirected destinations as reported direction and never invents an id', () => {
    const rules = classifyMessage('Шахеди на Полтавщині.', lexemes);
    const built = classificationFromVerdict(verdict({ threatState: 'redirected', destinationLocations: ['Кременчук', 'Неіснуюче місто'] }), rules, lexemes, 'курс на Кременчук');
    expect(built.classified.locations).toEqual([{ id: 'ua-city-kremenchuk', name: 'Кременчук', relationType: 'reported_direction' }]);
  });

  it('writes the model’s origins in the rules’ own transit shape, so the chain reads «звідки → куди»', () => {
    // `planStep` (./threat-vectors.ts) малює `reported_transit` лише з `redirect`, у якого є
    // відкликане місце й місце з `reported_direction`, — тієї форми, яку правила дають «повз A на B».
    // Вердикт моделі на те саме речення мусить лягти в ту саму форму, інакше рух не намалюється ніколи.
    const text = 'Шахеди повз Кременчук на Київ.';
    const rules = classifyMessage(text, lexemes);
    expect(rules.intent).toBe('redirect');
    const built = classificationFromVerdict(verdict({
      threatState: 'redirected', locations: ['Кременчук', 'Київ'], originLocations: ['Кременчук'], destinationLocations: ['Київ']
    }), rules, lexemes, text);
    const directions = (classified: typeof rules) => classified.locations
      .filter((location) => location.relationType === 'reported_direction').map((location) => location.id);

    expect(built.classified.intent).toBe(rules.intent);
    expect(built.classified.retraction?.locations.map((location) => location.id))
      .toEqual(rules.retraction?.locations.map((location) => location.id));
    expect(built.classified.retraction).toMatchObject({ threatTypes: ['uav'], coverage: 'located' });
    expect(directions(built.classified)).toEqual(directions(rules));
    // Місце «звідки» — історія, а не місце, для якого модель стверджує загрозу: зняти таке твердження
    // не було б кому, бо вердикт моделі не відкликає нічого.
    expect(built.classified.locations.map((location) => location.id)).toEqual(['ua-80']);
  });

  it('reads a named course with both ends as transit, dropping an origin the catalogue cannot place', () => {
    const rules = classifyMessage('Шахеди на Полтавщині.', lexemes);
    const built = classificationFromVerdict(verdict({
      threatState: 'asserted', directionText: 'з Кременчука на Київ',
      originLocations: ['Атлантида', 'Кременчук'], destinationLocations: ['Київ']
    }), rules, lexemes, 'Шахеди з Кременчука на Київ.');
    expect(built.classified.intent).toBe('redirect');
    expect(built.classified.retraction?.locations).toEqual([{ id: 'ua-city-kremenchuk', name: 'Кременчук' }]);
    expect(built.classified.locations).toEqual([{ id: 'ua-80', name: 'Київ', relationType: 'reported_direction' }]);
  });

  it('is no transit when no place it came from resolves', () => {
    const rules = classifyMessage('Шахеди на Полтавщині.', lexemes);
    const built = classificationFromVerdict(verdict({
      threatState: 'redirected', originLocations: ['Атлантида'], destinationLocations: ['Кременчук']
    }), rules, lexemes, 'курс на Кременчук');
    expect(built.classified.intent).toBe('threat');
    expect(built.classified.retraction).toBeUndefined();
    expect(built.classified.locations).toEqual([{ id: 'ua-city-kremenchuk', name: 'Кременчук', relationType: 'reported_direction' }]);
  });

  it('falls back to the rules’ geography when no model name resolves', () => {
    const rules = classifyMessage('Шахеди на Полтавщині.', lexemes);
    const built = classificationFromVerdict(verdict({ locations: ['Село Невідоме'] }), rules, lexemes, 'Шахеди на Полтавщині.');
    expect(built.resolvedLocations).toBe(0);
    expect(built.classified.locations.map((location) => location.id)).toEqual(['ua-53']);
  });

  it('carries the rules’ retrospective reading onto the model classification, as the grey band', () => {
    // Текст, який правила читають як переказ минулої ночі поряд зі словами про загрозу — саме
    // дефект v5, заради якого гейт існує. Без переносу класифікація моделі приходила в ingestion без
    // поля `retrospective`, і гейт не вмикався в режимі `codex` ЖОДНОГО разу.
    // Дослівно той різновид, який `src/domain/classifier.test.ts` пінить як сіру смугу: переказ
    // минулої ночі плюс слабке оперативне слово.
    const text = 'Цієї ночі БпЛА атакували Київ, і місто знову не спало. Увага киянам.';
    const rules = classifyMessage(text, lexemes);
    expect(rules.retrospective?.verdict).toBeTruthy();
    const built = classificationFromVerdict(verdict(), rules, lexemes, text);
    expect(built.classified.retrospective?.verdict).toBe('suspect');
    expect(built.classified.retrospective?.markers).toEqual(rules.retrospective?.markers);
  });

  it('adds no retrospective flag where the rules found none', () => {
    const rules = classifyMessage('Шахеди на Полтавщині.', lexemes);
    expect(rules.retrospective).toBeUndefined();
    expect(classificationFromVerdict(verdict(), rules, lexemes, 'Шахеди на Полтавщині.').classified.retrospective)
      .toBeUndefined();
  });
});

describe('classifyWithCodex', () => {
  const base = { lexemes, source: { name: 'eRadar', tier: 'B', official: false } };

  it('classifies with the model, reading timing and probability off the verdict', async () => {
    const rules = classifyMessage('Увечері очікується масований удар балістикою по Полтавщині.', lexemes);
    const chat = chatReturning(verdict({ threatType: 'ballistic_missile', timing: 'evening', probability: 0.6 }));
    const outcome = await classifyWithCodex({ message: message('Увечері очікується масований удар балістикою по Полтавщині.'), rules, ...base },
      { chat, now, loadPrevious: noPrevious, loadContexts: noContexts });
    expect(outcome.status).toBe('classified');
    if (outcome.status !== 'classified') return;
    expect(outcome.assessment.timing).toBe('evening');
    expect(outcome.assessment.probability).toBe(0.6);
    // Київський вечір 18.08: 18:00–23:59 = 15:00–20:59 UTC.
    expect(outcome.assessment.expectedFrom.toISOString()).toBe('2026-08-18T15:00:00.000Z');
    expect(outcome.assessment.expectedUntil.toISOString()).toBe('2026-08-18T20:59:00.000Z');
    expect(outcome.classified.threatType).toBe('ballistic_missile');
    expect(outcome.classified.locations[0]!.id).toBe('ua-53');
    // Що поїхало моделі: контексти, підказка правил, поточний час за Києвом.
    const request = chat.mock.calls[0]![0] as unknown as { surface: string; user: string; timeoutMs: number; json: boolean };
    expect(request.surface).toBe('classifier');
    expect(request.json).toBe(true);
    expect(request.timeoutMs).toBe(20_000);
    expect(request.user).toContain('rulesHint');
    expect(request.user).toContain('Полтавська область');
  });

  it('puts the location contexts before the message, most specific first', async () => {
    const rules = classifyMessage('Шахеди на Полтавщині.', lexemes);
    const chat = chatReturning(verdict());
    await classifyWithCodex({ message: message('Шахеди на Полтавщині.'), rules, ...base }, {
      chat, now, loadPrevious: noPrevious,
      loadContexts: async () => [{ locationId: 'ua-53', name: 'Полтавська область', text: '[2026-08-17 02:10] eRadar: «шахеди» → event_created', tokens: 20, truncated: false }]
    });
    const request = chat.mock.calls[0]![0] as unknown as { user: string; auditInput: { contextTokens: number } };
    expect(request.user.indexOf('### Контекст: Полтавська область')).toBeLessThan(request.user.indexOf('## Повідомлення для класифікації'));
    expect(request.auditInput.contextTokens).toBe(20);
  });

  it('hands the message back to the rules when the model fails, times out or answers prose', async () => {
    const rules = classifyMessage('Шахеди на Полтавщині.', lexemes);
    const input = { message: message('Шахеди на Полтавщині.'), rules, ...base };
    const failed = await classifyWithCodex(input, { chat: vi.fn(async () => ({ ok: false as const, reason: 'transport_error' as const, detail: 'TimeoutError: aborted', model: null, durationMs: 1 })), now, loadPrevious: noPrevious, loadContexts: noContexts });
    expect(failed).toMatchObject({ status: 'fallback', reason: 'fallback_timeout' });
    const prose = await classifyWithCodex(input, { chat: vi.fn(async () => ({ ok: true as const, content: 'Це не JSON', model: 'gpt-5.2', durationMs: 1 })), now, loadPrevious: noPrevious, loadContexts: noContexts });
    expect(prose).toMatchObject({ status: 'fallback', reason: 'fallback_unparsable' });
    const thrown = await classifyWithCodex(input, { chat: vi.fn(async () => { throw new Error('boom'); }), now, loadPrevious: noPrevious, loadContexts: noContexts });
    expect(thrown.status).toBe('fallback');
  });

  it('falls back below the confidence floor, and needs more confidence to suppress than to assert', async () => {
    const rules = classifyMessage('Шахеди на Полтавщині.', lexemes);
    const input = { message: message('Шахеди на Полтавщині.'), rules, ...base };
    const unsure = await classifyWithCodex(input, { chat: chatReturning(verdict({ confidence: 0.3 })), now, loadPrevious: noPrevious, loadContexts: noContexts });
    expect(unsure).toMatchObject({ status: 'fallback', reason: 'fallback_low_confidence' });
    // Правила бачать загрозу; модель каже «не загроза» з 0.6 — замало, щоб придушити попередження.
    const timid = await classifyWithCodex(input, { chat: chatReturning(verdict({ significant: false, confidence: 0.6, probability: null })), now, loadPrevious: noPrevious, loadContexts: noContexts });
    expect(timid).toMatchObject({ status: 'fallback', reason: 'fallback_low_confidence' });
    // З 0.9 — придушення: класифікація без наміру, правила вже не публікують.
    const sure = await classifyWithCodex(input, { chat: chatReturning(verdict({ significant: false, confidence: 0.9, probability: null })), now, loadPrevious: noPrevious, loadContexts: noContexts });
    expect(sure.status).toBe('suppressed');
    if (sure.status === 'suppressed') expect(sure.classified.intent).toBe('none');
  });

  it('resolves the model’s places through the catalogue and refuses an assertion with no place at all', async () => {
    const rules = classifyMessage('Щось летить.', lexemes);
    const outcome = await classifyWithCodex({ message: message('Щось летить.'), rules, ...base },
      { chat: chatReturning(verdict({ locations: ['Атлантида'] })), now, loadPrevious: noPrevious, loadContexts: noContexts });
    expect(outcome).toMatchObject({ status: 'fallback', reason: 'fallback_no_locations' });
  });

  it('spends the per-minute budget and the concurrency slots, and falls back rather than queueing', async () => {
    const rules = classifyMessage('Шахеди на Полтавщині.', lexemes);
    const input = { message: message('Шахеди на Полтавщині.'), rules, ...base };
    const chat = chatReturning(verdict());
    for (let index = 0; index < 3; index += 1) {
      expect((await classifyWithCodex(input, { chat, now, loadPrevious: noPrevious, loadContexts: noContexts })).status).toBe('classified');
    }
    expect(await classifyWithCodex(input, { chat, now, loadPrevious: noPrevious, loadContexts: noContexts })).toMatchObject({ status: 'fallback', reason: 'fallback_rate_limited' });
    expect(chat).toHaveBeenCalledTimes(3);

    resetCodexClassifier();
    const releases: Array<() => void> = [];
    const slow = vi.fn(() => new Promise<{ ok: true; content: string; model: string; durationMs: number }>((resolve) => {
      releases.push(() => resolve({ ok: true, content: JSON.stringify(verdict()), model: 'gpt-5.2', durationMs: 1 }));
    }));
    const first = classifyWithCodex(input, { chat: slow as never, now, loadPrevious: noPrevious, loadContexts: noContexts });
    const second = classifyWithCodex(input, { chat: slow as never, now, loadPrevious: noPrevious, loadContexts: noContexts });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const third = await classifyWithCodex(input, { chat: slow as never, now, loadPrevious: noPrevious, loadContexts: noContexts });
    expect(third).toMatchObject({ status: 'fallback', reason: 'fallback_busy' });
    for (const release of releases) release();
    const settled = await Promise.all([first, second]);
    expect(settled.map((outcome) => outcome.status)).toEqual(['classified', 'classified']);
  });

  // ----------------------------------------------------------------------------------------------
  // Стеля віку і резерв живого шляху
  // ----------------------------------------------------------------------------------------------

  describe('a message past the delivery-age ceiling', () => {
    const rules = () => classifyMessage('Шахеди на Полтавщині.', lexemes);
    /** Дві години після публікації: більше за типову годинну стелю, менше за будь-яке вікно очікування. */
    const late = () => new Date(PUBLISHED_AT.getTime() + 2 * 3_600_000);
    const booted = {
      concurrent: config.CODEX_PRIMARY_MAX_CONCURRENT,
      perMinute: config.CODEX_PRIMARY_MAX_PER_MINUTE
    };
    afterEach(() => {
      config.CODEX_PRIMARY_MAX_CONCURRENT = booted.concurrent;
      config.CODEX_PRIMARY_MAX_PER_MINUTE = booted.perMinute;
    });

    it('goes to the rules with its own outcome when taking a slot would eat the live reserve', async () => {
      // Два одночасні виклики — рівно резерв. Свіже повідомлення взяло б обидва; застаріле не бере
      // жодного, і саме це число оператор читає як «дозбір не заважає живому шляху».
      const chat = chatReturning(verdict());
      const outcome = await classifyWithCodex({ message: message('Шахеди на Полтавщині.'), rules: rules(), ...base },
        { chat, now: late, loadPrevious: noPrevious, loadContexts: noContexts });
      expect(outcome).toMatchObject({ status: 'fallback', reason: 'fallback_stale_deferred' });
      expect(chat).not.toHaveBeenCalled();
    });

    it('still reaches the model when the live path has budget to spare', async () => {
      // Застаріле повідомлення не є «не вартим моделі»: «увечері очікується», прочитане на годину
      // пізніше, публікується за власним вікном (`CONTEXT.md`), і жорсткий пропуск моделі втратив би
      // саме це попередження. Резерв прибирає голодування, а не можливість.
      config.CODEX_PRIMARY_MAX_CONCURRENT = 6;
      config.CODEX_PRIMARY_MAX_PER_MINUTE = 10;
      const chat = chatReturning(verdict({ timing: 'evening', probability: 0.6 }));
      const outcome = await classifyWithCodex({ message: message('Шахеди на Полтавщині.'), rules: rules(), ...base },
        { chat, now: late, loadPrevious: noPrevious, loadContexts: noContexts });
      expect(outcome.status).toBe('classified');
      expect(chat).toHaveBeenCalledTimes(1);
    });

    it('leaves the live half of the per-minute budget alone however many stale messages arrive', async () => {
      config.CODEX_PRIMARY_MAX_CONCURRENT = 6;
      config.CODEX_PRIMARY_MAX_PER_MINUTE = 4;
      const chat = chatReturning(verdict());
      const input = { message: message('Шахеди на Полтавщині.'), rules: rules(), ...base };
      for (let index = 0; index < 4; index += 1) {
        await classifyWithCodex(input, { chat, now: late, loadPrevious: noPrevious, loadContexts: noContexts });
      }
      // Половина бюджету — і ні викликом більше, хай скільки замітання приносить.
      expect(chat).toHaveBeenCalledTimes(2);
      // А живе повідомлення в ту саму хвилину ще має що витратити.
      const live = await classifyWithCodex(input, { chat, now, loadPrevious: noPrevious, loadContexts: noContexts });
      expect(live.status).toBe('classified');
    });
  });
});

describe('contextLineForVerdict', () => {
  it('names the source, the excerpt, the decision and both verdicts in one line', () => {
    const rules = classifyMessage('Шахеди на Полтавщині.', lexemes);
    const line = contextLineForVerdict({ name: 'eRadar' }, 'osint-eradar', 'Шахеди на Полтавщині.', {
      model: 'gpt-5.2', classifierVersion: 'codex-primary-v1', confidence: 0.85, timing: 'now', probability: 0.7,
      expectedFrom: new Date(), expectedUntil: new Date(), note: 'Категорично.', verdict: verdict()
    }, rules, 'event_created', (text) => text);
    expect(line).toContain('eRadar: «Шахеди на Полтавщині.» → event_created');
    expect(line).toContain('правила: threat/uav (Полтавська область)');
    expect(line).toContain('модель: uav/asserted, now, p=0.70, впевненість 0.85 (Полтавщина) — Категорично.');
  });
});
