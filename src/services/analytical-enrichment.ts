import { config } from '../config.js';
import { pool } from '../db/pool.js';
import type { LocationLexeme } from '../domain/classifier.js';
import { resolveModelPlace } from '../domain/model-place.js';
import { THREAT_TYPES, type ThreatType } from '../types.js';

/**
 * What the model read on a message the rules ALREADY published, and the reasons it stops there.
 *
 * ## The gap
 *
 * Promotion (migration 040, `./shadow-classifier.ts`) is a gap-filler by construction: the model may
 * create an event only where the deterministic rules created none. Three separate guards say so —
 * `allowAnalyticalPromotion` is set only for `ignored`/`unrecognized` decisions
 * (`./ingestion.ts`), `promoteAnalyticalThreat` exits when the deterministic verdict turned out
 * significant, and `ingestThreat` answers `published:false` when an event of the same class already
 * stands over the same place (`../repositories/events.ts`).
 *
 * Everything the model sees BEYOND what was published therefore goes nowhere. The rules raise the
 * event on «Шахеди на Полтавщину»; the same post says «курс на Кременчук» and names a sharper class,
 * the model reads both, and neither the event nor `/ops` records it — the shadow reading list shows
 * *disagreements*, and on a published message the two sides usually agree. The extra reading is not
 * a disagreement. It is an addition, and additions had no home.
 *
 * ## What this module may do, and what it structurally cannot
 *
 * It writes one row per addition into `analytical_enrichments` (migration 045) and issues no other
 * statement of any kind. That is the whole safety argument, and it is checkable by reading the SQL
 * in {@link recordAnalyticalEnrichments}: there is exactly one, it is an `INSERT` into that table,
 * and everything else it touches it touches in a `WHERE`.
 *
 * Consequences, each of which has a test of its own in `./analytical-enrichment.test.ts`:
 *
 *  - **Evidence never moves.** `threat_events.evidence_level` is read as a guard and copied as a
 *    snapshot; there is no `UPDATE` here to raise it with.
 *  - **Validity never moves.** The strings `valid_until` and `last_observed_at` do not appear in this
 *    file. A model remark cannot keep a human source's warning standing one minute past what that
 *    source vouched for.
 *  - **Nobody is notified.** `decideThreatNotification` (`../bot/notification-policy.ts`) is driven by
 *    a snapshot of the event: `geographyKey` over `threat_event_locations` and `evidenceRank` over
 *    `evidence_level`. This module writes neither, and it appends nothing to `system_event_log` —
 *    which is the ONLY trigger for the SSE stream and for `fanoutNewEvents` in `../bot/outbox.ts`.
 *    An enrichment is invisible to the fan-out in the same way a row in a table nobody joins is.
 *  - **An official event is untouchable.** The `INSERT` filters `evidence_level <> 'official'`, and
 *    the trigger in migration 045 refuses the row independently of this file. `CONTEXT.md`
 *    §Межі безпеки puts the official signal above analysis, and an annotation is where that stops
 *    being true quietly.
 *
 * ## Off by default, twice
 *
 * `codex_settings.analytical_enrichment_enabled` ships false, exactly like `analytical_threats`
 * before it, and it is a SEPARATE switch: an operator who has granted the model the right to publish
 * into a gap has not thereby granted it the right to annotate what the rules did publish, and the
 * two are turned off in different incidents. On top of that, nothing public reads the table — so even
 * with the switch on, what changes is one operator page and nothing a reader can see.
 */

// ------------------------------------------------------------------------------------------------
// What counts as an addition
// ------------------------------------------------------------------------------------------------

/**
 * Severity, for the one comparison this module makes with it.
 *
 * The ladder is «how much less time does a person have, and how much less can they do about it»,
 * which is the axis a reader of a public warning is actually on: mortars and artillery reach the
 * front-line strip and are heard before they are announced; MLRS and UAV give minutes; a guided air
 * bomb is a minutes-scale strike a person cannot outrun but a whole raion can hear coming; cruise
 * missiles cross oblasts; ballistics give a single-digit number of minutes and their own alert
 * language; `combined` outranks all of them because it means several of these at once, which is the
 * one class that changes what a person should do rather than only where.
 *
 * It exists ONLY to answer «is the model's class strictly more severe than the published one», and
 * the answer is recorded as a remark for a human. Nothing in this codebase reorders, prioritises,
 * escalates or notifies on it, and nothing should start: the moment a severity number decides
 * something automatically, a judgement call written once in a comment becomes operational policy.
 *
 * `unknown` is 0 so that it can never be an upgrade of anything, which matters because it is the
 * class a model answers with when it recognised nothing.
 */
