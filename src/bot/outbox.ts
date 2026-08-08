import type { Bot } from 'grammy';
import { Counter, type Registry } from 'prom-client';
import { pool } from '../db/pool.js';
import { relatedLocationsCte } from '../repositories/events.js';
import {
  cleanSummary, confidenceLabel, evidenceRaisedLine, evidenceStatement, extensionLine,
  geographyChangedLine, humanMoment, levelLabel, riskLevelChangedLine, threatLabel,
  threatTypeChangedLine, validUntilLine
} from './humanize.js';
import {
  decideAssessmentNotification, decideThreatNotification, geographyKey, mergePublishedState,
  threatContentHash,
  type AssessmentPublishedState, type ThreatPublishedState, type ThreatSnapshot
} from './notification-policy.js';

/**
 * Notifications this worker refused to queue, by the reason it refused.
 *
 * Constructed DETACHED (`registers: []`) like every other metric in this project, and attached by
 * {@link registerOutboxMetrics} — importing the outbox must never mutate a shared registry.
 *
 * A non-zero `expired` series is a real operational signal and `docs/OPERATIONS.md` names it as an
 * incident condition: the fan-out reads `system_event_log` through its own cursor, so a sustained
 * count means the cursor is running more than thirty minutes behind the events being written, and
 * subscribers are learning about threats after they stopped applying.
 */
const notificationsSuppressed = new Counter({
  name: 'threatlens_notifications_suppressed_total',
  help: 'Threat notifications not queued because the threat was no longer valid, by reason',
  labelNames: ['reason'], registers: []
});

/** Attaches this module's metrics to the one HTTP registry. Idempotent, like its neighbours. */
export function registerOutboxMetrics(registry: Registry): void {
  if (!registry.getSingleMetric('threatlens_notifications_suppressed_total')) {
    registry.registerMetric(notificationsSuppressed);
  }
}

function html(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]!);
}

