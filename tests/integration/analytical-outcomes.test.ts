import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  CITY_IN_OBLAST, OBLAST, OTHER_OBLAST, ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql
} from '../helpers/db.js';

/**
 * Чим закінчилися модельні промоції — від схеми міграції 043 до числа, яке оператор читає в /ops.
 *
 * Юніт-набір поруч із `src/services/analytical-outcomes.ts` доводить саме рішення (яке свідчення
 * важить більше); цей файл доводить те, що юніт довести не може: що SQL знаходить підтвердження там,
 * де воно є, не знаходить там, де його немає, і що ієрархія локацій працює в обидва боки — офіційна
 * тривога по області підтверджує промоцію по місту всередині неї.
 *
 * Друга гарантія, яку перевіряємо прямо, а не виводимо з коду: оцінювання нічого не змінює. Подія,
 * офіційна тривога та твердження джерел лишаються рівно такими, якими були — це вимірювання
 * ПРО подію, а не подія.
 *
 * `alert_active_at_publication` має власні випадки, бо саме він визначає знаменник точності:
 * промоцію, зроблену під уже активною тривогою, офіційно підтвердити неможливо, і /ops виводить її
 * зі знаменника замість того, щоб зарахувати як помилку моделі.
 */

const MODEL_SOURCE = 'osint-eradar';       // independence_group = 'osint-eradar'
const OTHER_SOURCE = 'osint-war-monitor';  // independence_group = 'osint-war-monitor'
const OPS = `Basic ${Buffer.from('operator:change-me').toString('base64')}`;

/** Публікація достатньо давня, щоб вікно чинності (30 хв) і пільговий період (15 хв) уже минули. */
const PUBLISHED_MINUTES_AGO = 90;

let sequence = 0;

async function seedMessage(sourceId: string, minutesAgo: number): Promise<string> {
  sequence += 1;
  const inserted = await sql<{ id: string }>(
    `INSERT INTO source_messages(source_id,external_id,published_at,raw_text,content_hash)
     VALUES ($1,$2,now() - ($3 || ' minutes')::interval,'Шахед курсом на область.',$2) RETURNING id`,
    [sourceId, `outcome-${sequence}`, String(minutesAgo)]
  );
  return inserted.rows[0]!.id;
}

/**
 * Подія рівно такої форми, яку створює `promoteAnalyticalThreat`: `unverified`, вікно чинності 30
 * хвилин від публікації. `origin` тут навмисно не згадується — цей модуль визначає промоцію за
 * `shadow_classifications.analytical_event_id` (міграція 040), тобто за коренем аудиту, а не за
 * позначкою на самій події.
 */
async function seedPromotion(options: {
  locationIds: string[];
  confidence?: number;
  minutesAgo?: number;
  threatType?: string;
  sourceId?: string;
}): Promise<{ eventId: string; messageId: string; publishedAt: Date }> {
  const minutesAgo = options.minutesAgo ?? PUBLISHED_MINUTES_AGO;
  const sourceId = options.sourceId ?? MODEL_SOURCE;
  const messageId = await seedMessage(sourceId, minutesAgo);
  const event = await sql<{ id: string; started_at: Date }>(
    `INSERT INTO threat_events(threat_type,status,evidence_level,title,summary,
       started_at,last_observed_at,valid_until)
     VALUES ($1,'observed','unverified','Аналітична загроза','Неперевірена оцінка моделі.',
       now() - ($2 || ' minutes')::interval, now() - ($2 || ' minutes')::interval,
       now() - ($2 || ' minutes')::interval + interval '30 minutes')
     RETURNING id, started_at`,
    [options.threatType ?? 'uav', String(minutesAgo)]
  );
  const eventId = event.rows[0]!.id;
  for (const locationId of options.locationIds) {
    await sql(
      `INSERT INTO threat_event_locations(event_id,location_id,relation_type)
       VALUES ($1,$2,'explicit_threat')`,
      [eventId, locationId]
    );
  }
  // Слід авторства моделі, який пише `ingestThreat`: роль доказу з префіксом `model:`. Саме за ним
  // незалежна перевірка відрізняє людське повідомлення від другої машинної думки.
  await sql(
    `INSERT INTO event_evidence(event_id,source_message_id,evidence_role,confidence)
     VALUES ($1,$2,$3,$4)`,
    [eventId, messageId, `model:${sourceId}`, options.confidence ?? 0.92]
  );
  await sql(
    `INSERT INTO shadow_classifications(source_message_id,classifier_version,published_at,
       deterministic_threat_type,deterministic_significant,model,model_threat_type,model_significant,
       model_confidence,agrees,message_text,analytical_event_id)
     VALUES ($1,'test-v1',now() - ($2 || ' minutes')::interval,'unknown',false,'test-model','uav',true,
       $3,false,'Шахед курсом на область.',$4)`,
    [messageId, String(minutesAgo), options.confidence ?? 0.92, eventId]
  );
  return { eventId, messageId, publishedAt: new Date(event.rows[0]!.started_at) };
}

