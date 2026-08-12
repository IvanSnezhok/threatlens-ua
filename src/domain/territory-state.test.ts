import { describe, expect, it } from 'vitest';
import type { LiveEvent, RelationType, ThreatType } from '../types.js';
import {
  composeTerritoryStates,
  type RiskLevel, type TerritoryNode, type TerritoryState
} from './territory-state.js';

/**
 * One pinned clock for the whole file. `composeTerritoryStates` takes `now` as a required input
 * precisely so a test never has to freeze a global — and so the freshness buckets that order the
 * icons mean the same thing here, on the server and in a replay of a recorded snapshot.
 */
const NOW = new Date('2026-08-08T12:00:00.000Z');
const PUBLISHED_AT = '2026-08-08T11:59:45.000Z';
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

/**
 * A three-level slice of the real catalogue: country → oblast/special_city → raion → city.
 * Only `oblast`, `special_city` and `raion` have polygons; `Ірпінь` is the city case that must roll
 * up, and `ua` is the country that must never become geography at all.
 */
const NODES: TerritoryNode[] = [
  { id: 'ua', parentId: null, type: 'country', nameUk: 'Україна' },
  { id: 'ua-32', parentId: 'ua', type: 'oblast', nameUk: 'Київська область' },
  { id: 'ua-32-01', parentId: 'ua-32', type: 'raion', nameUk: 'Бучанський район' },
  { id: 'ua-32-02', parentId: 'ua-32', type: 'raion', nameUk: 'Обухівський район' },
  { id: 'ua-32-03', parentId: 'ua-32', type: 'raion', nameUk: 'Броварський район' },
  { id: 'ua-32-04', parentId: 'ua-32', type: 'raion', nameUk: 'Фастівський район' },
  { id: 'ua-32-05', parentId: 'ua-32', type: 'raion', nameUk: 'Вишгородський район' },
  { id: 'ua-32-01-irpin', parentId: 'ua-32-01', type: 'city', nameUk: 'Ірпінь' },
  { id: 'ua-80', parentId: 'ua', type: 'special_city', nameUk: 'Київ' },
  { id: 'ua-51', parentId: 'ua', type: 'oblast', nameUk: 'Одеська область' },
  { id: 'ua-51-01', parentId: 'ua-51', type: 'raion', nameUk: 'Одеський район' }
];

const nameOf = (id: string): string => NODES.find((node) => node.id === id)?.nameUk ?? id;

type ComposeInput = Parameters<typeof composeTerritoryStates>[0];

const compose = (over: Partial<ComposeInput> = {}): TerritoryState[] => composeTerritoryStates({
  publishedAt: PUBLISHED_AT, now: NOW, nodes: NODES, alerts: [], threats: [], assessments: [], ...over
});

const byLocation = (states: TerritoryState[], locationId: string): TerritoryState => {
  const state = states.find((one) => one.locationId === locationId);
  if (!state) throw new Error(`no territory ${locationId} in [${states.map((one) => one.locationId).join(', ')}]`);
  return state;
};

const alertRow = (over: Partial<ComposeInput['alerts'][number]> = {}): ComposeInput['alerts'][number] => ({
  id: 'alert-1',
  location_id: 'ua-32-01',
  location_name: nameOf('ua-32-01'),
  alert_type: 'air_raid',
  started_at: ago(20 * 60_000),
  ...over
});

const at = (id: string, relationType: RelationType = 'explicit_threat'): LiveEvent['locations'][number] =>
  ({ id, name: nameOf(id), relationType, latitude: null, longitude: null });

const eventRow = (over: Partial<LiveEvent> = {}): LiveEvent => ({
  id: 'event-1',
  threatType: 'uav',
  status: 'active',
  evidenceLevel: 'monitoring',
  origin: 'deterministic',
  title: 'Ударні БпЛА',
  summary: 'Група БпЛА в напрямку області.',
  startedAt: ago(30 * 60_000),
  lastObservedAt: ago(5 * 60_000),
  validUntil: null,
  directionText: null,
  geometry: null,
  geometrySemantics: null,
  locations: [at('ua-32-01')],
  sources: [],
  ...over
});

