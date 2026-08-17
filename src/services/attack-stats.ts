import { Counter, Histogram, type Registry } from 'prom-client';
import { Agent, fetch as undiciFetch } from 'undici';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import {
  ATTACK_STATS_DISCLAIMER, ATTACK_STATS_EXCLUDED_REGIONS, ATTACK_STATS_METHODOLOGY_VERSION,
  ATTACK_STATS_PROMPT_VERSION, ATTACK_STATS_SYSTEM_PROMPT, buildAttackStatsPrompt, parseAttackStatsReply,
  type AttackStatsSummary, type AttackStatsTask, type ForecastDay
} from '../domain/attack-stats-report.js';
import { codexChat, type CodexChatRequest, type CodexChatResult } from './codex-client.js';
import { codexFeatureEnabled, type CodexEffort } from './codex-settings.js';

/**
 * Статистика ударів і пуассонівський прогноз по регіону: черга, воркер, губернатор, читання.
 *
 * ================================================================================================
 * Форма роботи: одна черга, один запуск водночас, без таймауту
 * ================================================================================================
 *
 * Модель тут робить не абзац за секунди, а розслідування за хвилини: вебпошук по кожній частині
 * періоду, звірка кожного епізоду з двома джерелами, підрахунок і прогноз. Власник сказав прямо: на
 * цю задачу таймауту нема. Тож роботу обмежує не секундомір, а форма:
 *
 *  * **Один активний рядок на регіон** — частковий унікальний індекс міграції 048. Другий запит на
 *    той самий регіон повертає стан першого, а не другий запуск.
 *  * **Один запуск водночас у процесі** — {@link drain} тримає прапорець, і жодні два виклики моделі
 *    не йдуть паралельно з цієї поверхні.
 *  * **Денний ліміт** — {@link ATTACK_STATS_MAX_PER_DAY}, рахований із таблиці за київську добу.
 *  * **Вікно свіжості** — молодший за {@link ATTACK_STATS_REFRESH_HOURS} годин звіт віддається читачеві
 *    замість нового запуску.
 *  * **Ліміт регіонів на плановий прохід** — щоб «усі області, на які хтось підписаний» не стало
 *    восьмигодинною чергою.
 *
 * Публічний користувач НЕ викликає модель: він записує інтерес і, якщо дозволено
 * (`ATTACK_STATS_PUBLIC_REQUESTS`), ставить рядок у ту саму чергу — під тими самими лімітами.
 *
 * ================================================================================================
 * Терплячий транспорт
 * ================================================================================================
 *
 * `null` у `timeoutMs` знімає наш `AbortSignal`, але не знімає ідл-таймаутів HTTP-клієнта: undici
 * (тобто Node-овий `fetch`) обриває тіло, у якому п'ять хвилин не було жодного байта. Під час довгого
 * міркування між пошуками стрім Responses може мовчати довше, і «без таймауту» перетворилося б на
 * «п'ять хвилин тиші». Тому ця поверхня, і лише вона, ходить у Codex через власний `Agent` без
 * `headersTimeout`/`bodyTimeout` — той самий клієнт, той самий код, інший диспетчер. Це єдина
 * причина, з якої `undici` є залежністю проєкту.
 *
 * ================================================================================================
 * Що це не робить
 * ================================================================================================
 *
 * Словник модуля — SELECT над каталогом, підписками і власними двома таблицями, INSERT/UPDATE над
 * власними двома таблицями та один рядок у `system_event_log`, щоб сторінка дізналася про готовий
 * звіт. Жодного шляху до тривог, подій, оцінок ризику чи сповіщень про загрози звідси немає.
 */

// ------------------------------------------------------------------------------------------------
// Метрики
// ------------------------------------------------------------------------------------------------

export type AttackStatsOutcome =
  | 'ok' | 'inconsistent' | 'model_rejected' | 'failed' | 'fresh' | 'queued'
  | 'refused_disabled' | 'refused_daily_cap' | 'refused_public_closed';

export const attackStatsRuns = new Counter({
  name: 'threatlens_attack_stats_runs_total',
  help: 'Attack statistics requests and runs by outcome, refusals included',
  labelNames: ['outcome'],
  registers: []
});

export const attackStatsDuration = new Histogram({
  name: 'threatlens_attack_stats_run_duration_seconds',
  help: 'Wall-clock of one attack statistics model run, success or failure',
  buckets: [30, 60, 120, 300, 600, 1200, 1800, 3600, 7200],
  registers: []
});

export function registerAttackStatsMetrics(registry: Registry): void {
  if (!registry.getSingleMetric('threatlens_attack_stats_runs_total')) registry.registerMetric(attackStatsRuns);
  if (!registry.getSingleMetric('threatlens_attack_stats_run_duration_seconds')) registry.registerMetric(attackStatsDuration);
}

// ------------------------------------------------------------------------------------------------
// Терплячий fetch
// ------------------------------------------------------------------------------------------------

let patientAgent: Agent | null = null;

/**
 * `fetch` без ідл-таймаутів транспорту. Створюється ліниво: тести й інсталяції без перемикача не
 * мають тримати зайвий пул з'єднань. `connectTimeout` лишається — «не можемо з'єднатися» не має
 * висіти вічно, це не той випадок, який власник просив не обмежувати.
 */
export function patientFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  patientAgent ??= new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 });
  const patient = { ...(init ?? {}), dispatcher: patientAgent } as unknown as Parameters<typeof undiciFetch>[1];
  return undiciFetch(input as unknown as Parameters<typeof undiciFetch>[0], patient) as unknown as Promise<Response>;
}

