/**
 * The territory aggregate: what the map draws, computed once on the server and shipped inside the
 * snapshot as `territories[]`.
 *
 * Pure by contract — zero database access, zero `config` import, zero `pg`, and **zero `new Date()`**.
 * `now` is a required member of the input: the icon order is bucketed by freshness, so the fold
 * needs a clock, and a clock read *inside* a pure function would make the buckets irreproducible
 * between the server, the unit tests and any replay of a recorded snapshot. The snapshot builder
 * passes the same `new Date()` it uses for `sliceMeta`.
 *
 * ## The rule this module exists to keep: no invented geography
 *
 * A polygon lights only for a territory a source literally named, or for the nearest ancestor that
 * has a polygon at all when the named place has none (a city, a hromada). Everything above that is
 * `partial` — derived coverage of an explicitly named child, drawn muted — and a national-scope
 * warning (`location_id = 'ua'`) produces no territory whatsoever. Twenty-seven lit oblasts would be
 * a claim no source made.
 *
 * The same three rules are implemented a second time in the browser (`territoryCoverage()` in
 * web/app.js), because the map must keep working against a server that does not yet send
 * `territories[]`. The two implementations are pinned to each other by CONTRACT.md §3.3 and by
 * STAGE1 §12.1's key-by-key table; changing one without the other changes the map's appearance.
 */
import { type EvidenceLevel, type LiveEvent, type RelationType, type ThreatTiming, type ThreatType } from '../types.js';
import {
  compareThreatIcons, rankThreatIcons, EVIDENCE_RANK, RELATION_RANK,
  type IconCandidate, type IconTone, type TerritoryIcon
} from './threat-icons.js';

/** `TerritoryIcon` is exactly `RankedIcon` (threat-icons.ts §3.2); re-exported so a consumer of the
 *  territory payload never has to know which of the two modules declared it. */
export type { TerritoryIcon };

/**
 * The slice of `locations` the fold needs: id, parent and tier. Declared here rather than in
 * `src/repositories/events.ts` on purpose — the repository imports this type, not the other way
 * round, so the fold never drags `pg` into a module whose unit tests must run without a database.
 */
export interface TerritoryNode { id: string; parentId: string | null; type: string; nameUk: string; }

export type TerritoryTier     = 'oblast' | 'special_city' | 'raion';
export type TerritoryCoverage = 'direct' | 'partial' | 'unmapped';
export type RiskLevel = 'background' | 'elevated' | 'significant' | 'high' | 'very_high';

export interface TerritoryAlert {
  alertType: string;              // 'air_raid' | 'artillery' | 'urban_fighting' | 'chemical' | 'nuclear' | …
  startedAt: string;              // ISO
  locationId: string;             // the territory literally named by the source
  locationName: string;
  coverage: TerritoryCoverage;    // how this alert reaches *this* territory
}

export interface TerritoryThreat {
  threatType: ThreatType;
  /**
   * Status AS OF THE CUTOFF — the three live values only. `liveThreats(cutoff)` projects a terminal
   * status back to `'active'` for a row that was still running at the cutoff (§2.5); revealing the
   * terminal label before the SSE frame that carries it would be an early all-clear. Anything else
   * arriving here is projected the same way, for the same reason.
   */
  status: 'observed' | 'confirmed' | 'active';
  evidenceLevel: EvidenceLevel;   // strongest across the events of this class on this territory
  relationType: RelationType;     // strongest relation, see RELATION_RANK
  /**
   * `relationType ∈ {explicit_threat, reported_direction, aftermath}` — the source said something
   * ABOUT this territory. `mentioned` and `official_alert` are false: `relationFor()` assigns
   * `mentioned` to the transit case («повз Миколаїв») and as the fall-through for any alias merely
   * present in the text. A non-asserted threat contributes NO polygon and NO icon; it appears only
   * in the territory panel's «Згадано джерелом» row, so no information is lost.
   */
  asserted: boolean;
  coverage: TerritoryCoverage;
  count: number;                  // live events of this class touching this territory
  lastConfirmedAt: string;        // ISO — max(lastObservedAt)
  /**
   * The `direction_text` of the NEWEST contributing event (`max(lastObservedAt)`), or null when that
   * event carries none. Never merged, concatenated or averaged across events — a quoted direction is
   * a quotation, and a merged one would be words no source wrote.
   */
  directionText: string | null;
  /**
   * At least one contributing event carries relation `aftermath` AND that event's `evidenceLevel` is
   * `official` or `confirmed`. The evidence gate is not decoration: `relationFor()` returns
   * `aftermath` from a MESSAGE-WIDE regex (`/наслідк|влучан|пошкоджен|вибух/`) that never references
   * the alias, so every location named anywhere in a consequences message gets it. Promoting that to
   * a hatched «підтверджена атака» polygon and to the top of the icon order would make the strongest
   * factual claim on the map rest on the weakest per-location signal.
   */
  consequence: boolean;
  eventIds: string[];             // up to 8, newest first — the panel's click-through targets
}

