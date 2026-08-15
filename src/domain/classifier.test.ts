import { describe, expect, it } from 'vitest';
import {
  classifyMessage, isDeEscalation, isSignificant, riskLevel, significanceRejection
} from './classifier.js';

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
  { id: 'test-huty', name: 'Гути', aliases: ['гутів'] },
  { id: 'test-kropyvnytskyi', name: 'Кропивницький', aliases: ['кропивницького'] }
];

const classify = (text: string) => classifyMessage(text, locations);

describe('classifyMessage', () => {
  it('recognizes a reported direction without claiming a target', () => {
    const result = classify('Ударні БпЛА у напрямку Києва');
    expect(result.threatType).toBe('uav');
    expect(result.locations[0]).toMatchObject({ id: 'ua-80', relationType: 'reported_direction' });
    expect(result.directionText).toContain('у напрямку Києва');
  });

  // ---- Курс: один словник для типу звʼязку і для тексту в картці ---------------------------------
  //
  // Знайдено не читанням коду, а бойовою карткою: заголовок «Крилата ракета повз Нечаївку продовжує
  // рух на Кропивницький!», а під ним поле «Напрямок: не повідомлявся». `relationFor` курс упізнав
  // (місце дістало `reported_direction`), окремий перелік фраз у видобувачі тексту — ні.

  it('takes the direction from a transit sentence that names no other heading phrase', () => {
    // Дослівне повідомлення з продакшену. «повз … рух на …» не є ані фразою курсу, ані стрілкою —
    // курс тут несе сама конструкція транзиту, і саме її раніше не читав видобувач тексту.
    const result = classify('⚠️Крилата ракета повз Гути продовжує рух на Кропивницький!');
    expect(result.locations.find((location) => location.id === 'test-kropyvnytskyi')?.relationType)
      .toBe('reported_direction');
    // Дослівно, разом зі словом «рух»: картка підписує це поле «напрямок повідомлено джерелом», і
    // будь-яке скорочення зробило б підпис неправдою.
    expect(result.directionText).toBe('рух на Кропивницький');
  });

  it('reads "у бік" as a direction in the card, not only in the relation', () => {
    // `relationFor` знав «у бік» від початку, видобувач тексту — ні. Розходження двох переліків.
    const result = classify('Ударні БпЛА у бік Одеси');
    expect(result.locations.find((location) => location.id === 'ua-city-odesa')?.relationType)
      .toBe('reported_direction');
    expect(result.directionText).toBe('у бік Одеси');
  });

  it('reads "рухається на" as well as "рухається до"', () => {
    // Перелік мав тільки «до». «Рухається на Київ» — звичайна фраза моніторингових каналів.
    const result = classify('Крилата ракета рухається на Київ');
    expect(result.locations.find((location) => location.id === 'ua-80')?.relationType)
      .toBe('reported_direction');
    expect(result.directionText).toBe('рухається на Київ');
  });

  it('marks the far end of "повз A до B" as a direction, the same as "повз A на B"', () => {
    // `REDIRECT_PATTERN` читав «до» як звʼязку транзиту, а `relationFor` — ні, тож Бориспіль лишався
    // звичайною згадкою. Наслідок видно на карті: `planStep` будує відрізок A→B лише тоді, коли
    // дальній кінець має тип `reported_direction`.
    const result = classify('Балістика повз Бровари до Борисполя');
    expect(result.locations.find((location) => location.id === 'test-boryspil')?.relationType)
      .toBe('reported_direction');
    expect(result.intent).toBe('redirect');
    // Речення не має ані фрази курсу, ані стрілки — текст напрямку тут може дати ЛИШЕ розбір
    // транзиту. Це і є той шлях, задля якого `directionPhrase` читає результат `REDIRECT_PATTERN`.
    expect(result.directionText).toBe('до Борисполя');
  });

  it('does not call an altitude a direction', () => {
    // Чому в переліку немає «летить на»: у картці це дало б «напрямок: на висоті 300 метрів».
    // `relationFor` від такої помилки боронить каталог, видобувач тексту — ні.
    const result = classify('Ударні БпЛА над Одещиною, летить на висоті 300 метрів');
    expect(result.directionText).toBeUndefined();
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
    { id: 'city-mena', name: 'Мена', aliases: ['мена'], type: 'city', oblastId: 'ua-74' },
    // The homonym pairs migration 031 completes. Each was a single catalogue row before it, which
    // is why the message's own oblast could not save it: `pickAmongTied` reads the oblast only to
    // separate two rows that claim the same span, so one unopposed row won whatever the text said.
    { id: 'ua-14', name: 'Донецька область', aliases: ['донеччина'], type: 'oblast', geocoded: true },
    { id: 'ua-46', name: 'Львівська область', aliases: ['львівщина'], type: 'oblast', geocoded: true },
    { id: 'city-bohuslav-kyiv', name: 'Богуслав', aliases: ['богуслав'], type: 'city', oblastId: 'ua-32' },
    { id: 'city-bohuslav-dnipro', name: 'Богуслав', aliases: ['богуслав'], type: 'city', oblastId: 'ua-12' },
    { id: 'city-zolochiv-lviv', name: 'Золочів', aliases: ['золочів'], type: 'city', oblastId: 'ua-46' },
    { id: 'city-zolochiv-kharkiv', name: 'Золочів', aliases: ['золочів'], type: 'city', oblastId: 'ua-63' },
    { id: 'city-mykolaivka-donetsk', name: 'Миколаївка', aliases: ['миколаївка'], type: 'city', oblastId: 'ua-14' },
    { id: 'city-mykolaivka-sumy', name: 'Миколаївка', aliases: ['миколаївка'], type: 'city', oblastId: 'ua-59' },
    { id: 'city-dolyna', name: 'Долина', aliases: ['долина'], type: 'city', oblastId: 'ua-26' },
    { id: 'city-lypova-dolyna', name: 'Липова Долина', aliases: ['липова долина'], type: 'city', oblastId: 'ua-59' },
    // Migration 032. Божедарівка is the one row of the five with no ambiguity to guard against —
    // its only namesake is a село in the same hromada — so it is a plain settlement row. The other
    // four come in pairs on purpose: a fifty-bearer and an eighty-five-bearer name held by a single
    // catalogue row would win every span unopposed, which is the defect, not the fix.
    { id: 'ua-05', name: 'Вінницька область', aliases: ['вінниччина'], type: 'oblast', geocoded: true },
    { id: 'ua-65', name: 'Херсонська область', aliases: ['херсонщина'], type: 'oblast', geocoded: true },
    { id: 'city-bozhedarivka', name: 'Божедарівка', aliases: ['божедарівка'], type: 'city', oblastId: 'ua-12' },
    { id: 'city-verkhivtseve', name: 'Верхівцеве', aliases: ['верхівцеве'], type: 'city', oblastId: 'ua-12' },
    { id: 'city-stepanivka-sumy', name: 'Степанівка', aliases: ['степанівка'], type: 'city', oblastId: 'ua-59' },
    { id: 'city-stepanivka-kherson', name: 'Степанівка', aliases: ['степанівка'], type: 'city', oblastId: 'ua-65' },
    { id: 'city-kalynivka-vinnytsia', name: 'Калинівка', aliases: ['калинівка'], type: 'city', oblastId: 'ua-05' },
    { id: 'city-kalynivka-brovary', name: 'Калинівка', aliases: ['калинівка'], type: 'city', oblastId: 'ua-32' },
    { id: 'city-kalynivka-fastiv', name: 'Калинівка', aliases: ['калинівка'], type: 'city', oblastId: 'ua-32' }
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
  // E. The homonyms migration 031 completes: a catalogue that held one of a pair named the wrong
  //    oblast even when the message named the right one in its own first line.
  // ----------------------------------------------------------------------------------------------

  it('E1 reads the Dnipropetrovsk Богуслав out of the message that painted Обухівський район', () => {
    // Verbatim from the production archive: `source_messages` id
    // 6b1e7d29-dbb5-4df2-a731-f418f66c62f4, osint-rynda, 2026-08-10T11:50:11Z. With only the Kyiv
    // Богуслав in the catalogue this resolved `katottg-ua32120010010027554`, the unmapped-ancestor
    // climb in `territory-state.ts` walked it up to Обухівський район, Київська область, and the
    // territory panel showed a Kyiv-oblast raion carrying a Dnipropetrovsk UAV corridor for an hour.
    // The message's second settlement, Божедарівка, was a silent drop 031 reported and 032 added, so
    // both lines of the incident message now name the place they were always about (see F1).
    expect(at('Дніпропетровщина:\nБпЛА курсом на Богуслав\nРеактивний БпЛА курсом на Божедарівку'))
      .toEqual(['city-bohuslav-dnipro', 'city-bozhedarivka', 'ua-12']);
    // The Kyiv one is still reachable when the message says so, which is the whole point of adding
    // the second row rather than replacing the first.
    expect(at('Київщина: БпЛА курсом на Богуслав')).toEqual(['city-bohuslav-kyiv', 'ua-32']);
    // And bare, with no oblast anywhere, the pair refuses. Inventing 400 km is worse than silence.
    expect(at('БпЛА курсом на Богуслав')).toEqual([]);
  });

  it('E2 keeps a Kharkiv Золочів out of Lviv oblast', () => {
    // 8ef447a6-28b2-4852-bbcf-65a7d24817bf and 09264f03-ef64-4bab-a907-e2eea613a809, both archived,
    // both naming Харківщина in the same sentence, both resolving Золочів, Львівська обл. before 031.
    expect(at('🛵Реактивний БПЛА на Харківщину з БНР попереднім курсом на Золочів'))
      .toEqual(['city-zolochiv-kharkiv', 'ua-63']);
    expect(at('Харківщина:\nБпЛА курсом на Золочів')).toEqual(['city-zolochiv-kharkiv', 'ua-63']);
    expect(at('Львівщина: БпЛА курсом на Золочів')).toEqual(['city-zolochiv-lviv', 'ua-46']);
  });

  it('E3 keeps a Sumy-border Миколаївка out of Donetsk oblast', () => {
    // a4d3b0ac-7df8-4ecf-b019-61d39f10fceb and a66137b9-7a22-4734-ada2-b0ad7adf4cc9, Air Force.
    // Хотінь — the settlement in the first of them, added by 024 — is in the same raion as this one.
    // Степанівка in the same message is migration 032's row; before it the third name in this
    // corridor resolved to nothing at all.
    expect(at('🛵 Сумщина: БпЛА повз Хотінь ➡️ у напрямку Миколаївки/Степанівки.'))
      .toEqual(['city-khotin', 'city-mykolaivka-sumy', 'city-stepanivka-sumy', 'ua-59']);
    expect(at('🛵 Сумщина: реактивний БпЛА ➡️ в напрямку Миколаївки.'))
      .toEqual(['city-mykolaivka-sumy', 'ua-59']);
    expect(at('Донеччина: БпЛА курсом на Миколаївку')).toEqual(['city-mykolaivka-donetsk', 'ua-14']);
  });

  it('E4 lets Липова Долина take the span Долина was reading out of it', () => {
    // 02ece8e9-78c3-401b-a18e-654bfb199a55, Air Force. The second word alone resolved Долина,
    // Івано-Франківська обл. — the far west — out of a Sumy border report. This is the longest-name
    // rule doing its job, not a tie-break: with the two-word row present there is no shorter match.
    expect(at('🛵 Сумщина: БпЛА ➡️ на півночі від Липової Долини,  курс - змінний.'))
      .toEqual(['city-lypova-dolyna', 'ua-59']);
    // The Ivano-Frankivsk town keeps its own name.
    expect(at('БпЛА курсом на Долину')).toEqual(['city-dolyna']);
  });

  // ----------------------------------------------------------------------------------------------
  // F. The settlements migration 032 adds: the two silent drops 031 reported but did not add, and
  //    the wrong-oblast homonym `scripts/homonym-audit.mjs` found before any incident did.
  // ----------------------------------------------------------------------------------------------

  it('F1 resolves Божедарівка, whose only namesake shares its hromada', () => {
    // Twelve archived mentions, every one Dnipropetrovsk. Verbatim: 6bfea2ed-8b6a-4d3e-8c3e-
    // 425c52a5a1ca (osint-rynda), 1e04c4e4-8380-4a2b-ad51-327b3a192bc6 and 60db3357-e412-46fe-9f07-
    // 424e13df0ab9 (єРадар), b26f54e1-a42a-46ce-ada2-4cdc5447cb26 (Air Force). Before this row every
    // one of them resolved the oblast and nothing else, so a stated course reached no settlement.
    expect(at('Дніпропетровщина:\nРеактивний БпЛА курсом на Божедарівку'))
      .toEqual(['city-bozhedarivka', 'ua-12']);
    expect(at('🛵Дніпропетровщина: реактивний БПЛА кружляє в районі Божедарівки'))
      .toEqual(['city-bozhedarivka', 'ua-12']);
    expect(at('🛵 Реактивний БпЛА на Дніпропетровщині, курсом на Божедарівку.'))
      .toEqual(['city-bozhedarivka', 'ua-12']);
    expect(at('🛵Дніпропетровщина: реактивний на Божедарівку / Кринички з півдня'))
      .toEqual(['city-bozhedarivka', 'ua-12']);
    // The incident message of migration 031, both of whose settlements now resolve.
    expect(at('Дніпропетровщина:\nБпЛА курсом на Богуслав\nРеактивний БпЛА курсом на Божедарівку'))
      .toEqual(['city-bohuslav-dnipro', 'city-bozhedarivka', 'ua-12']);
    // Unlike every other name in this block, a bare Божедарівка is allowed to resolve: Ukraine holds
    // two, and the other (UA12040010060018170) is a село in the same hromada, so there is no wrong
    // oblast for the name to land in. This is the СК running commentary that names Kharkiv and
    // Опішня in the same breath and never says which oblast the drone is over — 863d6851-690c-43e4-
    // aa3f-509e878e3a70, verbatim. (Neither Харків nor Опішня is in the trimmed catalogue above, so
    // this assertion is about the one name it can reach.)
    expect(at('Харків неподалік 3х дрона\nОпішня той так і літає\nреакт на Божедарівку'))
      .toEqual(['city-bozhedarivka']);
  });

  it('F2 gives Степанівка to Sumy, keeps it out of Kherson, and refuses it bare', () => {
    // The Sumy row is what the archive asks for: five threat mentions, all naming Сумщина, all on
    // the Хотінь–Миколаївка–Степанівка border corridor. Verbatim, in order: c35fec1c-0a04-42d0-921e-
    // 9d6124ffa2e2 (Air Force), 3b4c0d69-7a57-48c1-8319-9bd913109a94 and 10a52c37-dc63-4441-b8d6-
    // b37bc5733d6d (Ринда).
    expect(at('🛵 Сумщина: БпЛА повз Хотінь ➡️ в напрямку Степанівки.'))
      .toEqual(['city-khotin', 'city-stepanivka-sumy', 'ua-59']);
    expect(at('Сумщина:\nБпЛА курсом на Степанівку')).toEqual(['city-stepanivka-sumy', 'ua-59']);
    // The Cherkasy block of the same message is left in verbatim: the settlement it names is not in
    // the trimmed catalogue above, and what matters is that a second oblast in the text does not
    // pull Степанівка out of the one that owns it.
    expect(at('Сумщина:\nМолнія курсом на Степанівку\n\nЧеркащина:\nБпЛА курсом на Канів'))
      .toEqual(['city-stepanivka-sumy', 'ua-59']);
    // The Kherson row earns its place here rather than in the archive: fifty settlements in Ukraine
    // are called Степанівка, so a single row would have resolved every one of these spans wherever
    // the message was talking about. With the pair, the message decides.
    expect(at('Херсонщина: БпЛА курсом на Степанівку')).toEqual(['city-stepanivka-kherson', 'ua-65']);
    // Bare, and naming both oblasts, are the two shapes that must refuse. Before 032 the first of
    // them resolved nothing because the name was absent; it must still resolve nothing now that it
    // is present twice, which is a different reason for the same right answer.
    expect(at('БпЛА курсом на Степанівку')).toEqual([]);
    expect(at('Сумщина та Херсонщина: БпЛА курсом на Степанівку')).toEqual(['ua-59', 'ua-65']);
  });

  it('F3 stops a Kyiv-oblast Калинівка resolving to Vinnytsia, 200 km away', () => {
    // The highest-risk name in `scripts/homonym-audit.mjs`: 85 settlements called Калинівка, 81 of
    // them outside Вінницька область, and the catalogue held only the Vinnytsia місто because the
    // KATOTTG importer reads category M. 02b6756a-b89c-4f0c-acb5-5ba21d313cac, єРадар,
    // 2026-08-08T13:35:45Z, verbatim — the message names Київщина in its first word.
    expect(at('🛵Київщина: БПЛА над Калинівкою')).toEqual(['ua-32']);
    // Two Kyiv-oblast смт carry the name and the archive does not say which one the message means —
    // Баришівка in the follow-up message is twenty kilometres from the Броварський one, Обухів in
    // the message after that is twenty from the Фастівський one — so the pair refuses and the oblast
    // stands alone. An oblast is a true statement; a settlement 200 km away is not.
    expect(at('БпЛА курсом на Калинівку')).toEqual([]);
    // Вінниччина still reaches its own Калинівка, which is the whole point of adding rows rather
    // than removing one.
    expect(at('Вінниччина: БпЛА курсом на Калинівку')).toEqual(['city-kalynivka-vinnytsia', 'ua-05']);
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

// ------------------------------------------------------------------------------------------------
// `v5`: the retrospective veto
// ------------------------------------------------------------------------------------------------

/**
 * A monitoring channel telling readers about the war it is otherwise reporting.
 *
 * Fixture #1 is verbatim from the production archive — єРадар, `source_messages` id
 * a9353a5a-85b6-49d2-82e0-e5956698b696, published 2026-08-09T08:25:53Z — and it is the message this
 * whole layer exists for. It contains `баліст`, `БПЛА`, `ракети` and `Києва`, so `v4` classified it
 * as a live «Київ — комбінована загроза», opened an event and sent a Telegram notification for a
 * reflective essay about people sleeping in the metro.
 *
 * The block below pairs every marker with a message that does *not* carry it, because a veto is only
 * as good as the traffic it leaves alone. The negative of each pair is a real operational shape from
 * the same channels.
 */
const RETROSPECTIVE_ESSAY = [
  'Цієї ночі тисячі киян знову ночували на платформах метро. 💔',
  '',
  'Раніше масовані нальоти БПЛА та часові розрахунки після зльоту бортів стратегічної авіації давали бодай якийсь час на підготовку. ',
  '',
  'Тепер усе інакше. ',
  'росіяни дедалі частіше б’ють балістикою, яка застає людей зненацька посеред ночі. Часу на реакцію просто немає — ракети прилітають за лічені хвилини.',
  '',
  'Через цю непередбачуваність мешканці Києва змушені йти до підземки наперед. Навіть коли тривогу ще не оголосили, люди спускаються в метро, щоб просто встигнути врятуватися.',
  '',
  'Це важко, це страшно, це шалено виснажує морально й фізично. Але іншого варіанту немає — точно знати, коли кацапи запустять чергову балістику по місту, неможливо. Робимо все, щоб вижити. 🙏 ',
  '',
  'Стійкості всім нам.',
  '',
  '@eRadarrua'
].join('\n');

describe('classifyMessage on retrospective and narrative messages (v5)', () => {
  it('refuses the єРадар metro essay that v4 published as a live Kyiv threat', () => {
    const result = classify(RETROSPECTIVE_ESSAY);
    // What `v4` did with this text, kept in the test so the regression is legible: it resolved Kyiv,
    // matched ballistic + UAV + aviation and titled it «Комбінована загроза».
    expect(classify(RETROSPECTIVE_ESSAY.replace('Цієї ночі', 'Зараз БпЛА курсом на')).threatType)
      .toBe('combined');

    expect(result.intent).toBe('none');
    expect(result.locations).toEqual([]);
    expect(isSignificant(result)).toBe(false);
    expect(significanceRejection(result)).toBe('retrospective');
    expect(result.retrospective).toEqual({
      verdict: 'vetoed',
      markers: [
        'ретроспектива: «цієї ночі» з дієсловом минулого часу',
        'ретроспектива: «раніше — тепер»',
        'ретроспектива: розлога оповідь'
      ]
    });
    // The markers are archived as indicators, which is what makes "why was this ignored?" answerable
    // from the classification row alone.
    expect(result.indicators).toEqual(expect.arrayContaining([
      'ретроспектива: «цієї ночі» з дієсловом минулого часу'
    ]));
    // The classes it matched survive as candidates: the message is *about* ballistic missiles, and
    // an archive that forgot that could not answer what the veto suppressed.
    expect(result.signalThreatTypes).toEqual(expect.arrayContaining(['ballistic_missile']));
  });

  describe('summary-bulletin markers, each decisive on its own', () => {
    it('refuses the nightly tally and lets the live warning through', () => {
      expect(significanceRejection(classify('Підсумки ночі: балістика по Києву'))).toBe('retrospective');
      expect(significanceRejection(classify('У ніч на 08 серпня противник атакував Київ балістикою'))).toBe('retrospective');
      expect(significanceRejection(classify('Протягом ночі БпЛА атакували Київ'))).toBe('retrospective');
      expect(significanceRejection(classify('За ніч по Києву застосовано балістику'))).toBe('retrospective');
      expect(significanceRejection(classify('За попередніми даними, по Києву працювала балістика'))).toBe('retrospective');
      // Negative: the same vocabulary with no summary frame.
      expect(isSignificant(classify('Балістика по Києву'))).toBe(true);
    });

    it('does not read «станом на …» as retrospective, because a live snapshot opens that way too', () => {
      // The negative that cost the most to find. «Станом на 09:00» opens the Air Force's morning
      // tally, and «станом на 00:42» opens the strategic-aviation channel's LIVE hourly snapshot —
      // «Приблизна ситуація в повітряному просторі України станом на 00:42 … 2 реактивні БпЛА на
      // Житомир». A `v4 → v5` replay over the production archive showed that treating the phrase as
      // a summary marker would have suppressed three live warnings, for Zhytomyr and Kharkiv. The
      // tally is refused by the markers it carries besides this one; the snapshot publishes.
      expect(isSignificant(classify(
        'Приблизна ситуація в повітряному просторі України станом на 00:42. '
        + 'UPD 1:05 все що залишилося це 2 реактивні БпЛА на Київ.'
      ))).toBe(true);
      expect(isSignificant(classify('Балістика по Києву, підліт 3 хв'))).toBe(true);
    });

    it('refuses an after-action account opened with a start time', () => {
      expect(significanceRejection(classify('Починаючи з 13:00 було застосовано 18 груп реактивних Шахедів по Києву')))
        .toBe('retrospective');
      expect(isSignificant(classify('Група реактивних Шахедів курсом на Київ'))).toBe(true);
    });

    it('refuses the shot-down tally the Air Force publishes each morning', () => {
      expect(significanceRejection(classify('ЗБИТО/ПОДАВЛЕНО 135 ворожих БпЛА над Києвом'))).toBe('retrospective');
      // Negative: a single interception reported as it happens is a de-escalation, not a summary.
      expect(classify('Ціль знищена над Києвом').intent).toBe('de_escalation');
    });

    it('refuses yesterday and publishes today', () => {
      expect(significanceRejection(classify('Вчора ворог атакував Київ балістикою'))).toBe('retrospective');
      expect(significanceRejection(classify('Напередодні по Києву працювала балістика'))).toBe('retrospective');
      expect(isSignificant(classify('Балістична загроза для Києва'))).toBe(true);
    });

    it('refuses last night and publishes this minute', () => {
      expect(significanceRejection(classify('Минулої ночі БпЛА атакували Київ'))).toBe('retrospective');
      expect(significanceRejection(classify('За минулу добу по Києву застосовано балістику'))).toBe('retrospective');
      expect(isSignificant(classify('БпЛА над Києвом'))).toBe(true);
    });
  });

  describe('narration markers, decisive only when nothing operational is present', () => {
    it('needs a past-tense verb beside «цієї ночі», because anticipation is a warning', () => {
      expect(significanceRejection(classify('Цієї ночі БпЛА атакували Київ'))).toBe('retrospective');
      // The same opening with no past tense: an expectation about the night ahead must publish.
      expect(isSignificant(classify('Цієї ночі можлива балістична загроза для Києва'))).toBe(true);
    });

    it('reads the «раніше — тепер» contrast as an argument rather than a report', () => {
      expect(significanceRejection(
        classify('Раніше по Києву була переважно балістика. Тепер усе інакше.')
      )).toBe('retrospective');
      // Negative: «тепер» on its own says the opposite — it is the report.
      expect(isSignificant(classify('Тепер балістика по Києву'))).toBe(true);
    });

    it('reads prose at essay length as narration, and a long bulletin as a bulletin', () => {
      const essay = 'Мешканці Києва щоночі стикаються з новою реальністю повітряної війни, '
        + 'і кожна така ніч змінює те, як місто планує свій наступний день, '
        + 'як батьки збирають дітей до школи і як люди домовляються про зустрічі. '
        + 'Балістика змінила уявлення про час, який залишається людині на реакцію, '
        + 'а БпЛА змінили уявлення про те, скільки годин поспіль може тривати одна тривога '
        + 'і скільки разів за добу доводиться спускатися до підземного паркінгу. '
        + 'Про це варто говорити спокійно, бо страх сам по собі нікого не рятує, '
        + 'а звичка діяти за планом рятує майже завжди.';
      expect(essay.length).toBeGreaterThan(400);
      expect(significanceRejection(classify(essay))).toBe('retrospective');
      // A bulletin of the same length is a list of places, not prose, and every arrow in it is a
      // strong operational marker besides.
      const bulletin = 'Кіровоградська область ◦ Ударний Бп → Богданівка, Кам’янка, Кропивницький. '
        + 'Полтавська область ◦ Ударний Бп → Голобородьківське, Крем’янка, Лутайка, Пронозівка. '
        + 'Черкаська область ◦ Ударний Бп → Малий Ржавець, Пішки, Старосілля, Чигирин, Чорнобай. '
        + 'Чернігівська область ◦ Реактивний → Блешня, Гучин, Рудня ◦ Ударний Бп → Марс, Чернацьке. '
        + 'Сумська область ◦ Ударний Бп → Кириківка, Тростянець, Боромля, Ворожба, Білопілля. '
        + 'Київ ◦ Ударний Бп → Троєщина.';
      expect(bulletin.length).toBeGreaterThan(400);
      expect(isSignificant(classify(bulletin))).toBe(true);
    });

    it('does not read a target forecast as narration, however long it runs', () => {
      // The other expensive negative from the replay. This has exactly the shape of an essay — five
      // hundred characters, several sentences, prose — and it is *prospective*: it names what the
      // enemy may hit and says outright that the timing is unknown. Suppressing a forecast is a
      // different mistake from suppressing a summary, so the essay marker additionally requires a
      // past-tense verb, and there is none here.
      const forecast = 'Згідно деяких даних ворог може завдати удару балістичними ракетами '
        + '«Іскандер-М/С-400/КN-23» та гіперзвуковими ракетами «Циркон» по деяких обʼєктах. '
        + 'Потенційні цілі ураження: Київ: Дарниця, Жуляни, Позняки, Солом’янський район. '
        + 'Київщина: Біла Церква, Бровари, Васильків. '
        + 'Коли саме буде здійснено атаку нам невідомо, але просимо уважно реагувати на сигнал '
        + 'повітряної тривоги, особливо по балістиці — вона долітає за лічені хвилини.';
      expect(forecast.length).toBeGreaterThan(400);
      expect(classify(forecast).retrospective).toBeUndefined();
      expect(isSignificant(classify(forecast))).toBe(true);
    });
  });

  describe('the strong operational markers, each of which overrides every retrospective marker', () => {
    // The safety asymmetry, one case per marker: the message narrates last night AND states
    // something happening now, and every one of them publishes. Missing a retrospective false
    // positive costs a reader one wrong line; suppressing one of these costs them the warning.
    const withYesterday = (now: string) => `Вчора ворог атакував Київ балістикою. ${now}`;

    it('a stated direction', () => {
      expect(isSignificant(classify(withYesterday('БпЛА курсом на Київ')))).toBe(true);
    });

    it('an arrow bulletin', () => {
      expect(isSignificant(classify(withYesterday('Київщина ◦ Ударний Бп → Бровари')))).toBe(true);
    });

    it('the national «загроза застосування» warning', () => {
      expect(isSignificant(classify(withYesterday('Загроза застосування балістичного озброєння')))).toBe(true);
    });

    it('a time to impact', () => {
      expect(isSignificant(classify(withYesterday('Балістика по Києву, 4 хв')))).toBe(true);
    });

    it('the telegraphic target count', () => {
      expect(isSignificant(classify(withYesterday('3х шахеди на Київ')))).toBe(true);
    });

    it('a shelter instruction', () => {
      expect(isSignificant(classify(withYesterday('Балістика по Києву, негайно в укриття')))).toBe(true);
    });

    it('a verb of motion in the present tense', () => {
      expect(isSignificant(classify(withYesterday('Балістика летить на Київ')))).toBe(true);
      expect(isSignificant(classify(withYesterday('Шахеди заходять на Київ')))).toBe(true);
    });
  });

  describe('the grey band', () => {
    // Narration plus a word that might mean "now" and might be part of the story. The rules resolve
    // it towards publishing and mark it, which is the only thing that lets
    // `src/services/retrospective-gate.ts` ask about it.
    const suspect = (now: string) =>
      classify(`Цієї ночі БпЛА атакували Київ, і місто знову не спало. ${now}`);

    it('publishes and flags a narration beside a weak operational word', () => {
      for (const now of ['Зараз тихо.', 'Атака триває.', 'У повітряному просторі ситуація складна.',
        'Пуски фіксувалися всю ніч.', 'Увага киянам.']) {
        const result = suspect(now);
        expect(result.retrospective?.verdict, now).toBe('suspect');
        expect(isSignificant(result), now).toBe(true);
      }
    });

    it('keeps the same message vetoed when the weak word is absent', () => {
      const result = classify('Цієї ночі БпЛА атакували Київ, і місто знову не спало.');
      expect(result.retrospective?.verdict).toBe('vetoed');
    });

    it('does not enter the band at all when a summary marker is present', () => {
      // A summary bulletin is decisive: «Атака триває» inside the Air Force's morning tally is part
      // of the tally, and paying a model call to be told so would be a call spent on a certainty.
      const result = classify('ЗБИТО/ПОДАВЛЕНО 135 ворожих БпЛА над Києвом. Атака триває.');
      expect(result.retrospective?.verdict).toBe('vetoed');
    });
  });

  describe('what the veto is not allowed to touch', () => {
    it('never turns a withdrawal into an assertion', () => {
      const result = classify('Вчора була важка ніч. Наразі по Києву нічого не летить, відбій загрози.');
      expect(result.intent).toBe('de_escalation');
      expect(significanceRejection(result)).toBe('not_an_assertion');
      expect(result.retrospective).toBeUndefined();
    });

    it('never changes a message that was already going to raise nothing', () => {
      // A retrospective with no place in it was `no_threat_recognised`/`no_location` before and
      // stays that way: the veto is applied only to a classification that would otherwise publish,
      // so it cannot rewrite the rejection reasons the archive already uses.
      expect(significanceRejection(classify('Вчора був важкий день. Тримаймося.')))
        .toBe('not_an_assertion');
      expect(significanceRejection(classify('Вчора ворог застосував балістику')))
        .toBe('no_location');
    });

    it('leaves ordinary operational traffic completely unmarked', () => {
      for (const text of ['Ударні БпЛА у напрямку Києва', 'Загроза балістики для Сумщини',
        '⚠️ КИЇВ! УВАГА! РАКЕТА!', 'Одеса дорозвідка', 'Балістика повз Бровари на Бориспіль']) {
        expect(classify(text).retrospective, text).toBeUndefined();
      }
    });
  });
});

// ------------------------------------------------------------------------------------------------
// v6: the guided-bomb pattern
// ------------------------------------------------------------------------------------------------
//
// `каб[а-яіїєґ]*` was a three-letter stem plus a glob, which is to say it matched any Ukrainian word
// beginning with those letters. The channel re-audit behind migration 029 found it from the Russian
// side («декабре» → a guided bomb over Джанкой) and recorded that the Ukrainian half — «Кабмін»,
// «Кабінет» — was still live with 46 monitor rows able to trigger it on routine government news.
// It was not a hypothetical: osint-zhenyok/6ea8fc00-0bb5-4820-aaa9-946db5c7f96f, a news item about a
// cable factory in Zhytomyr, archived as `event_created` / `guided_air_bomb` under `v5`.
//
// The pair below is the shape of every test here: the weapon forms the production archive actually
// contains must all still parse, and the ordinary words must raise nothing **with an oblast name in
// the message**, because a false positive with no place resolves to nothing anyway and would prove
// the wrong thing. The negative cases carry Харківщина, Одещина, Житомир and Херсонщина for exactly
// that reason.

describe('classifyMessage on the guided-bomb pattern (v6)', () => {
  const catalogue = [
    { id: 'ua-63', name: 'Харківська область', aliases: ['харківщина', 'харківщині'], type: 'oblast', geocoded: true },
    { id: 'ua-51', name: 'Одеська область', aliases: ['одещина', 'одещині'], type: 'oblast', geocoded: true },
    { id: 'ua-65', name: 'Херсонська область', aliases: ['херсонщина', 'херсонщині'], type: 'oblast', geocoded: true },
    { id: 'ua-18', name: 'Житомирська область', aliases: ['житомирщина'], type: 'oblast', geocoded: true },
    { id: 'ua-14', name: 'Донецька область', aliases: ['донеччина', 'донеччині'], type: 'oblast', geocoded: true },
    { id: 'ua-city-zaporizhzhia', name: 'Запоріжжя', aliases: ['запоріжжя', 'запоріжжі'], type: 'city', geocoded: true, oblastId: 'ua-23' },
    { id: 'ua-city-zhytomyr', name: 'Житомир', aliases: ['житомир', 'житомирі'], type: 'city', geocoded: true, oblastId: 'ua-18' }
  ];
  const read = (text: string) => classifyMessage(text, catalogue);

  it('reads every weapon form the production archive contains', () => {
    // The four inflections the archive writes (`каб` ×78, `кабів` ×42, `каби` ×37, `кабам` ×5 over
    // 3 434 stored messages, case-insensitive), in the sentences the channels wrote them in, plus
    // the locative plural the alert channel uses for a stand-down. Capitalisation is not the
    // discriminator and must not become one: the telegraphic 🟠 posts write it in lower case.
    for (const text of [
      '🚀 КАБи на Запоріжжі',
      'Загроза застосування керованих авіаційних бомб (КАБів) на Харківщині',
      '🟠 10:09 каб напрямок Житомир',
      '🟠 20:22 Загроза кабів на Донеччині',
      '🟡 10:23 Відбій по кабам на Донеччині',
      '🟡 22:02 Відбій по КАБах на Донеччині',
      'Харківщина: 3 каби буде',
      'КАБами по Херсонщині'
    ]) {
      expect(read(text).threatType, text).toBe('guided_air_bomb');
    }
  });

  it('still reads a KAB written with its calibre', () => {
    // "КАБ-500" ends the token at the hyphen, so a digit suffix costs nothing.
    const result = read('КАБ-500 по Харківщині');
    expect(result.threatType).toBe('guided_air_bomb');
    expect(result.locations.map((location) => location.id)).toEqual(['ua-63']);
  });

  it('reads the compound spelling the channels use when they do not abbreviate', () => {
    // Twelve archived messages carry «керованих авіабомб» and ten of them name no КАБ at all, so
    // this phrase was invisible to the rules before v6.
    expect(read('🔴🔴 22:36 Загроза керованих авіабомб в м. Запоріжжя!').threatType)
      .toBe('guided_air_bomb');
    expect(read('Загроза керованих авіаційних бомб на Харківщині').threatType)
      .toBe('guided_air_bomb');
  });

  it('never reads a government word as a guided bomb, with the oblast named', () => {
    // The two messages the re-audit reproduced against the production catalogue. Under v5 both
    // classified as a significant `guided_air_bomb` — «Кабмін» over Харківська область and
    // «Кабінет» over Одеська область — which is the defect migration 029 recorded.
    for (const text of [
      'Кабмін ухвалив постанову про виплати для Харківщини',
      'Кабінет Міністрів затвердив бюджет для Одещини',
      'Кабмін виділив кошти Херсонщині на відновлення житла'
    ]) {
      const result = read(text);
      expect(result.threatType, text).toBe('unknown');
      expect(result.intent, text).toBe('none');
      expect(result.locations, text).toEqual([]);
      expect(isSignificant(result), text).toBe(false);
      expect(significanceRejection(result), text).toBe('not_an_assertion');
    }
  });

  it('never reads the archived cable-factory report as a guided bomb', () => {
    // Verbatim, osint-zhenyok/6ea8fc00-0bb5-4820-aaa9-946db5c7f96f, 2026-08-09 11:31:42Z. Archived
    // under v5 as `event_created` / `guided_air_bomb` over Житомир: a published threat event whose
    // entire evidence was the word «кабельні». It is pinned verbatim rather than paraphrased
    // because the wording is the finding.
    const result = read('🔶 Країна мразей атакувала підприємство Kromberg & Schubert у Житомирі — '
      + 'виробництво призупинили.\n\nПідприємство виготовляє кабельні системи для автомобілів. '
      + 'Через атаку його виробничі потужності та інфраструктура зазнали значних пошкоджень, тому '
      + 'роботу зупинили на невизначений термін.');
    expect(result.threatType).not.toBe('guided_air_bomb');
    expect(result.locations.map((location) => location.id)).not.toContain('ua-city-zhytomyr');
  });

  it('never reads the other ordinary каб-words the archive contains', () => {
    // «кабінеті» (a driver's cabinet in Дія), «кабінєт» (a joke about a urologist's office) and
    // «кабачки» (courgettes) are the remaining `каб` words in 3 434 archived messages. Each is given
    // an oblast so the refusal cannot be an artefact of there being no place to attach.
    for (const text of [
      'Документ відображатиметься в застосунку «Дія» та Кабінеті водія — Херсонщина',
      'Просьба пройти в кабінєт травматоуролога, Одещина',
      'А кабачки підійдуть замість кукурудзи? Харківщина',
      'У Житомирі прокладають кабельні мережі'
    ]) {
      const result = read(text);
      expect(result.threatType, text).toBe('unknown');
      expect(isSignificant(result), text).toBe(false);
    }
  });

  it('never reads the Russian month out of the middle of a word', () => {
    // Migration 029's finding, from the disabled @krymrealii sample: «в декабре 2025 года». The
    // left-hand `(?<!\p{L})` boundary is what refuses it, and it refuses every other word that
    // merely contains the three letters at the same time.
    const result = read('Евгений Швед – автомеханик из Джанкоя, в декабре 2025 года, Харьковщина');
    expect(result.threatType).not.toBe('guided_air_bomb');
    expect(isSignificant(result)).toBe(false);
  });

  it('does not let the compound form absorb an unguided bomb', () => {
    // «керован» stays required. A ФАБ is a different weapon and this class must not claim it.
    expect(read('Скидання авіабомб по Харківщині').threatType).not.toBe('guided_air_bomb');
  });
});
