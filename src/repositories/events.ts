import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { nearerTiming, type ThreatTiming } from '../domain/threat-timing.js';
import { config } from '../config.js';
import { CLASSIFIER_VERSION } from '../domain/classifier.js';
import type { TerritoryNode } from '../domain/territory-state.js';
import { pool } from '../db/pool.js';
import type { ClassifiedMessage, EvidenceLevel, LiveEvent, NormalizedMessage, ThreatOrigin } from '../types.js';

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
 * Той самий обхід ієрархії, але для БАГАТЬОХ місць одразу і зі збереженням того, від якого саме
 * місця дійшли: `related_locations_by_root(root, id)`.
 *
 * {@link relatedLocationsCte} відповідає на питання «чи стосується цього читача ось це одне місце»
 * і зливає результат у пласку множину — саме те, що треба фан-ауту тривог. Зведення після простою
 * ставить обернене питання: «які з десятка місць, де вночі щось було, стосуються цього читача», і
 * пласка множина на нього відповісти не може — у ній уже не видно, який рядок від якого місця.
 *
 * Правила обходу тут ті самі й навмисно повторені з попередньої функції, а не переписані: угору й
 * униз по `parent_id` на будь-яку глибину, захист від циклів через `path` і безумовна стеля
 * {@link LOCATION_HIERARCHY_MAX_DEPTH}. `parent_id` приходить із KATOTTG, тобто ззовні процесу, і
 * ацикличності від нього ніхто не гарантував.
 *
 * `anchor` — вираз-плейсхолдер з масивом ідентифікаторів (`$1::text[]`), ніколи не дані користувача.
 */
