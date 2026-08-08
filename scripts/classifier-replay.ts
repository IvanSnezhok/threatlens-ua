/**
 * Replays the current classifier over the archived corpus and reports what moved.
 *
 *   npm run classifier:replay -- [--days 30] [--limit 5000] [--source telegram:xxx]
 *                                [--examples 20] [--write] [--json]
 *
 * ## Why this exists
 *
 * `message_classifications` keeps one decision per message per classifier version, and the
 * `UNIQUE (source_message_id, classifier_version)` constraint was put there so a new version could
 * hold an opinion beside an old one instead of overwriting it. That made the archive a golden
 * corpus in principle. In practice nothing replayed it, so raising CLASSIFIER_VERSION was an act of
 * faith: the effect of a regex edit on three months of real traffic was unmeasured until it reached
 * subscribers.
 *
 * The default is `--dry`: read the archive, classify the stored text with the rules as they are
 * *now*, print the difference, write nothing. `--write` additionally records the fresh verdicts
 * under the current version, which is what makes the comparison durable — after it, the analytics
 * can hold the instrument constant across a version boundary.
 *
 * ## What `--write` does and does not claim
 *
 * It writes a classification row, not an event. No threat is raised, no alert is sent, no risk
 * signal is decayed — `created_event` is false and `event_id` is NULL on every replayed row, which
 * is the archive's own way of saying "this decision was made after the fact". A replayed row for a
 * version that already has one is left alone (`ON CONFLICT DO NOTHING`), so the command is safe to
 * run twice.
 *
 * The diff itself lives in `src/domain/classifier-replay.ts` and is unit-tested without a database.
 * Everything here is I/O.
 */
import { classifyMessage, CLASSIFIER_VERSION, significanceRejection } from '../src/domain/classifier.js';
import {
  archivedWasSignificant, formatReplayReport, replayReport,
  type ArchivedVerdict, type ReplayInput
} from '../src/domain/classifier-replay.js';
import { pool } from '../src/db/pool.js';
import { listLocationLexemes } from '../src/repositories/events.js';