const THREAT_SEVERITY: Record<ThreatType, number> = {
  unknown: 0,
  mortar: 1,
  artillery: 2,
  mlrs: 3,
  uav: 4,
  guided_air_bomb: 5,
  aviation: 6,
  cruise_missile: 7,
  ballistic_missile: 8,
  combined: 9
};

/**
 * How many extra places one message may propose.
 *
 * Not a performance bound — three rows are nothing. It is a shape bound: a verdict that names eight
 * places the rules did not find is not an enrichment of the published event, it is a model rewriting
 * the message, and the honest response to it is the shadow reading list rather than eight remarks
 * filed against somebody else's event. Truncation is deliberate and silent because the surplus is
 * evidence about the *model*, and that evidence is already whole in `shadow_classifications`.
 */
export const ENRICHMENT_MAX_LOCATIONS = 3;

/** The direction column is bounded at 500 by the CHECK in migration 045; kept identical here. */
const DIRECTION_TEXT_LIMIT = 500;

export type EnrichmentKind = 'direction' | 'additional_location' | 'threat_class';

/**
 * The part of a model verdict this module reads.
 *
 * Declared structurally rather than imported as `ShadowVerdict` from `./shadow-classifier.ts` on
 * purpose: that module CALLS this one, so importing back would be a cycle, and a verdict shape this
 * module can be tested against without loading the model client is worth more than the shared name.
 * `ShadowVerdict` satisfies it by structure, so the compiler still checks the call site.
 */
export interface EnrichmentVerdict {
  threatType: string;
  locations: string[];
  destinationLocations: string[];
  directionText: string | null;
  threatState: 'asserted' | 'redirected' | 'withdrawn' | 'uncertain';
  significant: boolean;
  confidence: number;
}

/**
 * What the deterministic rules actually published for this message — the baseline an addition is an
 * addition TO.
 *
 * Filled from the classification the pipeline already made (`../services/ingestion.ts`), not from a
 * re-read of the event: the question is «what did the rules take out of THIS message», and an event
 * that has since merged three other reports would answer a different one. The `WHERE` clauses in
 * {@link recordAnalyticalEnrichments} then re-check every addition against the event as it stands, so
 * a location another message attached in the meantime is still refused at write time.
 */
export interface PublishedClaim {
  eventId: string;
  threatType: string;
  locationIds: string[];
  directionText: string | null;
  nationalScope: boolean;
}

export interface EnrichmentDraft {
  kind: EnrichmentKind;
  /** Resolved through the production catalogue; never a name the model wrote. */
  locationId: string | null;
  threatType: string | null;
  directionText: string | null;
}

function isThreatType(value: string): value is ThreatType {
  return (THREAT_TYPES as readonly string[]).includes(value);
}

/**
 * The additions in a verdict, or an empty list.
 *
 * Pure and exported so every gate below is provable without a database or a model.
 *
 * The entry conditions are the promotion path's, deliberately and to the letter
 * (`buildAnalyticalClassification` in `./shadow-classifier.ts`): asserted or redirected, significant,
 * and at or above `ANALYTICAL_THREAT_MIN_CONFIDENCE`. Sharing the floor is the point — a verdict too
 * uncertain to create an event is too uncertain to be filed as a reading of somebody else's, and two
 * thresholds would mean an operator lowering one had silently moved the other. `withdrawn` and
 * `uncertain` states produce nothing at all: a model may never take anything back, and this path is
 * the one place where "the model said it is over" could look like harmless metadata.
 */
export function buildEnrichments(
  verdict: EnrichmentVerdict, published: PublishedClaim, lexemes: LocationLexeme[]
): EnrichmentDraft[] {
  if (!verdict.significant) return [];
  if (verdict.threatState !== 'asserted' && verdict.threatState !== 'redirected') return [];
  if (verdict.confidence < config.ANALYTICAL_THREAT_MIN_CONFIDENCE) return [];
  if (!isThreatType(verdict.threatType) || verdict.threatType === 'unknown') return [];
  const modelType = verdict.threatType;

  const drafts: EnrichmentDraft[] = [];

  // A course the source stated and the rules did not store. Only when the event carries none:
  // proposing a second direction beside an existing one is a contradiction for an operator to
  // resolve, not an addition, and the deterministic reading of the same sentence wins by default.
  const direction = (verdict.directionText ?? '').replace(/\s+/gu, ' ').trim();
  if (direction && !published.directionText?.trim()) {
    drafts.push({
      kind: 'direction', locationId: null, threatType: null,
      directionText: direction.slice(0, DIRECTION_TEXT_LIMIT)
    });
  }

  // Places the model named that the rules did not attach. Skipped entirely for a national-scope
  // event: that event already covers every oblast, so «additionally, Полтавщина» is not an addition,
  // it is a narrowing dressed as one.
  if (!published.nationalScope) {
    const known = new Set(published.locationIds);
    // Destinations first, because on a `redirected` verdict they are what the source says is being
    // approached — the half a reader needs — while `locations` on the same verdict routinely still
    // carries the place being passed. With the cap in force, order decides what survives truncation.
    const names = [...verdict.destinationLocations, ...verdict.locations];
    for (const name of names) {
      if (drafts.filter((draft) => draft.kind === 'additional_location').length >= ENRICHMENT_MAX_LOCATIONS) break;
      const place = resolveModelPlace(name, modelType, lexemes);
      if (!place || known.has(place.id)) continue;
      known.add(place.id);
      drafts.push({
        kind: 'additional_location', locationId: place.id, threatType: null, directionText: null
      });
    }
  }

  // A strictly more severe class than the one published — and never the other direction.
  //
  // A downgrade is silence for the same reason `decideThreatNotification` refuses to announce a
  // weakened evidence level: «this is less dangerous than you were told» is the one statement that
  // moves people out of shelters, and a model is not allowed to make it in any form, including as a
  // note an operator reads at three in the morning. An equal class is not an addition at all.
  if (isThreatType(published.threatType)
      && THREAT_SEVERITY[modelType] > THREAT_SEVERITY[published.threatType]) {
    drafts.push({
      kind: 'threat_class', locationId: null, threatType: modelType, directionText: null
    });
  }

  return drafts;
}