export function relatedLocationsByRootCte(anchor = '$1::text[]'): string {
  return `WITH RECURSIVE root_ancestors(root,id,parent_id,depth,path) AS (
      SELECT seed.id,seed.id,seed.parent_id,0,ARRAY[seed.id] FROM locations seed WHERE seed.id=ANY(${anchor})
    UNION ALL
      SELECT child.root,parent.id,parent.parent_id,child.depth+1,child.path||parent.id
      FROM root_ancestors child JOIN locations parent ON parent.id=child.parent_id
      WHERE child.depth<${LOCATION_HIERARCHY_MAX_DEPTH} AND NOT (parent.id=ANY(child.path))
  ), root_descendants(root,id,depth,path) AS (
      SELECT seed.id,seed.id,0,ARRAY[seed.id] FROM locations seed WHERE seed.id=ANY(${anchor})
    UNION ALL
      SELECT parent.root,child.id,parent.depth+1,parent.path||child.id
      FROM root_descendants parent JOIN locations child ON child.parent_id=parent.id
      WHERE parent.depth<${LOCATION_HIERARCHY_MAX_DEPTH} AND NOT (child.id=ANY(parent.path))
  ), related_locations_by_root(root,id) AS (
      SELECT root,id FROM root_ancestors UNION SELECT root,id FROM root_descendants
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

/**
 * The catalogue as the classifier reads it.
 *
 * `type`, `geocoded` and `oblast_id` ride along with the names because two catalogue rows can spell
 * the same — Миколаїв the oblast capital and Миколаїв the town in Lviv oblast, Городок twice,
 * Південне twice — and the classifier refuses such a span unless something ranks the rows. Only the
 * hand-seeded first-order rows carry coordinates (the KATOTTG importer writes none), so
 * `latitude IS NOT NULL` is the catalogue's own statement that a row is the well-known one, and the
 * oblast walked up `parent_id` is what lets a message that already said "Одещина" pick the Південне
 * it means. All three are read for that tie-break and nothing else.
 */
export async function listLocationLexemes() {
  const result = await pool.query<{
    id: string; name_uk: string; aliases: string[]; type: string;
    geocoded: boolean; oblast_id: string | null;
  }>(
    `WITH RECURSIVE ancestry(id, ancestor_id, ancestor_type) AS (
       SELECT id, id, type FROM locations
       UNION ALL
       SELECT ancestry.id, parent.id, parent.type
         FROM ancestry JOIN locations child ON child.id = ancestry.ancestor_id
                       JOIN locations parent ON parent.id = child.parent_id
     )
     SELECT l.id, l.name_uk, l.aliases, l.type, l.latitude IS NOT NULL AS geocoded,
            (SELECT ancestor_id FROM ancestry
              WHERE ancestry.id = l.id AND ancestor_type IN ('oblast','special_city')
              LIMIT 1) AS oblast_id
       FROM locations l WHERE l.type <> 'country' ORDER BY length(l.name_uk) DESC, l.id`
  );
  return result.rows.map((row) => ({
    id: row.id, name: row.name_uk, aliases: row.aliases ?? [], type: row.type,
    geocoded: row.geocoded, ...(row.oblast_id ? { oblastId: row.oblast_id } : {})
  }));
}

export type LocationLexemeRow = Awaited<ReturnType<typeof listLocationLexemes>>[number];

/**
 * The SAME array instance for every caller until the catalogue changes — identity is the contract,
 * not an optimisation. `indexFor` in `src/domain/classifier.ts` memoises its 300k-entry token index
 * in a `WeakMap` keyed on the catalogue *array*, so a path that re-queries per message (as ingestion
 * did) misses that memo 100% of the time and pays the recursive-CTE walk over tens of thousands of
 * KATOTTG rows plus a full re-index — ~40–75 MB of old-space garbage per ingested message, which is
 * what inflated the container to gigabytes during message bursts.
 *
 * Invalidation is event-driven: `invalidateLocationLexemeCache()` is called after every successful
 * KATOTTG import — the only writer of `locations`. The TTL below is a backstop for a writer this
 * module does not know about (a manual psql edit), not the primary mechanism.
 */
const LEXEME_CACHE_TTL_MS = 6 * 60 * 60_000;
let lexemeCache: { rows: LocationLexemeRow[]; loadedAt: number } | null = null;
let lexemeCacheLoading: Promise<LocationLexemeRow[]> | null = null;

export async function cachedLocationLexemes(): Promise<LocationLexemeRow[]> {
  if (lexemeCache && Date.now() - lexemeCache.loadedAt < LEXEME_CACHE_TTL_MS) return lexemeCache.rows;
  // One in-flight load shared by every concurrent message: a burst of N messages on a cold cache
  // must not become N recursive-CTE queries racing each other on the pool.
  lexemeCacheLoading ??= listLocationLexemes()
    .then((rows) => { lexemeCache = { rows, loadedAt: Date.now() }; return rows; })
    .finally(() => { lexemeCacheLoading = null; });
  return lexemeCacheLoading;
}

export function invalidateLocationLexemeCache() {
  lexemeCache = null;
}

async function appendSystemEvent(client: PoolClient, eventType: string, payload: unknown) {
  const result = await client.query<{ version: string }>(
    `INSERT INTO system_event_log(event_type,payload) VALUES ($1,$2) RETURNING version`,
    [eventType, JSON.stringify(payload)]
  );
  return Number(result.rows[0]?.version ?? 0);
}

/**
 * How long one message keeps the event it raised valid, in milliseconds.
 *
 * The same thirty minutes every `interval '30 minutes'` in this file writes, expressed once so that
 * the *decision* built on it — "is this message still inside its own validity window?" — is taken
 * from the same number the rows are written with. `src/services/source-backfill.ts` reads it to
 * label a replayed message `stale`, and {@link ingestThreat} reads it to decide whether a historical
 * message may publish at all. Two copies of that constant is two definitions of "expired".
 */
export const THREAT_VALIDITY_MS = 30 * 60_000;

/**
 * Стеля віку повідомлення для доставки, у мілісекундах, або `null`, коли її вимкнено.
 *
 * Читається щоразу, а не запамʼятовується в константі: `SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES` —
 * гаряче налаштування (`apply: 'hot'`), і оператор, який змінив його в `/ops`, має отримати нову
 * межу на наступному повідомленні, а не на наступному перезапуску.
 */
export function deliveryAgeCeilingMs(): number | null {
  const minutes = config.SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES;
  return minutes > 0 ? minutes * 60_000 : null;
}

/**
 * Чи це повідомлення ще має право дійти до людини — за одним лише його віком.
 *
 * Один предикат на дві поверхні: `ingestThreat` вирішує ним, чи писати рядок у `system_event_log`
 * (тобто чи буде подія на карті й сповіщення в боті), а `src/services/ingestion.ts` — чи називати
 * рішення придушеним за віком у архіві й у контексті локацій. Два окремі порівняння з тією самою
 * межею — це два визначення слова «застаріле».
 */
export function withinDeliveryAge(publishedAt: Date, now: Date = new Date()): boolean {
  const ceiling = deliveryAgeCeilingMs();
  if (ceiling === null) return true;
  return now.getTime() - publishedAt.getTime() < ceiling;
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
 *
 * **The conflict branch is gated on the withdrawal being older than this assertion.** Re-assertion
 * means "I said it was over, and now I am saying it again"; it does not mean "a message published
 * before my all-clear has just been read". Without the `WHERE`, replaying an hour-old post — which
 * is exactly what a catch-up backfill does — would clear a `withdrawn_at` that a *later* stand-down
 * wrote and put a threat its own publisher has already retracted back on the map. Zero rows updated
 * is the correct, silent outcome in that case: the newer statement stands.
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
       updated_at=now()
     WHERE threat_assertions.withdrawn_at IS NULL
        OR threat_assertions.withdrawn_at <= EXCLUDED.asserted_at`,
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
 *     changes nothing at all, without needing a special case. It is additionally bounded in TIME:
 *     `asserted_at <= $2` means a stand-down retracts only what was standing **when it was
 *     published**. Without that bound an hour-old all-clear read off a channel's history — the
 *     ordinary output of a catch-up backfill — would close an assertion the same source made ten
 *     minutes ago and take a live warning off the map, which is the one direction
 *     `docs/ARCHITECTURE.md` §Consistency rules calls unrecoverable.
 *  2. **Decay this source's risk signals** for the same places and classes, by pulling `expires_at`
 *     back to now — and, for the same reason, only the signals this source had already observed by
 *     the moment the all-clear was published. Not a negative contribution: a negative term could
 *     drive a location's index to zero while a real threat from other sources is still running,
 *     whereas expiry says only "the basis for *this* signal is gone" and leaves the time decay in
 *     `src/services/risk.ts` to handle the rest. Scoped on `source_messages.source_id` rather than
 *     `independence_group`, because a repost aggregator shares its group with the channel it copies.
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
        AND asserted_at <= $2::timestamptz
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
        AND rs.observed_at <= $2::timestamptz
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
  'event_created' | 'event_merged' | 'redirect' | 'de_escalation' | 'ignored' | 'unrecognized'
  | 'coalesced'
  /** Refused by the deterministic `v5` retrospection rules; reproducible by replaying them. */
  | 'ignored_retrospective'
  /** Refused by the model gate in the grey band; reproducible by nothing. See migration 025. */
  | 'ignored_retrospective_model';

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
  /** Advisory-only media; never consumed by `recordClassification` or the live event transaction. */
  media?: NormalizedMessage['media'];
  /** Original envelope used only by optional post-classification analytical promotion. */
  message?: NormalizedMessage;
  /** Backfill provenance keeps an old promoted event archive-only. */
  historical?: boolean;
  /**
   * Хто збудував класифікацію. Типово — `CLASSIFIER_VERSION` правил; у режимі `classifier_mode=codex`
   * — `codex-primary-v1`, і тоді `assessment` несе те, чого правила не дають: актуальність,
   * ймовірність, модель і її впевненість. Одна колонка `classifier_version` у архіві — і рішення
   * моделі міряються тими самими запитами, що й рішення правил.
   */
  classifierVersion?: string;
  assessment?: {
    model: string; confidence: number; timing: ThreatTiming; probability: number | null; note: string | null;
  } | null;
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
         withdrawn_assertions,withdrawn_event_ids,last_assertion_at,decayed_risk_signals,origin_zone,
         timing,probability,model,model_confidence,model_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::uuid[],$19,$20,$21,
         $22,$23,$24,$25,$26)
       ON CONFLICT (source_message_id,classifier_version) DO NOTHING
       RETURNING id`,
      [
        entry.sourceMessageId, entry.sourceId, entry.classifierVersion ?? CLASSIFIER_VERSION, entry.publishedAt,
        entry.decision, classified.intent, entry.createdEvent ?? false, entry.ignoredReason ?? null,
        classified.threatType, classified.signalThreatTypes, classified.indicators,
        classified.nationalScope, classified.directionText ?? null, entry.eventId ?? null,
        retraction?.coverage ?? null, retraction ? retraction.threatTypes : null,
        withdrawal?.withdrawnAssertions ?? null, withdrawal?.touchedEventIds ?? null,
        withdrawal?.lastAssertionAt ?? null, withdrawal?.decayedSignals ?? null,
        classified.originZone ?? null,
        entry.assessment?.timing ?? null, entry.assessment?.probability ?? null,
        entry.assessment?.model ?? null, entry.assessment?.confidence ?? null, entry.assessment?.note ?? null
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
  /**
   * Whether this call appended a lifecycle row to `system_event_log`.
   *
   * False for a duplicate and for a message replayed from outside its own validity window. That row
   * is the ONLY trigger for the public SSE stream and for the Telegram fan-out
   * (`src/bot/outbox.ts`), so `published: false` is the machine-readable form of "this landed in the
   * archive and nowhere else".
   */
  published: boolean;
}

export interface IngestThreatOptions {
  /**
   * The message is being replayed from the catch-up backfill rather than read live.
   *
   * On its own the flag changes nothing: a message replayed ten minutes after publication is still
   * news, and `src/services/source-backfill.ts` replays a downtime window that ends at *now*. What
   * it enables is the check below — `publishedAt + THREAT_VALIDITY_MS <= now()`, i.e. "this message
   * is already outside the window it would have created" — and only messages that fail that check
   * are treated as archive.
   *
   * It is opt-in, and it is opt-in from the CALLER rather than derived from the timestamp, because
   * the live path must keep its current behaviour exactly: a live message that arrives forty minutes
   * late through a Telegram outage is still the collector observing the channel, and silently
   * demoting it would be a behaviour change nobody asked for.
   *
   * The age ceiling below ({@link deliveryAgeCeilingMs}) is the OTHER half of the same question, and
   * it is deliberately not this flag: it looks at how old the message is, not at who is replaying
   * it, so a live path that starts delivering hour-old posts is covered without anybody having to
   * remember to pass a flag.
   */
  historical?: boolean;
  /** Model provenance. Forces `unverified` evidence and disables every retraction branch. */
  modelPromotion?: { model: string; confidence: number };
  /**
   * Модель як ОСНОВНИЙ класифікатор (міграція 049, `classifier_mode='codex'`): актуальність,
   * ймовірність і вікно очікування з її вердикту. На відміну від `modelPromotion` це НЕ знижує
   * доказовості й не вимикає злиття: твердження лишається твердженням джерела, модель лише прочитала
   * його. Подія позначається `classified_by='codex'`, а `origin` лишається `deterministic` — див.
   * коментар до колонки в міграції 049.
   */
  assessment?: {
    model: string;
    classifierVersion: string;
    timing: ThreatTiming;
    probability: number | null;
    expectedFrom: Date;
    expectedUntil: Date;
    note: string | null;
  };
}

export async function ingestThreat(
  message: NormalizedMessage, classified: ClassifiedMessage, options: IngestThreatOptions = {}
): Promise<IngestThreatResult> {
  /**
   * "Stale history is archive, not news", as one boolean.
   *
   * The seam is `system_event_log`: nothing reaches the public map or a subscriber's phone except
   * through a row in that table, so refusing to write one suppresses both at once and does it in a
   * single place instead of in a rule the SSE relay and the fan-out would each have to re-derive.
   * Everything else this flag switches off — new districts on a live event, risk signals,
   * corroboration promotion, supersession — is a state change that would ALSO be perceivable, and
   * each of them is disabled for its own reason at the site where it happens.
   *
   * A retraction is deliberately NOT switched off. A publisher's own all-clear is the safety-positive
   * direction, and with the `asserted_at <= $2` bound in {@link applyRetraction} it can only ever
   * reach what was standing when it was published.
   *
   * Дві межі, і жодна не послаблює іншої:
   *
   *  * **вікно валідності повідомлення дозбору** (30 хв) — те, що було тут завжди. Воно суворіше й
   *    вмикається прапорцем `historical`;
   *  * **стеля віку** (`SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES`, типово година) — рішення власника
   *    20.08.2026. Вона дивиться лише на вік і тому накриває ЖИВИЙ шлях теж: після реконекту
   *    MTProto віддає пачку пропущених апдейтів з їхніми справжніми датами й без жодного прапорця,
   *    і саме вони йшли в бот як щойно опубліковані. Повідомлення старше за стелю доходить до
   *    архіву й до контексту локацій — до людини не доходить нічого.
   */
  //
  // Очікувана загроза рахується не за віком, а за власним вікном. «Увечері очікується удар»,
  // опубліковане о 14:00 і прочитане о 15:10, стосується вечора, а не тих сімдесяти хвилин, що
  // минули: стеля віку є проксі для питання «те, про що це повідомлення, вже скінчилося?», і для
  // події «зараз» вона на нього відповідає, а для очікуваної — ні. Тому там питається саме те, що
  // мається на увазі: чи закрилося вікно очікування. Придушити попередження про сьогоднішній вечір
  // через те, що ми прочитали його на годину пізніше, означало б втратити справжнє попередження
  // заради правила, написаного проти хибних.
  const expectedUntil = options.assessment && options.assessment.timing !== 'now'
    ? options.assessment.expectedUntil
    : null;
  const staleForDelivery = expectedUntil
    ? expectedUntil.getTime() <= Date.now()
    : !withinDeliveryAge(message.publishedAt);
  const outsideWindow = (Boolean(options.historical)
    && message.publishedAt.getTime() + THREAT_VALIDITY_MS <= Date.now())
    || staleForDelivery;
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
        sourceMessageId: duplicate.rows[0].id, withdrawal: NO_WITHDRAWAL, published: false
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
       ON CONFLICT (source_id,external_id,content_hash) DO UPDATE SET
         received_at=now(), processing_status='classified'
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
    const evidenceLevel: EvidenceLevel = options.modelPromotion ? 'unverified'
      : sourceRow.official ? 'official' : sourceRow.tier === 'B' ? 'monitoring' : 'unverified';
    // Authorship, on its own axis. `evidenceLevel` above sends a Tier C human channel and a model
    // promotion to the same word — `unverified` — because corroboration really is absent in both
    // cases; that is correct and stays. What was missing is that a reader could not tell the two
    // apart afterwards: the only marks of model authorship were `classified.indicators` (consumed
    // in this transaction, never stored) and `raw_payload -> 'analyticalThreat'` (a join and a JSON
    // path away from every public read). Now it is a column, written from the same option that
    // already decides evidence, contribution and evidence_role below, so the four cannot disagree.
    //
    // Derived here rather than by the caller for the same reason `evidenceLevel` is: `ingestThreat`
    // is the only writer of `threat_events`, and a promotion that forgot to pass the origin would
    // publish a model claim labelled as rule output — the exact confusion this column exists to end.
    const origin: ThreatOrigin = options.modelPromotion ? 'model' : 'deterministic';
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

    // Очікувана подія (timing <> now) приймає нові повідомлення впродовж усього свого вікна, а не лише
    // тридцять хвилин від останньої згадки: «увечері очікується» о 15:00 і «все ще очікується» о 17:00 —
    // одна подія, а не дві.
    const existing = locationIds.length ? await client.query<{ id: string; evidence_level: EvidenceLevel; status: string; timing: ThreatTiming }>(
      `SELECT e.id,e.evidence_level,e.status,e.timing FROM threat_events e
       JOIN threat_event_locations el ON el.event_id=e.id
       WHERE e.threat_type=$1 AND el.location_id=ANY($2::text[])
         AND e.status IN ('observed','confirmed','active')
         AND (e.last_observed_at > now() - interval '30 minutes'
              OR (e.timing <> 'now' AND e.expected_until > now()))
       ORDER BY e.last_observed_at DESC LIMIT 1`,
      [classified.threatType, locationIds]
    ) : { rows: [], rowCount: 0 } as never;

    // Analytical promotion is a gap-filler, never a way to rewrite or widen an event that already
    // exists. In particular, one overlapping model destination must not attach its other guessed
    // destinations to an official event and trigger an `evidence_raised`/geography notification.
    if (options.modelPromotion && existing.rowCount && existing.rows[0]) {
      await client.query('COMMIT');
      return {
        id: existing.rows[0].id, version: await systemVersion(), created: false,
        sourceMessageId, withdrawal: NO_WITHDRAWAL, published: false
      };
    }

    let eventId: string;
    let created = false;
    if (existing.rowCount && existing.rows[0]) {
      eventId = existing.rows[0].id;
      const nextEvidence = strongestEvidence(existing.rows[0].evidence_level, evidenceLevel);
      // Every column that describes WHEN the event was last seen moves forwards only, and the two
      // columns of prose are rewritten only by a message at least as new as the one they came from.
      //
      // Before this, any late message dragged a live window backwards: an out-of-order arrival — and
      // every message a catch-up backfill replays is out of order by construction — reset
      // `last_observed_at` to its own older timestamp and recomputed `valid_until` from it, so a
      // threat another message had just extended to 04:10 could be pulled back to 03:40 and expire
      // early. `GREATEST` makes both monotonic. The prose is guarded separately because it is not a
      // maximum of anything: overwriting «курс на Полтавщину» with an hour-old «повз Бровари» is not
      // a shorter window, it is a wrong sentence on a live marker.
      //
      // `$3 >= last_observed_at` reads the row's PRE-UPDATE value: PostgreSQL evaluates every SET
      // expression against the old tuple, so the guard and the assignment beside it cannot disagree.
      //
      // `origin` is deliberately absent from this statement, and it is absent in both directions.
      // A promotion never reaches here at all — the guard above returns the moment a matching event
      // already exists — so this branch cannot write `model` onto a rule-authored event. The other
      // direction is the interesting one: a human message merging into an event the model created
      // does NOT reset `origin` to `deterministic`. Authorship is a fact about how the row came to
      // exist and it does not stop being true when a channel later reports the same thing; what
      // that report changes is corroboration, and corroboration is `evidence_level`, which this
      // statement does raise. Clearing the flag here would erase the disclosure at the exact moment
      // the event grows — the reader would watch a model guess quietly become an ordinary report.
      // Актуальність після злиття — БЛИЖЧА з двох: «увечері очікується» + «вже летить» = зараз.
      // Ймовірність — більша; вікно — ширше; `valid_until` — далі. Нова оцінка без `assessment`
      // (повідомлення, яке класифікували правила) лишає існуючу актуальність, але рахується як «зараз»
      // для вікна чинності, як і завжди.
      const existingTiming: ThreatTiming = existing.rows[0].timing ?? 'now';
      const mergedTiming: ThreatTiming = options.assessment
        ? nearerTiming(options.assessment.timing, existingTiming)
        : 'now';
      await client.query(
        `UPDATE threat_events SET
           summary=CASE WHEN $6::boolean THEN summary
             WHEN $3::timestamptz >= last_observed_at THEN $2 ELSE summary END,
           last_observed_at=GREATEST(last_observed_at,$3::timestamptz),updated_at=now(),
           evidence_level=$4,status=CASE WHEN $4='official' THEN 'active' ELSE status END,
           direction_text=CASE WHEN $6::boolean THEN COALESCE(direction_text,$5)
             WHEN $3::timestamptz >= last_observed_at
             THEN COALESCE($5,direction_text) ELSE direction_text END,
           valid_until=GREATEST(valid_until,$3::timestamptz + interval '30 minutes',$8::timestamptz),
           timing=$7,
           probability=CASE WHEN $9::numeric IS NULL THEN probability ELSE GREATEST(COALESCE(probability,0),$9::numeric) END,
           expected_from=CASE WHEN $10::timestamptz IS NULL THEN expected_from ELSE LEAST(COALESCE(expected_from,$10::timestamptz),$10::timestamptz) END,
           expected_until=CASE WHEN $8::timestamptz IS NULL THEN expected_until ELSE GREATEST(COALESCE(expected_until,$8::timestamptz),$8::timestamptz) END,
           assessment_note=COALESCE($11,assessment_note)
         WHERE id=$1`,
        [eventId, classified.summary, message.publishedAt, nextEvidence,
          classified.directionText ?? null, Boolean(options.modelPromotion),
          mergedTiming,
          options.assessment && options.assessment.timing !== 'now' ? options.assessment.expectedUntil : null,
          options.assessment?.probability ?? null,
          options.assessment ? options.assessment.expectedFrom : null,
          options.assessment?.note ?? null]
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
      // Born expired, with `ended_at` already set to the deadline the message itself carried.
      //
      // Writing `observed` and letting the sweeper retire it later would leave a window — however
      // short — in which a three-hour-old post is a live threat, and `liveThreats` has a second
      // branch that deliberately keeps terminal rows visible while `ended_at > cutoff`: an event
      // that ended at 03:40 and was inserted at 06:40 fails that branch by three hours, so setting
      // `ended_at` here is what makes the row unreachable from the map in delayed mode as well as in
      // live mode. `/api/v1/history` filters on nothing but `created_at <= cutoff`, so the event is
      // still in the archive an operator and a reader can page through — which is the whole point of
      // replaying the window at all.
      // Очікувана подія живе до кінця свого вікна, а не тридцять хвилин: `valid_until` — це те, що
      // читає сповіщувач і прибиральник, тож «увечері очікується» без цього зникло б з карти о 15:30.
      const expectedUntil = options.assessment && options.assessment.timing !== 'now' ? options.assessment.expectedUntil : null;
      const result = await client.query<{ id: string }>(
        `INSERT INTO threat_events(threat_type,status,evidence_level,origin,title,summary,started_at,last_observed_at,direction_text,valid_until,ended_at,
                                   timing,probability,expected_from,expected_until,classified_by,assessment_note)
         VALUES ($1,$2,$3,$9,$4,$5,$6::timestamptz,$6::timestamptz,$7,
           GREATEST($6::timestamptz + interval '30 minutes', COALESCE($13::timestamptz, $6::timestamptz)),
           CASE WHEN $8 THEN $6::timestamptz + interval '30 minutes' ELSE NULL END,
           $10,$11,$12::timestamptz,$13::timestamptz,$14,$15) RETURNING id`,
        [classified.threatType,
          outsideWindow ? 'expired' : evidenceLevel === 'official' ? 'active' : 'observed', evidenceLevel,
          classified.title, classified.summary, message.publishedAt, classified.directionText ?? null,
          outsideWindow, origin,
          options.assessment?.timing ?? 'now',
          options.assessment?.probability ?? null,
          options.assessment?.expectedFrom ?? message.publishedAt,
          expectedUntil ?? new Date(message.publishedAt.getTime() + THREAT_VALIDITY_MS),
          options.assessment ? 'codex' : 'rules',
          options.assessment?.note ?? null]
      );
      eventId = result.rows[0]!.id;
    }

    // A stale message may furnish the event it just created — that event is expired and drawn
    // nowhere — but it may not attach a district or an assertion to an event that is LIVE. Under the
    // territory model a district is a polygon and an icon stack, so growing the geography of a
    // standing threat from an hour-old post changes the most perceivable output the map has, and
    // `decideThreatNotification` reads exactly that growth as `geography_changed`. The assertion
    // rides with the district for the same reason and one more: an assertion is a claim about NOW,
    // and a message outside its own validity window is by definition not making one.
    if (created || !outsideWindow) {
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
    }
    // No risk signal from a message outside its own window. `src/services/risk.ts` decays on a
    // two-hour half-life and gates on `expires_at > now()` alone, so a three-hour-old signal still
    // contributes about a third of its weight — a backfill would quietly raise the analytic index of
    // every oblast in the replayed window hours after the reports it is built from stopped applying.
    // Очікувана загроза (не «зараз») важить у шестигодинному індексі ризику менше: масштабовано на
    // ймовірність моделі та вдвічі — це сигнал про можливе, а не про наявне, і так він читається.
    const timingWeight = options.assessment && options.assessment.timing !== 'now'
      ? 0.5 * (options.assessment.probability ?? 0.5) : 1;
    const baseContribution = (options.modelPromotion ? 0.3
      : sourceRow.official ? 2.5 : sourceRow.tier === 'B' ? 1.5 : 0.6) * timingWeight;
    for (const target of outsideWindow ? [] : signalTargets) {
      for (const signalThreatType of classified.signalThreatTypes) {
        await client.query(
          `INSERT INTO risk_signals(signal_type,source_message_id,location_id,threat_type,source_tier,
            independence_group,reliability,freshness,geographic_relevance,contribution,observed_at,expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10::timestamptz,$10::timestamptz + interval '6 hours')`,
          [classified.indicators[0] ?? target.relationType, sourceMessageId, target.id, signalThreatType, sourceRow.tier,
            sourceRow.independence_group, options.modelPromotion ? options.modelPromotion.confidence * 0.5
              : sourceRow.official ? 1 : sourceRow.tier === 'B' ? 0.75 : 0.4,
            target.relevance, baseContribution * target.relevance, message.publishedAt]
        );
      }
    }
    await client.query(
      `INSERT INTO event_evidence(event_id,source_message_id,evidence_role,confidence) VALUES ($1,$2,$3,$4)
       ON CONFLICT DO NOTHING`, [eventId, sourceMessageId,
        options.modelPromotion ? `model:${sourceRow.independence_group}` : sourceRow.independence_group,
        options.modelPromotion?.confidence ?? (evidenceLevel === 'official' ? 1 : 0.55)]
    );
    // Corroboration is a statement about the present tense — "two independent groups are reporting
    // this" — and a message from outside its own validity window is not reporting anything now. It
    // is also the one branch here that can raise a LIVE event's evidence level, which
    // `decideThreatNotification` reads as `evidence_raised` and sends as an escalation.
    if (evidenceLevel !== 'official' && !outsideWindow) {
      const corroboration = await client.query<{ independent_sources: number }>(
        `SELECT count(DISTINCT s.independence_group)::integer AS independent_sources
         FROM event_evidence ee
         JOIN source_messages sm ON sm.id=ee.source_message_id
         JOIN sources s ON s.id=sm.source_id
         WHERE ee.event_id=$1 AND s.tier IN ('A','B') AND ee.evidence_role NOT LIKE 'model:%'`,
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
    // Supersession is switched off for the same reason: it ENDS a live event (`status='corrected'`,
    // `ended_at=now()`) and announces that through `threat.corrected`. An edit read out of a
    // channel's history hours later must not retire a threat that is standing now. The revision row
    // and `supersedes_message_id` above are untouched — they are provenance, which issue #3 requires
    // a backfill to preserve, and neither is visible on any public surface.
    if (!outsideWindow && previousMessage.rows[0]?.event_id && previousMessage.rows[0].event_id !== eventId) {
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
    if (!options.modelPromotion && classified.retraction && classified.intent === 'redirect') {
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
    // THE SEAM. No row here means no SSE frame and no outbox line — `fanoutNewEvents` walks this
    // table and nothing else. The version still has to be answered truthfully, so it is read after
    // the COMMIT (through the pool, never through this client, which is still holding a transaction
    // and would need a second connection to answer a question it has already asked).
    const version = outsideWindow
      ? 0
      : await appendSystemEvent(client, created ? 'threat.created' : 'threat.updated', { eventId });
    await client.query('COMMIT');
    return {
      id: eventId, version: outsideWindow ? await systemVersion() : version,
      created, sourceMessageId, withdrawal, published: !outsideWindow
    };
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
      -- Bounded on attached_at (when WE attached the evidence) for the same reason the district
      -- above is, and never on sm.published_at, which is the publisher's declared time and would
      -- walk past any hold on a back-dated post. threatDetails() gates its evidence list the same
      -- way, so the marker and the dialog opened from it can never name different sources. An event
      -- inside the slice always keeps at least its first source: that row is attached in the same
      -- transaction that created the event, so their timestamps are equal.
      COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
        'name',s.name,'url',s.public_url,'publishedAt',sm.published_at
      )) FILTER (WHERE s.id IS NOT NULL AND ee.attached_at <= $1),'[]') AS sources
     FROM threat_events e
     LEFT JOIN threat_event_locations el ON el.event_id=e.id
     LEFT JOIN locations l ON l.id=el.location_id
     LEFT JOIN event_evidence ee ON ee.event_id=e.id
     LEFT JOIN source_messages sm ON sm.id=ee.source_message_id
     LEFT JOIN sources s ON s.id=sm.source_id
     WHERE ( e.last_observed_at > now() - interval '12 hours'
             -- Очікувана подія (міграція 049) читається за своїм вікном, а не за останньою згадкою:
             -- «протягом двох діб» без нової згадки не має зникнути з карти за дванадцять годин.
             OR (e.timing <> 'now' AND e.expected_until > now()) )
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
    // Міграція 049. COALESCE з тієї самої причини, що й `origin` нижче: бінарник може випередити базу.
    timing: row.timing ?? 'now',
    probability: row.probability == null ? null : Number(row.probability),
    expectedFrom: row.expected_from?.toISOString() ?? null,
    expectedUntil: row.expected_until?.toISOString() ?? null,
    classifiedBy: row.classified_by ?? 'rules',
    assessmentNote: row.assessment_note ?? null,
    // `e.*` above already carries the column; it is mapped explicitly because everything else on
    // this object is, and because a reader of `LiveEvent` must not have to know that a model event
    // is the `unverified` one whose indicators happened to say so. COALESCE guards the one window
    // in which the column can be missing: a server binary that has this mapper but is talking to a
    // database where migration 041 has not run yet. `deterministic` is the safe answer there — it
    // under-claims nothing, it only omits a disclosure the database cannot yet make.
    origin: row.origin ?? 'deterministic',
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

/**
 * The dialog behind one marker — the same event {@link liveThreats} is drawing, and therefore the
 * same slice.
 *
 * All FOUR reads carry the cutoff, not just the event's own existence. The event row gets the
 * identical as-of-cutoff projection `liveThreats` applies, because otherwise the map draws an
 * «активна загроза» polygon while the dialog opened from it reports `status: 'withdrawn'` and an
 * `ended_at` — an early all-clear read straight off a public endpoint, and two public endpoints
 * contradicting each other about one event inside one slice. `event_updates` is the same leak in
 * prose: web/app.js renders it as «Історія змін … стан: відкликано». Evidence and district
 * membership are held for the reason `migrations/022_publication_runtime.sql` states — a district is
 * a polygon and an icon stack, and a source message is the verbatim text of a report that has not
 * been published yet.
 *
 * The evidence bound is `ee.attached_at`, i.e. when WE attached it, never `sm.published_at`, which
 * is the publisher's own declared time and would walk straight past any hold on a back-dated post —
 * the same reasoning `/api/v1/history` gives for gating `created_at` and never `started_at`.
 *
 * In `live` mode the cutoff is `now()`, every added predicate is true for every visible row, the
 * CASE is a no-op, and the four statements are the ones that were here before.
 */
export async function threatDetails(id: string, cutoff: Date) {
  const event = await pool.query(
    // An event created after the cutoff does not exist yet as far as a public reader is concerned;
    // the `null` return is already the route's 404, so the hold and "no such event" are answered
    // identically and a probe cannot distinguish them.
    //
    // `e.*` expands first and the projected columns are selected AFTER it, so node-pg's field-by-
    // field row build leaves the later duplicate in place — the same trick, and the same reason, as
    // in `liveThreats`. `actual_status` carries the raw value for /ops and for tests.
    `SELECT e.*,
      CASE WHEN e.status IN ('expired','withdrawn','corrected') AND e.ended_at > $2
           THEN 'active' ELSE e.status END                                  AS status,
      e.status                                                              AS actual_status,
      CASE WHEN e.ended_at > $2 THEN NULL ELSE e.ended_at END               AS ended_at,
      COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
        'id',l.id,'name',l.name_uk,'relationType',el.relation_type,
        'latitude',l.latitude,'longitude',l.longitude
      )) FILTER (WHERE l.id IS NOT NULL AND el.created_at <= $2),'[]') AS locations
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
       JOIN sources s ON s.id=sm.source_id WHERE ee.event_id=$1 AND ee.attached_at <= $2
       ORDER BY sm.published_at`, [id, cutoff]
    ),
    pool.query(
      `SELECT previous_status,new_status,previous_evidence_level,new_evidence_level,reason,created_at
       FROM event_updates WHERE event_id=$1 AND created_at <= $2 ORDER BY created_at`, [id, cutoff]
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
 *
 * The timeline is the THIRD query bound by the module header's «status is reported as of the cutoff»
 * rule, and the one it is easiest to miss, because here the status is not just a field — it picks
 * the title and the summary, and the terminal strings are literal all-clear prose («Офіційна тривога
 * завершена», «Зафіксовано офіційний відбій.»). Rendered verbatim in the territory panel's «Історія»
 * tab, they would announce the відбій while the sibling «Стан зараз» tab, fed by the same slice's
 * snapshot, still shows the alert running and the map still paints the polygon.
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
      `SELECT DISTINCT e.id,'threat' AS kind,e.started_at AS happened_at,e.title,e.summary,
              CASE WHEN e.status IN ('expired','withdrawn','corrected') AND e.ended_at > $3
                   THEN 'active' ELSE e.status END AS status,
              e.status AS actual_status,
              -- valid_until is left alone: it is the declared validity deadline the event carried
              -- from the moment it was published, not a terminal-transition timestamp, so it reveals
              -- nothing the reader was not already shown.
              e.threat_type,e.evidence_level,e.valid_until,
              NULL::numeric AS risk_score,NULL::text AS risk_level
       FROM threat_events e JOIN threat_event_locations el ON el.event_id=e.id
       JOIN locations target ON target.id=el.location_id WHERE ${applies}
         AND e.created_at <= $3
       ORDER BY e.started_at DESC LIMIT $2`, [related, limit, cutoff]
    ),
    pool.query(
      // The status as of the cutoff is written ONCE and read four times: the title, the summary, the
      // status and the end instant must never disagree about whether the відбій has been published,
      // and repeating the condition four times is how they drift apart. This row's `valid_until`
      // carries `ended_at`, so it is nulled while the period is still running as of the cutoff —
      // otherwise the payload leaks the very timestamp the prose is being held back from announcing.
      `SELECT a.id,'alert' AS kind,a.started_at AS happened_at,
              CASE WHEN c.active_at_cutoff THEN 'Офіційна тривога' ELSE 'Офіційна тривога завершена' END AS title,
              CASE WHEN c.active_at_cutoff THEN 'Офіційне попередження активне.' ELSE 'Зафіксовано офіційний відбій.' END AS summary,
              CASE WHEN c.active_at_cutoff THEN 'active' ELSE a.status END AS status,
              a.status AS actual_status,
              a.alert_type AS threat_type,'official' AS evidence_level,
              CASE WHEN c.active_at_cutoff THEN NULL ELSE a.ended_at END AS valid_until,
              NULL::numeric AS risk_score,NULL::text AS risk_level
       FROM alert_periods a JOIN locations target ON target.id=a.location_id
       CROSS JOIN LATERAL (SELECT a.status='active' OR (a.status='ended' AND a.ended_at > $3) AS active_at_cutoff) c
       WHERE ${applies}
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

