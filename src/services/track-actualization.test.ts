import { describe, expect, it } from 'vitest';
import {
  actualizationFacts, validateActualization, type ActualizationInput
} from './track-actualization.js';

/**
 * Відповідь швидкої моделі проти того, що їй показали, — без бази й без моделі.
 *
 * Тут пінять єдине, що дає цій поверхні право на публічну карту: модель посилається лише на місця,
 * які назвали повідомлення події; курс — лише туди, куди його назвало джерело; «поточний відрізок»
 * починається з повідомлення, яке справді є у вході; публічний `summary` не вигадує чисел і не
 * прогнозує. Поріг упевненості сюди не належить — його застосовує карта.
 */

const input: ActualizationInput = {
  eventId: '00000000-0000-4000-8000-000000000001',
  threatType: 'uav',
  messages: [
    {
      publishedAt: new Date('2026-09-22T22:31:05.000Z'),
      channel: 'eRadar',
      text: 'Шахеди повз Бровари на Бориспіль.',
      places: [
        { id: 'ua-city-brovary', name: 'Бровари', type: 'city', relation: null, role: 'retracted' },
        { id: 'ua-city-boryspil', name: 'Бориспіль', type: 'city', relation: 'reported_direction', role: 'asserted' }
      ]
    },
    {
      publishedAt: new Date('2026-09-22T22:38:41.000Z'),
      channel: 'Моніторинг',
      text: '3 шахеди кружляють над Борисполем.',
      places: [{ id: 'ua-city-boryspil', name: 'Бориспіль', type: 'city', relation: 'mentioned', role: 'asserted' }]
    }
  ]
};

const reply = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  status: 'loitering', headPlaceId: 'ua-city-boryspil', headingPlaceId: null, originPlaceId: 'ua-city-brovary',
  loiterPlaceId: 'ua-city-boryspil', currentSince: null, summary: 'Шахеди з боку Броварів кружляють над Борисполем.',
  confidence: 0.8, ...overrides
});

describe('validateActualization', () => {
  it('refuses any place id the messages did not name', () => {
    expect(validateActualization(reply({ headPlaceId: 'ua-city-kyiv' }), input))
      .toEqual({ ok: false, reason: 'unknown_place:headPlaceId:ua-city-kyiv' });
    expect(validateActualization(reply({ originPlaceId: 'ua-32' }), input))
      .toEqual({ ok: false, reason: 'unknown_place:originPlaceId:ua-32' });
  });

  it('accepts a heading only where a source named a direction', () => {
    expect(validateActualization(reply({ status: 'moving', headingPlaceId: 'ua-city-boryspil' }), input).ok).toBe(true);
    // Бровари є у вході, але як пройдене місце: стрілка туди була б рухом, якого ніхто не повідомляв.
    expect(validateActualization(reply({ status: 'moving', headingPlaceId: 'ua-city-brovary' }), input))
      .toEqual({ ok: false, reason: 'heading_not_named_destination:ua-city-brovary' });
  });

  it('stores a low-confidence answer as it is: the floor belongs to the map', () => {
    const check = validateActualization(reply({ confidence: 0.2 }), input);
    expect(check).toMatchObject({ ok: true, value: { confidence: 0.2, status: 'loitering' } });
  });

  it('maps currentSince back to the exact publication it names, and refuses one that is not in the input', () => {
    const facts = actualizationFacts(input, new Date('2026-09-22T22:40:00.000Z'));
    // Модель бачить київський час із поясом і має повернути одне з цих значень дослівно.
    expect(facts.messages.map((message) => message.publishedAt))
      .toEqual(['2026-09-23T01:31:05+03:00', '2026-09-23T01:38:41+03:00']);
    const check = validateActualization(reply({ currentSince: facts.messages[1]!.publishedAt }), input);
    expect(check.ok && check.value.currentSince).toEqual(input.messages[1]!.publishedAt);
    expect(validateActualization(reply({ currentSince: '2026-09-23T01:35:00+03:00' }), input))
      .toEqual({ ok: false, reason: 'current_since_not_in_input' });
  });

  it('keeps the public summary to what the sources said: no invented numbers, no forecasts', () => {
    expect(validateActualization(reply({ summary: '3 шахеди кружляють над Борисполем.' }), input).ok).toBe(true);
    expect(validateActualization(reply({ summary: '7 шахедів кружляють над Борисполем.' }), input))
      .toEqual({ ok: false, reason: 'ungrounded_number:7' });
    expect(validateActualization(reply({ summary: 'Прогноз: далі на Київ.' }), input))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/^forecast_lexeme:/u) });
  });

  it('refuses prose and a status outside the vocabulary', () => {
    expect(validateActualization('Ціль над Борисполем.', input)).toEqual({ ok: false, reason: 'unparsable' });
    expect(validateActualization(reply({ status: 'arrived' }), input)).toMatchObject({ ok: false, reason: 'schema:status' });
  });
});
