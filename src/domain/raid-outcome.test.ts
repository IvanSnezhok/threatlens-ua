import { describe, expect, it } from 'vitest';
import { raidOutcomePhrase, raidOutcomes } from './raid-outcome.js';

describe('маркери наслідків у повідомленні джерела', () => {
  it('розрізняє вибух, роботу ППО, збиття і уламки', () => {
    expect(raidOutcomes('Вибухи в місті')).toEqual(['explosion']);
    expect(raidOutcomes('Працює ППО по цілях')).toEqual(['air_defence']);
    expect(raidOutcomes('Ціль збито над областю')).toEqual(['downed']);
    expect(raidOutcomes('Падіння уламків у приватному секторі')).toEqual(['debris']);
  });

  it('повертає всі маркери, які несе один пост', () => {
    expect(raidOutcomes('Вибухи в місті — робота ППО')).toEqual(['explosion', 'air_defence']);
  });

  it('мовчить, коли про наслідки не сказано нічого', () => {
    expect(raidOutcomes('Шахед курсом на Бровари')).toEqual([]);
  });

  it('говорить від імені джерел, а не від нашого', () => {
    // Уся межа цього модуля вміщається в одне слово: «повідомляли». Формулювання, яке стверджувало б
    // влучання, зробило б із чужого посту наш висновок про те, чого ми не встановлювали.
    for (const outcome of ['explosion', 'air_defence', 'downed', 'debris'] as const) {
      expect(raidOutcomePhrase(outcome)).toContain('повідомляли');
    }
  });
});