// ------------------------------------------------------------------------------------------------
// The write
// ------------------------------------------------------------------------------------------------

export interface EnrichmentTarget {
  eventId: string;
  /** The message both sides read; with `classifierVersion` it is the key of the shadow audit row. */
  sourceMessageId: string;
  classifierVersion: string;
  model: string;
  confidence: number;
}

export interface EnrichmentWriteResult {
  recorded: number;
  /** Drafts the event itself refused: already known, official, model-authored, or no longer live. */
  refused: number;
}

/** Test seam. Production passes nothing and the module talks to the shared pool. */
export interface EnrichmentWriteOptions {
  query?: (text: string, values: unknown[]) => Promise<{ rowCount: number | null }>;
}

/**
 * THE ONLY STATEMENT THIS MODULE ISSUES.
 *
 * Written as `INSERT ... SELECT ... FROM threat_events` rather than as a read followed by an insert,
 * and that is not a round-trip optimisation. Every guard below is then evaluated by the database
 * against the row being annotated, inside the same statement that writes — so there is no window in
 * which an event stops being live, is merged into an official one, or gains the very location being
 * proposed, between the check and the write. A caller cannot skip a guard by calling this function
 * differently, because there is no argument that switches one off.
 *
 * The guards, in the order they appear:
 *
 *  - `evidence_level <> 'official'` — an official event is out of reach. Restated by the trigger in
 *    migration 045, which refuses the row even for a writer that is not this file.
 *  - `origin='deterministic'` — an event the MODEL created cannot be annotated by the model. It is
 *    already an unverified model claim; a second model reading stacked on it is one opinion shown
 *    twice, and `/ops` would read it as two marks.
 *  - `status IN ('observed','confirmed','active')` — a remark about a withdrawn or expired event is
 *    noise in the one list an operator reads to catch a drifting model. It also drops enrichment for
 *    the replay path without a flag of its own: a backfilled message outside its own validity window
 *    creates its event already `expired` (`../repositories/events.ts`).
 *  - the three per-kind clauses — the addition must still be an addition **as the event stands now**,
 *    not as the message read. A location another source attached two minutes ago, a direction the
 *    rules have since written, a class the event has since been raised to: each is refused here, and
 *    `refused` counts them.
 *
 * `event_threat_type` and `event_evidence_level` are selected from the event row itself, so the
 * snapshot a human reads later cannot disagree with what was published — the trigger re-reads the
 * event and rejects the row if it does.
 *
 * `ON CONFLICT DO NOTHING` against `idx_analytical_enrichments_once`: `shadowClassify` is
 * fire-and-forget and a message re-read after a collector restart runs this path again.
 */
const INSERT_ENRICHMENT = `
  INSERT INTO analytical_enrichments(
    event_id,source_message_id,classifier_version,model,confidence,
    kind,location_id,threat_type,direction_text,event_threat_type,event_evidence_level)
  SELECT e.id,$2::uuid,$3::text,$4::text,$5::numeric,$6::text,$7::text,$8::text,$9::text,
         e.threat_type,e.evidence_level
    FROM threat_events e
   WHERE e.id=$1::uuid
     AND e.evidence_level <> 'official'
     AND e.origin = 'deterministic'
     AND e.status IN ('observed','confirmed','active')
     AND ($6::text <> 'additional_location' OR NOT EXISTS (
           SELECT 1 FROM threat_event_locations el
            WHERE el.event_id=e.id AND el.location_id=$7::text))
     AND ($6::text <> 'threat_class' OR e.threat_type <> $8::text)
     AND ($6::text <> 'direction' OR e.direction_text IS NULL)
  ON CONFLICT DO NOTHING`;

