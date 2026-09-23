import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureMigrated, integrationDatabaseAvailable, sql } from '../helpers/db.js';
import type * as CodexBudgetModule from '../../src/services/codex-budget.js';

/**
 * Бюджет квоти Codex проти живої PostgreSQL (міграція 057).
 *
 * Юніт-тести поруч із `src/services/codex-budget.ts` доводять рішення. Тут — те, заради чого існує
 * таблиця: процес, що стартує посеред вичерпаного вікна, знає про нього з першого виклику, а не з
 * першої відповіді 429; рядок один і пишеться лише тоді, коли знімок змінився; і консоль бачить той
 * самий стан у `GET /ops/codex/settings`.
 */

const OPS = `Basic ${Buffer.from('operator:change-me').toString('base64')}`;

const CLEAR_ROW = `UPDATE codex_budget_state SET primary_used_percent=NULL, primary_window_minutes=NULL,
  primary_reset_at=NULL, secondary_used_percent=NULL, secondary_window_minutes=NULL, secondary_reset_at=NULL,
  plan_type=NULL, blocked_until=NULL, blocked_reason=NULL, observed_at=NULL, updated_at=now() WHERE singleton`;

describe.skipIf(!integrationDatabaseAvailable)('codex budget state against live PostgreSQL', () => {
  let budget: typeof CodexBudgetModule;

  beforeAll(async () => {
    await ensureMigrated();
    // Динамічно, як і в кожному файлі цього каталогу: модуль тягне `src/db/pool.ts`, чий пул
    // будується з `DATABASE_URL` під час імпорту.
    budget = await import('../../src/services/codex-budget.js');
  });

  // Інтеграційні файли йдуть в одному процесі: памʼять бюджету й рядок переживають файл, тож і
  // до тесту, і після нього — порожній знімок і в памʼяті, і в таблиці.
  const clean = async () => {
    await budget.codexBudget.persistNow();
    budget.resetCodexBudget();
    await sql(CLEAR_ROW);
  };
  beforeEach(clean);
  afterEach(clean);

  const exhausted = (now: Date, resetAt: number) => ({
    status: 429,
    headers: new Headers({
      'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': String(resetAt),
      'x-codex-secondary-used-percent': '16', 'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-after-seconds': '86400', 'x-codex-plan-type': 'plus'
    }),
    body: JSON.stringify({ error: { type: 'usage_limit_reached', plan_type: 'plus', resets_at: resetAt, resets_in_seconds: 3_600 } }),
    now
  });

  it('keeps an exhausted window across a restart, so the first call after it is already held back', async () => {
    const now = new Date();
    const resetAt = Math.floor(now.getTime() / 1000) + 3_600;
    const answer = exhausted(now, resetAt);
    budget.codexBudget.observe(answer, answer.body, now);
    await budget.codexBudget.persistNow();

    const row = await sql<{
      primary_used_percent: number; primary_window_minutes: number; primary_reset_at: Date;
      secondary_used_percent: number; plan_type: string; blocked_until: Date; blocked_reason: string
    }>(`SELECT primary_used_percent, primary_window_minutes, primary_reset_at, secondary_used_percent,
               plan_type, blocked_until, blocked_reason FROM codex_budget_state`);
    expect(row.rows).toEqual([{
      primary_used_percent: 100, primary_window_minutes: 300, primary_reset_at: new Date(resetAt * 1000),
      secondary_used_percent: 16, plan_type: 'plus', blocked_until: new Date(resetAt * 1000),
      blocked_reason: 'usage_limit_reached'
    }]);

    // «Новий процес»: памʼять порожня, сховище — та сама таблиця.
    budget.resetCodexBudget();
    expect(await budget.codexBudget.admit('classifier', now)).toMatchObject({ admitted: false, reason: 'usage_limit' });
    expect(await budget.codexBudget.admit('classifier', new Date(resetAt * 1000 + 1_000))).toMatchObject({ admitted: true });
  });

  it('writes the one row only when the reading changes', async () => {
    const now = new Date();
    const reading = (used: string) => ({
      status: 200,
      headers: new Headers({
        'x-codex-primary-used-percent': used, 'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-at': String(Math.floor(now.getTime() / 1000) + 3_600)
      })
    });
    await budget.codexBudget.admit('risk', now);
    budget.codexBudget.observe(reading('40'), null, now);
    await budget.codexBudget.persistNow();
    const first = await sql<{ updated_at: Date }>(`SELECT updated_at FROM codex_budget_state`);

    budget.codexBudget.observe(reading('40'), null, new Date(now.getTime() + 1_000));
    await budget.codexBudget.persistNow();
    const unchanged = await sql<{ updated_at: Date; primary_used_percent: number }>(
      `SELECT updated_at, primary_used_percent FROM codex_budget_state`
    );
    expect(unchanged.rows).toEqual([{ updated_at: first.rows[0]!.updated_at, primary_used_percent: 40 }]);

    budget.codexBudget.observe(reading('41'), null, new Date(now.getTime() + 2_000));
    await budget.codexBudget.persistNow();
    expect((await sql(`SELECT primary_used_percent FROM codex_budget_state`)).rows).toEqual([{ primary_used_percent: 41 }]);
  });

  it('shows the operator the same state beside the switches', async () => {
    const now = new Date();
    const resetAt = Math.floor(now.getTime() / 1000) + 3_600;
    const answer = exhausted(now, resetAt);
    budget.codexBudget.observe(answer, answer.body, now);

    const Fastify = (await import('fastify')).default;
    const routes = (await import('../../src/api/ops-codex-routes.js')).default;
    const app = Fastify({ logger: false });
    await app.register(routes);
    await app.ready();
    try {
      const read = await app.inject({ method: 'GET', url: '/ops/codex/settings', headers: { authorization: OPS } });
      expect(read.statusCode).toBe(200);
      expect(read.json().budget).toMatchObject({
        planType: 'plus',
        primary: { usedPercent: 100, windowMinutes: 300, resetsAt: new Date(resetAt * 1000).toISOString(), expired: false },
        secondary: { usedPercent: 16, windowMinutes: 10_080 },
        blockedUntil: new Date(resetAt * 1000).toISOString(),
        blockedReason: 'usage_limit_reached',
        caps: { hot: 97, map: 85, analytics: 70, paceSlack: 10 },
        lanes: {
          hot: { admitted: false, reason: 'usage_limit' },
          map: { admitted: false, reason: 'usage_limit' },
          analytics: { admitted: false, reason: 'usage_limit' }
        }
      });
    } finally {
      await app.close();
    }
  });
});
