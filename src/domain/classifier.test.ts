import { describe, expect, it } from 'vitest';
import { classifyMessage, isDeEscalation, isSignificant, riskLevel } from './classifier.js';

const locations = [
  { id: 'ua-80', name: 'Київ', aliases: ['києва', 'києві'] },
  { id: 'ua-59', name: 'Сумська область', aliases: ['сумщина', 'сумщині'] },
  { id: 'ua-51', name: 'Одеська область', aliases: ['одещина', 'одещині'] },
  { id: 'ua-city-odesa', name: 'Одеса', aliases: ['одеси', 'одесі', 'одесу'] },
  { id: 'ua-53', name: 'Полтавська область', aliases: ['полтавщина', 'полтавщині'] },
  { id: 'ua-63', name: 'Харківська область', aliases: ['харківщина', 'харківщині'] },
  { id: 'ua-43', name: 'Автономна Республіка Крим', aliases: ['крим', 'криму'] },
  { id: 'test-kotelva', name: 'Котельва', aliases: ['котельві'] },
  { id: 'test-bohodukhiv', name: 'Богодухів', aliases: ['богодухова', 'богодухові'] },
  { id: 'test-brovary', name: 'Бровари', aliases: ['броварів', 'броварах'] },
  { id: 'test-boryspil', name: 'Бориспіль', aliases: ['борисполя', 'борисполі'] },
  { id: 'test-kyrykivka', name: 'Кириківка', aliases: ['кириківки'] },
  { id: 'test-trostianets', name: 'Тростянець', aliases: ['тростянця'] },
  { id: 'test-huty', name: 'Гути', aliases: ['гутів'] }
];

const classify = (text: string) => classifyMessage(text, locations);

describe('classifyMessage', () => {
  it('recognizes a reported direction without claiming a target', () => {
    const result = classify('Ударні БпЛА у напрямку Києва');
    expect(result.threatType).toBe('uav');
    expect(result.locations[0]).toMatchObject({ id: 'ua-80', relationType: 'reported_direction' });
    expect(result.directionText).toContain('у напрямку Києва');
  });

  it('recognizes ballistic threat and regional alias', () => {
    const result = classify('Загроза балістики для Сумщини');
    expect(result.threatType).toBe('ballistic_missile');
    expect(result.locations[0]?.id).toBe('ua-59');
  });

  it('turns strategic aviation activity into a national cruise-missile signal', () => {
    const result = classify('Зафіксовано зліт групи Ту-95МС з аеродрому на території РФ.');
    expect(result.threatType).toBe('cruise_missile');
    expect(result.signalThreatTypes).toContain('cruise_missile');
    expect(result.nationalScope).toBe(true);
    expect(result.indicators).toContain('зліт стратегічної авіації');
  });

  it('keeps all component threat types for combined signals', () => {
    const result = classify('Робота ворожої ППО та активність установок С-400.');
    expect(result.threatType).toBe('combined');
    expect(result.signalThreatTypes).toEqual(expect.arrayContaining(['ballistic_missile', 'cruise_missile']));
  });

  it('reads the national warning shape the Air Force publishes', () => {
    const result = classify('Загроза застосування балістичного озброєння!');
    expect(result.threatType).toBe('ballistic_missile');
    expect(result.nationalScope).toBe(true);
    expect(isSignificant(result)).toBe(true);
  });

  it('maps risk levels deterministically', () => {
    expect(riskLevel(0)).toBe('background');
    expect(riskLevel(3.5)).toBe('elevated');
    expect(riskLevel(8)).toBe('very_high');
  });
});

/**
 * Verbatim shapes from the OSINT monitoring channels.
 *
 * These feeds are not a threat wire: they carry memes, fundraisers, commentary and reporting about
 * events on the other side of the border between the situation reports. The classifier previously
 * treated any message containing a threat word as a threat, which is why each of these is pinned.
 */
describe('classifyMessage on monitoring-channel noise', () => {
  it('does not turn a report about a Russian city into a Ukrainian threat', () => {
    const result = classify('Брянськ, поки що росія 7 серпня 2026 року. Над містом дим від пожежі');
    expect(result.intent).toBe('none');
    expect(result.nationalScope).toBe(false);
    expect(result.locations).toEqual([]);
    expect(isSignificant(result)).toBe(false);
  });

  it('does not publish enemy air defence over a Russian city as a country-wide threat', () => {
    // The indicator matches, no Ukrainian location resolves, and before the foreign-place guard the
    // result was a threat "по всій Україні" every time a channel reported explosions in Russia.
    const result = classify('Курськ — робота ворожої ППО, вибухи в місті');
    expect(result.nationalScope).toBe(false);
    expect(isSignificant(result)).toBe(false);
  });

  it('still reads a launch report that names a Russian airfield', () => {
    // The other side of the same guard: launch activity is observed abroad by definition, and
    // suppressing it would discard the earliest warning this system gets.
    const result = classify('Зафіксовано зліт групи Ту-95МС з аеродрому Енгельс.');
    expect(result.nationalScope).toBe(true);
    expect(result.indicators).toContain('зліт стратегічної авіації');
    expect(isSignificant(result)).toBe(true);
  });

  it('ignores a meme that carries a threat word', () => {
    const result = classify('Підбірка мемів про шахед на вечір 😂');
    expect(result.intent).toBe('none');
    expect(isSignificant(result)).toBe(false);
  });

  it('ignores a fundraiser that mentions drones', () => {
    const result = classify('Збір на дрони для 47 бригади. Реквізити у коментарях. Монобанк.');
    expect(isSignificant(result)).toBe(false);
  });

  it('refuses to raise a threat that names no place, however threat-shaped', () => {
    // The structural backstop behind the marker-based satire guard: a meme with no humour marker
    // still names nowhere, and a threat event has to be somewhere.
    const result = classify('Шахед');
    expect(result.threatType).toBe('uav');
    expect(isSignificant(result)).toBe(false);
  });

  it('keeps a satirical framing that also carries an operational cue', () => {
    const result = classify('😂 Мем меми, але шахед курсом на Одесу');
    expect(result.threatType).toBe('uav');
    expect(result.locations.map((location) => location.id)).toContain('ua-city-odesa');
  });
});

