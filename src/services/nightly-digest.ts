import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { groundedNumbers, ungroundedNumber } from './analytics-narrative.js';
import { codexChat, type CodexClientDeps } from './codex-client.js';
import { codexFeatureEnabled } from './codex-settings.js';

interface DigestAssessment {
  chat_id: string;
  id: string;
  location_id: string;
  location_name: string;
  threat_type: string;
  risk_score: string;
  risk_level: string;
  indicative_percent: number | null;
  assessment_confidence: string;
  explanation: Record<string, unknown>;
  generated_at: Date;
  horizon_end: Date;
}

function kyivParts(now: Date): { date: string; minutes: number; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  const hour = Number(value('hour')); const minute = Number(value('minute'));
  return { date: `${value('year')}-${value('month')}-${value('day')}`, minutes: hour * 60 + minute, time: `${value('hour')}:${value('minute')}` };
}

// ------------------------------------------------------------------------------------------------
// The optional one-sentence opener written by a model
// ------------------------------------------------------------------------------------------------
//
// Що читає людина о 23:20 — це список оцінок, який згенерував детермінований рушій ризику. Модель
// не бере участі в жодному числі з цього списку; вона лише може додати один підсумковий рядок
// під переліком, який стисло каже, на що дивитися першим. Вимкнена — дайджест точно такий, яким був завжди.

export interface DigestFacts {
  time: string;
  locations: Array<{ locationName: string; threatType: string; level: string; indicativePercent: number | null; score: string }>;
  omitted: number;
}

/** Рівно ті факти, які потрапляють у повідомлення. Модель не бачить нічого понад це. */
export function digestFacts(rows: DigestAssessment[], omitted: number, time: string): DigestFacts {
  return {
    time,
    locations: rows.map((row) => ({
      locationName: row.location_name,
      threatType: row.threat_type,
      level: row.risk_level,
      indicativePercent: row.indicative_percent,
      score: row.risk_score
    })),
    omitted
  };
}

const DIGEST_SYSTEM_PROMPT = [
  'Ти пишеш ОДНЕ речення українською для нічного зведення системи повітряних загроз.',
  'Тобі надано готовий список оцінок. Твоє завдання — спокійно назвати, на що звернути увагу першим.',
  'Заборонено: вигадувати числа, назви місць чи типи загроз, яких немає у вхідному JSON.',
  'Заборонено: прогнозувати ціль, влучання, маршрут, час удару або безпеку конкретного місця.',
  'Заборонено: паніка, заклики, оклики, канцелярит. Тон — рівний і стриманий.',
  'Поверни лише JSON: {"summary": string} довжиною до 220 символів.'
].join(' ');

export interface DigestSummary {
  text: string | null;
  aiGenerated: boolean;
  /** Чому моделі не вийшло. null — коли вийшло або коли її й не питали. */
  rejectionReason: string | null;
}

const NO_SUMMARY: DigestSummary = { text: null, aiGenerated: false, rejectionReason: null };

export interface DigestSummaryDeps extends CodexClientDeps {
  /** Перевірка перемикача. Підмінюється в тестах, щоб не тягнути базу в юніт-тест. */
  featureEnabled?: () => Promise<boolean>;
}

/**
 * Один рядок від моделі — або нічого.
 *
 * Ніколи не кидає винятків і ніколи не затримує чергу назавжди: усе, що може піти не так, дає
 * `{ text: null }`, і дайджест іде в тому вигляді, у якому йшов би без моделі. Числа, які модель
 * написала, перевіряються тим самим механізмом, що й наратив аналітики: одне негрунтоване число
 * відкидає весь рядок, бо читач не має способу відрізнити вигадану цифру від справжньої.
 */
export async function digestSummary(facts: DigestFacts, deps: DigestSummaryDeps = {}): Promise<DigestSummary> {
  if (!facts.locations.length) return NO_SUMMARY;
  const enabled = await (deps.featureEnabled ?? (() => codexFeatureEnabled('digest')))();
  if (!enabled) return NO_SUMMARY;

  const result = await codexChat({
    promptVersion: 'nightly-digest-v1',
    system: DIGEST_SYSTEM_PROMPT,
    user: JSON.stringify(facts),
    json: true,
    auditInput: facts
  }, deps);
  if (!result.ok) return { text: null, aiGenerated: false, rejectionReason: result.reason };

  let summary: unknown;
  try {
    summary = (JSON.parse(result.content) as { summary?: unknown }).summary;
  } catch {
    return { text: null, aiGenerated: false, rejectionReason: 'unparsable_json' };
  }
  if (typeof summary !== 'string' || !summary.trim() || summary.length > 220) {
    return { text: null, aiGenerated: false, rejectionReason: 'unusable_summary' };
  }
  const invented = ungroundedNumber(summary, groundedNumbers(facts));
  if (invented) return { text: null, aiGenerated: false, rejectionReason: `ungrounded_number:${invented}` };
  return { text: summary.trim(), aiGenerated: true, rejectionReason: null };
}