// ------------------------------------------------------------------------------------------------
// Час і календар (за Києвом)
// ------------------------------------------------------------------------------------------------

function kyivParts(now: Date, timezone = config.APP_TIMEZONE): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    minutes: Number(value('hour')) * 60 + Number(value('minute'))
  };
}

function shiftIsoDate(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

/**
 * Завдання на сьогодні: період — цілі доби до вчора включно, прогноз — від сьогодні. Чиста функція,
 * щоб тест міг перевірити межі без бази.
 */
export function planAttackStatsTask(region: { id: string; name: string }, now = new Date(), timezone = config.APP_TIMEZONE): AttackStatsTask {
  const today = kyivParts(now, timezone).date;
  const periodTo = shiftIsoDate(today, -1);
  return {
    regionId: region.id,
    regionName: region.name,
    periodFrom: shiftIsoDate(periodTo, -(config.ATTACK_STATS_PERIOD_DAYS - 1)),
    periodTo,
    forecastFrom: today,
    forecastTo: shiftIsoDate(today, config.ATTACK_STATS_FORECAST_DAYS - 1),
    lastEpisodes: config.ATTACK_STATS_LAST_EPISODES,
    today
  };
}

// ------------------------------------------------------------------------------------------------
// Регіони
// ------------------------------------------------------------------------------------------------

export interface AttackStatsRegion { id: string; name: string }

/** 24 області та Київ, Київ першим: це регіон, для якого власник писав завдання. */
export async function attackStatsRegions(): Promise<AttackStatsRegion[]> {
  const result = await pool.query<{ id: string; name: string }>(
    `SELECT id, name_uk AS name FROM locations
      WHERE type IN ('oblast','special_city') AND NOT (id = ANY($1::text[]))
      ORDER BY (id = 'ua-80') DESC, name_uk`,
    [[...ATTACK_STATS_EXCLUDED_REGIONS]]
  );
  return result.rows;
}

// ------------------------------------------------------------------------------------------------
// Рядок звіту
// ------------------------------------------------------------------------------------------------

export type ReportStatus = 'queued' | 'running' | 'completed' | 'failed';
export type ReportVerification = 'passed' | 'inconsistent' | 'rejected' | 'skipped';
export type RequestedBy = 'scheduler' | 'operator' | 'public';

interface ReportRow {
  id: string;
  region_id: string;
  region_name: string;
  requested_by: RequestedBy;
  status: ReportStatus;
  methodology_version: string;
  prompt_version: string;
  period_from: string;
  period_to: string;
  forecast_from: string;
  forecast_to: string;
  last_episodes: number;
  queued_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  duration_ms: number | null;
  model: string | null;
  ai_run_id: string | null;
  verification: ReportVerification | null;
  rejection_reason: string | null;
  failure_reason: string | null;
  report_text: string | null;
  charts: unknown;
  summary: AttackStatsSummary | null;
}

export interface StoredAttackStatsReport {
  id: string;
  region: AttackStatsRegion;
  requestedBy: RequestedBy;
  status: ReportStatus;
  dataNature: 'calculated';
  methodologyVersion: string;
  promptVersion: string;
  period: { from: string; to: string };
  forecastPeriod: { from: string; to: string };
  lastEpisodes: number;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  model: string | null;
  aiRunId: string | null;
  verification: ReportVerification | null;
  rejectionReason: string | null;
  failureReason: string | null;
  summary: AttackStatsSummary | null;
  reportText: string | null;
  /** Сирий JSON-блок моделі — лише в операторській відповіді; публічній сторінці досить зведення. */
  charts?: unknown;
  disclaimer: string;
}

const REPORT_COLUMNS = `id, region_id, region_name, requested_by, status, methodology_version, prompt_version,
  period_from::text AS period_from, period_to::text AS period_to,
  forecast_from::text AS forecast_from, forecast_to::text AS forecast_to, last_episodes,
  queued_at, started_at, finished_at, duration_ms, model, ai_run_id, verification, rejection_reason,
  failure_reason, report_text, charts, summary`;

function toStored(row: ReportRow, options: { withText: boolean; withCharts?: boolean } = { withText: true }): StoredAttackStatsReport {
  return {
    ...(options.withCharts ? { charts: row.charts } : {}),
    id: row.id,
    region: { id: row.region_id, name: row.region_name },
    requestedBy: row.requested_by,
    status: row.status,
    dataNature: 'calculated',
    methodologyVersion: row.methodology_version,
    promptVersion: row.prompt_version,
    period: { from: row.period_from, to: row.period_to },
    forecastPeriod: { from: row.forecast_from, to: row.forecast_to },
    lastEpisodes: row.last_episodes,
    queuedAt: row.queued_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    durationMs: row.duration_ms,
    model: row.model,
    aiRunId: row.ai_run_id,
    verification: row.verification,
    rejectionReason: row.rejection_reason,
    failureReason: row.failure_reason,
    summary: row.summary,
    reportText: options.withText ? row.report_text : null,
    disclaimer: ATTACK_STATS_DISCLAIMER
  };
}

// ------------------------------------------------------------------------------------------------
// Читання
// ------------------------------------------------------------------------------------------------

/** Найсвіжіший готовий звіт по регіону, з текстом. */
export async function latestAttackStatsReport(regionId: string): Promise<StoredAttackStatsReport | null> {
  const result = await pool.query<ReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM attack_stats_reports
      WHERE region_id=$1 AND status='completed'
      ORDER BY finished_at DESC LIMIT 1`,
    [regionId]
  );
  return result.rows[0] ? toStored(result.rows[0]) : null;
}

/** Один звіт за id, з текстом і сирим JSON — для консолі. */
export async function attackStatsReportById(id: string): Promise<StoredAttackStatsReport | null> {
  const result = await pool.query<ReportRow>(`SELECT ${REPORT_COLUMNS} FROM attack_stats_reports WHERE id=$1`, [id]);
  return result.rows[0] ? toStored(result.rows[0], { withText: true, withCharts: true }) : null;
}

/** Останні звіти будь-якого статусу, без тексту — стрічка для консолі. */
export async function recentAttackStatsReports(limit = 30): Promise<StoredAttackStatsReport[]> {
  const result = await pool.query<ReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM attack_stats_reports ORDER BY queued_at DESC LIMIT $1`,
    [Math.min(Math.max(1, limit), 200)]
  );
  return result.rows.map((row) => toStored(row, { withText: false }));
}