const assessmentRow = (
  over: Partial<ComposeInput['assessments'][number]> = {}
): ComposeInput['assessments'][number] => ({
  id: 'assessment-1',
  location_id: 'ua-32-01',
  threat_type: 'uav',
  risk_level: 'high',
  risk_score: '7.2',
  indicative_percent: null,
  assessment_confidence: 'medium',
  horizon_end: new Date(NOW.getTime() + 3 * 60 * 60_000).toISOString(),
  generated_at: ago(10 * 60_000),
  ...over
});

describe('composeTerritoryStates — coverage, and the no-invented-geography rule', () => {
  it('lights a named raion directly and its oblast only partially', () => {
    const states = compose({ alerts: [alertRow()] });
    expect(states.map((one) => one.locationId)).toEqual(['ua-32', 'ua-32-01']);

    const raion = byLocation(states, 'ua-32-01');
    expect(raion.coverage).toBe('direct');
    expect(raion.tier).toBe('raion');
    expect(raion.name).toBe('Бучанський район');
    expect(raion.alertActive).toBe(true);
    expect(raion.alertSince).toBe(ago(20 * 60_000));
    expect(raion.publishedAt).toBe(PUBLISHED_AT);

    const oblast = byLocation(states, 'ua-32');
    expect(oblast.coverage).toBe('partial');
    expect(oblast.alertActive).toBe(true);
    // Полігон області приглушений, але рядок панелі називає ту територію, яку назвало джерело.
    expect(oblast.alerts).toEqual([{
      alertType: 'air_raid',
      startedAt: ago(20 * 60_000),
      locationId: 'ua-32-01',
      locationName: 'Бучанський район',
      coverage: 'partial'
    }]);
  });

  it('rolls a city alert up to the nearest territory that has a polygon', () => {
    const states = compose({
      alerts: [alertRow({ location_id: 'ua-32-01-irpin', location_name: 'Ірпінь' })]
    });
    // Саме місто не має контуру, тож його немає і в territories[].
    expect(states.map((one) => one.locationId)).toEqual(['ua-32', 'ua-32-01']);
    expect(byLocation(states, 'ua-32-01').coverage).toBe('unmapped');
    expect(byLocation(states, 'ua-32').coverage).toBe('partial');
  });

  it('resolves a hromada mention to its raion', () => {
    // Громад немає в каталозі взагалі (src/services/location-catalog.ts): алiас громади
    // розвʼязується в район ще до цього згортання, тож сюди приходить уже id району.
    const states = compose({ alerts: [alertRow({ location_id: 'ua-32-02', location_name: nameOf('ua-32-02') })] });
    expect(byLocation(states, 'ua-32-02').coverage).toBe('direct');

    // А id, якого в каталозі немає, не засвічує нічого — вигадувати предка немає з чого.
    expect(compose({ alerts: [alertRow({ location_id: 'ua-32-02-hromada' })] })).toEqual([]);
  });

  it('produces no territory and no icon for a national-scope threat', () => {
    expect(compose({ threats: [eventRow({ locations: [at('ua')] })] })).toEqual([]);
    expect(compose({ alerts: [alertRow({ location_id: 'ua', location_name: 'Україна' })] })).toEqual([]);
  });

  it('marks every explicitly named raion of one event and no others', () => {
    const states = compose({
      threats: [eventRow({
        evidenceLevel: 'official',
        locations: ['ua-32-01', 'ua-32-02', 'ua-32-03', 'ua-32-04', 'ua-32-05'].map((id) => at(id))
      })]
    });
    expect(states.filter((one) => one.coverage === 'direct').map((one) => one.locationId))
      .toEqual(['ua-32-01', 'ua-32-02', 'ua-32-03', 'ua-32-04', 'ua-32-05']);
    expect(states.filter((one) => one.coverage === 'partial').map((one) => one.locationId)).toEqual(['ua-32']);
    // Одеська область не згадана — її в знімку немає взагалі.
    expect(states.some((one) => one.locationId.startsWith('ua-51'))).toBe(false);
  });

  it('keeps a territory once when one event names it under two relation types', () => {
    const states = compose({
      threats: [eventRow({
        evidenceLevel: 'official',
        locations: [at('ua-32-01', 'explicit_threat'), at('ua-32-01', 'aftermath')]
      })]
    });
    const raion = byLocation(states, 'ua-32-01');
    expect(raion.threats).toHaveLength(1);
    expect(raion.threats[0]!.relationType).toBe('explicit_threat');
    expect(raion.threats[0]!.count).toBe(1);
    // `aftermath` мусить пережити злиття навіть тоді, коли сильніший звʼязок — explicit_threat.
    expect(raion.threats[0]!.consequence).toBe(true);
    expect(raion.consequences).toBe(true);
  });
});

