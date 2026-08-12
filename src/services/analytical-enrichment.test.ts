import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decideThreatNotification, geographyKey, threatContentHash, type ThreatPublishedState,
  type ThreatSnapshot
} from '../bot/notification-policy.js';
import {
  ENRICHMENT_MAX_LOCATIONS, buildEnrichments, recordAnalyticalEnrichments,
  type EnrichmentDraft, type EnrichmentVerdict, type PublishedClaim
} from './analytical-enrichment.js';

/**
 * The enrichment path, and the four things it must never be able to do.
 *
 * The build half is pure and is tested as arithmetic. The write half is tested by CAPTURING THE SQL,
 * which is unusual in this suite and deliberate: the guarantees this module makes are not about the
 * value it returns, they are about the statements it is capable of issuing. «An enrichment never
 * raises evidence» is not provable by asserting on a result object — it is provable by showing that
 * the only statement leaving this module is one `INSERT` into one table, and that the words
 * `valid_until`, `last_observed_at`, `system_event_log` and `UPDATE` do not appear in it at all.
 *
 * A test that asserted on a mocked database's *state* instead would pass just as happily on the day
 * somebody adds a second statement, because the mock would faithfully apply it.
 * `tests/integration/analytical-enrichment.test.ts` covers the same four properties against a real
 * database, where the trigger from migration 045 is also in force; these are the ones that run
 * everywhere and fail loudly in review.
 */

const locations = [
  { id: 'ua-80', name: 'Київ', aliases: ['києва', 'києві'] },
  { id: 'ua-city-odesa', name: 'Одеса', aliases: ['одеси', 'одесі', 'одесу'] },
  { id: 'ua-59', name: 'Сумська область', aliases: ['сумщина', 'сумщині'] }
];

function verdict(overrides: Partial<EnrichmentVerdict> = {}): EnrichmentVerdict {
  return {
    threatType: 'uav',
    locations: ['Київ'],
    destinationLocations: [],
    directionText: null,
    threatState: 'asserted',
    significant: true,
    confidence: 0.96,
    ...overrides
  };
}

function published(overrides: Partial<PublishedClaim> = {}): PublishedClaim {
  return {
    eventId: '00000000-0000-4000-8000-000000000001',
    threatType: 'uav',
    locationIds: ['ua-80'],
    directionText: null,
    nationalScope: false,
    ...overrides
  };
}

const kinds = (drafts: EnrichmentDraft[]) => drafts.map((draft) => draft.kind);