export interface AttackStatsRegionState {
  id: string;
  name: string;
  /** Найсвіжіший готовий звіт — без тексту, лише те, що треба, щоб намалювати картку вибору. */
  latest: {
    id: string;
    finishedAt: string;
    verification: ReportVerification | null;
    forecastFrom: string;
    forecastTo: string;
    tonight: ForecastDay | null;
    attackDays: number | null;
    model: string | null;
    fresh: boolean;
  } | null;
  /** Є активний рядок — звіт у черзі або рахується просто зараз. */
  pending: { id: string; status: 'queued' | 'running'; queuedAt: string; startedAt: string | null } | null;
  /**
   * Останній завершений запуск, готовий чи ні. Відрізняється від `latest`, коли остання спроба
   * впала: сторінка тоді каже «остання спроба не вдалася», а не «звіту ще немає», бо це різні стани
   * для читача, який щойно обрав область.
   */
  lastRun: { status: 'completed' | 'failed'; finishedAt: string } | null;
  /** Скільки разів регіон обирали на сторінці. */
  selections: number;
}

export interface AttackStatsOverview {
  enabled: boolean;
  publicRequests: boolean;
  dataNature: 'calculated';
  methodologyVersion: string;
  disclaimer: string;
  periodDays: number;
  forecastDays: number;
  lastEpisodes: number;
  caps: { perDay: number; usedToday: number; refreshHours: number };
  regions: AttackStatsRegionState[];
}

/** Стан усіх регіонів одним запитом на кожну з трьох таблиць — це те, що читає селектор на сторінці. */
export async function attackStatsOverview(now = new Date()): Promise<AttackStatsOverview> {
  const [regions, latest, pending, interest, enabled, usedToday, terminal] = await Promise.all([
    attackStatsRegions(),
    pool.query<{
      id: string; region_id: string; finished_at: Date; verification: ReportVerification | null;
      forecast_from: string; forecast_to: string; model: string | null; summary: AttackStatsSummary | null;
    }>(
      `SELECT DISTINCT ON (region_id) id, region_id, finished_at, verification,
              forecast_from::text AS forecast_from, forecast_to::text AS forecast_to, model, summary
         FROM attack_stats_reports WHERE status='completed'
        ORDER BY region_id, finished_at DESC`
    ),
    pool.query<{ id: string; region_id: string; status: 'queued' | 'running'; queued_at: Date; started_at: Date | null }>(
      `SELECT id, region_id, status, queued_at, started_at FROM attack_stats_reports
        WHERE status IN ('queued','running')`
    ),
    pool.query<{ region_id: string; selections: string }>(`SELECT region_id, selections::text FROM attack_stats_interest`),
    codexFeatureEnabled('attack_stats'),
    queuedToday(now),
    pool.query<{ region_id: string; status: 'completed' | 'failed'; finished_at: Date }>(
      `SELECT DISTINCT ON (region_id) region_id, status, finished_at FROM attack_stats_reports
        WHERE status IN ('completed','failed') AND finished_at IS NOT NULL
        ORDER BY region_id, finished_at DESC`
    )
  ]);
  const latestByRegion = new Map(latest.rows.map((row) => [row.region_id, row]));
  const pendingByRegion = new Map(pending.rows.map((row) => [row.region_id, row]));
  const terminalByRegion = new Map(terminal.rows.map((row) => [row.region_id, row]));
  const selectionsByRegion = new Map(interest.rows.map((row) => [row.region_id, Number(row.selections)]));
  const freshAfter = now.getTime() - config.ATTACK_STATS_REFRESH_HOURS * 3_600_000;
  return {
    enabled,
    publicRequests: config.ATTACK_STATS_PUBLIC_REQUESTS,
    dataNature: 'calculated',
    methodologyVersion: ATTACK_STATS_METHODOLOGY_VERSION,
    disclaimer: ATTACK_STATS_DISCLAIMER,
    periodDays: config.ATTACK_STATS_PERIOD_DAYS,
    forecastDays: config.ATTACK_STATS_FORECAST_DAYS,
    lastEpisodes: config.ATTACK_STATS_LAST_EPISODES,
    caps: { perDay: config.ATTACK_STATS_MAX_PER_DAY, usedToday, refreshHours: config.ATTACK_STATS_REFRESH_HOURS },
    regions: regions.map((region) => {
      const row = latestByRegion.get(region.id);
      const active = pendingByRegion.get(region.id);
      const last = terminalByRegion.get(region.id);
      return {
        id: region.id,
        name: region.name,
        latest: row ? {
          id: row.id,
          finishedAt: row.finished_at.toISOString(),
          verification: row.verification,
          forecastFrom: row.forecast_from,
          forecastTo: row.forecast_to,
          tonight: row.summary?.tonight ?? null,
          attackDays: row.summary?.attackDays ?? null,
          model: row.model,
          fresh: row.finished_at.getTime() >= freshAfter
        } : null,
        pending: active ? {
          id: active.id, status: active.status, queuedAt: active.queued_at.toISOString(),
          startedAt: active.started_at?.toISOString() ?? null
        } : null,
        lastRun: last ? { status: last.status, finishedAt: last.finished_at.toISOString() } : null,
        selections: selectionsByRegion.get(region.id) ?? 0
      };
    })
  };
}

