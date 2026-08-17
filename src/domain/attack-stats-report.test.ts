import { describe, expect, it } from 'vitest';
import {
  ATTACK_STATS_DISCLAIMER, attackStatsDigestLines, buildAttackStatsPrompt, composeAttackStatsSummary,
  extractJsonBlock, forecastLevel, parseAttackStatsReply, recomputePoisson, regionPromptForms,
  type AttackStatsTask
} from './attack-stats-report.js';

/**
 * Чиста частина статистики ударів: промт, розбір, перерахунок Пуассона, зведення.
 *
 * Жодної бази й жодної мережі — усе, що тут перевіряється, читач може повторити на папері з тими
 * самими числами, і саме це є властивістю, яку тести пінять: числа на сторінці не є словом моделі.
 */

const TASK: AttackStatsTask = {
  regionId: 'ua-80', regionName: 'Київ',
  periodFrom: '2026-07-01', periodTo: '2026-08-16',
  forecastFrom: '2026-08-17', forecastTo: '2026-08-31',
  lastEpisodes: 15, today: '2026-08-17'
};

const CHARTS = {
  region: 'Київ',
  period: { from: '2026-07-01', to: '2026-08-16' },
  forecast_period: { from: '2026-08-17', to: '2026-08-31' },
  episodes: [
    { date: '2026-07-02', start: '01:40', end: '05:10', weapons: ['ballistic', 'uav'], combined: true, sources: ['https://suspilne.media/a', 'https://t.me/kpszsu/1'], note: '' },
    { date: '2026-07-04', start: '23:30', end: '02:00', weapons: ['uav'], combined: false, sources: ['https://www.ukrinform.ua/b'] },
    { date: '2026-07-10', start: '03:15', end: null, weapons: ['Крилаті ракети'], combined: false, sources: ['javascript:alert(1)', 'https://reuters.com/c'] },
    { date: '2026-06-30', start: '02:00', end: null, weapons: ['uav'], combined: false, sources: [] }
  ],
  calendar: [
    { date: '2026-07-02', attack: true }, { date: '2026-07-03', attack: false }, { date: '2026-07-04', attack: true },
    { date: '2026-07-10', attack: true }, { date: '2026-08-20', attack: true }
  ],
  hourly: [{ hour: 1, count: 1 }, { hour: 23, count: 1 }, { hour: 3, count: 1 }],
  weapons: { ballistic: 0.34, cruise: 0.33, uav: 0.33 },
  metrics: [
    { label: 'Липень', from: '2026-07-01', to: '2026-07-31', attack_days: 2, night_share: 0.5, ballistic_share: 0.5, intervals_days: [2, 6], mean_interval_days: 4, min_interval_days: 2, max_interval_days: 6, tempo_per_30_days: 1.9 },
    { label: 'Серпень', from: '2026-08-01', to: '2026-08-16', attack_days: 1, night_share: 1, ballistic_share: 0, intervals_days: [], tempo_per_30_days: 1.9 }
  ],
  intervals_days: [2, 6, 3, 1, 4, 2, 3, 5, 2, 1, 3, 2, 4, 2],
  lambda_per_day: 0.35,
  expected_attacks: 5.25,
  scenarios: { low: 3, base: 5.25, high: 7.5 },
  forecast: [
    { date: '2026-08-17', p: 0.3, level: 'medium' }, { date: '2026-08-18', p: 0.29, level: 'low' },
    { date: '2026-08-19', p: 0.61, level: 'medium' }, { date: '2026-09-05', p: 0.5, level: 'medium' }
  ],
  conclusions: ['Перше.', 'Друге.', ' ', 'Третє.'],
  assumptions: ['Пуассонівський процес без пам’яті.']
};

function reply(charts: unknown = CHARTS): string {
  return [
    '## КРОК 1. Таблиця епізодів',
    '| Дата | Час | Засоби | Комбінована | Джерела | Примітки |',
    '|---|---|---|---|---|---|',
    '| 02.07 | 01:40–05:10 | балістика + БпЛА | так | … | |',
    '',
    'Приклад форми з завдання (не дані):',
    '```json',
    '{"forecast": [{"date":"2026-01-01","p":0.99}], "example": true}',
    '```',
    '',
    '## КРОК 4. Дані для графіків',
    '```json',
    JSON.stringify(charts, null, 2),
    '```',
    '',
    `Дисклеймер: ${ATTACK_STATS_DISCLAIMER}`
  ].join('\n');
}