// ------------------------------------------------------------------------------------------------
// Taking a model event back
// ------------------------------------------------------------------------------------------------

/**
 * ================================================================================================
 * Why an early exit for analytical events exists at all, and why it is a SEPARATE function
 * ================================================================================================
 *
 * The retraction path above — {@link applyRetraction} and every branch that calls it — is gated on
 * `!options.modelPromotion` (see the transit branch in {@link ingestThreat}). That gate is not a
 * limitation to be worked around: a model allowed to withdraw is a model that can take a *human*
 * source's live warning off a public map, and `CONTEXT.md` §Межі безпеки puts that outside what
 * analysis may ever do. It stays exactly as it is, and nothing below relaxes it.
 *
 * What the gate leaves behind is the opposite problem. A wrong MODEL event has exactly one exit —
 * {@link THREAT_VALIDITY_MS} elapsing and `expireThreatEvents` retiring it — so an operator watching
 * an obviously false analytical pin (a news retrospective read as a live threat, a homonym resolved
 * into the wrong oblast) has no button for up to half an hour, on a surface people read to decide
 * whether to move to a shelter.
 *
 * This function is that button, and it is deliberately not a parameter on the existing path:
 *
 *  - **The guard is a WHERE clause, not a caller's discipline.** `origin='model'` appears in the
 *    UPDATE itself, so handing this function the id of a deterministic event updates zero rows. Had
 *    the capability been added as `applyRetraction(..., { operator: true })`, the same guarantee
 *    would depend on every future edit of a 60-line function preserving one condition.
 *  - **It cannot widen.** There is no source scope, no location list and no threat-type list to get
 *    wrong: the unit of work is one event id, and the blast radius is one row plus its audit.
 *  - **It never reads or writes `threat_assertions`.** The assertion attached to a promoted event is
 *    a *human channel's* claim about a place — the model only classified it — and an operator
 *    removing the model's reading of a post does not make the post unsaid. Leaving the assertions
 *    alone is safe precisely because the event cannot come back: the merge lookup in
 *    {@link ingestThreat} matches only `status IN ('observed','confirmed','active')`, so a later
 *    message about the same place and class opens a NEW event with its own authorship rather than
 *    reviving this one.
 *  - **`alert_source_states`, `alert_periods`, `risk_signals` and `notification_outbox` are not
 *    reached from here, and no call path leads from this function to `reconcileAggregateAlert`.**
 *    The risk signals in particular are left running on their own six-hour expiry: the message was
 *    still published, and decaying its contribution would be this path editing the analytic index of
 *    an oblast, which is a second surface and a second mandate.
 *
 * **`withdrawn`, not `expired` or `corrected`.** All three are in the CHECK on `threat_events.status`
 * (migrations/001_init.sql:78) and only one of them is true. `expired` means the validity window ran
 * out and is written by `expireThreatEvents` when `valid_until <= now()`; this path fires *before*
 * that deadline by construction, so writing `expired` would state that a window elapsed while
 * `valid_until` on the same row says it has not. `corrected` means a newer message replaced this
 * event and carries a replacement id nobody has here. `withdrawn` means the claim was taken back,
 * which is exactly what happened — and it is already the word `web/app.js` renders as «відкликано»
 * and the one `liveThreats` keeps visible while `ended_at > cutoff`, so the delayed map loses the pin
 * in the same frame that explains it instead of before it.
 */
