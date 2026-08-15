import type { Bot } from 'grammy';
import { Counter, type Registry } from 'prom-client';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { relatedLocationsCte } from '../repositories/events.js';
import { onAlertPoke } from '../services/alert-poke.js';
import { scopeToSubscription } from '../domain/location-label.js';
import { locationCatalogue } from '../services/location-labels.js';
import { summariseMovement } from '../services/movement-summary.js';
import { deliverableRun } from '../services/event-log-cursor.js';
import {
  MODEL_CHANNEL_ACTION, MODEL_CHANNEL_DISCLAIMER, MODEL_CHANNEL_STANDING,
  cleanSummary, confidenceLabel, evidenceRaisedLine, evidenceStatement, extensionLine,
  geographyChangedLine, humanMoment, levelLabel, modelAnalysisHeading, riskLevelChangedLine,
  threatLabel, threatTypeChangedLine, validUntilLine
} from './humanize.js';
import {
  decideAssessmentNotification, decideThreatNotification, geographyKey, mergePublishedState,
  threatContentHash,
  type AssessmentPublishedState, type ThreatPublishedState, type ThreatSnapshot
} from './notification-policy.js';
import {
  claimDeliveryBatch, deliveryClass, recordProviderBackoff, registerDeliveryGovernorMetrics
} from './delivery-governor.js';

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
  registerDeliveryGovernorMetrics(registry);
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
  /**
   * На що саме підписаний цей чат — усі його підписки, які зачепила ця загроза.
   *
   * Без цього поля перелік місць був однаковий для всіх: він рахувався один раз на загрозу, до
   * циклу по підписниках. Підписаний на Київ читав «Українськ, Бровари, Вишневе та ще 11», де його
   * стосувалися два міста з чотирнадцяти.
   */
  subscribed_location_ids: string[];
}

