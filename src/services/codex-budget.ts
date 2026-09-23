import { Counter } from 'prom-client';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';

/**
 * Бюджет Codex: хто має право на виклик, поки квота облікового запису ще є (міграція 057).
 *
 * ================================================================================================
 * Навіщо, коли кожна поверхня вже має власний ліміт на хвилину
 * ================================================================================================
 *
 * Ліміти поверхонь рахують ВИКЛИКИ, а квота облікового запису рахує ВІКНО: п'ять годин (primary) і
 * тиждень (secondary), у відсотках. 23.09.2026 п'ятигодинне вікно плану plus вичерпалося о 08:56 UTC,
 * і далі кожна поверхня кликала з тією самою частотою: понад дві тисячі відповідей 429 за дві години,
 * жодна з яких нічого не дала. Ризик сам по собі з'їв більшу частину вікна ще до того — по виклику
 * на кожну групу за прохід, — і класифікатор, на вердикт якого чекає попередження, лишився без моделі
 * саме тоді, коли повідомлень було найбільше.
 *
 * Бекенд шле заголовки `x-codex-primary-*` і `x-codex-secondary-*` на КОЖНУ відповідь, не лише на
 * 429: скільки відсотків вікна витрачено, скільки воно триває і коли скинеться. Цей модуль їх читає
 * і ДО запиту вирішує, чи має поверхня на нього право.
 *
 * ================================================================================================
 * Три смуги, і чому гарячий шлях зупиняється останнім
 * ================================================================================================
 *
 *  - **hot** — основний класифікатор, ретроспективний гейт, переказ руху: на них чекає попередження.
 *    Мають право, поки витрачено менше `CODEX_BUDGET_HOT_MAX_PERCENT` (97 %).
 *  - **map** — актуалізація треку: карта. До `CODEX_BUDGET_MAP_MAX_PERCENT` (85 %).
 *  - **analytics** — усе інше: тінь, ризик, наратив, дайджест, тактика, дослідження, статистика,
 *    стискання контексту (і доповнення, що їде на вердикті тіні). До
 *    `CODEX_BUDGET_ANALYTICS_MAX_PERCENT` (70 %) І не швидше за рівномірний темп: витрачено не більше,
 *    ніж минуло вікна, плюс `CODEX_BUDGET_PACE_SLACK_PERCENT` (10 пунктів). Без темпу нічна атака
 *    спалювала б 70 % за першу годину, і решту вікна аналітика стояла б без моделі теж.
 *
 * Тижневе вікно має ті самі межі — і темп теж. Відповідь 429 `usage_limit_reached` зупиняє ВСІ
 * смуги до моменту скидання, названого в тілі або в заголовках.
 *
 * Відмова — не помилка: `codexChat` повертає `budget_deferred` без жодного мережевого запиту й без
 * рядка в `ai_runs` (рахує лише `threatlens_codex_budget_denied_total{lane}`), і поверхня йде своїм
 * запасним шляхом — правила, детермінований трек, текст без моделі. Тож жодна межа тут не може
 * загубити попередження: вона лише вирішує, чиє читання ще робить модель.
 *
 * ================================================================================================
 * Памʼять і таблиця
 * ================================================================================================
 *
 * Рішення — у памʼяті процесу, як і кожен бюджет у цьому коді (див. `./shadow-classifier.ts`):
 * обмежувач, якому для рішення про запит потрібен запит у базу, — не обмежувач. Але ЗНАННЯ про
 * вичерпане вікно не має права зникати з перезапуском, інакше перша ж хвилина після деплою піде на
 * ті самі 429. Тому останній знімок лежить у `codex_budget_state` (один рядок), читається на першому
 * виклику після старту і пишеться лише тоді, коли змінився, — не частіше ніж раз на десять секунд.
 */

export const CODEX_LANES = ['hot', 'map', 'analytics'] as const;
export type CodexLane = (typeof CODEX_LANES)[number];