export type AnalyticalWithdrawalMode = 'operator' | 'auto_unconfirmed';

export interface AnalyticalWithdrawalRequest {
  /** Free prose for the audit row. Bounded 8..500 by the CHECK in migration 042. */
  reason: string;
  /** Ops account, or the literal `'system'` for {@link withdrawUnconfirmedAnalyticalEvents}. */
  withdrawnBy: string;
  mode?: AnalyticalWithdrawalMode;
}

/**
 * The four refusals are reported apart rather than collapsed into a boolean.
 *
 * `not_model` is the one that matters: an operator who is told only "nothing happened" learns
 * nothing about *why*, and the answer «this event was not written by the model, so this button does
 * not apply to it» is the single most important thing this surface can say. Distinguishing it from
 * `not_found` does reveal that an id exists, which every public read in this file is careful never to
 * do — but the only caller is behind `/ops` Basic auth, where the caller can already list every
 * event, and refusing to say which of two refusals happened would make the guarantee unverifiable by
 * the person responsible for it.
 */
export interface AnalyticalWithdrawalResult {
  outcome: 'withdrawn' | 'not_found' | 'not_model' | 'not_live';
  eventId: string;
  previousStatus: string | null;
  origin: ThreatOrigin | null;
  /** The `system_event_log` version the withdrawal was written at; `null` when nothing was written. */
  version: number | null;
}