interface Options {
  days: number;
  limit: number;
  sourceId: string | null;
  examples: number;
  write: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { days: 30, limit: 5000, sourceId: null, examples: 20, write: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--write') options.write = true;
    // Accepted and ignored: it is the default, and an operator who types it deserves to be told it
    // worked rather than that the flag is unknown.
    else if (flag === '--dry') options.write = false;
    else if (flag === '--json') options.json = true;
    else if (flag === '--days' && value) { options.days = Number(value); index += 1; }
    else if (flag === '--limit' && value) { options.limit = Number(value); index += 1; }
    else if (flag === '--examples' && value) { options.examples = Number(value); index += 1; }
    else if (flag === '--source' && value) { options.sourceId = value; index += 1; }
    else if (flag) throw new Error(`Невідомий аргумент: ${flag}`);
  }
  for (const [name, value] of [['days', options.days], ['limit', options.limit], ['examples', options.examples]] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} має бути додатним числом`);
  }
  return options;
}

interface ArchiveRow {
  source_message_id: string;
  source_id: string;
  raw_text: string;
  published_at: Date;
  classifier_version: string;
  threat_type: string | null;
  created_event: boolean;
  decision: string;
  location_ids: string[] | null;
}

/**
 * The newest archived verdict per message, excluding ones already made by the current version.
 *
 * `DISTINCT ON` rather than a join on the newest version string: versions are not ordered
 * lexicographically forever ('v10' sorts before 'v2'), and `classified_at DESC` is the ordering that
 * actually means "the last thing we thought about this message".
 *
 * Messages the current version has already judged are excluded because comparing a version with
 * itself is noise, and because a replay is meant to be re-runnable without the corpus shrinking each
 * time `--write` lands rows.
 */
async function loadArchive(options: Options): Promise<ArchiveRow[]> {
  const result = await pool.query<ArchiveRow>(
    `SELECT DISTINCT ON (mc.source_message_id)
            mc.source_message_id, mc.source_id, sm.raw_text, mc.published_at,
            mc.classifier_version, mc.threat_type, mc.created_event, mc.decision,
            (SELECT array_agg(l.location_id)
               FROM message_classification_locations l
              WHERE l.classification_id = mc.id AND l.role = 'asserted') AS location_ids
       FROM message_classifications mc
       JOIN source_messages sm ON sm.id = mc.source_message_id
      WHERE mc.published_at > now() - ($1 || ' days')::interval
        AND mc.classifier_version <> $2
        AND ($3::text IS NULL OR mc.source_id = $3)
        AND sm.raw_text <> ''
        AND NOT EXISTS (
          SELECT 1 FROM message_classifications current
           WHERE current.source_message_id = mc.source_message_id
             AND current.classifier_version = $2
        )
      ORDER BY mc.source_message_id, mc.classified_at DESC
      LIMIT $4`,
    [String(options.days), CLASSIFIER_VERSION, options.sourceId, options.limit]
  );
  return result.rows;
}

async function writeVerdicts(inputs: ReplayInput[], rows: Map<string, ArchiveRow>): Promise<number> {
  let written = 0;
  for (const { archived, fresh } of inputs) {
    const row = rows.get(archived.sourceMessageId)!;
    // The same three-way judgement the live pipeline records, taken from the same function so the
    // replayed rows are comparable with the archived ones rather than merely similar to them.
    const rejection = significanceRejection(fresh);
    const decision = fresh.intent === 'de_escalation' ? 'de_escalation'
      : rejection === null ? (fresh.intent === 'redirect' ? 'redirect' : 'event_created')
        : rejection === 'no_location' ? 'ignored' : 'unrecognized';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO message_classifications(
           source_message_id, source_id, classifier_version, published_at, decision, intent,
           created_event, ignored_reason, threat_type, candidate_threat_types, indicators,
           national_scope, direction_text)
         VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (source_message_id, classifier_version) DO NOTHING
         RETURNING id`,
        [
          archived.sourceMessageId, row.source_id, CLASSIFIER_VERSION, row.published_at, decision,
          fresh.intent, rejection, fresh.threatType === 'unknown' ? null : fresh.threatType,
          fresh.signalThreatTypes, fresh.indicators, fresh.nationalScope, fresh.directionText ?? null
        ]
      );
      const id = inserted.rows[0]?.id;
      if (id) {
        written += 1;
        for (const location of fresh.locations) {
          // The catalogue moves between the original classification and the replay, and a location
          // id that no longer exists must not abort a whole replay: the classification row is the
          // valuable part and it is already written.
          await client.query(
            `INSERT INTO message_classification_locations(classification_id, location_id, role, relation_type)
             VALUES ($1,$2,'asserted',$3) ON CONFLICT DO NOTHING`,
            [id, location.id, location.relationType]
          ).catch(() => undefined);
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.error(`Не вдалося записати вердикт для ${archived.sourceMessageId}: ${String(error)}`);
    } finally {
      client.release();
    }
  }
  return written;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const locations = await listLocationLexemes();
  const rows = await loadArchive(options);
  if (!rows.length) {
    console.log(`Архів не містить повідомлень для порівняння (версія ${CLASSIFIER_VERSION}, вікно ${options.days} дн.).`);
    return;
  }

  const byId = new Map(rows.map((row) => [row.source_message_id, row]));
  const inputs: ReplayInput[] = rows.map((row) => {
    const archived: ArchivedVerdict = {
      sourceMessageId: row.source_message_id,
      sourceId: row.source_id,
      text: row.raw_text,
      classifierVersion: row.classifier_version,
      threatType: row.threat_type,
      locationIds: row.location_ids ?? [],
      significant: archivedWasSignificant(row.decision)
    };
    return { archived, fresh: classifyMessage(row.raw_text, locations) };
  });

  const report = replayReport(inputs, CLASSIFIER_VERSION, options.examples);
  console.log(options.json ? JSON.stringify(report, null, 2) : formatReplayReport(report));

  if (!options.write) {
    console.log('\nРежим --dry: у базу нічого не записано. Додайте --write, щоб зберегти вердикти нової версії.');
    return;
  }
  const written = await writeVerdicts(inputs, byId);
  console.log(`\nЗаписано вердиктів версії ${CLASSIFIER_VERSION}: ${written} з ${inputs.length}.`);
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(error);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