/** Поверхні, які не аналітика. Решта — аналітика, зокрема й кожна поверхня, яку додадуть пізніше. */
const SURFACE_LANES: Record<string, CodexLane> = {
  classifier: 'hot', retrospective_gate: 'hot', movement_summary: 'hot',
  actualization: 'map'
};

export function laneForSurface(surface: string): CodexLane {
  // `hasOwn`, бо `surface` — рядок, і `toString` з прототипу — не смуга.
  return Object.hasOwn(SURFACE_LANES, surface) ? SURFACE_LANES[surface]! : 'analytics';
}

// ------------------------------------------------------------------------------------------------
// Знімок квоти і те, звідки він береться
// ------------------------------------------------------------------------------------------------

export interface CodexUsageWindow {
  /** Скільки відсотків вікна витрачено — так, як сказав бекенд. */
  usedPercent: number;
  windowMinutes: number | null;
  resetAt: Date | null;
}

export interface CodexBudgetState {
  /** П'ятигодинне вікно. */
  primary: CodexUsageWindow | null;
  /** Тижневе вікно. */
  secondary: CodexUsageWindow | null;
  planType: string | null;
  /** Коли заголовки прочитано востаннє. */
  observedAt: Date | null;
  /** До якого моменту 429 `usage_limit_reached` зупинив усі смуги. */
  blockedUntil: Date | null;
  blockedReason: string | null;
}

/** Стан «нічого не відомо». Заморожений: знімок ніколи не змінюється на місці, лише замінюється. */
export const EMPTY_BUDGET_STATE: CodexBudgetState = Object.freeze({
  primary: null, secondary: null, planType: null, observedAt: null, blockedUntil: null, blockedReason: null
});

function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name)?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Бекенд шле epoch у секундах; значення, що виглядає як мілісекунди, читається як мілісекунди. */
function fromEpoch(value: number): Date {
  return new Date(value > 1e12 ? value : value * 1000);
}

function usageWindow(headers: Headers, name: 'primary' | 'secondary', now: Date): CodexUsageWindow | null {
  const used = headerNumber(headers, `x-codex-${name}-used-percent`);
  if (used === null) return null;
  const minutes = headerNumber(headers, `x-codex-${name}-window-minutes`);
  const resetAt = headerNumber(headers, `x-codex-${name}-reset-at`);
  const resetAfter = headerNumber(headers, `x-codex-${name}-reset-after-seconds`);
  return {
    usedPercent: Math.max(0, used),
    windowMinutes: minutes !== null && minutes > 0 ? Math.round(minutes) : null,
    // Точний момент — перевага над «через скільки секунд»: другий пливе на час доставки відповіді.
    resetAt: resetAt !== null && resetAt > 0 ? fromEpoch(resetAt)
      : resetAfter !== null && resetAfter >= 0 ? new Date(now.getTime() + resetAfter * 1000) : null
  };
}

export interface CodexUsageHeaders {
  primary: CodexUsageWindow | null;
  secondary: CodexUsageWindow | null;
  planType: string | null;
}

/** Заголовки `x-codex-*` однієї відповіді; `null` — їх немає (проксі chat/completions їх не шле). */
export function parseCodexUsageHeaders(headers: Headers, now = new Date()): CodexUsageHeaders | null {
  const primary = usageWindow(headers, 'primary', now);
  const secondary = usageWindow(headers, 'secondary', now);
  if (!primary && !secondary) return null;
  return { primary, secondary, planType: headers.get('x-codex-plan-type')?.trim() || null };
}

/** Тіло 429 без часу скидання і без заголовків, що його назвали б: п'ять хвилин, потім одна проба. */
const UNKNOWN_RESET_BLOCK_MS = 5 * 60_000;