/**
 * Очікувана загроза на території (міграція 049): подія з `timing` ≠ now. Вона НЕ заливає полігон і
 * не стає іконкою — це не «загроза зараз», а сказане джерелом про найближчі години чи доби. Панель
 * показує її окремим рядком «очікується …», з ймовірністю моделі і вікном.
 */
export interface TerritoryExpectedThreat {
  eventId: string;
  threatType: ThreatType;
  timing: ThreatTiming;
  probability: number | null;
  expectedFrom: string | null;
  expectedUntil: string | null;
  evidenceLevel: EvidenceLevel;
  lastObservedAt: string;
  note: string | null;
}

export interface TerritoryAssessment {
  assessmentId: string;
  threatType: ThreatType;
  riskLevel: RiskLevel;
  riskScore: number;
  indicativePercent: number | null;
  assessmentConfidence: 'low' | 'medium' | 'high';
  horizonEnd: string;             // ISO
  generatedAt: string;            // ISO
}

export interface TerritoryState {
  locationId: string;             // === locations.id === the ADM1/ADM2 promoteId
  tier: TerritoryTier;
  name: string;                   // locations.name_uk, unmodified
  parentId: string | null;
  coverage: TerritoryCoverage;    // strongest coverage across all states on this territory
  alertActive: boolean;
  alertSince: string | null;      // ISO — earliest active alert start
  alerts: TerritoryAlert[];
  threats: TerritoryThreat[];     // ordered by the icon priority, strongest first
  expected: TerritoryExpectedThreat[];  // очікувані (timing ≠ now), найближчі першими; без полігона й іконки
  threatActive: boolean;          // any threat with `asserted === true` — drives the orange polygon
  consequences: boolean;          // any `TerritoryThreat.consequence` — «підтверджена атака / наслідки»
  assessment: TerritoryAssessment | null;   // strongest live assessment (highest riskScore)
  analyticStatus: 'none' | RiskLevel;
  icons: TerritoryIcon[];         // <= MAX_ICON_SLOTS (3), ranked
  iconOverflow: number;           // the N the RANKING truncated; 0 when nothing was truncated
  publishedAt: string;            // === snapshot.publication.cutoffAt
}

/**
 * Дзеркало LOCATION_HIERARCHY_MAX_DEPTH із src/repositories/events.ts (і з web/app.js). Каталог
 * тритирівневий, вісім кроків — це запас на випадок зіпсованого parent_id, а не очікувана глибина.
 * Константа переоголошена, а не імпортована: імпорт із репозиторію затягнув би сюди `pg`.
 */
export const LOCATION_HIERARCHY_MAX_DEPTH = 8;
/** Скільки очікуваних загроз несе одна територія в панель. */
export const MAX_TERRITORY_EXPECTED = 6;
/** Порядок актуальності: дзеркало `TIMING_RANK` із `src/domain/threat-timing.ts`. */
const TIMING_RANK: Record<ThreatTiming, number> = { now: 0, within_hour: 1, evening: 2, within_day: 3, within_two_days: 4 };

/** Тільки ці три рівні мають контур на карті; усе інше (місто, громада, країна) не є територією. */
export const POLYGON_TIERS = new Set<string>(['oblast', 'special_city', 'raion']);

/** Загальнонаціональна тривога не є географією. Див. заголовок модуля. */
export const NATIONAL_SCOPE_ID = 'ua';

/**
 * Звʼязки, які СТВЕРДЖУЮТЬ загрозу саме для цієї території. `mentioned` сюди не входить свідомо:
 * класифікатор ставить його для транзиту («повз Миколаїв» — щось пройшло повз, у бік того місця не
 * цілилися) і як запасний варіант для будь-якого алiаса, знайденого в тексті. `official_alert` є в
 * enum і у двох CHECK, але його не пише жоден код; ранжуємо як mentioned.
 */
