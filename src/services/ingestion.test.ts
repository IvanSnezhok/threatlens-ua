import { readFileSync } from 'node:fs';
import { Registry } from 'prom-client';
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import {
  AERIAL_MIRROR_MIN_POLL_SECONDS, ALERTS_IN_UA_MIN_POLL_SECONDS, SLOW_LEG_INTERVAL_SECONDS,
  UKRAINE_ALARM_MIN_POLL_SECONDS, alertLegIntervalMs, escapeLikePattern, ingestionLegs,
  locationNameCandidates, normalizeAlarmResponse, pickLocationMatch, registerAlertChannelMetrics,
  strongestDeclaredAlert, unknownPlaceCandidates
} from './ingestion.js';

describe('official alert normalization', () => {
  it('normalizes a nested active-alert snapshot', () => {
    const result = normalizeAlarmResponse([{ regionId: '31', regionName: 'Київ', activeAlerts: [
      { id: 'air-1', type: 'AIR', lastUpdate: '2026-01-02T03:04:05Z' }
    ] }]);
    expect(result.candidateCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      externalId: 'air-1', locationKey: '31', locationName: 'Київ', alertType: 'air_raid', active: true
    });
  });

  it('normalizes explicit inactive records without inventing activity', () => {
    const result = normalizeAlarmResponse({ alerts: [{
      region_id: 'ua-53', region_name: 'Полтавська область', alert_type: 'ARTILLERY', status: 'inactive'
    }] });
    expect(result.records[0]).toMatchObject({ locationKey: 'ua-53', alertType: 'artillery', active: false });
  });
});

/**
 * `alerts.in.ua` (`/v1/alerts/active.json`) таким, яким його віддає живий API, а не таким, яким його
 * зручно уявляти.
 *
 * `tests/fixtures/alerts-in-ua-active-levels.json` — сім тривог, вирізаних без правок зі зрізу
 * 22.09.2026 на 43 активні. Кожна форма рядка там по одному разу: область без `threats[]`, два
 * райони з різним кольором і різновидом, третій район без різновиду, громада з `location_raion`,
 * місто, і два типи, які не є повітряною тривогою.
 *
 * Регресія, яку тримає цей блок: нормалізатор брав `id` рядка за ключ локації й не читав
 * `location_title` взагалі. Кожен рядок ставав «місцем» з номером ТРИВОГИ замість назви, жоден не
 * лягав на каталог, і джерело падало на «no provider locations matched local locations (8757, 28288,
 * 76016, 76017, 185413)» — з першого опитування й назавжди. Відсутність `finished_at`-гілки при цьому
 * робила б кожну тривогу `active: false`, тож навіть зіставлене тіло записало б погашені тривоги.
 */
const ALERTS_IN_UA = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/alerts-in-ua-active-levels.json', import.meta.url), 'utf8')
) as { alerts: Array<Record<string, unknown>> };