export async function enqueueNightlyDigests(now = new Date()): Promise<number> {
  const current = kyivParts(now);
  const [targetHour, targetMinute] = config.NIGHTLY_DIGEST_TIME.split(':').map(Number);
  if (current.minutes < targetHour! * 60 + targetMinute!) return 0;

  const assessments = await pool.query<DigestAssessment>(
    `SELECT DISTINCT s.chat_id::text,a.id,a.location_id,l.name_uk AS location_name,a.threat_type,
            a.risk_score,a.risk_level,a.indicative_percent,a.assessment_confidence,a.explanation,
            a.generated_at,a.horizon_end
     FROM subscriptions s
     JOIN telegram_users u ON u.chat_id=s.chat_id AND u.enabled=true
     JOIN locations l ON l.id=s.location_id
     JOIN risk_assessments a ON a.location_id=s.location_id AND a.published=true
       AND a.superseded_by IS NULL AND a.expires_at>now()
       AND (s.threat_type='*' OR s.threat_type=a.threat_type)
     WHERE s.enabled=true AND s.notify_analytics=true
     ORDER BY s.chat_id::text,a.risk_score DESC,a.generated_at DESC`
  );
  const grouped = new Map<string, DigestAssessment[]>();
  for (const assessment of assessments.rows) {
    const rows = grouped.get(assessment.chat_id) ?? [];
    rows.push(assessment); grouped.set(assessment.chat_id, rows);
  }

  // Кому дайджест уже надіслано сьогодні — з'ясовуємо ДО циклу, а не всередині транзакції.
  // Планувальник будить цю функцію щопівхвилини аж до півночі, тож після першого успішного прогону
  // всі підписники вже claimed і робота зводиться до `ON CONFLICT DO NOTHING`. Без цього списку
  // модель питали б заново на кожному тику — десятки разів за ніч, за дані, які нікуди не підуть.
  // Вставка з ON CONFLICT нижче лишається справжнім захистом від гонки; це — лише економія.
  const alreadySent = await pool.query<{ chat_id: string }>(
    'SELECT chat_id::text FROM nightly_digest_runs WHERE digest_date=$1', [current.date]
  );
  const sent = new Set(alreadySent.rows.map((row) => row.chat_id));

  let queued = 0;
  // Один виклик моделі на КОМБІНАЦІЮ оцінок, а не на підписника. Тисяча людей, підписаних на Київ,
  // отримує той самий перелік, і питати модель тисячу разів про однакові дані означало б витратити
  // квоту акаунта на буквальні дублікати. Кеш живе рівно один прогін: наступного вечора дані інші.
  const summaries = new Map<string, DigestSummary>();

  for (const [chatId, rows] of grouped) {
    if (sent.has(chatId)) continue;
    const selected = rows.slice(0, 12);
    const facts = digestFacts(selected, Math.max(0, rows.length - selected.length), current.time);
    const key = JSON.stringify(facts);
    let summary = summaries.get(key);
    if (!summary) {
      summary = await digestSummary(facts);
      summaries.set(key, summary);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query(
        `INSERT INTO nightly_digest_runs(digest_date,chat_id) VALUES ($1,$2)
         ON CONFLICT DO NOTHING`, [current.date, chatId]
      );
      if (!claimed.rowCount) { await client.query('ROLLBACK'); continue; }
      const outbox = await client.query<{ id: string }>(
        `INSERT INTO notification_outbox(assessment_id,chat_id,notification_type,idempotency_key,priority,payload)
         VALUES ($1,$2,'nightly_digest',$3,4,$4) RETURNING id`,
        [selected[0]!.id, chatId, `nightly:${current.date}:${chatId}`, JSON.stringify({
          generatedTime: current.time,
          date: current.date,
          assessments: selected.map((row) => ({
            locationName: row.location_name, threatType: row.threat_type, score: row.risk_score,
            level: row.risk_level, indicativePercent: row.indicative_percent,
            confidence: row.assessment_confidence, explanation: row.explanation,
            horizonEnd: row.horizon_end
          })),
          omitted: facts.omitted,
          // Позначка їде разом із текстом, а не виводиться з його наявності: повідомлення форматує
          // інший модуль, і він не має здогадуватися, звідки взявся рядок.
          aiSummary: summary.text,
          aiGenerated: summary.aiGenerated
        })]
      );
      await client.query(
        `UPDATE nightly_digest_runs SET outbox_id=$3 WHERE digest_date=$1 AND chat_id=$2`,
        [current.date, chatId, outbox.rows[0]!.id]
      );
      await client.query('COMMIT');
      queued += 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return queued;
}

export function startNightlyDigestScheduler(log: { info: Function; error: Function }): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const queued = await enqueueNightlyDigests();
      if (queued) log.info({ queued }, 'nightly digests queued');
    } catch (error) {
      log.error({ error }, 'nightly digest scheduling failed');
    } finally { running = false; }
  };
  const timer = setInterval(run, 30_000);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
