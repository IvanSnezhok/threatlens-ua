import { describe, expect, it } from 'vitest';
import { parseAlertChannelMessage, locationKey, type AlertChannelParse } from './alert-parser.js';

/**
 * Every fixture below is a verbatim message captured from a live channel while this parser was
 * written — https://t.me/s/air_alert_ua for the phrase-first order, and the oblast and city military
 * administrations (khersonskaODA, kyivoda, VinnytsiaODA, oda_rv, slv_vca, kherson_miskrada) for the
 * location-first one. Nothing here reaches the network: the channels' wording is the contract under
 * test, so it is pinned as data.
 *
 * The last-but-one block pins the other half of that contract: wording from channels that are
 * registered in `sources` and switched OFF, sampled 06.08–10.08.2026 for
 * `migrations/029_disabled_channel_reaudit.sql`. Those fixtures assert refusals. A channel is
 * enabled in the catalogue when its wording appears here as an accepted shape, so a shape that
 * appears here as a refused one is the written record of why its channel is still silent.
 */
const OBSERVED_AT = new Date('2026-08-07T11:47:00.000Z');

function parse(text: string): AlertChannelParse {
  return parseAlertChannelMessage(text, OBSERVED_AT);
}

function names(text: string): string[] {
  const result = parse(text);
  if (result.kind !== 'event') throw new Error(`expected an event, got ${result.kind}`);
  return result.event.locationNames;
}

function action(text: string): string {
  const result = parse(text);
  if (result.kind !== 'event') throw new Error(`expected an event, got ${result.kind}`);
  return result.event.action;
}

describe('alert channel parser — alert starts', () => {
  it('reads a single-raion start', () => {
    const text = '🔴 13:47 Повітряна тривога в Новомосковський район\n'
      + 'Слідкуйте за подальшими повідомленнями.\n#Новомосковський_район';
    expect(action(text)).toBe('start');
    expect(names(text)).toEqual(['Новомосковський район']);
  });

  it('reads every location of a bullet-list start', () => {
    const text = '🔴 01:04 Повітряна тривога в \n'
      + '• Вишгородський район\n• Бучанський район\n• Обухівський район\n• Фастівський район\n'
      + '• Білоцерківський район\n• Бориспільський район\n• Броварський район\n'
      + 'Слідкуйте за подальшими повідомленнями.\n'
      + '#Вишгородський_район #Бучанський_район #Обухівський_район #Фастівський_район '
      + '#Білоцерківський_район #Бориспільський_район #Броварський_район';
    expect(names(text)).toEqual([
      'Вишгородський район', 'Бучанський район', 'Обухівський район', 'Фастівський район',
      'Білоцерківський район', 'Бориспільський район', 'Броварський район'
    ]);
  });

  it('reads the city-plus-hromada form as one name', () => {
    const text = '🔴 12:50 Повітряна тривога в м. Харків та Харківська територіальна громада\n'
      + 'Слідкуйте за подальшими повідомленнями.';
    expect(names(text)).toEqual(['м. Харків та Харківська територіальна громада']);
  });

  it('reads a special-city start', () => {
    expect(names('🔴 03:12 Повітряна тривога в м. Київ\nСлідкуйте за подальшими повідомленнями.'))
      .toEqual(['м. Київ']);
  });

  it('keeps the apostrophe the channel printed', () => {
    expect(names('🔴 01:06 Повітряна тривога в Кам’янський район')).toEqual(['Кам’янський район']);
  });
});

describe('alert channel parser — all-clears', () => {
  it('reads a single-raion all-clear and drops the trailing full stop', () => {
    const text = '🟢 14:04 Відбій тривоги в Богодухівський район.\n'
      + 'Слідкуйте за подальшими повідомленнями.\n#Богодухівський_район';
    expect(action(text)).toBe('end');
    expect(names(text)).toEqual(['Богодухівський район']);
  });

  it('reads a bullet-list all-clear', () => {
    const text = '🟢 08:29 Відбій тривоги в \n'
      + '• Кальміуський район\n• Краматорський район\n• Горлівський район\n• Маріупольський район\n'
      + '• Донецький район\n• Бахмутський район\n• Волноваський район\n• Покровський район\n'
      + 'Слідкуйте за подальшими повідомленнями.';
    expect(action(text)).toBe('end');
    expect(names(text)).toHaveLength(8);
    expect(names(text)[0]).toBe('Кальміуський район');
    expect(names(text)[7]).toBe('Покровський район');
  });

  it('reads the city-plus-hromada all-clear', () => {
    const text = '🟢 14:05 Відбій тривоги в м. Харків та Харківська територіальна громада.\n'
      + 'Слідкуйте за подальшими повідомленнями.';
    expect(names(text)).toEqual(['м. Харків та Харківська територіальна громада']);
  });
});