/** Офіційна тривога, що ПОЧАЛАСЬ за `minutesAgo` хвилин до зараз. */
async function seedAlertPeriod(locationId: string, minutesAgo: number, endedMinutesAgo?: number): Promise<void> {
  await sql(
    `INSERT INTO alert_periods(location_id,alert_type,status,started_at,ended_at)
     VALUES ($1,'air_raid',$4,now() - ($2 || ' minutes')::interval,
       CASE WHEN $3::text IS NULL THEN NULL ELSE now() - ($3 || ' minutes')::interval END)`,
    [locationId, String(minutesAgo), endedMinutesAgo == null ? null : String(endedMinutesAgo),
      endedMinutesAgo == null ? 'active' : 'ended']
  );
}

/**
 * Твердження іншого джерела про ту саму загрозу. `modelAuthored` відтворює другу модельну промоцію:
 * та сама форма рядка, але з роллю доказу `model:…`, яку незалежна перевірка мусить відкинути.
 */
async function seedAssertion(options: {
  eventId: string;
  locationId: string;
  minutesAgo: number;
  sourceId?: string;
  threatType?: string;
  modelAuthored?: boolean;
  withdrawn?: boolean;
}): Promise<void> {
  const sourceId = options.sourceId ?? OTHER_SOURCE;
  const messageId = await seedMessage(sourceId, options.minutesAgo);
  await sql(
    `INSERT INTO threat_assertions(event_id,source_id,independence_group,location_id,threat_type,
       asserted_at,asserted_message_id,valid_until,withdrawn_at)
     VALUES ($1,$2,$2,$3,$4,now() - ($5 || ' minutes')::interval,$6,
       now() - ($5 || ' minutes')::interval + interval '30 minutes',
       CASE WHEN $7::boolean THEN now() ELSE NULL END)`,
    [options.eventId, sourceId, options.locationId, options.threatType ?? 'uav',
      String(options.minutesAgo), messageId, Boolean(options.withdrawn)]
  );
  await sql(
    `INSERT INTO event_evidence(event_id,source_message_id,evidence_role,confidence)
     VALUES ($1,$2,$3,0.55)`,
    [options.eventId, messageId, options.modelAuthored ? `model:${sourceId}` : sourceId]
  );
}

interface OutcomeRow {
  outcome: string;
  confirmed_at: Date | null;
  confirmed_location_id: string | null;
  confirmed_by: string | null;
  alert_active_at_publication: boolean;
  confidence: string;
  model: string;
}

async function outcomeOf(eventId: string): Promise<OutcomeRow | undefined> {
  const rows = await sql<OutcomeRow>(
    `SELECT outcome,confirmed_at,confirmed_location_id,confirmed_by,alert_active_at_publication,
            confidence,model
       FROM analytical_outcomes WHERE event_id=$1`,
    [eventId]
  );
  return rows.rows[0];
}

async function evaluate() {
  const { evaluateAnalyticalOutcomes } = await import('../../src/services/analytical-outcomes.js');
  return evaluateAnalyticalOutcomes();
}