/**
 * Ends one model-authored threat event early, and nothing else.
 *
 * Five statements in one transaction, in this order:
 *
 *  1. `SELECT ... FOR UPDATE` — the row is pinned so a concurrent `expireThreatEvents` sweep or a
 *     merging message cannot move the status between the check and the write. The read is what
 *     produces the *diagnosis* (`not_found` / `not_model` / `not_live`); it is not what produces the
 *     safety, which is point 2.
 *  2. `UPDATE ... WHERE id=$1 AND origin='model' AND status = ANY(live)` — the guarantee, restated in
 *     the statement that actually mutates. If the `FOR UPDATE` check above were ever deleted,
 *     reordered or refactored into a helper that forgot it, this WHERE would still update zero rows
 *     for a deterministic event. `rowCount === 0` therefore aborts the whole transaction rather than
 *     continuing to write an audit row for a change that did not happen.
 *  3. `event_updates` — the same lifecycle trail every other transition in this file leaves, so the
 *     dialog behind the marker renders «стан: відкликано» from the same table as always. The
 *     evidence level is carried across unchanged: state and evidence are different axes, and how
 *     well corroborated the claim was does not change because the claim was taken back.
 *  4. `analytical_withdrawals` — the audit (migration 042), in the SAME transaction, so «withdrawn»
 *     and «recorded as withdrawn» cannot become different sets.
 *  5. `system_event_log` — THE SEAM. Without this row the map keeps drawing the pin until the next
 *     full snapshot: SSE walks this table and nothing else. `threat.withdrawn` is reused rather than
 *     a new type invented, because every consumer already handles it correctly — `web/app.js:823`
 *     removes the marker, `analytics-scheduler.ts:67` recomputes, and `bot/outbox.ts:246` refuses to
 *     send it, which is what keeps a withdrawal from becoming a second Telegram message about a
 *     threat that no longer exists.
 *
 * **The payload carries a fixed token, never `reason` or `withdrawnBy`.** `system_event_log` is read
 * by the public `/api/v1/stream`; an operator's free-prose note ("прибрав, канал жартує") and the ops
 * account name are internal and would be published verbatim by the very act of recording them. The
 * prose lives in `analytical_withdrawals`, which no public read touches.
 */
