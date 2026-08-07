import type { Bot } from 'grammy';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { relatedLocationsCte } from '../repositories/events.js';

const threatLabels: Record<string, string> = {
  uav: 'ударні БпЛА', ballistic_missile: 'балістичні ракети',
  cruise_missile: 'крилаті ракети', guided_air_bomb: 'керовані авіаційні бомби',
  aviation: 'активність авіації', mlrs: 'РСЗВ', artillery: 'артилерія',
  mortar: 'мінометний обстріл', combined: 'комбінована загроза', unknown: 'невизначена загроза'
};
const levelLabels: Record<string, string> = {
  background: 'фоновий', elevated: 'підвищений', significant: 'значний',
  high: 'високий', very_high: 'дуже високий'
};

function html(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]!);
}

async function insertForSubscribers(args: {
  locationId: string; type: string; entityId: string; eventVersion: number;
  priority: number; payload: Record<string, unknown>; threatType?: string; evidenceLevel?: string;
}) {
  // `related_locations` is the whole ancestor and descendant chain of the event location, so an
  // oblast subscriber keeps receiving a city event once a raion sits between the two. `DISTINCT`
  // collapses a chat that holds several matching subscriptions (oblast *and* raion *and* city) into
  // the single outbox row `idempotency_key` would otherwise have to absorb.
  await pool.query(
    `${relatedLocationsCte()}
     INSERT INTO notification_outbox(event_id,alert_period_id,assessment_id,chat_id,notification_type,idempotency_key,priority,payload)
     SELECT DISTINCT
            CASE WHEN $2='threat_update' THEN $3::uuid END,
            CASE WHEN $2 IN ('alert_start','alert_end') THEN $3::uuid END,
            CASE WHEN $2='assessment_update' THEN $3::uuid END,
            s.chat_id,$2::text,$3||':'||s.chat_id||':'||$2||':'||$4,$5::integer,$6::jsonb
     FROM subscriptions s JOIN telegram_users u ON u.chat_id=s.chat_id
     WHERE s.enabled=true AND u.enabled=true
       AND EXISTS (SELECT 1 FROM related_locations r WHERE r.id=s.location_id)
       AND (
         ($2='alert_start' AND s.notify_alert_start=true) OR
         ($2='alert_end' AND s.notify_alert_end=true) OR
         ($2='assessment_update' AND s.notify_analytics=true AND (s.threat_type='*' OR s.threat_type=$7)) OR
         ($2='threat_update' AND s.notify_threats=true AND (s.threat_type='*' OR s.threat_type=$7)
           AND CASE $8 WHEN 'official' THEN 3 WHEN 'confirmed' THEN 2 WHEN 'monitoring' THEN 1 ELSE 0 END >=
               CASE s.minimum_evidence_level WHEN 'official' THEN 3 WHEN 'confirmed' THEN 2 WHEN 'monitoring' THEN 1 ELSE 0 END)
       )
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [args.locationId, args.type, args.entityId, args.eventVersion, args.priority,
      JSON.stringify(args.payload), args.threatType ?? '*', args.evidenceLevel ?? 'unverified']
  );
}

async function enqueueForEvent(event: any) {
  if (event.event_type.startsWith('alert.')) {
    const locationId = String(event.payload.locationId);
    const entityId = String(event.payload.alertId);
    const type = event.event_type === 'alert.started' ? 'alert_start' : 'alert_end';
    const location = (await pool.query(`SELECT name_uk FROM locations WHERE id=$1`, [locationId])).rows[0];
    await insertForSubscribers({
      locationId, type, entityId, eventVersion: Number(event.version), priority: type === 'alert_start' ? 0 : 2,
      payload: { locationName: location?.name_uk, mapUrl: `${config.PUBLIC_URL}/?location=${locationId}` }
    });
    return;
  }
  if (event.event_type.startsWith('threat.') && event.event_type !== 'threat.expired') {
    const entityId = String(event.payload.eventId);
    const threats = await pool.query(
      `SELECT e.*,el.location_id,l.name_uk FROM threat_events e
       JOIN threat_event_locations el ON el.event_id=e.id JOIN locations l ON l.id=el.location_id
       WHERE e.id=$1`, [entityId]
    );
    for (const threat of threats.rows) {
      await insertForSubscribers({
        locationId: threat.location_id, type: 'threat_update', entityId,
        eventVersion: Number(event.version), priority: threat.evidence_level === 'official' ? 1 : 3,
        threatType: threat.threat_type, evidenceLevel: threat.evidence_level,
        payload: {
          locationName: threat.name_uk, threatType: threat.threat_type, summary: threat.summary,
          evidenceLevel: threat.evidence_level, lastObservedAt: threat.last_observed_at,
          validUntil: threat.valid_until, mapUrl: `${config.PUBLIC_URL}/?event=${entityId}`
        }
      });
    }
    return;
  }
  if (event.event_type === 'assessment.updated') {
    const entityId = String(event.payload.assessmentId);
    const assessment = (await pool.query(
      `SELECT a.*,l.name_uk FROM risk_assessments a JOIN locations l ON l.id=a.location_id WHERE a.id=$1`, [entityId]
    )).rows[0];
    if (!assessment) return;
    await insertForSubscribers({
      locationId: assessment.location_id, type: 'assessment_update', entityId,
      eventVersion: Number(event.version), priority: 4, threatType: assessment.threat_type,
      payload: {
        locationName: assessment.name_uk, threatType: assessment.threat_type,
        score: assessment.risk_score, level: assessment.risk_level,
        indicativePercent: assessment.indicative_percent, confidence: assessment.assessment_confidence,
        explanation: assessment.explanation, horizonEnd: assessment.horizon_end,
        mapUrl: `${config.PUBLIC_URL}/?assessment=${entityId}`
      }
    });
  }
}

async function fanoutNewEvents() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO worker_state(worker_name,cursor_value) VALUES ('notification-fanout',0) ON CONFLICT DO NOTHING`);
    const state = await client.query(`SELECT cursor_value FROM worker_state WHERE worker_name='notification-fanout' FOR UPDATE`);
    let cursor = Number(state.rows[0].cursor_value);
    const events = await client.query(`SELECT * FROM system_event_log WHERE version>$1 ORDER BY version LIMIT 100`, [cursor]);
    await client.query('COMMIT');
    for (const event of events.rows) {
      await enqueueForEvent(event);
      cursor = Number(event.version);
      await pool.query(`UPDATE worker_state SET cursor_value=$2,updated_at=now() WHERE worker_name=$1`, ['notification-fanout', cursor]);
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export function formatMessage(row: any): string {
  const p = row.payload;
  if (row.notification_type === 'alert_start') {
    return `🔴 <b>Повітряна тривога — ${html(p.locationName)}</b>\n\nОфіційне сповіщення. Перейдіть до визначеного укриття та дотримуйтеся вказівок офіційних служб.\n\n<a href="${html(p.mapUrl)}">Відкрити карту</a>`;
  }
  if (row.notification_type === 'alert_end') {
    return `⚪ <b>Офіційний відбій — ${html(p.locationName)}</b>\n\nЗавершено конкретну офіційну тривогу. Перевірте локальні вказівки перед виходом з укриття.\n\n<a href="${html(p.mapUrl)}">Хронологія</a>`;
  }
  if (row.notification_type === 'assessment_update') {
    const factors = Array.isArray(p.explanation?.raisingFactors) ? p.explanation.raisingFactors.slice(0, 3) : [];
    return `📊 <b>Оновлення аналітики — ${html(p.locationName)}</b>\n\n${html(threatLabels[p.threatType] ?? p.threatType)}: <b>${html(levelLabels[p.level] ?? p.level)}</b> · ${html(p.score)}/10\nІндикативний рівень: ${html(p.indicativePercent)}% · впевненість: ${html(p.confidence)}${factors.length ? `\n\nЧинники:\n${factors.map((factor: string) => `• ${html(factor)}`).join('\n')}` : ''}\n\nЦе індекс публічних сигналів, не статистична ймовірність і не офіційна тривога.\n<a href="${html(p.mapUrl)}">Пояснення</a>`;
  }
  if (row.notification_type === 'nightly_digest') {
    const lines = (p.assessments as any[]).map((assessment) => {
      const factor = assessment.explanation?.raisingFactors?.[0];
      return `<b>${html(assessment.locationName)}</b> — ${html(threatLabels[assessment.threatType] ?? assessment.threatType)}\n${html(levelLabels[assessment.level] ?? assessment.level)} · ${html(assessment.indicativePercent)}% індикативного рівня · ${html(assessment.score)}/10${factor ? `\n↳ ${html(factor)}` : ''}`;
    });
    const omitted = p.omitted ? `\n\nЩе оцінок: ${html(p.omitted)} — перегляньте на сайті.` : '';
    return `🌙 <b>Оновлення аналітики станом на ${html(p.generatedTime)}</b>\n\n${lines.join('\n\n')}${omitted}\n\nРівень сформовано з публічних сигналів на горизонт до 6 годин. Це не статистична ймовірність, не прогноз цілі та не офіційна тривога. У разі тривоги перейдіть до визначеного укриття.\n\n<a href="${html(p.mapUrl)}">Карта й пояснення</a>`;
  }
  return `⚠️ <b>${html(p.locationName)}</b>\n${html(threatLabels[p.threatType] ?? p.threatType)}\nРівень доказовості: ${html(p.evidenceLevel)}\n\n${html(p.summary)}\n\nДані дійсні до: ${html(p.validUntil ?? 'не вказано')}\n<a href="${html(p.mapUrl)}">Карта та джерела</a>`;
}

const sendingReclaimSeconds = 300;
const maxAttempts = 8;

async function reclaimStuckSending(): Promise<number> {
  const reclaimed = await pool.query(
    `UPDATE notification_outbox
     SET status=CASE WHEN attempts>=$2 THEN 'failed' ELSE 'retry' END,next_attempt_at=now(),updated_at=now()
     WHERE status='sending' AND updated_at < now()-($1||' seconds')::interval`,
    [sendingReclaimSeconds, maxAttempts]
  );
  return reclaimed.rowCount ?? 0;
}

async function deliverBatch(bot: Bot, log: { warn: Function }) {
  const reclaimed = await reclaimStuckSending();
  if (reclaimed) log.warn({ reclaimed }, 'reclaimed notifications stuck in sending');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batch = await client.query(
      `SELECT * FROM notification_outbox WHERE status IN ('pending','retry') AND next_attempt_at<=now()
       ORDER BY priority,created_at LIMIT 25 FOR UPDATE SKIP LOCKED`
    );
    for (const row of batch.rows) {
      await client.query(`UPDATE notification_outbox SET status='sending',attempts=attempts+1,updated_at=now() WHERE id=$1`, [row.id]);
    }
    await client.query('COMMIT');
    for (const row of batch.rows) {
      try {
        const sent = await bot.api.sendMessage(String(row.chat_id), formatMessage(row), {
          parse_mode: 'HTML', disable_notification: row.priority >= 3,
          link_preview_options: { is_disabled: true }
        });
        await pool.query(`UPDATE notification_outbox SET status='sent',sent_at=now(),updated_at=now() WHERE id=$1`, [row.id]);
        await pool.query(
          `INSERT INTO notification_deliveries(outbox_id,telegram_message_id,delivered_status,queued_at,sent_at)
           VALUES ($1,$2,'sent',$3,now())`, [row.id, sent.message_id, row.created_at]
        );
      } catch (error: any) {
        const code = String(error?.error?.error_code ?? error?.error_code ?? 'unknown');
        const retryAfter = Number(error?.error?.parameters?.retry_after ?? Math.min(300, 2 ** row.attempts));
        await pool.query(
          `UPDATE notification_outbox SET status=CASE WHEN attempts>=$4 OR $3 IN ('400','403') THEN 'failed' ELSE 'retry' END,
           next_attempt_at=now()+($2||' seconds')::interval,updated_at=now() WHERE id=$1`, [row.id, retryAfter, code, maxAttempts]
        );
        await pool.query(
          `INSERT INTO notification_deliveries(outbox_id,delivered_status,error_code,queued_at)
           VALUES ($1,'failed',$2,$3)`, [row.id, code, row.created_at]
        );
        if (code === '403') await pool.query(`UPDATE telegram_users SET enabled=false WHERE chat_id=$1`, [row.chat_id]);
      }
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export function startNotificationWorkers(bot: Bot | null, log: { warn: Function; error: Function }) {
  const fanoutRun = () => fanoutNewEvents().catch((error) => log.error({ error }, 'notification fanout failed'));
  const fanout = setInterval(fanoutRun, 1_000); fanout.unref(); void fanoutRun();
  const deliveryRun = () => bot && deliverBatch(bot, log).catch((error) => log.error({ error }, 'notification delivery failed'));
  const delivery = bot ? setInterval(deliveryRun, 1_000) : undefined; delivery?.unref(); if (bot) void deliveryRun();
  return () => { clearInterval(fanout); if (delivery) clearInterval(delivery); };
}