describe('the prompt', () => {
  it('is the owner’s template with the region, the period, the horizon and N filled in', () => {
    const prompt = buildAttackStatsPrompt(TASK);
    expect(prompt).toContain('по місту Київ за період 01.07.2026 — 16.08.2026');
    expect(prompt).toContain('прогноз на 17–31.08.2026');
    expect(prompt).toContain('останніми 15 епізодами');
    expect(prompt).toContain('Київської міської військової адміністрації (КМВА) та КМДА');
    expect(prompt).toContain('лише атаки безпосередньо по м. Київ');
    expect(prompt).toContain('Сьогодні 17.08.2026');
    // Автоматичний режим: без зупинки на підтвердження — інакше запуск чекав би людину, якої нема.
    expect(prompt).toContain('не зупиняйся для підтвердження');
    // Дисклеймер їде в промт дослівно, щоб модель повторила саме його.
    expect(prompt).toContain(ATTACK_STATS_DISCLAIMER);
    // Формат JSON-блоку — з тими самими ключами, що їх читає парсер.
    for (const key of ['"calendar"', '"hourly"', '"weapons"', '"intervals_days"', '"forecast"', '"episodes"', '"conclusions"']) {
      expect(prompt).toContain(key);
    }
  });

  it('declines an oblast name into the scope and the authority, and rewrites the inclusion rule', () => {
    const forms = regionPromptForms('ua-53', 'Полтавська область');
    expect(forms).toEqual({
      name: 'Полтавська область', scope: 'Полтавській області', kind: 'oblast',
      authority: 'Полтавської обласної військової адміністрації (ОВА)'
    });
    expect(regionPromptForms('ua-23', 'Запорізька область').scope).toBe('Запорізькій області');
    expect(regionPromptForms('ua-14', 'Донецька область').authority).toContain('Донецької обласної');
    const prompt = buildAttackStatsPrompt({ ...TASK, regionId: 'ua-53', regionName: 'Полтавська область' });
    expect(prompt).toContain('по Полтавській області за період');
    expect(prompt).toContain('атаки по території Полтавській області');
    expect(prompt).not.toContain('м. Київ');
  });
});

describe('extracting the JSON block', () => {
  it('takes the LAST fenced block that carries a forecast, not the example the prompt showed', () => {
    const block = extractJsonBlock(reply()) as { example?: boolean; region?: string };
    expect(block.example).toBeUndefined();
    expect(block.region).toBe('Київ');
  });

  it('falls back to the widest object when the model forgot the fences', () => {
    const text = `Ось дані: ${JSON.stringify({ forecast: [{ date: '2026-08-17', p: 0.4 }] })} — кінець.`;
    expect(extractJsonBlock(text)).toEqual({ forecast: [{ date: '2026-08-17', p: 0.4 }] });
  });

  it('gives null, not an exception, for prose without any object', () => {
    expect(extractJsonBlock('Джерел за цей період не знайдено.')).toBeNull();
  });
});

describe('recomputing the Poisson rate', () => {
  it('derives λ, p, the expectation and the ±σ scenarios from the intervals alone', () => {
    const estimate = recomputePoisson([2, 6, 3, 1], 15)!;
    // mean 3 → λ = 1/3 → p = 1 − e^(−1/3)
    expect(estimate.meanIntervalDays).toBe(3);
    expect(estimate.lambdaPerDay).toBeCloseTo(0.3333, 4);
    expect(estimate.pDaily).toBeCloseTo(1 - Math.exp(-1 / 3), 4);
    expect(estimate.expectedAttacks).toBe(5);
    expect(estimate.scenarios.base).toBe(5);
    expect(estimate.scenarios.low).toBeCloseTo(5 - Math.sqrt(5), 2);
    expect(estimate.scenarios.high).toBeCloseTo(5 + Math.sqrt(5), 2);
    expect(estimate.minIntervalDays).toBe(1);
    expect(estimate.maxIntervalDays).toBe(6);
  });

  it('refuses to invent a rate from nothing', () => {
    expect(recomputePoisson([], 15)).toBeNull();
    expect(recomputePoisson([0, 0], 15)).toBeNull();
    expect(recomputePoisson([-1, Number.NaN], 15)).toBeNull();
  });

  it('never goes below zero attacks in the low scenario', () => {
    expect(recomputePoisson([30], 3)!.scenarios.low).toBe(0);
  });

  it('labels probabilities by the thresholds the task fixed', () => {
    expect(forecastLevel(0.6)).toBe('high');
    expect(forecastLevel(0.599)).toBe('medium');
    expect(forecastLevel(0.3)).toBe('medium');
    expect(forecastLevel(0.299)).toBe('low');
  });
});

