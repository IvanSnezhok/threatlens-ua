import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

/**
 * Covers `src/services/analytics-archive.ts` — the analytical slices over the classification archive
 * — against a hand-built corpus whose every number is checkable by hand.
 *
 * The corpus is written straight into `message_classifications`, `message_classification_locations`
 * and `threat_assertions` rather than driven through `processMessage`, for one reason the ingestion
 * path cannot give: it spans two months and two classifier versions. Version splitting is the whole
 * point of this feature — an improvement to `src/domain/classifier.ts` must never read as a change
 * in enemy tactics — and it cannot be tested on data that only ever carries one version stamped
 * "now". The last describe block closes that gap from the other side by running the same slices over
 * rows the production pipeline wrote.
 *
 * ## The corpus
 *
 * January (the comparison window): Poltava oblast reported twice for one drone event, Kharkiv city
 * once for a ballistic one, one meme.
 *
 * February (the window under test): Kharkiv oblast reported by all three monitors for one drone
 * event and stood down an hour later by the monitor that raised it; a ballistic event over Kharkiv
 * city; a drone event over Poltava that ends in a withdrawal; a country-wide ballistic warning; and
 * three messages that raised nothing, one per reason.
 *
 * February again under `v2`: three of the same messages re-judged, two of which `v1` had discarded.
 */

const WAR = 'osint-war-monitor';
const ERADAR = 'osint-eradar';
const AERIS = 'osint-aeris-rimor';
const POLTAVA = 'ua-53';
const KHARKIV = 'ua-63';
const KHARKIV_CITY = 'ua-city-kharkiv';
const COUNTRY = 'ua';

const FEBRUARY = { from: '2026-02-01T00:00:00Z', to: '2026-03-01T00:00:00Z' };

interface ClassificationSeed {
  key: string;
  source: string;
  at: string;
  decision: string;
  version?: string;
  intent?: string;
  createdEvent?: boolean;
  ignoredReason?: string | null;
  threatType?: string | null;
  candidates?: string[];
  indicators?: string[];
  national?: boolean;
  event?: string | null;
  asserted?: Array<[string, string]>;
  retracted?: string[];
  withdrawnAssertions?: number | null;
}

interface AssertionSeed {
  event: string;
  source: string;
  location: string;
  threatType: string;
  assertedAt: string;
  assertedBy: string;
  withdrawnAt?: string;
  withdrawnBy?: string;
}

const EVENTS: Array<{ key: string; threatType: string; status: string; evidence: string; startedAt: string }> = [
  { key: 'E1', threatType: 'uav', status: 'observed', evidence: 'monitoring', startedAt: '2026-01-10T20:00:00Z' },
  { key: 'E2', threatType: 'ballistic_missile', status: 'observed', evidence: 'monitoring', startedAt: '2026-01-15T21:00:00Z' },
  { key: 'E3', threatType: 'uav', status: 'observed', evidence: 'confirmed', startedAt: '2026-02-05T20:00:00Z' },
  { key: 'E4', threatType: 'ballistic_missile', status: 'observed', evidence: 'monitoring', startedAt: '2026-02-06T02:00:00Z' },
  { key: 'E5', threatType: 'uav', status: 'withdrawn', evidence: 'monitoring', startedAt: '2026-02-10T23:00:00Z' },
  { key: 'E6', threatType: 'ballistic_missile', status: 'observed', evidence: 'monitoring', startedAt: '2026-02-15T05:00:00Z' }
];