/** Форма відмови, виміряна 23.09.2026. Числа — `unknown`: їх перетворюють нижче, а не відкидають тіло. */
const usageLimitBodySchema = z.object({
  error: z.object({
    type: z.literal('usage_limit_reached'),
    resets_at: z.unknown().optional(),
    resets_in_seconds: z.unknown().optional()
  })
});

/**
 * До якого моменту відповідь 429 зупиняє всі смуги, або `null`, якщо це не вичерпана квота.
 *
 * Лише `usage_limit_reached` — форма, виміряна 23.09.2026:
 * `{"error":{"type":"usage_limit_reached",…,"resets_at":1790164674,"resets_in_seconds":8965}}`.
 * Інший 429 (перевантаження, частота) квоти не описує і нічого тут не блокує. Момент береться з тіла,
 * а коли тіло його не називає — зі скидання вікна, яке заголовки показують вичерпаним.
 */
export function usageLimitUntil(body: string, known: CodexBudgetState, now = new Date()): Date | null {
  let error: z.infer<typeof usageLimitBodySchema>['error'];
  try {
    const parsed = usageLimitBodySchema.safeParse(JSON.parse(body));
    if (!parsed.success) return null;
    error = parsed.data.error;
  } catch {
    return null;
  }
  const { resets_at: resetsAtRaw, resets_in_seconds: resetsInRaw } = error;
  const resetsAt = Number(resetsAtRaw);
  if (resetsAtRaw != null && Number.isFinite(resetsAt) && resetsAt > 0) return fromEpoch(resetsAt);
  const resetsIn = Number(resetsInRaw);
  if (resetsInRaw != null && Number.isFinite(resetsIn) && resetsIn >= 0) return new Date(now.getTime() + resetsIn * 1000);
  const exhausted = [known.primary, known.secondary]
    .filter((window): window is CodexUsageWindow & { resetAt: Date } =>
      Boolean(window && window.usedPercent >= 100 && window.resetAt && window.resetAt.getTime() > now.getTime()))
    .map((window) => window.resetAt.getTime());
  if (exhausted.length) return new Date(Math.max(...exhausted));
  if (known.primary?.resetAt && known.primary.resetAt.getTime() > now.getTime()) return known.primary.resetAt;
  return new Date(now.getTime() + UNKNOWN_RESET_BLOCK_MS);
}

// ------------------------------------------------------------------------------------------------
// Рішення
// ------------------------------------------------------------------------------------------------

export interface CodexBudgetCaps {
  hot: number;
  map: number;
  analytics: number;
  /** На скільки пунктів аналітика може йти попереду рівномірного темпу вікна. */
  paceSlack: number;
}

/**
 * Межі з налаштувань — у порядку аналітика ≤ карта ≤ гарячий шлях, хоч би як їх виставили.
 *
 * Стискання, а не відмова зберегти: переставлені межі — помилка налаштування, і її ціною не має бути
 * квота, яку аналітика забрала раніше за попередження. Консоль показує межі, що діють насправді.
 */
export function codexBudgetCaps(): CodexBudgetCaps {
  const hot = config.CODEX_BUDGET_HOT_MAX_PERCENT;
  const map = Math.min(config.CODEX_BUDGET_MAP_MAX_PERCENT, hot);
  const analytics = Math.min(config.CODEX_BUDGET_ANALYTICS_MAX_PERCENT, map);
  return { hot, map, analytics, paceSlack: config.CODEX_BUDGET_PACE_SLACK_PERCENT };
}

export interface CodexWindowReading {
  /** Витрачено зараз: після скидання вікна — нуль, хоч би що казав останній знімок. */
  usedPercent: number;
  /** Скільки вікна минуло, у відсотках; `null`, коли бекенд не назвав тривалості чи скидання. */
  elapsedPercent: number | null;
  /** Знімок описує вікно, яке вже скинулося. */
  expired: boolean;
}