describe('alert channel parser — partial all-clears (🟡)', () => {
  it('refuses to clear a raion the same message says is still under alert', () => {
    // The real defect this rule exists for: the channel clears Kupiansk raion and immediately
    // repeats Kupiansk raion under "тривога ще триває у". Treating it as an all-clear would push an
    // "Офіційний відбій" into a raion that is still under alert.
    const text = '🟡 14:04 Відбій тривоги в Куп’янський район.\n'
      + 'Зверніть увагу, тривога ще триває у:\n- Куп’янський район\n#Купянський_район';
    const result = parse(text);
    expect(result.kind).toBe('ignored');
    expect(result).toMatchObject({ reason: 'partial_all_clear_still_active' });
  });

  it('clears the raions that are not repeated in the still-active list', () => {
    // Seven raions clear; what remains under alert are hromadas inside them, which this catalogue
    // does not model, so the raion-level all-clear stands.
    const text = '🟡 21:16 Відбій тривоги в \n'
      + '• Кам’янський район\n• Новомосковський район\n• Дніпровський район\n• Павлоградський район\n'
      + '• Криворізький район\n• Синельниківський район\n• Нікопольський район\n'
      + 'Зверніть увагу, тривога ще триває у:\n'
      + '- м. Марганець та Марганецька територіальна громада\n'
      + '- м. Нікополь та Нікопольська територіальна громада\n'
      + '- Покровська територіальна громада\n- Червоногригорівська територіальна громада';
    const result = parse(text);
    expect(result.kind).toBe('event');
    expect(names(text)).toHaveLength(7);
    expect(names(text)).toContain('Нікопольський район');
    // The dash list is never mistaken for more locations to clear.
    expect(names(text)).not.toContain('м. Нікополь та Нікопольська територіальна громада');
  });

  it('ignores a bare "still under alert" bulletin', () => {
    const text = '🟡 17:49 Увага\nЗверніть увагу, тривога ще триває у:\n'
      + '- Запорізька область\n- Запорізький район';
    expect(parse(text)).toMatchObject({ kind: 'ignored', reason: 'advisory' });
  });

  it('ignores a "still under alert" bulletin whose headline is a typo', () => {
    // Verbatim: the channel published a headline consisting of the single letter "к".
    const text = '🟡 10:06 к\nЗверніть увагу, тривога ще триває у:\n'
      + '- Кальміуський район\n- Краматорський район\n- Горлівський район';
    expect(parse(text)).toMatchObject({ kind: 'ignored', reason: 'still_active_notice' });
  });

  it('clears the city a 🟡 names when the still-active list names the raion around it', () => {
    // Verbatim, 08.08.2026 10:30 — and published two seconds after the threat stand-down pinned
    // below as "🟡 drone-attack stand-down carrying the still-active list". Same circle, same
    // addendum, same minute, opposite outcome: the only thing that separates them is "тривоги в".
    const text = '🟡 10:30 Відбій тривоги в м. Нікополь та Нікопольська територіальна громада.\n'
      + 'Зверніть увагу, тривога ще триває у:\n- Нікопольський район\n'
      + '#м_Нікополь_та_Нікопольська_територіальна_громада';
    expect(action(text)).toBe('end');
    // The raion around the city is a different catalogue row, so the subtraction does not fire.
    expect(names(text)).toEqual(['м. Нікополь та Нікопольська територіальна громада']);
  });

  it('clears the raions of a bullet-list 🟡 that the hromada-level addendum does not repeat', () => {
    // Verbatim, 07.08.2026 18:14. Seven raions clear; what stays under alert are hromadas inside
    // them, which this catalogue does not model, so the raion-level all-clear stands.
    const text = '🟡 18:14 Відбій тривоги в \n'
      + '• Кам’янський район\n• Новомосковський район\n• Дніпровський район\n• Павлоградський район\n'
      + '• Криворізький район\n• Синельниківський район\n• Нікопольський район\n'
      + 'Зверніть увагу, тривога ще триває у:\n'
      + '- м. Марганець та Марганецька територіальна громада\n'
      + '- Покровська територіальна громада\n- Червоногригорівська територіальна громада\n'
      + '#Камянський_район #Новомосковський_район #Дніпровський_район #Павлоградський_район '
      + '#Криворізький_район #Синельниківський_район #Нікопольський_район';
    expect(action(text)).toBe('end');
    expect(names(text)).toEqual([
      'Кам’янський район', 'Новомосковський район', 'Дніпровський район', 'Павлоградський район',
      'Криворізький район', 'Синельниківський район', 'Нікопольський район'
    ]);
  });
});