const CLASSIFICATIONS: ClassificationSeed[] = [
  // ---- January -------------------------------------------------------------------------------
  { key: 'J1', source: WAR, at: '2026-01-10T20:00:00Z', decision: 'event_created', createdEvent: true, threatType: 'uav', candidates: ['uav'], event: 'E1', asserted: [[POLTAVA, 'explicit_threat']] },
  { key: 'J2', source: ERADAR, at: '2026-01-10T20:05:00Z', decision: 'event_merged', threatType: 'uav', candidates: ['uav'], event: 'E1', asserted: [[POLTAVA, 'explicit_threat']] },
  { key: 'J3', source: WAR, at: '2026-01-15T21:00:00Z', decision: 'event_created', createdEvent: true, threatType: 'ballistic_missile', candidates: ['ballistic_missile'], event: 'E2', asserted: [[KHARKIV_CITY, 'explicit_threat']] },
  { key: 'J4', source: AERIS, at: '2026-01-20T22:00:00Z', decision: 'unrecognized', intent: 'none', ignoredReason: 'not_an_assertion', threatType: null, candidates: [] },

  // ---- February, classifier v1 ----------------------------------------------------------------
  { key: 'F1', source: WAR, at: '2026-02-05T20:00:00Z', decision: 'event_created', createdEvent: true, threatType: 'uav', candidates: ['uav'], event: 'E3', asserted: [[KHARKIV, 'explicit_threat']] },
  { key: 'F2', source: ERADAR, at: '2026-02-05T20:03:00Z', decision: 'event_merged', threatType: 'uav', candidates: ['uav'], event: 'E3', asserted: [[KHARKIV, 'explicit_threat']] },
  { key: 'F3', source: AERIS, at: '2026-02-05T20:10:00Z', decision: 'event_merged', threatType: 'uav', candidates: ['uav'], event: 'E3', asserted: [[KHARKIV, 'reported_direction']] },
  { key: 'F9', source: WAR, at: '2026-02-05T21:00:00Z', decision: 'de_escalation', intent: 'de_escalation', threatType: null, candidates: [], retracted: [KHARKIV], withdrawnAssertions: 1 },
  { key: 'F4', source: WAR, at: '2026-02-06T02:00:00Z', decision: 'event_created', createdEvent: true, threatType: 'ballistic_missile', candidates: ['ballistic_missile', 'cruise_missile'], indicators: ['зліт стратегічної авіації'], event: 'E4', asserted: [[KHARKIV_CITY, 'explicit_threat']] },
  { key: 'F5', source: ERADAR, at: '2026-02-10T23:00:00Z', decision: 'event_created', createdEvent: true, threatType: 'uav', candidates: ['uav'], event: 'E5', asserted: [[POLTAVA, 'explicit_threat']] },
  { key: 'F11', source: ERADAR, at: '2026-02-11T00:00:00Z', decision: 'de_escalation', intent: 'de_escalation', threatType: null, candidates: [], retracted: [POLTAVA], withdrawnAssertions: 1 },
  { key: 'F6', source: AERIS, at: '2026-02-12T01:00:00Z', decision: 'ignored', ignoredReason: 'no_location', threatType: 'uav', candidates: ['uav'] },
  { key: 'F7', source: WAR, at: '2026-02-12T01:30:00Z', decision: 'unrecognized', intent: 'none', ignoredReason: 'not_an_assertion', threatType: null, candidates: [] },
  { key: 'F8', source: ERADAR, at: '2026-02-13T03:00:00Z', decision: 'coalesced', ignoredReason: 'restated_within_coalesce_window', threatType: 'uav', candidates: ['uav'] },
  { key: 'F10', source: WAR, at: '2026-02-15T05:00:00Z', decision: 'event_created', createdEvent: true, threatType: 'ballistic_missile', candidates: ['ballistic_missile'], indicators: ['активність МіГ-31К'], national: true, event: 'E6' },

  // ---- February, classifier v2: the same three messages, re-judged -----------------------------
  // F1 unchanged, F6 promoted from "recognised something that is nowhere" to an event, F7 promoted
  // from "recognised nothing". Two of the three are what a classifier improvement actually looks
  // like in this archive.
  { key: 'F1', source: WAR, at: '2026-02-05T20:00:00Z', version: 'v2', decision: 'event_created', createdEvent: true, threatType: 'uav', candidates: ['uav'], event: 'E3', asserted: [[KHARKIV, 'explicit_threat']] },
  { key: 'F6', source: AERIS, at: '2026-02-12T01:00:00Z', version: 'v2', decision: 'event_created', createdEvent: true, threatType: 'uav', candidates: ['uav'], event: 'E5', asserted: [[POLTAVA, 'explicit_threat']] },
  { key: 'F7', source: WAR, at: '2026-02-12T01:30:00Z', version: 'v2', decision: 'event_created', createdEvent: true, threatType: 'uav', candidates: ['uav'], event: 'E5', asserted: [[POLTAVA, 'explicit_threat']] }
];