// ------------------------------------------------------------------------------------------------
// Губернатор
// ------------------------------------------------------------------------------------------------

async function queuedToday(now: Date): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM attack_stats_reports
      WHERE (queued_at AT TIME ZONE $2)::date = ($1::timestamptz AT TIME ZONE $2)::date`,
    [now.toISOString(), config.APP_TIMEZONE]
  );
  return Number(result.rows[0]?.count ?? 0);
}

export interface RefusalInput {
  enabled: boolean;
  requestedBy: RequestedBy;
  publicRequests: boolean;
  perDay: number;
  usedToday: number;
}

export type Refusal = 'refused_disabled' | 'refused_public_closed' | 'refused_daily_cap';

/**
 * Чиста: порядок відмов — перемикач, публічний доступ, денний ліміт. Перемикач першим, бо його не
 * змінить жодне очікування; ліміт останнім, бо він єдиний, який завтра сам собою відкриється.
 */
export function attackStatsRefusal(input: RefusalInput): Refusal | null {
  if (!input.enabled) return 'refused_disabled';
  if (input.requestedBy === 'public' && !input.publicRequests) return 'refused_public_closed';
  if (input.perDay <= 0 || input.usedToday >= input.perDay) return 'refused_daily_cap';
  return null;
}

export const REFUSAL_DETAILS: Record<Refusal, string> = {
  refused_disabled: 'Перемикач «Статистика ударів і ймовірності» вимкнено в /ops: інтерес записано, звіт не рахуватиметься, доки його не ввімкнуть.',
  refused_public_closed: 'Публічні запити вимкнено: інтерес записано, регіон потрапить у найближчий плановий прохід.',
  refused_daily_cap: 'Денний ліміт запусків вичерпано: інтерес записано, звіт порахується завтра.'
};

// ------------------------------------------------------------------------------------------------
// Запит: інтерес → свіжий звіт | черга | відмова
// ------------------------------------------------------------------------------------------------

export type RequestOutcome =
  | { outcome: 'invalid_region' }
  | { outcome: 'fresh'; report: StoredAttackStatsReport }
  | { outcome: 'queued' | 'running'; reportId: string; position: number }
  | { outcome: Refusal; detail: string; latest: StoredAttackStatsReport | null };

export interface RequestOptions {
  /** Оператор: не зважати на вікно свіжості. Ліміт і перемикач діють однаково для всіх. */
  force?: boolean;
  now?: Date;
  /** Тестовий шов: перемикач без бази. */
  featureEnabled?: () => Promise<boolean>;
  /** Тестовий шов: не будити воркер після постановки в чергу. */
  kick?: boolean;
}

export async function requestAttackStats(
  regionId: string, requestedBy: RequestedBy, options: RequestOptions = {}
): Promise<RequestOutcome> {
  const now = options.now ?? new Date();
  const regions = await attackStatsRegions();
  const region = regions.find((item) => item.id === regionId);
  if (!region) return { outcome: 'invalid_region' };

  // Інтерес записується ДО будь-якої відмови: вибір користувача — це факт, який має пережити й
  // вимкнений перемикач, і вичерпаний ліміт, бо саме з нього завтрашній прохід дізнається, що рахувати.
  if (requestedBy === 'public') {
    await pool.query(
      `INSERT INTO attack_stats_interest(region_id) VALUES ($1)
       ON CONFLICT (region_id) DO UPDATE SET last_selected_at=now(), selections=attack_stats_interest.selections+1`,
      [regionId]
    );
  }

  const active = await pool.query<{ id: string; status: 'queued' | 'running'; position: string }>(
    `SELECT id, status,
            (SELECT count(*) FROM attack_stats_reports q WHERE q.status='queued' AND q.queued_at <= r.queued_at)::text AS position
       FROM attack_stats_reports r WHERE region_id=$1 AND status IN ('queued','running') LIMIT 1`,
    [regionId]
  );
  if (active.rows[0]) {
    attackStatsRuns.inc({ outcome: 'queued' });
    return { outcome: active.rows[0].status, reportId: active.rows[0].id, position: Number(active.rows[0].position) };
  }

  const latest = await latestAttackStatsReport(regionId);
  const freshAfter = now.getTime() - config.ATTACK_STATS_REFRESH_HOURS * 3_600_000;
  if (!options.force && latest?.finishedAt && Date.parse(latest.finishedAt) >= freshAfter) {
    attackStatsRuns.inc({ outcome: 'fresh' });
    return { outcome: 'fresh', report: latest };
  }

  const enabled = await (options.featureEnabled ?? (() => codexFeatureEnabled('attack_stats')))();
  const refusal = attackStatsRefusal({
    enabled, requestedBy, publicRequests: config.ATTACK_STATS_PUBLIC_REQUESTS,
    perDay: config.ATTACK_STATS_MAX_PER_DAY, usedToday: await queuedToday(now)
  });
  if (refusal) {
    attackStatsRuns.inc({ outcome: refusal });
    return { outcome: refusal, detail: REFUSAL_DETAILS[refusal], latest };
  }

  const queued = await enqueue(region, requestedBy, now);
  if (!queued) {
    // Гонка з другим запитом на той самий регіон: унікальний індекс відкинув вставку, а отже, рядок
    // уже є, і відповідь про нього — правильна відповідь.
    return requestAttackStats(regionId, requestedBy, { ...options, kick: false });
  }
  attackStatsRuns.inc({ outcome: 'queued' });
  if (options.kick !== false) void drain();
  return { outcome: 'queued', reportId: queued.id, position: queued.position };
}

async function enqueue(region: AttackStatsRegion, requestedBy: RequestedBy, now: Date): Promise<{ id: string; position: number } | null> {
  const task = planAttackStatsTask(region, now);
  const inserted = await pool.query<{ id: string; position: string }>(
    `WITH inserted AS (
       INSERT INTO attack_stats_reports(region_id, region_name, requested_by, status, methodology_version, prompt_version,
                                        period_from, period_to, forecast_from, forecast_to, last_episodes, queued_at)
       VALUES ($1,$2,$3,'queued',$4,$5,$6::date,$7::date,$8::date,$9::date,$10,$11::timestamptz)
       ON CONFLICT DO NOTHING
       RETURNING id, queued_at)
     SELECT id,
            -- The row this statement inserts is not visible to the subselect (data-modifying CTE), so
            -- the count is «rows ahead of it», and the position is that plus one.
            ((SELECT count(*) FROM attack_stats_reports q WHERE q.status='queued' AND q.queued_at <= inserted.queued_at) + 1)::text AS position
       FROM inserted`,
    [region.id, region.name, requestedBy, ATTACK_STATS_METHODOLOGY_VERSION, ATTACK_STATS_PROMPT_VERSION,
      task.periodFrom, task.periodTo, task.forecastFrom, task.forecastTo, task.lastEpisodes, now.toISOString()]
  );
  const row = inserted.rows[0];
  return row ? { id: row.id, position: Number(row.position) } : null;
}

// ------------------------------------------------------------------------------------------------
// Воркер
// ------------------------------------------------------------------------------------------------

export interface AttackStatsRunDeps {
  /** Тестовий шов: замість `codexChat`. */
  chat?: (request: CodexChatRequest) => Promise<CodexChatResult>;
  featureEnabled?: () => Promise<boolean>;
  now?: () => Date;
}

export interface AttackStatsRunResult {
  reportId: string;
  regionId: string;
  outcome: 'ok' | 'inconsistent' | 'model_rejected' | 'failed';
  durationMs: number;
}

let draining = false;

/**
 * Залежності, з якими осушує чергу «розбуджений» воркер — той, що стартує з `requestAttackStats`
 * і з тику планувальника, без явних параметрів. У бою це порожній об'єкт (справжній `codexChat`,
 * справжній перемикач); інтеграційні тести підставляють сюди заглушку моделі, бо кнопка на сторінці
 * будить воркер сама, і тест не має способу передати їй параметри інакше.
 */
let workerDefaults: AttackStatsRunDeps = {};

export function setAttackStatsWorkerDefaults(deps: AttackStatsRunDeps): void {
  workerDefaults = deps;
}

/**
 * Обробляє чергу до порожньої, по одному звіту, послідовно. Прапорець — це і є «один запуск
 * водночас»; виклик, що застав прапорець піднятим, просто виходить: рядок, який він хотів
 * обробити, підбере той прохід, що вже йде.
 */
export async function drain(deps: AttackStatsRunDeps = workerDefaults, log?: { info: Function; error: Function }): Promise<AttackStatsRunResult[]> {
  if (draining) return [];
  draining = true;
  const results: AttackStatsRunResult[] = [];
  try {
    for (;;) {
      const result = await runNextAttackStats(deps);
      if (!result) break;
      results.push(result);
      log?.info({ ...result }, 'attack statistics run finished');
    }
  } catch (error) {
    log?.error({ error }, 'attack statistics drain failed');
  } finally {
    draining = false;
  }
  return results;
}

/** Бере найстаріший `queued`, позначає `running` і виконує. `null` — черга порожня. */
export async function runNextAttackStats(deps: AttackStatsRunDeps = {}): Promise<AttackStatsRunResult | null> {
  const claimed = await pool.query<ReportRow>(
    `UPDATE attack_stats_reports SET status='running', started_at=now()
      WHERE id = (SELECT id FROM attack_stats_reports WHERE status='queued' ORDER BY queued_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING ${REPORT_COLUMNS}`
  );
  const row = claimed.rows[0];
  if (!row) return null;
  return runClaimedReport(row, deps);
}

async function runClaimedReport(row: ReportRow, deps: AttackStatsRunDeps): Promise<AttackStatsRunResult> {
  const startedAt = (deps.now ?? (() => new Date()))();
  const task: AttackStatsTask = {
    regionId: row.region_id, regionName: row.region_name,
    periodFrom: row.period_from, periodTo: row.period_to,
    forecastFrom: row.forecast_from, forecastTo: row.forecast_to,
    lastEpisodes: row.last_episodes,
    today: kyivParts(startedAt).date
  };

  const enabled = await (deps.featureEnabled ?? (() => codexFeatureEnabled('attack_stats')))();
  if (!enabled) {
    // Перемикач вимкнули між постановкою в чергу і запуском. Це не збій моделі — це губернатор, і
    // рядок каже саме це.
    return finishFailed(row, startedAt, 'refused_disabled: перемикач вимкнено після постановки в чергу', 0);
  }

  const chat = deps.chat ?? ((request: CodexChatRequest) => codexChat(request, { fetchImpl: patientFetch as typeof fetch }));
  const prompt = buildAttackStatsPrompt(task);
  const effort = config.ATTACK_STATS_REASONING_EFFORT || undefined;
  const result = await chat({
    promptVersion: ATTACK_STATS_PROMPT_VERSION,
    surface: 'attack_stats',
    system: ATTACK_STATS_SYSTEM_PROMPT,
    user: prompt,
    json: false,
    // `null` — без AbortSignal (див. codex-client). Додатне значення — стеля оператора.
    timeoutMs: config.ATTACK_STATS_TIMEOUT_MS > 0 ? config.ATTACK_STATS_TIMEOUT_MS : null,
    tools: config.ATTACK_STATS_WEB_SEARCH_TOOL ? [{ type: config.ATTACK_STATS_WEB_SEARCH_TOOL }] : [],
    reasoningEffort: effort as CodexEffort | undefined,
    auditInput: {
      task, promptVersion: ATTACK_STATS_PROMPT_VERSION,
      webSearchTool: config.ATTACK_STATS_WEB_SEARCH_TOOL || null,
      timeoutMs: config.ATTACK_STATS_TIMEOUT_MS || null,
      prompt
    }
  }).catch((error: unknown): CodexChatResult => ({
    ok: false, reason: 'transport_error', detail: String(error).slice(0, 300), model: null, durationMs: 0
  }));

  const durationMs = Math.max(0, (deps.now ?? (() => new Date()))().getTime() - startedAt.getTime()) || result.durationMs;
  attackStatsDuration.observe(durationMs / 1000);

  if (!result.ok) {
    return finishFailed(row, startedAt, `${result.reason}: ${result.detail}`, durationMs, result.model);
  }

  const parsed = parseAttackStatsReply(result.content, task);
  const verification: ReportVerification = parsed.summary
    ? parsed.summary.verification
    : 'rejected';
  const aiRunId = await claimAiRun(startedAt);
  await pool.query(
    `UPDATE attack_stats_reports
        SET status='completed', finished_at=now(), duration_ms=$2, model=$3, ai_run_id=$4,
            verification=$5, rejection_reason=$6, report_text=$7, charts=$8::jsonb, summary=$9::jsonb
      WHERE id=$1`,
    [row.id, durationMs, result.model, aiRunId, verification, parsed.rejectionReason,
      result.content, parsed.charts ? JSON.stringify(parsed.charts) : null,
      parsed.summary ? JSON.stringify(parsed.summary) : null]
  );
  const outcome = verification === 'passed' ? 'ok' : verification === 'inconsistent' ? 'inconsistent' : 'model_rejected';
  attackStatsRuns.inc({ outcome });
  await announce(row, 'completed', verification);
  return { reportId: row.id, regionId: row.region_id, outcome, durationMs };
}

async function finishFailed(
  row: ReportRow, startedAt: Date, reason: string, durationMs: number, model: string | null = null
): Promise<AttackStatsRunResult> {
  const aiRunId = await claimAiRun(startedAt);
  await pool.query(
    `UPDATE attack_stats_reports
        SET status='failed', finished_at=now(), duration_ms=$2, model=$3, ai_run_id=$4,
            verification='skipped', failure_reason=$5
      WHERE id=$1`,
    [row.id, durationMs, model, aiRunId, reason.slice(0, 500)]
  );
  attackStatsRuns.inc({ outcome: 'failed' });
  await announce(row, 'failed', 'skipped');
  return { reportId: row.id, regionId: row.region_id, outcome: 'failed', durationMs };
}

/** Останній `ai_runs` цієї поверхні з моменту старту — best effort, як у тактики й дослідження. */
async function claimAiRun(since: Date): Promise<string | null> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM ai_runs WHERE surface='attack_stats' AND created_at >= $1 ORDER BY created_at DESC LIMIT 1`,
    [since.toISOString()]
  ).catch(() => ({ rows: [] as Array<{ id: string }> }));
  return result.rows[0]?.id ?? null;
}

