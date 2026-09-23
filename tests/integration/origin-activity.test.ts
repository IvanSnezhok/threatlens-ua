import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

/**
 * Зона походження малюється іконкою першого з її класів, тож порядок класів — це і є рішення, що
 * летить з моря. Порядок має бути за останньою згадкою, а не за абеткою: `array_agg(DISTINCT …)`
 * годинами показував `aviation` над акваторією, звідки джерела щойно повідомили про крилаті ракети.
 */

const SOURCE = 'osint-war-monitor';
let sequence = 0;

async function classify(zone: string, threatType: string | null, minutesAgo: number): Promise<void> {
  sequence += 1;
  const message = await sql<{ id: string }>(
    `INSERT INTO source_messages(source_id,external_id,published_at,raw_text,content_hash)
     VALUES ($1,$2,now() - make_interval(mins => $3::int),'fixture',$2) RETURNING id`,
    [SOURCE, `origin-activity-${sequence}`, minutesAgo]
  );
  await sql(
    `INSERT INTO message_classifications(source_message_id,source_id,classifier_version,published_at,
       decision,intent,threat_type,origin_zone)
     VALUES ($1,$2,'test',now() - make_interval(mins => $3::int),'event_created','threat',$4,$5)`,
    [message.rows[0]!.id, SOURCE, minutesAgo, threatType, zone]
  );
}

describe.skipIf(!integrationDatabaseAvailable)('origin zone activity', () => {
  beforeAll(async () => { await ensureMigrated(); });
  beforeEach(async () => { await resetDatabase(); });

  it('puts the class reported last first, and a named class before an unnamed one', async () => {
    await classify('black_sea', 'aviation', 40);
    await classify('black_sea', 'cruise_missile', 30);
    await classify('black_sea', 'aviation', 20);
    await classify('black_sea', 'cruise_missile', 10);
    // Свіжіше за все інше, але зброї не називає: це не довід проти класу, названого раніше.
    await classify('black_sea', 'unknown', 2);
    // Imported here, like everywhere in this project: `src/config.ts` reads the environment at import
    // time, and a suite skipped for want of a database must not load it at all.
    const { activeOriginZones } = await import('../../src/services/origin-activity.js');
    const [zone] = await activeOriginZones();
    expect(zone).toMatchObject({
      zoneId: 'black_sea', threatTypes: ['cruise_missile', 'aviation', 'unknown'], reports: 5, sources: 1
    });
  });
});
