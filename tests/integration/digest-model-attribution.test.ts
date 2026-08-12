import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OBLAST, ensureMigrated, integrationDatabaseAvailable, outboxRows, resetDatabase, seedSubscription,
  seedUser, sql
} from '../helpers/db.js';

/**
 * Хто підняв сигнал, з якого зібрано число в нічному зведенні.
 *
 * Юніт-тести поруч із `src/services/nightly-digest.ts` доводять, що ознака доходить до фактів і що
 * при нулі жодного попередження не зʼявляється. Чого фейк структурно довести не може — саме те, що
 * тут: SQL має рахувати сигнали за рядком тіньової класифікації, а не за авторством події, і ці два
 * способи розходяться рівно в одному випадку, який і є найважливішим для читача.
 *
 * Той випадок — злиття. `threat_events.origin` (міграція 041) навмисно лишається 'model', коли в
 * модельну подію пізніше вливається повідомлення людини: авторство події від цього не змінюється.
 * Але сигнал того повідомлення — людський, з повною вагою джерела, і назвати його модельним
 * означало б сказати читачеві, що припущенням є те, що насправді повідомило джерело. Тобто помилка
 * в бік, протилежний до безпечного: замість «частину сигналів дала модель» вийшло б
 * «майже всі сигнали модельні», і попередження перестало б щось означати.
 */

const SOURCE = 'osint-eradar';
const DIGEST_AT = new Date('2026-08-12T20:30:00.000Z'); // 23:30 за Києвом — після NIGHTLY_DIGEST_TIME
const CHAT_ID = 991_155;

let sequence = 0;

async function seedMessage(): Promise<string> {
  sequence += 1;
  const inserted = await sql<{ id: string }>(
    `INSERT INTO source_messages(source_id,external_id,published_at,raw_text,content_hash)
     VALUES ($1,$2,now(),'Шахед курсом на область.',$2) RETURNING id`,
    [SOURCE, `digest-attribution-${sequence}`]
  );
  return inserted.rows[0]!.id;
}

/** Подія, авторство якої належить моделі — рівно те, що пише промоція в `ingestThreat`. */
async function seedModelEvent(): Promise<string> {
  const inserted = await sql<{ id: string }>(
    `INSERT INTO threat_events(threat_type,status,evidence_level,origin,title,summary,
       started_at,last_observed_at,valid_until)
     VALUES ('uav','observed','unverified','model','Аналітична загроза','Неперевірена оцінка моделі.',
       now(),now(),now()+interval '30 minutes') RETURNING id`
  );
  return inserted.rows[0]!.id;
}

/** Рядок тіньової класифікації з непорожнім `analytical_event_id` — сам факт промоції. */
async function seedPromotedVerdict(messageId: string, eventId: string): Promise<void> {
  await sql(
    `INSERT INTO shadow_classifications(source_message_id,classifier_version,published_at,
       deterministic_threat_type,deterministic_significant,model,model_threat_type,model_significant,
       model_confidence,agrees,message_text,analytical_event_id)
     VALUES ($1,'test-v1',now(),'unknown',false,'test-model','uav',true,0.86,false,
       'Шахед курсом на область.',$2)`,
    [messageId, eventId]
  );
}

/** Класифікація повідомлення, віднесена до події, — те, чим людське повідомлення вливається в неї. */
async function seedClassification(messageId: string, eventId: string): Promise<void> {
  await sql(
    `INSERT INTO message_classifications(source_message_id,source_id,classifier_version,published_at,
       decision,intent,created_event,threat_type,event_id)
     VALUES ($1,$2,'test-v1',now(),'event_merged','threat',false,'uav',$3)`,
    [messageId, SOURCE, eventId]
  );
}

async function seedAssessment(): Promise<string> {
  const inserted = await sql<{ id: string }>(
    `INSERT INTO risk_assessments(location_id,threat_type,horizon_start,horizon_end,risk_score,
       risk_level,assessment_confidence,model_version,indicative_percent,explanation,expires_at,published)
     VALUES ($1,'uav',now(),now()+interval '6 hours',3.5,'elevated','low','integration-fixture',35,
       '{"raisingFactors":["Пряма загроза цій території — 2 повідомлення за останні години."]}'::jsonb,
       now()+interval '6 hours',true) RETURNING id`,
    [OBLAST]
  );
  return inserted.rows[0]!.id;
}