describe('composeTerritoryStates — threat rows', () => {
  it('a mentioned-only location gets no threat polygon and no icon', () => {
    const states = compose({
      threats: [eventRow({ evidenceLevel: 'official', locations: [at('ua-32-01', 'mentioned')] })]
    });
    const raion = byLocation(states, 'ua-32-01');
    // Територія існує — рядок «згадано джерелом» у панелі лишається, втрачаємо лише заяву.
    expect(raion.threats).toHaveLength(1);
    expect(raion.threats[0]!.asserted).toBe(false);
    expect(raion.threatActive).toBe(false);
    expect(raion.icons).toEqual([]);
    expect(raion.iconOverflow).toBe(0);
  });

  it('a monitoring-evidence aftermath event produces consequences: false', () => {
    const monitoring = compose({
      threats: [eventRow({ evidenceLevel: 'monitoring', locations: [at('ua-32-01', 'aftermath')] })]
    });
    const reported = byLocation(monitoring, 'ua-32-01');
    expect(reported.threats[0]!.asserted).toBe(true);
    expect(reported.threats[0]!.consequence).toBe(false);
    expect(reported.consequences).toBe(false);
    expect(reported.icons[0]!.tone).toBe('reported');

    // Та сама подія з офіційного джерела — і тільки тоді це «підтверджені наслідки».
    const official = compose({
      threats: [eventRow({ evidenceLevel: 'official', locations: [at('ua-32-01', 'aftermath')] })]
    });
    const confirmed = byLocation(official, 'ua-32-01');
    expect(confirmed.threats[0]!.consequence).toBe(true);
    expect(confirmed.consequences).toBe(true);
    expect(confirmed.icons[0]!.tone).toBe('consequence');
  });

  it("directionText is the newest contributing event's, never merged", () => {
    const older = eventRow({
      id: 'event-old', lastObservedAt: ago(40 * 60_000), directionText: 'у напрямку Києва'
    });
    const newer = eventRow({ id: 'event-new', lastObservedAt: ago(4 * 60_000), directionText: null });

    const withoutDirection = byLocation(compose({ threats: [older, newer] }), 'ua-32-01');
    expect(withoutDirection.threats[0]!.count).toBe(2);
    expect(withoutDirection.threats[0]!.lastConfirmedAt).toBe(ago(4 * 60_000));
    expect(withoutDirection.threats[0]!.directionText).toBeNull();
    expect(withoutDirection.threats[0]!.eventIds).toEqual(['event-new', 'event-old']);

    // І навпаки: коли напрямок несе саме найновіша подія, беремо його дослівно й самого.
    const withDirection = byLocation(compose({
      threats: [older, { ...newer, directionText: 'у напрямку Житомира' }]
    }), 'ua-32-01');
    expect(withDirection.threats[0]!.directionText).toBe('у напрямку Житомира');
  });
});

