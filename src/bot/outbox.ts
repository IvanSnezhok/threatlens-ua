import type { Bot } from 'grammy';
import { pool } from '../db/pool.js';
import { relatedLocationsCte } from '../repositories/events.js';
import {
  cleanSummary, confidenceLabel, evidenceStatement, humanMoment, levelLabel, threatLabel, validUntilLine
} from './humanize.js';

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

/**
 * Turns a source row into the link a reader can actually open to check us.
 *
 * Telegram sources keep the channel handle in `sources.telegram_username` and the message id in
 * `source_messages.external_id`, which together address the exact post the classification was built
 * from — that is the citation worth showing. When the id is not a plain message number (the polled
 * alert APIs synthesise their own ids) the channel front page is still honest, and a source with no
 * public address at all yields nothing rather than a link that goes nowhere.
 */
function sourceUrlFor(row: any): string | null {
  const username = String(row?.telegram_username ?? '').trim().replace(/^@/, '');
  const externalId = String(row?.external_id ?? '').trim();
  if (username && /^\d+$/.test(externalId)) return `https://t.me/${username}/${externalId}`;
  if (username) return `https://t.me/${username}`;
  const publicUrl = String(row?.public_url ?? '').trim();
  return /^https?:\/\//i.test(publicUrl) ? publicUrl : null;
}

/** Spread into a payload: contributes the two source fields, or nothing when there is no citation. */
function sourceFields(row: any): Record<string, string> {
  const url = sourceUrlFor(row);
  if (!url) return {};
  const name = String(row?.source_name ?? '').trim();
  return name ? { sourceUrl: url, sourceName: name } : { sourceUrl: url };
}

const sourceColumns = `s.name AS source_name,s.public_url,s.telegram_username,sm.external_id`;

/** The newest piece of evidence behind an event — the message a reader is most likely to recognise. */
async function latestEventSource(eventId: string): Promise<Record<string, string>> {
  const result = await pool.query(
    `SELECT ${sourceColumns}
     FROM event_evidence ee JOIN source_messages sm ON sm.id=ee.source_message_id
     JOIN sources s ON s.id=sm.source_id
     WHERE ee.event_id=$1 ORDER BY sm.published_at DESC LIMIT 1`, [eventId]
  );
  return sourceFields(result.rows[0]);
}

async function messageSource(sourceMessageId: string | null): Promise<Record<string, string>> {
  if (!sourceMessageId) return {};
  const result = await pool.query(
    `SELECT ${sourceColumns} FROM source_messages sm JOIN sources s ON s.id=sm.source_id WHERE sm.id=$1`,
    [sourceMessageId]
  );
  return sourceFields(result.rows[0]);
}

