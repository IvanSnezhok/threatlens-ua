import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

/**
 * Дірка в каталозі, названа своїм імʼям.
 *
 * `no_location` на моніторинговому каналі — це правильно складене попередження, яке не підняло
 * нічого, бо названого села немає в каталозі. Досі з нього лишався САМЕ лічильник:
 * `threatlens_classification_rejections_total{reason="no_location"}` казав, що діра є, і ніколи не
 * казав, яка. Офіційні фіди такої проблеми не мають — вони називають місце окремим полем, і воно
 * їде в `recordUnresolvedLocations`, звідки `/ops` його вже читає.
 *
 * Цей файл пінить, що проза тепер їде туди ж і тим самим акцесором: якби гіпотези писалися в
 * структуру, якої `src/api/ops-sources-routes.ts` не читає, фіча була б рівно так само невидимою,
 * як і до неї, а тести на саме виділення гіпотез і далі були б зеленими.
 */

const ERADAR = 'osint-eradar';
let sequence = 0;

async function ingest(text: string) {
  const { processMessage } = await import('../../src/services/ingestion.js');
  sequence += 1;
  return processMessage({
    sourceId: ERADAR, externalId: `gap-${sequence}`, publishedAt: new Date(), text, rawPayload: { test: true }
  }, { monitor: true });
}

async function gapsFor(sourceId: string) {
  const { unresolvedLocationReports } = await import('../../src/services/ingestion.js');
  return unresolvedLocationReports().find((report) => report.sourceId === sourceId);
}

describe.skipIf(!integrationDatabaseAvailable)('place names the catalogue does not hold', () => {
  beforeAll(ensureMigrated);

  beforeEach(async () => {
    await resetDatabase();
    const {
      resetMonitorCoalescing, resetSourceDescriptors, resetUnresolvedLocations
    } = await import('../../src/services/ingestion.js');
    resetMonitorCoalescing();
    resetSourceDescriptors();
    resetUnresolvedLocations();
  });

  it('names the unmatched place of a no_location rejection, through the accessor /ops already reads', async () => {
    const outcome = await ingest('Ударний БпЛА курсом на Кароліну! Будьте уважні.');
    expect(outcome).toEqual({ ignored: true });
    // Саме `no_location`: загрозу правила впізнали, місця — ні. Інакше цей тест пінив би не те.
    const archived = await sql<{ ignored_reason: string }>(
      `SELECT ignored_reason FROM message_classifications WHERE source_id=$1`, [ERADAR]
    );
    expect(archived.rows[0]!.ignored_reason).toBe('no_location');
    expect(await gapsFor(ERADAR)).toMatchObject({ sourceId: ERADAR, count: 1, samples: ['Кароліну'] });
  });

  it('accumulates across messages instead of overwriting, and counts observations', async () => {
    // У прози немає «знімка», з якого можна перечитати все наново: рядок, переписаний останнім
    // повідомленням, показував би оператору одне слово замість переліку дір.
    await ingest('Шахед курсом на Кароліну!');
    await ingest('Балістика курсом на Залісся та Кароліну!');
    const report = await gapsFor(ERADAR);
    expect(report!.samples).toEqual(['Залісся', 'Кароліну']);
    expect(report!.count).toBe(3);
  });

  it('says nothing for a message the rules refused for any other reason', async () => {
    // «Не впізнали твердження» — це словник каналу, а не каталог, і перелік гіпотез про місця там
    // був би шумом, який ховає справжні дірки.
    await ingest('Доброго ранку, друзі. Підписуйтеся на наш канал.');
    expect(await gapsFor(ERADAR)).toBeUndefined();
  });

  it('says nothing when the catalogue did match, however many other capitalised words there are', async () => {
    const outcome = await ingest('Балістика курсом на Полтавщину, попереджає Генштаб.') as { id?: string };
    expect(outcome.id).toBeTruthy();
    expect(await gapsFor(ERADAR)).toBeUndefined();
  });
});