describe('composing the summary', () => {
  const parsed = parseAttackStatsReply(reply(), TASK);
  const summary = parsed.summary!;

  it('parses a well-formed reply into a passed summary', () => {
    expect(parsed.rejectionReason).toBeNull();
    expect(summary.verification).toBe('passed');
    expect(summary.region).toEqual({ id: 'ua-80', name: 'Київ' });
    expect(summary.period).toEqual({ from: '2026-07-01', to: '2026-08-16', days: 47 });
    expect(summary.forecastPeriod).toEqual({ from: '2026-08-17', to: '2026-08-31', days: 15 });
    expect(summary.disclaimer).toBe(ATTACK_STATS_DISCLAIMER);
  });

  it('keeps only episodes and calendar days inside the period, and only http(s) sources', () => {
    expect(summary.episodes.map((episode) => episode.date)).toEqual(['2026-07-02', '2026-07-04', '2026-07-10']);
    expect(summary.episodes[0]!.weapons).toEqual(['ballistic', 'uav']);
    // Українська назва класу з тексту нормалізується до словника; невідома — відкидається.
    expect(summary.episodes[2]!.weapons).toEqual(['cruise']);
    expect(summary.episodes[2]!.sources).toEqual(['https://reuters.com/c']);
    expect(summary.calendar.map((day) => day.date)).not.toContain('2026-08-20');
    // Дні з атаками — з календаря ПЛЮС епізоди, яких календар не назвав.
    expect(summary.attackDays).toBe(3);
  });

  it('recomputes λ and p from the model’s own intervals and keeps the model’s numbers beside them', () => {
    expect(summary.poisson!.meanIntervalDays).toBeCloseTo(40 / 14, 3);
    expect(summary.poisson!.lambdaPerDay).toBeCloseTo(0.35, 2);
    expect(summary.model.lambdaPerDay).toBe(0.35);
    expect(summary.model.expectedAttacks).toBe(5.25);
    expect(summary.model.pMedian).toBeCloseTo(0.3, 3);
  });

  it('relabels every forecast day from its p and drops days outside the horizon', () => {
    expect(summary.forecast.map((day) => [day.date, day.level])).toEqual([
      ['2026-08-17', 'medium'], ['2026-08-18', 'low'], ['2026-08-19', 'high']
    ]);
    expect(summary.tonight).toEqual({ date: '2026-08-17', p: 0.3, level: 'medium' });
    expect(summary.issues).toContain('level_relabelled');
  });

  it('weights the night and ballistic shares by attack days across the sub-periods', () => {
    // (0.5·2 + 1·1) / 3 and (0.5·2 + 0·1) / 3
    expect(summary.nightShare).toBeCloseTo(0.667, 3);
    expect(summary.ballisticShare).toBeCloseTo(0.333, 3);
    expect(summary.hourly[1]).toBe(1);
    expect(summary.hourly[23]).toBe(1);
    expect(summary.hourly.reduce((sum, value) => sum + value, 0)).toBe(3);
  });

  it('trims empty conclusions and keeps the assumptions', () => {
    expect(summary.conclusions).toEqual(['Перше.', 'Друге.', 'Третє.']);
    expect(summary.assumptions).toEqual(['Пуассонівський процес без пам’яті.']);
  });

  it('marks a reply inconsistent when the model’s λ disagrees with its own intervals', () => {
    const drifted = parseAttackStatsReply(reply({ ...CHARTS, lambda_per_day: 0.9 }), TASK).summary!;
    expect(drifted.verification).toBe('inconsistent');
    expect(drifted.issues.some((issue) => issue.startsWith('lambda_mismatch'))).toBe(true);
    // Прогноз при цьому лишається — читач бачить обидва числа, а не порожнє місце.
    expect(drifted.forecast.length).toBe(3);
  });

  it('marks a reply inconsistent when the forecast probabilities float away from the recomputed p', () => {
    const forecast = CHARTS.forecast.map((day) => ({ ...day, p: 0.9 }));
    const drifted = parseAttackStatsReply(reply({ ...CHARTS, forecast }), TASK).summary!;
    expect(drifted.verification).toBe('inconsistent');
    expect(drifted.issues.some((issue) => issue.startsWith('p_mismatch'))).toBe(true);
  });

  it('marks a reply without intervals inconsistent rather than inventing a rate', () => {
    const noIntervals = parseAttackStatsReply(reply({ ...CHARTS, intervals_days: [] }), TASK).summary!;
    expect(noIntervals.poisson).toBeNull();
    expect(noIntervals.verification).toBe('inconsistent');
  });

  it('falls back to the episodes for the night share and the hourly comb when the model gave neither', () => {
    const bare = parseAttackStatsReply(reply({ ...CHARTS, metrics: undefined, hourly: undefined }), TASK).summary!;
    // 01:40 і 03:15 — нічні, 23:30 — ні.
    expect(bare.nightShare).toBeCloseTo(0.667, 3);
    expect(bare.hourly[1]).toBe(1);
    expect(bare.hourly[3]).toBe(1);
    expect(bare.hourly[23]).toBe(1);
  });
});