export function readUsageWindow(window: CodexUsageWindow | null, now: Date): CodexWindowReading | null {
  if (!window) return null;
  if (window.resetAt && window.resetAt.getTime() <= now.getTime()) {
    return { usedPercent: 0, elapsedPercent: 0, expired: true };
  }
  const elapsedPercent = window.resetAt && window.windowMinutes
    ? Math.min(100, Math.max(0,
        100 * (1 - (window.resetAt.getTime() - now.getTime()) / (window.windowMinutes * 60_000))))
    : null;
  return { usedPercent: window.usedPercent, elapsedPercent, expired: false };
}

export type CodexBudgetDenial = 'usage_limit' | 'primary_cap' | 'secondary_cap' | 'primary_pace' | 'secondary_pace';

export interface CodexLaneDecision {
  admitted: boolean;
  reason: CodexBudgetDenial | null;
}

/**
 * Чи має смуга право на виклик у мить `now`. Чиста: жодної бази, жодного годинника.
 *
 * Межа — строга (`U < cap`): на 70 % аналітика вже стоїть. Темп — нестрогий (`U ≤ E + slack`). Невідоме
 * вікно (заголовків не було) нікого не зупиняє: «нічого не відомо» — не привід віддати попередження
 * правилам.
 */
export function laneDecision(
  lane: CodexLane, state: CodexBudgetState, now: Date, caps: CodexBudgetCaps = codexBudgetCaps()
): CodexLaneDecision {
  if (state.blockedUntil && state.blockedUntil.getTime() > now.getTime()) return { admitted: false, reason: 'usage_limit' };
  for (const name of ['primary', 'secondary'] as const) {
    const reading = readUsageWindow(state[name], now);
    if (!reading) continue;
    if (reading.usedPercent >= caps[lane]) return { admitted: false, reason: `${name}_cap` };
    if (lane === 'analytics' && reading.elapsedPercent !== null
      && reading.usedPercent > reading.elapsedPercent + caps.paceSlack) {
      return { admitted: false, reason: `${name}_pace` };
    }
  }
  return { admitted: true, reason: null };
}

// ------------------------------------------------------------------------------------------------
// Метрика
// ------------------------------------------------------------------------------------------------

/**
 * Виклики, яким бюджет відмовив ДО мережі, за смугою. Єдиний слід відмови: рядка в `ai_runs` немає,
 * бо не було й запиту, — а без лічильника «модель мовчить, бо квота» виглядало б як «модель мовчить».
 */
export const codexBudgetDenied = new Counter({
  name: 'threatlens_codex_budget_denied_total',
  help: 'Codex calls the budget governor refused before any network request, by lane',
  labelNames: ['lane'],
  registers: []
});

export function codexBudgetMetrics(): ReadonlyArray<[string, Counter<string>]> {
  return [['threatlens_codex_budget_denied_total', codexBudgetDenied]];
}

// ------------------------------------------------------------------------------------------------
// Сховище
// ------------------------------------------------------------------------------------------------

export interface CodexBudgetStore {
  load(): Promise<CodexBudgetState | null>;
  save(state: CodexBudgetState): Promise<void>;
}

interface BudgetRow {
  primary_used_percent: number | string | null;
  primary_window_minutes: number | null;
  primary_reset_at: Date | null;
  secondary_used_percent: number | string | null;
  secondary_window_minutes: number | null;
  secondary_reset_at: Date | null;
  plan_type: string | null;
  blocked_until: Date | null;
  blocked_reason: string | null;
  observed_at: Date | null;
}

function windowFromRow(
  used: number | string | null, minutes: number | null, resetAt: Date | null
): CodexUsageWindow | null {
  if (used === null) return null;
  return { usedPercent: Number(used), windowMinutes: minutes, resetAt: resetAt ? new Date(resetAt) : null };
}