describe('classifyMessage on telegraphic and conversational styles', () => {
  it('reads a conversational ballistic report', () => {
    const result = classify('Ймовірно вихід балістики з Криму. Якщо Онікс, є 4 хвилини звалити');
    expect(result.signalThreatTypes).toEqual(expect.arrayContaining(['ballistic_missile', 'cruise_missile']));
    expect(result.locations.map((location) => location.id)).toContain('ua-43');
    expect(isSignificant(result)).toBe(true);
  });

  it('reads a two-word telegraphic reconnaissance report', () => {
    const result = classify('Одеса дорозвідка');
    expect(result.threatType).toBe('uav');
    expect(result.indicators).toContain('розвідувальна активність БпЛА');
    expect(result.locations.map((location) => location.id)).toContain('ua-city-odesa');
    expect(isSignificant(result)).toBe(true);
  });

  it('never lets a bare reconnaissance mention become a country-wide event', () => {
    const result = classify('дорозвідка');
    expect(result.nationalScope).toBe(false);
    expect(isSignificant(result)).toBe(false);
  });

  it('reads abbreviated counts and slashed location lists', () => {
    const result = classify('3х реакт йдуть по межі Котельва /Харківщина / 1х неподалік Богодухів');
    expect(result.threatType).toBe('uav');
    expect(result.locations.map((location) => location.id))
      .toEqual(expect.arrayContaining(['ua-63', 'test-kotelva', 'test-bohodukhiv']));
  });

  it('does not confuse the "реакт" abbreviation with reactive artillery', () => {
    const result = classify('Реактивна артилерія по Харківщині');
    expect(result.threatType).toBe('mlrs');
  });

  it('reads the arrow bulletin, separating region headers from arrow targets', () => {
    const result = classify('✈️Сумщина: →Кириківка/Тростянець. ✈️Харківщина: →Гути/Богодухів.');
    expect(result.indicators).toContain('рух цілі за напрямком');
    expect(isSignificant(result)).toBe(true);
    const relations = new Map(result.locations.map((location) => [location.id, location.relationType]));
    expect(relations.get('ua-59')).toBe('mentioned');
    expect(relations.get('ua-63')).toBe('mentioned');
    for (const target of ['test-kyrykivka', 'test-trostianets', 'test-huty', 'test-bohodukhiv']) {
      expect(relations.get(target)).toBe('reported_direction');
    }
  });

  it('does not invent a weapon class from the arrow bulletin', () => {
    // The arrow says something is moving, not what. Guessing `uav` from the ✈️ would be a claim the
    // message does not make; `unknown` is the honest reading and still raises the event.
    const result = classify('✈️Сумщина: →Кириківка/Тростянець.');
    expect(result.threatType).toBe('unknown');
    expect(result.signalThreatTypes).toEqual(['unknown']);
  });

  it('never lets a bare arrow with no place become an event', () => {
    const result = classify('→ далі буде');
    expect(result.indicators).toEqual([]);
    expect(isSignificant(result)).toBe(false);
  });

  it('reads "в напрямку" as well as "у напрямку"', () => {
    const result = classify('❗️Реактивні БпЛА в напрямку Одеси/області.');
    expect(result.threatType).toBe('uav');
    expect(result.locations.find((location) => location.id === 'ua-city-odesa')?.relationType)
      .toBe('reported_direction');
    expect(result.directionText).toContain('в напрямку Одеси');
  });

  it('does not raise a forward-looking threat from an explosions-only report', () => {
    // "Повідомляють про вибухи на Одещині" is aftermath, not a warning, and there is no threat type
    // to attach to it. Recorded here so the decision is explicit rather than incidental.
    const result = classify('💥Повідомляють про вибухи на Одещині.');
    expect(isSignificant(result)).toBe(false);
  });
});

/**
 * Withdrawal is its own class, not an absence of classification.
 *
 * A threat currently only ever fades on its 30-minute validity timer. These messages are the only
 * evidence a publisher gives that a threat is over, so they are recognised and typed here; acting on
 * them is a state transition owned elsewhere.
 */
describe('classifyMessage on de-escalation', () => {
  it('reads an absence statement that names no threat token', () => {
    const result = classify('ТУшки неактивні, у наш бік наразі нічого не летить');
    expect(result.intent).toBe('de_escalation');
    expect(isDeEscalation(result)).toBe(true);
    expect(isSignificant(result)).toBe(false);
    expect(result.retraction?.coverage).toBe('unspecified');
  });

  it('reads a denied indicator and reports what it denies', () => {
    const result = classify(
      'Станом на цю мить не відмічаємо ознак, що можуть свідчити про можливе застосування стратегічної авіації'
    );
    expect(result.intent).toBe('de_escalation');
    expect(result.retraction?.threatTypes).toContain('aviation');
    // No place named, and the text carries nothing that says how far the statement reaches.
    expect(result.retraction?.coverage).toBe('unspecified');
  });

  it('reads an explicit withdrawal and scopes it to the place it names', () => {
    const result = classify('Ціль знищена над Одещиною');
    expect(result.intent).toBe('de_escalation');
    expect(result.retraction?.coverage).toBe('located');
    expect(result.retraction?.locations.map((location) => location.id)).toContain('ua-51');
  });

  it('does not read anticipation of an all-clear as an all-clear', () => {
    // The most dangerous confusion available in this module: the threat is still running.
    const result = classify('очікуємо на відбій, але пильність не втрачати');
    expect(result.intent).not.toBe('de_escalation');
    expect(isDeEscalation(result)).toBe(false);
    expect(isSignificant(result)).toBe(false);
  });

  it('does not let a denial swallow the threat it is contrasted with', () => {
    const result = classify('Не фіксуємо балістики, але шахеди йдуть на Одесу');
    expect(result.intent).toBe('threat');
    expect(result.threatType).toBe('uav');
    expect(result.locations.map((location) => location.id)).toContain('ua-city-odesa');
  });

  it('does not let a trailing denial about something else withdraw the threat', () => {
    const result = classify('БпЛА на Полтавщині, вибухів не зафіксовано');
    expect(result.intent).toBe('threat');
    expect(result.threatType).toBe('uav');
    expect(isSignificant(result)).toBe(true);
  });

  it('does not treat an OSINT all-clear wording as anything but a classification', () => {
    // "Відбій" from a monitoring channel is a statement by that channel, never an official
    // all-clear. The routing guarantee that keeps it away from the alert tables is pinned by
    // tests/integration/osint-monitor-sources.test.ts; here it is only that it raises no threat.
    const result = classify('Відбій загрози ударних БпЛА для Одещини');
    expect(isSignificant(result)).toBe(false);
    expect(result.intent).toBe('de_escalation');
    expect(result.retraction?.threatTypes).toContain('uav');
    expect(result.retraction?.locations.map((location) => location.id)).toContain('ua-51');
  });
});

