import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureMigrated, integrationDatabaseAvailable, resetDatabase, sql } from '../helpers/db.js';

/**
 * What a risk pass writes, and what it deliberately does not write any more.
 *
 * `src/services/risk.test.ts` proves the scoring and the model budget against a dispatching fake.
 * What a fake structurally cannot prove is the part this file exists for: that a pass which changes
 * nothing leaves the published row *itself* alive rather than depositing a duplicate beside it, that
 * the row it extends is still the same claim afterwards, and that the two ends of the extension —
 * an expired horizon and a horizon older than the six hours it claims — are refused and republished.
 *
 * Every fixture reaches the database through the pass itself, never through a hand-written
 * `risk_assessments` INSERT: the point of the assertions is what `runRiskAssessments()` does, and a
 * seeded row with `model_version='integration-fixture'` would be expired by the version sweep that
 * opens every pass before any of it could be observed.
 *
 * Wall clock is exercised by backdating the columns the code itself wrote, never by fake timers.
 */

const OBLAST = 'test-risk-oblast';

async function seedSignals(count: number, options: {
  threatType?: string; contribution?: number; independenceGroups?: number; signalType?: string;
} = {}): Promise<void> {
  await sql(
    `INSERT INTO risk_signals(signal_type,location_id,threat_type,source_tier,independence_group,
       reliability,freshness,geographic_relevance,contribution,observed_at,expires_at)
     SELECT $6,$1,$2,'A','group-' || (g % $3), 1,1,1,$4::numeric,
            now(), now() + interval '3 hours'
     FROM generate_series(1,$5::int) g`,
    [OBLAST, options.threatType ?? 'uav', options.independenceGroups ?? 2,
      options.contribution ?? 1, count, options.signalType ?? 'explicit_threat']
  );
}

interface AssessmentRow {
  id: string;
  risk_score: string;
  risk_level: string;
  explanation: Record<string, unknown>;
  generated_at: Date;
  horizon_end: Date;
  expires_at: Date;
  extended_at: Date | null;
  published: boolean;
  superseded_by: string | null;
}

async function assessments(): Promise<AssessmentRow[]> {
  return (await sql<AssessmentRow>(
    `SELECT id,risk_score,risk_level,explanation,generated_at,horizon_end,expires_at,extended_at,
            published,superseded_by
     FROM risk_assessments ORDER BY generated_at, id`
  )).rows;
}

async function links(assessmentId?: string): Promise<Array<{ signal_id: string; contribution: string; explanation: string }>> {
  return (await sql<{ signal_id: string; contribution: string; explanation: string }>(
    `SELECT signal_id,contribution,explanation FROM risk_assessment_signals
      WHERE ($1::uuid IS NULL OR assessment_id=$1) ORDER BY signal_id`,
    [assessmentId ?? null]
  )).rows;
}

async function assessmentEvents(): Promise<number> {
  const row = await sql<{ n: string }>(
    `SELECT count(*)::text AS n FROM system_event_log WHERE event_type='assessment.updated'`
  );
  return Number(row.rows[0]!.n);
}

async function runPass(): Promise<number> {
  const { runRiskAssessments } = await import('../../src/services/risk.js');
  return runRiskAssessments();
}