/**
 * Files each draft, and reports how many the event accepted.
 *
 * One statement per draft rather than a multi-row insert: the per-kind guards differ, a single
 * statement would have to fold them into a CASE over every row, and «this remark was refused because
 * the event already has that district» is exactly the outcome that must stay distinguishable from
 * «written». The count of drafts is at most {@link ENRICHMENT_MAX_LOCATIONS} + 2.
 *
 * Never throws for a refused row — a refusal is a zero `rowCount`, which is the normal case. A
 * genuine database failure does propagate, and the caller in `./shadow-classifier.ts` swallows it
 * like every other model-path failure: an enrichment is the least important thing in the process.
 */
export async function recordAnalyticalEnrichments(
  target: EnrichmentTarget, drafts: readonly EnrichmentDraft[], options: EnrichmentWriteOptions = {}
): Promise<EnrichmentWriteResult> {
  if (!drafts.length) return { recorded: 0, refused: 0 };
  const query = options.query
    ?? ((text: string, values: unknown[]) => pool.query(text, values) as Promise<{ rowCount: number | null }>);
  let recorded = 0;
  for (const draft of drafts) {
    const result = await query(INSERT_ENRICHMENT, [
      target.eventId, target.sourceMessageId, target.classifierVersion, target.model,
      target.confidence, draft.kind, draft.locationId, draft.threatType, draft.directionText
    ]);
    if (result.rowCount) recorded += 1;
  }
  return { recorded, refused: drafts.length - recorded };
}

// ------------------------------------------------------------------------------------------------
// What /ops reads
// ------------------------------------------------------------------------------------------------

export interface EnrichmentReport {
  windowHours: number;
  total: number;
  byKind: Array<{ kind: string; count: number }>;
  recent: Array<{
    id: string;
    eventId: string;
    recordedAt: string;
    kind: EnrichmentKind;
    model: string;
    confidence: number;
    /** What the rules published, as it stood when the remark was filed. */
    event: { title: string; threatType: string; evidenceLevel: string };
    locationId: string | null;
    locationName: string | null;
    threatType: string | null;
    directionText: string | null;
    /** The audit root: the message both sides read, for the shadow row and the raw text. */
    sourceMessageId: string;
  }>;
}

/**
 * The reading list, and the only reader of this table in the codebase.
 *
 * Deliberately shaped like {@link file://./shadow-classifier.ts} `shadowAgreement`: a window, a
 * total, a breakdown and the newest examples. The two answer neighbouring questions — «where do the
 * rules and the model disagree» and «what does the model see that the rules do not write down» — and
 * an operator moves between them, so they should not need two mental models.
 *
 * The window is bounded by the caller (`../api/ops-codex-routes.ts`) because both queries reach a
 * table that grows with published events, behind a route a human refreshes by hand.
 *
 * Nothing here writes, and nothing here is reachable from a public route. Publishing enrichments
 * would be a new read path and a decision somebody has to take deliberately; it is not this one.
 */
export async function enrichmentReport(windowHours = 24, examples = 20): Promise<EnrichmentReport> {
  const totals = await pool.query<{ kind: string; count: number }>(
    `SELECT kind, count(*)::int AS count
       FROM analytical_enrichments
      WHERE recorded_at > now() - ($1 || ' hours')::interval
      GROUP BY kind ORDER BY count DESC`,
    [String(windowHours)]
  );
  const recent = await pool.query(
    `SELECT en.id,en.event_id,en.recorded_at,en.kind,en.model,en.confidence,
            en.location_id,en.threat_type,en.direction_text,en.source_message_id,
            en.event_threat_type,en.event_evidence_level,
            l.name_uk AS location_name, e.title AS event_title
       FROM analytical_enrichments en
       LEFT JOIN locations l ON l.id=en.location_id
       JOIN threat_events e ON e.id=en.event_id
      WHERE en.recorded_at > now() - ($1 || ' hours')::interval
      ORDER BY en.recorded_at DESC LIMIT $2`,
    [String(windowHours), examples]
  );
  return {
    windowHours,
    total: totals.rows.reduce((sum, row) => sum + row.count, 0),
    byKind: totals.rows,
    recent: recent.rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      recordedAt: new Date(row.recorded_at).toISOString(),
      kind: row.kind,
      model: row.model,
      confidence: Number(row.confidence),
      event: {
        title: row.event_title,
        threatType: row.event_threat_type,
        evidenceLevel: row.event_evidence_level
      },
      locationId: row.location_id ?? null,
      locationName: row.location_name ?? null,
      threatType: row.threat_type ?? null,
      directionText: row.direction_text ?? null,
      sourceMessageId: row.source_message_id
    }))
  };
}