async function threatCandidates(args: {
  locationIds: string[]; entityId: string; threatType: string; evidenceLevel: string;
}): Promise<ThreatCandidate[]> {
  const result = await pool.query<ThreatCandidate>(
    `${relatedLocationsCte('ANY($1::text[])')}
     SELECT s.chat_id,ns.last_threat_type,ns.last_evidence_level,ns.last_geography_key,
            ns.last_valid_until,ns.content_hash,ns.telegram_message_id,
            -- Групування замість DISTINCT: рядок і далі один на чат, але тепер він несе ще й ті
            -- підписки, через які чат сюди потрапив. notification_state приєднано по chat_id, тож
            -- усі його колонки функційно залежні від нього й у GROUP BY нічого не ламають.
            array_agg(DISTINCT s.location_id) AS subscribed_location_ids
     FROM subscriptions s
     JOIN telegram_users u ON u.chat_id=s.chat_id
     LEFT JOIN notification_state ns
       ON ns.entity_kind='threat' AND ns.entity_key=$2 AND ns.chat_id=s.chat_id
     WHERE s.enabled=true AND u.enabled=true AND s.notify_threats=true
       AND EXISTS (SELECT 1 FROM related_locations r WHERE r.id=s.location_id)
       AND (s.threat_type='*' OR s.threat_type=$3)
       AND CASE $4 WHEN 'official' THEN 3 WHEN 'confirmed' THEN 2 WHEN 'monitoring' THEN 1 ELSE 0 END >=
           CASE s.minimum_evidence_level WHEN 'official' THEN 3 WHEN 'confirmed' THEN 2 WHEN 'monitoring' THEN 1 ELSE 0 END
     GROUP BY s.chat_id,ns.last_threat_type,ns.last_evidence_level,ns.last_geography_key,
              ns.last_valid_until,ns.content_hash,ns.telegram_message_id`,
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

/**
 * Below every subscriber notification, and below the quiet threshold.
 *
 * `deliverBatch` sends anything at priority 3 or above with `disable_notification`, and a model
 * estimate is the last thing that should buzz a channel audience at 03:00 — the reader did not pick
 * a territory and cannot have wanted this more than the warning it is not. 5 sits under the soft
 * threat update (4), which is itself the quietest subscriber-facing row.
 *
 * Priority only orders the non-`protected` half of a batch; the class in `delivery-governor.ts` is
 * what keeps these rows out of the alert half entirely.
 */
const CHANNEL_PUBLICATION_PRIORITY = 5;

/**
 * Queues one post per enabled channel for a model-authored event, at most once per event, ever.
 *
 * ## What the statement is shaped around
 *
 * Everything happens in ONE statement because two would have a gap. The claim in
 * `channel_published_events` (migration 044) is what decides whether a message exists at all, and if
 * it were written first and the outbox insert then failed, the event would be marked published and
 * never queued — a silently lost post, which for a public channel means a gap a reader can see and
 * we cannot explain. Writing the outbox row first would have the opposite failure: a post with no
 * claim behind it, publishable again on the next pass of the fan-out cursor. The data-modifying CTE
 * makes them the same statement, so the primary key on (channel_id, event_id) is a decision about
 * the message rather than a note taken beside it.
 *
 * ## Why the origin guard is repeated in SQL
 *
 * The caller has already checked `origin='model'`, and the `EXISTS` below checks it again against
 * the row itself. This is the same argument `withdrawUnconfirmedAnalyticalEvents` makes in
 * `src/repositories/events.ts`: a guard that is a WHERE clause holds for every future caller,
 * including one that reaches this function from somewhere else with a threat row it read
 * differently. The domain rule it enforces is not a preference — official alerts and deterministic
 * threat events must not reach this channel through this path at all (migration 044 header) — and a
 * rule of that weight should not be one `if` away from being wrong.
 *
 * `evidence_level='unverified'` is part of the same guard rather than an extra caution. A model
 * event keeps `origin='model'` after a human message merges into it (migration 041) while its
 * evidence level rises, and at that point the channel format — which opens by calling itself an
 * unconfirmed model estimate — would be describing the event incorrectly. Such an event is simply
 * not published; it is not a model estimate any more, it is a corroborated report, and a corroborated
 * report reaching a public channel is a separate decision nobody has made.
 */
async function publishModelAnalysisToChannels(args: {
  eventId: string; threat: any; locationLabel: string; source: Record<string, string>;
}): Promise<void> {
  if (!config.PUBLICATION_CHANNEL_ENABLED) return;
  if (args.threat.origin !== 'model' || args.threat.evidence_level !== 'unverified') return;
  await pool.query(
    `WITH claimed AS (
       INSERT INTO channel_published_events(channel_id,event_id,outbox_id)
       SELECT c.id,$1::uuid,gen_random_uuid() FROM publication_channels c
       WHERE c.enabled=true AND c.publishes='model_analysis'
         AND EXISTS (SELECT 1 FROM threat_events e
                     WHERE e.id=$1::uuid AND e.origin='model' AND e.evidence_level='unverified')
       ON CONFLICT (channel_id,event_id) DO NOTHING
       RETURNING channel_id,outbox_id
     )
     INSERT INTO notification_outbox(id,event_id,publication_channel_id,chat_id,notification_type,
       idempotency_key,priority,payload)
     SELECT claimed.outbox_id,$1::uuid,claimed.channel_id,c.chat_id,'channel_publication',
            $1||':channel:'||claimed.channel_id,$3::integer,$2::jsonb
     FROM claimed JOIN publication_channels c ON c.id=claimed.channel_id
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [args.eventId, JSON.stringify({
      locationName: args.locationLabel, threatType: args.threat.threat_type,
      summary: args.threat.summary, evidenceLevel: args.threat.evidence_level,
      origin: args.threat.origin, validUntil: args.threat.valid_until,
      lastObservedAt: args.threat.last_observed_at, ...args.source
    }), CHANNEL_PUBLICATION_PRIORITY]
  );
}

/**
 * Назви місць одним рядком; довгий перелік обрізається, а не перетворюється на стіну імен.
 *
 * «та ще 11» читачі назвали незрозумілим, і небезпідставно: число висіло без одиниці виміру, тож
 * «ще 11» могло означати що завгодно — міст, повідомлень, хвилин. Тепер одиниця названа.
 *
 * Головне скорочення тут робить не ця функція, а `scopeToSubscription` вище: перелік довгий тоді,
 * коли він чужий. Після звуження до напрямку підписки більшість повідомлень мають одну-дві назви, і
 * гілка з обрізанням лишається для того, хто підписався на цілу область під час масованої атаки.
 */
function locationLabel(names: string[]): string {
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length <= 3) return unique.join(', ');
  const rest = unique.length - 3;
  // Форма однини тут недосяжна — гілка працює від чотирьох назв, тобто rest завжди ≥ 1 — але
  // «21 населений пункт» вимагає однини, і саме тому правило написане повністю, а не для двійки.
  const noun = rest % 10 === 1 && rest % 100 !== 11 ? 'населений пункт'
    : (rest % 10 >= 2 && rest % 10 <= 4 && (rest % 100 < 10 || rest % 100 >= 20))
        ? 'населені пункти' : 'населених пунктів';
  return `${unique.slice(0, 3).join(', ')} і ще ${rest} ${noun}`;
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
    // Каталог читається РАЗ на подію, а не на кожного підписника: підписи залежать від усього
    // каталогу, а не від того, хто читає, і фан-аут ходить сюди раз на секунду.
    const catalogue = await locationCatalogue();
    // Переказ рахується РАЗ на подію, а не на підписника: текст той самий для всіх, і виклик моделі
    // на кожного з них був би тією самою відповіддю, помноженою на кількість чатів. Повертає `null`
    // тихо — вимкнена функція, один канал, відхилений абзац і мертва мережа тут нерозрізненні, і
    // жодне з цього не має права затримати попередження.
    const movement = await summariseMovement(entityId);
    const threatLocationIds = threats.rows.map((row) => String(row.location_id));
    const nameById = new Map(threats.rows.map((row) => [String(row.location_id), String(row.name_uk)]));
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
      // Перелік місць — ПЕР ПІДПИСНИКА. Рішення про те, СЛАЛИ чи ні, і далі приймається за всією
      // загрозою (`snapshot` вище): загроза, що виросла на другу область, — це одна новина, і
      // геть звузивши знімок, ми б перестали бачити її зростання. Звужується тільки те, що
      // читач БАЧИТЬ у тексті.
      const scopedIds = scopeToSubscription(threatLocationIds, candidate.subscribed_location_ids ?? [], catalogue.rows);
      const names = locationLabel(scopedIds.map((id) => catalogue.labels.get(id) ?? nameById.get(id) ?? id));
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
            modelSummary: movement?.summary ?? null, modelSources: movement?.sources ?? null,
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
    // Subscribers first, the public channel after, and never the other way round. The people who
    // asked to be warned are the audience this worker exists for; the channel is a publication, and
    // a publication that went out while a warning was still being queued would have the priority of
    // this system backwards. Both are idempotent, so a throw between them costs a retry of the whole
    // event and nothing else.
    await publishModelAnalysisToChannels({
      // Канал — це публікація, а не підписка: у нього немає напрямку, який можна було б звузити,
      // тож він отримує ВСІ місця загрози. Однозначними їх робить той самий каталог.
      eventId: entityId, threat, source: threatSource,
      locationLabel: locationLabel(threatLocationIds.map(
        (id) => catalogue.labels.get(id) ?? nameById.get(id) ?? id))
    });
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

/**
 * Проводить журнал у чергу й каже, чи був серед проведеного початок тривоги.
 *
 * Повертається саме булеве значення, а не кількість: єдиний споживач питає «чи будити відправника
 * негайно», і на це питання «сім» відповідає не краще за «так».
 */
async function fanoutNewEvents(): Promise<boolean> {
  const client = await pool.connect();
  let raisedAlert = false;
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO worker_state(worker_name,cursor_value) VALUES ('notification-fanout',0) ON CONFLICT DO NOTHING`);
    const state = await client.query(`SELECT cursor_value FROM worker_state WHERE worker_name='notification-fanout' FOR UPDATE`);
    let cursor = Number(state.rows[0].cursor_value);
    const events = await client.query(`SELECT * FROM system_event_log WHERE version>$1 ORDER BY version LIMIT 100`, [cursor]);
    await client.query('COMMIT');
    // Лише безперервний відрізок версій. Курсор тут довговічний, тож перестрибнута версія — це не
    // затримка, а непроведене сповіщення назавжди; див. `src/services/event-log-cursor.ts`.
    for (const event of deliverableRun(events.rows, cursor, Date.now())) {
      await enqueueForEvent(event);
      if (event.event_type === 'alert.started') raisedAlert = true;
      cursor = Number(event.version);
      await pool.query(`UPDATE worker_state SET cursor_value=$2,updated_at=now() WHERE worker_name=$1`, ['notification-fanout', cursor]);
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
  return raisedAlert;
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
  // The public channel, and the only message in this function that is not addressed to somebody who
  // asked for it. Three things about its shape are load-bearing rather than decorative:
  //
  //  * the disclaimer is the FIRST line, before the threat class and before the place. A channel post
  //    is read forwarded and screenshotted, and whatever survives that has to carry «це не тривога»;
  //  * the marker is 🤖 and the heading is «Аналітична оцінка · <клас>», never «<місце> — <загроза>».
  //    The alert branches above open with 🔴/⚪ and a bold place name and the subscriber threat
  //    message with ⚠️; a reader at 03:00 sorts these by silhouette, not by reading, so the estimate
  //    must not have the silhouette of an alert. This is the CONTEXT.md ordering — official signals
  //    above analysis — expressed in the one place the reader actually applies it;
  //  * the branch sits BELOW the two alert branches, like the threat delta path does, so no payload
  //    shape can route an official alert into a format that begins by disclaiming itself.
  if (row.notification_type === 'channel_publication') {
    const summary = cleanSummary(p.summary);
    return `🤖 <i>${html(MODEL_CHANNEL_DISCLAIMER)}</i>\n\n`
      + `<b>${html(modelAnalysisHeading(p.threatType))}</b>\n${html(p.locationName)}`
      + (summary ? `\n\n${html(summary)}` : '')
      + `\n\n${MODEL_CHANNEL_ACTION}`
      + details(
        evidenceStatement(p.evidenceLevel),
        validUntilLine(p.validUntil, now),
        MODEL_CHANNEL_STANDING,
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
    // Готове речення з payload, а не число: формулювання попередження належить тому, хто знає, що
    // саме модель зробила (`modelSignalDisclosure` у `src/services/nightly-digest.ts`), і цей
    // форматувальник не має його переписувати. `null` там означає «модельних сигналів не було», і
    // `details` мовчки викидає рядок — порожня згадка про модель знецінює попередження, яке має
    // значення лише тоді, коли внесок справді є.
    //
    // Місце рядка обране: ПІСЛЯ загального застереження про природу індексу і ПЕРЕД вказівкою про
    // укриття. Спершу читач дізнається, чим є цей рівень узагалі, потім — що частину сигналів під
    // ним ніхто не підтверджував, і аж наприкінці читає, що робити. Зворотний порядок поставив би
    // застереження про модель попереду пояснення, до якого воно є уточненням.
    //
    // `typeof === 'string'` тому, що payload приходить із JSONB і несе те, що записав планувальник
    // будь-якої версії: рядок від старішого бінарника, який поля не знав, має зникнути так само
    // тихо, як `null`, а не надрукуватися як `[object Object]`.
    const modelDisclosure = typeof p.modelDisclosure === 'string' && p.modelDisclosure.trim()
      ? html(p.modelDisclosure) : null;
    return `🌙 <b>Аналітика${generated ? ` станом на ${html(generated)}` : ''}</b>\n\n${lines.join('\n\n')}${omitted}${aiSummary}`
      + details(
        horizon && `Горизонт оцінки — до ${html(horizon)}`,
        'Рівень сформовано з публічних сигналів. Це не статистична ймовірність, не прогноз цілі та не офіційна тривога.',
        modelDisclosure,
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
  // Модельний переказ заміщає детермінований опис, коли він є, і НІКОЛИ не з'являється без джерел:
  // `summariseMovement` не повертає абзаца, для якого не впізнав жодного каналу. Позначка 🤖 та сама,
  // що й у каналі, — читач має розрізняти, де його попереджають правила, а де переказує модель.
  const modelSources = Array.isArray(p.modelSources) ? p.modelSources.filter(Boolean) : [];
  const modelSummary = modelSources.length ? cleanSummary(p.modelSummary) : '';
  const summary = modelSummary || cleanSummary(p.summary);
  const attribution = modelSummary
    ? `\n\n🤖 <i>Переказ моделі за повідомленнями: ${html(modelSources.join(', '))}</i>`
    : '';
  return `⚠️ <b>${html(p.locationName)} — ${html(threatLabel(p.threatType))}</b>`
    + (summary ? `\n\n${html(summary)}` : '')
    + attribution
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
  const batch = await claimDeliveryBatch();
  for (let index = 0; index < batch.length; index += 1) {
    const row = batch[index]!;
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
      // The published post, recorded against the claim that authorised it. Nothing edits a channel
      // message today — the claim is written at enqueue time and is what stops a second post — so
      // this is not the read-back of a decision, it is the only durable link between an event in
      // this database and something a reader can be shown.
      if (row.publication_channel_id) {
        await pool.query(
          `UPDATE channel_published_events SET telegram_message_id=$2,published_at=now()
           WHERE outbox_id=$1`, [row.id, messageId]
        );
      }
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
      // 403 means the same thing for both recipient kinds — we are no longer allowed to write there
      // — and both are switched off rather than retried. For a channel that is the bot losing its
      // administrator rights, and leaving the row enabled would turn every later promotion into
      // another failed post nobody reads. Which row is touched follows `publication_channel_id`
      // rather than the chat id, because a channel id is not in `telegram_users` and the old
      // statement would silently have updated nothing.
      if (code === '403' && row.publication_channel_id) {
        await pool.query(
          `UPDATE publication_channels SET enabled=false,updated_at=now() WHERE id=$1`,
          [row.publication_channel_id]
        );
      } else if (code === '403') {
        await pool.query(`UPDATE telegram_users SET enabled=false WHERE chat_id=$1`, [row.chat_id]);
      }
      if (code === '429') {
        // retry_after is aggregate for this bot. Put untouched claims back now instead of waiting
        // for the five-minute crash-reclaim path, persist the pause, and resume by priority later.
        await recordProviderBackoff(
          row.id, deliveryClass(row), retryAfter, batch.slice(index + 1).map((item) => String(item.id))
        );
        break;
      }
    }
  }
}

/**
 * The two workers, plus the one signal that can make the fan-out run early.
 *
 * ## Why the fan-out is poked, and why the delivery worker now is too
 *
 * The fan-out is the step that turns a committed `alert.started` into outbox rows, and it is pure
 * database work with no external service in it — running it a second earlier costs one statement
 * and buys a second off every subscriber's warning.
 *
 * The delivery worker was left on its bare timer, on the argument that poking it would spend the
 * Telegram budget to save «a fraction of the second the API itself takes». Тепер це виміряно, і
 * частка виявилася цілою секундою: на бойових даних за тиждень від рядка в черзі до `sent_at`
 * минало p50 **1.04 с**, p90 1.49 с, максимум 2.46 с. Це не тривалість запиту до Telegram — це
 * очікування наступного тіку, рівномірно розподілене на [0, 1 с]. Сам запит ховається всередині
 * цієї секунди.
 *
 * Тож відправника теж будять — але лише на початок тривоги, і будить його той самий прохід
 * фан-ауту, що поставив рядок у чергу (`fanoutNewEvents` повертає, чи був серед проведеного
 * `alert.started`). Бюджет Telegram при цьому не витрачається зайвим: `claimDeliveryBatch` бере
 * `FOR UPDATE` на рядку governor'а, тож зайвий виклик або бачить порожній кошик токенів, або
 * чекає на той, що вже виконується. Раніше прокидається доставка — не збільшується її дозвіл.
 *
 * Відбій не будить нікого: асиметрія «початок швидко, відбій неспішно» тут та сама, що і в
 * `src/services/alert-poke.ts` та в `ALERT_END_DEBOUNCE_SECONDS`.
 *
 * ## The publication hold does not apply here, and that is not new
 *
 * This worker reads `system_event_log` through its own durable cursor in `worker_state` and has
 * never consulted the publication cutoff — the Telegram exemption of CONTRACT §2.4 and
 * `docs/METHODOLOGY.md` §Publication: «Збір, класифікація, аудит, /ops, метрики та
 * Telegram-сповіщення не затримуються». The poke changes when this worker runs, never what it is
 * allowed to see, so `delayed_15s` behaves exactly as it did — a subscriber was already being told
 * about an alert the public map was still holding, at most one second later than now.
 *
 * ## The overlap guard is new, and is a precondition of the poke
 *
 * `fanoutNewEvents` had no re-entrancy protection: two concurrent passes read the same cursor
 * `FOR UPDATE` inside a transaction that then COMMITs before the enqueue loop runs, so the second
 * pass can select the same window and re-enqueue it — harmless today only because
 * `idempotency_key` absorbs it and because a one-second interval rarely overlaps. Adding a second
 * trigger makes that collision routine, so the guard comes with it, and it re-arms once rather than
 * queueing: a poke that lands mid-pass must not be lost, because the running pass may already have
 * read its window before the poking transaction was visible.
 */
export function startNotificationWorkers(bot: Bot | null, log: { warn: Function; error: Function }) {
  const deliveryRun = () => bot && deliverBatch(bot, log).catch((error) => log.error({ error }, 'notification delivery failed'));
  let fanoutRunning = false;
  let fanoutRearm = false;
  const fanoutRun = async (): Promise<void> => {
    if (fanoutRunning) return;
    fanoutRunning = true;
    try {
      // Прохід, який щойно поставив у чергу початок тривоги, і будить відправника: черга вже
      // наповнена, і чекати на тік немає чого. Помилка доставки лишається в її власному `catch`.
      if (await fanoutNewEvents()) void deliveryRun();
    } catch (error) {
      log.error({ error }, 'notification fanout failed');
    } finally {
      fanoutRunning = false;
      if (fanoutRearm) { fanoutRearm = false; void fanoutRun(); }
    }
  };
  const fanout = setInterval(() => void fanoutRun(), 1_000); fanout.unref(); void fanoutRun();
  const detachPoke = onAlertPoke(() => {
    if (fanoutRunning) { fanoutRearm = true; return; }
    void fanoutRun();
  });
  const delivery = bot ? setInterval(deliveryRun, 1_000) : undefined; delivery?.unref(); if (bot) void deliveryRun();
  return () => { clearInterval(fanout); if (delivery) clearInterval(delivery); detachPoke(); };
}