/**
 * @air_alert_ua publishes more than alert transitions. Under a single oblast hashtag it also runs a
 * guided-bomb commentary — 🟠 "КАБ напрямок Краматорськ" while the bombs are in the air, a 🟡
 * stand-down once they are not — and every stand-down repeats the *same* body: "Зверніть увагу,
 * тривога ще триває у:" over all eight raions of Донецька область. Only the headline varies, and it
 * is whatever the duty officer typed. Verbatim pairs from the production archive, 07.08–09.08.2026:
 *
 *   🟠 15:37 КАБ напрямок Краматорськ            → 🟡 15:51 к
 *   🟠 04:23 КАБ напрямок Слов'янськ             → 🟡 05:01 е
 *   🟠 11:29 КАБи в напрямку Краматорськ-Дружківка‼️ → 🟡 11:58 Відбій
 *   🟠 20:22 Загроза кабів Краматорськ Словянськ → 🟡 20:53 Відбій
 *   🟠 09:45…10:10 КАБ напрямок … (six posts)    → 🟡 10:23 Відбій по кабам
 *
 * The bare "Відбій" is therefore the elided member of the "Відбій <загрози|атаки|по …>" family, not
 * a partial all-clear that lost its location. The air-raid alert over those eight raions ran
 * through every one of these messages and ended, ten hours after the 20:53 one, in the shape this
 * parser does read. Both shapes are pinned here side by side because the wording is all that
 * separates a threat standing down from an authority saying the air-raid alert is over.
 */
describe('alert channel parser — the national channel\'s per-oblast threat thread', () => {
  const stillActiveDonetsk = 'Зверніть увагу, тривога ще триває у:\n'
    + '- Кальміуський район\n- Краматорський район\n- Горлівський район\n- Маріупольський район\n'
    + '- Донецький район\n- Бахмутський район\n- Волноваський район\n- Покровський район\n'
    + '#Донецька_область';

  it('refuses a bare "Відбій" headline carrying the still-active list', () => {
    // Verbatim, 08.08.2026 20:53. The message says in its own body that the alert is still running
    // in all eight raions of the oblast it covers; the real all-clear for them arrived at 06:45 the
    // next morning. Reading this as an air-raid all-clear would push an "Офіційний відбій" into a
    // frontline oblast under a live alert — the one failure this project treats as unrecoverable.
    expect(parse(`🟡 20:53 Відбій\n${stillActiveDonetsk}`))
      .toMatchObject({ kind: 'ignored', reason: 'still_active_notice' });
  });

  it('refuses the same body under the spelled-out KAB stand-down headline', () => {
    // Verbatim, 09.08.2026 10:23 — the same shape with the subject printed instead of elided.
    expect(parse(`🟡 10:23 Відбій по кабам\n${stillActiveDonetsk}`))
      .toMatchObject({ kind: 'ignored', reason: 'threat_notice' });
  });

  it('refuses the same body under the typo\'d headlines the channel also publishes', () => {
    // Verbatim, 07.08.2026 15:51 and 08.08.2026 05:01. These are what prove the addendum, not the
    // headline, is the reliable part of the shape.
    expect(parse(`🟡 15:51 к\n${stillActiveDonetsk}`))
      .toMatchObject({ kind: 'ignored', reason: 'still_active_notice' });
    expect(parse(`🟡 05:01 е\n${stillActiveDonetsk}`))
      .toMatchObject({ kind: 'ignored', reason: 'still_active_notice' });
  });

  it('reads the real all-clear the same raions eventually got', () => {
    // Verbatim, 08.08.2026 19:19. This is the contrast the block exists for: when the authority
    // ends the air-raid alert it prints "Відбій тривоги в" and lists the raions with • bullets.
    const text = '🟢 19:19 Відбій тривоги в \n'
      + '• Кальміуський район\n• Краматорський район\n• Горлівський район\n• Маріупольський район\n'
      + '• Донецький район\n• Бахмутський район\n• Волноваський район\n• Покровський район\n'
      + 'Слідкуйте за подальшими повідомленнями.\n'
      + '#Кальміуський_район #Краматорський_район #Горлівський_район #Маріупольський_район '
      + '#Донецький_район #Бахмутський_район #Волноваський_район #Покровський_район';
    expect(action(text)).toBe('end');
    expect(names(text)).toEqual([
      'Кальміуський район', 'Краматорський район', 'Горлівський район', 'Маріупольський район',
      'Донецький район', 'Бахмутський район', 'Волноваський район', 'Покровський район'
    ]);
  });

  it('refuses a bare "Відбій" that arrives without the addendum, loudly', () => {
    // Never published, and that is the point: with no addendum there is nothing reliable left to
    // read, so the shape stays `unrecognized` and wakes the wording-drift alarm rather than being
    // guessed at as "probably a full all-clear".
    expect(parse('🟡 20:53 Відбій').kind).toBe('unrecognized');
    expect(parse('🟢 20:53 Відбій\nСлідкуйте за подальшими повідомленнями.').kind)
      .toBe('unrecognized');
  });
});