describe.skipIf(!integrationDatabaseAvailable)('analytical promotion outcomes', () => {
  beforeAll(ensureMigrated);
  beforeEach(async () => {
    await resetDatabase();
    const { resetAnalyticalOutcomeMetrics } = await import('../../src/services/analytical-outcomes.js');
    resetAnalyticalOutcomeMetrics();
  });

  describe('classification', () => {
    it('рахує офіційну тривогу над областю підтвердженням промоції по місту в ній', async () => {
      const { eventId } = await seedPromotion({ locationIds: [CITY_IN_OBLAST] });
      // Тривога почалася через 5 хвилин ПІСЛЯ публікації моделі — саме те випередження, заради
      // якого промоцію взагалі публікують.
      await seedAlertPeriod(OBLAST, PUBLISHED_MINUTES_AGO - 5);

      const summary = await evaluate();

      expect(summary).toMatchObject({ evaluated: 1, confirmedOfficial: 1 });
      const outcome = await outcomeOf(eventId);
      expect(outcome?.outcome).toBe('confirmed_official');
      // Локація самої тривоги, а не та, яку назвала модель: підтвердження має бути перевірюваним.
      expect(outcome?.confirmed_location_id).toBe(OBLAST);
      expect(outcome?.confirmed_by).toBe('air_raid');
      expect(outcome?.alert_active_at_publication).toBe(false);
    });

    it('рахує твердження іншої групи незалежності незалежним підтвердженням', async () => {
      const { eventId } = await seedPromotion({ locationIds: [OBLAST] });
      // Найчастіша форма підтвердження: людське повідомлення вливається в подію моделі, а не
      // створює власну. Тому перевірка читає `threat_assertions`, а не «іншу подію».
      await seedAssertion({ eventId, locationId: OBLAST, minutesAgo: PUBLISHED_MINUTES_AGO - 8 });

      const summary = await evaluate();

      expect(summary).toMatchObject({ evaluated: 1, confirmedIndependent: 1 });
      const outcome = await outcomeOf(eventId);
      expect(outcome?.outcome).toBe('confirmed_independent');
      expect(outcome?.confirmed_by).toBe(OTHER_SOURCE);
    });

    it('рахує промоцію, якої ніхто не підтвердив, невдалою', async () => {
      const { eventId } = await seedPromotion({ locationIds: [OBLAST] });
      // Тривога в іншій області та твердження про іншу загрозу — обидва не про цю промоцію.
      await seedAlertPeriod(OTHER_OBLAST, PUBLISHED_MINUTES_AGO - 5);
      await seedAssertion({
        eventId, locationId: OBLAST, minutesAgo: PUBLISHED_MINUTES_AGO - 5, threatType: 'artillery'
      });

      const summary = await evaluate();

      expect(summary).toMatchObject({ evaluated: 1, unconfirmed: 1 });
      const outcome = await outcomeOf(eventId);
      expect(outcome?.outcome).toBe('unconfirmed');
      expect(outcome?.confirmed_at).toBeNull();
      expect(outcome?.confirmed_by).toBeNull();
    });
  });

  describe('що підтвердженням не рахується', () => {
    it('не рахує тривогу, яка вже тривала на момент публікації, але позначає випадок', async () => {
      const { eventId } = await seedPromotion({ locationIds: [OBLAST] });
      // Почалася за 20 хвилин ДО публікації і не закінчилась. Якби «активна тривога» рахувалась
      // підтвердженням, під час масованої атаки точність показувала б майже 100% і не означала б
      // нічого.
      await seedAlertPeriod(OBLAST, PUBLISHED_MINUTES_AGO + 20);

      await evaluate();

      const outcome = await outcomeOf(eventId);
      expect(outcome?.outcome).toBe('unconfirmed');
      expect(outcome?.alert_active_at_publication).toBe(true);
    });

    it('не рахує підтвердженням твердження власної групи незалежності', async () => {
      const { eventId } = await seedPromotion({ locationIds: [OBLAST] });
      await seedAssertion({
        eventId, locationId: OBLAST, minutesAgo: PUBLISHED_MINUTES_AGO - 5, sourceId: MODEL_SOURCE
      });

      await evaluate();

      expect((await outcomeOf(eventId))?.outcome).toBe('unconfirmed');
    });

    it('не рахує підтвердженням другу модельну промоцію з іншого джерела', async () => {
      const { eventId } = await seedPromotion({ locationIds: [OBLAST] });
      // Дві моделі, що погодились між собою, — це одна думка, а не дві.
      await seedAssertion({
        eventId, locationId: OBLAST, minutesAgo: PUBLISHED_MINUTES_AGO - 5, modelAuthored: true
      });

      await evaluate();

      expect((await outcomeOf(eventId))?.outcome).toBe('unconfirmed');
    });

    it('не рахує підтвердженням твердження, яке джерело вже відкликало', async () => {
      const { eventId } = await seedPromotion({ locationIds: [OBLAST] });
      await seedAssertion({
        eventId, locationId: OBLAST, minutesAgo: PUBLISHED_MINUTES_AGO - 5, withdrawn: true
      });

      await evaluate();

      expect((await outcomeOf(eventId))?.outcome).toBe('unconfirmed');
    });

    it('не рахує тривогу, що почалась уже після вікна підтвердження', async () => {
      const { eventId } = await seedPromotion({ locationIds: [OBLAST] });
      // Вікно — 45 хвилин від публікації; ця тривога почалась на 60-й.
      await seedAlertPeriod(OBLAST, PUBLISHED_MINUTES_AGO - 60);

      await evaluate();

      expect((await outcomeOf(eventId))?.outcome).toBe('unconfirmed');
    });
  });

  describe('обмеження проходу', () => {
    it('не оцінює промоцію, чиє вікно чинності ще не минуло разом із пільговим періодом', async () => {
      // 35 хвилин тому: вікно чинності щойно закрилось, але 15 хвилин на відставання офіційного
      // каналу ще не минули. Судити зараз — означало б зарахувати запізнілу тривогу як промах.
      const { eventId } = await seedPromotion({ locationIds: [OBLAST], minutesAgo: 35 });

      const summary = await evaluate();

      expect(summary.evaluated).toBe(0);
      expect(await outcomeOf(eventId)).toBeUndefined();
    });

    it('оцінює кожну промоцію один раз', async () => {
      const { eventId } = await seedPromotion({ locationIds: [OBLAST] });
      await seedAlertPeriod(OBLAST, PUBLISHED_MINUTES_AGO - 5);

      const first = await evaluate();
      const second = await evaluate();

      expect(first.evaluated).toBe(1);
      // Другий прохід не бачить кандидата й нічого не дописує: інакше кожен перезапуск подвоював би
      // ряд у метриках.
      expect(second.evaluated).toBe(0);
      expect(second.pending).toBe(0);
      const rows = await sql(`SELECT count(*)::int AS count FROM analytical_outcomes WHERE event_id=$1`, [eventId]);
      expect(rows.rows[0]!.count).toBe(1);
    });

    it('нічого не змінює в події, тривозі чи твердженнях', async () => {
      const { eventId } = await seedPromotion({ locationIds: [OBLAST] });
      await seedAlertPeriod(OBLAST, PUBLISHED_MINUTES_AGO - 5);
      const before = await sql<{ snapshot: string }>(
        `SELECT (status || evidence_level || updated_at::text) AS snapshot FROM threat_events WHERE id=$1`,
        [eventId]
      );

      await evaluate();

      const after = await sql<{ snapshot: string }>(
        `SELECT (status || evidence_level || updated_at::text) AS snapshot FROM threat_events WHERE id=$1`,
        [eventId]
      );
      expect(after.rows[0]!.snapshot).toBe(before.rows[0]!.snapshot);
      // Офіційні таблиці — окремо й прямо: аналітика не має до них шляху в жодному напрямку.
      const alerts = await sql(`SELECT count(*)::int AS count FROM alert_periods`);
      expect(alerts.rows[0]!.count).toBe(1);
    });
  });

  describe('точність за порогом', () => {
    it('рахує точність окремо для кожного порогу й виводить невимірні випадки зі знаменника', async () => {
      const { analyticalPrecision } = await import('../../src/services/analytical-outcomes.js');

      // 0.96 — підтверджена офіційно; входить у всі три пороги.
      const high = await seedPromotion({ locationIds: [OBLAST], confidence: 0.96 });
      await seedAlertPeriod(OBLAST, PUBLISHED_MINUTES_AGO - 5);
      // 0.88 — не підтверджена нічим; входить лише в поріг 0.85.
      await seedPromotion({ locationIds: [OTHER_OBLAST], confidence: 0.88 });
      // 0.91 — не підтверджена, але вся її територія була під тривогою ще до публікації: підтвердити
      // офіційно її неможливо, тож вона не має псувати точність.
      const undecidable = await seedPromotion({ locationIds: ['ua-63'], confidence: 0.91 });
      await seedAlertPeriod('ua-63', PUBLISHED_MINUTES_AGO + 30);

      await evaluate();
      const report = await analyticalPrecision(30, 10);

      expect(report.evaluated).toBe(3);
      expect(report.thresholds.map((bucket) => bucket.threshold)).toEqual([0.85, 0.9, 0.95]);
      const [low, mid, top] = report.thresholds;
      // 0.85: три промоції, одна підтверджена, одна невимірна → 1 з 2.
      expect(low).toMatchObject({ promotions: 3, confirmedOfficial: 1, undecidable: 1, precisionPercent: 50 });
      // 0.9: дві промоції (0.96 і 0.91), з них невимірна одна → 1 з 1.
      expect(mid).toMatchObject({ promotions: 2, undecidable: 1, precisionPercent: 100 });
      // 0.95: лише підтверджена.
      expect(top).toMatchObject({ promotions: 1, confirmedOfficial: 1, precisionPercent: 100 });
      // Випередження рахується від публікації до підтвердження — 5 хвилин у фікстурі.
      expect(top!.medianLeadSeconds).toBeGreaterThan(240);
      expect(top!.medianLeadSeconds).toBeLessThan(360);

      // Список для читання — лише невдалі промоції, найновіші згори.
      const failed = report.recentUnconfirmed.map((row) => row.eventId);
      expect(failed).toContain(undecidable.eventId);
      expect(failed).not.toContain(high.eventId);
      expect(report.recentUnconfirmed.find((row) => row.eventId === undecidable.eventId))
        .toMatchObject({ alertActiveAtPublication: true, model: 'test-model' });
    });
  });

  describe('/ops/analytical-outcomes', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      const Fastify = (await import('fastify')).default;
      const routes = (await import('../../src/api/ops-codex-routes.js')).default;
      app = Fastify({ logger: false });
      await app.register(routes);
      await app.ready();
    });

    afterAll(async () => { await app?.close(); });

    it('вимагає операторську автентифікацію', async () => {
      const response = await app.inject({ method: 'GET', url: '/ops/analytical-outcomes' });
      expect(response.statusCode).toBe(401);
    });

    it('віддає точність за трьома порогами разом із чинним порогом і методологією', async () => {
      await seedPromotion({ locationIds: [OBLAST], confidence: 0.93 });
      await seedAlertPeriod(OBLAST, PUBLISHED_MINUTES_AGO - 5);
      await evaluate();

      const response = await app.inject({
        method: 'GET', url: '/ops/analytical-outcomes?days=7&failures=5',
        headers: { authorization: OPS }
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.windowDays).toBe(7);
      expect(body.currentThreshold).toBeGreaterThan(0);
      expect(body.thresholds).toHaveLength(3);
      expect(body.methodology.confirmationWindowMinutes).toBe(45);
      // Сторінка нічого не змінює — вона лише показує, куди рухати поріг.
      expect(body.methodology.notice).toContain('не змінюється автоматично');
    });
  });
});
