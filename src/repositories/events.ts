import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { ClassifiedMessage, EvidenceLevel, LiveEvent, NormalizedMessage } from '../types.js';

export async function listLocationLexemes() {
  const result = await pool.query<{ id: string; name_uk: string; aliases: string[] }>(
    `SELECT id, name_uk, aliases FROM locations WHERE type <> 'country' ORDER BY length(name_uk) DESC`
  );
  return result.rows.map((row) => ({ id: row.id, name: row.name_uk, aliases: row.aliases ?? [] }));
}

async function appendSystemEvent(client: PoolClient, eventType: string, payload: unknown) {
  const result = await client.query<{ version: string }>(
    `INSERT INTO system_event_log(event_type,payload) VALUES ($1,$2) RETURNING version`,
    [eventType, JSON.stringify(payload)]
  );
  return Number(result.rows[0]?.version ?? 0);
}

const evidenceRank: Record<EvidenceLevel, number> = { unverified: 0, monitoring: 1, confirmed: 2, official: 3 };
function strongestEvidence(left: EvidenceLevel, right: EvidenceLevel): EvidenceLevel {
  return evidenceRank[left] >= evidenceRank[right] ? left : right;
}

export async function ingestThreat(message: NormalizedMessage, classified: ClassifiedMessage): Promise<{ id: string; version: number; created: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hash = createHash('sha256').update(message.text).digest('hex');
    const duplicate = await client.query<{ event_id: string }>(
      `SELECT ee.event_id FROM source_messages sm
       LEFT JOIN event_evidence ee ON ee.source_message_id=sm.id
       WHERE sm.source_id=$1 AND sm.external_id=$2 AND sm.content_hash=$3
       ORDER BY sm.received_at DESC LIMIT 1`,
      [message.sourceId, message.externalId, hash]
    );
    if (duplicate.rowCount && duplicate.rows[0]?.event_id) {
      await client.query('COMMIT');
      return { id: duplicate.rows[0].event_id, version: await systemVersion(), created: false };
    }
    const previousMessage = await client.query<{ id: string; event_id: string | null }>(
      `SELECT sm.id,ee.event_id FROM source_messages sm
       LEFT JOIN event_evidence ee ON ee.source_message_id=sm.id
       WHERE sm.source_id=$1 AND sm.external_id=$2
       ORDER BY received_at DESC LIMIT 1`, [message.sourceId, message.externalId]
    );
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO source_messages(source_id,external_id,published_at,edited_at,raw_text,raw_payload,content_hash,processing_status,supersedes_message_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'classified',$8)
       ON CONFLICT (source_id,external_id,content_hash) DO UPDATE SET received_at=now()
       RETURNING id`,
      [message.sourceId, message.externalId, message.publishedAt, message.editedAt ?? null, message.text, JSON.stringify(message.rawPayload), hash,
        previousMessage.rows[0]?.id ?? null]
    );
    const sourceMessageId = inserted.rows[0]!.id;
    if (previousMessage.rowCount) {
      const revision = await client.query<{ next_revision: number }>(
        `SELECT COALESCE(max(revision_number),0)+1 AS next_revision
         FROM source_message_revisions WHERE source_message_id=$1`, [previousMessage.rows[0]!.id]
      );
      await client.query(
        `INSERT INTO source_message_revisions(source_message_id,revision_number,raw_text,raw_payload)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [previousMessage.rows[0]!.id, revision.rows[0]!.next_revision, message.text, JSON.stringify(message.rawPayload)]
      );
    }
    const source = await client.query<{ tier: string; official: boolean; independence_group: string }>(
      `SELECT tier,official,independence_group FROM sources WHERE id=$1`, [message.sourceId]
    );
    const sourceRow = source.rows[0] ?? { tier: 'C', official: false, independence_group: message.sourceId };
    const evidenceLevel: EvidenceLevel = sourceRow.official ? 'official' : sourceRow.tier === 'B' ? 'monitoring' : 'unverified';
    const eventLocations = classified.nationalScope
      ? [{ id: 'ua', name: 'Україна', relationType: 'mentioned' as const }]
      : classified.locations;
    const signalTargets: Array<{ id: string; relationType: string; relevance: number }> = classified.nationalScope
      ? (await client.query<{ id: string }>(
          `SELECT id FROM locations WHERE type IN ('oblast','special_city') ORDER BY id`
        )).rows.map((row) => ({ id: row.id, relationType: 'national_posture', relevance: 0.28 }))
      : classified.locations.map((location) => ({
          id: location.id,
          relationType: location.relationType,
          relevance: location.relationType === 'explicit_threat' ? 1 : location.relationType === 'reported_direction' ? 0.75 : 0.55
        }));
    if (!classified.nationalScope && classified.locations.length) {
      const parents = await client.query<{ id: string }>(
        `SELECT DISTINCT parent.id FROM locations child JOIN locations parent ON parent.id=child.parent_id
         WHERE child.id=ANY($1::text[]) AND parent.type='oblast'`,
        [classified.locations.map((location) => location.id)]
      );
      for (const parent of parents.rows) {
        if (!signalTargets.some((target) => target.id === parent.id)) {
          signalTargets.push({ id: parent.id, relationType: 'child_location_signal', relevance: 0.65 });
        }
      }
    }
    const locationIds = eventLocations.map((location) => location.id);

    const existing = locationIds.length ? await client.query<{ id: string; evidence_level: EvidenceLevel; status: string }>(
      `SELECT e.id,e.evidence_level,e.status FROM threat_events e
       JOIN threat_event_locations el ON el.event_id=e.id
       WHERE e.threat_type=$1 AND el.location_id=ANY($2::text[])
         AND e.status IN ('observed','confirmed','active')
         AND e.last_observed_at > now() - interval '30 minutes'
       ORDER BY e.last_observed_at DESC LIMIT 1`,
      [classified.threatType, locationIds]
    ) : { rows: [], rowCount: 0 } as never;

    let eventId: string;
    let created = false;
    if (existing.rowCount && existing.rows[0]) {
      eventId = existing.rows[0].id;
      const nextEvidence = strongestEvidence(existing.rows[0].evidence_level, evidenceLevel);
      await client.query(
        `UPDATE threat_events SET summary=$2,last_observed_at=$3,updated_at=now(),
         evidence_level=$4,status=CASE WHEN $4='official' THEN 'active' ELSE status END,
         direction_text=COALESCE($5,direction_text),valid_until=$3::timestamptz + interval '30 minutes'
         WHERE id=$1`,
        [eventId, classified.summary, message.publishedAt, nextEvidence, classified.directionText ?? null]
      );
      if (existing.rows[0].evidence_level !== nextEvidence) {
        await client.query(
          `INSERT INTO event_updates(event_id,previous_status,new_status,previous_evidence_level,new_evidence_level,reason)
           VALUES ($1,$2,$3,$4,$5,'stronger_evidence_received')`,
          [eventId, existing.rows[0].status, nextEvidence === 'official' ? 'active' : existing.rows[0].status,
            existing.rows[0].evidence_level, nextEvidence]
        );
      }
    } else {
      created = true;
      const result = await client.query<{ id: string }>(
        `INSERT INTO threat_events(threat_type,status,evidence_level,title,summary,started_at,last_observed_at,direction_text,valid_until)
         VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$6::timestamptz,$7,$6::timestamptz + interval '30 minutes') RETURNING id`,
        [classified.threatType, evidenceLevel === 'official' ? 'active' : 'observed', evidenceLevel,
          classified.title, classified.summary, message.publishedAt, classified.directionText ?? null]
      );
      eventId = result.rows[0]!.id;
    }

    for (const location of eventLocations) {
      await client.query(
        `INSERT INTO threat_event_locations(event_id,location_id,relation_type) VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`, [eventId, location.id, location.relationType]
      );
    }
    const baseContribution = sourceRow.official ? 2.5 : sourceRow.tier === 'B' ? 1.5 : 0.6;
    for (const target of signalTargets) {
      for (const signalThreatType of classified.signalThreatTypes) {
        await client.query(
          `INSERT INTO risk_signals(signal_type,source_message_id,location_id,threat_type,source_tier,
            independence_group,reliability,freshness,geographic_relevance,contribution,observed_at,expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10::timestamptz,$10::timestamptz + interval '6 hours')`,
          [classified.indicators[0] ?? target.relationType, sourceMessageId, target.id, signalThreatType, sourceRow.tier,
            sourceRow.independence_group, sourceRow.official ? 1 : sourceRow.tier === 'B' ? 0.75 : 0.4,
            target.relevance, baseContribution * target.relevance, message.publishedAt]
        );
      }
    }
    await client.query(
      `INSERT INTO event_evidence(event_id,source_message_id,evidence_role,confidence) VALUES ($1,$2,$3,$4)
       ON CONFLICT DO NOTHING`, [eventId, sourceMessageId, sourceRow.independence_group, evidenceLevel === 'official' ? 1 : 0.55]
    );
    if (evidenceLevel !== 'official') {
      const corroboration = await client.query<{ independent_sources: number }>(
        `SELECT count(DISTINCT s.independence_group)::integer AS independent_sources
         FROM event_evidence ee
         JOIN source_messages sm ON sm.id=ee.source_message_id
         JOIN sources s ON s.id=sm.source_id
         WHERE ee.event_id=$1 AND s.tier IN ('A','B')`,
        [eventId]
      );
      if ((corroboration.rows[0]?.independent_sources ?? 0) >= 2) {
        const promoted = await client.query<{ evidence_level: EvidenceLevel; status: string }>(
          `UPDATE threat_events SET evidence_level='confirmed',status='confirmed',updated_at=now()
           WHERE id=$1 AND evidence_level NOT IN ('official','confirmed')`,
          [eventId]
        );
        if (promoted.rowCount) {
          await client.query(
            `INSERT INTO event_updates(event_id,previous_status,new_status,previous_evidence_level,new_evidence_level,reason)
             VALUES ($1,'observed','confirmed',$2,'confirmed','two_independent_tier_a_or_b_sources')`,
            [eventId, evidenceLevel]
          );
        }
      }
    }
    if (previousMessage.rows[0]?.event_id && previousMessage.rows[0].event_id !== eventId) {
      const previousEvent = await client.query<{ evidence_level: EvidenceLevel; status: string }>(
        `SELECT evidence_level,status FROM threat_events WHERE id=$1 FOR UPDATE`,
        [previousMessage.rows[0].event_id]
      );
      const corrected = await client.query(
        `UPDATE threat_events SET status='corrected',ended_at=now(),updated_at=now()
         WHERE id=$1 AND status IN ('observed','confirmed','active')`,
        [previousMessage.rows[0].event_id]
      );
      if (corrected.rowCount && previousEvent.rows[0]) {
        await client.query(
          `INSERT INTO event_updates(event_id,previous_status,new_status,previous_evidence_level,new_evidence_level,reason)
           VALUES ($1,$2,'corrected',$3,$3,'source_message_edited')`,
          [previousMessage.rows[0].event_id, previousEvent.rows[0].status, previousEvent.rows[0].evidence_level]
        );
        await appendSystemEvent(client, 'threat.corrected', {
          eventId: previousMessage.rows[0].event_id,
          replacementEventId: eventId
        });
      }
    }
    const version = await appendSystemEvent(client, created ? 'threat.created' : 'threat.updated', { eventId });
    await client.query('COMMIT');
    return { id: eventId, version, created };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function liveThreats(): Promise<LiveEvent[]> {
  const result = await pool.query(
    `SELECT e.*,
      COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
        'id',l.id,'name',l.name_uk,'relationType',el.relation_type,
        'latitude',l.latitude,'longitude',l.longitude
      )) FILTER (WHERE l.id IS NOT NULL),'[]') AS locations,
      COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
        'name',s.name,'url',s.public_url,'publishedAt',sm.published_at
      )) FILTER (WHERE s.id IS NOT NULL),'[]') AS sources
     FROM threat_events e
     LEFT JOIN threat_event_locations el ON el.event_id=e.id
     LEFT JOIN locations l ON l.id=el.location_id
     LEFT JOIN event_evidence ee ON ee.event_id=e.id
     LEFT JOIN source_messages sm ON sm.id=ee.source_message_id
     LEFT JOIN sources s ON s.id=sm.source_id
     WHERE e.status IN ('observed','confirmed','active')
       AND e.last_observed_at > now() - interval '12 hours'
     GROUP BY e.id ORDER BY e.last_observed_at DESC`
  );
  return result.rows.map((row) => ({
    id: row.id,
    threatType: row.threat_type,
    status: row.status,
    evidenceLevel: row.evidence_level,
    title: row.title,
    summary: row.summary,
    startedAt: row.started_at.toISOString(),
    lastObservedAt: row.last_observed_at.toISOString(),
    validUntil: row.valid_until?.toISOString() ?? null,
    directionText: row.direction_text,
    geometry: row.geometry,
    geometrySemantics: row.geometry_semantics,
    locations: row.locations,
    sources: row.sources
  }));
}

