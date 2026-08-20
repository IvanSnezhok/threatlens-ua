import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { ATTACK_DEBRIEF_DISCLAIMER, attackDebriefLines, debriefWorthShowing, type AttackDebrief } from './attack-debrief.js';

/**
 * Текст розбору — те місце, де межа «рахуємо повідомлення, а не засоби» або тримається, або
 * ламається одним словом. Тести нижче перевіряють саме формулювання, бо саме воно тут і є межею.
 */
const debrief = (over: Partial<AttackDebrief> = {}): AttackDebrief => ({
  alertPeriodId: '00000000-0000-4000-8000-000000000001',
  locationId: 'ua-32',
  locationName: 'Київська область',
  startedAt: new Date('2026-08-19T23:10:00.000Z'),
  endedAt: new Date('2026-08-20T00:42:00.000Z'),
  durationMinutes: 92,
  classes: [{ label: 'ударні БпЛА', messages: 11 }, { label: 'балістика', messages: 3 }],
  reported: [],
  outcomes: [],
  messages: 14,
  ...over
});

describe('текст розбору атаки', () => {
  it('починає з тривалості й називає числа повідомленнями', () => {
    const lines = attackDebriefLines(debrief());
    expect(lines[0]).toBe('Тривога тривала 1 година 32 хв.');
    expect(lines[1]).toBe('За цей час канали писали про: ударні БпЛА — 11 повідомлень; балістика — 3 повідомлення.');
    expect(lines.join(' ')).not.toMatch(/\d+\s+цілей/);
  });

  it('мовчить про кількість цілей, коли джерела її не називали', () => {
    expect(attackDebriefLines(debrief()).some((line) => line.includes('Кількість'))).toBe(false);
  });

  it('називає кількість цілей ЛИШЕ як цитату джерел, зі стелею і без суми', () => {
    const lines = attackDebriefLines(debrief({ reported: [{ label: 'ударні БпЛА', count: 10 }] }));
    const line = lines.find((entry) => entry.includes('Кількість'))!;
    expect(line).toContain('яку називали самі джерела');
    expect(line).toContain('до 10');
    expect(line).toContain('найбільше, назване в одному повідомленні');
    expect(line).toContain('не додаються');
  });

  it('говорить про наслідки словами джерел, а не як про встановлений факт', () => {
    const lines = attackDebriefLines(debrief({
      outcomes: [
        { outcome: 'explosion', phrase: 'повідомляли про вибухи', places: ['Бровари', 'Київ'] },
        { outcome: 'air_defence', phrase: 'повідомляли про роботу ППО', places: ['Київ'] }
      ]
    }));
    expect(lines).toContain('Повідомляли про вибухи: Бровари, Київ.');
    expect(lines).toContain('Повідомляли про роботу ППО: Київ.');
    // Жодного речення, яке стверджувало б влучання від нашого імені.
    expect(lines.join(' ')).not.toContain('було влучання');
  });

  it('стоїть у минулому часі — розбір не говорить про те, що буде', () => {
    const text = attackDebriefLines(debrief({
      reported: [{ label: 'цілі', count: 6 }],
      outcomes: [{ outcome: 'downed', phrase: 'повідомляли про збиття', places: ['Київ'] }]
    })).join(' ');
    for (const future of ['очікується', 'буде', 'ймовірно', 'прогноз']) expect(text).not.toContain(future);
  });

  it('називає тривалість людською мовою в обидва боки від години', () => {
    expect(attackDebriefLines(debrief({ durationMinutes: 1 }))[0]).toBe('Тривога тривала 1 хвилина.');
    expect(attackDebriefLines(debrief({ durationMinutes: 44 }))[0]).toBe('Тривога тривала 44 хвилини.');
    expect(attackDebriefLines(debrief({ durationMinutes: 120 }))[0]).toBe('Тривога тривала 2 години.');
    expect(attackDebriefLines(debrief({ durationMinutes: 305 }))[0]).toBe('Тривога тривала 5 годин 5 хв.');
  });

  it('застереження називає джерело чисел і межу того, що ми знаємо', () => {
    expect(ATTACK_DEBRIEF_DISCLAIMER).toContain('не офіційні дані');
    expect(ATTACK_DEBRIEF_DISCLAIMER).toContain('не рахуємо засобів');
  });
});

describe('поріг показу', () => {
  const booted = config.ATTACK_DEBRIEF_MIN_MESSAGES;
  afterEach(() => { config.ATTACK_DEBRIEF_MIN_MESSAGES = booted; });

  it('мовчить про тривогу, за час якої каналів майже не було чути', () => {
    config.ATTACK_DEBRIEF_MIN_MESSAGES = 3;
    expect(debriefWorthShowing(debrief({ messages: 2 }))).toBe(false);
    expect(debriefWorthShowing(debrief({ messages: 3 }))).toBe(true);
    expect(debriefWorthShowing(null)).toBe(false);
  });
});
