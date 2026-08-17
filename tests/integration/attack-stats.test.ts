import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CITY_IN_OBLAST, OBLAST, OTHER_OBLAST, ensureMigrated, integrationDatabaseAvailable, outboxRows,
  resetDatabase, seedSubscription, seedUser, sql
} from '../helpers/db.js';
import { ATTACK_STATS_DISCLAIMER } from '../../src/domain/attack-stats-report.js';

/**
 * Статистика ударів і ймовірності — черга, воркер, губернатор, читання, дайджест і маршрути проти
 * справжнього Postgres.
 *
 * Чиста частина (промт, розбір, Пуассон) — у `src/domain/attack-stats-report.test.ts`. Тут — те, що
 * фейк довести не може: частковий унікальний індекс як дедуплікація черги, ліміт, рахований із
 * таблиці, підняття підписки на район до області, рядок outbox без `assessment_id`.
 */

const KYIV = 'ua-80';
const OPS_AUTH = `Basic ${Buffer.from('operator:change-me').toString('base64')}`;
const NOW = new Date('2026-08-17T15:00:00.000Z'); // 18:00 за Києвом, до планового проходу о 20:30

function goodReply(regionName = 'Київ'): string {
  return [
    '## Таблиця епізодів',
    '| Дата | Час | Засоби | Комбінована | Джерела | Примітки |',
    '```json',
    JSON.stringify({
      region: regionName,
      episodes: [
        { date: '2026-07-20', start: '02:10', end: '05:00', weapons: ['ballistic', 'uav'], combined: true, sources: ['https://suspilne.media/x'] },
        { date: '2026-08-01', start: '23:40', end: null, weapons: ['uav'], combined: false, sources: ['https://www.ukrinform.ua/y'] }
      ],
      calendar: [{ date: '2026-07-20', attack: true }, { date: '2026-08-01', attack: true }],
      hourly: [{ hour: 2, count: 1 }, { hour: 23, count: 1 }],
      weapons: { ballistic: 0.5, cruise: 0, uav: 0.5 },
      metrics: [{ label: 'Період', attack_days: 2, night_share: 0.5, ballistic_share: 0.5, intervals_days: [12] }],
      intervals_days: [12, 3, 5, 2, 4, 3, 6, 2],
      lambda_per_day: 0.216,
      forecast: [
        { date: '2026-08-17', p: 0.19, level: 'low' }, { date: '2026-08-18', p: 0.2, level: 'low' },
        { date: '2026-08-19', p: 0.35, level: 'medium' }
      ],
      conclusions: ['Перший висновок.', 'Другий.', 'Третій.', 'Четвертий.', 'П’ятий.'],
      assumptions: ['Пуассонівський процес.']
    }),
    '```',
    `Дисклеймер: ${ATTACK_STATS_DISCLAIMER}`
  ].join('\n');
}

const enabled = async () => true;
const chatOk = async () => ({ ok: true as const, content: goodReply(), model: 'gpt-5.2', durationMs: 4200 });

async function switchOn(): Promise<void> {
  await sql(`UPDATE codex_settings SET attack_stats_enabled=true WHERE singleton`);
}

async function service() {
  return import('../../src/services/attack-stats.js');
}

