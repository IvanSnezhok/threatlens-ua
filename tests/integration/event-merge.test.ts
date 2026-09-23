import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ClassifiedMessage, ThreatType } from '../../src/types.js';
import type { IngestThreatOptions } from '../../src/repositories/events.js';
import { ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

/**
 * Правило злиття подій наскрізно: справжній `ingestThreat`, справжній запит кандидатів і місць,
 * справжній архів класифікацій, з якого правило читає голову події.
 *
 * Повідомлення проходить тим самим шляхом, що й у `processMessage`: транзакція події, а за нею запис
 * класифікації в архів (`recordClassification`) — саме так архів отримує місця, з яких складаються
 * поточні місця й голова події. Чисте правило закріплене в `src/domain/event-merge.test.ts`; тут —
 * те, чого без бази не перевірити: що SQL приносить потрібних кандидатів, що клас уточнюється в рядку
 * події й лишає слід в історії, і що очікувана подія зливається так, як і раніше.
 */

const SOURCE = 'osint-eradar';
const MINUTE = 60_000;
const KYIV = 'ua-80';
const KYIV_OBLAST = 'ua-32';
const KROPYVNYTSKYI = 'ua-city-kropyvnytskyi';
const BILA_TSERKVA = 'ua-city-bila-tserkva';
const CHERKASY = 'ua-city-cherkasy';
const CHERKASY_OBLAST = 'ua-71';
// Бровари й Славутич — рядки KATOTTG, яких свіжа тестова база не має; точки ті самі, що в міграції 056.
const BROVARY = 'test-merge-brovary';
const SLAVUTYCH = 'test-merge-slavutych';

const TITLES: Readonly<Record<string, string>> = {
  uav: 'Ударні БпЛА', unknown: 'Загроза', ballistic_missile: 'Балістика'
};

let sequence = 0;

/**
 * One monitoring message, through the transaction and the archive in the order `processMessage`
 * uses. `headings` are the places the message names as a heading («курс на …»), the rest are where
 * the target is.
 */
async function report(
  places: string[],
  options: {
    threatType?: ThreatType; minutesAgo?: number; headings?: string[]; text?: string; ingest?: IngestThreatOptions;
  } = {}
): Promise<{ id: string; created: boolean }> {
  // Dynamic, as everywhere in this suite: `src/config.ts` and the pool are built at import time, and
  // this file must stay importable — and skipped — where no database is configured.
  const { ingestThreat, recordClassification } = await import('../../src/repositories/events.js');
  const threatType = options.threatType ?? 'uav';
  const publishedAt = new Date(Date.now() - (options.minutesAgo ?? 0) * MINUTE);
  sequence += 1;
  const classified: ClassifiedMessage = {
    intent: 'threat',
    threatType,
    signalThreatTypes: [threatType],
    locations: places.map((id) => ({
      id, name: id, relationType: options.headings?.includes(id) ? 'reported_direction' : 'explicit_threat'
    })),
    nationalScope: false,
    indicators: [],
    title: TITLES[threatType] ?? threatType,
    summary: `Повідомлення ${sequence}`
  };
  const result = await ingestThreat({
    sourceId: SOURCE, externalId: `merge-${sequence}`, publishedAt,
    text: options.text ?? `Повідомлення ${sequence}: ${places.join(', ')}`, rawPayload: { test: true }
  }, classified, options.ingest);
  await recordClassification({
    sourceId: SOURCE, sourceMessageId: result.sourceMessageId, publishedAt, classified,
    decision: result.created ? 'event_created' : 'event_merged', eventId: result.id, createdEvent: result.created
  });
  return result;
}

async function eventCount(): Promise<number> {
  return (await sql(`SELECT 1 FROM threat_events`)).rowCount ?? 0;
}

describe.skipIf(!integrationDatabaseAvailable)('threat event merging', () => {
  beforeAll(ensureMigrated);

  beforeEach(async () => {
    await resetDatabase();
    await sql(
      `INSERT INTO locations(id,parent_id,type,name_uk,latitude,longitude) VALUES
         ($1,$3,'city','Бровари',50.5111,30.7900),($2,$3,'city','Славутич',51.5201,30.7562)`,
      [BROVARY, SLAVUTYCH, KYIV_OBLAST]
    );
  });

  it('keeps Київ and Кропивницький two minutes apart as two events, although both name Київщина', async () => {
    // «Київщина: БпЛА на Київ», then «БпЛА з Київщини на Кропивницький»: the old rule glued them on
    // the oblast; 250 km is not a leg any drone flies in two minutes.
    const kyiv = await report([KYIV_OBLAST, KYIV], { minutesAgo: 2, headings: [KYIV] });
    const kropyvnytskyi = await report([KYIV_OBLAST, KROPYVNYTSKYI], { headings: [KROPYVNYTSKYI] });
    expect(kropyvnytskyi.created).toBe(true);
    expect(kropyvnytskyi.id).not.toBe(kyiv.id);
  });

  it('joins Київ to a drone event at Бровари eight minutes earlier', async () => {
    const brovary = await report([BROVARY], { minutesAgo: 8 });
    const kyiv = await report([KYIV]);
    expect(kyiv).toMatchObject({ id: brovary.id, created: false });
    expect(await eventCount()).toBe(1);
  });

  it('joins a digest to the group it puts the target at, read from its text', async () => {
    // The same four places in two orders. A Ukrainian digest names each group's destination in turn,
    // and the one named last is where the track — and so the merge — puts the target.
    const brovary = await report([BROVARY], { minutesAgo: 3, headings: [BROVARY] });
    const places = [KYIV_OBLAST, BROVARY, CHERKASY_OBLAST, CHERKASY];
    const cherkasy = await report(places, {
      minutesAgo: 1, headings: [BROVARY, CHERKASY], text: 'Київщина: 6 на Бровари. Черкащина: 3 на Черкаси'
    });
    expect(cherkasy.id).not.toBe(brovary.id);
    const again = await report(places, {
      headings: [BROVARY, CHERKASY], text: 'Черкащина: 3 на Черкаси. Київщина: 6 на Бровари'
    });
    expect(again.id).toBe(brovary.id);
  });

  it('joins «курс на Бровари» that names no class to the drone event at Бровари, which stays a drone event', async () => {
    const drones = await report([BROVARY], { minutesAgo: 5 });
    const unnamed = await report([BROVARY], { threatType: 'unknown', headings: [BROVARY] });
    expect(unnamed).toMatchObject({ id: drones.id, created: false });
    const row = await sql<{ threat_type: string }>(`SELECT threat_type FROM threat_events WHERE id=$1`, [drones.id]);
    expect(row.rows[0]!.threat_type).toBe('uav');
  });

  it('upgrades an unknown event when a drone report joins it, and says so in its history', async () => {
    const unnamed = await report([BROVARY], { threatType: 'unknown', minutesAgo: 5 });
    const drones = await report([BROVARY]);
    expect(drones).toMatchObject({ id: unnamed.id, created: false });
    const row = await sql<{ threat_type: string; title: string }>(
      `SELECT threat_type, title FROM threat_events WHERE id=$1`, [unnamed.id]
    );
    expect(row.rows[0]).toEqual({ threat_type: 'uav', title: TITLES.uav });
    const history = await sql<{ reason: string }>(`SELECT reason FROM event_updates WHERE event_id=$1`, [unnamed.id]);
    expect(history.rows.map((update) => update.reason)).toEqual(['threat_type_refined']);
  });

  it('keeps two groups apart when all they share is Київська область', async () => {
    const north = await report([KYIV_OBLAST, SLAVUTYCH], { minutesAgo: 3 });
    const south = await report([KYIV_OBLAST, BILA_TSERKVA]);
    expect(south.created).toBe(true);
    expect(south.id).not.toBe(north.id);
  });

  it('does not join an event last seen longer ago than its class horizon', async () => {
    // Twenty-six minutes: the old flat half hour would have joined it, the drone window does not.
    const old = await report([BROVARY], { minutesAgo: 26 });
    const fresh = await report([BROVARY]);
    expect(fresh.created).toBe(true);
    expect(fresh.id).not.toBe(old.id);
  });

  it('keeps merging an expected event while its window is open, by the rule it always had', async () => {
    // «Увечері очікується балістика по Київщині» forty-five minutes ago, and now a report that shares
    // only the oblast with it. For a «now» event that is two groups; for an expected one it is the
    // same threat whose window is still open, exactly as before.
    const now = Date.now();
    const expected = await report([KYIV_OBLAST, SLAVUTYCH], {
      threatType: 'ballistic_missile', minutesAgo: 45,
      ingest: {
        assessment: {
          model: 'test-model', classifierVersion: 'codex-primary-v1', timing: 'evening', probability: 0.6,
          expectedFrom: new Date(now - 45 * MINUTE), expectedUntil: new Date(now + 3 * 60 * MINUTE), note: null
        }
      }
    });
    const current = await report([KYIV_OBLAST, BILA_TSERKVA], { threatType: 'ballistic_missile' });
    expect(current).toMatchObject({ id: expected.id, created: false });
    const row = await sql<{ timing: string }>(`SELECT timing FROM threat_events WHERE id=$1`, [expected.id]);
    expect(row.rows[0]!.timing).toBe('now');
  });
});