/** Один рядок у журнал подій: сторінка перечитує стан регіонів, побачивши `attack_stats.updated`. */
async function announce(row: ReportRow, status: 'completed' | 'failed', verification: ReportVerification): Promise<void> {
  await pool.query(
    `INSERT INTO system_event_log(event_type,payload) VALUES ('attack_stats.updated',$1::jsonb)`,
    [JSON.stringify({ reportId: row.id, regionId: row.region_id, status, verification })]
  ).catch(() => undefined);
}

// ------------------------------------------------------------------------------------------------
// Плановий прохід
// ------------------------------------------------------------------------------------------------

const DAILY_PASS_WORKER = 'attack-stats-daily-pass';

/**
 * Регіони, які варто рахувати, у порядку зацікавленості: скільки чатів з увімкненою аналітикою
 * підписані на цю область (або на щось усередині неї), потім — коли востаннє обирали на сторінці.
 * Один запит, рекурсія по каталогу вгору до області, обмежена глибиною.
 */
export async function regionsOfInterest(): Promise<Array<{ id: string; name: string; chats: number; lastSelectedAt: string | null }>> {
  const result = await pool.query<{ id: string; name: string; chats: string; last_selected_at: Date | null }>(
    `WITH RECURSIVE climb(chat_id, id, parent_id, type, depth) AS (
       SELECT s.chat_id, l.id, l.parent_id, l.type, 0
         FROM subscriptions s
         JOIN telegram_users u ON u.chat_id=s.chat_id AND u.enabled
         JOIN locations l ON l.id=s.location_id
        WHERE s.enabled AND s.notify_analytics
       UNION ALL
       SELECT c.chat_id, p.id, p.parent_id, p.type, c.depth+1
         FROM climb c JOIN locations p ON p.id=c.parent_id
        WHERE c.type NOT IN ('oblast','special_city','country') AND c.depth < 8
     ), subscribed AS (
       SELECT id, count(DISTINCT chat_id)::text AS chats FROM climb
        WHERE type IN ('oblast','special_city') GROUP BY id
     )
     SELECT l.id, l.name_uk AS name, COALESCE(sub.chats,'0') AS chats, i.last_selected_at
       FROM locations l
       LEFT JOIN subscribed sub ON sub.id=l.id
       LEFT JOIN attack_stats_interest i ON i.region_id=l.id
      WHERE l.type IN ('oblast','special_city') AND NOT (l.id = ANY($1::text[]))
        AND (sub.id IS NOT NULL OR i.region_id IS NOT NULL)
      ORDER BY COALESCE(sub.chats,'0')::int DESC, i.last_selected_at DESC NULLS LAST, l.name_uk`,
    [[...ATTACK_STATS_EXCLUDED_REGIONS]]
  );
  return result.rows.map((row) => ({
    id: row.id, name: row.name, chats: Number(row.chats), lastSelectedAt: row.last_selected_at?.toISOString() ?? null
  }));
}