export const postgresBudgetStore: CodexBudgetStore = {
  async load() {
    const result = await pool.query<BudgetRow>(
      `SELECT primary_used_percent, primary_window_minutes, primary_reset_at,
              secondary_used_percent, secondary_window_minutes, secondary_reset_at,
              plan_type, blocked_until, blocked_reason, observed_at
         FROM codex_budget_state WHERE singleton`
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      primary: windowFromRow(row.primary_used_percent, row.primary_window_minutes, row.primary_reset_at),
      secondary: windowFromRow(row.secondary_used_percent, row.secondary_window_minutes, row.secondary_reset_at),
      planType: row.plan_type,
      observedAt: row.observed_at,
      blockedUntil: row.blocked_until,
      blockedReason: row.blocked_reason
    };
  },
  async save(state) {
    await pool.query(
      `INSERT INTO codex_budget_state(singleton, primary_used_percent, primary_window_minutes, primary_reset_at,
         secondary_used_percent, secondary_window_minutes, secondary_reset_at, plan_type,
         blocked_until, blocked_reason, observed_at, updated_at)
       VALUES (true,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
       ON CONFLICT (singleton) DO UPDATE SET
         primary_used_percent=EXCLUDED.primary_used_percent,
         primary_window_minutes=EXCLUDED.primary_window_minutes,
         primary_reset_at=EXCLUDED.primary_reset_at,
         secondary_used_percent=EXCLUDED.secondary_used_percent,
         secondary_window_minutes=EXCLUDED.secondary_window_minutes,
         secondary_reset_at=EXCLUDED.secondary_reset_at,
         plan_type=EXCLUDED.plan_type,
         blocked_until=EXCLUDED.blocked_until,
         blocked_reason=EXCLUDED.blocked_reason,
         observed_at=EXCLUDED.observed_at,
         updated_at=now()`,
      [
        state.primary?.usedPercent ?? null, state.primary?.windowMinutes ?? null, state.primary?.resetAt ?? null,
        state.secondary?.usedPercent ?? null, state.secondary?.windowMinutes ?? null, state.secondary?.resetAt ?? null,
        state.planType, state.blockedUntil, state.blockedReason, state.observedAt
      ]
    );
  }
};

/**
 * Чи змінився знімок настільки, щоб його варто було писати.
 *
 * Скидання — з точністю до хвилини: коли бекенд назве лише «через скільки секунд», момент, обчислений
 * із кожної відповіді, пливе на мілісекунди, і без округлення кожна відповідь була б «зміною».
 */
function persistedKey(state: CodexBudgetState): string {
  const windows = [state.primary, state.secondary].map((usage) => (usage
    ? [Math.round(usage.usedPercent * 10) / 10, usage.windowMinutes,
        usage.resetAt ? Math.round(usage.resetAt.getTime() / 60_000) : null]
    : null));
  return JSON.stringify([...windows, state.planType, state.blockedUntil?.getTime() ?? null, state.blockedReason]);
}

/** Прочитаний зі сховища знімок поверх того, що процес устиг побачити сам: новіше спостереження виграє. */
function mergeLoaded(current: CodexBudgetState, stored: CodexBudgetState): CodexBudgetState {
  const storedNewer = !current.observedAt
    || (stored.observedAt !== null && stored.observedAt.getTime() > current.observedAt.getTime());
  const usage = storedNewer ? stored : current;
  const block = (stored.blockedUntil?.getTime() ?? 0) > (current.blockedUntil?.getTime() ?? 0) ? stored : current;
  return {
    primary: usage.primary, secondary: usage.secondary, planType: usage.planType, observedAt: usage.observedAt,
    blockedUntil: block.blockedUntil, blockedReason: block.blockedReason
  };
}

// ------------------------------------------------------------------------------------------------
// Губернатор
// ------------------------------------------------------------------------------------------------

/** Рідше за раз на десять секунд рядок не пишеться, хоч би скільки відповідей приносили заголовки. */
const PERSIST_EVERY_MS = 10_000;
/** Невдале читання сховища повторюється не частіше ніж раз на хвилину. */
const LOAD_RETRY_MS = 60_000;
/**
 * Скільки перший виклик після старту чекає на читання сховища. Секунда — і далі рішення з того, що є:
 * повільна база на старті не має права затримати вердикт, на який чекає попередження.
 */