describe('an alerts.in.ua snapshot as the live API sends it', () => {
  const normalized = normalizeAlarmResponse(ALERTS_IN_UA);
  const byAlertId = (id: number) => {
    const record = normalized.records.find((candidate) => candidate.externalId === String(id));
    if (!record) throw new Error(`no record for alert ${id}`);
    return record;
  };

  it('turns every alert into one record carrying the alert id as its external id', () => {
    expect(normalized.candidateCount).toBe(7);
    expect(normalized.records.map((record) => record.externalId))
      .toEqual(['8757', '264928', '265383', '76016', '76017', '265304', '265568']);
  });

  it('names the place from location_title', () => {
    expect(normalized.records.map((record) => record.locationName)).toEqual([
      'Луганська область', 'Покровський район', 'Олександрійський район',
      'Вовчанська територіальна громада', 'Вовчанська територіальна громада', 'м. Марганець',
      'Харківський район'
    ]);
  });

  it('never keys the place by the alert id or by the feed\'s own location_uid', () => {
    // Обидва — числа у власному просторі фіда. `id` — номер тривоги; `location_uid` — нумерація
    // alerts.in.ua («16» — Луганщина, «1313» — Вовчанська), яка з КАТОТТГ не має нічого спільного.
    // Будь-яке з них у `id OR official_code` означало б або тихий промах, або тихий збіг з чужим
    // рядком. Ключа немає зовсім — місце шукається лише за назвою.
    ALERTS_IN_UA.alerts.forEach((raw, index) => {
      const record = normalized.records[index]!;
      expect(record.locationKey).not.toBe(String(raw.id));
      expect(record.locationKey).not.toBe(String(raw.location_uid));
      expect(record.locationKey).not.toBe(String(raw.location_oblast_uid));
    });
    expect(normalized.records.every((record) => record.locationKey === '')).toBe(true);
  });

  it('files a hromada under its raion and everything else under its oblast', () => {
    // Район — вужчий із двох, і лише він відрізняє дві однойменні громади однієї області.
    expect(byAlertId(76016).parentName).toBe('Чугуївський район');
    expect(byAlertId(76017).parentName).toBe('Чугуївський район');
    expect(byAlertId(264928).parentName).toBe('Донецька область');
    expect(byAlertId(265383).parentName).toBe('Кіровоградська область');
    expect(byAlertId(265568).parentName).toBe('Харківська область');
    expect(byAlertId(265304).parentName).toBe('Дніпропетровська область');
    // Область лежить «під собою»: підказка звужує лише нічию, тож тут вона нічого не змінює.
    expect(byAlertId(8757).parentName).toBe('Луганська область');
  });

  it('reads finished_at: null as a standing alert and a date there as a finished one', () => {
    // У цьому тілі немає ні `status`, ні булевого поля — лише `finished_at`. Без нього всі сім
    // рядків були б `active: false`.
    expect(normalized.records.every((record) => record.active)).toBe(true);
    const finished = normalizeAlarmResponse({ alerts: [
      { ...ALERTS_IN_UA.alerts[2], finished_at: '2026-09-22T10:05:00.000Z' }
    ] });
    expect(finished.records[0]).toMatchObject({ externalId: '265383', active: false });
  });

  it('carries the provider start, however old it is', () => {
    // Луганщина під тривогою з 04.04.2022. Це правда про тривогу, а не зіпсоване поле.
    expect(byAlertId(8757).startedAt.toISOString()).toBe('2022-04-04T16:45:39.000Z');
    expect(byAlertId(265568).startedAt.toISOString()).toBe('2026-09-22T16:22:26.217Z');
  });

  it('reads alert_level and derives the kind from threats[] alone', () => {
    expect(byAlertId(8757)).toMatchObject({ alertLevel: 'red', alertKind: null });
    expect(byAlertId(264928)).toMatchObject({ alertLevel: 'red', alertKind: 'missiles' });
    expect(byAlertId(265383)).toMatchObject({ alertLevel: 'yellow', alertKind: 'drones' });
    // Колір без `threats[]` — повне тіло: різновид лишається неназваним, а не здогаданим.
    expect(byAlertId(265568)).toMatchObject({ alertLevel: 'yellow', alertKind: null });
  });

  it('keeps shelling and urban fighting as their own types, never as an air raid', () => {
    // Власні типи — те, що дає `persistOfficialAlertSnapshot` відкинути їх до пошуку місця.
    expect(byAlertId(76016).alertType).toBe('artillery');
    expect(byAlertId(265304).alertType).toBe('artillery');
    expect(byAlertId(76017).alertType).toBe('urban_fighting');
    expect(normalized.records.filter((record) => record.alertType === 'air_raid')
      .map((record) => record.externalId)).toEqual(['8757', '264928', '265383', '265568']);
  });
});

/**
 * Колір і різновид, прочитані з двох форм, які їх несуть, і згорнуті правилом «найсильніший».
 *
 * Значення `threat_type` тут — ті, що їх справді віддає `alerts.in.ua`: зріз 22.09.2026 (51 активна
 * тривога, 31 із `threats[]`) дав рівно `drones` і `unspecified_missiles`.
 */