async function seedSignal(assessmentId: string, messageId: string, contribution = 0.3): Promise<void> {
  const signal = await sql<{ id: string }>(
    `INSERT INTO risk_signals(signal_type,source_message_id,location_id,threat_type,source_tier,
       independence_group,reliability,freshness,geographic_relevance,contribution,observed_at,expires_at)
     VALUES ('explicit_threat',$1,$2,'uav','C','eradar',0.4,1,1,$3::numeric,now(),now()+interval '6 hours')
     RETURNING id`,
    [messageId, OBLAST, contribution]
  );
  await sql(
    `INSERT INTO risk_assessment_signals(assessment_id,signal_id,contribution,explanation)
     VALUES ($1,$2,$3::numeric,'integration fixture')`,
    [assessmentId, signal.rows[0]!.id, contribution]
  );
}

async function counts(assessmentIds: string[]): Promise<Map<string, number>> {
  const { modelSignalCounts } = await import('../../src/services/nightly-digest.js');
  return modelSignalCounts(assessmentIds);
}

describe.skipIf(!integrationDatabaseAvailable)('модельний внесок у нічному зведенні', () => {
  beforeAll(async () => { await ensureMigrated(); });
  beforeEach(async () => { await resetDatabase(); });

  it('рахує сигнали промотованих вердиктів і мовчить про оцінки без них', async () => {
    const withModel = await seedAssessment();
    const withoutModel = await seedAssessment();
    const event = await seedModelEvent();

    const promoted = await seedMessage();
    await seedPromotedVerdict(promoted, event);
    await seedSignal(withModel, promoted);
    await seedSignal(withModel, await seedMessage(), 0.6);
    await seedSignal(withoutModel, await seedMessage(), 0.6);

    const result = await counts([withModel, withoutModel]);
    expect(result.get(withModel)).toBe(1);
    // Оцінка без жодного модельного сигналу не має рядка взагалі: «немає» і «нуль» — один стан,
    // і `digestFacts` читає його як нуль.
    expect(result.has(withoutModel)).toBe(false);
  });

  it('не називає модельним людське повідомлення, що влилося в модельну подію', async () => {
    const assessment = await seedAssessment();
    const event = await seedModelEvent();

    const promoted = await seedMessage();
    await seedPromotedVerdict(promoted, event);
    await seedSignal(assessment, promoted);

    // Джерело повідомило те саме за півгодини — подія лишається модельною за авторством, але цей
    // сигнал написала людина. Підрахунок за `threat_events.origin` дав би тут 2.
    const human = await seedMessage();
    await seedClassification(human, event);
    await seedSignal(assessment, human, 0.6);

    expect((await counts([assessment])).get(assessment)).toBe(1);
  });

  it('не рахує вердикт, який записали, але не промотували', async () => {
    const assessment = await seedAssessment();
    const message = await seedMessage();
    // `analytical_threats_enabled` вимкнено — тіньовий корпус збирається, публікації немає.
    await sql(
      `INSERT INTO shadow_classifications(source_message_id,classifier_version,published_at,
         deterministic_threat_type,deterministic_significant,model,model_threat_type,model_significant,
         agrees,message_text)
       VALUES ($1,'test-v1',now(),'unknown',false,'test-model','uav',true,false,'Шахед курсом на область.')`,
      [message]
    );
    await seedSignal(assessment, message, 0.6);

    expect((await counts([assessment])).size).toBe(0);
  });

  it('доводить число й речення до payload зведення — і мовчить, коли модель не втручалася', async () => {
    const { enqueueNightlyDigests } = await import('../../src/services/nightly-digest.js');
    await seedUser(CHAT_ID);
    await seedSubscription({ chatId: CHAT_ID, locationId: OBLAST, notifyAnalytics: true });

    const assessment = await seedAssessment();
    await seedSignal(assessment, await seedMessage(), 0.6);
    expect(await enqueueNightlyDigests(DIGEST_AT)).toBe(1);

    const quiet = (await outboxRows()).find((row) => row.notification_type === 'nightly_digest');
    const quietPayload = quiet!.payload as Record<string, unknown>;
    expect(quietPayload.modelSignals).toBe(0);
    // Порожня згадка знецінює попередження, тому за замовчуванням у payload немає рядка взагалі.
    expect(quietPayload.modelDisclosure).toBeNull();

    // Наступна ніч: той самий підписник, але частину сигналів підняла модель.
    await sql('TRUNCATE nightly_digest_runs, notification_outbox CASCADE');
    const event = await seedModelEvent();
    const promoted = await seedMessage();
    await seedPromotedVerdict(promoted, event);
    await seedSignal(assessment, promoted);
    expect(await enqueueNightlyDigests(DIGEST_AT)).toBe(1);

    const loud = (await outboxRows()).find((row) => row.notification_type === 'nightly_digest');
    const loudPayload = loud!.payload as Record<string, unknown>;
    expect(loudPayload.modelSignals).toBe(1);
    expect(loudPayload.modelDisclosure).toBe('Частину сигналів (1) дала модель — вони не підтверджені джерелом.');
  });
});