export interface DailyPassResult {
  ran: boolean;
  queued: string[];
  skippedFresh: string[];
  skippedActive: string[];
  refused: Refusal | null;
}

/**
 * Один прохід на київську добу, після `ATTACK_STATS_RUN_TIME`. Ставить у чергу до
 * `ATTACK_STATS_MAX_REGIONS_PER_PASS` регіонів зацікавленості, пропускаючи свіжі й уже активні, у
 * межах денного ліміту. Стан «сьогодні вже було» — у `worker_state`, тож перезапуск процесу після
 * проходу не запускає його вдруге.
 */
export async function runAttackStatsDailyPass(now = new Date(), options: { force?: boolean; featureEnabled?: () => Promise<boolean> } = {}): Promise<DailyPassResult> {
  const parts = kyivParts(now);
  const [hour, minute] = config.ATTACK_STATS_RUN_TIME.split(':').map(Number);
  const dayStamp = Number(parts.date.replaceAll('-', ''));
  const nothing: DailyPassResult = { ran: false, queued: [], skippedFresh: [], skippedActive: [], refused: null };
  if (!options.force) {
    if (parts.minutes < hour! * 60 + minute!) return nothing;
    const state = await pool.query<{ cursor_value: string }>(
      `SELECT cursor_value::text FROM worker_state WHERE worker_name=$1`, [DAILY_PASS_WORKER]
    );
    if (Number(state.rows[0]?.cursor_value ?? 0) >= dayStamp) return nothing;
  }
  await pool.query(
    `INSERT INTO worker_state(worker_name,cursor_value,updated_at) VALUES ($1,$2,now())
     ON CONFLICT (worker_name) DO UPDATE SET cursor_value=EXCLUDED.cursor_value, updated_at=now()`,
    [DAILY_PASS_WORKER, dayStamp]
  );

  const enabled = await (options.featureEnabled ?? (() => codexFeatureEnabled('attack_stats')))();
  const result: DailyPassResult = { ran: true, queued: [], skippedFresh: [], skippedActive: [], refused: null };
  if (!enabled) { result.refused = 'refused_disabled'; return result; }

  const [candidates, latest, pending] = await Promise.all([
    regionsOfInterest(),
    pool.query<{ region_id: string; finished_at: Date }>(
      `SELECT DISTINCT ON (region_id) region_id, finished_at FROM attack_stats_reports
        WHERE status='completed' ORDER BY region_id, finished_at DESC`
    ),
    pool.query<{ region_id: string }>(`SELECT region_id FROM attack_stats_reports WHERE status IN ('queued','running')`)
  ]);
  const freshAfter = now.getTime() - config.ATTACK_STATS_REFRESH_HOURS * 3_600_000;
  const fresh = new Set(latest.rows.filter((row) => row.finished_at.getTime() >= freshAfter).map((row) => row.region_id));
  const active = new Set(pending.rows.map((row) => row.region_id));
  let usedToday = await queuedToday(now);

  for (const region of candidates) {
    if (result.queued.length >= config.ATTACK_STATS_MAX_REGIONS_PER_PASS) break;
    if (active.has(region.id)) { result.skippedActive.push(region.id); continue; }
    if (fresh.has(region.id)) { result.skippedFresh.push(region.id); continue; }
    if (config.ATTACK_STATS_MAX_PER_DAY <= 0 || usedToday >= config.ATTACK_STATS_MAX_PER_DAY) {
      result.refused = 'refused_daily_cap';
      attackStatsRuns.inc({ outcome: 'refused_daily_cap' });
      break;
    }
    const queued = await enqueue({ id: region.id, name: region.name }, 'scheduler', now);
    if (queued) { result.queued.push(region.id); usedToday += 1; attackStatsRuns.inc({ outcome: 'queued' }); }
  }
  return result;
}