export const ASSERTING_RELATIONS = new Set<RelationType>(['explicit_threat', 'reported_direction', 'aftermath']);

/**
 * Доказовість, за якої «наслідки» стають окремим штрихованим полігоном. Регулярка наслідків у
 * relationFor() перевіряє ВЕСЬ текст повідомлення і ніколи не дивиться на алiас, тож у повідомленні
 * «Вибухи в Одесі, ракети повз Миколаїв» aftermath дістається й Миколаєву.
 */
export const CONFIRMING_EVIDENCE = new Set<EvidenceLevel>(['official', 'confirmed']);

/**
 * Поріг для аналітичного КОНТУРУ. Нижчий за поріг іконки: пунктирний контур — це підказка про
 * територію, гліф — це заява про клас зброї. Дзеркалиться в `territoryCoverage()` у web/app.js.
 */
export const ANALYTIC_CONTOUR_FLOOR = new Set<RiskLevel>(['elevated', 'significant', 'high', 'very_high']);

/** Risk levels at which an analytic assessment may become an ICON (the contour's floor is lower —
 *  `elevated` — because a dotted outline is a hint about a territory and a glyph is a claim about a
 *  class). CONTRACT §5.2. */
const ANALYTIC_ICON_FLOOR = new Set<RiskLevel>(['significant', 'high', 'very_high']);

/** Above this many territories carrying one (threatType, riskLevel) pair in one snapshot, the pair
 *  did not come from geography and must not become geography. See `broadAnalyticPairs` below. */
const ANALYTIC_FANOUT_LIMIT = 20;

/** The panel's click-through targets, newest first. More than eight is a list nobody reads. */
const MAX_TERRITORY_EVENT_IDS = 8;

const RISK_LEVEL_RANK: Record<RiskLevel, number> =
  { background: 0, elevated: 1, significant: 2, high: 3, very_high: 4 };

const COVERAGE_RANK: Record<TerritoryCoverage, number> = { direct: 2, unmapped: 1, partial: 0 };

/** `direct` beats `unmapped` beats `partial`, exactly as the browser resolves it at write time. */
const strongerCoverage = (left: TerritoryCoverage, right: TerritoryCoverage): TerritoryCoverage =>
  COVERAGE_RANK[left] >= COVERAGE_RANK[right] ? left : right;

const LIVE_THREAT_STATUSES = new Set<string>(['observed', 'confirmed', 'active']);

/**
 * Anything that is not one of the three live labels is reported as `active`.
 *
 * That is the safe direction and the same one §2.5 already takes: showing a terminal label before
 * the SSE frame that carries it is an early all-clear, which the publication gate is forbidden to
 * produce. Showing a live label a moment too long is not.
 */
const liveStatus = (status: string): TerritoryThreat['status'] =>
  LIVE_THREAT_STATUSES.has(status) ? (status as TerritoryThreat['status']) : 'active';

/**
 * Нерозбірний час не має права зронити весь знімок: він проходить далі як є, а freshnessBucket()
 * покладе такого кандидата в найстаріший кошик.
 */
const toIso = (value: string | Date): string => {
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
};

/** `numeric(4,1)` приходить із pg рядком. NaN сюди не потрапляє — інакше зламався б і порядок. */
const toNumber = (value: string | number): number => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** `-Infinity` for an unparseable timestamp: it sorts oldest and never poisons a comparison to NaN. */
const parsedMs = (value: string): number => {
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
};

/** The tone an existing threat row wears: consequence > confirmed > reported. */
const threatTone = (threat: TerritoryThreat): IconTone =>
  threat.consequence ? 'consequence'
    : (threat.evidenceLevel === 'official' || threat.evidenceLevel === 'confirmed')
        ? 'confirmed' : 'reported';

const threatCandidate = (threat: TerritoryThreat): IconCandidate => ({
  threatType: threat.threatType,
  tone: threatTone(threat),
  evidenceLevel: threat.evidenceLevel,
  relationType: threat.relationType,
  lastConfirmedAt: threat.lastConfirmedAt,
  eventCount: threat.count,
  riskScore: null
});