export async function threatDetails(id: string) {
  const event = await pool.query(
    `SELECT e.*,
      COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
        'id',l.id,'name',l.name_uk,'relationType',el.relation_type,
        'latitude',l.latitude,'longitude',l.longitude
      )) FILTER (WHERE l.id IS NOT NULL),'[]') AS locations
     FROM threat_events e
     LEFT JOIN threat_event_locations el ON el.event_id=e.id
     LEFT JOIN locations l ON l.id=el.location_id
     WHERE e.id=$1 GROUP BY e.id`, [id]
  );
  if (!event.rowCount) return null;
  const [evidence, updates] = await Promise.all([
    pool.query(
      `SELECT s.id AS source_id,s.name,s.tier,s.official,s.public_url,sm.external_id,
              sm.published_at,sm.edited_at,sm.raw_text,ee.confidence,ee.evidence_role
       FROM event_evidence ee JOIN source_messages sm ON sm.id=ee.source_message_id
       JOIN sources s ON s.id=sm.source_id WHERE ee.event_id=$1 ORDER BY sm.published_at`, [id]
    ),
    pool.query(
      `SELECT previous_status,new_status,previous_evidence_level,new_evidence_level,reason,created_at
       FROM event_updates WHERE event_id=$1 ORDER BY created_at`, [id]
    )
  ]);
  return { ...event.rows[0], evidence: evidence.rows, updates: updates.rows };
}