async function insertForAlertSubscribers(args: {
  locationId: string; type: 'alert_start' | 'alert_end'; entityId: string; eventVersion: number;
  priority: number; payload: Record<string, unknown>;
}) {
  // Official alerts keep the set-based fanout that threats and analytics gave up. They carry no
  // per-chat published state, they ignore the evidence and threat-type filters, and every one of
  // them must arrive — there is nothing here to suppress, so there is nothing to loop over.
  //
  // `related_locations` is the whole ancestor and descendant chain of the event location, so an
  // oblast subscriber keeps receiving a city event once a raion sits between the two. `DISTINCT`
  // collapses a chat that holds several matching subscriptions (oblast *and* raion *and* city) into
  // the single outbox row `idempotency_key` would otherwise have to absorb.
  await pool.query(
    `${relatedLocationsCte()}
     INSERT INTO notification_outbox(alert_period_id,chat_id,notification_type,idempotency_key,priority,payload)
     SELECT DISTINCT $3::uuid,s.chat_id,$2::text,$3||':'||s.chat_id||':'||$2||':'||$4,$5::integer,$6::jsonb
     FROM subscriptions s JOIN telegram_users u ON u.chat_id=s.chat_id
     WHERE s.enabled=true AND u.enabled=true
       AND EXISTS (SELECT 1 FROM related_locations r WHERE r.id=s.location_id)
       AND (($2='alert_start' AND s.notify_alert_start=true) OR ($2='alert_end' AND s.notify_alert_end=true))
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [args.locationId, args.type, args.entityId, args.eventVersion, args.priority,
      JSON.stringify(args.payload)]
  );
}

/**
 * Chats that may hear about a threat, each with what it was last told about that same threat.
 *
 * The subscription filters are identical to the ones the alert fanout applies inline; the join to
 * `notification_state` is what turns a set-based insert into a per-chat decision. The anchor is an
 * array because one threat can be attached to several locations at once, and a chat must appear
 * here exactly once regardless of how many of them it subscribes to.
 */
interface ThreatCandidate {
  chat_id: string;
  last_threat_type: string | null;
  last_evidence_level: string | null;
  last_geography_key: string | null;
  last_valid_until: Date | null;
  content_hash: string | null;
  telegram_message_id: string | null;
}

async function threatCandidates(args: {
  locationIds: string[]; entityId: string; threatType: string; evidenceLevel: string;
}): Promise<ThreatCandidate[]> {
  const result = await pool.query<ThreatCandidate>(
    `${relatedLocationsCte('ANY($1::text[])')}
     SELECT DISTINCT s.chat_id,ns.last_threat_type,ns.last_evidence_level,ns.last_geography_key,
            ns.last_valid_until,ns.content_hash,ns.telegram_message_id
     FROM subscriptions s
     JOIN telegram_users u ON u.chat_id=s.chat_id
     LEFT JOIN notification_state ns
       ON ns.entity_kind='threat' AND ns.entity_key=$2 AND ns.chat_id=s.chat_id
     WHERE s.enabled=true AND u.enabled=true AND s.notify_threats=true
       AND EXISTS (SELECT 1 FROM related_locations r WHERE r.id=s.location_id)
       AND (s.threat_type='*' OR s.threat_type=$3)
       AND CASE $4 WHEN 'official' THEN 3 WHEN 'confirmed' THEN 2 WHEN 'monitoring' THEN 1 ELSE 0 END >=
           CASE s.minimum_evidence_level WHEN 'official' THEN 3 WHEN 'confirmed' THEN 2 WHEN 'monitoring' THEN 1 ELSE 0 END`,
    [args.locationIds, args.entityId, args.threatType, args.evidenceLevel]
  );
  return result.rows;
}

/**
 * Records what a chat is being told, at enqueue time rather than at delivery time.
 *
 * The fanout runs once a second; a marker written only after Telegram confirms delivery would let
 * the next pass decide against an empty history and queue the same escalation twice. Writing it here
 * means the failure mode is a missed repeat rather than a duplicate, and the outbox keeps its own
 * at-least-once retries underneath. `telegram_message_id` is deliberately not touched: it belongs to
 * the delivery worker, and a soft update must not lose the message it is about to edit.
 *
 * `expires_at` has a two-hour floor. A source that reports a validity window already in the past —
 * a mis-parsed «до 22:00» read as yesterday — would otherwise write a row the cleanup deletes on its
 * next pass, and the chat's published state would evaporate under it: every following mention of the
 * same threat would look like a first mention and be sent in full. That is precisely the repeat storm
 * this table exists to stop.
 */
async function rememberThreatState(args: {
  entityId: string; chatId: string; locationId: string; snapshot: ThreatSnapshot;
}) {
  await pool.query(
    `INSERT INTO notification_state(entity_kind,entity_key,chat_id,location_id,last_threat_type,
       last_evidence_level,last_geography_key,last_valid_until,content_hash,last_notified_at,expires_at)
     VALUES ('threat',$1,$2,$3,$4,$5,$6,$7::timestamptz,$8,now(),
       GREATEST(COALESCE($7::timestamptz + interval '6 hours', now() + interval '12 hours'),
                now() + interval '2 hours'))
     ON CONFLICT (entity_kind,entity_key,chat_id) DO UPDATE SET
       location_id=EXCLUDED.location_id,last_threat_type=EXCLUDED.last_threat_type,
       last_evidence_level=EXCLUDED.last_evidence_level,last_geography_key=EXCLUDED.last_geography_key,
       last_valid_until=EXCLUDED.last_valid_until,content_hash=EXCLUDED.content_hash,
       last_notified_at=now(),expires_at=EXCLUDED.expires_at,updated_at=now()`,
    [args.entityId, args.chatId, args.locationId, args.snapshot.threatType, args.snapshot.evidenceLevel,
      geographyKey(args.snapshot.locationIds), args.snapshot.validUntil, threatContentHash(args.snapshot)]
  );
}

async function rememberAssessmentState(args: {
  entityKey: string; chatId: string; locationId: string; riskLevel: string; score: number;
}) {
  await pool.query(
    `INSERT INTO notification_state(entity_kind,entity_key,chat_id,location_id,last_risk_level,
       last_score,last_notified_at,expires_at)
     VALUES ('assessment',$1,$2,$3,$4,$5,now(),now() + interval '12 hours')
     ON CONFLICT (entity_kind,entity_key,chat_id) DO UPDATE SET
       location_id=EXCLUDED.location_id,last_risk_level=EXCLUDED.last_risk_level,
       last_score=EXCLUDED.last_score,last_notified_at=now(),expires_at=EXCLUDED.expires_at,updated_at=now()`,
    [args.entityKey, args.chatId, args.locationId, args.riskLevel, args.score]
  );
}

/** Location names as one label; long lists are trimmed rather than turned into a wall of names. */
function locationLabel(names: string[]): string {
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length <= 3) return unique.join(', ');
  return `${unique.slice(0, 3).join(', ')} та ще ${unique.length - 3}`;
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
    await insertForAlertSubscribers({
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
    // `ORDER BY` makes the leading row — and therefore the threat fields read off it — the same on
    // every pass, so a re-run of the identical event cannot produce a different content hash.
    const threats = await pool.query(
      `SELECT e.*,el.location_id,l.name_uk FROM threat_events e
       JOIN threat_event_locations el ON el.event_id=e.id JOIN locations l ON l.id=el.location_id
       WHERE e.id=$1 ORDER BY el.location_id`, [entityId]
    );
    if (!threats.rowCount) return;
    const threat = threats.rows[0];
    // Defence in depth, and the last one on this path. `ingestThreat` already refuses to append a
    // `system_event_log` row for a message outside its own validity window, so nothing a catch-up
    // backfill replays should ever reach here — but this branch is reached from ANY threat event in
    // the log, and a fan-out that has fallen far enough behind would otherwise send a warning whose
    // deadline passed while it sat in the queue. Warning somebody about a threat that is over is not
    // a harmless late message: it is a false alarm, and it teaches the reader to discount the next
    // one. A threat with no declared deadline is not suppressed — there is nothing to have passed.
    if (threat.valid_until && new Date(threat.valid_until).getTime() <= Date.now()) {
      notificationsSuppressed.inc({ reason: 'expired' });
      return;
    }
    const threatSource = await latestEventSource(entityId);
    // One decision per chat about the *whole* threat, not one per location it touches: a threat that
    // grows a second oblast is one piece of news, and the geography rule can only see that growth if
    // every location is on the table at once.
    const snapshot: ThreatSnapshot = {
      threatType: threat.threat_type,
      evidenceLevel: threat.evidence_level,
      locationIds: threats.rows.map((row) => String(row.location_id)),
      validUntil: threat.valid_until ? new Date(threat.valid_until).toISOString() : null
    };
    const names = locationLabel(threats.rows.map((row) => String(row.name_uk)));
    const candidates = await threatCandidates({
      locationIds: snapshot.locationIds, entityId,
      threatType: snapshot.threatType, evidenceLevel: snapshot.evidenceLevel
    });
    for (const candidate of candidates) {
      // A row exists but says nothing about a threat only when the join found no state at all.
      const published: ThreatPublishedState | null = candidate.last_evidence_level === null
        && candidate.last_threat_type === null && candidate.content_hash === null
        ? null
        : {
            threatType: candidate.last_threat_type,
            evidenceLevel: candidate.last_evidence_level,
            geographyKey: candidate.last_geography_key,
            validUntil: candidate.last_valid_until ? new Date(candidate.last_valid_until).toISOString() : null,
            contentHash: candidate.content_hash,
            telegramMessageId: candidate.telegram_message_id ? Number(candidate.telegram_message_id) : null
          };
      const decision = decideThreatNotification(published, snapshot);
      if (decision.action === 'skip') continue;
      // A soft update is a courtesy, not a warning: it rides at the quiet priority even when the
      // threat itself is official, because the only thing it says is "still standing, until later".
      const priority = decision.kind === 'soft' ? 4 : (snapshot.evidenceLevel === 'official' ? 1 : 3);
      const inserted = await pool.query(
        `INSERT INTO notification_outbox(event_id,chat_id,notification_type,idempotency_key,priority,payload)
         VALUES ($1::uuid,$2,'threat_update',$3,$4,$5::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [entityId, candidate.chat_id,
          `${entityId}:${candidate.chat_id}:threat_update:${Number(event.version)}`, priority,
          JSON.stringify({
            locationName: names, threatType: snapshot.threatType, summary: threat.summary,
            evidenceLevel: snapshot.evidenceLevel, lastObservedAt: threat.last_observed_at,
            validUntil: threat.valid_until, ...threatSource,
            updateKind: decision.kind, changes: decision.changes,
            previousThreatType: published?.threatType ?? null,
            previousEvidenceLevel: published?.evidenceLevel ?? null,
            editMessageId: decision.action === 'edit' ? decision.editMessageId : null,
            state: { kind: 'threat', key: entityId }
          })]
      );
      if (!inserted.rowCount) continue;
      // What is recorded is what the chat was *told*, which is not the same as the current snapshot:
      // the fields a delta message stayed silent about keep their published value.
      await rememberThreatState({
        entityId, chatId: candidate.chat_id, locationId: String(threat.location_id),
        snapshot: mergePublishedState(published, snapshot)
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
    // Analytics identity is (location, threat type), not the assessment row: every run inserts a new
    // row, so keying the published state by assessment id would make every single run look new.
    const stateKey = `${assessment.location_id}:${assessment.threat_type}`;
    const score = Number(assessment.risk_score);
    const generatedAt = new Date(assessment.generated_at ?? Date.now()).toISOString();
    const candidates = await pool.query<{
      chat_id: string; last_risk_level: string | null; last_score: string | null; last_notified_at: Date | null;
    }>(
      `${relatedLocationsCte()}
       SELECT DISTINCT s.chat_id,ns.last_risk_level,ns.last_score,ns.last_notified_at
       FROM subscriptions s
       JOIN telegram_users u ON u.chat_id=s.chat_id
       LEFT JOIN notification_state ns
         ON ns.entity_kind='assessment' AND ns.entity_key=$2 AND ns.chat_id=s.chat_id
       WHERE s.enabled=true AND u.enabled=true AND s.notify_analytics=true
         AND EXISTS (SELECT 1 FROM related_locations r WHERE r.id=s.location_id)
         AND (s.threat_type='*' OR s.threat_type=$3)`,
      [assessment.location_id, stateKey, assessment.threat_type]
    );
    for (const candidate of candidates.rows) {
      const published: AssessmentPublishedState | null = candidate.last_risk_level === null ? null : {
        riskLevel: candidate.last_risk_level,
        score: candidate.last_score === null ? null : Number(candidate.last_score),
        notifiedAt: candidate.last_notified_at ? new Date(candidate.last_notified_at).toISOString() : null
      };
      const decision = decideAssessmentNotification(published, {
        riskLevel: assessment.risk_level, score, at: generatedAt
      });
      if (decision.action === 'skip') continue;
      const inserted = await pool.query(
        `INSERT INTO notification_outbox(assessment_id,chat_id,notification_type,idempotency_key,priority,payload)
         VALUES ($1::uuid,$2,'assessment_update',$3,4,$4::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [entityId, candidate.chat_id,
          `${entityId}:${candidate.chat_id}:assessment_update:${Number(event.version)}`,
          JSON.stringify({
            locationName: assessment.name_uk, threatType: assessment.threat_type,
            score: assessment.risk_score, level: assessment.risk_level,
            indicativePercent: assessment.indicative_percent, confidence: assessment.assessment_confidence,
            explanation: assessment.explanation, horizonEnd: assessment.horizon_end,
            ...sourceFields(topSignal),
            updateKind: decision.kind, silent: decision.silent,
            previousLevel: published?.riskLevel ?? null, previousScore: published?.score ?? null,
            state: { kind: 'assessment', key: stateKey }
          })]
      );
      if (!inserted.rowCount) continue;
      await rememberAssessmentState({
        entityKey: stateKey, chatId: candidate.chat_id, locationId: assessment.location_id,
        riskLevel: assessment.risk_level, score
      });
    }
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
    // The previous level is stated only when it actually moved, so a routine drift message does not
    // pretend to be a level change — and a level change is never left to be inferred from a number.
    const movement = p.previousLevel && p.previousLevel !== p.level
      ? `\n${html(riskLevelChangedLine(p.previousLevel, p.level, p.updateKind === 'deescalation' ? 'down' : 'up'))}`
      : '';
    return `📊 <b>Оновлення аналітики — ${html(p.locationName)}</b>\n`
      + `${html(threatLabel(p.threatType))}: <b>${html(levelLabel(p.level))}</b> · ${html(p.score)}/10${movement}\n\n`
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
  // Threat updates. The first message a chat gets about a threat carries the whole picture; every
  // later one says only what moved, because a person who already read the warning does not need it
  // restated — they need to know whether anything about it changed.
  //
  // The check sits *below* the alert branches on purpose. An official tribute of a raid must never
  // be reachable from this path: alerts carry no `updateKind`, are never suppressed and are never
  // edited, and keeping their branches above this one is what guarantees it structurally.
  if (p.updateKind && p.updateKind !== 'initial') return formatThreatDelta(p, now);
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

const deltaHeadings: Record<string, string> = { escalation: '⬆️', change: '🔀', soft: '⏱' };

/**
 * A follow-up message about a threat the chat has already been warned about.
 *
 * It deliberately omits both the source summary and the shelter instruction: the person read them in
 * the first message, and repeating them is what makes an update indistinguishable from a repeat. The
 * link back to the first source stays, because the reader must still be able to check the claim.
 */
function formatThreatDelta(p: any, now: Date): string {
  const changes: string[] = Array.isArray(p.changes) ? p.changes : [];
  const lines: string[] = [];
  if (changes.includes('evidence_raised')) lines.push(evidenceRaisedLine(p.evidenceLevel));
  if (changes.includes('threat_type_changed')) {
    lines.push(threatTypeChangedLine(p.previousThreatType, p.threatType));
  }
  if (changes.includes('geography_changed')) lines.push(geographyChangedLine(String(p.locationName ?? '')));
  if (changes.includes('validity_extended')) {
    const extension = extensionLine(p.validUntil, now);
    if (extension) lines.push(extension);
  }
  // A change list that produced no phrase would leave an empty message; the validity line is the one
  // statement that is always true of a standing threat, so it is the fallback.
  if (!lines.length) lines.push(validUntilLine(p.validUntil, now) ?? 'Загроза лишається актуальною.');
  const heading = deltaHeadings[String(p.updateKind)] ?? '🔁';
  return `${heading} <b>${html(p.locationName)} — оновлення</b>\n${html(threatLabel(p.threatType))}\n\n`
    + lines.map((line) => html(line)).join('\n')
    + details(sourceLine(p));
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
        const payload = row.payload ?? {};
        const text = formatMessage(row);
        const options = {
          parse_mode: 'HTML' as const,
          // A de-escalation is worth recording and not worth a sound at night, so the policy can ask
          // for silence explicitly; everything from priority 3 down was already quiet.
          disable_notification: payload.silent === true || row.priority >= 3,
          link_preview_options: { is_disabled: true }
        };
        const editMessageId = Number(payload.editMessageId ?? 0) || null;
        let messageId: number | null = null;
        if (editMessageId) {
          // Editing keeps one message per threat in the chat: «ще стоїть, до 04:10» replaces the line
          // the person already read instead of stacking another push on top of it. The message may be
          // gone (deleted, or older than Telegram lets us edit), and grammy reports that as an
          // ordinary API error — falling through to a normal send is the correct answer, not a retry,
          // because the subscriber has nothing to look at either way.
          try {
            await bot.api.editMessageText(String(row.chat_id), editMessageId, text, {
              parse_mode: options.parse_mode, link_preview_options: options.link_preview_options
            });
            messageId = editMessageId;
          } catch (error: any) {
            log.warn({ outboxId: row.id, code: String(error?.error?.error_code ?? error?.error_code ?? 'unknown') },
              'notification edit failed, sending a new message');
          }
        }
        if (messageId === null) {
          const sent = await bot.api.sendMessage(String(row.chat_id), text, options);
          messageId = sent.message_id;
        }
        await pool.query(`UPDATE notification_outbox SET status='sent',sent_at=now(),updated_at=now() WHERE id=$1`, [row.id]);
        await pool.query(
          `INSERT INTO notification_deliveries(outbox_id,telegram_message_id,delivered_status,queued_at,sent_at)
           VALUES ($1,$2,'sent',$3,now())`, [row.id, messageId, row.created_at]
        );
        // The message id is what makes the *next* soft update an edit rather than a new push.
        if (payload.state?.key) {
          await pool.query(
            `UPDATE notification_state SET telegram_message_id=$3,delivered_at=now(),updated_at=now()
             WHERE entity_kind=$1 AND entity_key=$2 AND chat_id=$4`,
            [payload.state.kind, payload.state.key, messageId, row.chat_id]
          );
        }
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