const ASSERTIONS: AssertionSeed[] = [
  { event: 'E1', source: WAR, location: POLTAVA, threatType: 'uav', assertedAt: '2026-01-10T20:00:00Z', assertedBy: 'J1' },
  { event: 'E3', source: WAR, location: KHARKIV, threatType: 'uav', assertedAt: '2026-02-05T20:00:00Z', assertedBy: 'F1', withdrawnAt: '2026-02-05T21:00:00Z', withdrawnBy: 'F9' },
  { event: 'E3', source: ERADAR, location: KHARKIV, threatType: 'uav', assertedAt: '2026-02-05T20:03:00Z', assertedBy: 'F2' },
  { event: 'E4', source: WAR, location: KHARKIV_CITY, threatType: 'ballistic_missile', assertedAt: '2026-02-06T02:00:00Z', assertedBy: 'F4' },
  { event: 'E5', source: ERADAR, location: POLTAVA, threatType: 'uav', assertedAt: '2026-02-10T23:00:00Z', assertedBy: 'F5', withdrawnAt: '2026-02-11T00:00:00Z', withdrawnBy: 'F11' }
];

const eventIds = new Map<string, string>();
const messageIds = new Map<string, string>();

async function seedCorpus(): Promise<void> {
  eventIds.clear();
  messageIds.clear();

  for (const event of EVENTS) {
    const row = await sql<{ id: string }>(
      `INSERT INTO threat_events(threat_type,status,evidence_level,title,summary,started_at,last_observed_at,valid_until)
       VALUES ($1,$2,$3,$4,$4,$5,$5,$5::timestamptz+interval '30 minutes') RETURNING id`,
      [event.threatType, event.status, event.evidence, `Fixture ${event.key}`, event.startedAt]
    );
    eventIds.set(event.key, row.rows[0]!.id);
  }

  for (const seed of CLASSIFICATIONS) {
    let messageId = messageIds.get(seed.key);
    if (!messageId) {
      const row = await sql<{ id: string }>(
        `INSERT INTO source_messages(source_id,external_id,published_at,raw_text,content_hash,processing_status)
         VALUES ($1,$2,$3,$4,$5,'processed') RETURNING id`,
        [seed.source, `fixture-${seed.key}`, seed.at, `fixture ${seed.key}`, `hash-${seed.key}`]
      );
      messageId = row.rows[0]!.id;
      messageIds.set(seed.key, messageId);
    }
    const inserted = await sql<{ id: string }>(
      `INSERT INTO message_classifications(source_message_id,source_id,classifier_version,published_at,
         decision,intent,created_event,ignored_reason,threat_type,candidate_threat_types,indicators,
         national_scope,event_id,retraction_coverage,retracted_threat_types,withdrawn_assertions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [
        messageId, seed.source, seed.version ?? 'v1', seed.at, seed.decision,
        seed.intent ?? (seed.decision === 'de_escalation' ? 'de_escalation' : 'threat'),
        seed.createdEvent ?? false, seed.ignoredReason ?? null, seed.threatType ?? null,
        seed.candidates ?? [], seed.indicators ?? [], seed.national ?? false,
        seed.event ? eventIds.get(seed.event) : null,
        seed.retracted?.length ? 'located' : null,
        seed.retracted?.length ? ['uav'] : null,
        seed.withdrawnAssertions ?? null
      ]
    );
    const classificationId = inserted.rows[0]!.id;
    for (const [locationId, relation] of seed.asserted ?? []) {
      await sql(
        `INSERT INTO message_classification_locations(classification_id,location_id,role,relation_type)
         VALUES ($1,$2,'asserted',$3)`, [classificationId, locationId, relation]
      );
    }
    for (const locationId of seed.retracted ?? []) {
      await sql(
        `INSERT INTO message_classification_locations(classification_id,location_id,role,relation_type)
         VALUES ($1,$2,'retracted',NULL)`, [classificationId, locationId]
      );
    }
  }

  for (const assertion of ASSERTIONS) {
    await sql(
      `INSERT INTO threat_assertions(event_id,source_id,independence_group,location_id,threat_type,
         asserted_at,asserted_message_id,valid_until,withdrawn_at,withdrawn_message_id,withdrawal_reason)
       VALUES ($1,$2,$2,$3,$4,$5,$6,$5::timestamptz+interval '30 minutes',$7,$8,$9)`,
      [
        eventIds.get(assertion.event), assertion.source, assertion.location, assertion.threatType,
        assertion.assertedAt, messageIds.get(assertion.assertedBy),
        assertion.withdrawnAt ?? null,
        assertion.withdrawnBy ? messageIds.get(assertion.withdrawnBy) : null,
        assertion.withdrawnAt ? 'de_escalation' : null
      ]
    );
  }
}

async function service() {
  return import('../../src/services/analytics-archive.js');
}

async function februaryWindow(overrides: Record<string, unknown> = {}) {
  const { resolveWindow } = await service();
  return resolveWindow({ ...FEBRUARY, bucket: 'month', classifierVersions: ['v1'], ...overrides });
}

describe.skipIf(!integrationDatabaseAvailable)('analytics over the classification archive', () => {
  beforeAll(async () => { await ensureMigrated(); });
  beforeEach(async () => {
    await resetDatabase();
    const { resetAnalyticsCaches } = await service();
    resetAnalyticsCaches();
    await seedCorpus();
  });

  // ----------------------------------------------------------------------------------------------
  describe('window handling', () => {
    it('refuses an unbounded window instead of scanning the archive', async () => {
      const { resolveWindow, MAX_WINDOW_DAYS } = await service();
      expect(() => resolveWindow({ from: '2020-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }))
        .toThrowError(/must not exceed/);
      expect(MAX_WINDOW_DAYS).toBe(400);
    });

    it('picks a bucket that matches the window length', async () => {
      const { resolveWindow } = await service();
      expect(resolveWindow({ from: '2026-02-01T00:00:00Z', to: '2026-02-08T00:00:00Z' }).bucket).toBe('day');
      expect(resolveWindow({ from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z' }).bucket).toBe('week');
      expect(resolveWindow({ from: '2025-06-01T00:00:00Z', to: '2026-03-01T00:00:00Z' }).bucket).toBe('month');
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('coverage', () => {
    it('reports each classifier version with its own span', async () => {
      const { archiveCoverage } = await service();
      const coverage = await archiveCoverage();
      expect(coverage.versions).toEqual([
        expect.objectContaining({
          classifierVersion: 'v1', messages: 15, sources: 3,
          firstPublishedAt: '2026-01-10T20:00:00.000Z', lastPublishedAt: '2026-02-15T05:00:00.000Z'
        }),
        expect.objectContaining({
          classifierVersion: 'v2', messages: 3, sources: 2,
          firstPublishedAt: '2026-02-05T20:00:00.000Z', lastPublishedAt: '2026-02-12T01:30:00.000Z'
        })
      ]);
      // Both versions judged February, so a February window can be compared like for like — which is
      // exactly the condition every other slice checks before it calls a comparison safe.
      expect(coverage.overlappingVersions).toEqual(['v1', 'v2']);
      expect(coverage.messages).toBe(18);
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('threat type dynamics', () => {
    it('counts messages, new events and touched events per class', async () => {
      const { threatTypeDynamics } = await service();
      const result = await threatTypeDynamics(await februaryWindow());
      expect(result.series).toEqual([
        { bucket: '2026-02-01', classifierVersion: 'v1', threatType: 'ballistic_missile', messages: 2, eventsRaised: 2, events: 2 },
        { bucket: '2026-02-01', classifierVersion: 'v1', threatType: 'uav', messages: 4, eventsRaised: 2, events: 2 }
      ]);
      expect(result.withoutGeography).toBe(0);
    });

    it('breaks the same series out by oblast, rolling a city up to its region', async () => {
      const { threatTypeDynamics } = await service();
      const result = await threatTypeDynamics(await februaryWindow());
      expect(result.byOblast).toEqual([
        // The ballistic event is filed against Kharkiv *city*; it lands under the oblast only because
        // the rollup walks `parent_id`.
        { bucket: '2026-02-01', classifierVersion: 'v1', threatType: 'ballistic_missile', oblastId: COUNTRY, oblastName: 'Україна', messages: 1, eventsRaised: 1, events: 1 },
        { bucket: '2026-02-01', classifierVersion: 'v1', threatType: 'ballistic_missile', oblastId: KHARKIV, oblastName: 'Харківська область', messages: 1, eventsRaised: 1, events: 1 },
        { bucket: '2026-02-01', classifierVersion: 'v1', threatType: 'uav', oblastId: POLTAVA, oblastName: 'Полтавська область', messages: 1, eventsRaised: 1, events: 1 },
        { bucket: '2026-02-01', classifierVersion: 'v1', threatType: 'uav', oblastId: KHARKIV, oblastName: 'Харківська область', messages: 3, eventsRaised: 1, events: 1 }
      ]);
    });

    it('separates the two classifier versions instead of adding them together', async () => {
      const { threatTypeDynamics } = await service();
      const result = await threatTypeDynamics(await februaryWindow({ classifierVersions: null }));
      const uav = result.series.filter((point) => point.threatType === 'uav');
      expect(uav).toEqual([
        { bucket: '2026-02-01', classifierVersion: 'v1', threatType: 'uav', messages: 4, eventsRaised: 2, events: 2 },
        { bucket: '2026-02-01', classifierVersion: 'v2', threatType: 'uav', messages: 3, eventsRaised: 3, events: 2 }
      ]);
      expect(result.versionSafety.versionsInWindow).toEqual(['v1', 'v2']);
      expect(result.versionSafety.splitByVersion).toBe(true);
      expect(result.versionSafety.comparable).toBe(false);
      expect(result.versionSafety.notes.join(' ')).toContain('2 версії класифікатора');
    });

    it('narrows to one oblast without leaving an all-Ukraine total beside it', async () => {
      const { threatTypeDynamics } = await service();
      const result = await threatTypeDynamics(await februaryWindow({ oblastId: KHARKIV }));
      expect(result.byOblast.every((row) => row.oblastId === KHARKIV)).toBe(true);
      expect(result.series).toEqual([
        { bucket: '2026-02-01', classifierVersion: 'v1', threatType: 'ballistic_missile', messages: 1, eventsRaised: 1, events: 1 },
        { bucket: '2026-02-01', classifierVersion: 'v1', threatType: 'uav', messages: 3, eventsRaised: 1, events: 1 }
      ]);
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('geography shift', () => {
    it('ranks oblasts against the immediately preceding window', async () => {
      const { geographyShift } = await service();
      const result = await geographyShift(await februaryWindow());
      expect(result.previousWindow).toEqual({ from: '2026-01-04T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' });
      expect(result.rows.map((row) => ({
        oblast: row.oblastId, now: row.current.eventsRaised, before: row.previous.eventsRaised,
        delta: row.deltaEventsRaised, trend: row.trend, rank: row.current.rank, rankBefore: row.previous.rank
      }))).toEqual([
        // A country-wide warning is geography too: it is filed under `ua` rather than dropped.
        { oblast: COUNTRY, now: 1, before: 0, delta: 1, trend: 'new', rank: 2, rankBefore: null },
        { oblast: KHARKIV, now: 2, before: 1, delta: 1, trend: 'steady', rank: 1, rankBefore: 2 },
        { oblast: POLTAVA, now: 1, before: 1, delta: 0, trend: 'falling', rank: 3, rankBefore: 1 }
      ]);
      // Kharkiv doubled its events but held the same share of a bigger total; Poltava kept its single
      // event and lost half its share. Counts and shares answer different questions.
      const kharkiv = result.rows.find((row) => row.oblastId === KHARKIV)!;
      expect(kharkiv.current.share).toBe(0.5);
      expect(kharkiv.previous.share).toBe(0.5);
      const poltava = result.rows.find((row) => row.oblastId === POLTAVA)!;
      expect(poltava.deltaShare).toBe(-0.25);
    });

    it('calls the comparison version-safe only when one version covers both halves', async () => {
      const { geographyShift } = await service();
      const pinned = await geographyShift(await februaryWindow());
      expect(pinned.versionSafety.comparable).toBe(true);
      expect(pinned.versionSafety.notes).toEqual([]);

      const mixed = await geographyShift(await februaryWindow({ classifierVersions: null }));
      expect(mixed.versionSafety.comparable).toBe(false);
      expect(mixed.versionSafety.notes.join(' ')).toContain('не є версійно-безпечним');
      // v2 exists only in the current half, so the note has to name that asymmetry rather than
      // letting three extra v2 events read as enemy activity.
      expect(mixed.versionSafety.notes.join(' ')).toContain('[v1, v2]');
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('loss points', () => {
    it('aggregates where threats are taken back, and how long they stood', async () => {
      const { lossPoints } = await service();
      const result = await lossPoints(await februaryWindow());

      expect(result.byOblast.map((row) => ({ key: row.key, label: row.label, n: row.withdrawals, held: row.medianHeldSeconds }))).toEqual([
        { key: POLTAVA, label: 'Полтавська область', n: 1, held: 3600 },
        { key: KHARKIV, label: 'Харківська область', n: 1, held: 3600 }
      ]);
      expect(result.bySource.map((row) => ({ key: row.key, n: row.withdrawals, events: row.events }))).toEqual([
        { key: ERADAR, n: 1, events: 1 },
        { key: WAR, n: 1, events: 1 }
      ]);
      expect(result.byThreatType).toEqual([expect.objectContaining({
        key: 'uav', withdrawals: 2, events: 2, sources: 2, medianHeldSeconds: 3600, p90HeldSeconds: 3600
      })]);
    });

    it('reports interception as a rate over the assertions actually opened', async () => {
      const { lossPoints } = await service();
      const result = await lossPoints(await februaryWindow());
      // Four assertions opened in February, two of them later withdrawn. The January assertion is
      // outside the window and is neither numerator nor denominator.
      expect(result.interception.asserted).toBe(4);
      expect(result.interception.withdrawn).toBe(2);
      expect(result.interception.withdrawnShare).toBe(0.5);
      expect(result.interception.medianHeldSeconds).toBe(3600);
    });

    it('lists the events that ended in a stand-down rather than on their timer', async () => {
      const { lossPoints } = await service();
      const result = await lossPoints(await februaryWindow());
      expect(result.closedEvents).toEqual([expect.objectContaining({
        threatType: 'uav', lastAssertedBy: ERADAR, lastAssertedFor: POLTAVA,
        withdrawnBy: ERADAR, withdrawnFor: POLTAVA, withdrawalReason: 'de_escalation',
        heldSeconds: 3600, classifierVersion: 'v1'
      })]);
      // The Kharkiv event also lost an assertion, but a second source still holds it, so the event is
      // not `withdrawn` and does not appear. State and evidence are allowed to disagree.
      expect(result.closedEvents).toHaveLength(1);
    });

    it('refuses to guess a version for an assertion two versions judged', async () => {
      const { lossPoints } = await service();
      // Without a pinned version, the Kharkiv assertion's own message carries both v1 and v2
      // verdicts. It is reported under `classifierVersion: null` rather than credited to whichever
      // sorted first.
      const unpinned = await lossPoints(await februaryWindow({ classifierVersions: null }));
      expect(unpinned.interception.byVersion).toEqual([
        { classifierVersion: 'v1', asserted: 3, withdrawn: 1, withdrawnShare: 0.3333 },
        { classifierVersion: null, asserted: 1, withdrawn: 1, withdrawnShare: 1 }
      ]);

      // Pinning one version resolves the ambiguity: that assertion *was* judged by v1, among others.
      const pinned = await lossPoints(await februaryWindow());
      expect(pinned.interception.byVersion).toEqual([
        { classifierVersion: 'v1', asserted: 4, withdrawn: 2, withdrawnShare: 0.5 }
      ]);
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('source performance', () => {
    it('separates leading a report from following one', async () => {
      const { sourcePerformance } = await service();
      const result = await sourcePerformance(await februaryWindow());
      expect(result.rows.map((row) => ({
        source: row.sourceId, messages: row.messages, first: row.firstReports,
        followUps: row.followUps, lag: row.medianLagSeconds
      }))).toEqual([
        { source: WAR, messages: 5, first: 3, followUps: 0, lag: null },
        { source: ERADAR, messages: 4, first: 1, followUps: 1, lag: 180 },
        // Aeris never leads: on the one event it reported it was three minutes behind єРадар and ten
        // behind War Monitor.
        { source: AERIS, messages: 2, first: 0, followUps: 1, lag: 600 }
      ]);
    });

    it('counts duplication and unreadable output per source', async () => {
      const { sourcePerformance } = await service();
      const result = await sourcePerformance(await februaryWindow());
      const byId = new Map(result.rows.map((row) => [row.sourceId, row]));
      expect(byId.get(WAR)).toMatchObject({
        eventsRaised: 3, corroborations: 0, deEscalations: 1, emptyWithdrawals: 0,
        unrecognized: 1, notAnAssertion: 1, signalShare: 0.6, duplicateShare: 0, unreadableShare: 0.2
      });
      expect(byId.get(ERADAR)).toMatchObject({
        eventsRaised: 1, corroborations: 1, coalesced: 1, deEscalations: 1,
        signalShare: 0.5, duplicateShare: 0.5, unreadableShare: 0
      });
      expect(byId.get(AERIS)).toMatchObject({
        eventsRaised: 0, corroborations: 1, ignored: 1, noLocation: 1, unreadableShare: 0.5
      });
      expect(byId.get(WAR)!.tier).toBe('B');
    });

    it('keeps the leader board inside one classifier version', async () => {
      const { sourcePerformance } = await service();
      const result = await sourcePerformance(await februaryWindow({ classifierVersions: null }));
      const v2 = result.rows.filter((row) => row.classifierVersion === 'v2');
      // Under v2, Aeris' previously-ignored message raised the Poltava event first, so v2 credits it
      // with a first report v1 gives it no share of. Summing the two versions would invent a fourth
      // report of an event that happened once.
      expect(v2.map((row) => ({ source: row.sourceId, first: row.firstReports, raised: row.eventsRaised }))).toEqual([
        { source: WAR, first: 1, raised: 2 },
        { source: AERIS, first: 1, raised: 1 }
      ]);
      expect(result.versionSafety.versionsInWindow).toEqual(['v1', 'v2']);
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('classifier version comparison', () => {
    it('compares two versions only over the messages both judged', async () => {
      const { classifierVersionComparison } = await service();
      const result = await classifierVersionComparison(await februaryWindow({ classifierVersions: null }), 'v1', 'v2');
      expect(result).toMatchObject({
        sharedMessages: 3, onlyBaseline: 8, onlyCandidate: 0, sameCorpus: false, agreementRate: 0.3333
      });
      expect(result.notes.join(' ')).toContain('Корпуси не збігаються');
    });

    it('reports which decisions moved, not just that something did', async () => {
      const { classifierVersionComparison } = await service();
      const result = await classifierVersionComparison(await februaryWindow({ classifierVersions: null }), 'v1', 'v2');
      expect(result.decisionMigration).toEqual([
        { baselineDecision: 'event_created', candidateDecision: 'event_created', messages: 1, threatTypeChanged: 0 },
        { baselineDecision: 'ignored', candidateDecision: 'event_created', messages: 1, threatTypeChanged: 0 },
        { baselineDecision: 'unrecognized', candidateDecision: 'event_created', messages: 1, threatTypeChanged: 1 }
      ]);
      expect(result.totals).toEqual([
        { classifierVersion: 'v1', messages: 11, eventsRaised: 4, unreadable: 2 },
        { classifierVersion: 'v2', messages: 3, eventsRaised: 3, unreadable: 0 }
      ]);
    });

    it('rejects comparing a version with itself', async () => {
      const { classifierVersionComparison } = await service();
      await expect(classifierVersionComparison(await februaryWindow(), 'v1', 'v1')).rejects.toThrow(/different/);
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('strike composition', () => {
    it('reads every class a message matched, not only the one it was filed under', async () => {
      const { strikeComposition } = await service();
      const result = await strikeComposition(await februaryWindow());
      expect(result.composition).toEqual([
        { bucket: '2026-02-01', classifierVersion: 'v1', threatType: 'uav', messages: 4, share: 0.5714 },
        { bucket: '2026-02-01', classifierVersion: 'v1', threatType: 'ballistic_missile', messages: 2, share: 0.2857 },
        // The cruise candidate exists only in `candidate_threat_types`: the message was filed as
        // ballistic. This is the column that shows a change in strike composition.
        { bucket: '2026-02-01', classifierVersion: 'v1', threatType: 'cruise_missile', messages: 1, share: 0.1429 }
      ]);
    });

    it('surfaces launch-side indicators and the national-warning share', async () => {
      const { strikeComposition } = await service();
      const result = await strikeComposition(await februaryWindow());
      expect(result.indicators.map((row) => row.indicator).sort()).toEqual([
        'активність МіГ-31К', 'зліт стратегічної авіації'
      ]);
      expect(result.indicators.every((row) => row.messages === 1 && row.sources === 1)).toBe(true);
      expect(result.nationalScope).toEqual([
        { bucket: '2026-02-01', classifierVersion: 'v1', national: 1, located: 5, nationalShare: 0.1667 }
      ]);
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('the overview, and what it looks like with no model', () => {
    it('assembles every slice for one window', async () => {
      const { strategicOverview } = await service();
      const overview = await strategicOverview(await februaryWindow());
      expect(overview.dynamics.series).toHaveLength(2);
      expect(overview.geography.rows).toHaveLength(3);
      expect(overview.loss.interception.asserted).toBe(4);
      expect(overview.sources.rows).toHaveLength(3);
      expect(overview.composition.composition).toHaveLength(3);
      expect(overview.coverage.versions.map((version) => version.classifierVersion)).toEqual(['v1', 'v2']);
    });

    it('produces a narrative from the numbers with the model switched off', async () => {
      const { strategicOverview } = await service();
      const { narrateOverview, groundedNumbers, ungroundedNumber } = await import('../../src/services/analytics-narrative.js');
      const overview = await strategicOverview(await februaryWindow());
      const narrative = await narrateOverview(overview);

      expect(narrative.generatedBy).toBe('deterministic');
      expect(narrative.model).toBeNull();
      expect(narrative.rejectionReason).toBeNull();
      expect(narrative.facts.totals).toEqual({ messages: 6, eventsRaised: 4 });
      expect(narrative.facts.interception).toEqual({
        asserted: 4, withdrawn: 2, withdrawnPercent: 50, medianHeldMinutes: 60
      });
      expect(narrative.findings.join(' ')).toContain('Знято 2 з 4 тверджень');
      // The deterministic text is held to the same grounding rule the model's output is.
      const allowed = groundedNumbers(narrative.facts);
      for (const line of [narrative.headline, ...narrative.findings, ...narrative.caveats]) {
        expect(ungroundedNumber(line, allowed)).toBeNull();
      }
      // No model was called, so nothing was audited.
      const runs = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM ai_runs`);
      expect(Number(runs.rows[0]!.n)).toBe(0);
    });
  });

  // ----------------------------------------------------------------------------------------------
  describe('over rows the ingestion pipeline wrote', () => {
    /**
     * The same slices, on data nobody hand-placed.
     *
     * The fixture above buys exact numbers at the cost of writing the archive itself; this block
     * pays that back by running the production path — `processMessage` classifies, ingests, archives
     * and writes assertions — and checking the analytics agree with what the pipeline produced.
     */
    async function ingestNight(): Promise<void> {
      const { processMessage, resetMonitorCoalescing } = await import('../../src/services/ingestion.js');
      resetMonitorCoalescing();
      await sql(`UPDATE sources SET enabled=true WHERE adapter_type='mtproto_monitor'`);
      const texts: Array<[string, string]> = [
        [WAR, 'Шахед курсом на Полтавщину.'],
        [ERADAR, 'БпЛА на Полтавщині.'],
        [ERADAR, 'Балістика на Харків.'],
        [AERIS, 'Підбірка мемів про шахед на вечір 😂'],
        [AERIS, 'Шахед.'],
        [WAR, 'Полтавщина — відбій загрози ударних БпЛА.'],
        [ERADAR, 'Полтавщина — відбій загрози ударних БпЛА.']
      ];
      let index = 0;
      for (const [sourceId, text] of texts) {
        index += 1;
        await processMessage({
          sourceId, externalId: `pipeline-${index}`, publishedAt: new Date(), text,
          rawPayload: { channel: sourceId }
        }, { monitor: true });
      }
    }

    it('reads the live archive with the deployed classifier version', async () => {
      await resetDatabase();
      const { resetAnalyticsCaches, resolveWindow, threatTypeDynamics, lossPoints, sourcePerformance } = await service();
      resetAnalyticsCaches();
      await ingestNight();
      const { CLASSIFIER_VERSION } = await import('../../src/domain/classifier.js');

      const window = resolveWindow({ bucket: 'day' });
      const dynamics = await threatTypeDynamics(window);
      expect(dynamics.versionSafety.versionsInWindow).toEqual([CLASSIFIER_VERSION]);
      expect(dynamics.series.map((point) => ({ type: point.threatType, raised: point.eventsRaised }))).toEqual([
        { type: 'ballistic_missile', raised: 1 },
        { type: 'uav', raised: 1 }
      ]);
      expect(dynamics.byOblast.map((row) => row.oblastId).sort()).toEqual(['ua-53', 'ua-63']);

      // The Poltava drone event was raised by two monitors and stood down by both, so it is the one
      // the loss view is about; the Kharkiv ballistic event is still live.
      const loss = await lossPoints(window);
      expect(loss.closedEvents).toHaveLength(1);
      expect(loss.closedEvents[0]).toMatchObject({ threatType: 'uav', withdrawnFor: 'ua-53', classifierVersion: CLASSIFIER_VERSION });
      expect(loss.interception.withdrawn).toBeGreaterThan(0);
      expect(loss.byOblast.map((row) => row.key)).toEqual(['ua-53']);

      const sources = await sourcePerformance(window);
      const byId = new Map(sources.rows.map((row) => [row.sourceId, row]));
      expect(byId.get(WAR)).toMatchObject({ firstReports: 1, eventsRaised: 1 });
      expect(byId.get(ERADAR)).toMatchObject({ firstReports: 1, corroborations: 1 });
      // Aeris published a meme and a placeless drone report: two messages, no signal at all.
      expect(byId.get(AERIS)).toMatchObject({ messages: 2, eventsRaised: 0, unreadableShare: 1 });
    });
  });
});