export async function assessmentDetails(id: string) {
  const assessment = await pool.query(
    `SELECT a.*,l.name_uk AS location_name,l.latitude,l.longitude
     FROM risk_assessments a JOIN locations l ON l.id=a.location_id WHERE a.id=$1`, [id]
  );
  if (!assessment.rowCount) return null;
  const signals = await pool.query(
    `SELECT rs.id,rs.signal_type,rs.threat_type,rs.source_tier,rs.reliability,
            rs.geographic_relevance,rs.observed_at,rs.expires_at,ras.contribution,ras.explanation,
            s.name AS source_name,s.public_url
     FROM risk_assessment_signals ras JOIN risk_signals rs ON rs.id=ras.signal_id
     LEFT JOIN source_messages sm ON sm.id=rs.source_message_id
     LEFT JOIN sources s ON s.id=sm.source_id
     WHERE ras.assessment_id=$1 ORDER BY ras.contribution DESC`, [id]
  );
  return { ...assessment.rows[0], signals: signals.rows };
}

export async function activeAlerts() {
  const result = await pool.query(
    `SELECT a.id,a.location_id,l.name_uk AS location_name,l.latitude,l.longitude,
            a.alert_type,a.status,a.started_at,a.updated_at
     FROM alert_periods a JOIN locations l ON l.id=a.location_id
     WHERE a.status='active' ORDER BY a.started_at DESC`
  );
  return result.rows;
}