// ------------------------------------------------------------------------------------------------
// Господарство і планувальник
// ------------------------------------------------------------------------------------------------

/** Запуск, який процес не пережив, не може завершитися: позначаємо, щоб регіон не завис назавжди. */
export async function failInterruptedRuns(): Promise<number> {
  const result = await pool.query(
    `UPDATE attack_stats_reports
        SET status='failed', finished_at=now(), verification='skipped', failure_reason='interrupted: процес перезапущено під час запуску'
      WHERE status='running'`
  );
  return result.rowCount ?? 0;
}

export async function pruneAttackStats(days = config.ATTACK_STATS_RETENTION_DAYS): Promise<number> {
  const result = await pool.query(
    `DELETE FROM attack_stats_reports WHERE queued_at < now() - make_interval(days => $1::int) AND status IN ('completed','failed')`,
    [days]
  );
  return result.rowCount ?? 0;
}

const TICK_MS = 60_000;

/**
 * Раз на хвилину: плановий прохід (якщо його час і сьогодні ще не було), потім осушення черги. Черга
 * осушується і поза розкладом — {@link requestAttackStats} будить її сама, — тож тик тут лише
 * підстраховка на випадок, коли запуск застав `draining` піднятим і рядок лишився чекати.
 */
export function startAttackStatsScheduler(log: { info: Function; error: Function }): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const pass = await runAttackStatsDailyPass();
      if (pass.ran) {
        log.info({ ...pass }, 'attack statistics daily pass');
        const pruned = await pruneAttackStats();
        if (pruned) log.info({ pruned }, 'attack statistics reports pruned');
      }
      await drain({}, log);
    } catch (error) {
      log.error({ error }, 'attack statistics tick failed');
    }
  };
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  void failInterruptedRuns()
    .then((count) => { if (count) log.info({ count }, 'attack statistics runs interrupted by restart marked failed'); })
    .catch((error) => log.error({ error }, 'attack statistics restart housekeeping failed'))
    .finally(() => void tick());
  return () => { stopped = true; clearInterval(timer); };
}

