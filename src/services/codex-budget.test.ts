import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config.js';
import {
  CodexBudget, laneDecision, laneForSurface, parseCodexUsageHeaders, usageLimitUntil,
  EMPTY_BUDGET_STATE, type CodexBudgetState, type CodexBudgetStore
} from './codex-budget.js';

/**
 * Бюджет квоти Codex без мережі й без бази: заголовки, межі смуг і блок після 429.
 *
 * Межі тут пінять саме на краях, бо саме край — рішення власника: аналітика стоїть уже на 70 %, карта
 * на 85 %, гарячий шлях на 97 %, а темп аналітики дозволяє рівно «минуло вікна + 10 пунктів» і ні
 * десятою більше. Помилка на одиницю в будь-який бік — це або аналітика, що доїдає резерв
 * попереджень, або класифікатор, який віддає повідомлення правилам на хвилину раніше, ніж мусив.
 */

const NOW = new Date('2026-09-23T09:00:00.000Z');
const minutes = (count: number) => count * 60_000;

/** П'ятигодинне вікно, з якого минуло `elapsed` хвилин, і `used` відсотків витрачено. */
function state(used: number, elapsed = 150, overrides: Partial<CodexBudgetState> = {}): CodexBudgetState {
  return {
    ...EMPTY_BUDGET_STATE,
    primary: { usedPercent: used, windowMinutes: 300, resetAt: new Date(NOW.getTime() + minutes(300 - elapsed)) },
    observedAt: NOW,
    ...overrides
  };
}

describe('lanes', () => {
  it('puts the surfaces a warning waits on in the hot lane, the track in the map lane, everything else in analytics', () => {
    expect(['classifier', 'retrospective_gate', 'movement_summary'].map(laneForSurface)).toEqual(['hot', 'hot', 'hot']);
    expect(laneForSurface('actualization')).toBe('map');
    expect(['shadow', 'risk', 'narrative', 'digest', 'tactics', 'attack_research', 'attack_stats',
      'context_compaction', 'attacks'].map(laneForSurface)).toEqual(Array(9).fill('analytics'));
    // Нова поверхня, про яку бюджет не знає, зупиняється першою, а не останньою.
    expect(laneForSurface('toString')).toBe('analytics');
  });
});

describe('admission at the boundaries', () => {
  it('holds each lane back exactly at its own cap', () => {
    // Половина вікна минула, тож темп аналітики тут не заважає (≤ 60 %).
    expect(laneDecision('analytics', state(59.9), NOW)).toEqual({ admitted: true, reason: null });
    expect(laneDecision('analytics', state(70, 280), NOW)).toEqual({ admitted: false, reason: 'primary_cap' });
    expect(laneDecision('analytics', state(69.9, 280), NOW).admitted).toBe(true);
    expect(laneDecision('map', state(84.9), NOW).admitted).toBe(true);
    expect(laneDecision('map', state(85), NOW)).toEqual({ admitted: false, reason: 'primary_cap' });
    expect(laneDecision('hot', state(96.9), NOW).admitted).toBe(true);
    expect(laneDecision('hot', state(97), NOW)).toEqual({ admitted: false, reason: 'primary_cap' });
  });

  it('paces analytics to the window: spent may lead elapsed by the slack and not a tenth more', () => {
    // Минуло 150 хв із 300 — 50 %; дозволено до 60 %.
    expect(laneDecision('analytics', state(60), NOW).admitted).toBe(true);
    expect(laneDecision('analytics', state(60.1), NOW)).toEqual({ admitted: false, reason: 'primary_pace' });
    // Темп — лише для аналітики: карта й гарячий шлях не чекають на рівномірність.
    expect(laneDecision('map', state(60.1), NOW).admitted).toBe(true);
    expect(laneDecision('hot', state(60.1), NOW).admitted).toBe(true);
  });

  it('applies the same caps and pace to the weekly window', () => {
    const weekly = (used: number, elapsedMinutes: number): CodexBudgetState => ({
      ...EMPTY_BUDGET_STATE,
      primary: { usedPercent: 5, windowMinutes: 300, resetAt: new Date(NOW.getTime() + minutes(290)) },
      secondary: { usedPercent: used, windowMinutes: 10_080, resetAt: new Date(NOW.getTime() + minutes(10_080 - elapsedMinutes)) }
    });
    // Минула половина тижня: 60 % — ще в темпі, 60,1 % — уже ні.
    expect(laneDecision('analytics', weekly(60, 5_040), NOW).admitted).toBe(true);
    expect(laneDecision('analytics', weekly(60.1, 5_040), NOW)).toEqual({ admitted: false, reason: 'secondary_pace' });
    expect(laneDecision('hot', weekly(97, 9_000), NOW)).toEqual({ admitted: false, reason: 'secondary_cap' });
  });

  it('forgets a window once it has reset, and stops nobody while nothing is known', () => {
    const reset = state(100, 150, {
      primary: { usedPercent: 100, windowMinutes: 300, resetAt: new Date(NOW.getTime() - 1_000) }
    });
    expect(laneDecision('analytics', reset, NOW).admitted).toBe(true);
    expect(laneDecision('analytics', EMPTY_BUDGET_STATE, NOW).admitted).toBe(true);
  });

  it('keeps the hot lane last even when the caps are set out of order', () => {
    const saved = {
      hot: config.CODEX_BUDGET_HOT_MAX_PERCENT,
      analytics: config.CODEX_BUDGET_ANALYTICS_MAX_PERCENT
    };
    Object.assign(config, { CODEX_BUDGET_HOT_MAX_PERCENT: 60, CODEX_BUDGET_ANALYTICS_MAX_PERCENT: 90 });
    try {
      // Аналітика не отримає квоти, якої вже не має гарячий шлях.
      expect(laneDecision('analytics', state(59, 290), NOW).admitted).toBe(true);
      expect(laneDecision('analytics', state(61, 290), NOW)).toEqual({ admitted: false, reason: 'primary_cap' });
    } finally {
      Object.assign(config, {
        CODEX_BUDGET_HOT_MAX_PERCENT: saved.hot, CODEX_BUDGET_ANALYTICS_MAX_PERCENT: saved.analytics
      });
    }
  });
});