function iconCandidatesFor(state: {
  coverage: TerritoryCoverage;
  threats: TerritoryThreat[];
  assessment: TerritoryAssessment | null;
  assessmentCoverage: TerritoryCoverage | null;
}, now: Date, broadAnalyticPairs: ReadonlySet<string>): IconCandidate[] {
  // Іконка на `partial` області стверджувала б клас загрози для цілої області, чого не казало
  // жодне джерело. Приглушений полігон — це «десь усередині», іконка — це «тут». Різниця між ними
  // і є правилом «не вигадуємо географію».
  if (state.coverage === 'partial') return [];

  const candidates: IconCandidate[] = state.threats
    // `mentioned` / `official_alert` не дають іконки. relationFor() ставить `mentioned` для
    // транзиту («повз Миколаїв») і як запасний варіант для будь-якого алiаса в тексті; гліф класу
    // зброї на такому полігоні — це заява, якої джерело не робило. Рядок у панелі лишається.
    //
    // Друга умова — те саме правило, застосоване до окремого сімейства станів. `state.coverage` —
    // це НАЙСИЛЬНІШЕ покриття з усіх сімейств, тож область, засвічена офіційною тривогою напряму,
    // має coverage `direct` навіть тоді, коли загрозу назвали лише для району всередині неї. Без
    // цієї перевірки на такій області зʼявився б гліф класу зброї — рівно та заява, яку забороняє
    // CONTRACT §6.5 («icon candidates only for `direct` and `unmapped` territories»).
    .filter((threat) => threat.asserted && threat.coverage !== 'partial')
    .map((threat): IconCandidate => ({
      threatType: threat.threatType,
      tone: threatTone(threat),
      evidenceLevel: threat.evidenceLevel,
      relationType: threat.relationType,
      lastConfirmedAt: threat.lastConfirmedAt,
      eventCount: threat.count,
      riskScore: null
    }));

  // Аналітична оцінка стає іконкою лише тоді, коли живої події цього класу немає взагалі: інакше
  // на території зʼявилися б дві іконки одного типу — одна про повідомлення, друга про модель.
  //
  // Плюс два пороги, обидва проти однієї конкретної діри. Загальнонаціональна класифікація не дає
  // полігона напряму (location_id = 'ua' відкидається), але ingestThreat розсіює її сигнали на КОЖНУ
  // область як `national_posture` з relevance 0.28, і з них виходять 27 `direct` аналітичних
  // територій. 27 сірих гліфів — це заява «цей клас тут» для попередження, якого жодне джерело не
  // локалізувало. Тому: (1) поріг `significant`, а не `elevated`; (2) якщо ту саму пару
  // (клас, рівень) несе понад ANALYTIC_FANOUT_LIMIT територій одного знімка — іконки немає взагалі.
  const covered = new Set(candidates.map((candidate) => candidate.threatType));
  const assessment = state.assessment;
  if (assessment
      && state.assessmentCoverage !== 'partial'
      && ANALYTIC_ICON_FLOOR.has(assessment.riskLevel)
      && !covered.has(assessment.threatType)
      && !broadAnalyticPairs.has(`${assessment.threatType}|${assessment.riskLevel}`)) {
    candidates.push({
      threatType: assessment.threatType,
      tone: 'analytic',
      evidenceLevel: null,
      relationType: null,
      lastConfirmedAt: assessment.generatedAt,
      eventCount: 0,
      riskScore: assessment.riskScore
    });
  }
  return candidates;
}

const strongerAssessment = (candidate: TerritoryAssessment, current: TerritoryAssessment): boolean => {
  if (candidate.riskScore !== current.riskScore) return candidate.riskScore > current.riskScore;
  const byLevel = RISK_LEVEL_RANK[candidate.riskLevel] - RISK_LEVEL_RANK[current.riskLevel];
  if (byLevel !== 0) return byLevel > 0;
  return candidate.assessmentId < current.assessmentId;
};

/** Newest first; equal timestamps fall back to the id so the list never depends on Map order. */
const byRecencyThenId = (left: [string, number], right: [string, number]): number => {
  if (left[1] !== right[1]) return right[1] > left[1] ? 1 : -1;
  return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
};

/** One territory reached by one literally named location, and how it was reached. */
interface Reached { node: TerritoryNode; coverage: TerritoryCoverage; }

interface ThreatDraft {
  threatType: ThreatType;
  status: TerritoryThreat['status'];
  evidenceLevel: EvidenceLevel;
  relationType: RelationType;
  coverage: TerritoryCoverage;
  consequence: boolean;
  newestAt: number;
  lastConfirmedAt: string;
  directionText: string | null;
  events: Map<string, number>;
}