/**
 * The oblast and city military administrations publish the same three transitions in the opposite
 * word order, with no printed clock and one location per message. Fixtures below are verbatim from
 * https://t.me/s/khersonskaODA, kyivoda, VinnytsiaODA, oda_rv, slv_vca and kherson_miskrada.
 */
describe('alert channel parser — the administrations\' location-first word order', () => {
  it('reads a start whose location comes before the phrase', () => {
    expect(action('🔴 Бериславський район - повітряна тривога!')).toBe('start');
    expect(names('🔴 Бериславський район - повітряна тривога!')).toEqual(['Бериславський район']);
  });

  it('reads an all-clear whose location comes before the phrase', () => {
    expect(action('🟢 Каховський район - відбій повітряної тривоги!')).toBe('end');
    expect(names('🟢 Каховський район - відбій повітряної тривоги!')).toEqual(['Каховський район']);
  });

  it('keeps a hyphenated raion name intact', () => {
    // `Могилів-Подільський` carries an unspaced hyphen inside the name; the separator is a spaced
    // dash. Splitting on the wrong one would leave "Могилів" and never resolve against the catalogue.
    expect(names('🔴 Могилів-Подільський район - повітряна тривога!'))
      .toEqual(['Могилів-Подільський район']);
  });

  it('clears the raion a 🟡 names and leaves the ones it lists as still under alert', () => {
    const text = '🟡 Скадовський район - відбій повітряної тривоги!\n\n'
      + 'Зверніть увагу, повітряна тривога досі триває у:\n'
      + '- Бериславський район\n- Генічеський район\n- Каховський район\n- Херсонський район';
    expect(action(text)).toBe('end');
    // The administrations list the *other* raions, never the one they are clearing, so the
    // subtraction is a no-op here — and stays in place so that the day one of them does repeat it,
    // the all-clear is refused exactly as it is on the national channel.
    expect(names(text)).toEqual(['Скадовський район']);
    const result = parse(text);
    if (result.kind !== 'event') throw new Error('expected an event');
    expect(result.event.stillActiveNames).toEqual([
      'Бериславський район', 'Генічеський район', 'Каховський район', 'Херсонський район'
    ]);
  });

  it('reads "досі триває" the same way as the national channel\'s "ще триває"', () => {
    // Same trap, the administrations' wording: the cleared raion repeated under the still-active
    // list must not produce an "Офіційний відбій" for a raion that is still under alert.
    const text = '🟡 Херсонський район - відбій повітряної тривоги!\n\n'
      + 'Зверніть увагу, повітряна тривога досі триває у:\n- Херсонський район\n- Каховський район';
    expect(parse(text)).toMatchObject({ kind: 'ignored', reason: 'partial_all_clear_still_active' });
  });

  it('carries no printed clock', () => {
    const result = parse('🔴 Краматорський район - повітряна тривога!');
    expect(result).toMatchObject({ kind: 'event', event: { channelClock: null } });
  });

  it('refuses a threat stand-down dressed in the same word order', () => {
    // The whole reason "повітрян…" is mandatory in front of "тривог…" in the location-first
    // patterns: without it these would end a running air-raid alert.
    expect(parse('🟢 Херсонський район - відбій загрози ударних БпЛА!'))
      .toMatchObject({ kind: 'ignored', reason: 'threat_notice' });
    expect(parse('🔴 Херсонський район - загроза застосування КАБів!'))
      .toMatchObject({ kind: 'ignored', reason: 'threat_notice' });
  });

  it('refuses a circle that disagrees with the location-first wording', () => {
    expect(parse('🟢 Бериславський район - повітряна тривога!').kind).toBe('unrecognized');
    expect(parse('🔴 Бериславський район - відбій повітряної тривоги!').kind).toBe('unrecognized');
  });

  it('reports an all-clear that names no location instead of clearing everything', () => {
    // Verbatim from https://t.me/s/odeskaODA, which publishes its locations *above* the phrase and
    // then gives the all-clear with no location at all. "Everything this source holds" is not a
    // reading this parser is allowed to invent, so the shape is surfaced rather than acted on.
    expect(parse('🟢 Відбій повітряної тривоги!').kind).toBe('unrecognized');
    expect(parse('❗️ Одеський район\n\n🔴 Повітряна тривога!'))
      .toMatchObject({ kind: 'ignored', reason: 'unrelated' });
  });
});