describe('the colour an alert carries', () => {
  it('reads the level off an alerts.in.ua alert and the kind off its threats', () => {
    const result = normalizeAlarmResponse({ alerts: [{
      region_id: 'ua-32', region_name: 'Київська область', alert_type: 'air_raid', status: 'active',
      alert_level: 'yellow',
      threats: [{ threat_type: 'drones', level: 'yellow', source_message: 'Дронова загроза (жовтий рівень)' }]
    }] });
    expect(result.records[0]).toMatchObject({
      alertType: 'air_raid', active: true, alertLevel: 'yellow', alertKind: 'drones'
    });
  });

  it('names both kinds only when the source named both', () => {
    const both = normalizeAlarmResponse({ alerts: [{
      region_id: 'ua-32', region_name: 'Київська область', status: 'active', alert_level: 'red',
      threats: [{ threat_type: 'drones' }, { threat_type: 'unspecified_missiles' }]
    }] });
    expect(both.records[0]).toMatchObject({ alertLevel: 'red', alertKind: 'drones_missiles' });
  });

  it('leaves the kind unnamed when the level came without threats', () => {
    // 17 із 51 тривоги в зрізі мали колір і жодної загрози в масиві. Колір без різновиду — повне
    // тіло, а не половина: вигадувати різновид ми не маємо права.
    const bare = normalizeAlarmResponse({ alerts: [{
      region_id: 'ua-32', region_name: 'Київська область', status: 'active', alert_level: 'red'
    }] });
    expect(bare.records[0]).toMatchObject({ alertLevel: 'red', alertKind: null });
  });

  it('contributes nothing for a threat type it does not know', () => {
    const unknown = normalizeAlarmResponse({ alerts: [{
      region_id: 'ua-32', region_name: 'Київська область', status: 'active', alert_level: 'red',
      threats: [{ threat_type: 'sabotage_group' }]
    }] });
    expect(unknown.records[0]).toMatchObject({ alertLevel: 'red', alertKind: null });
  });

  it('reads the level off the mirror snapshot body too', () => {
    const mirror = normalizeAlarmResponse({ states: [
      { regionName: 'Луганська область', active: true, alertLevel: 'red' },
      { regionName: 'АР Крим', active: true }
    ] });
    expect(mirror.records[0]).toMatchObject({ alertLevel: 'red', alertKind: null });
    // Дзеркало `threats[]` не має, тож різновид тут `null` при живому кольорі — і це очікувано.
    expect(mirror.records[1]).toMatchObject({ alertLevel: null, alertKind: null });
  });

  it('drops a colour the domain does not know rather than widening the enum', () => {
    const invented = normalizeAlarmResponse({ alerts: [{
      region_id: 'ua-32', region_name: 'Київська область', status: 'active', alert_level: 'crimson'
    }] });
    // Тривога лишається; відкинуто ЛИШЕ прикмету.
    expect(invented.records[0]).toMatchObject({ active: true, alertLevel: null });
  });

  it('leaves Ukraine Alarm v3 colourless, because its body carries no level', () => {
    const v3 = normalizeAlarmResponse([{ regionId: '31', regionName: 'Київ', activeAlerts: [
      { id: 'air-1', type: 'AIR', lastUpdate: '2026-01-02T03:04:05Z' }
    ] }]);
    expect(v3.records[0]).toMatchObject({ alertType: 'air_raid', alertLevel: null, alertKind: null });
  });
});

/**
 * Правило зведення: найсильніший колір серед тих, ХТО ТРИМАЄ, і різновид того рівня — або нічого.
 *
 * Перевіряється без бази, бо це домен, а не SQL: сам запит лише приносить рядки, що тримають
 * тривогу, а рішення ухвалює ця функція.
 */
describe('the level an aggregate concludes', () => {
  it('takes the strongest colour, not the commonest', () => {
    expect(strongestDeclaredAlert([
      { level: 'yellow', kind: 'drones' },
      { level: 'yellow', kind: 'drones' },
      { level: 'red', kind: 'missiles' }
    ])).toEqual({ level: 'red', kind: 'missiles' });
  });

  it('treats silence as weaker than any colour', () => {
    expect(strongestDeclaredAlert([{ level: null, kind: null }, { level: 'yellow', kind: 'drones' }]))
      .toEqual({ level: 'yellow', kind: 'drones' });
  });

  it('refuses to invent a kind when the strongest level disagrees with itself', () => {
    expect(strongestDeclaredAlert([
      { level: 'red', kind: 'drones' },
      { level: 'red', kind: 'missiles' }
    ])).toEqual({ level: 'red', kind: null });
  });

  it('ignores the kind of a weaker row entirely', () => {
    // Жовтий рядок каже «дрони», червоний мовчить про різновид. Різновид беремо з переможця, тобто
    // не беремо: підписати червону тривогу «дронова» на підставі жовтої — це сказати за джерело.
    expect(strongestDeclaredAlert([
      { level: 'yellow', kind: 'drones' },
      { level: 'red', kind: null }
    ])).toEqual({ level: 'red', kind: null });
  });

  it('says nothing about an alert nobody coloured', () => {
    expect(strongestDeclaredAlert([])).toEqual({ level: null, kind: null });
    expect(strongestDeclaredAlert([{ level: null, kind: null }])).toEqual({ level: null, kind: null });
  });
});