const LOAD_WAIT_MS = 1_000;

export interface CodexBudgetAdmission extends CodexLaneDecision {
  lane: CodexLane;
}

/** Те, що від бюджету потрібно `codexChat`: рішення до запиту і спостереження після нього. */
export interface CodexBudgetGate {
  admit(surface: string, now?: Date): Promise<CodexBudgetAdmission>;
  observe(response: { status: number; headers: Headers }, body: string | null, now?: Date): void;
}

export interface CodexBudgetWindowView {
  /** Як сказав бекенд в останньому знімку. */
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: string | null;
  elapsedPercent: number | null;
  /** Вікно вже скинулося; `usedPercent` — історія, а рішення рахує нуль. */
  expired: boolean;
}

export interface CodexBudgetView {
  observedAt: string | null;
  planType: string | null;
  primary: CodexBudgetWindowView | null;
  secondary: CodexBudgetWindowView | null;
  /** Лише поки блок діє; минулий блок — історія, яка нікого не зупиняє. */
  blockedUntil: string | null;
  blockedReason: string | null;
  caps: CodexBudgetCaps;
  lanes: Record<CodexLane, CodexLaneDecision>;
}

function windowView(window: CodexUsageWindow | null, now: Date): CodexBudgetWindowView | null {
  const reading = readUsageWindow(window, now);
  if (!window || !reading) return null;
  return {
    usedPercent: window.usedPercent,
    windowMinutes: window.windowMinutes,
    resetsAt: window.resetAt?.toISOString() ?? null,
    elapsedPercent: reading.elapsedPercent === null ? null : Math.round(reading.elapsedPercent * 10) / 10,
    expired: reading.expired
  };
}

export class CodexBudget implements CodexBudgetGate {
  private state: CodexBudgetState = EMPTY_BUDGET_STATE;
  private loaded = false;
  private loading: Promise<void> | null = null;
  private lastLoadAttemptAt = Number.NEGATIVE_INFINITY;
  private savedKey: string | null = null;
  private lastSaveAt = Number.NEGATIVE_INFINITY;
  private saveTimer: NodeJS.Timeout | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(private store: CodexBudgetStore | null) {}