export async function withdrawAnalyticalEvent(
  eventId: string, request: AnalyticalWithdrawalRequest
): Promise<AnalyticalWithdrawalResult> {
  const mode: AnalyticalWithdrawalMode = request.mode ?? 'operator';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ status: string; origin: ThreatOrigin; evidence_level: EvidenceLevel }>(
      `SELECT status,origin,evidence_level FROM threat_events WHERE id=$1 FOR UPDATE`, [eventId]
    );
    const row = current.rows[0];
    const refuse = (outcome: AnalyticalWithdrawalResult['outcome']): AnalyticalWithdrawalResult => ({
      outcome, eventId, previousStatus: row?.status ?? null, origin: row?.origin ?? null, version: null
    });
    if (!row) {
      await client.query('ROLLBACK');
      return refuse('not_found');
    }
    // The check an operator sees. The one that *holds* is in the UPDATE below.
    if (row.origin !== 'model') {
      await client.query('ROLLBACK');
      return refuse('not_model');
    }
    if (!LIVE_STATUSES.includes(row.status)) {
      await client.query('ROLLBACK');
      return refuse('not_live');
    }
    const closed = await client.query(
      `UPDATE threat_events SET status='withdrawn',ended_at=now(),updated_at=now()
        WHERE id=$1 AND origin='model' AND status = ANY($2::text[])`,
      [eventId, LIVE_STATUSES]
    );
    // Unreachable while the `FOR UPDATE` above holds the row, and deliberately handled anyway: this
    // branch is what makes the WHERE clause the guard rather than a duplicate of the check. Anything
    // that ever makes the two disagree ends as a rollback, never as an audit row without a change.
    if (!closed.rowCount) {
      await client.query('ROLLBACK');
      return refuse('not_live');
    }
    await client.query(
      `INSERT INTO event_updates(event_id,previous_status,new_status,previous_evidence_level,
         new_evidence_level,reason)
       VALUES ($1,$2,'withdrawn',$3,$3,$4)`,
      [eventId, row.status, row.evidence_level,
        mode === 'operator' ? 'operator_withdrew_analytical_event' : 'analytical_event_unconfirmed']
    );
    await client.query(
      `INSERT INTO analytical_withdrawals(event_id,previous_status,reason,withdrawn_by,mode)
       VALUES ($1,$2,$3,$4,$5)`,
      [eventId, row.status, request.reason, request.withdrawnBy, mode]
    );
    const version = await appendSystemEvent(client, 'threat.withdrawn', {
      eventId,
      reason: mode === 'operator' ? 'operator_withdrew_analytical_event' : 'analytical_event_unconfirmed'
    });
    await client.query('COMMIT');
    return { outcome: 'withdrawn', eventId, previousStatus: row.status, origin: 'model', version };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The reason a promoted event is closed by the sweep, in the audit row. A constant rather than prose
 * at the call site so that every unattended withdrawal in the table reads identically and an operator
 * can tell the sweep's rows from a human's by the text alone, not only by `mode`.
 */
