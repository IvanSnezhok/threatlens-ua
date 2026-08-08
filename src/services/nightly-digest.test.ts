import { describe, expect, it } from 'vitest';

/**
 * Що саме отримує людина о 23:20, коли модель мовчить, бреше або її просто вимкнено.
 *
 * Нічне зведення — єдиний машинний текст цієї системи, який приходить у Telegram без того, щоб
 * хтось його прочитав перед надсиланням. Тому тут перевіряється не «чи гарно написано», а три речі,
 * кожна з яких мовчазна:
 *
 *   1. вимкнений перемикач означає, що моделі взагалі не питали — не «спитали й проігнорували»;
 *   2. будь-яка невдача моделі дає зведення без рядка, а не зведення без оцінок;
 *   3. число, якого немає у вхідних фактах, відкидає весь рядок.
 *
 * `CODEX_BASE_URL` треба задати до розбору конфігу, тому модуль імпортується динамічно.
 */

process.env.CODEX_BASE_URL = 'https://codex.test/v1';

const { digestFacts, digestSummary } = await import('./nightly-digest.js');

const settings = async () => ({
  model: 'gpt-5.2' as string | null,
  features: { narrative: false, digest: true, attacks: false },
  updatedAt: null,
  effectiveModel: 'gpt-5.2' as string | null,
  modelSource: 'stored' as const
});
const credentials = async () => ({ accessToken: 'token', accountId: null });
const audit = async () => undefined;
const base = { settings, credentials, audit, featureEnabled: async () => true };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function completion(summary: unknown): Response {
  return jsonResponse({ choices: [{ message: { content: JSON.stringify({ summary }) } }] });
}

const rows = [
  {
    location_name: 'Полтава', threat_type: 'ballistic_missile', risk_level: 'elevated',
    indicative_percent: 35, risk_score: '3.5'
  },
  {
    location_name: 'Харків', threat_type: 'uav', risk_level: 'moderate',
    indicative_percent: 20, risk_score: '2.0'
  }
] as never[];

const facts = digestFacts(rows, 4, '23:20');

describe('факти зведення', () => {
  it('несуть рівно те, що піде в повідомлення, і нічого більше', () => {
    // Модель не має бачити ні chat_id, ні ідентифікаторів оцінок: усе, що вона не бачить, вона не
    // може ані переказати, ані сплутати.
    expect(facts).toEqual({
      time: '23:20',
      locations: [
        { locationName: 'Полтава', threatType: 'ballistic_missile', level: 'elevated', indicativePercent: 35, score: '3.5' },
        { locationName: 'Харків', threatType: 'uav', level: 'moderate', indicativePercent: 20, score: '2.0' }
      ],
      omitted: 4
    });
  });
});

describe('рядок від моделі', () => {
  it('з’являється, коли модель відповіла коректно', async () => {
    const summary = await digestSummary(facts, {
      ...base, fetchImpl: async () => completion('Найвищий рівень — по Полтаві, решта нижче.')
    });
    expect(summary).toEqual({
      text: 'Найвищий рівень — по Полтаві, решта нижче.', aiGenerated: true, rejectionReason: null
    });
  });

  it('не з’являється, коли перемикач вимкнено, і модель навіть не викликається', async () => {
    let called = false;
    const summary = await digestSummary(facts, {
      ...base, featureEnabled: async () => false,
      fetchImpl: async () => { called = true; return completion('щось'); }
    });
    expect(summary).toEqual({ text: null, aiGenerated: false, rejectionReason: null });
    expect(called).toBe(false);
  });

  it('не з’являється, коли сесія протухла — і зведення від цього не ламається', async () => {
    const summary = await digestSummary(facts, {
      ...base, fetchImpl: async () => jsonResponse({ error: 'invalid_token' }, 401)
    });
    expect(summary.text).toBeNull();
    expect(summary.aiGenerated).toBe(false);
    expect(summary.rejectionReason).toBe('session_expired');
  });

  it('не з’являється, коли мережа впала', async () => {
    const summary = await digestSummary(facts, {
      ...base, fetchImpl: async () => { throw new Error('fetch failed'); }
    });
    expect(summary).toMatchObject({ text: null, aiGenerated: false, rejectionReason: 'transport_error' });
  });

  it('відкидається цілком через одне вигадане число', async () => {
    // «47 БпЛА» не було в жодній оцінці. Читач не має способу відрізнити вигадану цифру від
    // порахованої, тому підозрілим стає весь рядок, а не одне слово в ньому.
    const summary = await digestSummary(facts, {
      ...base, fetchImpl: async () => completion('Зафіксовано 47 ударних БпЛА над двома областями.')
    });
    expect(summary.text).toBeNull();
    expect(summary.rejectionReason).toBe('ungrounded_number:47');
  });

  it('приймає числа, які модель узяла з наданих оцінок', async () => {
    const summary = await digestSummary(facts, {
      ...base, fetchImpl: async () => completion('По Полтаві 35% індикативного рівня — найвище зі списку.')
    });
    expect(summary.text).toContain('35%');
    expect(summary.aiGenerated).toBe(true);
  });

  it('відкидає відповідь, яка не є очікуваним JSON', async () => {
    const summary = await digestSummary(facts, {
      ...base, fetchImpl: async () => jsonResponse({ choices: [{ message: { content: 'не json' } }] })
    });
    expect(summary).toMatchObject({ text: null, rejectionReason: 'unparsable_json' });
  });

  it('відкидає порожній або надто довгий рядок', async () => {
    const empty = await digestSummary(facts, { ...base, fetchImpl: async () => completion('   ') });
    expect(empty.rejectionReason).toBe('unusable_summary');
    const long = await digestSummary(facts, { ...base, fetchImpl: async () => completion('а'.repeat(400)) });
    expect(long.rejectionReason).toBe('unusable_summary');
  });

  it('не питає модель про порожній список оцінок', async () => {
    let called = false;
    const summary = await digestSummary(digestFacts([], 0, '23:20'), {
      ...base, fetchImpl: async () => { called = true; return completion('щось'); }
    });
    expect([summary.text, called]).toEqual([null, false]);
  });
});
