import { describe, expect, it, vi } from 'vitest';
import { rejectionFor, summariseMovement, type MovementFact } from './movement-summary.js';

const fact = (sourceName: string, locationName: string, text: string): MovementFact =>
  ({ sourceName, locationName, text, observedAt: '2026-08-15T12:00:00.000Z' });

const FACTS: MovementFact[] = [
  fact('Повітряна тривога', 'Миколаїв', 'БпЛА курсом на Миколаїв з півдня'),
  fact('Моніторинг Півдня', 'Херсон', 'Група БпЛА пройшла Херсон у напрямку Миколаєва')
];

const settings = (movement_summary: boolean) => async () => ({
  model: 'gpt-5.6-luna' as string | null,
  effort: 'medium' as const,
  serviceTier: 'priority' as const,
  features: {
    narrative: false, digest: false, attacks: false, shadow: false, analytical_threats: false,
    analytical_enrichment: false, retrospective_gate: false, tactics: false, attack_research: false,
    movement_summary
  },
  updatedAt: null,
  effectiveModel: 'gpt-5.6-luna' as string | null,
  modelSource: 'stored' as const
});

const reply = (payload: unknown) => async () => ({
  ok: true as const, content: JSON.stringify(payload), model: 'gpt-5.6-luna', durationMs: 12
});

describe('rejectionFor', () => {
  it('accepts a summary that stays inside the facts and names a real channel', () => {
    expect(rejectionFor({
      summary: 'БпЛА пройшли Херсон і рухаються на Миколаїв.',
      sources: ['Повітряна тривога']
    }, FACTS)).toBeNull();
  });

  it('refuses a summary that cites no channel we gave it', () => {
    // Джерела — не оформлення, а умова допуску: абзац без посилання неможливо перевірити, і читач
    // не знає, що з написаного є в джерелі, а що додала модель.
    expect(rejectionFor({
      summary: 'БпЛА рухаються на Миколаїв.',
      sources: ['Якийсь канал, якого ми не передавали']
    }, FACTS)).toBe('no_known_source');
  });

  it('refuses a place no source named', () => {
    // Дописане сусіднє місто — це загроза, про яку не повідомляв ніхто.
    expect(rejectionFor({
      summary: 'БпЛА пройшли Херсон і рухаються на Одесу.',
      sources: ['Повітряна тривога']
    }, FACTS)).toBe('unknown_place:Одесу');
  });

  it('refuses forecasting language even when every place is real', () => {
    const verdict = rejectionFor({
      summary: 'БпЛА з Херсона, ймовірно, буде удар по Миколаєву.',
      sources: ['Повітряна тривога']
    }, FACTS);
    expect(verdict).toMatch(/^forecast:/);
  });

  it('refuses a summary longer than the message it is meant to shorten', () => {
    expect(rejectionFor({
      summary: `Херсон ${'та Миколаїв '.repeat(40)}`,
      sources: ['Повітряна тривога']
    }, FACTS)).toBe('too_long');
  });

  it('allows a word that appears in the source text even if it is not a catalogue place', () => {
    // «Група» з великої літери — не топонім. Груба евристика має поступатися вихідному тексту,
    // інакше вона відхиляла б справні перекази.
    expect(rejectionFor({
      summary: 'Група БпЛА пройшла Херсон у напрямку Миколаєва.',
      sources: ['Моніторинг Півдня']
    }, FACTS)).toBeNull();
  });
});

describe('summariseMovement', () => {
  it('says nothing at all while the feature is off', async () => {
    const chat = vi.fn();
    expect(await summariseMovement('e1', {
      settings: settings(false), chat: chat as never, facts: async () => FACTS
    })).toBeNull();
    // І не витрачає виклику: вимкнений перемикач має коштувати нуль, а не запит із відкинутою відповіддю.
    expect(chat).not.toHaveBeenCalled();
  });

  it('does not summarise a single channel', async () => {
    const chat = vi.fn();
    expect(await summariseMovement('e1', {
      settings: settings(true), chat: chat as never, facts: async () => [FACTS[0]!]
    })).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });

  it('returns the paragraph with only the channels it actually recognised', async () => {
    const result = await summariseMovement('e1', {
      settings: settings(true), facts: async () => FACTS,
      chat: reply({
        summary: 'БпЛА пройшли Херсон і рухаються на Миколаїв.',
        sources: ['Повітряна тривога', 'Вигаданий канал']
      }) as never
    });
    // Вигадане джерело не потрапляє в перелік: одна невпізнана назва зробила б неперевірними всі.
    expect(result).toEqual({
      summary: 'БпЛА пройшли Херсон і рухаються на Миколаїв.',
      sources: ['Повітряна тривога']
    });
  });

  it('drops a rejected paragraph instead of publishing it unsigned', async () => {
    expect(await summariseMovement('e1', {
      settings: settings(true), facts: async () => FACTS,
      chat: reply({ summary: 'Ймовірно, буде удар по Миколаєву.', sources: ['Повітряна тривога'] }) as never
    })).toBeNull();
  });

  it('survives a model that answers with something other than JSON', async () => {
    expect(await summariseMovement('e1', {
      settings: settings(true), facts: async () => FACTS,
      chat: (async () => ({ ok: true as const, content: 'не json', model: 'm', durationMs: 1 })) as never
    })).toBeNull();
  });

  it('never throws out of the notification path', async () => {
    // Виняток тут коштував би попередження, а не абзацу.
    await expect(summariseMovement('e1', {
      settings: settings(true),
      facts: async () => { throw new Error('база лягла'); }
    })).resolves.toBeNull();
  });
});