describe('the spellings tried for one published label', () => {
  it('leaves an ordinary label alone', () => {
    expect(locationNameCandidates('Харківський район')).toEqual(['Харківський район']);
    expect(locationNameCandidates('  Полтавська  область.  ')).toEqual(['Полтавська область']);
  });

  it('reads a compound city-and-hromada label as the hromada first', () => {
    // Обидві половини тепер називають справжній рядок каталогу. Ширша з них — громада: тривога
    // накриває її цілком, і звузити офіційну тривогу до міста всередині означало б сказати менше,
    // ніж сказало джерело. Місто лишається запасним варіантом.
    expect(locationNameCandidates('м. Харків та Харківська територіальна громада')).toEqual([
      'м. Харків та Харківська територіальна громада',
      'Харківська територіальна громада',
      'м. Харків'
    ]);
  });
});

describe('location LIKE escaping', () => {
  it('neutralizes LIKE metacharacters supplied by the provider', () => {
    expect(escapeLikePattern('%')).toBe('\\%');
    expect(escapeLikePattern('_')).toBe('\\_');
    expect(escapeLikePattern('\\')).toBe('\\\\');
    expect(escapeLikePattern('київ_%')).toBe('київ\\_\\%');
  });

  it('leaves ordinary Ukrainian names untouched', () => {
    expect(escapeLikePattern('львівська область')).toBe('львівська область');
  });
});

describe('location match resolution', () => {
  const exact = { id: 'ua-32', type: 'oblast', match_rank: 0 };
  const alias = { id: 'ua-14', type: 'oblast', match_rank: 1 };
  const prefix = { id: 'ua-51', type: 'raion', match_rank: 2 };

  it('prefers an exact name over an alias or prefix hit', () => {
    expect(pickLocationMatch([prefix, alias, exact])).toBe('ua-32');
  });

  it('prefers an alias over a prefix hit', () => {
    expect(pickLocationMatch([prefix, alias])).toBe('ua-14');
  });

  it('accepts a prefix hit only when it is unique', () => {
    expect(pickLocationMatch([prefix])).toBe('ua-51');
    expect(pickLocationMatch([prefix, { id: 'ua-53', type: 'raion', match_rank: 2 }])).toBeNull();
  });

  it('rejects an ambiguous prefix hit instead of falling back to a lower-ranked candidate', () => {
    expect(pickLocationMatch([
      { id: 'ua-51', type: 'oblast', match_rank: 2 },
      { id: 'ua-53', type: 'raion', match_rank: 2 }
    ])).toBeNull();
  });

  it('breaks exact-match ties towards a single administrative unit', () => {
    expect(pickLocationMatch([
      { id: 'ua-32-hromada', type: 'hromada', match_rank: 0 },
      { id: 'ua-32', type: 'special_city', match_rank: 0 }
    ])).toBe('ua-32');
  });

  it('rejects exact matches that stay ambiguous after the administrative tie-break', () => {
    expect(pickLocationMatch([
      { id: 'ua-32', type: 'oblast', match_rank: 0 },
      { id: 'ua-80', type: 'special_city', match_rank: 0 }
    ])).toBeNull();
    expect(pickLocationMatch([
      { id: 'ua-51-a', type: 'city', match_rank: 0 },
      { id: 'ua-53-a', type: 'city', match_rank: 0 }
    ])).toBeNull();
  });

  it('returns null when nothing matched', () => {
    expect(pickLocationMatch([])).toBeNull();
  });
});

/**
 * The wiring, not the values.
 *
 * A metric that is written but never registered is invisible on `/metrics` and looks exactly
 * like a quiet system, which is the failure mode ops instrumentation exists to prevent. This test
 * asserts only that every name this module owns — including the shadow-classifier ones that ride
 * along on the same call — reaches a registry, and that calling the registration twice is safe,
 * because `src/api/server.ts` is not the only place that may ever want a registry.
 */
describe('the parent hint a feed nests a label under', () => {
  it('carries the enclosing region from a snapshot body', () => {
    const result = normalizeAlarmResponse({ states: [
      { regionName: 'Нікопольська територіальна громада', active: true, parentName: 'Дніпропетровська область' }
    ] });
    expect(result.records[0]).toMatchObject({
      locationName: 'Нікопольська територіальна громада', parentName: 'Дніпропетровська область'
    });
  });

  it('omits it rather than carrying an empty string, so the resolver cannot narrow on nothing', () => {
    const result = normalizeAlarmResponse({ states: [
      { regionName: 'Полтавський район', active: true, parentName: '   ' }
    ] });
    expect(result.records[0]).not.toHaveProperty('parentName');
  });
});