describe('rejections', () => {
  it('rejects a reply without a JSON block', () => {
    const parsed = parseAttackStatsReply('Лише проза без даних.', TASK);
    expect(parsed).toEqual({ charts: null, summary: null, rejectionReason: 'json_block_missing' });
  });

  it('names the schema path that failed', () => {
    const parsed = parseAttackStatsReply(reply({ ...CHARTS, forecast: [{ date: 'вчора', p: 0.5 }] }), TASK);
    expect(parsed.rejectionReason).toBe('schema:forecast.0.date');
  });

  it('rejects a forecast that lies entirely outside the horizon', () => {
    const parsed = parseAttackStatsReply(reply({ ...CHARTS, forecast: [{ date: '2026-09-05', p: 0.5 }] }), TASK);
    expect(parsed.summary?.verification).toBe('rejected');
    expect(parsed.rejectionReason).toBe('forecast_outside_period');
  });

  it('coerces numeric strings, which models produce, but not garbage', () => {
    const parsed = parseAttackStatsReply(reply({ ...CHARTS, lambda_per_day: '0.35', forecast: [{ date: '2026-08-17', p: '0.4' }] }), TASK);
    expect(parsed.summary?.tonight?.p).toBe(0.4);
    const bad = parseAttackStatsReply(reply({ ...CHARTS, forecast: [{ date: '2026-08-17', p: 'half' }] }), TASK);
    expect(bad.rejectionReason).toBe('schema:forecast.0.p');
  });
});

describe('the digest lines', () => {
  it('open with the period and the counts, name tonight and the next days, and never the region', () => {
    const summary = parseAttackStatsReply(reply(), TASK).summary!;
    const lines = attackStatsDigestLines(summary);
    expect(lines[0]).toBe('Період 01.07.2026 — 16.08.2026: 3 дн. з атаками із 47, нічних 67 %, з балістикою 33 %, середній інтервал 2,9 доби.');
    expect(lines[1]).toBe('Найближча ніч (17.08): ≈30 % — середня.');
    expect(lines[2]).toBe('Далі: 18.08 29 % · 19.08 61 %.');
    expect(lines.join('\n')).not.toContain('Київ');
  });

  it('adds the recomputed p when the model’s numbers do not add up', () => {
    const drifted = parseAttackStatsReply(reply({ ...CHARTS, lambda_per_day: 0.9 }), TASK).summary!;
    const lines = attackStatsDigestLines(drifted);
    expect(lines.at(-1)).toContain('Перерахунок за Пуассоном дає ≈');
    expect(lines.at(-1)).toContain('не сходяться');
  });

  it('says nothing about tonight when the forecast starts later', () => {
    const later = composeAttackStatsSummary(
      { ...CHARTS, forecast: [{ date: '2026-08-20', p: 0.2 }] } as never, TASK
    );
    // `tonight` — перший день прогнозу від forecastFrom включно; 20.08 і є ним.
    expect(later.tonight?.date).toBe('2026-08-20');
    expect(attackStatsDigestLines(later)[1]).toBe('Найближча ніч (20.08): ≈20 % — низька.');
  });
});