/**
 * Compound place names in the cases the OSINT feeds actually use.
 *
 * The catalogue now carries 136 raions, whose names are two words that both decline. The KATOTTG
 * importer enumerates three of the cases as aliases; the feeds use all of them, and a raion that
 * fails to match does not fail quietly — the substring "харків" inside "Харківським" tags the
 * **city** instead, which is a wrong location that looks right.
 */
describe('classifyMessage on compound place names', () => {
  const catalogue = [
    { id: 'ua-63', name: 'Харківська область', aliases: ['харківщина', 'харківщині'] },
    { id: 'ua-city-kharkiv', name: 'Харків', aliases: ['харкова', 'харкові'] },
    {
      id: 'ua-63-raion-kharkiv',
      name: 'Харківський',
      // Exactly what `raionAliases` emits: nominative, genitive and locative, and nothing else.
      aliases: ['харківський', 'харківський район', 'харківського району', 'харківському районі',
        'пісочинська територіальна громада', 'пісочинська громада']
    },
    { id: 'ua-32', name: 'Київська область', aliases: ['київщина', 'київщині'] },
    { id: 'ua-80', name: 'Київ', aliases: ['києва', 'києві'] }
  ];
  const inCatalogue = (text: string) =>
    classifyMessage(text, catalogue).locations.map((location) => location.id);

  it('resolves a raion in a case the importer never enumerated', () => {
    // Instrumental. Before per-word stemming this named the city of Kharkiv.
    expect(inCatalogue('Шахед над Харківським районом')).toEqual(['ua-63-raion-kharkiv']);
  });

  it('resolves the enumerated raion cases too', () => {
    expect(inCatalogue('Загроза БпЛА для Харківського району')).toEqual(['ua-63-raion-kharkiv']);
    expect(inCatalogue('БпЛА у Харківському районі')).toEqual(['ua-63-raion-kharkiv']);
    expect(inCatalogue('Шахед у Харківський район')).toEqual(['ua-63-raion-kharkiv']);
  });

  it('resolves a hromada spelling to the raion that contains it', () => {
    expect(inCatalogue('БпЛА над Пісочинською громадою')).toEqual(['ua-63-raion-kharkiv']);
  });

  it('does not name the city when only the oblast was named', () => {
    expect(inCatalogue('Шахед на Київську область')).toEqual(['ua-32']);
    expect(inCatalogue('Шахед над Харківською областю')).toEqual(['ua-63']);
    expect(inCatalogue('Шахед на Харківщину')).toEqual(['ua-63']);
  });

  it('still names both when both were named', () => {
    expect(inCatalogue('Шахед у Київській області та в місті Київ')).toEqual(['ua-32', 'ua-80']);
  });

  it('leaves the city reachable on its own', () => {
    expect(inCatalogue('Шахед на Харків')).toEqual(['ua-city-kharkiv']);
  });
});

