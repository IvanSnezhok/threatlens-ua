import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const lexemes = [
  { id: 'ua-80', name: 'Київ', aliases: ['києва', 'києві'] },
  { id: 'ua-53', name: 'Полтавська область', aliases: ['полтавщина', 'полтавщині'] },
  { id: 'ua-city-kremenchuk', name: 'Кременчук', aliases: ['кременчука', 'кременчуці'] }
];

function message(text: string): NormalizedMessage {
  return { sourceId: 'osint-eradar', externalId: 'm-1', publishedAt: new Date('2026-08-18T12:00:00Z'), text, rawPayload: {} };
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

  it('falls back to the rules’ geography when no model name resolves', () => {
    const rules = classifyMessage('Шахеди на Полтавщині.', lexemes);
    const built = classificationFromVerdict(verdict({ locations: ['Село Невідоме'] }), rules, lexemes, 'Шахеди на Полтавщині.');
    expect(built.resolvedLocations).toBe(0);
    expect(built.classified.locations.map((location) => location.id)).toEqual(['ua-53']);
  });
});

describe('classifyWithCodex', () => {
  const base = { lexemes, source: { name: 'eRadar', tier: 'B', official: false } };

  it('classifies with the model, reading timing and probability off the verdict', async () => {
    const rules = classifyMessage('Увечері очікується масований удар балістикою по Полтавщині.', lexemes);
    const chat = chatReturning(verdict({ threatType: 'ballistic_missile', timing: 'evening', probability: 0.6 }));
    const outcome = await classifyWithCodex({ message: message('Увечері очікується масований удар балістикою по Полтавщині.'), rules, ...base },
      { chat, loadPrevious: noPrevious, loadContexts: noContexts });
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
      chat, loadPrevious: noPrevious,
      loadContexts: async () => [{ locationId: 'ua-53', name: 'Полтавська область', text: '[2026-08-17 02:10] eRadar: «шахеди» → event_created', tokens: 20, truncated: false }]
    });
    const request = chat.mock.calls[0]![0] as unknown as { user: string; auditInput: { contextTokens: number } };
    expect(request.user.indexOf('### Контекст: Полтавська область')).toBeLessThan(request.user.indexOf('## Повідомлення для класифікації'));
    expect(request.auditInput.contextTokens).toBe(20);
  });

  it('hands the message back to the rules when the model fails, times out or answers prose', async () => {
    const rules = classifyMessage('Шахеди на Полтавщині.', lexemes);
    const input = { message: message('Шахеди на Полтавщині.'), rules, ...base };
    const failed = await classifyWithCodex(input, { chat: vi.fn(async () => ({ ok: false as const, reason: 'transport_error' as const, detail: 'TimeoutError: aborted', model: null, durationMs: 1 })), loadPrevious: noPrevious, loadContexts: noContexts });
    expect(failed).toMatchObject({ status: 'fallback', reason: 'fallback_timeout' });
    const prose = await classifyWithCodex(input, { chat: vi.fn(async () => ({ ok: true as const, content: 'Це не JSON', model: 'gpt-5.2', durationMs: 1 })), loadPrevious: noPrevious, loadContexts: noContexts });
    expect(prose).toMatchObject({ status: 'fallback', reason: 'fallback_unparsable' });
    const thrown = await classifyWithCodex(input, { chat: vi.fn(async () => { throw new Error('boom'); }), loadPrevious: noPrevious, loadContexts: noContexts });
    expect(thrown.status).toBe('fallback');
  });

  it('falls back below the confidence floor, and needs more confidence to suppress than to assert', async () => {
    const rules = classifyMessage('Шахеди на Полтавщині.', lexemes);
    const input = { message: message('Шахеди на Полтавщині.'), rules, ...base };
    const unsure = await classifyWithCodex(input, { chat: chatReturning(verdict({ confidence: 0.3 })), loadPrevious: noPrevious, loadContexts: noContexts });
    expect(unsure).toMatchObject({ status: 'fallback', reason: 'fallback_low_confidence' });
    // Правила бачать загрозу; модель каже «не загроза» з 0.6 — замало, щоб придушити попередження.
    const timid = await classifyWithCodex(input, { chat: chatReturning(verdict({ significant: false, confidence: 0.6, probability: null })), loadPrevious: noPrevious, loadContexts: noContexts });
    expect(timid).toMatchObject({ status: 'fallback', reason: 'fallback_low_confidence' });
    // З 0.9 — придушення: класифікація без наміру, правила вже не публікують.
    const sure = await classifyWithCodex(input, { chat: chatReturning(verdict({ significant: false, confidence: 0.9, probability: null })), loadPrevious: noPrevious, loadContexts: noContexts });
    expect(sure.status).toBe('suppressed');
    if (sure.status === 'suppressed') expect(sure.classified.intent).toBe('none');
  });

  it('resolves the model’s places through the catalogue and refuses an assertion with no place at all', async () => {
    const rules = classifyMessage('Щось летить.', lexemes);
    const outcome = await classifyWithCodex({ message: message('Щось летить.'), rules, ...base },
      { chat: chatReturning(verdict({ locations: ['Атлантида'] })), loadPrevious: noPrevious, loadContexts: noContexts });
    expect(outcome).toMatchObject({ status: 'fallback', reason: 'fallback_no_locations' });
  });

  it('spends the per-minute budget and the concurrency slots, and falls back rather than queueing', async () => {
    const rules = classifyMessage('Шахеди на Полтавщині.', lexemes);
    const input = { message: message('Шахеди на Полтавщині.'), rules, ...base };
    const chat = chatReturning(verdict());
    for (let index = 0; index < 3; index += 1) {
      expect((await classifyWithCodex(input, { chat, loadPrevious: noPrevious, loadContexts: noContexts })).status).toBe('classified');
    }
    expect(await classifyWithCodex(input, { chat, loadPrevious: noPrevious, loadContexts: noContexts })).toMatchObject({ status: 'fallback', reason: 'fallback_rate_limited' });
    expect(chat).toHaveBeenCalledTimes(3);

    resetCodexClassifier();
    const releases: Array<() => void> = [];
    const slow = vi.fn(() => new Promise<{ ok: true; content: string; model: string; durationMs: number }>((resolve) => {
      releases.push(() => resolve({ ok: true, content: JSON.stringify(verdict()), model: 'gpt-5.2', durationMs: 1 }));
    }));
    const first = classifyWithCodex(input, { chat: slow as never, loadPrevious: noPrevious, loadContexts: noContexts });
    const second = classifyWithCodex(input, { chat: slow as never, loadPrevious: noPrevious, loadContexts: noContexts });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const third = await classifyWithCodex(input, { chat: slow as never, loadPrevious: noPrevious, loadContexts: noContexts });
    expect(third).toMatchObject({ status: 'fallback', reason: 'fallback_busy' });
    for (const release of releases) release();
    const settled = await Promise.all([first, second]);
    expect(settled.map((outcome) => outcome.status)).toEqual(['classified', 'classified']);
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