// ------------------------------------------------------------------------------------------------
// Дайджест
// ------------------------------------------------------------------------------------------------

export interface AttackStatsDigestEntry {
  regionId: string;
  regionName: string;
  reportId: string;
  finishedAt: string;
  model: string | null;
  verification: ReportVerification;
  summary: AttackStatsSummary;
}

/**
 * Найсвіжіший придатний звіт по кожному з регіонів — для нічної аналітики бота. Придатний означає
 * `passed` або `inconsistent` (обидва мають зведення; `inconsistent` несе позначку) і не старіший за
 * `maxAgeHours`: у розсилку не має потрапити позавчорашній прогноз, у якого «найближча ніч» уже минула.
 */
export async function attackStatsForDigest(regionIds: readonly string[], maxAgeHours = 36): Promise<Map<string, AttackStatsDigestEntry>> {
  if (!regionIds.length) return new Map();
  const result = await pool.query<{
    id: string; region_id: string; region_name: string; finished_at: Date; model: string | null;
    verification: 'passed' | 'inconsistent'; summary: AttackStatsSummary;
  }>(
    `SELECT DISTINCT ON (region_id) id, region_id, region_name, finished_at, model, verification, summary
       FROM attack_stats_reports
      WHERE region_id = ANY($1::text[]) AND status='completed' AND verification IN ('passed','inconsistent')
        AND summary IS NOT NULL AND finished_at >= now() - make_interval(hours => $2::int)
      ORDER BY region_id, finished_at DESC`,
    [[...regionIds], maxAgeHours]
  );
  return new Map(result.rows.map((row) => [row.region_id, {
    regionId: row.region_id, regionName: row.region_name, reportId: row.id,
    finishedAt: row.finished_at.toISOString(), model: row.model, verification: row.verification, summary: row.summary
  }]));
}

/**
 * Область (або Київ) над кожною з підписаних локацій — щоб підписка на район чи громаду отримала
 * статистику своєї області. Одним запитом на всі локації, рекурсія вгору обмежена глибиною.
 */
export async function regionsForLocations(locationIds: readonly string[]): Promise<Map<string, string>> {
  if (!locationIds.length) return new Map();
  const result = await pool.query<{ origin: string; region_id: string }>(
    `WITH RECURSIVE climb(origin, id, parent_id, type, depth) AS (
       SELECT l.id, l.id, l.parent_id, l.type, 0 FROM locations l WHERE l.id = ANY($1::text[])
       UNION ALL
       SELECT c.origin, p.id, p.parent_id, p.type, c.depth+1
         FROM climb c JOIN locations p ON p.id=c.parent_id
        WHERE c.type NOT IN ('oblast','special_city','country') AND c.depth < 8
     )
     SELECT DISTINCT ON (origin) origin, id AS region_id FROM climb
      WHERE type IN ('oblast','special_city') AND NOT (id = ANY($2::text[]))
      ORDER BY origin, depth`,
    [[...locationIds], [...ATTACK_STATS_EXCLUDED_REGIONS]]
  );
  return new Map(result.rows.map((row) => [row.origin, row.region_id]));
}

/** Тестовий шов: скидає прапорець осушення й залежності воркера між тестами. */
export function resetAttackStatsWorker(): void {
  draining = false;
  workerDefaults = {};
}