interface TerritoryDraft {
  node: TerritoryNode;
  coverage: TerritoryCoverage;
  alerts: TerritoryAlert[];
  threats: Map<ThreatType, ThreatDraft>;
  expected: Map<string, TerritoryExpectedThreat>;
  assessment: TerritoryAssessment | null;
  assessmentCoverage: TerritoryCoverage | null;
}

export function composeTerritoryStates(input: {
  publishedAt: string;
  /**
   * REQUIRED, no default. The fold ranks icons by freshness bucket, so it needs a clock — and it
   * must never reach for `new Date()` itself: that would destroy determinism and make the freshness
   * buckets irreproducible between the server, the tests and any replay, which is exactly what the
   * roadmap's «алгоритм має бути детермінованим» forbids. The snapshot passes the same `new Date()`
   * it uses for `sliceMeta`.
   */
  now: Date;
  nodes: TerritoryNode[];
  alerts: Array<{ id: string; location_id: string; location_name: string; alert_type: string; started_at: string | Date }>;
  threats: LiveEvent[];
  assessments: Array<{
    id: string; location_id: string; threat_type: ThreatType; risk_level: RiskLevel;
    risk_score: string | number; indicative_percent: number | null;
    assessment_confidence: 'low' | 'medium' | 'high';
    horizon_end: string | Date; generated_at: string | Date
  }>;
}): TerritoryState[] {
  const index = new Map<string, TerritoryNode>(input.nodes.map((node) => [node.id, node]));
  const reachCache = new Map<string, readonly Reached[]>();

  /**
   * Території, яких дістає одна дослівно названа локація.
   *
   * direct   — саму територію названо дослівно;
   * unmapped — найближчий предок із контуром, коли в названої локації контуру немає (місто,
   *            громада). Він не гасне з наближенням: детальнішого шару, який його підмінить, немає;
   * partial  — предки над «якорем»; на оглядовому масштабі без них область виглядала б спокійною,
   *            поки в її районі триває тривога.
   *
   * Той самий обхід, що й `claim()` у web/app.js: обмеження глибини, захист від циклу, і країна,
   * яка не є територією взагалі.
   */
  const reachOf = (locationId: string | null | undefined): readonly Reached[] => {
    if (!locationId) return [];
    const cached = reachCache.get(locationId);
    if (cached) return cached;
    const reached: Reached[] = [];
    const named = index.get(locationId);
    if (locationId !== NATIONAL_SCOPE_ID && named && named.type !== 'country') {
      let anchored = POLYGON_TIERS.has(named.type);
      if (anchored) reached.push({ node: named, coverage: 'direct' });
      const seen = new Set<string>([locationId]);
      let parentId = named.parentId;
      let depth = 0;
      while (parentId && !seen.has(parentId) && depth < LOCATION_HIERARCHY_MAX_DEPTH) {
        seen.add(parentId);
        depth += 1;
        const parent = index.get(parentId);
        if (!parent) break;
        if (POLYGON_TIERS.has(parent.type)) {
          reached.push({ node: parent, coverage: anchored ? 'partial' : 'unmapped' });
          anchored = true;
        }
        parentId = parent.parentId;
      }
    }
    reachCache.set(locationId, reached);
    return reached;
  };

  const drafts = new Map<string, TerritoryDraft>();
  const draftFor = (node: TerritoryNode, coverage: TerritoryCoverage): TerritoryDraft => {
    const existing = drafts.get(node.id);
    if (existing) {
      existing.coverage = strongerCoverage(existing.coverage, coverage);
      return existing;
    }
    const draft: TerritoryDraft = {
      node, coverage, alerts: [], threats: new Map(), expected: new Map(), assessment: null, assessmentCoverage: null
    };
    drafts.set(node.id, draft);
    return draft;
  };

  for (const alert of input.alerts) {
    const startedAt = toIso(alert.started_at);
    for (const { node, coverage } of reachOf(alert.location_id)) {
      draftFor(node, coverage).alerts.push({
        alertType: alert.alert_type,
        startedAt,
        locationId: alert.location_id,
        locationName: alert.location_name,
        coverage
      });
    }
  }

  for (const event of input.threats) {
    // Очікувана подія (міграція 049) — в окремий список території, а не в полігон і не в іконку:
    // «увечері очікується балістика» не є загрозою зараз, і заливати нею область означало б показати
    // читачеві те саме, що й «балістика в повітрі».
    if (event.timing && event.timing !== 'now') {
      for (const location of event.locations ?? []) {
        for (const { node, coverage } of reachOf(location.id)) {
          const draft = draftFor(node, coverage);
          if (!draft.expected.has(event.id)) {
            draft.expected.set(event.id, {
              eventId: event.id, threatType: event.threatType, timing: event.timing,
              probability: event.probability ?? null, expectedFrom: event.expectedFrom ?? null,
              expectedUntil: event.expectedUntil ?? null, evidenceLevel: event.evidenceLevel,
              lastObservedAt: toIso(event.lastObservedAt), note: event.assessmentNote ?? null
            });
          }
        }
      }
      continue;
    }
    // liveThreats() агрегує locations[] через jsonb_agg(DISTINCT …), тож одна локація під двома
    // relation_type приходить двома записами. Згортаємо їх за id, лишаючи найсильніший звʼязок,
    // інакше перший запис порахувався б двічі. `aftermath` тримаємо окремим прапорцем: він мусить
    // пережити злиття навіть тоді, коли сильніший звʼязок — explicit_threat.
    const byLocation = new Map<string, { relationType: RelationType; aftermath: boolean }>();
    for (const location of event.locations ?? []) {
      const previous = byLocation.get(location.id);
      const stronger = previous && RELATION_RANK[previous.relationType] >= RELATION_RANK[location.relationType]
        ? previous.relationType : location.relationType;
      byLocation.set(location.id, {
        relationType: stronger,
        aftermath: (previous?.aftermath ?? false) || location.relationType === 'aftermath'
      });
    }

    const confirmed = CONFIRMING_EVIDENCE.has(event.evidenceLevel);
    const lastConfirmedAt = toIso(event.lastObservedAt);
    const observedAtMs = parsedMs(event.lastObservedAt);

    for (const [locationId, link] of byLocation) {
      for (const { node, coverage } of reachOf(locationId)) {
        const draft = draftFor(node, coverage);
        const existing = draft.threats.get(event.threatType);
        if (!existing) {
          draft.threats.set(event.threatType, {
            threatType: event.threatType,
            status: liveStatus(event.status),
            evidenceLevel: event.evidenceLevel,
            relationType: link.relationType,
            coverage,
            consequence: link.aftermath && confirmed,
            newestAt: observedAtMs,
            lastConfirmedAt,
            directionText: event.directionText,
            events: new Map([[event.id, observedAtMs]])
          });
          continue;
        }
        existing.coverage = strongerCoverage(existing.coverage, coverage);
        if (RELATION_RANK[link.relationType] > RELATION_RANK[existing.relationType]) {
          existing.relationType = link.relationType;
        }
        if (EVIDENCE_RANK[event.evidenceLevel] > EVIDENCE_RANK[existing.evidenceLevel]) {
          existing.evidenceLevel = event.evidenceLevel;
        }
        existing.consequence = existing.consequence || (link.aftermath && confirmed);
        // Напрямок і статус беруться з НАЙНОВІШОЇ події класу — з тієї самої, що дала
        // lastConfirmedAt. Зливати напрямки двох повідомлень не можна: цитата лишається цитатою.
        if (observedAtMs > existing.newestAt) {
          existing.newestAt = observedAtMs;
          existing.lastConfirmedAt = lastConfirmedAt;
          existing.directionText = event.directionText;
          existing.status = liveStatus(event.status);
        }
        existing.events.set(event.id, observedAtMs);
      }
    }
  }

  for (const row of input.assessments) {
    const candidate: TerritoryAssessment = {
      assessmentId: row.id,
      threatType: row.threat_type,
      riskLevel: row.risk_level,
      riskScore: toNumber(row.risk_score),
      indicativePercent: row.indicative_percent,
      assessmentConfidence: row.assessment_confidence,
      horizonEnd: toIso(row.horizon_end),
      generatedAt: toIso(row.generated_at)
    };
    for (const { node, coverage } of reachOf(row.location_id)) {
      const draft = draftFor(node, coverage);
      // «Найсильніша жива оцінка (найвищий riskScore)» — CONTRACT §3.2. riskLevel виводиться зі
      // score у `riskLevel()` (src/domain/classifier.ts), тож рівень і бал не можуть розійтися;
      // решта ключів існує лише для того, щоб вибір лишався однозначним на рівних балах.
      if (!draft.assessment || strongerAssessment(candidate, draft.assessment)) {
        draft.assessment = candidate;
        draft.assessmentCoverage = coverage;
      }
    }
  }

  // Прохід перший: території готові, окрім іконок.
  const built = [...drafts.values()].map((draft) => {
    const threats = [...draft.threats.values()].map((threat): TerritoryThreat => ({
      threatType: threat.threatType,
      status: threat.status,
      evidenceLevel: threat.evidenceLevel,
      relationType: threat.relationType,
      asserted: ASSERTING_RELATIONS.has(threat.relationType),
      coverage: threat.coverage,
      count: threat.events.size,
      lastConfirmedAt: threat.lastConfirmedAt,
      directionText: threat.directionText,
      consequence: threat.consequence,
      eventIds: [...threat.events.entries()].sort(byRecencyThenId).slice(0, MAX_TERRITORY_EVENT_IDS)
        .map(([id]) => id)
    }));
    const alertSince = draft.alerts.reduce<string | null>(
      (earliest, alert) => earliest == null || alert.startedAt < earliest ? alert.startedAt : earliest, null
    );
    // Найближчі першими, за рівної актуальності — ймовірніші; не більше шести: це рядки панелі.
    const expected = [...draft.expected.values()]
      .sort((left, right) => (TIMING_RANK[left.timing] - TIMING_RANK[right.timing])
        || ((right.probability ?? 0) - (left.probability ?? 0)))
      .slice(0, MAX_TERRITORY_EXPECTED);
    const assessment = draft.assessment;
    const state: TerritoryState = {
      locationId: draft.node.id,
      tier: draft.node.type as TerritoryTier,
      name: draft.node.nameUk,
      parentId: draft.node.parentId,
      coverage: draft.coverage,
      alertActive: draft.alerts.length > 0,
      alertSince,
      alerts: draft.alerts,
      threats,
      expected,
      threatActive: threats.some((threat) => threat.asserted),
      consequences: threats.some((threat) => threat.consequence),
      assessment,
      analyticStatus: assessment && ANALYTIC_CONTOUR_FLOOR.has(assessment.riskLevel)
        ? assessment.riskLevel : 'none',
      icons: [],
      iconOverflow: 0,
      publishedAt: input.publishedAt
    };
    return { state, assessmentCoverage: draft.assessmentCoverage };
  });

  // Прохід другий: пари (клас, рівень), які несе більше ніж ANALYTIC_FANOUT_LIMIT територій. Така
  // ширина не приходить із географії — це загальнонаціональна класифікація, розсіяна ingestThreat
  // на кожну область, і вона не має права стати гліфом на 27 полігонах.
  const pairCounts = new Map<string, number>();
  for (const { state } of built) {
    if (!state.assessment) continue;
    const pair = `${state.assessment.threatType}|${state.assessment.riskLevel}`;
    pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
  }
  const broadAnalyticPairs = new Set<string>(
    [...pairCounts.entries()].filter(([, count]) => count > ANALYTIC_FANOUT_LIMIT).map(([pair]) => pair)
  );

  // Прохід третій: іконки і порядок панелі.
  for (const { state, assessmentCoverage } of built) {
    const stack = rankThreatIcons(
      iconCandidatesFor({
        coverage: state.coverage,
        threats: state.threats,
        assessment: state.assessment,
        assessmentCoverage
      }, input.now, broadAnalyticPairs),
      input.now
    );
    state.icons = stack.icons;
    state.iconOverflow = stack.overflow;
    // Панель відкривається тим самим порядком, що й іконки, які щойно натиснули. Загроза, яка не
    // може стати іконкою (`mentioned`), не має права стояти вище за ту, що стала: інакше список і
    // стек іконок розійшлися б у тому, що на цій території найсильніше.
    state.threats.sort((left, right) =>
      (Number(right.asserted) - Number(left.asserted))
      || compareThreatIcons(threatCandidate(left), threatCandidate(right), input.now));
  }

  // Порядок територій — за locationId. Він стабільний між знімками, тож diff payload'у показує
  // зміну стану, а не перестановку рядків.
  return built.map(({ state }) => state).sort((left, right) =>
    left.locationId < right.locationId ? -1 : left.locationId > right.locationId ? 1 : 0);
}