describe.skipIf(!integrationDatabaseAvailable)('what a risk pass writes', () => {
  beforeAll(async () => { await ensureMigrated(); });

  beforeEach(async () => {
    await resetDatabase();
    await sql(`INSERT INTO locations(id,parent_id,type,name_uk) VALUES ($1,NULL,'oblast','Тестова область')`, [OBLAST]);
    (await import('../../src/services/risk.js')).resetRiskRunGuard();
  });

  it('publishes one assessment and links every contributing signal in one statement', async () => {
    // Forty signals in two halves that differ in BOTH columns the batch carries. The loop this
    // replaced issued forty INSERTs inside the open transaction, so the count proves the single
    // `unnest` statement carries every row — and the two halves prove it carries each row's own
    // values, which a batch that transposed one array against another would still get the count of.
    await seedSignals(20, { contribution: 0.1, signalType: 'explicit_threat' });
    await seedSignals(20, { contribution: 0.3, signalType: 'reported_direction' });

    expect(await runPass()).toBe(1);

    const rows = await assessments();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.published).toBe(true);
    expect(rows[0]!.extended_at).toBeNull();

    const signalIds = (await sql<{ id: string }>(`SELECT id FROM risk_signals ORDER BY id`)).rows.map((row) => row.id);
    const written = await links(rows[0]!.id);
    expect(written.map((row) => row.signal_id)).toEqual(signalIds);
    // Every link against the signal it names: the explanation is that signal's own type, and the
    // contribution is its own weight after decay — reliability is 1 and the signals were observed a
    // moment ago, so the two-hour half-life leaves at most a rounding difference.
    const mismatched = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM risk_assessment_signals ras JOIN risk_signals rs ON rs.id=ras.signal_id
        WHERE ras.explanation <> rs.signal_type OR abs(ras.contribution - rs.contribution) > 0.01`
    );
    expect(Number(mismatched.rows[0]!.n)).toBe(0);
    expect(await assessmentEvents()).toBe(1);
  });

  it('re-confirms the published assessment instead of writing a duplicate when nothing changed', async () => {
    await seedSignals(3);
    expect(await runPass()).toBe(1);
    const [first] = await assessments();

    // Second pass over the same signals: same score, same level, same wording.
    expect(await runPass()).toBe(0);

    const rows = await assessments();
    expect(rows).toHaveLength(1);
    const extended = rows[0]!;
    // The claim is untouched — this is the safety boundary of the extension. A pass that changed the
    // score, the level, the wording or the moment the assessment was stated would be publishing, and
    // publishing goes through an INSERT and an `assessment.updated` event.
    expect(extended.id).toBe(first!.id);
    expect(extended.risk_score).toBe(first!.risk_score);
    expect(extended.risk_level).toBe(first!.risk_level);
    expect(extended.explanation).toEqual(first!.explanation);
    expect(extended.generated_at.getTime()).toBe(first!.generated_at.getTime());
    expect(extended.superseded_by).toBeNull();
    // Only the end of the horizon moved, and it moved with `expires_at`: a live row whose
    // `horizon_end` had lapsed would render as an assessment valid until a time in the past.
    expect(extended.extended_at).not.toBeNull();
    expect(extended.expires_at.getTime()).toBeGreaterThan(first!.expires_at.getTime());
    expect(extended.horizon_end.getTime()).toBe(extended.expires_at.getTime());
    // Nothing was notified, because nothing changed.
    expect(await assessmentEvents()).toBe(1);
    // And no second set of links was deposited for a row that already has them.
    expect(await links()).toHaveLength(3);
  });

  it('publishes and supersedes when the index actually moves', async () => {
    await seedSignals(3);
    expect(await runPass()).toBe(1);
    const [first] = await assessments();

    await seedSignals(2);
    expect(await runPass()).toBe(1);

    const rows = await assessments();
    expect(rows).toHaveLength(2);
    const [previous, current] = rows;
    expect(previous!.id).toBe(first!.id);
    expect(previous!.superseded_by).toBe(current!.id);
    expect(current!.published).toBe(true);
    expect(current!.extended_at).toBeNull();
    expect(Number(current!.risk_score)).toBeGreaterThan(Number(previous!.risk_score));
    expect(await assessmentEvents()).toBe(2);
    expect(await links(current!.id)).toHaveLength(5);
  });

  it('republishes an expired assessment rather than reviving it', async () => {
    await seedSignals(3);
    expect(await runPass()).toBe(1);
    const [first] = await assessments();
    // The horizon lapsed a minute ago: the reader is currently being shown no assessment for this
    // oblast at all, and the six live signals say there should be one.
    await sql(`UPDATE risk_assessments SET expires_at=now() - interval '1 minute'`);

    expect(await runPass()).toBe(1);

    const rows = await assessments();
    expect(rows).toHaveLength(2);
    const lapsed = rows.find((row) => row.id === first!.id)!;
    const fresh = rows.find((row) => row.id !== first!.id)!;
    // The expired row stays expired. Moving its `expires_at` forward would put a horizon that has
    // already lapsed back in front of readers under its original `generated_at`.
    expect(lapsed.expires_at.getTime()).toBeLessThan(Date.now());
    expect(lapsed.extended_at).toBeNull();
    expect(lapsed.superseded_by).toBe(fresh.id);
    expect(fresh.published).toBe(true);
    expect(fresh.expires_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('states the assessment afresh once the row is older than the horizon it claims', async () => {
    await seedSignals(3);
    expect(await runPass()).toBe(1);
    const [first] = await assessments();
    // Still live, but stated seven hours ago: an extension here would keep a seven-hour-old wording
    // in front of readers indefinitely for as long as the index stayed flat.
    await sql(
      `UPDATE risk_assessments SET generated_at=now() - interval '7 hours',
                                   expires_at=now() + interval '1 hour',
                                   horizon_end=now() + interval '1 hour'`
    );

    expect(await runPass()).toBe(1);

    const rows = await assessments();
    expect(rows).toHaveLength(2);
    const stale = rows.find((row) => row.id === first!.id)!;
    const fresh = rows.find((row) => row.id !== first!.id)!;
    expect(stale.extended_at).toBeNull();
    expect(stale.superseded_by).toBe(fresh.id);
    expect(fresh.generated_at.getTime()).toBeGreaterThan(stale.generated_at.getTime());
    expect(await assessmentEvents()).toBe(2);
  });

  it('keeps repeated passes over a steady situation at one row and one set of links', async () => {
    // The shape the event-driven recompute produces during a nationwide wave: a pass a minute over a
    // situation that is not moving. Before the extension every one of these deposited a full
    // assessment plus one link per signal that no consumer would ever read.
    await seedSignals(6);
    expect(await runPass()).toBe(1);
    for (let pass = 0; pass < 5; pass += 1) expect(await runPass()).toBe(0);

    expect(await assessments()).toHaveLength(1);
    expect(await links()).toHaveLength(6);
    expect(await assessmentEvents()).toBe(1);
  });

  it('registers the indexes and the column migration 036 adds', async () => {
    const indexes = await sql<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE indexname IN ('risk_assessments_current_idx','risk_assessments_published_window_idx',
                            'risk_signals_live_idx')
        ORDER BY indexname`
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      'risk_assessments_current_idx', 'risk_assessments_published_window_idx', 'risk_signals_live_idx'
    ]);
    // The two indexes the new ones are additive to: migration 003's is still the right shape for the
    // location-led counts in `src/services/attack-research.ts` and nothing here replaces it.
    const kept = await sql<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE indexname IN ('risk_assessments_live_idx','risk_signals_live_group_idx') ORDER BY indexname`
    );
    expect(kept.rows).toHaveLength(2);
  });
});