describe('alert channel parser — messages that must never move alert state', () => {
  const notAlerts: Array<[string, string]> = [
    ['🟠 evacuation notice', '🟠 13:59 БЕЗКОШТОВНА ЕВАКУАЦІЯ\n'
      + 'Просимо терміново евакуюватися із зони бойових дій або небезпечної території Харківської '
      + 'області. Цілодобова БЕЗКОШТОВНА гаряча лінія – тел. 203\n#Купянський_район'],
    ['🟠 KAB advisory', '🟠 21:56 УВАГА!!!\nЗагроза застосування керованих авіаційних бомб (КАБів).\n'
      + '#Пологівський_район'],
    ['🟠 kamikaze drone attack', '🟠 08:10 Атака дронів-камікадзе\nРайон Лапинки, рух до центру міста \n'
      + '#м_Нікополь_та_Нікопольська_територіальна_громада'],
    ['🟠 KAB direction', '🟠 09:53 КАБ напрямок Краматорськ\nк\n#Донецька_область'],
    ['🔴🔴 heightened danger', '🔴🔴 16:02 Загроза керованих авіабомб в м. Запоріжжя та Запорізька '
      + 'територіальна громада!\nУвага! Підвищений рівень небезпеки! Пройдіть у найближче укриття'],
    ['🔴🔴 UAV threat', '🔴🔴 14:03 Загроза ударних БпЛА в м. Запоріжжя та Запорізька територіальна '
      + 'громада!\nЗагроза ударних БпЛА'],
    ['🟢 threat stand-down', '🟢 15:49 Відбій загрози ударних БпЛА\nВідбій загрози ударних БпЛА\n'
      + '#м_Харків_та_Харківська_територіальна_громада'],
    ['🟢 artillery stand-down', '🟢 17:49 Відбій загрози артобстрілу в м. Нікополь та Нікопольська '
      + 'територіальна громада.\nСлідкуйте за подальшими повідомленнями.'],
    ['🟢 drone attack stand-down', '🟢 17:49 Відбій атаки дронів-камікадзе\n'
      + 'Слідкуйте за подальшими повідомленнями.'],
    ['🟡 KAB stand-down', '🟡 22:02 Відбій по КАБах\nЗверніть увагу, тривога ще триває у:\n'
      + '- Кальміуський район\n- Краматорський район'],
    // The four shapes below are verbatim, and each one carries the "still under alert" addendum that
    // a partial all-clear also carries. The addendum is not what makes a message an all-clear; the
    // phrase "відбій … тривоги" is. Without these pins, widening the parser to read the addendum
    // alone would turn every one of them into an "Офіційний відбій" over a live alert.
    ['🟡 KAB stand-down carrying the still-active list', '🟡 08:51 Відбій загрози застосування '
      + 'керованих авіаційних бомб (КАБів).\nЗверніть увагу, тривога ще триває у:\n'
      + '- Запорізька область\n- Запорізький район\n#Запорізький_район'],
    ['🟡 drone-attack stand-down carrying the still-active list', '🟡 10:30 Відбій атаки '
      + 'дронів-камікадзе\nЗверніть увагу, тривога ще триває у:\n- Нікопольський район\n'
      + '#м_Нікополь_та_Нікопольська_територіальна_громада'],
    // The nastiest near miss in the archive: a threat stand-down that also names a place after "в",
    // so it is one word ("загрози") away from the accepted all-clear shape.
    ['🟡 artillery stand-down that names a place after "в"', '🟡 15:34 Відбій загрози артобстрілу '
      + 'в м. Нікополь та Нікопольська територіальна громада.\n'
      + 'Зверніть увагу, тривога ще триває у:\n- Дніпропетровська область\n- Нікопольський район\n'
      + '#м_Нікополь_та_Нікопольська_територіальна_громада'],
    ['🟡 УВАГА bulletin carrying the still-active list', '🟡 18:10 УВАГА !!!\n'
      + 'Зверніть увагу, тривога ще триває у:\n- Запорізька область\n- Пологівський район\n'
      + '#Пологівський_район'],
    ['🟢 KAB stand-down under an Увага headline', '🟢 17:49 Увага\n'
      + 'Відбій загрози застосування керованих авіаційних бомб (КАБів).'],
    // Verbatim, and the reason "загроз" is no longer anchored to the start of the headline: the
    // national channel writes the noun second here, and the shape was reported as unknown until it.
    ['🔴🔴 missile threat with the noun second', '🔴🔴 17:46 Ракетна загроза в м. Запоріжжя та '
      + 'Запорізька територіальна громада!']
  ];

  it.each(notAlerts)('ignores %s', (_label, text) => {
    // The failure this pins: "🟢 Відбій загрози ударних БпЛА" cancelling an air-raid alert that is
    // still running, and "🔴🔴 Загроза керованих авіабомб" starting one that was never declared.
    expect(parse(text).kind).toBe('ignored');
  });

  it('reports the threat-notice family separately from advisories', () => {
    expect(parse('🟢 15:49 Відбій загрози ударних БпЛА'))
      .toMatchObject({ kind: 'ignored', reason: 'threat_notice' });
    expect(parse('🟠 08:10 Атака дронів-камікадзе\nРайон Лапинки'))
      .toMatchObject({ kind: 'ignored', reason: 'advisory' });
  });
});