async function enqueueForEvent(event: any) {
  if (event.event_type.startsWith('alert.')) {
    const locationId = String(event.payload.locationId);
    const entityId = String(event.payload.alertId);
    const type = event.event_type === 'alert.started' ? 'alert_start' : 'alert_end';
    const location = (await pool.query(`SELECT name_uk FROM locations WHERE id=$1`, [locationId])).rows[0];
    // The alert row carries the times a reader asks about first ("since when?", "when did it end?")
    // and the message that announced it, which is the only citation an alert notification can have.
    const alert = (await pool.query(
      `SELECT started_at,ended_at,source_message_id FROM alert_periods WHERE id=$1`, [entityId]
    )).rows[0];
    await insertForSubscribers({
      locationId, type, entityId, eventVersion: Number(event.version), priority: type === 'alert_start' ? 0 : 2,
      payload: {
        locationName: location?.name_uk, startedAt: alert?.started_at, endedAt: alert?.ended_at,
        ...(await messageSource(alert?.source_message_id ?? null))
      }
    });
    return;
  }
  // `threat.withdrawn` is excluded for the same reason as `threat.expired`: both mean the threat is
  // no longer standing, and the payload this branch builds is the *original* threat text. Fanning
  // either one out re-sends "Шахед курсом на Полтавщину" to everyone who was already warned, at the
  // moment the warning stops applying. Nothing is sent instead of a stand-down message on purpose —
  // a withdrawal here comes from a monitoring source, and a message that reads as an all-clear must
  // only ever come from an official one.
  if (event.event_type.startsWith('threat.')
    && event.event_type !== 'threat.expired' && event.event_type !== 'threat.withdrawn') {
    const entityId = String(event.payload.eventId);
    const threats = await pool.query(
      `SELECT e.*,el.location_id,l.name_uk FROM threat_events e
       JOIN threat_event_locations el ON el.event_id=e.id JOIN locations l ON l.id=el.location_id
       WHERE e.id=$1`, [entityId]
    );
    const threatSource = await latestEventSource(entityId);
    for (const threat of threats.rows) {
      await insertForSubscribers({
        locationId: threat.location_id, type: 'threat_update', entityId,
        eventVersion: Number(event.version), priority: threat.evidence_level === 'official' ? 1 : 3,
        threatType: threat.threat_type, evidenceLevel: threat.evidence_level,
        payload: {
          locationName: threat.name_uk, threatType: threat.threat_type, summary: threat.summary,
          evidenceLevel: threat.evidence_level, lastObservedAt: threat.last_observed_at,
          validUntil: threat.valid_until, ...threatSource
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
    // The strongest contributing signal is the closest thing an assessment has to a first source:
    // the score is ours, but the observation that moved it belongs to whoever published it.
    const topSignal = (await pool.query(
      `SELECT ${sourceColumns}
       FROM risk_assessment_signals ras JOIN risk_signals rs ON rs.id=ras.signal_id
       JOIN source_messages sm ON sm.id=rs.source_message_id JOIN sources s ON s.id=sm.source_id
       WHERE ras.assessment_id=$1 ORDER BY ras.contribution DESC LIMIT 1`, [entityId]
    )).rows[0];
    await insertForSubscribers({
      locationId: assessment.location_id, type: 'assessment_update', entityId,
      eventVersion: Number(event.version), priority: 4, threatType: assessment.threat_type,
      payload: {
        locationName: assessment.name_uk, threatType: assessment.threat_type,
        score: assessment.risk_score, level: assessment.risk_level,
        indicativePercent: assessment.indicative_percent, confidence: assessment.assessment_confidence,
        explanation: assessment.explanation, horizonEnd: assessment.horizon_end,
        ...sourceFields(topSignal)
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

/**
 * The link back to the first source, or nothing at all.
 *
 * There is deliberately no fallback link. The map view these messages used to point at does not
 * exist yet, and a dead "Карта та джерела" costs more trust than a missing line: a reader who taps a
 * broken link during an alert learns that the bot's claims are not checkable.
 */
function sourceLine(payload: any): string | null {
  const url = typeof payload.sourceUrl === 'string' && /^https?:\/\//i.test(payload.sourceUrl)
    ? payload.sourceUrl : null;
  if (!url) return null;
  const name = String(payload.sourceName ?? '').trim();
  return `<a href="${html(url)}">Першоджерело${name ? `: ${html(name)}` : ''}</a>`;
}

/** Joins the detail block, dropping the lines whose data was missing. */
function details(...lines: (string | null)[]): string {
  const present = lines.filter((line): line is string => Boolean(line));
  return present.length ? `\n\n${present.join('\n')}` : '';
}

/**
 * Every message follows the same three beats: what happened and where, what the reader should do,
 * then the details that let them judge it (evidence, validity, source). The order is the point — a
 * person reading one notification on a lock screen at 03:00 sees the action before the metadata.
 *
 * `now` is injectable so the relative wording ("ще ~25 хв") is testable without freezing the clock.
 */
export function formatMessage(row: any, now: Date = new Date()): string {
  const p = row.payload;
  if (row.notification_type === 'alert_start') {
    const started = humanMoment(p.startedAt, now);
    return `🔴 <b>Повітряна тривога — ${html(p.locationName)}</b>\n\n`
      + 'Прямуйте до визначеного укриття й дотримуйтеся вказівок офіційних служб.'
      + details(
        started && `Оголошено о ${html(started)}`,
        'Офіційне сповіщення про тривогу',
        sourceLine(p)
      );
  }
  if (row.notification_type === 'alert_end') {
    const ended = humanMoment(p.endedAt, now);
    return `⚪ <b>Відбій тривоги — ${html(p.locationName)}</b>\n\n`
      + 'Перед виходом з укриття перевірте місцеві вказівки: відбій стосується лише цієї тривоги.'
      + details(
        ended && `Відбій о ${html(ended)}`,
        'Офіційне сповіщення про відбій',
        sourceLine(p)
      );
  }
  if (row.notification_type === 'assessment_update') {
    const factors = Array.isArray(p.explanation?.raisingFactors) ? p.explanation.raisingFactors.slice(0, 3) : [];
    const horizon = humanMoment(p.horizonEnd, now);
    const confidence = confidenceLabel(p.confidence);
    return `📊 <b>Оновлення аналітики — ${html(p.locationName)}</b>\n`
      + `${html(threatLabel(p.threatType))}: <b>${html(levelLabel(p.level))}</b> · ${html(p.score)}/10\n\n`
      + 'Це орієнтир для планування, а не сигнал тривоги. Окремих дій зараз не потрібно — '
      + 'реагуйте на офіційні сповіщення.'
      + (factors.length ? `\n\nЩо підвищує рівень:\n${factors.map((factor: string) => `• ${html(factor)}`).join('\n')}` : '')
      + details(
        p.indicativePercent != null ? `Індикативний рівень: ${html(p.indicativePercent)}%` : null,
        confidence ? `Впевненість оцінки: ${html(confidence)}` : null,
        horizon && `Оцінка чинна до ${html(horizon)}`,
        'Це індекс публічних сигналів, не статистична ймовірність і не офіційна тривога.',
        sourceLine(p)
      );
  }
  if (row.notification_type === 'nightly_digest') {
    const lines = (p.assessments as any[]).map((assessment) => {
      const factor = assessment.explanation?.raisingFactors?.[0];
      return `<b>${html(assessment.locationName)}</b> — ${html(threatLabel(assessment.threatType))}\n`
        + `${html(levelLabel(assessment.level))} · ${html(assessment.indicativePercent)}% індикативного рівня · ${html(assessment.score)}/10`
        + (factor ? `\n↳ ${html(factor)}` : '');
    });
    // `generatedTime` is already a Kyiv HH:MM produced by the digest scheduler; anything else that
    // reaches this field still goes through the formatter rather than being printed raw.
    const generated = /^\d{1,2}:\d{2}$/.test(String(p.generatedTime ?? ''))
      ? String(p.generatedTime) : humanMoment(p.generatedTime, now);
    const horizon = humanMoment((p.assessments as any[])[0]?.horizonEnd, now);
    const omitted = p.omitted ? `\n\nЩе оцінок: ${html(p.omitted)} — перегляньте на сайті.` : '';
    // Рядок від моделі підписано вголос і поставлено ПІСЛЯ переліку. Оцінки — це те, заради чого
    // надіслано повідомлення, і машинне речення не має ставати першим, що читає людина вночі.
    const aiSummary = p.aiGenerated && p.aiSummary
      ? `\n\n<i>Стисло (написала мовна модель за цими ж оцінками): ${html(p.aiSummary)}</i>`
      : '';
    return `🌙 <b>Аналітика${generated ? ` станом на ${html(generated)}` : ''}</b>\n\n${lines.join('\n\n')}${omitted}${aiSummary}`
      + details(
        horizon && `Горизонт оцінки — до ${html(horizon)}`,
        'Рівень сформовано з публічних сигналів. Це не статистична ймовірність, не прогноз цілі та не офіційна тривога.',
        'У разі тривоги прямуйте до визначеного укриття.'
      );
  }
  const summary = cleanSummary(p.summary);
  return `⚠️ <b>${html(p.locationName)} — ${html(threatLabel(p.threatType))}</b>`
    + (summary ? `\n\n${html(summary)}` : '')
    + '\n\nЯкщо ви в цьому районі — перейдіть до укриття або до приміщення без вікон '
    + 'і дочекайтеся офіційного сповіщення.'
    + details(
      evidenceStatement(p.evidenceLevel),
      validUntilLine(p.validUntil, now),
      sourceLine(p)
    );
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