const UNCONFIRMED_CLOSE_REASON =
  'Автоматичне закриття: аналітична подія простояла без підтвердження жодним джерелом.';

/**
 * Closes model events that stood their configured time and that nothing corroborated.
 *
 * The case this exists for is the one an operator cannot be relied on to catch: a model whose
 * calibration has drifted produces a steady drip of plausible-looking pins at three in the morning,
 * each individually below the threshold of "obviously wrong" and collectively the thing that turns
 * the unverified layer from a residue into what the map mostly shows. Nobody presses a button per
 * pin at that hour.
 *
 * **Corroboration is the absence of a non-model evidence row, and that is a deliberate choice of
 * definition.** `event_evidence.evidence_role` carries the bare independence group for a
 * deterministic message and `model:<group>` for a promotion ({@link ingestThreat}), so a row that is
 * NOT `model:%` means a message the deterministic rules themselves accepted has since been attached
 * to this event — a human channel said the same thing about the same place inside the merge window.
 * That is the identical exclusion the `two_independent_tier_a_or_b_sources` promotion above uses,
 * which is the point: one definition of "somebody else said this too", not two that can drift.
 * `evidence_level <> 'unverified'` is checked as well, because an official or Tier B merge raises it
 * and the two conditions must never be able to disagree about the same row.
 *
 * **Off unless configured.** `minutes <= 0` returns immediately without touching the database — this
 * function makes a published pin disappear sooner than a reader was told it would, so the shipped
 * default (`ANALYTICAL_UNCONFIRMED_CLOSE_MINUTES`, `src/config.ts`) is 0 and switching it on is a
 * deliberate act. A threshold above {@link THREAT_VALIDITY_MS} would be a no-op — `expireThreatEvents`
 * already retires the row at `valid_until` — so config bounds it below that.
 *
 * The clock is `created_at`, never `started_at`. `started_at` is the publisher's declared time and a
 * back-dated post would make an event "already overdue" the instant it was created; `created_at` is
 * when WE put it on the map, which is what "стояла N хвилин" means to the person reading it.
 *
 * Each candidate goes through {@link withdrawAnalyticalEvent} rather than through a bulk UPDATE, so
 * there is exactly ONE statement in this codebase that can end a model event and exactly one place
 * where `origin='model'` has to be true. A batch UPDATE here would be faster and would be a second
 * place to get the guard wrong. The candidate list is bounded so one pass cannot emit an unbounded
 * number of SSE frames.
 */