describe('alert channel parser — shapes it does not know', () => {
  it('reports an unknown headline instead of dropping it', () => {
    const result = parse('🔴 12:00 Нова невідома фраза каналу\nТекст.');
    expect(result).toEqual({ kind: 'unrecognized', headline: 'Нова невідома фраза каналу' });
  });

  it('reports an alert phrase published without a status circle', () => {
    // The wording-drift alarm the `unrelated` bucket must never swallow: the vocabulary is there,
    // the circle is not, so which half moved is unknown and guessing is the wrong answer.
    expect(parse('Повітряна тривога в Одеський район').kind).toBe('unrecognized');
    expect(parse('Бериславський район - повітряна тривога!').kind).toBe('unrecognized');
  });

  it('files an ordinary post with neither a circle nor the alert vocabulary as unrelated', () => {
    // An administration channel publishes news between its alerts, and about a third of those posts
    // mention "повітряної тривоги" in passing. Reporting them as unknown *shapes* would bury a real
    // wording change under a permanent stream of school-bus announcements.
    expect(parse('Технічне повідомлення каналу без кружечка'))
      .toMatchObject({ kind: 'ignored', reason: 'unrelated' });
    // Verbatim, https://t.me/s/VinnytsiaODA.
    expect(parse('⏳З 00:00 розпочалася комендантська година. Вона триватиме до 5:00.\n\n'
      + 'Нагадуємо, що перебування на вулиці в цей час заборонено 🚫\n\n'
      + '☝️Виходити можна лише для того, щоб дійти до найближчого укриття у разі сигналу '
      + 'повітряної тривоги.')).toMatchObject({ kind: 'ignored', reason: 'unrelated' });
  });

  it('reports an alert phrase that names no location', () => {
    expect(parse('🔴 12:00 Повітряна тривога в \nСлідкуйте за подальшими повідомленнями.').kind)
      .toBe('unrecognized');
  });

  it('reports a circle that disagrees with the wording', () => {
    // A green circle over "Повітряна тривога" means the vocabulary moved; guessing which half is
    // right is exactly the wrong response for an alert source.
    expect(parse('🟢 12:00 Повітряна тривога в Одеський район').kind).toBe('unrecognized');
  });

  it('ignores an empty message', () => {
    expect(parse('   \n  ')).toMatchObject({ kind: 'ignored', reason: 'empty' });
  });
});

