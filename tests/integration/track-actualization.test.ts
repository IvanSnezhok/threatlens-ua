import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CITY_IN_OBLAST, OBLAST, OTHER_OBLAST, count, ensureMigrated, integrationDatabaseAvailable, resetDatabase,
  seedThreatEvent, sql
} from '../helpers/db.js';
import type * as TrackActualizationModule from '../../src/services/track-actualization.js';

/**
 * Воркер актуалізації треку проти живої PostgreSQL, з моделлю-заглушкою.
 *
 * Юніт-тести поруч із `src/services/track-actualization.ts` доводять перевірку відповіді. Чого
 * заглушка бази довести не може — саме те, що тут: вибір кандидатів («найновіша класифікація новіша
 * за останню актуалізацію») справді зупиняє повторний виклик на незмінному вході, перемикач справді
 * вимикає поверхню, а відхилена відповідь справді лягає в `ai_runs` і не лягає в таблицю треку.
 */

const SOURCE = 'osint-eradar';
const OPS = `Basic ${Buffer.from('operator:change-me').toString('base64')}`;
let sequence = 0;

type Place = [locationId: string, role: 'asserted' | 'retracted', relation: string | null];

async function seedClassification(eventId: string, minutesAgo: number, text: string, places: Place[]): Promise<Date> {
  sequence += 1;
  const message = await sql<{ id: string; published_at: Date }>(
    `INSERT INTO source_messages(source_id,external_id,published_at,raw_text,content_hash)
     VALUES ($1,$2,now() - make_interval(mins => $3::int),$4,$2) RETURNING id, published_at`,
    [SOURCE, `track-actualization-${sequence}`, minutesAgo, text]
  );
  const classification = await sql<{ id: string }>(
    `INSERT INTO message_classifications(source_message_id,source_id,classifier_version,published_at,
       decision,intent,created_event,threat_type,event_id)
     VALUES ($1,$2,'test-v1',$3,'event_merged','threat',false,'uav',$4) RETURNING id`,
    [message.rows[0]!.id, SOURCE, message.rows[0]!.published_at, eventId]
  );
  for (const [locationId, role, relation] of places) {
    await sql(
      `INSERT INTO message_classification_locations(classification_id,location_id,role,relation_type)
       VALUES ($1,$2,$3,$4)`,
      [classification.rows[0]!.id, locationId, role, relation]
    );
  }
  return message.rows[0]!.published_at;
}

const answer = (overrides: Record<string, unknown> = {}) => ({
  status: 'moving', headPlaceId: OBLAST, headingPlaceId: CITY_IN_OBLAST, originPlaceId: null, loiterPlaceId: null,
  currentSince: null, summary: 'Шахед на Київщині, курс на Білу Церкву.', confidence: 0.3, ...overrides
});

const chatAnswering = (value: unknown) => vi.fn(async (_request: { surface: string; tier?: string; promptVersion: string }) => ({
  ok: true as const, content: JSON.stringify(value), model: 'gpt-6-luna', durationMs: 5
}));

async function switchOn(mode: 'rules' | 'codex' = 'rules'): Promise<void> {
  await sql(`UPDATE codex_settings SET actualization_enabled=true, classifier_mode=$1 WHERE singleton`, [mode]);
}