describe.skipIf(!integrationDatabaseAvailable)('attack statistics', () => {
  beforeAll(async () => { await ensureMigrated(); });
  beforeEach(async () => {
    await resetDatabase();
    const { resetAttackStatsWorker } = await service();
    resetAttackStatsWorker();
  });

  // ----------------------------------------------------------------------------------------------
  describe('regions and requests', () => {
    it('offers the 24 oblasts and Kyiv, Kyiv first, and never Crimea or Sevastopol', async () => {
      const { attackStatsRegions } = await service();
      const regions = await attackStatsRegions();
      expect(regions[0]).toEqual({ id: KYIV, name: 'Київ' });
      expect(regions.length).toBe(25);
      expect(regions.map((region) => region.id)).not.toContain('ua-43');
      expect(regions.map((region) => region.id)).not.toContain('ua-85');
    });

    it('records the interest even when the switch refuses, so tomorrow’s pass knows what to compute', async () => {
      const { requestAttackStats } = await service();
      const outcome = await requestAttackStats(KYIV, 'public', { now: NOW, kick: false });
      expect(outcome.outcome).toBe('refused_disabled');
      const interest = await sql<{ region_id: string; selections: string }>(`SELECT region_id, selections::text FROM attack_stats_interest`);
      expect(interest.rows).toEqual([{ region_id: KYIV, selections: '1' }]);
      await requestAttackStats(KYIV, 'public', { now: NOW, kick: false });
      expect((await sql<{ selections: string }>(`SELECT selections::text FROM attack_stats_interest`)).rows[0]!.selections).toBe('2');
      // Відмова не пише рядка звіту: ліміт рахується з поставлених у чергу, а не з натискань.
      expect((await sql(`SELECT 1 FROM attack_stats_reports`)).rowCount).toBe(0);
    });

    it('rejects an unknown region without touching anything', async () => {
      const { requestAttackStats } = await service();
      expect((await requestAttackStats('ua-43', 'public', { now: NOW, kick: false })).outcome).toBe('invalid_region');
      expect((await requestAttackStats('ua-99', 'operator', { now: NOW, kick: false })).outcome).toBe('invalid_region');
      expect((await sql(`SELECT 1 FROM attack_stats_interest`)).rowCount).toBe(0);
    });

    it('queues once per region: the second request answers with the first row', async () => {
      await switchOn();
      const { requestAttackStats } = await service();
      const first = await requestAttackStats(KYIV, 'public', { now: NOW, kick: false });
      expect(first.outcome).toBe('queued');
      const second = await requestAttackStats(KYIV, 'public', { now: NOW, kick: false });
      expect(second).toMatchObject({ outcome: 'queued', reportId: (first as { reportId: string }).reportId, position: 1 });
      const other = await requestAttackStats(OTHER_OBLAST, 'public', { now: NOW, kick: false });
      expect(other).toMatchObject({ outcome: 'queued', position: 2 });
      expect((await sql(`SELECT 1 FROM attack_stats_reports WHERE status='queued'`)).rowCount).toBe(2);
    });

    it('closes the public door and counts the daily cap from the table', async () => {
      await switchOn();
      const { requestAttackStats } = await service();
      const { config } = await import('../../src/config.js');
      const publicRequests = config.ATTACK_STATS_PUBLIC_REQUESTS;
      const perDay = config.ATTACK_STATS_MAX_PER_DAY;
      try {
        config.ATTACK_STATS_PUBLIC_REQUESTS = false;
        expect((await requestAttackStats(KYIV, 'public', { now: NOW, kick: false })).outcome).toBe('refused_public_closed');
        // Оператора зачинені двері не стосуються.
        expect((await requestAttackStats(KYIV, 'operator', { now: NOW, kick: false })).outcome).toBe('queued');
        config.ATTACK_STATS_PUBLIC_REQUESTS = true;
        config.ATTACK_STATS_MAX_PER_DAY = 1;
        expect((await requestAttackStats(OTHER_OBLAST, 'public', { now: NOW, kick: false })).outcome).toBe('refused_daily_cap');
      } finally {
        config.ATTACK_STATS_PUBLIC_REQUESTS = publicRequests;
        config.ATTACK_STATS_MAX_PER_DAY = perDay;
      }
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('the worker', () => {
    it('runs the oldest queued row, stores a passed report, and tells the page through the event log', async () => {
      await switchOn();
      const { requestAttackStats, runNextAttackStats, latestAttackStatsReport } = await service();
      await requestAttackStats(KYIV, 'public', { now: NOW, kick: false });

      let request: { user: string; timeoutMs?: number | null; tools?: unknown; surface: string } | null = null;
      const result = await runNextAttackStats({
        featureEnabled: enabled,
        chat: async (req) => { request = req as never; return chatOk(); }
      });
      expect(result).toMatchObject({ regionId: KYIV, outcome: 'ok' });
      // Що саме поїхало моделі: промт по Києву, вебпошук, без сигналу таймауту.
      expect(request!.surface).toBe('attack_stats');
      expect(request!.user).toContain('по місту Київ');
      expect(request!.timeoutMs).toBeNull();
      expect(request!.tools).toEqual([{ type: 'web_search' }]);

      const stored = (await latestAttackStatsReport(KYIV))!;
      expect(stored.status).toBe('completed');
      expect(stored.verification).toBe('passed');
      expect(stored.model).toBe('gpt-5.2');
      expect(stored.summary!.tonight).toEqual({ date: '2026-08-17', p: 0.19, level: 'low' });
      expect(stored.summary!.attackDays).toBe(2);
      expect(stored.reportText).toContain('Таблиця епізодів');
      expect(stored.disclaimer).toBe(ATTACK_STATS_DISCLAIMER);
      // Публічна форма не несе сирого JSON — його читає лише консоль.
      expect('charts' in stored).toBe(false);

      const events = await sql<{ payload: { regionId: string; status: string } }>(
        `SELECT payload FROM system_event_log WHERE event_type='attack_stats.updated'`
      );
      expect(events.rows.map((row) => row.payload)).toEqual([{ reportId: stored.id, regionId: KYIV, status: 'completed', verification: 'passed' }]);
      // Черга порожня.
      expect(await runNextAttackStats({ featureEnabled: enabled, chat: chatOk })).toBeNull();
    });

    it('answers a fresh report instead of queueing again, and forces one for the operator', async () => {
      await switchOn();
      const { requestAttackStats, runNextAttackStats } = await service();
      await requestAttackStats(KYIV, 'public', { now: NOW, kick: false });
      await runNextAttackStats({ featureEnabled: enabled, chat: chatOk });
      const again = await requestAttackStats(KYIV, 'public', { now: NOW, kick: false });
      expect(again.outcome).toBe('fresh');
      expect((again as { report: { verification: string } }).report.verification).toBe('passed');
      const forced = await requestAttackStats(KYIV, 'operator', { now: NOW, kick: false, force: true });
      expect(forced.outcome).toBe('queued');
    });

    it('records a model failure as failed with the reason, and never as a report', async () => {
      await switchOn();
      const { requestAttackStats, runNextAttackStats, latestAttackStatsReport } = await service();
      await requestAttackStats(KYIV, 'public', { now: NOW, kick: false });
      const result = await runNextAttackStats({
        featureEnabled: enabled,
        chat: async () => ({ ok: false as const, reason: 'transport_error' as const, detail: 'ECONNRESET', model: 'gpt-5.2', durationMs: 10 })
      });
      expect(result?.outcome).toBe('failed');
      const row = await sql<{ status: string; verification: string; failure_reason: string }>(
        `SELECT status, verification, failure_reason FROM attack_stats_reports`
      );
      expect(row.rows[0]).toEqual({ status: 'failed', verification: 'skipped', failure_reason: 'transport_error: ECONNRESET' });
      expect(await latestAttackStatsReport(KYIV)).toBeNull();
    });

    it('keeps a reply without a JSON block as rejected text, which the digest then ignores', async () => {
      await switchOn();
      const { requestAttackStats, runNextAttackStats, latestAttackStatsReport, attackStatsForDigest } = await service();
      await requestAttackStats(KYIV, 'public', { now: NOW, kick: false });
      const result = await runNextAttackStats({
        featureEnabled: enabled,
        chat: async () => ({ ok: true as const, content: 'Проза без жодного блоку даних.', model: 'gpt-5.2', durationMs: 10 })
      });
      expect(result?.outcome).toBe('model_rejected');
      const stored = (await latestAttackStatsReport(KYIV))!;
      expect(stored.verification).toBe('rejected');
      expect(stored.rejectionReason).toBe('json_block_missing');
      expect(stored.summary).toBeNull();
      expect((await attackStatsForDigest([KYIV])).size).toBe(0);
    });

    it('fails a row the switch was turned off under, and one a restart interrupted', async () => {
      await switchOn();
      const { requestAttackStats, runNextAttackStats, failInterruptedRuns } = await service();
      await requestAttackStats(KYIV, 'public', { now: NOW, kick: false });
      const result = await runNextAttackStats({ featureEnabled: async () => false, chat: chatOk });
      expect(result?.outcome).toBe('failed');
      expect((await sql<{ failure_reason: string }>(`SELECT failure_reason FROM attack_stats_reports`)).rows[0]!.failure_reason)
        .toContain('refused_disabled');

      await requestAttackStats(OTHER_OBLAST, 'public', { now: NOW, kick: false });
      await sql(`UPDATE attack_stats_reports SET status='running', started_at=now() WHERE region_id=$1`, [OTHER_OBLAST]);
      expect(await failInterruptedRuns()).toBe(1);
      const interrupted = await sql<{ status: string; failure_reason: string }>(
        `SELECT status, failure_reason FROM attack_stats_reports WHERE region_id=$1`, [OTHER_OBLAST]
      );
      expect(interrupted.rows[0]!.status).toBe('failed');
      expect(interrupted.rows[0]!.failure_reason).toContain('interrupted');
    });

    it('holds one active row per region by constraint, not by convention', async () => {
      await sql(
        `INSERT INTO attack_stats_reports(region_id,region_name,requested_by,status,methodology_version,prompt_version,
           period_from,period_to,forecast_from,forecast_to,last_episodes)
         VALUES ($1,'Київ','operator','queued','t','t','2026-07-01','2026-08-16','2026-08-17','2026-08-31',15)`, [KYIV]
      );
      await expect(sql(
        `INSERT INTO attack_stats_reports(region_id,region_name,requested_by,status,methodology_version,prompt_version,
           period_from,period_to,forecast_from,forecast_to,last_episodes)
         VALUES ($1,'Київ','operator','running','t','t','2026-07-01','2026-08-16','2026-08-17','2026-08-31',15)`, [KYIV]
      )).rejects.toThrow(/attack_stats_reports_active_idx/);
      // Готовий звіт поруч із активним — дозволено: це історія, а не черга.
      await sql(
        `INSERT INTO attack_stats_reports(region_id,region_name,requested_by,status,methodology_version,prompt_version,
           period_from,period_to,forecast_from,forecast_to,last_episodes,finished_at,verification)
         VALUES ($1,'Київ','operator','completed','t','t','2026-07-01','2026-08-16','2026-08-17','2026-08-31',15,now(),'passed')`, [KYIV]
      );
      // А `completed` без verification — ні.
      await expect(sql(
        `INSERT INTO attack_stats_reports(region_id,region_name,requested_by,status,methodology_version,prompt_version,
           period_from,period_to,forecast_from,forecast_to,last_episodes,finished_at)
         VALUES ($1,'Полтавська область','operator','completed','t','t','2026-07-01','2026-08-16','2026-08-17','2026-08-31',15,now())`, [OTHER_OBLAST]
      )).rejects.toThrow(/check/i);
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('the daily pass', () => {
    it('queues the regions people asked for — subscribers first, then page selections — once per day', async () => {
      await switchOn();
      const { requestAttackStats, runAttackStatsDailyPass, regionsOfInterest } = await service();
      // Два чати з аналітикою на Київщину: один — на область, другий — на місто в ній.
      await seedUser(1); await seedSubscription({ chatId: 1, locationId: OBLAST });
      await seedUser(2); await seedSubscription({ chatId: 2, locationId: CITY_IN_OBLAST });
      // Чат без аналітики не рахується.
      await seedUser(3); await seedSubscription({ chatId: 3, locationId: OTHER_OBLAST, notifyAnalytics: false });
      // Вибір на сторінці — Київ (перемикач для інтересу не потрібен).
      await sql(`UPDATE codex_settings SET attack_stats_enabled=false WHERE singleton`);
      await requestAttackStats(KYIV, 'public', { now: NOW, kick: false });
      await switchOn();

      const candidates = await regionsOfInterest();
      expect(candidates.map((candidate) => [candidate.id, candidate.chats])).toEqual([[OBLAST, 2], [KYIV, 0]]);

      // 18:00 за Києвом — ще не час: нічого не робить і не ставить штампа.
      const early = await runAttackStatsDailyPass(NOW, { featureEnabled: enabled });
      expect(early.ran).toBe(false);
      expect((await sql(`SELECT 1 FROM worker_state WHERE worker_name='attack-stats-daily-pass'`)).rowCount).toBe(0);

      const later = new Date('2026-08-17T17:45:00.000Z'); // 20:45 за Києвом
      const pass = await runAttackStatsDailyPass(later, { featureEnabled: enabled });
      expect(pass).toMatchObject({ ran: true, queued: [OBLAST, KYIV], skippedFresh: [], skippedActive: [], refused: null });
      const queued = await sql<{ region_id: string; requested_by: string }>(
        `SELECT region_id, requested_by FROM attack_stats_reports WHERE status='queued' ORDER BY queued_at`
      );
      expect(queued.rows).toEqual([{ region_id: OBLAST, requested_by: 'scheduler' }, { region_id: KYIV, requested_by: 'scheduler' }]);

      // Того самого дня вдруге — ні. Наступного — так, але активні рядки пропускаються.
      expect((await runAttackStatsDailyPass(new Date('2026-08-17T18:45:00.000Z'), { featureEnabled: enabled })).ran).toBe(false);
      const tomorrow = await runAttackStatsDailyPass(new Date('2026-08-18T17:45:00.000Z'), { featureEnabled: enabled });
      expect(tomorrow).toMatchObject({ ran: true, queued: [], skippedActive: [OBLAST, KYIV] });
    });

    it('skips a region whose report is still fresh', async () => {
      await switchOn();
      const { requestAttackStats, runNextAttackStats, runAttackStatsDailyPass } = await service();
      await requestAttackStats(KYIV, 'public', { now: NOW, kick: false });
      await runNextAttackStats({ featureEnabled: enabled, chat: chatOk });
      await seedUser(1); await seedSubscription({ chatId: 1, locationId: OTHER_OBLAST });

      const pass = await runAttackStatsDailyPass(new Date('2026-08-17T17:45:00.000Z'), { featureEnabled: enabled });
      expect(pass.queued).toEqual([OTHER_OBLAST]);
      expect(pass.skippedFresh).toEqual([KYIV]);
      expect(pass.refused).toBeNull();
    });

    it('stops at the daily cap, counted from what was queued today by anybody', async () => {
      await switchOn();
      const { requestAttackStats, runAttackStatsDailyPass } = await service();
      await requestAttackStats(KYIV, 'public', { now: NOW, kick: false }); // один уже поставлено сьогодні
      await seedUser(1); await seedSubscription({ chatId: 1, locationId: OTHER_OBLAST });

      const { config } = await import('../../src/config.js');
      const perDay = config.ATTACK_STATS_MAX_PER_DAY;
      try {
        config.ATTACK_STATS_MAX_PER_DAY = 1;
        const pass = await runAttackStatsDailyPass(new Date('2026-08-17T17:45:00.000Z'), { featureEnabled: enabled });
        expect(pass.queued).toEqual([]);
        expect(pass.skippedActive).toEqual([]);
        expect(pass.refused).toBe('refused_daily_cap');
      } finally {
        config.ATTACK_STATS_MAX_PER_DAY = perDay;
      }
    });

    it('does nothing but stamp the day when the switch is off', async () => {
      const { runAttackStatsDailyPass } = await service();
      await seedUser(1); await seedSubscription({ chatId: 1, locationId: OBLAST });
      const pass = await runAttackStatsDailyPass(new Date('2026-08-17T17:45:00.000Z'), { featureEnabled: async () => false });
      expect(pass).toMatchObject({ ran: true, queued: [], refused: 'refused_disabled' });
      expect((await sql(`SELECT 1 FROM attack_stats_reports`)).rowCount).toBe(0);
    });

    it('prunes old reports and keeps the queue', async () => {
      const { pruneAttackStats } = await service();
      await sql(
        `INSERT INTO attack_stats_reports(region_id,region_name,requested_by,status,methodology_version,prompt_version,
           period_from,period_to,forecast_from,forecast_to,last_episodes,queued_at,finished_at,verification)
         VALUES ($1,'Київ','scheduler','completed','t','t','2026-05-01','2026-06-15','2026-06-16','2026-06-30',15,
                 now()-interval '70 days',now()-interval '70 days','passed')`, [KYIV]
      );
      await sql(
        `INSERT INTO attack_stats_reports(region_id,region_name,requested_by,status,methodology_version,prompt_version,
           period_from,period_to,forecast_from,forecast_to,last_episodes,queued_at)
         VALUES ($1,'Полтавська область','scheduler','queued','t','t','2026-05-01','2026-06-15','2026-06-16','2026-06-30',15,
                 now()-interval '70 days')`, [OTHER_OBLAST]
      );
      expect(await pruneAttackStats(60)).toBe(1);
      expect((await sql<{ region_id: string }>(`SELECT region_id FROM attack_stats_reports`)).rows).toEqual([{ region_id: OTHER_OBLAST }]);
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('the nightly digest', () => {
    const DIGEST_AT = new Date('2026-08-17T20:30:00.000Z'); // 23:30 за Києвом

    async function seedReport(regionId: string, regionName: string): Promise<void> {
      await switchOn();
      const { requestAttackStats, runNextAttackStats } = await service();
      await requestAttackStats(regionId, 'operator', { now: NOW, kick: false, force: true });
      await runNextAttackStats({
        featureEnabled: enabled,
        chat: async () => ({ ok: true as const, content: goodReply(regionName), model: 'gpt-5.2', durationMs: 5 })
      });
    }

    it('reaches a subscriber with no risk assessment at all, through the oblast above their city', async () => {
      await seedReport(OBLAST, 'Київська область');
      await seedUser(7); await seedSubscription({ chatId: 7, locationId: CITY_IN_OBLAST });
      // Чат без аналітики — нічого; чат на іншу область без звіту — нічого.
      await seedUser(8); await seedSubscription({ chatId: 8, locationId: OBLAST, notifyAnalytics: false });
      await seedUser(9); await seedSubscription({ chatId: 9, locationId: OTHER_OBLAST });

      const { enqueueNightlyDigests } = await import('../../src/services/nightly-digest.js');
      expect(await enqueueNightlyDigests(DIGEST_AT)).toBe(1);
      const rows = await outboxRows();
      expect(rows.length).toBe(1);
      const row = rows[0] as { chat_id: string; notification_type: string; assessment_id: string | null; payload: any };
      expect(String(row.chat_id)).toBe('7');
      expect(row.notification_type).toBe('nightly_digest');
      expect(row.assessment_id).toBeNull();
      expect(row.payload.assessments).toEqual([]);
      expect(row.payload.attackStats).toHaveLength(1);
      expect(row.payload.attackStats[0]).toMatchObject({ regionId: OBLAST, regionName: 'Київська область', verification: 'passed' });
      expect(row.payload.attackStats[0].lines[1]).toBe('Найближча ніч (17.08): ≈19 % — низька.');
      expect(row.payload.attackStats[0].disclaimer).toBe(ATTACK_STATS_DISCLAIMER);

      // Формат: дисклеймер — перший рядок блоку, назва регіону — заголовок, і жодного силуету тривоги.
      const { formatMessage } = await import('../../src/bot/outbox.js');
      const text = formatMessage(row, DIGEST_AT);
      expect(text).toContain('Чинних оцінок ризику по ваших підписках зараз немає.');
      const block = text.slice(text.indexOf('📈'));
      expect(block.indexOf(ATTACK_STATS_DISCLAIMER.slice(0, 40))).toBeLessThan(block.indexOf('Київська область'));
      expect(block).toContain('Найближча ніч (17.08): ≈19 % — низька.');
      expect(text).not.toContain('🔴');

      // Наступний тик — нікому вдруге.
      expect(await enqueueNightlyDigests(DIGEST_AT)).toBe(0);
    });

    it('lists each region once even when several subscriptions climb to it', async () => {
      await seedReport(OBLAST, 'Київська область');
      await seedUser(7);
      await seedSubscription({ chatId: 7, locationId: CITY_IN_OBLAST });
      await seedSubscription({ chatId: 7, locationId: OBLAST });
      const { enqueueNightlyDigests } = await import('../../src/services/nightly-digest.js');
      expect(await enqueueNightlyDigests(DIGEST_AT)).toBe(1);
      const row = (await outboxRows())[0] as { payload: any };
      expect(row.payload.attackStats.map((entry: { regionId: string }) => entry.regionId)).toEqual([OBLAST]);
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('the routes', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      const { buildServer } = await import('../../src/api/server.js');
      app = await buildServer();
    });

    afterAll(async () => { await app?.close(); });

    it('serves the region overview and a report publicly, cacheable, without raw JSON', async () => {
      await switchOn();
      const { requestAttackStats, runNextAttackStats } = await service();
      await requestAttackStats(KYIV, 'public', { now: NOW, kick: false });
      await runNextAttackStats({ featureEnabled: enabled, chat: chatOk });

      const overview = await app.inject({ method: 'GET', url: '/api/v1/analytics/attack-stats' });
      expect(overview.statusCode).toBe(200);
      expect(overview.headers['cache-control']).toContain('max-age=60');
      const body = overview.json();
      expect(body.enabled).toBe(true);
      expect(body.disclaimer).toBe(ATTACK_STATS_DISCLAIMER);
      expect(body.regions[0].id).toBe(KYIV);
      expect(body.regions[0].latest).toMatchObject({ verification: 'passed', tonight: { date: '2026-08-17', p: 0.19, level: 'low' } });
      expect(body.regions[0].pending).toBeNull();
      expect(body.regions[0].selections).toBe(1);

      const report = await app.inject({ method: 'GET', url: `/api/v1/analytics/attack-stats/${KYIV}` });
      expect(report.statusCode).toBe(200);
      expect(report.headers['cache-control']).toContain('max-age=300');
      expect(report.json().summary.forecast).toHaveLength(3);
      expect(report.json().charts).toBeUndefined();
      expect((await app.inject({ method: 'GET', url: `/api/v1/analytics/attack-stats/${OTHER_OBLAST}` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/v1/analytics/attack-stats/kyiv' })).statusCode).toBe(400);
    });

    it('lets a reader register a region — 202 when queued, 200 with the refusal explained', async () => {
      const refused = await app.inject({ method: 'POST', url: `/api/v1/analytics/attack-stats/${KYIV}/requests` });
      expect(refused.statusCode).toBe(200);
      expect(refused.json()).toMatchObject({ outcome: 'refused_disabled' });
      expect(refused.json().detail).toContain('вимкнено');
      await switchOn();
      const queued = await app.inject({ method: 'POST', url: `/api/v1/analytics/attack-stats/${OTHER_OBLAST}/requests` });
      expect(queued.statusCode).toBe(202);
      expect(queued.json()).toMatchObject({ outcome: 'queued', position: 1 });
      expect((await app.inject({ method: 'POST', url: '/api/v1/analytics/attack-stats/ua-43/requests' })).statusCode).toBe(400);
    });

    it('guards the console routes and answers the operator with the queue and the raw report', async () => {
      expect((await app.inject({ method: 'GET', url: '/ops/attack-stats' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/ops/attack-stats', payload: { regionId: KYIV } })).statusCode).toBe(401);

      const disabled = await app.inject({ method: 'POST', url: '/ops/attack-stats', headers: { authorization: OPS_AUTH }, payload: { regionId: KYIV } });
      expect(disabled.statusCode).toBe(409);
      await switchOn();
      // Кнопка будить воркер сама; у тесті він має піти в заглушку, а не в справжній Codex.
      const { setAttackStatsWorkerDefaults } = await service();
      setAttackStatsWorkerDefaults({ featureEnabled: enabled, chat: chatOk });
      const queued = await app.inject({ method: 'POST', url: '/ops/attack-stats', headers: { authorization: OPS_AUTH }, payload: { regionId: KYIV } });
      expect(queued.statusCode).toBe(202);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const done = await sql(`SELECT 1 FROM attack_stats_reports WHERE status='completed'`);
        if (done.rowCount) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const overview = await app.inject({ method: 'GET', url: '/ops/attack-stats', headers: { authorization: OPS_AUTH } });
      expect(overview.statusCode).toBe(200);
      expect(overview.json().recent).toHaveLength(1);
      expect(overview.json().settings.runTime).toBe('20:30');
      const reportId = overview.json().recent[0].id;
      const full = await app.inject({ method: 'GET', url: `/ops/attack-stats/${reportId}`, headers: { authorization: OPS_AUTH } });
      expect(full.statusCode).toBe(200);
      expect(full.json().charts.forecast).toHaveLength(3);
      expect(full.json().reportText).toContain('Таблиця епізодів');

      const pass = await app.inject({ method: 'POST', url: '/ops/attack-stats/daily-pass', headers: { authorization: OPS_AUTH } });
      expect(pass.statusCode).toBe(202);
      expect(pass.json().ran).toBe(true);
    });
  });
});