/**
 * The catalogue re-audit of 10.08.2026 (`migrations/029_disabled_channel_reaudit.sql`).
 *
 * Every message below is verbatim from the public preview of a channel that is registered in
 * `sources` and switched OFF, sampled 06.08–10.08.2026. None of them may become an alert transition,
 * and each one is here because it is adjacent to a family the parser deliberately excludes: an
 * unlocated declaration, an "УВАГА" advisory, an oblast-wide scope with an exclusion clause, or a
 * prose mention inside a news post. Pinning them is what stops a future change made to admit one of
 * these channels from admitting it by accident, and what gives whoever builds the missing design a
 * written-down statement of the shape they have to read.
 */
describe('alert channel parser — the shapes that keep channels switched off', () => {
  it('refuses the unlocated oblast-wide declaration @ternopilskaODA publishes', () => {
    // ternopilskaODA/26967 and /26968, 07.08.2026, twenty-seven minutes apart: a complete alert and
    // its all-clear with no location anywhere in either message. The scope is the oblast and it
    // lives in the identity of the channel, which this parser deliberately does not know — it takes
    // a source id from the caller and applies every shape to every channel. Reading these would
    // need a per-source default scope in the catalogue, not a pattern here.
    expect(parse('УВАГА‼️Повітряна тривога! Пройдіть негайно в укриття!'))
      .toMatchObject({ kind: 'ignored', reason: 'advisory' });
    expect(parse('Відбій повітряної тривоги‼️'))
      .toMatchObject({ kind: 'ignored', reason: 'unrelated' });
  });

  it('refuses the Zaporizhzhia prose format, exclusion clause and all', () => {
    // zoda_gov_ua/65746 and /65749, 09.08.2026, republished within two seconds by
    // ivan_fedorov_zp/45788 and /45791. "крім" carries an exclusion the location model cannot
    // express, and the readable sibling names «всій Запорізькій області» — a phrase, not a
    // catalogue row. Migration 014 refused this format; this is the same format four months on.
    expect(parse('🚨УВАГА🚨\nОголошена повітряна тривога у громадах Запорізької області, '
      + 'крім міста Запоріжжя!\nБережіть себе і терміново прослідуйте у безпечне місце!'))
      .toMatchObject({ kind: 'ignored', reason: 'unrelated' });
    expect(parse('🚨УВАГА🚨\nОголошена повітряна тривога по всій Запорізькій області!\n'
      + 'Бережіть себе і терміново прослідуйте у безпечне місце!'))
      .toMatchObject({ kind: 'ignored', reason: 'unrelated' });
  });

  it('refuses the Zaporizhzhia all-clears, whose scope does not pair with their starts', () => {
    // zoda_gov_ua/65744 and /65748. Both are unambiguous sentences; neither pairs reliably with the
    // starts above — 09.08 ran "крім міста Запоріжжя" at 16:34 and closed with "по Запорізькій
    // області" at 17:19. A parser that read the starts it understood and refused these would leave
    // alerts running until `ALERT_CHANNEL_MAX_ALERT_SECONDS` swept them.
    //
    // Note which bucket they land in: `unrelated`, not `unrecognized`. ✅ is not a status circle and
    // "по" is not the "в/у" the end pattern anchors on, so nothing in the message reaches the
    // wording-drift alarm. That is the documented cost of enabling a channel whose format was never
    // read — its all-clears would be silent, not loud.
    expect(parse('✅ Відбій повітряної тривоги по Запорізькій області та м. Запоріжжя!'))
      .toMatchObject({ kind: 'ignored', reason: 'unrelated' });
    expect(parse('✅ Відбій повітряної тривоги по Запорізькій області!'))
      .toMatchObject({ kind: 'ignored', reason: 'unrelated' });
  });

  it('refuses the Zaporizhzhia threat notices published inside a running alert', () => {
    // ivan_fedorov_zp/45794 and /45793, 09.08.2026. Nine of that channel's eighteen sampled posts
    // are this family. They sit next to the all-clears above in the same feed, which is why the
    // "Загроза …" exclusion has to survive any change made to read that channel.
    expect(parse('‼️УВАГА! Загроза застосування керованих авіаційних бомб (КАБів) '
      + 'по Запорізькій області та м. Запоріжжя‼️'))
      .toMatchObject({ kind: 'ignored', reason: 'threat_notice' });
    expect(parse('‼️УВАГА! Активність ворожої тактичної авіації! '
      + 'Загроза для Запорізької області та м. Запоріжжя‼️'))
      .toMatchObject({ kind: 'ignored', reason: 'threat_notice' });
  });

  it('files an administration news post that mentions the vocabulary as unrelated', () => {
    // dnipropetrovskaODA/31281 and odeskaODA/18400, 08–09.08.2026. Both are what A2/A4 said the
    // administration feeds are: reporting, with the alert vocabulary in a subordinate clause. They
    // must stay out of the wording-drift alarm or the alarm is worthless.
    expect(parse('Гучні звуки, які чули мешканці Дніпра, - бойова робота наших сил ППО.\n\n'
      + 'До відбою повітряної тривоги перебувайте у безпечних місцях.'))
      .toMatchObject({ kind: 'ignored', reason: 'unrelated' });
    expect(parse('На жаль, до 12 людей збільшилася кількість постраждалих внаслідок нічної атаки '
      + 'ворога по Одещині. 11 людей госпіталізовані в стані середньої тяжкості. Ще одному '
      + 'постраждалому допомогу надано амбулаторно.\n\nПрошу мешканців не ігнорувати сигнали '
      + 'повітряної тривоги та залишатися в укриттях до відбою.'))
      .toMatchObject({ kind: 'ignored', reason: 'unrelated' });
  });

  it('refuses the @alarm_kyiv alert-state mirror, which is a monitor row and not an alert channel', () => {
    // alarm_kyiv/2690 and /2691, 10.08.2026. Twenty of twenty posts are this pair. The row is
    // `mtproto_monitor`, so this text never reaches this parser today — it is pinned because the
    // shape is one flag away from being read as an official alert for the capital, and because the
    // asymmetry below is the whole argument for keeping it a monitor: the 🟢 half reaches the
    // wording-drift alarm and the 🚨 half does not, so the channel would clear more loudly than it
    // alerts.
    expect(parse('🚨 м. Київ\nПовітряна тривога'))
      .toMatchObject({ kind: 'ignored', reason: 'unrelated' });
    expect(parse('🟢 м. Київ\nВідбій повітряної тривоги'))
      .toEqual({ kind: 'unrecognized', headline: 'м. Київ' });
  });
});

