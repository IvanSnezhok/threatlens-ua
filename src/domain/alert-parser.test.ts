import { describe, expect, it } from 'vitest';
import { parseAlertChannelMessage, locationKey, type AlertChannelParse } from './alert-parser.js';

/**
 * Every fixture below is a verbatim message from https://t.me/s/air_alert_ua, captured from the live
 * channel while this parser was written. Nothing here reaches the network: the channel's wording is
 * the contract under test, so it is pinned as data.
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
    ['🟢 KAB stand-down under an Увага headline', '🟢 17:49 Увага\n'
      + 'Відбій загрози застосування керованих авіаційних бомб (КАБів).']
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

  it('reports a message with no status circle', () => {
    expect(parse('Технічне повідомлення каналу без кружечка').kind).toBe('unrecognized');
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