describe('buildEnrichments — what counts as an addition', () => {
  it('offers a course the source stated and the rules did not store', () => {
    const drafts = buildEnrichments(verdict({ directionText: 'курс на Кременчук' }), published(), locations);
    expect(drafts).toEqual([
      { kind: 'direction', locationId: null, threatType: null, directionText: 'курс на Кременчук' }
    ]);
  });

  it('stays silent when the event already carries a direction', () => {
    // Two directions on one event is a contradiction for an operator to resolve, not an addition,
    // and the deterministic reading of the same sentence wins by default.
    const drafts = buildEnrichments(
      verdict({ directionText: 'курс на Кременчук' }),
      published({ directionText: 'у напрямку Полтавщини' }),
      locations
    );
    expect(kinds(drafts)).not.toContain('direction');
  });

  it('resolves a place the rules missed into a catalogue id, never into the model\'s spelling', () => {
    const drafts = buildEnrichments(verdict({ locations: ['Києва', 'Одесі'] }), published(), locations);
    expect(drafts).toEqual([
      { kind: 'additional_location', locationId: 'ua-city-odesa', threatType: null, directionText: null }
    ]);
  });

  it('drops a name the catalogue cannot resolve to exactly one place', () => {
    // The same three refusals `resolveModelPlace` applies for a promotion. A model naming a place
    // that is not in the catalogue, or one that is in it twice, adds nothing here either — and
    // picking the first candidate would file a remark about a town 400 km from the one meant.
    expect(buildEnrichments(verdict({ locations: ['Атлантида'] }), published(), locations)).toEqual([]);
  });

  it('adds nothing to an event that already covers the whole country', () => {
    const drafts = buildEnrichments(
      verdict({ locations: ['Одеса'] }), published({ nationalScope: true, locationIds: ['ua'] }), locations
    );
    expect(kinds(drafts)).not.toContain('additional_location');
  });

  it('caps the number of places one message may propose, destinations first', () => {
    const drafts = buildEnrichments(
      verdict({ threatState: 'redirected', destinationLocations: ['Одеса'], locations: ['Сумщина'] }),
      published(),
      locations
    );
    const places = drafts.filter((draft) => draft.kind === 'additional_location');
    expect(places.length).toBeLessThanOrEqual(ENRICHMENT_MAX_LOCATIONS);
    expect(places[0]?.locationId).toBe('ua-city-odesa');
  });

  it('offers a strictly more severe class', () => {
    const drafts = buildEnrichments(verdict({ threatType: 'ballistic_missile' }), published(), locations);
    expect(drafts).toContainEqual({
      kind: 'threat_class', locationId: null, threatType: 'ballistic_missile', directionText: null
    });
  });

  it('never offers a LESS severe class, which is the one remark that would reassure', () => {
    // The same asymmetry `decideThreatNotification` applies to a weakened evidence level: «this is
    // less dangerous than you were told» is the statement that moves people out of shelters, and a
    // model may not make it in any form — including as a note an operator reads at three in the
    // morning while deciding whether the rules over-reacted.
    const drafts = buildEnrichments(
      verdict({ threatType: 'uav' }), published({ threatType: 'ballistic_missile' }), locations
    );
    expect(kinds(drafts)).not.toContain('threat_class');
  });

  it('says nothing when the model filed the same class', () => {
    expect(kinds(buildEnrichments(verdict(), published(), locations))).not.toContain('threat_class');
  });

  it.each([
    ['below the shared confidence floor', verdict({ confidence: 0.5, directionText: 'курс на Кременчук' })],
    ['a withdrawal', verdict({ threatState: 'withdrawn', directionText: 'курс на Кременчук' })],
    ['an uncertain state', verdict({ threatState: 'uncertain', directionText: 'курс на Кременчук' })],
    ['not significant', verdict({ significant: false, directionText: 'курс на Кременчук' })],
    ['no recognised class', verdict({ threatType: 'unknown', directionText: 'курс на Кременчук' })]
  ])('records nothing for a verdict that is %s', (_label, modelVerdict) => {
    expect(buildEnrichments(modelVerdict, published(), locations)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------
// The four prohibitions, read off the statements themselves
// ------------------------------------------------------------------------------------------------

const target = {
  eventId: '00000000-0000-4000-8000-000000000001',
  sourceMessageId: '00000000-0000-4000-8000-000000000002',
  classifierVersion: 'v5',
  model: 'test-model',
  confidence: 0.96
};

const everyKind: EnrichmentDraft[] = [
  { kind: 'direction', locationId: null, threatType: null, directionText: 'курс на Кременчук' },
  { kind: 'additional_location', locationId: 'ua-city-odesa', threatType: null, directionText: null },
  { kind: 'threat_class', locationId: null, threatType: 'ballistic_missile', directionText: null }
];

let statements: string[] = [];
const accepting = vi.fn(async (text: string) => { statements.push(text); return { rowCount: 1 }; });
const refusing = vi.fn(async (text: string) => { statements.push(text); return { rowCount: 0 }; });

beforeEach(() => {
  statements = [];
  accepting.mockClear();
  refusing.mockClear();
});

async function issuedStatements(): Promise<string[]> {
  await recordAnalyticalEnrichments(target, everyKind, { query: accepting });
  expect(statements.length).toBe(everyKind.length);
  return statements;
}

/** Every table an `INSERT INTO` in these statements names. */
function insertTargets(text: string): string[] {
  return [...text.matchAll(/insert\s+into\s+([a-z_]+)/gi)].map((match) => match[1]!.toLowerCase());
}

describe('recordAnalyticalEnrichments — the write cannot reach the event', () => {
  it('issues one INSERT into analytical_enrichments per remark and nothing else, ever', async () => {
    for (const text of await issuedStatements()) {
      expect(insertTargets(text)).toEqual(['analytical_enrichments']);
      expect(text).not.toMatch(/\b(update|delete|truncate|alter|drop)\b/i);
    }
  });

  it('never changes the evidence level of the event it annotates', async () => {
    // PROHIBITION 1. `evidence_level` appears twice and only twice: as a guard in the WHERE, and as a
    // value COPIED out of the event row into the remark's own snapshot column. There is no statement
    // here that could assign it, which is the difference between a rule and a promise.
    for (const text of await issuedStatements()) {
      expect(text).toContain("e.evidence_level <> 'official'");
      expect(text).toContain('e.threat_type,e.evidence_level');
      expect(text).not.toMatch(/threat_events\s+set/i);
      expect(text).not.toMatch(/\bset\s+evidence_level/i);
    }
  });

  it('never extends validity and never moves the last observation', async () => {
    // PROHIBITION 2. The strings simply do not occur. A model reading a post as a restatement cannot
    // keep a HUMAN source's warning standing one minute longer than that source vouched for — which
    // is what an enrichment written onto the event, through the merge statement in
    // `../repositories/events.ts`, would silently do via `GREATEST(valid_until, ...)`.
    for (const text of await issuedStatements()) {
      expect(text).not.toMatch(/valid_until/i);
      expect(text).not.toMatch(/last_observed_at/i);
      expect(text).not.toMatch(/ended_at/i);
    }
  });

  it('never touches anything a notification is derived from', async () => {
    // PROHIBITION 3, first half. `fanoutNewEvents` (`../bot/outbox.ts`) walks `system_event_log` and
    // nothing else, and the snapshot it decides on is built from the event row and its districts.
    // None of those tables is named here, so there is no row for the fan-out to find and no changed
    // field for `decideThreatNotification` to read.
    const forbidden = [
      'system_event_log', 'notification_outbox', 'notification_state', 'event_updates',
      'threat_assertions', 'risk_signals', 'alert_periods', 'alert_source_states', 'event_evidence'
    ];
    for (const text of await issuedStatements()) {
      // Whole words: `event_evidence_level` is this table's own snapshot column and must not read as
      // a reference to `event_evidence`, which is the table the corroboration promotion walks.
      for (const table of forbidden) expect(text).not.toMatch(new RegExp(`\\b${table}\\b`, 'i'));
      // `threat_event_locations` IS named — as a `SELECT 1` that refuses a district the event already
      // has. Reading the polygon set is what makes the remark honest; writing it is what would put a
      // new polygon on the map and send `geography_changed` to every subscriber.
      expect(insertTargets(text)).not.toContain('threat_event_locations');
    }
  });

  it('leaves the notification decision exactly where it was', async () => {
    // PROHIBITION 3, second half, stated in the units the notifier itself uses. The snapshot is built
    // from the event: its evidence level, its districts, its validity deadline. An enrichment adds a
    // district to a table that is not `threat_event_locations`, so the snapshot after it is the same
    // object as before — and the policy answers `skip`, exactly as it does for any re-confirmation.
    //
    // Had the same addition gone onto the event, the second call below would be `send`/`change`. That
    // contrast is the whole reason the row lives in a table of its own, so it is asserted here rather
    // than described in a comment.
    const snapshot: ThreatSnapshot = {
      threatType: 'uav', evidenceLevel: 'monitoring', locationIds: ['ua-80'],
      validUntil: '2026-03-01T20:30:00.000Z'
    };
    const told: ThreatPublishedState = {
      threatType: snapshot.threatType,
      evidenceLevel: snapshot.evidenceLevel,
      geographyKey: geographyKey(snapshot.locationIds),
      validUntil: snapshot.validUntil,
      contentHash: threatContentHash(snapshot),
      telegramMessageId: 42
    };
    await recordAnalyticalEnrichments(target, everyKind, { query: accepting });
    expect(decideThreatNotification(told, snapshot)).toMatchObject({ action: 'skip', kind: 'none' });

    // And the counter-example, so the assertion above cannot pass by being vacuous: the very same
    // addition, had it reached the event's district set, is a fresh push to every subscriber.
    const widened: ThreatSnapshot = { ...snapshot, locationIds: ['ua-80', 'ua-city-odesa'] };
    expect(decideThreatNotification(told, widened)).toMatchObject({ action: 'send', kind: 'change' });
  });

  it('refuses an official event in the statement itself, not in the caller', async () => {
    // PROHIBITION 4. The guard travels with the write, so an official event cannot be annotated by
    // any caller of this function however it is called; migration 045 adds a trigger that refuses the
    // row even for a writer that is not this file. When the event declines, `recorded` is zero and
    // the drafts are reported as refused rather than silently counted.
    for (const text of await issuedStatements()) {
      expect(text).toContain("e.evidence_level <> 'official'");
      expect(text).toContain("e.origin = 'deterministic'");
      expect(text).toContain("e.status IN ('observed','confirmed','active')");
    }
    statements = [];
    const result = await recordAnalyticalEnrichments(target, everyKind, { query: refusing });
    expect(result).toEqual({ recorded: 0, refused: everyKind.length });
  });

  it('re-checks each addition against the event as it stands, not as the message read', async () => {
    // A district another source attached two minutes ago, a direction the rules have since written,
    // a class the event has since been raised to: each has its own clause, and each is evaluated by
    // the database inside the writing statement — so there is no window between the check and the
    // write for any of the three to change.
    const [text] = await issuedStatements();
    expect(text).toContain('el.event_id=e.id AND el.location_id=$7::text');
    expect(text).toContain("$6::text <> 'threat_class' OR e.threat_type <> $8::text");
    expect(text).toContain("$6::text <> 'direction' OR e.direction_text IS NULL");
  });

  it('touches the database not at all when the verdict added nothing', async () => {
    expect(await recordAnalyticalEnrichments(target, [], { query: accepting }))
      .toEqual({ recorded: 0, refused: 0 });
    expect(accepting).not.toHaveBeenCalled();
  });

  it('binds the event and the audit root, and never a model-written place name', async () => {
    const write = vi.fn(async () => ({ rowCount: 1 }));
    await recordAnalyticalEnrichments(target, everyKind, { query: write });
    const values = (write.mock.calls[1]! as unknown as [string, unknown[]])[1];
    expect(values[0]).toBe(target.eventId);
    expect(values[1]).toBe(target.sourceMessageId);
    // The resolved catalogue id, which is the only form a place ever reaches the database in.
    expect(values[6]).toBe('ua-city-odesa');
  });
});

// ------------------------------------------------------------------------------------------------
// The wiring: who asks for an enrichment, and when nobody does
// ------------------------------------------------------------------------------------------------

// The feature switches are a database read and this suite has no database; `codexFeatureEnabled`
// answers false on a failed query, which is also the stored default, so the switch is mocked and the
// "off" case gets a test of its own — the most important one in this block.
vi.mock('./codex-settings.js', () => ({ codexFeatureEnabled: vi.fn(async () => true) }));
const { codexFeatureEnabled } = await import('./codex-settings.js');

const pooled = vi.fn(async () => ({ rows: [], rowCount: 0 }));
vi.mock('../db/pool.js', () => ({ pool: { query: (...args: unknown[]) => pooled(...args as []) } }));

const { shadowClassify, resetShadowRateLimit } = await import('./shadow-classifier.js');

const chatReturning = (value: unknown) => vi.fn(async () => ({
  ok: true as const, content: JSON.stringify(value), model: 'test-model', durationMs: 5
}));

const modelVerdict = {
  threatType: 'ballistic_missile', locations: ['Одеса'], significant: true, confidence: 0.96,
  originLocations: [], destinationLocations: [], directionText: 'курс на південь',
  threatState: 'asserted'
};

/** A message the rules PUBLISHED — the only shape an enrichment is ever offered for. */
const enrichable = () => ({
  sourceMessageId: '00000000-0000-4000-8000-000000000002',
  publishedAt: new Date('2026-03-01T20:00:00Z'),
  text: 'Балістика на Одесу',
  classified: {
    intent: 'threat' as const, threatType: 'uav', signalThreatTypes: ['uav'],
    locations: [{ id: 'ua-80', name: 'Київ', relationType: 'explicit_threat' as const }],
    nationalScope: false, indicators: ['uav'], title: 'Загроза', summary: 'Загроза'
  },
  publishedClaim: published()
});

describe('shadowClassify — the enrichment half', () => {
  beforeEach(() => {
    resetShadowRateLimit();
    pooled.mockClear();
    vi.mocked(codexFeatureEnabled).mockImplementation(async () => true);
  });

  it('files nothing while the operator has not switched enrichment on', async () => {
    // The default an installation upgrades into. Everything else about the pipeline is unchanged —
    // the comparison row is still written, the model was still asked — and the remark simply does
    // not exist. This is the assertion that has to survive every future edit of this feature.
    vi.mocked(codexFeatureEnabled).mockImplementation(async (feature) => feature !== 'analytical_enrichment');
    const enrich = vi.fn(async () => 3);
    const outcome = await shadowClassify(enrichable() as never, {
      chat: chatReturning(modelVerdict) as never, enrich
    });
    expect(outcome.status).toBe('recorded');
    expect(outcome.enrichments).toBeUndefined();
    expect(enrich).not.toHaveBeenCalled();
  });

  it('asks the enrichment switch by its own name, not by the publication one', async () => {
    await shadowClassify(enrichable() as never, { chat: chatReturning(modelVerdict) as never, enrich: vi.fn(async () => 0) });
    expect(vi.mocked(codexFeatureEnabled)).toHaveBeenCalledWith('analytical_enrichment');
    expect(vi.mocked(codexFeatureEnabled)).toHaveBeenCalledWith('analytical_threats');
  });

  it('files the remarks once the operator has switched it on', async () => {
    const enrich = vi.fn(async () => 2);
    const outcome = await shadowClassify(enrichable() as never, {
      chat: chatReturning(modelVerdict) as never, enrich
    });
    expect(outcome).toMatchObject({ status: 'recorded', enrichments: 2 });
    expect(enrich).toHaveBeenCalledOnce();
  });

  it('offers nothing for a message the rules refused, which is the promotion path', async () => {
    // Promotion and enrichment are complementary by construction: `allowAnalyticalPromotion` marks
    // the messages the rules declined, `publishedClaim` the ones they published, and `./ingestion.ts`
    // sets exactly one. A verdict on a declined message must never be filed as a remark about
    // somebody else's event.
    const enrich = vi.fn(async () => 1);
    const outcome = await shadowClassify(
      { ...enrichable(), publishedClaim: undefined, allowAnalyticalPromotion: true } as never,
      { chat: chatReturning(modelVerdict) as never, enrich, promote: vi.fn(async () => null) }
    );
    expect(outcome.enrichments).toBeUndefined();
    expect(enrich).not.toHaveBeenCalled();
  });

  it('swallows an enrichment failure rather than losing the comparison row', async () => {
    const enrich = vi.fn(async () => { throw new Error('relation does not exist'); });
    const outcome = await shadowClassify(enrichable() as never, {
      chat: chatReturning(modelVerdict) as never, enrich
    });
    expect(outcome.status).toBe('recorded');
    expect(outcome.enrichments).toBeUndefined();
  });
});