describe.skipIf(!integrationDatabaseAvailable)('track actualization worker against live PostgreSQL', () => {
  let actualization: typeof TrackActualizationModule;
  let eventId: string;
  let newest: Date;

  beforeAll(async () => {
    await ensureMigrated();
    // Динамічно, як і в кожному файлі цього каталогу: модуль тягне `src/db/pool.ts`, чий пул
    // будується з `DATABASE_URL` під час імпорту, а пропущений прогін (без бази) не має його будувати.
    actualization = await import('../../src/services/track-actualization.js');
  });

  beforeEach(async () => {
    await resetDatabase();
    actualization.resetTrackActualization();
    eventId = await seedThreatEvent({ locationIds: [CITY_IN_OBLAST] });
    await seedClassification(eventId, 6, 'Шахед на Київщині курсом на Білу Церкву.', [
      [OBLAST, 'asserted', 'mentioned'], [CITY_IN_OBLAST, 'asserted', 'reported_direction']
    ]);
    newest = await seedClassification(eventId, 2, 'Шахед над Білою Церквою.', [[CITY_IN_OBLAST, 'asserted', 'explicit_threat']]);
  });

  it('asks nothing and stores nothing while the switch is off', async () => {
    const chat = chatAnswering(answer());
    const pass = await actualization.runTrackActualization({ chat });
    expect(pass.enabled).toBe(false);
    expect(chat).not.toHaveBeenCalled();
    expect(await count('threat_track_actualizations')).toBe(0);
  });

  it('stores the fast model’s reading, low confidence included, and hands it back as stored', async () => {
    await switchOn();
    const chat = chatAnswering(answer());
    const pass = await actualization.runTrackActualization({ chat });

    expect(pass).toMatchObject({ enabled: true, stored: 1, rejected: 0, failed: 0 });
    expect(chat).toHaveBeenCalledOnce();
    expect(chat.mock.calls[0]![0]).toMatchObject({ surface: 'actualization', tier: 'fast', promptVersion: 'actualization-v1' });
    const latest = (await actualization.latestActualizations([eventId])).get(eventId);
    // Поріг 0,6 — справа карти: тут рядок лягає й читається рівно таким, яким модель його дала.
    expect(latest).toMatchObject({
      eventId, model: 'gpt-6-luna', status: 'moving', headLocationId: OBLAST, headingLocationId: CITY_IN_OBLAST,
      asOf: newest.toISOString(), summary: 'Шахед на Київщині, курс на Білу Церкву.'
    });
    expect(latest!.confidence).toBeCloseTo(0.3, 5);
    // Режим `rules` — тінь: рядок є, а карта його не застосовує.
    expect(await actualization.actualizationApplies()).toBe(false);
    await switchOn('codex');
    expect(await actualization.actualizationApplies()).toBe(true);
  });

  it('does not ask again about an unchanged input, and does once a newer message arrives', async () => {
    await switchOn();
    const chat = chatAnswering(answer());
    await actualization.runTrackActualization({ chat });
    await actualization.runTrackActualization({ chat });
    expect(chat).toHaveBeenCalledOnce();
    expect(await count('threat_track_actualizations', 'event_id=$1', [eventId])).toBe(1);

    const later = await seedClassification(eventId, 0, 'Шахед минув Білу Церкву.', [[CITY_IN_OBLAST, 'asserted', 'mentioned']]);
    await actualization.runTrackActualization({ chat: chatAnswering(answer({ status: 'passed', headingPlaceId: null })) });
    expect(await count('threat_track_actualizations', 'event_id=$1', [eventId])).toBe(2);
    expect((await actualization.latestActualizations([eventId])).get(eventId))
      .toMatchObject({ status: 'passed', asOf: later.toISOString() });
  });

  it('refuses a place the messages never named, audits the refusal, and does not retry the same input at once', async () => {
    await switchOn();
    const chat = chatAnswering(answer({ headPlaceId: OTHER_OBLAST }));
    const pass = await actualization.runTrackActualization({ chat });

    expect(pass).toMatchObject({ stored: 0, rejected: 1 });
    expect(await count('threat_track_actualizations')).toBe(0);
    const audit = await sql<{ surface: string; prompt_version: string; validation_status: string; fallback_reason: string; status: string }>(
      `SELECT surface, prompt_version, validation_status, fallback_reason, status FROM ai_runs`
    );
    expect(audit.rows).toEqual([{
      surface: 'actualization', prompt_version: 'actualization-v1', validation_status: 'rejected',
      fallback_reason: `unknown_place:headPlaceId:${OTHER_OBLAST}`, status: 'failed'
    }]);

    await actualization.runTrackActualization({ chat });
    expect(chat).toHaveBeenCalledOnce();
  });

  it('lets the console set the fast model and the switch, and refuses the tier the backend answers with 400', async () => {
    // Схема тіла PUT відкидає невідомі ключі мовчки, тож поле, забуте в ній, виглядало б збереженим
    // і не зберігалося б ніколи. Звідси — повний коловорот через маршрут, а не лише `applySettingsPatch`.
    const Fastify = (await import('fastify')).default;
    const routes = (await import('../../src/api/ops-codex-routes.js')).default;
    const app = Fastify({ logger: false });
    await app.register(routes);
    await app.ready();
    const put = (payload: Record<string, unknown>) => app.inject({
      method: 'PUT', url: '/ops/codex/settings', headers: { authorization: OPS }, payload
    });
    try {
      const saved = await put({ model: 'gpt-5.6-luna', fastModel: 'gpt-6-luna', features: { actualization: true } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().settings).toMatchObject({
        effectiveModel: 'gpt-5.6-luna', fastModel: 'gpt-6-luna', effectiveFastModel: 'gpt-6-luna',
        features: { actualization: true }
      });
      expect((await put({ fastModel: '' })).json().settings)
        .toMatchObject({ fastModel: null, effectiveFastModel: 'gpt-5.6-luna' });
      const read = await app.inject({ method: 'GET', url: '/ops/codex/settings', headers: { authorization: OPS } });
      expect(read.json().settings).toMatchObject({ fastModel: null, features: { actualization: true } });
      expect((await put({ serviceTier: 'flex' })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
