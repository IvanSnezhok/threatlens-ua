import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { CLASSIFIER_VERSION } from '../domain/classifier.js';
import type { TerritoryNode } from '../domain/territory-state.js';
import { pool } from '../db/pool.js';
import type { ClassifiedMessage, EvidenceLevel, LiveEvent, NormalizedMessage } from '../types.js';

/**
 * ================================================================================================
 * The publication cutoff, and what it means for every read below
 * ================================================================================================
 *
 * Every public read function in this file takes `cutoff: Date` as its **second** parameter, before
 * any optional one — `locationTimeline` already had an optional `limit`, and a required parameter
 * after an optional one is TS1016 and does not compile. Taking it as a parameter rather than reading
 * it here is what keeps one slice per request: `src/api/server.ts` computes it once and threads it
 * through, so the rows, the `version` and the `generatedAt` a reader is served all describe the same
 * instant.
 *
 * **Status is reported AS OF THE CUTOFF.** In `delayed_15s` two of these queries deliberately return
 * rows whose *current* status is terminal, because they were live at the cutoff, and
 * `alert_periods.status` / `threat_events.status` are the status as of **now**. Returning them raw
 * would put «відкликано» / «втратила чинність» next to an orange «активна загроза» polygon, and
 * revealing a terminal state before the SSE frame that carries it is an early all-clear — the one
 * direction `docs/ARCHITECTURE.md` §Consistency rules calls unrecoverable. Both functions therefore
 * project the status and keep the raw value in a second column no public presentation surface reads.
 *
 * In `live` mode the cutoff is Postgres `now()`, every second branch is empty, every CASE is a
 * no-op, and each statement degenerates to the one that was here before.
 */

// ------------------------------------------------------------------------------------------------
// Location hierarchy
// ------------------------------------------------------------------------------------------------

/**
 * Hard ceiling on the number of `parent_id` edges any hierarchy walk follows.
 *
 * The catalogue is three tiers deep (`oblast` -> `raion` -> `city`) and the schema also permits
 * `country` and `hromada`, so the longest legal chain is four edges. Eight leaves room for a tier
 * to be inserted without a code change while still bounding the work a malformed import can cause.
 */
export const LOCATION_HIERARCHY_MAX_DEPTH = 8;

/**
 * `WITH RECURSIVE` prefix that defines `related_locations(id)`.
 *
 * The set is every location reachable from `anchor` by following `parent_id` upwards **or**
 * downwards to any depth, plus the anchor itself. That is what "the same place" means for a
 * subscriber: somebody watching an oblast wants the events of every raion and every city inside it,
 * and somebody watching a city wants the oblast-wide alerts that cover them. Matching a single
 * `parent_id` edge, which is what this replaced, silently drops both directions the moment a raion
 * tier sits between oblast and city.
 *
 * Cycle protection is deliberate rather than incidental. `parent_id` comes from KATOTTG, i.e. from
 * outside the process, so it is not trusted to be acyclic. Two independent stops are applied:
 * each branch carries the ids it has already visited and refuses to re-enter one, which cuts a
 * cycle exactly where it closes, and `depth` caps the walk unconditionally at
 * {@link LOCATION_HIERARCHY_MAX_DEPTH}. Either alone terminates; together they also keep a cyclic
 * catalogue from re-expanding a subtree.
 *
 * `anchor` is a placeholder expression (a parameter reference such as `$1`), never interpolated
 * user data — every call site keeps passing the location id as a bind parameter.
 */
export function relatedLocationsCte(anchor = '$1'): string {
  return `WITH RECURSIVE location_ancestors(id,parent_id,depth,path) AS (
      SELECT anchor.id,anchor.parent_id,0,ARRAY[anchor.id] FROM locations anchor WHERE anchor.id=${anchor}
    UNION ALL
      SELECT parent.id,parent.parent_id,child.depth+1,child.path||parent.id
      FROM location_ancestors child JOIN locations parent ON parent.id=child.parent_id
      WHERE child.depth<${LOCATION_HIERARCHY_MAX_DEPTH} AND NOT (parent.id=ANY(child.path))
  ), location_descendants(id,depth,path) AS (
      SELECT anchor.id,0,ARRAY[anchor.id] FROM locations anchor WHERE anchor.id=${anchor}
    UNION ALL
      SELECT child.id,parent.depth+1,parent.path||child.id
      FROM location_descendants parent JOIN locations child ON child.parent_id=parent.id
      WHERE parent.depth<${LOCATION_HIERARCHY_MAX_DEPTH} AND NOT (child.id=ANY(parent.path))
  ), related_locations(id) AS (
      SELECT id FROM location_ancestors UNION SELECT id FROM location_descendants
  )`;
}