  /** Тестовий шов: стан модуля переживає TRUNCATE, а інтеграційні файли йдуть в одному процесі. */
  reset(store: CodexBudgetStore | null): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.store = store;
    this.state = EMPTY_BUDGET_STATE;
    this.loaded = false;
    this.loading = null;
    this.lastLoadAttemptAt = Number.NEGATIVE_INFINITY;
    this.savedKey = null;
    this.lastSaveAt = Number.NEGATIVE_INFINITY;
    this.saving = Promise.resolve();
  }

  /** Читає сховище один раз на процес (з повтором не частіше за хвилину, якщо не вдалося). */
  async ensureLoaded(nowMs = Date.now()): Promise<void> {
    if (this.loaded || !this.store) return;
    if (!this.loading) {
      if (nowMs - this.lastLoadAttemptAt < LOAD_RETRY_MS) return;
      this.lastLoadAttemptAt = nowMs;
      const store = this.store;
      const attempt: Promise<void> = store.load()
        .then((stored) => {
          if (this.store !== store) return;
          this.loaded = true;
          if (!stored) return;
          // Те, що вже лежить у рядку, писати вдруге нема чого; писати треба лише новіше за нього.
          this.savedKey = persistedKey(stored);
          this.state = mergeLoaded(this.state, stored);
          this.schedulePersist(Date.now());
        })
        .catch(() => undefined)
        .finally(() => { if (this.loading === attempt) this.loading = null; });
      this.loading = attempt;
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.loading,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, LOAD_WAIT_MS); timer.unref(); })
    ]).finally(() => clearTimeout(timer));
  }

  async admit(surface: string, now = new Date()): Promise<CodexBudgetAdmission> {
    await this.ensureLoaded(now.getTime());
    const lane = laneForSurface(surface);
    const decision = laneDecision(lane, this.state, now);
    if (!decision.admitted) codexBudgetDenied.inc({ lane });
    return { lane, ...decision };
  }

  /**
   * Заголовки кожної відповіді — і 200, і 429, і будь-якої іншої — плюс тіло відмови, коли воно є.
   * Ніколи не кидає: облік квоти не має права коштувати викликові його результату.
   */
  observe(response: { status: number; headers: Headers }, body: string | null, now = new Date()): void {
    try {
      let next = this.state;
      const usage = parseCodexUsageHeaders(response.headers, now);
      if (usage) {
        next = {
          ...next,
          primary: usage.primary ?? next.primary,
          secondary: usage.secondary ?? next.secondary,
          planType: usage.planType ?? next.planType,
          observedAt: now
        };
      }
      if (response.status === 429 && body) {
        const until = usageLimitUntil(body, next, now);
        if (until && until.getTime() > now.getTime()
          && (!next.blockedUntil || until.getTime() > next.blockedUntil.getTime())) {
          next = { ...next, blockedUntil: until, blockedReason: 'usage_limit_reached' };
        }
      }
      if (next === this.state) return;
      this.state = next;
      this.schedulePersist(now.getTime());
    } catch {
      // Див. вище: знімок, який не вдалося прочитати, — це знімок, якого не було.
    }
  }

  private schedulePersist(nowMs: number): void {
    if (!this.store || this.saveTimer) return;
    if (persistedKey(this.state) === this.savedKey) return;
    const delay = Math.max(0, this.lastSaveAt + PERSIST_EVERY_MS - nowMs);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.persistNow();
    }, delay);
    this.saveTimer.unref();
  }

  /** Пише знімок зараз, якщо він відрізняється від записаного. Тіло таймера й тестовий шов. */
  persistNow(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saving = this.saving.then(() => this.writeIfChanged());
    return this.saving;
  }

  private async writeIfChanged(): Promise<void> {
    const store = this.store;
    if (!store) return;
    const snapshot = this.state;
    const key = persistedKey(snapshot);
    if (key === this.savedKey) return;
    this.lastSaveAt = Date.now();
    try {
      await store.save(snapshot);
      if (this.store === store) this.savedKey = key;
    } catch {
      // Рішення від запису не залежать; наступна зміна (або цей самий таймер) спробує знову.
    }
    if (this.store === store) this.schedulePersist(Date.now());
  }

  async view(now = new Date()): Promise<CodexBudgetView> {
    await this.ensureLoaded(now.getTime());
    const caps = codexBudgetCaps();
    const state = this.state;
    const blocked = state.blockedUntil && state.blockedUntil.getTime() > now.getTime();
    return {
      observedAt: state.observedAt?.toISOString() ?? null,
      planType: state.planType,
      primary: windowView(state.primary, now),
      secondary: windowView(state.secondary, now),
      blockedUntil: blocked ? state.blockedUntil!.toISOString() : null,
      blockedReason: blocked ? state.blockedReason : null,
      caps,
      lanes: {
        hot: laneDecision('hot', state, now, caps),
        map: laneDecision('map', state, now, caps),
        analytics: laneDecision('analytics', state, now, caps)
      }
    };
  }
}

/** Бюджет процесу. Один на інсталяцію, як і обліковий запис Codex. */
export const codexBudget = new CodexBudget(postgresBudgetStore);

/** Тестовий шов: чистий стан і, за потреби, інше сховище (`null` — лише памʼять). */
export function resetCodexBudget(store: CodexBudgetStore | null = postgresBudgetStore): void {
  codexBudget.reset(store);
}