export const UNCONFIRMED_CLOSE_BATCH_SIZE = 50;

export async function withdrawUnconfirmedAnalyticalEvents(
  minutes = config.ANALYTICAL_UNCONFIRMED_CLOSE_MINUTES,
  limit = UNCONFIRMED_CLOSE_BATCH_SIZE
): Promise<AnalyticalWithdrawalResult[]> {
  if (minutes <= 0) return [];
  const candidates = await pool.query<{ id: string }>(
    `SELECT e.id FROM threat_events e
      WHERE e.origin='model'
        AND e.status = ANY($1::text[])
        AND e.evidence_level='unverified'
        AND e.created_at <= now() - ($2::text || ' minutes')::interval
        AND NOT EXISTS (
          SELECT 1 FROM event_evidence ee
           WHERE ee.event_id=e.id AND ee.evidence_role NOT LIKE 'model:%'
        )
      ORDER BY e.created_at
      LIMIT $3`,
    [LIVE_STATUSES, String(minutes), limit]
  );
  const results: AnalyticalWithdrawalResult[] = [];
  for (const candidate of candidates.rows) {
    results.push(await withdrawAnalyticalEvent(candidate.id, {
      reason: UNCONFIRMED_CLOSE_REASON, withdrawnBy: 'system', mode: 'auto_unconfirmed'
    }));
  }
  return results;
}