/**
 * Materialises {@link relatedLocationsCte} for callers that fan one location out over several
 * statements, so the walk is paid for once instead of once per statement.
 */
export async function relatedLocationIds(locationId: string): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `${relatedLocationsCte()} SELECT id FROM related_locations`, [locationId]
  );
  return result.rows.map((row) => row.id);
}

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

// ------------------------------------------------------------------------------------------------
// Assertions: who still says a threat is happening
// ------------------------------------------------------------------------------------------------

/** Statuses in which a threat event is live and can still be withdrawn. */
const LIVE_STATUSES = ['observed', 'confirmed', 'active'];

/**
 * Records or refreshes one source's claim over one place and one threat class.
 *
 * The upsert clears `withdrawn_at`, which is the re-assertion case: a source that said the threat
 * was over and is now reporting it again is asserting, not contradicting itself, and its row has to
 * count towards keeping the event alive. `GREATEST` on the timestamps keeps an out-of-order replay
 * from shortening a window that a newer message already extended.
 */
async function assertThreat(
  client: PoolClient,
  values: {
    eventId: string; sourceId: string; independenceGroup: string; locationId: string;
    threatType: string; observedAt: Date; sourceMessageId: string;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO threat_assertions(event_id,source_id,independence_group,location_id,threat_type,
       asserted_at,asserted_message_id,valid_until)
     VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7,$6::timestamptz + interval '30 minutes')
     ON CONFLICT (event_id,source_id,location_id,threat_type) DO UPDATE SET
       asserted_at=GREATEST(threat_assertions.asserted_at,EXCLUDED.asserted_at),
       asserted_message_id=EXCLUDED.asserted_message_id,
       valid_until=GREATEST(threat_assertions.valid_until,EXCLUDED.valid_until),
       withdrawn_at=NULL,withdrawn_message_id=NULL,withdrawal_reason=NULL,
       updated_at=now()`,
    [values.eventId, values.sourceId, values.independenceGroup, values.locationId,
      values.threatType, values.observedAt, values.sourceMessageId]
  );
}

/**
 * What a message takes back, resolved into the columns the withdrawal statement matches on.
 *
 * `null` means "every value this source has", which is how `coverage: 'unspecified'` — "у наш бік
 * нічого не летить", with no place named — is expressed. It is safe *only* because `sourceId` is
 * never null: an unscoped withdrawal is unscoped within one publisher's own claims and reaches
 * nobody else's. No attempt is made to guess a scope from the text; the classifier deliberately
 * refuses to, and inventing one here would be the same mistake one layer down.
 */
export interface RetractionScope {
  sourceId: string;
  locationIds: string[] | null;
  threatTypes: string[] | null;
  at: Date;
  sourceMessageId: string | null;
  reason: string;
}

export interface WithdrawalOutcome {
  /** Assertions taken back. Zero is the normal, correct result for a source that never asserted. */
  withdrawnAssertions: number;
  /** Events touched by the withdrawal, whether or not they ended. */
  touchedEventIds: string[];
  /** Events that lost their last holding assertion and moved to `withdrawn`. */
  endedEventIds: string[];
  /** The newest claim this source held immediately before the withdrawal. */
  lastAssertionAt: Date | null;
  decayedSignals: number;
}

const NO_WITHDRAWAL: WithdrawalOutcome = {
  withdrawnAssertions: 0, touchedEventIds: [], endedEventIds: [], lastAssertionAt: null, decayedSignals: 0
};

/**
 * Applies one source's withdrawal, and nothing else.
 *
 * Three statements, in this order and inside the caller's transaction:
 *
 *  1. **Close this source's matching assertions.** `source_id=$1` is the whole safety rule and it is
 *     enforced here, once, in SQL. A withdrawal from channel A cannot reach a row owned by channel
 *     B, so a mis-parsed joke or a channel testing its keyboard can never clear a threat two other
 *     monitors are still reporting — and a source that never asserted matches no rows and therefore
 *     changes nothing at all, without needing a special case.
 *  2. **Decay this source's risk signals** for the same places and classes, by pulling `expires_at`
 *     back to now. Not a negative contribution: a negative term could drive a location's index to
 *     zero while a real threat from other sources is still running, whereas expiry says only "the
 *     basis for *this* signal is gone" and leaves the time decay in `src/services/risk.ts` to handle
 *     the rest. Scoped on `source_messages.source_id` rather than `independence_group`, because a
 *     repost aggregator shares its group with the channel it copies.
 *  3. **Re-derive each touched event.** The event lives while any assertion still holds, exactly as
 *     an official alert lives while `bool_or(holds)` over `alert_source_states`. When something
 *     still holds, `valid_until` is recomputed as the maximum the survivors support, so it can never
 *     be pulled below what another source is still vouching for. When nothing holds, the event moves
 *     to `withdrawn` with its evidence level untouched — state and evidence are different axes, and
 *     a threat that two independent monitors confirmed remains a threat that two monitors confirmed
 *     even after both stood it down.
 *
 * `alert_source_states` and `alert_periods` are not read or written here, and no call path leads
 * from this function to `reconcileAggregateAlert`. An official all-clear is a different domain with
 * a different mandate.
 */
export async function applyRetraction(client: PoolClient, scope: RetractionScope): Promise<WithdrawalOutcome> {
  const withdrawn = await client.query<{ event_id: string; asserted_at: Date }>(
    `UPDATE threat_assertions
        SET withdrawn_at=$2::timestamptz,withdrawn_message_id=$3,withdrawal_reason=$4,updated_at=now()
      WHERE source_id=$1
        AND withdrawn_at IS NULL
        AND ($5::text[] IS NULL OR location_id = ANY($5::text[]))
        AND ($6::text[] IS NULL OR threat_type = ANY($6::text[]))
      RETURNING event_id,asserted_at`,
    [scope.sourceId, scope.at, scope.sourceMessageId, scope.reason, scope.locationIds, scope.threatTypes]
  );

  const decayed = await client.query(
    `UPDATE risk_signals rs SET expires_at=$2::timestamptz
       FROM source_messages sm
      WHERE sm.id=rs.source_message_id
        AND sm.source_id=$1
        AND rs.expires_at > $2::timestamptz
        AND ($3::text[] IS NULL OR rs.location_id = ANY($3::text[]))
        AND ($4::text[] IS NULL OR rs.threat_type = ANY($4::text[]))`,
    [scope.sourceId, scope.at, scope.locationIds, scope.threatTypes]
  );

  const touchedEventIds = [...new Set(withdrawn.rows.map((row) => row.event_id))];
  const lastAssertionAt = withdrawn.rows
    .map((row) => new Date(row.asserted_at))
    .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
  const endedEventIds: string[] = [];

  for (const eventId of touchedEventIds) {
    const support = await client.query<{ held: boolean | null; supported_until: Date | null }>(
      `SELECT bool_or(withdrawn_at IS NULL AND valid_until > now()) AS held,
              max(valid_until) FILTER (WHERE withdrawn_at IS NULL AND valid_until > now()) AS supported_until
         FROM threat_assertions WHERE event_id=$1`,
      [eventId]
    );
    if (support.rows[0]?.held) {
      // Only ever shortened towards what the survivors support, never extended: extending here would
      // let a withdrawal keep an event alive longer than any message ever claimed.
      await client.query(
        `UPDATE threat_events SET valid_until=$2::timestamptz,updated_at=now()
          WHERE id=$1 AND status = ANY($3::text[]) AND valid_until > $2::timestamptz`,
        [eventId, support.rows[0].supported_until, LIVE_STATUSES]
      );
      continue;
    }
    const current = await client.query<{ status: string; evidence_level: EvidenceLevel }>(
      `SELECT status,evidence_level FROM threat_events WHERE id=$1 FOR UPDATE`, [eventId]
    );
    const row = current.rows[0];
    if (!row || !LIVE_STATUSES.includes(row.status)) continue;
    await client.query(
      `UPDATE threat_events SET status='withdrawn',ended_at=now(),updated_at=now() WHERE id=$1`, [eventId]
    );
    await client.query(
      `INSERT INTO event_updates(event_id,previous_status,new_status,previous_evidence_level,
         new_evidence_level,reason)
       VALUES ($1,$2,'withdrawn',$3,$3,'last_source_assertion_withdrawn')`,
      [eventId, row.status, row.evidence_level]
    );
    // Same shape as `threat.created` / `threat.expired`, so the SSE relay and every log consumer see
    // a withdrawal the way they see any other lifecycle transition.
    await appendSystemEvent(client, 'threat.withdrawn', {
      eventId, sourceId: scope.sourceId, reason: scope.reason
    });
    endedEventIds.push(eventId);
  }

  return {
    withdrawnAssertions: withdrawn.rowCount ?? 0,
    touchedEventIds,
    endedEventIds,
    lastAssertionAt,
    decayedSignals: decayed.rowCount ?? 0
  };
}

/**
 * Inserts the raw message and returns its id, without disturbing an existing row.
 *
 * The conflict branch is a deliberate no-op update: `ON CONFLICT DO NOTHING` returns nothing, and
 * every caller here needs the id to attach a classification record to. Re-stamping
 * `processing_status` instead would let a replay of an already-classified message overwrite its
 * status with the status of the replay.
 */
async function insertSourceMessage(
  client: PoolClient, message: NormalizedMessage, status: string
): Promise<string> {
  const hash = createHash('sha256').update(message.text).digest('hex');
  const result = await client.query<{ id: string }>(
    `INSERT INTO source_messages(source_id,external_id,published_at,edited_at,raw_text,raw_payload,
       content_hash,processing_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (source_id,external_id,content_hash)
       DO UPDATE SET received_at=source_messages.received_at
     RETURNING id`,
    [message.sourceId, message.externalId, message.publishedAt, message.editedAt ?? null,
      message.text, JSON.stringify(message.rawPayload), hash, status]
  );
  return result.rows[0]!.id;
}

export interface DeEscalationResult {
  sourceMessageId: string;
  withdrawal: WithdrawalOutcome;
}

/**
 * A source stating that what it reported is over.
 *
 * The message is stored under its own `processing_status` exactly as before; what is new is that it
 * now moves state. `coverage: 'located'` withdraws this source's claims over the places it names;
 * `coverage: 'unspecified'` — "ТУшки неактивні, у наш бік наразі нічого не летить" — withdraws every
 * open claim this source holds and none belonging to anyone else. An empty `threatTypes` means the
 * message named no weapon class and therefore retracts all of them, within that same source scope.
 *
 * Locations are matched exactly, not through the hierarchy: an all-clear for an oblast leaves this
 * source's claim over a city inside it standing, and the 30-minute validity timer retires it. That
 * is the conservative direction — over-narrow withdrawal costs a few minutes of a stale event,
 * over-broad withdrawal takes a live warning off the map.
 */
export async function applyDeEscalation(
  message: NormalizedMessage, classified: ClassifiedMessage
): Promise<DeEscalationResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sourceMessageId = await insertSourceMessage(client, message, 'de_escalation');
    const retraction = classified.retraction;
    const withdrawal = retraction
      ? await applyRetraction(client, {
          sourceId: message.sourceId,
          locationIds: retraction.coverage === 'unspecified'
            ? null
            : retraction.locations.map((location) => location.id),
          threatTypes: retraction.threatTypes.length ? [...retraction.threatTypes] : null,
          at: message.publishedAt,
          sourceMessageId,
          reason: 'de_escalation'
        })
      : NO_WITHDRAWAL;
    await client.query('COMMIT');
    return { sourceMessageId, withdrawal };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------------------------------------------
// Classification archive
// ------------------------------------------------------------------------------------------------

export type ClassificationDecision =
  'event_created' | 'event_merged' | 'redirect' | 'de_escalation' | 'ignored' | 'unrecognized' | 'coalesced';

export interface ClassificationLogEntry {
  sourceId: string;
  sourceMessageId: string;
  publishedAt: Date;
  classified: ClassifiedMessage;
  decision: ClassificationDecision;
  ignoredReason?: string | null;
  eventId?: string | null;
  createdEvent?: boolean;
  withdrawal?: WithdrawalOutcome | null;
}

/**
 * Archives one classifier decision.
 *
 * Written for every message the classifier sees, including the ones it discards — the questions this
 * archive exists to answer ("how is the strike pattern changing", "where do threats get lost")
 * live mostly in the discarded majority, and "why was this ignored?" has no other source of truth.
 *
 * Called outside the ingestion transaction on purpose. A failure to record analytics must never roll
 * back a threat event or a withdrawal; callers treat an error here as a metric, not as an outage.
 * The cost is that a crash between the two writes loses one archive row, which is the right trade.
 */
export async function recordClassification(entry: ClassificationLogEntry): Promise<void> {
  const { classified, withdrawal } = entry;
  const retraction = classified.retraction;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO message_classifications(source_message_id,source_id,classifier_version,published_at,
         decision,intent,created_event,ignored_reason,threat_type,candidate_threat_types,indicators,
         national_scope,direction_text,event_id,retraction_coverage,retracted_threat_types,
         withdrawn_assertions,withdrawn_event_ids,last_assertion_at,decayed_risk_signals)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::uuid[],$19,$20)
       ON CONFLICT (source_message_id,classifier_version) DO NOTHING
       RETURNING id`,
      [
        entry.sourceMessageId, entry.sourceId, CLASSIFIER_VERSION, entry.publishedAt,
        entry.decision, classified.intent, entry.createdEvent ?? false, entry.ignoredReason ?? null,
        classified.threatType, classified.signalThreatTypes, classified.indicators,
        classified.nationalScope, classified.directionText ?? null, entry.eventId ?? null,
        retraction?.coverage ?? null, retraction ? retraction.threatTypes : null,
        withdrawal?.withdrawnAssertions ?? null, withdrawal?.touchedEventIds ?? null,
        withdrawal?.lastAssertionAt ?? null, withdrawal?.decayedSignals ?? null
      ]
    );
    const classificationId = inserted.rows[0]?.id;
    if (classificationId) {
      for (const location of classified.locations) {
        await client.query(
          `INSERT INTO message_classification_locations(classification_id,location_id,role,relation_type)
           VALUES ($1,$2,'asserted',$3) ON CONFLICT DO NOTHING`,
          [classificationId, location.id, location.relationType]
        );
      }
      for (const location of retraction?.locations ?? []) {
        await client.query(
          `INSERT INTO message_classification_locations(classification_id,location_id,role,relation_type)
           VALUES ($1,$2,'retracted',NULL) ON CONFLICT DO NOTHING`,
          [classificationId, location.id]
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface IngestThreatResult {
  id: string;
  version: number;
  created: boolean;
  sourceMessageId: string;
  /** Present for `redirect`: what the same message took back for the place it says was passed. */
  withdrawal: WithdrawalOutcome;
}

export async function ingestThreat(
  message: NormalizedMessage, classified: ClassifiedMessage
): Promise<IngestThreatResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hash = createHash('sha256').update(message.text).digest('hex');
    const duplicate = await client.query<{ id: string; event_id: string }>(
      `SELECT sm.id,ee.event_id FROM source_messages sm
       LEFT JOIN event_evidence ee ON ee.source_message_id=sm.id
       WHERE sm.source_id=$1 AND sm.external_id=$2 AND sm.content_hash=$3
       ORDER BY sm.received_at DESC LIMIT 1`,
      [message.sourceId, message.externalId, hash]
    );
    if (duplicate.rowCount && duplicate.rows[0]?.event_id) {
      await client.query('COMMIT');
      return {
        id: duplicate.rows[0].event_id, version: await systemVersion(), created: false,
        sourceMessageId: duplicate.rows[0].id, withdrawal: NO_WITHDRAWAL
      };
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
      // The oblast that carries the risk signal for a city is no longer its direct parent once a
      // raion tier sits in between, so the ancestor chain is walked rather than one edge. Same
      // cycle guards as `relatedLocationsCte`; `depth>0` keeps a location from being treated as its
      // own parent when it already is an oblast.
      const parents = await client.query<{ id: string }>(
        `WITH RECURSIVE ancestors(id,parent_id,type,depth,path) AS (
            SELECT child.id,child.parent_id,child.type,0,ARRAY[child.id]
            FROM locations child WHERE child.id=ANY($1::text[])
          UNION ALL
            SELECT parent.id,parent.parent_id,parent.type,child.depth+1,child.path||parent.id
            FROM ancestors child JOIN locations parent ON parent.id=child.parent_id
            WHERE child.depth<${LOCATION_HIERARCHY_MAX_DEPTH} AND NOT (parent.id=ANY(child.path))
         )
         SELECT DISTINCT id FROM ancestors WHERE depth>0 AND type='oblast'`,
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
      // The source's own claim over this place, one row per constituent threat class. The event now
      // lives while at least one such row holds, instead of purely on the 30-minute timer, and the
      // same row is what a later withdrawal from this source — and only from this source — matches.
      for (const signalThreatType of classified.signalThreatTypes) {
        await assertThreat(client, {
          eventId, sourceId: message.sourceId, independenceGroup: sourceRow.independence_group,
          locationId: location.id, threatType: signalThreatType,
          observedAt: message.publishedAt, sourceMessageId
        });
      }
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
    // Transit: "Балістика повз Бровари на Бориспіль". The same message asserts for the place being
    // approached and withdraws for the place being passed, which is the whole content of the class.
    // Both halves run in one transaction so the two statements can never be observed apart.
    //
    // Locations the message reports as a *direction* are excluded from the withdrawal. The classifier
    // reads both spans out of one sentence, so a name that appears on both sides would otherwise be
    // asserted and retracted by the same message — and withdrawal is the dangerous direction to
    // resolve that tie in.
    let withdrawal = NO_WITHDRAWAL;
    if (classified.retraction && classified.intent === 'redirect') {
      const approaching = new Set(classified.locations
        .filter((location) => location.relationType === 'reported_direction')
        .map((location) => location.id));
      const passedBy = classified.retraction.locations
        .map((location) => location.id)
        .filter((id) => !approaching.has(id));
      if (passedBy.length) {
        withdrawal = await applyRetraction(client, {
          sourceId: message.sourceId,
          locationIds: passedBy,
          // Never null on this path: a redirect is a statement about one threat moving on, and an
          // unscoped withdrawal is reserved for a message that actually says nothing is flying.
          threatTypes: classified.retraction.threatTypes.length
            ? [...classified.retraction.threatTypes]
            : [classified.threatType],
          at: message.publishedAt,
          sourceMessageId,
          reason: 'redirect'
        });
      }
    }
    const version = await appendSystemEvent(client, created ? 'threat.created' : 'threat.updated', { eventId });
    await client.query('COMMIT');
    return { id: eventId, version, created, sourceMessageId, withdrawal };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function liveThreats(cutoff: Date): Promise<LiveEvent[]> {
  const result = await pool.query(
    // `e.*` still expands first and the projected `status` is selected AFTER it: node-pg builds a
    // row by assigning field by field in order (`Result.parseRow`), so the later column of a
    // duplicate name is the one the mapper below reads. `actual_status` carries the raw value for
    // /ops and for tests; nothing on the public map reads it.
    `SELECT e.*,
      CASE WHEN e.status IN ('expired','withdrawn','corrected') AND e.ended_at > $1
           THEN 'active' ELSE e.status END                                  AS status,
      e.status                                                              AS actual_status,
      -- A district attached to an already-published event by a later merge is held for the same
      -- fifteen seconds as a brand-new event. Under the territory model that district IS a polygon
      -- and an icon stack — the most perceivable output the map has — so "a difference nobody can
      -- perceive" stopped being true the moment territories were drawn. The event always keeps at
      -- least one location: the first is written in the same transaction, so its created_at
      -- equals the event's own.
      COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
        'id',l.id,'name',l.name_uk,'relationType',el.relation_type,
        'latitude',l.latitude,'longitude',l.longitude
      )) FILTER (WHERE l.id IS NOT NULL AND el.created_at <= $1),'[]') AS locations,
      COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
        'name',s.name,'url',s.public_url,'publishedAt',sm.published_at
      )) FILTER (WHERE s.id IS NOT NULL),'[]') AS sources
     FROM threat_events e
     LEFT JOIN threat_event_locations el ON el.event_id=e.id
     LEFT JOIN locations l ON l.id=el.location_id
     LEFT JOIN event_evidence ee ON ee.event_id=e.id
     LEFT JOIN source_messages sm ON sm.id=ee.source_message_id
     LEFT JOIN sources s ON s.id=sm.source_id
     WHERE e.last_observed_at > now() - interval '12 hours'
       AND e.created_at <= $1
       AND ( e.status IN ('observed','confirmed','active')
          OR ( e.status IN ('expired','withdrawn','corrected')
               AND e.ended_at > $1 AND e.updated_at > now() - interval '1 hour' ) )
     GROUP BY e.id ORDER BY e.last_observed_at DESC`,
    [cutoff]
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

export async function threatDetails(id: string, cutoff: Date) {
  const event = await pool.query(
    // An event created after the cutoff does not exist yet as far as a public reader is concerned;
    // the `null` return is already the route's 404, so the hold and "no such event" are answered
    // identically and a probe cannot distinguish them.
    `SELECT e.*,
      COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
        'id',l.id,'name',l.name_uk,'relationType',el.relation_type,
        'latitude',l.latitude,'longitude',l.longitude
      )) FILTER (WHERE l.id IS NOT NULL),'[]') AS locations
     FROM threat_events e
     LEFT JOIN threat_event_locations el ON el.event_id=e.id
     LEFT JOIN locations l ON l.id=el.location_id
     WHERE e.id=$1 AND e.created_at <= $2 GROUP BY e.id`, [id, cutoff]
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

export async function assessmentDetails(id: string, cutoff: Date) {
  const assessment = await pool.query(
    `SELECT a.*,l.name_uk AS location_name,l.latitude,l.longitude
     FROM risk_assessments a JOIN locations l ON l.id=a.location_id
     WHERE a.id=$1 AND a.generated_at <= $2`, [id, cutoff]
  );
  if (!assessment.rowCount) return null;
  // `source_trust` is the publisher's current measured trust (`migrations/021_source_trust.sql`),
  // not the trust that was current when the assessment was generated: the number is a month-wide
  // rolling measurement and the card answers "how much do we trust this channel", not "how much did
  // we trust it at 03:14". NULL when the nightly worker has never scored the source, which the API
  // layer turns into no label at all rather than into a reassuring default.
  const signals = await pool.query(
    `SELECT rs.id,rs.signal_type,rs.threat_type,rs.source_tier,rs.reliability,
            rs.geographic_relevance,rs.observed_at,rs.expires_at,ras.contribution,ras.explanation,
            s.name AS source_name,s.public_url,t.trust AS source_trust
     FROM risk_assessment_signals ras JOIN risk_signals rs ON rs.id=ras.signal_id
     LEFT JOIN source_messages sm ON sm.id=rs.source_message_id
     LEFT JOIN sources s ON s.id=sm.source_id
     LEFT JOIN source_trust_current t ON t.source_id=sm.source_id
     WHERE ras.assessment_id=$1 ORDER BY ras.contribution DESC`, [id]
  );
  return { ...assessment.rows[0], signals: signals.rows };
}

/**
 * The alerts a public reader may see, as of the cutoff.
 *
 * The second branch of the `WHERE` is the all-clear asymmetry made mechanical. A period that ended
 * *after* the cutoff was still running at the cutoff, so the delayed view must keep showing it —
 * otherwise the public snapshot announces «Офіційний відбій» before the SSE frame that carries it,
 * which is the one failure `migrations/008` and `docs/ARCHITECTURE.md` call unrecoverable. The
 * `updated_at > now() - interval '1 hour'` bound is what keeps that branch from scanning every
 * period the installation has ever recorded, and `alert_periods_recent_idx (updated_at DESC)`
 * serves it.
 *
 * Filtering on `started_at` was rejected: it is `min(provider_started_at)`, the provider's
 * *declared* start, routinely older than the moment we learned of the alert — a provider that
 * back-dates would leak the alert instantly past any cutoff. `published_at` is when the period
 * became publicly true.
 *
 * With the `mode_changed_at` clamp on the cutoff, branch 2 also cannot RESURRECT an alert that was
 * already cleared from the public map: at the flip instant the cutoff is `mode_changed_at`, so
 * `ended_at > cutoff` is false for anything that ended before the flip. Without the clamp an
 * «Відбій» published at 10:00:00 and a flip at 10:00:05 would have put the red polygon back for nine
 * seconds — a false alert produced by a control-plane action alone.
 */
export async function activeAlerts(cutoff: Date) {
  const result = await pool.query(
    `SELECT a.id,a.location_id,l.name_uk AS location_name,l.latitude,l.longitude,
            a.alert_type,
            -- Status as of the cutoff. Branch 2 below returns periods that ended AFTER the cutoff:
            -- at the cutoff instant they were running, and that instant is what this whole response
            -- describes. \`actual_status\` carries the truth for /ops and for tests; the map reads
            -- presence, not status, and now that is a decision rather than luck.
            CASE WHEN a.status='ended' AND a.ended_at > $1 THEN 'active' ELSE a.status END AS status,
            a.status AS actual_status,
            a.started_at,a.updated_at
     FROM alert_periods a JOIN locations l ON l.id=a.location_id
     WHERE (a.status='active' AND a.published_at <= $1)
        OR (a.status='ended'  AND a.published_at <= $1 AND a.ended_at > $1
            AND a.updated_at > now() - interval '1 hour')
     ORDER BY a.started_at DESC`,
    [cutoff]
  );
  return result.rows;
}

/**
 * The `LEFT JOIN` on the superseding row is what makes "superseded" a fact **as of the cutoff**
 * rather than a fact as of now: an assessment replaced two seconds ago was still the current one at
 * the cutoff, and dropping it would blank the analytic contour for the length of the hold.
 */
export async function currentAssessments(cutoff: Date) {
  const result = await pool.query(
    `SELECT a.*,l.name_uk AS location_name,l.latitude,l.longitude
     FROM risk_assessments a
     JOIN locations l ON l.id=a.location_id
     LEFT JOIN risk_assessments sup ON sup.id=a.superseded_by
     WHERE a.published=true
       AND a.generated_at <= $1
       AND a.expires_at   >  $1
       AND (a.superseded_by IS NULL OR sup.generated_at > $1)
     ORDER BY a.risk_score DESC`,
    [cutoff]
  );
  return result.rows;
}

/**
 * The ancestry closure of the given location ids, capped at {@link LOCATION_HIERARCHY_MAX_DEPTH} and
 * cycle-guarded.
 *
 * Exists so `composeTerritoryStates()` can climb from a named city to the oblast that carries its
 * polygon without this process ever holding the whole catalogue: `SELECT id,parent_id,type FROM
 * locations` is tens of thousands of rows after the KATOTTG import, and the snapshot runs on every
 * page load. Walking upwards from only the referenced ids costs one index probe per edge.
 *
 * `TerritoryNode` is declared in `src/domain/territory-state.ts` and imported here, not the other
 * way round: the fold's unit tests are required to run without a database, and declaring the type
 * here would drag `pg` into them.
 */
export async function territoryAncestry(locationIds: string[]): Promise<TerritoryNode[]> {
  if (!locationIds.length) return [];
  const result = await pool.query<{ id: string; parent_id: string | null; type: string; name_uk: string }>(
    `WITH RECURSIVE seed AS (
       SELECT id, parent_id, type, name_uk, 0 AS depth, ARRAY[id] AS path
       FROM locations WHERE id = ANY($1::text[])
       UNION ALL
       SELECT l.id, l.parent_id, l.type, l.name_uk, s.depth+1, s.path || l.id
       FROM seed s JOIN locations l ON l.id = s.parent_id
       WHERE s.depth < ${LOCATION_HIERARCHY_MAX_DEPTH} AND NOT l.id = ANY(s.path)
     )
     SELECT DISTINCT id, parent_id, type, name_uk FROM seed`,
    [locationIds]
  );
  return result.rows.map((row) => ({
    id: row.id, parentId: row.parent_id, type: row.type, nameUk: row.name_uk
  }));
}

/**
 * `cutoff` is the SECOND parameter, before the optional `limit`. Appending it after would be TS1016
 * («A required parameter cannot follow an optional parameter») and would not compile — which is
 * exactly the property wanted here, because the compiler then enumerates every call site instead of
 * silently binding `undefined` and turning every `<= $n` into NULL.
 *
 * The three item queries and the three matching count queries all carry the predicate, so the counts
 * can never disagree with the items a reader is shown.
 */
export async function locationTimeline(locationId: string, cutoff: Date, limit = 100) {
  const location = (await pool.query(
    `SELECT id,parent_id,type,name_uk,latitude,longitude FROM locations WHERE id=$1`, [locationId]
  )).rows[0];
  if (!location) return null;
  // Six statements share one hierarchy walk: resolving the ids once and binding them as an array is
  // cheaper than repeating the recursive CTE in each of them, and keeps the six definitions of
  // "belongs to this location" identical by construction.
  const related = await relatedLocationIds(locationId);
  const applies = `target.id=ANY($1::text[])`;
  const [threats, alerts, assessments, threatCount, alertCount, assessmentCount] = await Promise.all([
    pool.query(
      `SELECT DISTINCT e.id,'threat' AS kind,e.started_at AS happened_at,e.title,e.summary,e.status,
              e.threat_type,e.evidence_level,e.valid_until,NULL::numeric AS risk_score,NULL::text AS risk_level
       FROM threat_events e JOIN threat_event_locations el ON el.event_id=e.id
       JOIN locations target ON target.id=el.location_id WHERE ${applies}
         AND e.created_at <= $3
       ORDER BY e.started_at DESC LIMIT $2`, [related, limit, cutoff]
    ),
    pool.query(
      `SELECT a.id,'alert' AS kind,a.started_at AS happened_at,
              CASE WHEN a.status='active' THEN 'Офіційна тривога' ELSE 'Офіційна тривога завершена' END AS title,
              CASE WHEN a.status='active' THEN 'Офіційне попередження активне.' ELSE 'Зафіксовано офіційний відбій.' END AS summary,
              a.status,a.alert_type AS threat_type,'official' AS evidence_level,a.ended_at AS valid_until,
              NULL::numeric AS risk_score,NULL::text AS risk_level
       FROM alert_periods a JOIN locations target ON target.id=a.location_id WHERE ${applies}
         AND a.published_at <= $3
       ORDER BY a.started_at DESC LIMIT $2`, [related, limit, cutoff]
    ),
    pool.query(
      `SELECT a.id,'assessment' AS kind,a.generated_at AS happened_at,'Аналітичне попередження' AS title,
              COALESCE(a.explanation->>'summary','Індекс публічних сигналів.') AS summary,
              CASE WHEN a.superseded_by IS NULL AND a.expires_at>now() THEN 'active' ELSE 'expired' END AS status,
              a.threat_type,NULL::text AS evidence_level,a.horizon_end AS valid_until,a.risk_score,a.risk_level
       FROM risk_assessments a JOIN locations target ON target.id=a.location_id WHERE a.published=true AND ${applies}
         AND a.generated_at <= $3
       ORDER BY a.generated_at DESC LIMIT $2`, [related, limit, cutoff]
    ),
    // The counts take the cutoff as `$2`: an unreferenced bind parameter is a bind-message error in
    // PostgreSQL, so `limit` cannot simply be carried along to keep the numbering uniform.
    pool.query(`SELECT count(DISTINCT e.id)::integer AS count FROM threat_events e
      JOIN threat_event_locations el ON el.event_id=e.id JOIN locations target ON target.id=el.location_id
      WHERE ${applies} AND e.created_at <= $2`, [related, cutoff]),
    pool.query(`SELECT count(*)::integer AS count FROM alert_periods a
      JOIN locations target ON target.id=a.location_id WHERE ${applies} AND a.published_at <= $2`, [related, cutoff]),
    pool.query(`SELECT count(*)::integer AS count FROM risk_assessments a
      JOIN locations target ON target.id=a.location_id
      WHERE a.published=true AND ${applies} AND a.generated_at <= $2`, [related, cutoff])
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