describe('metric registration', () => {
  const expected = [
    'threatlens_aerial_mirror_polls_total',
    'threatlens_aerial_mirror_raw_regions',
    'threatlens_alert_channel_messages_total',
    'threatlens_alert_channel_stuck_alerts_total',
    'threatlens_alert_stale_sources_ignored_total',
    'threatlens_monitor_messages_total',
    'threatlens_messages_stale_for_delivery_total',
    'threatlens_classification_log_failures_total',
    'threatlens_threat_withdrawals_total',
    'threatlens_classifications_total',
    'threatlens_classification_rejections_total',
    'threatlens_threat_to_de_escalation_total',
    'threatlens_shadow_attempts_total',
    'threatlens_shadow_outcomes_total',
    'threatlens_analytical_promotions_blocked_total',
    'threatlens_retrospective_gate_attempts_total',
    'threatlens_retrospective_gate_outcomes_total',
    'threatlens_ingestion_leg_runs_total',
    'threatlens_ingestion_leg_interval_seconds',
    'threatlens_ingestion_leg_duration_seconds',
    'threatlens_alert_pokes_total',
    // Скільки обласних «тривог», яких влада не оголошувала, адаптер відкинув на останньому опитуванні
    // (міграція 050). Нуль тут — не мета: на ніч із районними тривогами це кілька одиниць.
    'threatlens_aerial_mirror_dropped_rollup_oblasts',
    // Вузли, що тримають тривогу, за кольором (міграція 054). Три ряди й ніколи більше: yellow,
    // red і unknown. Ряд має існувати навіть у нулі — інакше «кольору немає» й «фід перестав слати
    // колір» неможливо розрізнити.
    'threatlens_alert_levels_reported'
  ];

  it('attaches every counter this module owns, model-layer ones included', () => {
    const registry = new Registry();
    registerAlertChannelMetrics(registry);
    const names = registry.getMetricsAsArray().map((metric) => metric.name);
    expect(names).toEqual(expect.arrayContaining(expected));
  });

  it('is safe to call twice on the same registry', () => {
    const registry = new Registry();
    registerAlertChannelMetrics(registry);
    expect(() => registerAlertChannelMetrics(registry)).not.toThrow();
    expect(registry.getMetricsAsArray()).toHaveLength(expected.length);
  });
});

/**
 * The floors, and the fact that no setting can reach past them.
 *
 * `ALERT_POLL_INTERVAL_SECONDS` is bounded by the schema at 2..60, and an operator writing 2 is the
 * whole point of this block: the schema accepts it, `alertLegIntervalMs` clamps it up per provider,
 * and no path exists between the two that could skip the clamp. Each floor is somebody else's
 * published limit — see the block comment beside the constants — so «за скільки секунд» must not be
 * answerable from `/ops` for any of them.
 */
describe('per-provider polling floors', () => {
  const booted = config.ALERT_POLL_INTERVAL_SECONDS;
  afterEach(() => { config.ALERT_POLL_INTERVAL_SECONDS = booted; });

  it('clamps the operator cadence up to each provider floor', () => {
    config.ALERT_POLL_INTERVAL_SECONDS = 2;                // the schema's own minimum
    expect(alertLegIntervalMs(AERIAL_MIRROR_MIN_POLL_SECONDS)).toBe(3000);
    expect(alertLegIntervalMs(ALERTS_IN_UA_MIN_POLL_SECONDS)).toBe(7000);
    expect(alertLegIntervalMs(UKRAINE_ALARM_MIN_POLL_SECONDS)).toBe(15_000);
  });

  it('cannot be configured away by any value the schema accepts', () => {
    for (let seconds = 2; seconds <= 60; seconds += 1) {
      config.ALERT_POLL_INTERVAL_SECONDS = seconds;
      expect(alertLegIntervalMs(AERIAL_MIRROR_MIN_POLL_SECONDS)).toBeGreaterThanOrEqual(3000);
      expect(alertLegIntervalMs(ALERTS_IN_UA_MIN_POLL_SECONDS)).toBeGreaterThanOrEqual(7000);
      expect(alertLegIntervalMs(UKRAINE_ALARM_MIN_POLL_SECONDS)).toBeGreaterThanOrEqual(15_000);
    }
  });

  it('lets an operator slow every leg down past its floor', () => {
    // The clamp is one-directional: floors stop a leg being sped up, never being throttled. An
    // operator responding to a rate-limit incident has to be able to reach 60 s on all three.
    config.ALERT_POLL_INTERVAL_SECONDS = 60;
    expect(alertLegIntervalMs(AERIAL_MIRROR_MIN_POLL_SECONDS)).toBe(60_000);
    expect(alertLegIntervalMs(ALERTS_IN_UA_MIN_POLL_SECONDS)).toBe(60_000);
    expect(alertLegIntervalMs(UKRAINE_ALARM_MIN_POLL_SECONDS)).toBe(60_000);
  });

  it('reads the setting per call, which is what makes the key hot', () => {
    config.ALERT_POLL_INTERVAL_SECONDS = 4;
    expect(alertLegIntervalMs(AERIAL_MIRROR_MIN_POLL_SECONDS)).toBe(4000);
    config.ALERT_POLL_INTERVAL_SECONDS = 30;
    expect(alertLegIntervalMs(AERIAL_MIRROR_MIN_POLL_SECONDS)).toBe(30_000);
  });
});