describe('the quota headers', () => {
  it('reads both windows, the exact reset over the relative one, and the plan', () => {
    const headers = new Headers({
      'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': '1790164674', 'x-codex-primary-reset-after-seconds': '8965',
      'x-codex-secondary-used-percent': '16', 'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-after-seconds': '600',
      'x-codex-plan-type': 'plus', 'x-codex-credits-has-credits': 'False'
    });
    expect(parseCodexUsageHeaders(headers, NOW)).toEqual({
      primary: { usedPercent: 100, windowMinutes: 300, resetAt: new Date(1_790_164_674_000) },
      secondary: { usedPercent: 16, windowMinutes: 10_080, resetAt: new Date(NOW.getTime() + 600_000) },
      planType: 'plus'
    });
  });

  it('answers null for a response that carries none, and ignores values that are not numbers', () => {
    expect(parseCodexUsageHeaders(new Headers({ 'Content-Type': 'application/json' }), NOW)).toBeNull();
    expect(parseCodexUsageHeaders(new Headers({ 'x-codex-primary-used-percent': 'lots' }), NOW)).toBeNull();
  });
});

describe('429 usage_limit_reached', () => {
  const body = (error: Record<string, unknown>) => JSON.stringify({ error: { type: 'usage_limit_reached', ...error } });

  it('blocks until the moment the body names, then from the exhausted window, then five minutes', () => {
    expect(usageLimitUntil(body({ resets_at: 1790164674, resets_in_seconds: 8965 }), EMPTY_BUDGET_STATE, NOW))
      .toEqual(new Date(1_790_164_674_000));
    expect(usageLimitUntil(body({ resets_in_seconds: 60 }), EMPTY_BUDGET_STATE, NOW))
      .toEqual(new Date(NOW.getTime() + 60_000));
    expect(usageLimitUntil(body({}), state(100, 100), NOW)).toEqual(new Date(NOW.getTime() + minutes(200)));
    expect(usageLimitUntil(body({}), EMPTY_BUDGET_STATE, NOW)).toEqual(new Date(NOW.getTime() + minutes(5)));
  });

  it('does not block on a 429 that is not the usage limit', () => {
    expect(usageLimitUntil(JSON.stringify({ error: { type: 'rate_limit_exceeded' } }), EMPTY_BUDGET_STATE, NOW)).toBeNull();
    expect(usageLimitUntil('<html>Too Many Requests</html>', EMPTY_BUDGET_STATE, NOW)).toBeNull();
  });

  it('stops every lane until the reset and lets them go after it', async () => {
    const budget = new CodexBudget(null);
    budget.observe(
      { status: 429, headers: new Headers() },
      body({ resets_at: Math.floor(NOW.getTime() / 1000) + 3_600 }), NOW
    );
    for (const surface of ['classifier', 'actualization', 'risk']) {
      expect(await budget.admit(surface, new Date(NOW.getTime() + minutes(59)))).toMatchObject({
        admitted: false, reason: 'usage_limit'
      });
    }
    expect(await budget.admit('risk', new Date(NOW.getTime() + minutes(61)))).toMatchObject({ admitted: true });
  });
});

describe('persistence', () => {
  let saved: CodexBudgetState[] = [];
  const store = (stored: CodexBudgetState | null = null): CodexBudgetStore => ({
    load: async () => stored,
    save: async (snapshot) => { saved.push(snapshot); }
  });
  afterEach(() => {
    saved = [];
    vi.useRealTimers();
  });

  it('starts from what the last process knew, so a restart does not hammer an exhausted window', async () => {
    const budget = new CodexBudget(store(state(100, 60)));
    expect(await budget.admit('classifier', NOW)).toMatchObject({ admitted: false, reason: 'primary_cap' });
  });

  it('writes only a change, and not more often than every ten seconds', async () => {
    vi.useFakeTimers({ now: NOW });
    const budget = new CodexBudget(store());
    const headers = (used: string) => new Headers({
      'x-codex-primary-used-percent': used, 'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': String(Math.floor(NOW.getTime() / 1000) + 3_600)
    });
    await budget.admit('risk');
    budget.observe({ status: 200, headers: headers('40') }, null);
    await vi.advanceTimersByTimeAsync(0);
    // The same reading again is not a change and costs no write.
    budget.observe({ status: 200, headers: headers('40') }, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(saved.map((snapshot) => snapshot.primary?.usedPercent)).toEqual([40]);

    budget.observe({ status: 200, headers: headers('41') }, null);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(saved).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(saved.map((snapshot) => snapshot.primary?.usedPercent)).toEqual([40, 41]);
  });
});