export async function currentAssessments() {
  const result = await pool.query(
    `SELECT a.*,l.name_uk AS location_name,l.latitude,l.longitude
     FROM risk_assessments a JOIN locations l ON l.id=a.location_id
     WHERE a.published=true AND a.expires_at > now() AND a.superseded_by IS NULL
     ORDER BY a.risk_score DESC`
  );
  return result.rows;
}

export async function locationTimeline(locationId: string, limit = 100) {
  const location = (await pool.query(
    `SELECT id,parent_id,type,name_uk,latitude,longitude FROM locations WHERE id=$1`, [locationId]
  )).rows[0];
  if (!location) return null;
  const applies = `(target.id=$1 OR target.parent_id=$1 OR
    target.id=(SELECT parent_id FROM locations WHERE id=$1))`;
  const [threats, alerts, assessments, threatCount, alertCount, assessmentCount] = await Promise.all([
    pool.query(
      `SELECT DISTINCT e.id,'threat' AS kind,e.started_at AS happened_at,e.title,e.summary,e.status,
              e.threat_type,e.evidence_level,e.valid_until,NULL::numeric AS risk_score,NULL::text AS risk_level
       FROM threat_events e JOIN threat_event_locations el ON el.event_id=e.id
       JOIN locations target ON target.id=el.location_id WHERE ${applies}
       ORDER BY e.started_at DESC LIMIT $2`, [locationId, limit]
    ),
    pool.query(
      `SELECT a.id,'alert' AS kind,a.started_at AS happened_at,
              CASE WHEN a.status='active' THEN 'Офіційна тривога' ELSE 'Офіційна тривога завершена' END AS title,
              CASE WHEN a.status='active' THEN 'Офіційне попередження активне.' ELSE 'Зафіксовано офіційний відбій.' END AS summary,
              a.status,a.alert_type AS threat_type,'official' AS evidence_level,a.ended_at AS valid_until,
              NULL::numeric AS risk_score,NULL::text AS risk_level
       FROM alert_periods a JOIN locations target ON target.id=a.location_id WHERE ${applies}
       ORDER BY a.started_at DESC LIMIT $2`, [locationId, limit]
    ),
    pool.query(
      `SELECT a.id,'assessment' AS kind,a.generated_at AS happened_at,'Аналітичне попередження' AS title,
              COALESCE(a.explanation->>'summary','Індекс публічних сигналів.') AS summary,
              CASE WHEN a.superseded_by IS NULL AND a.expires_at>now() THEN 'active' ELSE 'expired' END AS status,
              a.threat_type,NULL::text AS evidence_level,a.horizon_end AS valid_until,a.risk_score,a.risk_level
       FROM risk_assessments a JOIN locations target ON target.id=a.location_id WHERE a.published=true AND ${applies}
       ORDER BY a.generated_at DESC LIMIT $2`, [locationId, limit]
    ),
    pool.query(`SELECT count(DISTINCT e.id)::integer AS count FROM threat_events e
      JOIN threat_event_locations el ON el.event_id=e.id JOIN locations target ON target.id=el.location_id WHERE ${applies}`, [locationId]),
    pool.query(`SELECT count(*)::integer AS count FROM alert_periods a
      JOIN locations target ON target.id=a.location_id WHERE ${applies}`, [locationId]),
    pool.query(`SELECT count(*)::integer AS count FROM risk_assessments a
      JOIN locations target ON target.id=a.location_id WHERE a.published=true AND ${applies}`, [locationId])
  ]);
  const items = [...threats.rows, ...alerts.rows, ...assessments.rows]
    .sort((left, right) => new Date(right.happened_at).getTime() - new Date(left.happened_at).getTime())
    .slice(0, limit);
  return {
    location,
    counts: {
      threats: Number(threatCount.rows[0]?.count ?? 0),
      alerts: Number(alertCount.rows[0]?.count ?? 0),
      assessments: Number(assessmentCount.rows[0]?.count ?? 0)
    },
    items
  };
}

export async function systemVersion(): Promise<number> {
  const result = await pool.query<{ version: string }>('SELECT COALESCE(max(version),0) version FROM system_event_log');
  return Number(result.rows[0]?.version ?? 0);
}