describe('the leg split', () => {
  const booted = config.ALERT_POLL_INTERVAL_SECONDS;
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  afterEach(() => { config.ALERT_POLL_INTERVAL_SECONDS = booted; });

  const intervals = () => Object.fromEntries(
    ingestionLegs(silent).map((leg) => [leg.name, leg.intervalMs() / 1000])
  );

  it('puts the three alert-state legs on the fast cadence and leaves the backstop at fifteen', () => {
    config.ALERT_POLL_INTERVAL_SECONDS = 4;                // the default
    expect(intervals()).toEqual({
      'aerial-mirror': 4,
      'alerts-in-ua': 7,
      'ukraine-alarm': 15,
      'alert-channel-backstop': SLOW_LEG_INTERVAL_SECONDS
    });
  });

  it('does not move the slow leg when the alert cadence changes', () => {
    config.ALERT_POLL_INTERVAL_SECONDS = 2;
    expect(intervals()['alert-channel-backstop']).toBe(15);
    config.ALERT_POLL_INTERVAL_SECONDS = 60;
    expect(intervals()['alert-channel-backstop']).toBe(15);
  });

  it('names every leg exactly once, because the names are metric labels', () => {
    const names = ingestionLegs(silent).map((leg) => leg.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// --------------------------------------------------------------------------------------------
// Гіпотези про назви місць, яких каталог не має
// --------------------------------------------------------------------------------------------

describe('place candidates from a message the catalogue matched nothing in', () => {
  it('reads a capitalised word inside a sentence as a candidate', () => {
    expect(unknownPlaceCandidates('Ударні БпЛА курсом на Кароліну, будьте уважні'))
      .toEqual(['Кароліну']);
  });

  it('joins adjacent capitalised words into one candidate', () => {
    // «Нова Каховка» — одна пропущена назва, а не дві; оператор читає перелік очима, і два уламки
    // однієї назви коштують йому саме того часу, заради якого цей перелік існує.
    expect(unknownPlaceCandidates('Загроза для Нова Каховка та околиць'))
      .toEqual(['Нова Каховка']);
  });

  it('ignores the first word of a sentence, where a capital letter says nothing', () => {
    expect(unknownPlaceCandidates('Увага! Терміново. Вибухи.')).toEqual([]);
    expect(unknownPlaceCandidates('Ворог підняв борти.')).toEqual([]);
  });

  it('ignores the weapon and agency vocabulary a capital letter otherwise catches', () => {
    // «ППО», «РФ», «БпЛА», «МіГ» — це словник, яким канал пише про зброю; жодне з них не є місцем,
    // і всі чотири ловляться однією ознакою: велика літера не лише перша.
    expect(unknownPlaceCandidates('Працює ППО, збито БпЛА, злетів МіГ-31К з аеродрому РФ')).toEqual([]);
  });

  it('ignores a bearing and an ordinary word the morphology could reach a real name through', () => {
    // `isBlockedPlaceToken` — той самий список, яким каталог відмовляється читати «південним» як
    // Південне і «мені» як Мену. Перелік гіпотез не має показувати те, що система свідомо не читає.
    expect(unknownPlaceCandidates('Ціль йде Південним курсом, і Мені це не подобається')).toEqual([]);
  });

  it('ignores latin words, which on these channels are handles and links', () => {
    expect(unknownPlaceCandidates('Підписуйтеся на Eradar та Monitor')).toEqual([]);
  });

  it('names each candidate once however often the message repeats it', () => {
    expect(unknownPlaceCandidates('По Кароліну йдуть, повторюю, по Кароліну'))
      .toEqual(['Кароліну']);
  });
});
