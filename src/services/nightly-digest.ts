import { config } from '../config.js';
import { pool } from '../db/pool.js';

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

  let queued = 0;
  for (const [chatId, rows] of grouped) {
    const selected = rows.slice(0, 12);
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
          omitted: Math.max(0, rows.length - selected.length),
          mapUrl: `${config.PUBLIC_URL}/analytics`
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