describe('alert channel parser — timestamps and formatting noise', () => {
  it('echoes the caller-supplied Telegram time and never the printed clock', () => {
    const result = parse('🔴 13:47 Повітряна тривога в Одеський район');
    expect(result).toMatchObject({ kind: 'event' });
    if (result.kind !== 'event') return;
    expect(result.event.observedAt).toBe(OBSERVED_AT);
    expect(result.event.channelClock).toBe('13:47');
  });

  it('parses a message that carries no printed clock', () => {
    const result = parse('🔴 Повітряна тривога в Одеський район');
    expect(result).toMatchObject({ kind: 'event' });
    if (result.kind !== 'event') return;
    expect(result.event.channelClock).toBeNull();
    expect(result.event.locationNames).toEqual(['Одеський район']);
  });

  it('survives stray punctuation, doubled spaces and a trailing hashtag block', () => {
    const text = '🟢  14:05   Відбій тривоги в   Лозівський  район ... \n\n'
      + 'Слідкуйте за подальшими повідомленнями.\n\n#Лозівський_район';
    expect(names(text)).toEqual(['Лозівський район']);
  });

  it('reports the air_raid type for every transition it emits', () => {
    const result = parse('🔴 13:47 Повітряна тривога в Одеський район');
    expect(result).toMatchObject({ kind: 'event', event: { alertType: 'air_raid' } });
  });
});

describe('locationKey', () => {
  it('folds apostrophe variants and trailing punctuation to one comparison key', () => {
    expect(locationKey('Куп’янський район.')).toBe(locationKey('- Куп\'янський  район'));
    expect(locationKey('м. Нікополь та Нікопольська територіальна громада'))
      .toBe('м. нікополь та нікопольська територіальна громада');
  });
});