describe('classifyMessage on redirects', () => {
  it('separates the place being passed from the place being approached', () => {
    const result = classify('Балістика повз Бровари на Бориспіль (Київщина)');
    expect(result.intent).toBe('redirect');
    expect(result.threatType).toBe('ballistic_missile');
    expect(result.retraction?.locations.map((location) => location.id)).toEqual(['test-brovary']);
    expect(result.locations.find((location) => location.id === 'test-boryspil')?.relationType)
      .toBe('reported_direction');
    // The passed-by location stays on the event: subtracting it is a state decision, not a
    // classification one, and the retraction is the hook that makes it available.
    expect(result.locations.map((location) => location.id)).toContain('test-brovary');
  });

  it('stays an ordinary threat when only one side of the transit resolves', () => {
    const result = classify('Балістика повз Бровари на Житомир');
    expect(result.intent).toBe('threat');
    expect(result.retraction).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------------
// v2 vocabulary
// ------------------------------------------------------------------------------------------------
//
// Every indicator added in v2 gets two tests: one real phrase from the monitoring channels that it
// must catch, and one nearby phrase it must leave alone. The second half is the one that keeps a
// pattern honest — an indicator that fires on everything raises the alert volume and teaches
// subscribers to ignore the app, which is a slower and more permanent failure than missing a
// message.

describe('classifyMessage on ground-attack S-300/S-400', () => {
  it('reads the Air Force phrasing with an oblast attached', () => {
    // v1 saw no threat noun here at all: "загроза застосування" only set a national scope when no
    // place resolved, so the located version — the one that says where the shelling is aimed —
    // classified as nothing and was discarded. Frontline oblasts get this warning almost daily.
    const result = classify('Загроза застосування С-300 по Харківщині!');
    expect(result.threatType).toBe('ballistic_missile');
    expect(result.locations.map((location) => location.id)).toContain('ua-63');
    expect(result.indicators).toContain('загроза застосування С-300/С-400');
    expect(isSignificant(result)).toBe(true);
  });

  it('reads a strike report that names the system without the standard phrase', () => {
    const result = classify('Обстріл з С-400 по Сумщині.');
    expect(result.threatType).toBe('ballistic_missile');
    expect(result.locations.map((location) => location.id)).toContain('ua-59');
  });

  it('does not fire on an air-defence report that merely names the system', () => {
    // "Робота ворожої ППО" is an ambient indicator about the far side. Reading the S-300 in it as a
    // ground-attack warning would turn every report of Russian air defence into a Ukrainian threat.
    const result = classify('Робота ворожої ППО, працює С-300 над Курськом.');
    expect(result.indicators).not.toContain('загроза застосування С-300/С-400');
  });
});

describe('classifyMessage on sea-area launches', () => {
  it('recognizes a launch reported by the water it came from', () => {
    const result = classify('Пуски крилатих ракет з акваторії Чорного моря.');
    expect(result.threatType).toBe('cruise_missile');
    expect(result.indicators).toContain('пуски з морської акваторії');
    expect(result.nationalScope).toBe(true);
  });

  it('recognizes the other word order the channels use', () => {
    const result = classify('З акваторії Азовського моря зафіксовано пуск.');
    expect(result.indicators).toContain('пуски з морської акваторії');
  });

  it('leaves a weather note about the same sea alone', () => {
    const result = classify('Шторм в акваторії Чорного моря, судноплавство обмежене.');
    expect(result.indicators).not.toContain('пуски з морської акваторії');
    expect(result.intent).toBe('none');
  });
});

describe('classifyMessage on the Banderol cruise missile', () => {
  it('files a named Banderol as a cruise missile', () => {
    const result = classify('Бандероль курсом на Одесу.');
    expect(result.threatType).toBe('cruise_missile');
    expect(result.locations.map((location) => location.id)).toContain('ua-city-odesa');
  });

  it('raises nothing for the postal sense of the word', () => {
    // No lexical guard separates the missile from the parcel, and inventing one would be a guess.
    // The structural guard is the one that holds: a message that names no place raises nothing.
    const result = classify('Відділення видає бандероль після 18:00.');
    expect(isSignificant(result)).toBe(false);
  });
});

describe('classifyMessage on reconnaissance drones', () => {
  it('reads the bare noun beside a place', () => {
    const result = classify('Розвідник в Одесі.');
    expect(result.threatType).toBe('uav');
    expect(result.indicators).toContain('розвідувальна активність БпЛА');
  });

  it('reads the full phrase the official channels use', () => {
    const result = classify('Розвідувальний БпЛА над Полтавщиною.');
    expect(result.threatType).toBe('uav');
    expect(result.indicators).toContain('розвідувальна активність БпЛА');
  });

  it('raises nothing for the word with no place attached', () => {
    // The word also means a human scout, and the location requirement is what keeps a war memoir out
    // of the threat feed.
    const result = classify('Розвідник розповів про службу.');
    expect(isSignificant(result)).toBe(false);
  });
});

describe('classifyMessage on naval drones', () => {
  it('records that the platform was a surface one', () => {
    const result = classify('Морські безпілотники в напрямку Одеси.');
    expect(result.indicators).toContain('морські безпілотники');
    // The class stays `uav`: ThreatType has no naval member, and downgrading the class to buy a
    // taxonomy would drop a real warning for a coastal city.
    expect(result.threatType).toBe('uav');
  });

  it('reads the other name the channels use for the same thing', () => {
    const result = classify('Безекіпажні катери противника, увага для Одещини.');
    expect(result.indicators).toContain('морські безпілотники');
  });

  it('does not attach the marker to an ordinary aerial drone', () => {
    const result = classify('Ударні БпЛА у напрямку Києва');
    expect(result.indicators).not.toContain('морські безпілотники');
  });
});

describe('classifyMessage on repeat approaches', () => {
  it('marks a second pass over a place already attacked', () => {
    const result = classify('Повторно курсом на Одесу.');
    expect(result.indicators).toContain('повторний захід');
    expect(result.locations.map((location) => location.id)).toContain('ua-city-odesa');
    expect(isSignificant(result)).toBe(true);
  });

  it('does not invent a weapon the message never named', () => {
    // The phrase almost always describes a Shahed, and "almost always" is a guess. When the text
    // does say "шахед", the ordinary UAV pattern has already matched.
    expect(classify('Повторно курсом на Одесу.').threatType).toBe('unknown');
    expect(classify('Шахед повторно курсом на Одесу.').threatType).toBe('uav');
  });

  it('leaves an unrelated repetition alone', () => {
    const result = classify('Повторно публікуємо інструкцію для Одеси.');
    expect(result.indicators).not.toContain('повторний захід');
  });
});

describe('classifyMessage on MiG-31K movements', () => {
  it('still raises a national ballistic warning on a take-off', () => {
    const result = classify('Зліт МіГ-31К з аеродрому Саваслейка.');
    expect(result.threatType).toBe('ballistic_missile');
    expect(result.nationalScope).toBe(true);
    expect(result.indicators).toContain('активність МіГ-31К');
  });

  it('treats a landing as activity on the far side rather than a threat', () => {
    // The inversion v1 made: a landing is the end of a threat window, and reading it as the start of
    // one raised a country-wide ballistic warning for a message saying the aircraft was on the
    // ground.
    const result = classify('МіГ-31К здійснив посадку на аеродромі Саваслейка.');
    expect(result.intent).toBe('none');
    expect(result.nationalScope).toBe(false);
    expect(result.indicators).not.toContain('активність МіГ-31К');
  });

  it('does not let a landing sentence disarm a warning in another sentence', () => {
    const result = classify('МіГ-31К у повітрі. Раніше інший борт здійснив посадку.');
    expect(result.threatType).toBe('ballistic_missile');
    expect(result.nationalScope).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------
// v3: repeated threat tokens across a contrast
// ------------------------------------------------------------------------------------------------
//
// `v2` examined the first occurrence of each pattern and nothing else, so a message that denies a
// weapon and then reports the same weapon was judged entirely on the denial. Every case below
// published an all-clear for a live threat before this version.

describe('classifyMessage on a threat repeated after a contrast', () => {
  it('reads the drone after "але", not the one before it', () => {
    const result = classify('БпЛА не фіксуємо, але БпЛА курсом на Київ');
    expect(result.intent).toBe('threat');
    expect(result.threatType).toBe('uav');
    expect(result.locations.map((location) => location.id)).toContain('ua-80');
    expect(isSignificant(result)).toBe(true);
  });

  it('does the same for a repeated ballistic threat', () => {
    const result = classify('Балістику не фіксуємо, але балістика курсом на Київ');
    expect(result.intent).toBe('threat');
    expect(result.threatType).toBe('ballistic_missile');
    expect(isSignificant(result)).toBe(true);
  });

  it('does the same for a repeated cruise-missile threat', () => {
    const result = classify('Крилатих ракет не фіксуємо, проте крилата ракета курсом на Одесу');
    expect(result.intent).toBe('threat');
    expect(result.threatType).toBe('cruise_missile');
    expect(result.locations.map((location) => location.id)).toContain('ua-city-odesa');
  });

  it('reads every contrastive conjunction the same way', () => {
    for (const conjunction of ['але', 'проте', 'однак', 'втім']) {
      const result = classify(`Шахедів не фіксуємо, ${conjunction} шахед курсом на Київ`);
      expect(result.intent, conjunction).toBe('threat');
      expect(result.threatType, conjunction).toBe('uav');
    }
  });

  it('classifies a mixed denial on what it asserts, not on what it denies', () => {
    const result = classify('Не фіксуємо балістики, але шахед курсом на Київ');
    expect(result.threatType).toBe('uav');
    expect(result.signalThreatTypes).not.toContain('ballistic_missile');
  });

  it('leaves a clean absence statement a de-escalation', () => {
    // The negative half of the same rule: with nothing after the denial there is nothing to assert,
    // and the message must keep meaning what it says.
    for (const text of ['БпЛА не фіксуємо', 'Балістики не фіксуємо.', 'Крилатих ракет не спостерігаємо']) {
      const result = classify(text);
      expect(result.intent, text).toBe('de_escalation');
      expect(isSignificant(result), text).toBe(false);
    }
  });

  it('still refuses to read anticipation of an all-clear as an all-clear', () => {
    const result = classify('Очікуємо на відбій, БпЛА поки не фіксуємо');
    expect(result.intent).not.toBe('de_escalation');
    expect(isDeEscalation(result)).toBe(false);
  });

  it('does not let a denied strategic indicator hide an asserted one later', () => {
    const result = classify('Зліт Ту-95 не фіксуємо, але зліт Ту-160 підтверджено.');
    expect(result.indicators).toContain('зліт стратегічної авіації');
    expect(result.nationalScope).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------
// v3 vocabulary
// ------------------------------------------------------------------------------------------------
//
// Every rule below gets the phrase from the archive that it must catch and the nearby phrase it must
// leave alone. The catalogue is local to this block so the additions cannot perturb the fixtures
// above, and it holds only places the sampled messages actually name.

describe('classifyMessage on v3 vocabulary', () => {
  const catalogue = [
    { id: 'ua-80', name: 'Київ', aliases: ['київ', 'києва', 'києві'] },
    { id: 'ua-city-odesa', name: 'Одеса', aliases: ['одеси', 'одесі', 'одесу'] },
    { id: 'ua-city-sumy', name: 'Суми', aliases: ['сумах'] },
    { id: 'ua-city-dnipro', name: 'Дніпро', aliases: ['дніпра', 'дніпрі'] },
    { id: 'ua-63', name: 'Харківська область', aliases: ['харківщина', 'харківщині'] },
    { id: 'ua-59', name: 'Сумська область', aliases: ['сумщина', 'сумщині'] },
    { id: 'test-vyshhorod', name: 'Вишгород', aliases: ['вишгорода'] },
    { id: 'test-brovary', name: 'Бровари', aliases: ['броварів', 'броварах'] }
  ];
  const read = (text: string) => classifyMessage(text, catalogue);

  describe('the jet-powered Shahed as the channels inflect it', () => {
    it('reads every form the archive uses', () => {
      for (const text of [
        'Одеса 1х реактив Аркадія',
        '2х реактива по межі Київської області, курс на Київ',
        'Реактивний керований на Вишгород',
        'Пара реактивних на Бровари',
        'Реактивні БпЛА в напрямку Одеси'
      ]) {
        const result = read(text);
        expect(result.threatType, text).toBe('uav');
        expect(isSignificant(result), text).toBe(true);
      }
    });

    it('still leaves reactive artillery to the artillery class', () => {
      expect(read('Реактивна артилерія по Харківщині').threatType).toBe('mlrs');
      expect(read('Обстріл з реактивної артилерії по Харківщині').threatType).toBe('mlrs');
    });

    it('raises nothing for a jet drone that names no place', () => {
      expect(isSignificant(read('Реактивний'))).toBe(false);
    });
  });

  describe('Zala', () => {
    it('files a named Zala as a reconnaissance UAV', () => {
      const result = read('Дніпропетровщина: Zala курсом на Дніпро');
      expect(result.threatType).toBe('uav');
      expect(isSignificant(result)).toBe(true);
    });

    it('does not read the Ukrainian word "зала" as a drone', () => {
      // Cyrillic, and it means "hall". Only the Latin spelling is the aircraft.
      const result = read('Зала очікування у Києві працює цілодобово.');
      expect(result.threatType).toBe('unknown');
      expect(isSignificant(result)).toBe(false);
    });
  });

  describe('Молнія', () => {
    it('files a named Molniya as a UAV', () => {
      const result = read('Сумщина: Молнія курсом на Суми');
      expect(result.threatType).toBe('uav');
      expect(result.locations.map((location) => location.id)).toContain('ua-city-sumy');
    });

    it('raises nothing when the same word names no place', () => {
      expect(isSignificant(read('Молнія'))).toBe(false);
    });
  });

  describe('the "Ударний Бп" abbreviation', () => {
    it('reads the structured bulletin', () => {
      const result = read('Сумська область ◦ Ударний Бп 2 грп.');
      expect(result.threatType).toBe('uav');
      expect(result.locations.map((location) => location.id)).toContain('ua-59');
    });

    it('does not read the two letters on their own', () => {
      // "Бп" alone is two characters and evidence of nothing; only "ударний Бп" is the weapon.
      const result = read('Сумська область ◦ Бп 2 грп.');
      expect(result.threatType).toBe('unknown');
      expect(result.indicators).toEqual([]);
    });
  });

  describe('generic "дрон"', () => {
    it('reads a count of drones beside a place', () => {
      const result = read('Київ, у нас 3 дрони біля Трої');
      expect(result.threatType).toBe('uav');
      expect(result.indicators).toContain('дрони без уточнення типу');
      expect(isSignificant(result)).toBe(true);
    });

    it('reads a verb of motion beside a place', () => {
      expect(read('Київ. Дрони йдуть на низькій висоті.').threatType).toBe('uav');
    });

    it('raises nothing for the word with a place but no operational cue', () => {
      const result = read('У Києві засоби захисту від дронів активовані.');
      expect(result.threatType).toBe('unknown');
      expect(isSignificant(result)).toBe(false);
    });

    it('raises nothing for an operational cue with no Ukrainian place', () => {
      const result = read('У повітрі 30х різних дронів, у всіх курс західний');
      expect(isSignificant(result)).toBe(false);
    });

    it('still ignores a fundraiser for drones', () => {
      expect(isSignificant(read('Збір на дрони для 47 бригади у Києві. Монобанк.'))).toBe(false);
    });
  });

  describe('generic "ракета"', () => {
    it('reads the shouted one-line warning', () => {
      const result = read('⚠️ КИЇВ! УВАГА! РАКЕТА!');
      expect(result.indicators).toContain('ракета без уточнення типу');
      expect(isSignificant(result)).toBe(true);
    });

    it('does not guess which kind of missile it was', () => {
      // Ballistic and cruise arrive with minutes of difference between them; printing a coin toss
      // as a class would be a claim the message never made.
      expect(read('⚠️ КИЇВ! УВАГА! РАКЕТА!').threatType).toBe('unknown');
    });

    it('raises nothing without an operational cue', () => {
      expect(isSignificant(read('У Києві відкрили виставку ракет.'))).toBe(false);
    });

    it('raises nothing with no place at all', () => {
      expect(isSignificant(read('2 ракети'))).toBe(false);
    });
  });

  describe('generic "бомба"', () => {
    it('reads a bomb with a stated direction', () => {
      const result = read('Бомба у напрямку Вишгорода');
      expect(result.indicators).toContain('авіабомба без уточнення типу');
      expect(result.threatType).toBe('unknown');
      expect(isSignificant(result)).toBe(true);
    });

    it('does not read a bomb shelter as a bomb', () => {
      const result = read('У Києві відкрили нове бомбосховище, укриття працює цілодобово.');
      expect(result.indicators).not.toContain('авіабомба без уточнення типу');
      expect(isSignificant(result)).toBe(false);
    });
  });

  describe('a reported direction with no weapon named', () => {
    it('raises an unknown event for a bare course', () => {
      for (const text of ['Курс на Вишгород!', 'Один курсом на Вишгород', 'Поки тримають курс на Вишгород']) {
        const result = read(text);
        expect(result.threatType, text).toBe('unknown');
        expect(result.indicators, text).toContain('повідомлений напрямок без названого типу');
        expect(isSignificant(result), text).toBe(true);
      }
    });

    it('reads the "н.п." form the Air Force uses', () => {
      const result = read('Курс на н.п. Вишгород та Бровари!');
      expect(isSignificant(result)).toBe(true);
      expect(result.locations.map((location) => location.id))
        .toEqual(expect.arrayContaining(['test-vyshhorod', 'test-brovary']));
    });

    it('reads "у бік" as a stated direction too', () => {
      expect(isSignificant(read('У бік Броварів дві штуки'))).toBe(true);
    });

    it('never infers the class from an earlier message', () => {
      // The classifier is a pure function of one message; this pins the property that makes that
      // guarantee observable rather than incidental.
      expect(read('Шахед курсом на Вишгород').threatType).toBe('uav');
      expect(read('Курс на Вишгород').threatType).toBe('unknown');
    });

    it('does not read an exchange rate as a heading', () => {
      expect(isSignificant(read('Курс долара знову зріс. Київ реагує спокійно.'))).toBe(false);
      expect(isSignificant(read('Курси англійської у Києві.'))).toBe(false);
    });

    it('raises nothing for a direction with no Ukrainian place', () => {
      expect(isSignificant(read('Курсом на Ростов'))).toBe(false);
    });

    it('does not turn a withdrawal into a threat because it states a direction', () => {
      const result = read('Відбій загрози ударних БпЛА курсом на Київ');
      expect(result.intent).toBe('de_escalation');
      expect(isSignificant(result)).toBe(false);
    });
  });

  describe('the ➤ arrow bulletin', () => {
    it('reads the arrow the way it reads →', () => {
      const result = read('Рильськ ➤ Суми ➤');
      expect(result.indicators).toContain('рух цілі за напрямком');
      expect(result.threatType).toBe('unknown');
      expect(result.locations.find((location) => location.id === 'ua-city-sumy')?.relationType)
        .toBe('reported_direction');
    });

    it('never lets a bare ➤ with no place become an event', () => {
      expect(isSignificant(read('ДКУ ➤'))).toBe(false);
    });
  });
});

// ------------------------------------------------------------------------------------------------
// v4 location resolution
// ------------------------------------------------------------------------------------------------
//
// One test per defect the v3 measurement found, and each one is a pair: the message that must stop
// resolving the wrong place, and a message naming the place it was being confused with, which must
// still resolve. A rule that fixes the first by breaking the second has fixed nothing.
//
// The catalogue below is the real one, trimmed to the rows these messages can reach, with the
// `type`, `geocoded` and `oblastId` columns `listLocationLexemes` reads. Ids and KATOTTG codes are
// the production ones so a failure here names a row a reviewer can look up.

describe('classifyMessage on Ukrainian place-name morphology (v4)', () => {
  const catalogue = [
    { id: 'ua-12', name: 'Дніпропетровська область', aliases: ['дніпропетровщина'], type: 'oblast', geocoded: true },
    { id: 'ua-32', name: 'Київська область', aliases: ['київщина'], type: 'oblast', geocoded: true },
    { id: 'ua-51', name: 'Одеська область', aliases: ['одещина'], type: 'oblast', geocoded: true },
    { id: 'ua-59', name: 'Сумська область', aliases: ['сумщина'], type: 'oblast', geocoded: true },
    { id: 'ua-63', name: 'Харківська область', aliases: ['харківщина'], type: 'oblast', geocoded: true },
    { id: 'ua-74', name: 'Чернігівська область', aliases: ['чернігівщина'], type: 'oblast', geocoded: true },
    { id: 'ua-23', name: 'Запорізька область', aliases: ['запорізька область'], type: 'oblast', geocoded: true },
    { id: 'ua-80', name: 'Київ', aliases: ['київ', 'києва', 'троєщина', 'троя', 'жуляни'], type: 'special_city', geocoded: true },
    { id: 'ua-city-dnipro', name: 'Дніпро', aliases: ['дніпро'], type: 'city', geocoded: true, oblastId: 'ua-12' },
    { id: 'ua-city-zaporizhzhia', name: 'Запоріжжя', aliases: ['запоріжжя'], type: 'city', geocoded: true, oblastId: 'ua-23' },
    { id: 'ua-city-kropyvnytskyi', name: 'Кропивницький', aliases: ['кропивницький'], type: 'city', geocoded: true, oblastId: 'ua-35' },
    { id: 'ua-city-mykolaiv', name: 'Миколаїв', aliases: ['миколаїв'], type: 'city', geocoded: true, oblastId: 'ua-48' },
    { id: 'raion-kropyvnytskyi', name: 'Кропивницький район', aliases: ['кропивницький', 'кропивницький район'], type: 'raion', oblastId: 'ua-35' },
    { id: 'raion-brovary', name: 'Броварський район', aliases: ['броварський', 'броварський район'], type: 'raion', oblastId: 'ua-32' },
    { id: 'raion-boryspil', name: 'Бориспільський район', aliases: ['бориспільський'], type: 'raion', oblastId: 'ua-32' },
    { id: 'city-obukhiv', name: 'Обухів', aliases: ['обухів'], type: 'city', oblastId: 'ua-32' },
    { id: 'city-obukhivka', name: 'Обухівка', aliases: ['обухівка'], type: 'city', oblastId: 'ua-12' },
    { id: 'city-bar', name: 'Бар', aliases: ['бар'], type: 'city', oblastId: 'ua-05' },
    { id: 'city-berezne', name: 'Березне', aliases: ['березне'], type: 'city', oblastId: 'ua-56' },
    { id: 'city-samar', name: 'Самар', aliases: ['самар'], type: 'city', oblastId: 'ua-12' },
    { id: 'city-fastiv', name: 'Фастів', aliases: ['фастів'], type: 'city', oblastId: 'ua-32' },
    { id: 'city-brovary', name: 'Бровари', aliases: ['бровари'], type: 'city', oblastId: 'ua-32' },
    { id: 'city-pivdenne-odesa', name: 'Південне', aliases: ['південне'], type: 'city', oblastId: 'ua-51' },
    { id: 'city-pivdenne-kharkiv', name: 'Південне', aliases: ['південне'], type: 'city', oblastId: 'ua-63' },
    { id: 'city-horodok-lviv', name: 'Городок', aliases: ['городок'], type: 'city', oblastId: 'ua-46' },
    { id: 'city-horodok-khmeln', name: 'Городок', aliases: ['городок'], type: 'city', oblastId: 'ua-68' },
    { id: 'city-mykolaiv-lviv', name: 'Миколаїв', aliases: ['миколаїв'], type: 'city', oblastId: 'ua-46' },
    { id: 'city-zgurivka', name: 'Згурівка', aliases: ['згурівка'], type: 'city', oblastId: 'ua-32' },
    { id: 'city-dymerka', name: 'Велика Димерка', aliases: ['велика димерка'], type: 'city', oblastId: 'ua-32' },
    { id: 'city-zazymia', name: 'Зазим’я', aliases: ['зазим’я'], type: 'city', oblastId: 'ua-32' },
    { id: 'city-pohreby', name: 'Погреби', aliases: ['погреби'], type: 'city', oblastId: 'ua-32' },
    { id: 'city-kozelets', name: 'Козелець', aliases: ['козелець'], type: 'city', oblastId: 'ua-74' },
    { id: 'city-mala-divytsia', name: 'Мала Дівиця', aliases: ['мала дівиця'], type: 'city', oblastId: 'ua-74' },
    { id: 'city-dihtiari', name: 'Дігтярі', aliases: ['дігтярі'], type: 'city', oblastId: 'ua-74' },
    { id: 'city-khotin', name: 'Хотінь', aliases: ['хотінь'], type: 'city', oblastId: 'ua-59' },
    { id: 'city-yunakivka', name: 'Юнаківка', aliases: ['юнаківка'], type: 'city', oblastId: 'ua-59' },
    { id: 'city-mena', name: 'Мена', aliases: ['мена'], type: 'city', oblastId: 'ua-74' }
  ];
  const at = (text: string) => classifyMessage(text, catalogue).locations.map((location) => location.id).sort();

  // ----------------------------------------------------------------------------------------------
  // A. Wrong resolutions: v3 named a real settlement the message never mentioned.
  // ----------------------------------------------------------------------------------------------

  it('A1 does not read Обухів out of Обухівка, and still reads Обухів', () => {
    expect(at('Дніпропетровщина: 6х БпЛА курсом на Обухівку')).toEqual(['city-obukhivka', 'ua-12']);
    expect(at('БпЛА курсом на Обухів')).toEqual(['city-obukhiv']);
    expect(at('Новий реактив у Обухова')).toEqual(['city-obukhiv']);
  });

  it('A2 does not read Бар out of Баришівка, and still reads Бар', () => {
    expect(at('Реактивний БпЛА на Київщині повз Баришівку')).toEqual(['ua-32']);
    expect(at('БпЛА на Бар')).toEqual(['city-bar']);
  });

  it('A3 does not read Березне out of Березна, and still reads Березне', () => {
    expect(at('Чернігівщина - реактивний повз Березну на Козелець'))
      .toEqual(['city-kozelets', 'ua-74']);
    expect(at('БпЛА курсом на Березне')).toEqual(['city-berezne']);
  });

  it('A4 never reads a settlement out of a compass bearing', () => {
    // Three shapes: the hyphenated adjective, the declined adjective and the bare noun. None of
    // them is a place, and the second is a legal form of the neuter name Південне.
    expect(at('БпЛА на півночі Чернігівщини, на південно-західний напрямок')).toEqual(['ua-74']);
    expect(at('Реактивний БпЛА на Київщині, південним курсом')).toEqual(['ua-32']);
    expect(at('БпЛА курсом на Дніпро з південного сходу')).toEqual(['ua-city-dnipro']);
    // ...and the settlement is still reachable where the message spells it as the catalogue does
    // and says which of the two it means.
    expect(at('Одещина: реактив на Південне')).toEqual(['city-pivdenne-odesa', 'ua-51']);
  });

  it('A5 never reads the city out of an oblast adjective, however the oblast was spelled', () => {
    // The v3 failure needed two spellings of the oblast in one message: the alias matched one of
    // them, leaving the substring "київ" inside the other free for the city to claim.
    expect(at('Київщина чисто. Реактив з Чернігівщини на північ Київщини')).toEqual(['ua-32', 'ua-74']);
    expect(at('Реактивний БпЛА курсом на Київщину. Київщина - реактивний на Фастів'))
      .toEqual(['city-fastiv', 'ua-32']);
    expect(at('Шахед над Харківською областю')).toEqual(['ua-63']);
    // Both are named when both were named.
    expect(at('Загроза балістики по м.Київ, Київській області, зокрема м.Бровари'))
      .toEqual(['city-brovary', 'ua-32', 'ua-80']);
  });

  it('A6 does not read Самар out of Самарський, and keeps the city the message did name', () => {
    expect(at('Розвідувальний БпЛА в Самарському р-ні Дніпра')).toEqual(['ua-city-dnipro']);
  });

  // ----------------------------------------------------------------------------------------------
  // B. Inflections v3 could not resolve at all.
  // ----------------------------------------------------------------------------------------------

  it('B1 resolves the instrumental "Києвом"', () => {
    expect(at('5 балістик над Києвом!')).toEqual(['ua-80']);
  });

  it('B2 resolves "Кропивницьким" as the city, and the raion only with its head noun', () => {
    // The precedence rule for a masculine administrative adjective, both ways round.
    expect(at('БпЛА над Кропивницьким')).toEqual(['ua-city-kropyvnytskyi']);
    expect(at('БпЛА у Кропивницькому районі')).toEqual(['raion-kropyvnytskyi']);
  });

  it('B3 resolves the genitive "Фастова"', () => {
    expect(at('Київщина - реактивний керований на Фастова')).toEqual(['city-fastiv', 'ua-32']);
  });

  it('B4 resolves both oblasts of a coordinated pair, and a longer list too', () => {
    expect(at('2х реактива по межі Київської та Чернігівської областей')).toEqual(['ua-32', 'ua-74']);
    expect(at('БпЛА у Київській, Чернігівській та Сумській областях')).toEqual(['ua-32', 'ua-59', 'ua-74']);
    expect(at('Шахед у Броварському та Бориспільському районах')).toEqual(['raion-boryspil', 'raion-brovary']);
  });

  // ----------------------------------------------------------------------------------------------
  // C. The dual alias: Запоріжжя is the city, Запорізька область is the oblast.
  // ----------------------------------------------------------------------------------------------

  it('C reads a bare Запоріжжя as the city and the adjective as the oblast', () => {
    expect(at('КАБи на Запоріжжі')).toEqual(['ua-city-zaporizhzhia']);
    expect(at('БпЛА курсом на Запоріжжя з півдня')).toEqual(['ua-city-zaporizhzhia']);
    expect(at('Шахед на Запорізьку область')).toEqual(['ua-23']);
  });

  // ----------------------------------------------------------------------------------------------
  // D. The settlements migration 024 adds.
  // ----------------------------------------------------------------------------------------------

  it('D resolves the settlements the catalogue used to lack', () => {
    expect(at('Пара реактивних на Згурівку')).toEqual(['city-zgurivka']);
    expect(at('Курс на н.п. Дігтярі та Мала Дівиця!')).toEqual(['city-dihtiari', 'city-mala-divytsia']);
    expect(at('Бомба у напрямку Юнаківки/Хотіні')).toEqual(['city-khotin', 'city-yunakivka']);
    expect(at('БпЛА у напрямку Зазим’є Велика Димерка')).toEqual(['city-dymerka', 'city-zazymia']);
    expect(at('Погреби - Троя рух БПЛА')).toEqual(['city-pohreby', 'ua-80']);
    expect(at('Жуляни 2 балістики падають!!')).toEqual(['ua-80']);
  });

  // ----------------------------------------------------------------------------------------------
  // The rules that keep the additions honest.
  // ----------------------------------------------------------------------------------------------

  it('refuses a name two catalogue rows spell the same way', () => {
    // Two Городок, in two oblasts the message does not name. Publishing either is a coin toss with
    // somebody's air-raid warning, so neither is published.
    expect(at('Шахед над Городком')).toEqual([]);
    expect(at('Реактивний на Південне')).toEqual([]);
  });

  it('lets the message break the tie by naming the oblast', () => {
    expect(at('Одещина: реактив на Південне')).toEqual(['city-pivdenne-odesa', 'ua-51']);
    expect(at('Харківщина: реактив на Південне')).toEqual(['city-pivdenne-kharkiv', 'ua-63']);
  });

  it('breaks a tie towards the seeded first-order settlement', () => {
    // Миколаїв the oblast capital and Миколаїв the town in Lviv oblast. Only the first is geocoded.
    expect(at('Шахед на Миколаїв')).toEqual(['ua-city-mykolaiv']);
  });

  it('never reads a place out of an ordinary word a paradigm happens to reach', () => {
    expect(at('Троє БпЛА над Києвом')).toEqual(['ua-80']);
    expect(at('Мені здається, там БпЛА над Києвом')).toEqual(['ua-80']);
    // ...while the town itself, spelled as the catalogue spells it, still resolves.
    expect(at('Чернігівщина - реактивний Козелець - 2 реактивних Мена'))
      .toEqual(['city-kozelets', 'city-mena', 'ua-74']);
  });

  it('lets a longer name take the text a shorter one sits inside', () => {
    expect(at('БпЛА курсом на Велику Димерку')).toEqual(['city-dymerka']);
    expect(at('Шахед на Київщину та в місто Київ')).toEqual(['ua-32', 'ua-80']);
  });
});