describe('composeTerritoryStates — icons', () => {
  it('gives a partial territory no icons at all', () => {
    const states = compose({
      alerts: [alertRow()],
      threats: [eventRow({ evidenceLevel: 'official', locations: [at('ua-32-01')] })]
    });
    expect(byLocation(states, 'ua-32-01').icons).toHaveLength(1);

    const oblast = byLocation(states, 'ua-32');
    expect(oblast.coverage).toBe('partial');
    expect(oblast.icons).toEqual([]);
    expect(oblast.iconOverflow).toBe(0);
  });

  it('never gives an alert-lit oblast an icon for a threat named only in its raion', () => {
    // `TerritoryState.coverage` — найсильніше покриття З УСІХ сімейств, тож область під власною
    // офіційною тривогою має `direct` навіть тоді, коли загрозу назвали лише для району в ній.
    // Гліф класу зброї на такій області був би заявою, якої джерело не робило (CONTRACT §6.5).
    const states = compose({
      alerts: [alertRow({ location_id: 'ua-32', location_name: nameOf('ua-32') })],
      threats: [eventRow({ evidenceLevel: 'official', locations: [at('ua-32-01')] })]
    });
    const oblast = byLocation(states, 'ua-32');
    expect(oblast.coverage).toBe('direct');
    expect(oblast.threats[0]!.coverage).toBe('partial');
    expect(oblast.threatActive).toBe(true);
    expect(oblast.icons).toEqual([]);

    expect(byLocation(states, 'ua-32-01').icons).toHaveLength(1);
  });

  it('drops an analytic candidate when a live event of that class exists', () => {
    const states = compose({
      threats: [eventRow({ evidenceLevel: 'official', locations: [at('ua-32-01')] })],
      assessments: [assessmentRow({ threat_type: 'uav', risk_level: 'high', risk_score: '7.2' })]
    });
    const raion = byLocation(states, 'ua-32-01');
    expect(raion.icons).toHaveLength(1);
    expect(raion.icons[0]!.tone).toBe('confirmed');
    expect(raion.analyticStatus).toBe('high');
  });

  it('ignores a background-level assessment', () => {
    const states = compose({
      assessments: [assessmentRow({ risk_level: 'background', risk_score: '1.4' })]
    });
    const raion = byLocation(states, 'ua-32-01');
    expect(raion.analyticStatus).toBe('none');
    expect(raion.icons).toEqual([]);
  });

  it('an assessment below significant never becomes an icon', () => {
    // `elevated` малює контур — але не гліф: контур це підказка про територію, гліф це заява
    // про клас зброї, і пороги в них різні.
    const elevated = byLocation(compose({
      assessments: [assessmentRow({ risk_level: 'elevated', risk_score: '3.1' })]
    }), 'ua-32-01');
    expect(elevated.analyticStatus).toBe('elevated');
    expect(elevated.icons).toEqual([]);

    const significant = byLocation(compose({
      assessments: [assessmentRow({ risk_level: 'significant', risk_score: '5.4' })]
    }), 'ua-32-01');
    expect(significant.analyticStatus).toBe('significant');
    expect(significant.icons).toHaveLength(1);
    expect(significant.icons[0]!.tone).toBe('analytic');
    expect(significant.icons[0]!.evidenceLevel).toBeNull();
    expect(significant.icons[0]!.lastConfirmedAt).toBe(ago(10 * 60_000));
  });

  it('a national-scope posture never produces 27 icon stacks', () => {
    // ingestThreat розсіює загальнонаціональну класифікацію на КОЖНУ область як national_posture,
    // і з неї виходять 27 `direct` аналітичних територій. Ширина, якої не давала географія, не
    // має права стати географією.
    const oblasts = (count: number): TerritoryNode[] => Array.from({ length: count }, (_, index) => ({
      id: `ua-o${String(index + 1).padStart(2, '0')}`,
      parentId: 'ua',
      type: 'oblast',
      nameUk: `Область ${index + 1}`
    }));
    const posture = (nodes: TerritoryNode[]): ComposeInput['assessments'] => nodes.map((node, index) =>
      assessmentRow({ id: `assessment-${index}`, location_id: node.id, threat_type: 'uav', risk_level: 'high' }));

    const wide = oblasts(27);
    const fannedOut = compose({
      nodes: [NODES[0]!, ...wide],
      assessments: posture(wide)
    });
    expect(fannedOut).toHaveLength(27);
    expect(fannedOut.every((one) => one.analyticStatus === 'high')).toBe(true);
    expect(fannedOut.every((one) => one.icons.length === 0)).toBe(true);
    expect(fannedOut.every((one) => one.iconOverflow === 0)).toBe(true);

    // Рівно на порозі (20 територій) гліф ще є — інакше тест ловив би не поріг, а щось інше.
    const narrow = oblasts(20);
    const localised = compose({ nodes: [NODES[0]!, ...narrow], assessments: posture(narrow) });
    expect(localised).toHaveLength(20);
    expect(localised.every((one) => one.icons.length === 1)).toBe(true);
  });

  it('orders threats[] by the icon comparator', () => {
    const states = compose({
      threats: [
        eventRow({ id: 'e-uav', threatType: 'uav', evidenceLevel: 'monitoring', locations: [at('ua-32-01')] }),
        eventRow({ id: 'e-mortar', threatType: 'mortar', evidenceLevel: 'official', locations: [at('ua-32-01')] }),
        eventRow({ id: 'e-ballistic', threatType: 'ballistic_missile', evidenceLevel: 'official', locations: [at('ua-32-01')] }),
        eventRow({ id: 'e-artillery', threatType: 'artillery', evidenceLevel: 'monitoring', locations: [at('ua-32-01')] })
      ]
    });
    const raion = byLocation(states, 'ua-32-01');
    expect(raion.threats).toHaveLength(4);
    expect(raion.icons).toHaveLength(3);
    expect(raion.iconOverflow).toBe(1);
    expect(raion.threats.map((one) => one.threatType).slice(0, 3))
      .toEqual(raion.icons.map((one) => one.threatType));
    // Доказовість вище за небезпеку: офіційний міномет випереджає моніторингових БпЛА.
    expect(raion.icons.map((one) => one.threatType))
      .toEqual<ThreatType[]>(['ballistic_missile', 'mortar', 'uav']);
  });

  it('territories[] order matches icons[] order', () => {
    // Для кожної території список панелі відкривається рівно тими класами, які стали іконками:
    // інакше користувач натиснув би на гліф і побачив би вгорі списку інший клас.
    const states = compose({
      alerts: [alertRow()],
      threats: [
        eventRow({ id: 'e-1', threatType: 'cruise_missile', evidenceLevel: 'official', locations: [at('ua-32-01')] }),
        eventRow({ id: 'e-2', threatType: 'uav', evidenceLevel: 'monitoring', locations: [at('ua-32-01'), at('ua-51-01')] }),
        eventRow({ id: 'e-3', threatType: 'mlrs', evidenceLevel: 'confirmed', locations: [at('ua-51-01', 'mentioned')] })
      ]
    });
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) {
      const asserted = state.threats.filter((one) => one.asserted).map((one) => one.threatType);
      expect(state.icons.map((one) => one.threatType)).toEqual(asserted.slice(0, state.icons.length));
    }
  });

  it('two calls with the same now and the same rows produce byte-identical icons[]', () => {
    const input: Partial<ComposeInput> = {
      alerts: [alertRow(), alertRow({ id: 'alert-2', location_id: 'ua-51-01', location_name: nameOf('ua-51-01') })],
      threats: [
        eventRow({ id: 'e-1', threatType: 'ballistic_missile', evidenceLevel: 'official', locations: [at('ua-32-01'), at('ua-51-01', 'aftermath')] }),
        eventRow({ id: 'e-2', threatType: 'uav', evidenceLevel: 'monitoring', lastObservedAt: ago(2 * 60_000), locations: [at('ua-32-01-irpin')] }),
        eventRow({ id: 'e-3', threatType: 'mortar', evidenceLevel: 'confirmed', locations: [at('ua-51-01')] })
      ],
      assessments: [
        assessmentRow({ id: 'r-1', location_id: 'ua-32-02', threat_type: 'cruise_missile', risk_level: 'very_high', risk_score: '8.8' }),
        assessmentRow({ id: 'r-2', location_id: 'ua-51-01', threat_type: 'aviation', risk_level: 'significant', risk_score: '5.1' })
      ]
    };
    const first = compose(input);
    const second = compose(input);
    expect(first.some((one) => one.icons.length > 0)).toBe(true);
    expect(JSON.stringify(first.map((one) => one.icons)))
      .toBe(JSON.stringify(second.map((one) => one.icons)));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe('composeTerritoryStates — analytic status', () => {
  it('keeps the strongest live assessment and reports its level as the contour', () => {
    const levels: Array<[RiskLevel, string]> = [['elevated', '3.2'], ['very_high', '9.1'], ['significant', '5.0']];
    const states = compose({
      assessments: levels.map(([risk_level, risk_score], index) =>
        assessmentRow({ id: `assessment-${index}`, risk_level, risk_score, threat_type: 'cruise_missile' }))
    });
    const raion = byLocation(states, 'ua-32-01');
    expect(raion.assessment?.riskLevel).toBe('very_high');
    expect(raion.assessment?.riskScore).toBe(9.1);
    expect(raion.analyticStatus).toBe('very_high');
  });
});
