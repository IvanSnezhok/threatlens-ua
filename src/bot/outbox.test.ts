import { describe, expect, it } from 'vitest';
import { formatMessage } from './outbox.js';
import {
  cleanSummary, evidenceRaisedLine, evidenceStatement, extensionLine, geographyChangedLine,
  humanMoment, riskLevelChangedLine, threatTypeChangedLine, validUntilLine
} from './humanize.js';

// 2026-08-08T00:13:46Z is 03:13 in Kyiv (UTC+3 in summer), which is the whole point of the fixture:
// a naive formatter would print 00:13 and send people to a shelter an hour off.
const now = new Date('2026-08-08T00:13:46.000Z');

describe('Telegram notification formatting', () => {
  it('escapes source-controlled HTML', () => {
    // Обидва поля термінового попередження приходять від джерела: назву місця бере каталог, а
    // напрямок — дослівно з тексту каналу, і саме він тепер друкується там, де раніше стояла цитата.
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      locationName: '<b>Київ</b>', threatType: 'uav', evidenceLevel: 'monitoring',
      directionText: '<script>alert(1)</script>', summary: 'байдуже', validUntil: 'soon'
    } }, now);
    expect(text).not.toContain('<script>');
    expect(text).toContain('&lt;script&gt;');
    expect(text).toContain('&lt;b&gt;Київ&lt;/b&gt;');
  });

  it('labels nightly percentages as indicative rather than statistical probability', () => {
    const text = formatMessage({ notification_type: 'nightly_digest', payload: {
      generatedTime: '23:20', assessments: [{ locationName: 'Полтава', threatType: 'ballistic_missile',
        level: 'elevated', indicativePercent: 35, score: 3.5, explanation: {} }], omitted: 0
    } }, now);
    expect(text).toContain('35% індикативного рівня');
    expect(text).toContain('не статистична ймовірність');
  });

  it('states validity in Kyiv time with a remaining-time hint instead of an ISO string', () => {
    // Дедлайн лишився там, де в читача є час його прочитати: у публікації каналу й у дельті. З
    // термінового попередження він пішов навмисне — це не вказівка до дії, — але ISO-рядок не сміє
    // просочитися в ЖОДНЕ повідомлення, і саме це друга половина перевірки.
    const published = formatMessage({ notification_type: 'channel_publication', payload: {
      locationName: 'Київ', threatType: 'ballistic_missile', evidenceLevel: 'unverified',
      summary: 'Загроза застосування балістики', validUntil: '2026-08-08T00:38:46.000Z'
    } }, now);
    expect(published).toContain('Актуально до 03:38 (ще ~25 хв)');
    const urgent = formatMessage({ notification_type: 'threat_update', payload: {
      locationName: 'Київ', threatType: 'ballistic_missile', evidenceLevel: 'confirmed',
      summary: 'Загроза застосування балістики', validUntil: '2026-08-08T00:38:46.000Z'
    } }, now);
    for (const text of [published, urgent]) {
      expect(text).not.toContain('2026-08-08T00:38:46.000Z');
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('spells out the evidence level instead of leaking the database enum', () => {
    // Повне речення — там, де людина читає не поспішаючи (канал, очікувана загроза).
    const unhurried = formatMessage({ notification_type: 'channel_publication', payload: {
      locationName: 'Київ', threatType: 'ballistic_missile', evidenceLevel: 'confirmed', summary: 'Пуски'
    } }, now);
    expect(unhurried).toContain('Підтверджено кількома джерелами');
    expect(unhurried).not.toContain('confirmed');
  });

  it('compresses the evidence level to a badge in an urgent warning without losing it', () => {
    // Рівень доказовості не зникає з термінового попередження — він стає словом у заголовку.
    // `CONTEXT.md` ставить офіційні сигнали над аналітикою, і читач мусить бачити цю різницю;
    // абзац під заголовком коштує секунд там, де секунди коштують найдорожче.
    const confirmed = formatMessage({ notification_type: 'threat_update', payload: {
      locationName: 'Київ', threatType: 'ballistic_missile', evidenceLevel: 'confirmed', summary: 'Пуски'
    } }, now);
    expect(confirmed).toContain('⚠️ <b>Київ — балістичні ракети</b> · підтверджено');
    expect(confirmed).not.toContain('Підтверджено кількома джерелами');
    expect(confirmed).not.toContain('confirmed');

    const unverified = formatMessage({ notification_type: 'threat_update', payload: {
      locationName: 'Київ', threatType: 'uav', evidenceLevel: 'unverified', summary: 'Шахеди'
    } }, now);
    expect(unverified).toContain('· неперевірено');
    expect(unverified).not.toContain('unverified');
  });

  it('leads an urgent warning with where the target is, taken verbatim from the source', () => {
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      locationName: 'Київська область', threatType: 'uav', evidenceLevel: 'monitoring',
      directionText: 'курсом на Бровари', summary: 'Ударні БпЛА курсом на Бровари, група з півдня'
    } }, now);
    expect(text).toContain('📍 курсом на Бровари');
    expect(text.indexOf('📍')).toBeLessThan(text.indexOf('в укриття'));
    // Цитата поста більше не їде в поштовх: заголовок і напрямок уже сказали те саме, коротше.
    expect(text).not.toContain('група з півдня');
  });

  it('says nothing about the direction when the source named none', () => {
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      locationName: 'Київ', threatType: 'uav', evidenceLevel: 'monitoring', summary: 'Шахеди'
    } }, now);
    expect(text).not.toContain('📍');
  });

  it('never emits a dead link: no source in the payload means no link at all', () => {
    for (const row of [
      { notification_type: 'alert_start', payload: { locationName: 'Київ', startedAt: now.toISOString() } },
      { notification_type: 'alert_end', payload: { locationName: 'Київ', endedAt: now.toISOString() } },
      { notification_type: 'threat_update', payload: { locationName: 'Київ', threatType: 'uav', evidenceLevel: 'monitoring', summary: 'Шахеди' } },
      { notification_type: 'assessment_update', payload: { locationName: 'Київ', threatType: 'uav', level: 'elevated', score: 3.5, indicativePercent: 35, confidence: 'medium', explanation: {} } },
      { notification_type: 'nightly_digest', payload: { generatedTime: '23:20', omitted: 0, assessments: [
        { locationName: 'Київ', threatType: 'uav', level: 'elevated', indicativePercent: 35, score: 3.5, explanation: {} }
      ] } }
    ]) {
      const text = formatMessage(row, now);
      expect(text).not.toContain('<a href');
      expect(text).not.toContain('Карта та джерела');
      expect(text).not.toContain('undefined');
    }
  });

  it('links the originating channel message when the payload carries one', () => {
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      locationName: 'Київ', threatType: 'uav', evidenceLevel: 'monitoring', summary: 'Шахеди',
      sourceUrl: 'https://t.me/monitor/1234', sourceName: 'Моніторинг'
    } }, now);
    expect(text).toContain('<a href="https://t.me/monitor/1234">Першоджерело: Моніторинг</a>');
  });

  it('ignores a source value that is not an http link', () => {
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      locationName: 'Київ', threatType: 'uav', evidenceLevel: 'monitoring', summary: 'Шахеди',
      sourceUrl: 'javascript:alert(1)', sourceName: 'Моніторинг'
    } }, now);
    expect(text).not.toContain('<a href');
  });

  it('puts the action before the details in a threat message', () => {
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      locationName: 'Київ', threatType: 'ballistic_missile', evidenceLevel: 'confirmed',
      directionText: 'курсом на Київ', summary: 'Загроза балістики',
      validUntil: '2026-08-08T00:38:46.000Z',
      sourceUrl: 'https://t.me/monitor/1234', sourceName: 'Моніторинг'
    } }, now);
    // Порядок і є змістом: місце й клас → де ціль → що робити → чим перевірити.
    expect(text.indexOf('📍 курсом на Київ')).toBeGreaterThan(text.indexOf('балістичні ракети'));
    expect(text.indexOf('в укриття')).toBeGreaterThan(text.indexOf('📍 курсом на Київ'));
    expect(text.indexOf('Першоджерело')).toBeGreaterThan(text.indexOf('в укриття'));
  });

  it('cleans channel formatting out of the summary and keeps a single leading emoji', () => {
    // Цитата джерела лишилася в повідомленні про ОЧІКУВАНУ загрозу — там, де читач має час на абзац.
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      locationName: 'Київ', threatType: 'ballistic_missile', evidenceLevel: 'confirmed',
      timing: 'evening', summary: '⚠️Загроза  застосування балістики триває..'
    } }, now);
    expect(text).toContain('🕒 <b>Київ — балістичні ракети: очікується увечері</b>');
    expect(text).toContain('Загроза застосування балістики триває.');
    expect(text).not.toContain('триває..');
    expect(text.match(/⚠️/g)).toBeNull();
  });

  it('translates the assessment confidence enum', () => {
    const text = formatMessage({ notification_type: 'assessment_update', payload: {
      locationName: 'Київ', threatType: 'uav', level: 'elevated', score: 3.5,
      indicativePercent: 35, confidence: 'medium', explanation: { raisingFactors: ['зліт МіГ-31К'] },
      horizonEnd: '2026-08-08T03:13:46.000Z'
    } }, now);
    expect(text).toContain('Впевненість оцінки: середня');
    expect(text).toContain('Оцінка чинна до 06:13');
    expect(text).not.toContain('medium');
  });
});

describe('threat updates that follow an earlier message', () => {
  const standing = {
    locationName: 'Київська область', threatType: 'uav', evidenceLevel: 'monitoring',
    summary: 'Ударні БпЛА курсом на північ області.', validUntil: '2026-08-08T00:38:46.000Z'
  };

  it('gives the place, the target and the instruction in the first message — and stops there', () => {
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      ...standing, directionText: 'курсом на північ області', updateKind: 'initial', changes: ['initial']
    } }, now);
    expect(text).toContain('⚠️ <b>Київська область — ударні БпЛА</b> · моніторинг');
    expect(text).toContain('📍 курсом на північ області');
    expect(text).toContain('в укриття');
    expect(text).not.toContain('оновлення');
    // Те, що пішло: цитата поста, повне речення про доказовість, дедлайн.
    expect(text).not.toContain('Ударні БпЛА курсом на північ області.');
    expect(text).not.toContain('Повідомляють моніторингові канали');
    expect(text).not.toContain('Актуально до');
    // Стислість вимірювана, а не на око: чотири рядки й менш ніж двісті символів на екрані блокування.
    expect(text.split('\n').filter(Boolean).length).toBeLessThanOrEqual(4);
    expect(text.length).toBeLessThan(200);
  });

  it('says what changed instead of repeating the warning when evidence is raised', () => {
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      ...standing, evidenceLevel: 'confirmed', updateKind: 'escalation',
      changes: ['evidence_raised'], previousEvidenceLevel: 'monitoring'
    } }, now);
    expect(text).toContain('⬆️ Доказовість підвищено — підтверджено кількома джерелами');
    // The original summary is what makes a repeat read as a repeat; an update must not carry it.
    expect(text).not.toContain('Ударні БпЛА курсом на північ області.');
    // Neither may it repeat the instruction the person already followed.
    expect(text).not.toContain('перейдіть до укриття');
  });

  it('states the new deadline and the time left when a threat is extended', () => {
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      ...standing, validUntil: '2026-08-08T02:23:46.000Z', updateKind: 'soft',
      changes: ['validity_extended']
    } }, now);
    expect(text).toContain('⏱ Загрозу продовжено до 05:23 (ще ~2 год 10 хв)');
  });

  it('names both threat types when the classification is corrected', () => {
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      ...standing, threatType: 'cruise_missile', updateKind: 'change',
      changes: ['threat_type_changed', 'geography_changed'], previousThreatType: 'uav'
    } }, now);
    expect(text).toContain('🔀 Характер загрози уточнено: ударні БпЛА → крилаті ракети');
    expect(text).toContain('📍 Оновлено перелік напрямків: Київська область');
  });

  it('escapes source-controlled names inside a delta line', () => {
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      ...standing, locationName: '<i>Київ</i>', updateKind: 'change', changes: ['geography_changed']
    } }, now);
    expect(text).not.toContain('<i>');
    expect(text).toContain('&lt;i&gt;Київ&lt;/i&gt;');
  });

  it('falls back to the validity line when an update carries no recognised change', () => {
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      ...standing, updateKind: 'soft', changes: []
    } }, now);
    expect(text).toContain('Актуально до 03:38');
  });

  it('keeps the link to the first source in an update', () => {
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      ...standing, updateKind: 'escalation', changes: ['evidence_raised'],
      sourceUrl: 'https://t.me/monitor/1234', sourceName: 'Моніторинг'
    } }, now);
    expect(text).toContain('<a href="https://t.me/monitor/1234">Першоджерело: Моніторинг</a>');
  });

  it('never routes an official alert through the delta path', () => {
    // Alerts carry no `updateKind` of their own, but a payload that somehow grew one must not be
    // able to turn «Повітряна тривога» into a one-line update: the alert branches sit above it.
    for (const type of ['alert_start', 'alert_end']) {
      const text = formatMessage({ notification_type: type, payload: {
        locationName: 'Київ', startedAt: now.toISOString(), endedAt: now.toISOString(),
        updateKind: 'soft', changes: ['validity_extended']
      } }, now);
      expect(text).toContain('Офіційне сповіщення');
      expect(text).not.toContain('— оновлення');
    }
  });

  it('spells out the direction of an analytics level change', () => {
    const text = formatMessage({ notification_type: 'assessment_update', payload: {
      locationName: 'Полтава', threatType: 'uav', level: 'elevated', score: '3.0',
      indicativePercent: 30, confidence: 'low', explanation: {}, updateKind: 'deescalation',
      previousLevel: 'significant', previousScore: 5
    } }, now);
    expect(text).toContain('🔽 Рівень знижено: значний → підвищений');
  });

  it('does not claim a level change when only the index drifted', () => {
    const text = formatMessage({ notification_type: 'assessment_update', payload: {
      locationName: 'Полтава', threatType: 'uav', level: 'elevated', score: '4.0',
      indicativePercent: 40, confidence: 'low', explanation: {}, updateKind: 'drift',
      previousLevel: 'elevated', previousScore: 3
    } }, now);
    expect(text).not.toContain('Рівень знижено');
    expect(text).not.toContain('Рівень підвищено');
  });
});

describe('humanised wording helpers', () => {
  it('formats a Kyiv time without a date for today and with a spelled-out date otherwise', () => {
    expect(humanMoment('2026-08-08T00:38:46.000Z', now)).toBe('03:38');
    expect(humanMoment('2026-08-09T05:00:00.000Z', now)).toBe('9 серпня о 08:00');
  });

  it('returns nothing for a missing or unparsable timestamp', () => {
    expect(humanMoment(null, now)).toBeNull();
    expect(humanMoment('soon', now)).toBeNull();
    expect(validUntilLine(undefined, now)).toBeNull();
  });

  it('switches to past tense once the validity window has closed', () => {
    expect(validUntilLine('2026-08-08T00:00:00.000Z', now)).toBe('Орієнтир діяв до 03:00');
  });

  it('counts hours and minutes for a long window', () => {
    expect(validUntilLine('2026-08-08T02:23:46.000Z', now)).toBe('Актуально до 05:23 (ще ~2 год 10 хв)');
  });

  it('covers every evidence level defined by the schema', () => {
    for (const level of ['official', 'confirmed', 'monitoring', 'unverified']) {
      expect(evidenceStatement(level)).toMatch(/[а-яїієґ]/i);
      expect(evidenceStatement(level)).not.toBe(level);
    }
    // An enum the dictionary has not learned yet must not surface as its English key.
    expect(evidenceStatement('щось нове')).toBe('Рівень доказовості не визначено');
    expect(evidenceStatement(null)).not.toMatch(/[a-z]/i);
  });

  it('names the year only when the timestamp is not from the current one', () => {
    expect(humanMoment('2025-08-08T00:38:46.000Z', now)).toBe('8 серпня 2025 року о 03:38');
    expect(humanMoment('2026-08-09T05:00:00.000Z', now)).not.toContain('року');
  });

  it('softly cleans a summary without rewriting its wording', () => {
    expect(cleanSummary('⚠️  Шахеди курсом на Полтавщину..\n\n\n\nСтежте  за  повідомленнями !!'))
      .toBe('Шахеди курсом на Полтавщину.\n\nСтежте за повідомленнями!');
    expect(cleanSummary('Ціль зникла з радарів...')).toBe('Ціль зникла з радарів…');
    expect(cleanSummary(null)).toBe('');
  });

  it('strips a leading flag emoji but keeps ordinary typography', () => {
    // Flags are not Extended_Pictographic, and the wider property that does cover them also eats «№».
    expect(cleanSummary('🇷🇺 Зліт МіГ-31К')).toBe('Зліт МіГ-31К');
    expect(cleanSummary('№5 борт зафіксовано')).toBe('№5 борт зафіксовано');
  });

  it('keeps the channel line break instead of welding two claims together', () => {
    expect(cleanSummary('Ціль зникла\n... далі буде')).toBe('Ціль зникла\n… далі буде');
  });

  it('builds the extension line an update message is made of', () => {
    expect(extensionLine('2026-08-08T00:38:46.000Z', now)).toBe('⏱ Загрозу продовжено до 03:38 (ще ~25 хв)');
    // A window that has already closed is stated without a countdown rather than with a negative one.
    expect(extensionLine('2026-08-08T00:00:00.000Z', now)).toBe('⏱ Загрозу продовжено до 03:00');
    expect(extensionLine(null, now)).toBeNull();
  });

  it('folds a full-sentence evidence phrase into the escalation line', () => {
    // The dictionary entry is capitalised because a first message shows it standing alone; after a
    // dash the same words are a clause, and a capital there would read as two welded sentences.
    expect(evidenceRaisedLine('official')).toBe('⬆️ Доказовість підвищено — офіційне повідомлення');
    expect(evidenceRaisedLine('confirmed')).toBe('⬆️ Доказовість підвищено — підтверджено кількома джерелами');
  });

  it('names both sides of a corrected classification and of a moved risk level', () => {
    expect(threatTypeChangedLine('uav', 'cruise_missile'))
      .toBe('🔀 Характер загрози уточнено: ударні БпЛА → крилаті ракети');
    expect(riskLevelChangedLine('significant', 'elevated', 'down'))
      .toBe('🔽 Рівень знижено: значний → підвищений');
    expect(riskLevelChangedLine('elevated', 'high', 'up'))
      .toBe('⬆️ Рівень підвищено: підвищений → високий');
  });

  it('states the whole current geography, not only what was added', () => {
    // A reader who sees only this line must end up with the same picture as one who read the first
    // message, so the label is the threat's full list of directions.
    expect(geographyChangedLine('Київська область, Біла Церква'))
      .toBe('📍 Оновлено перелік напрямків: Київська область, Біла Церква');
  });
});

describe('nightly digest AI summary line', () => {
  const digestPayload = {
    generatedTime: '23:20', assessments: [{ locationName: 'Полтава', threatType: 'ballistic_missile',
      level: 'elevated', indicativePercent: 35, score: 3.5, explanation: {} }], omitted: 0
  };

  it('names the model as the author of the summarising line', () => {
    // Читач не має способу відрізнити машинний рядок від порахованого, якщо йому цього не сказати,
    // а сказати може лише формат повідомлення: сама модель могла б цю фразу й пропустити.
    const text = formatMessage({ notification_type: 'nightly_digest', payload: {
      ...digestPayload, aiSummary: 'Найвищий рівень — по Полтаві.', aiGenerated: true
    } }, now);
    expect(text).toContain('написала мовна модель');
    expect(text).toContain('Найвищий рівень — по Полтаві.');
    // Оцінки лишаються тим, заради чого надіслано повідомлення: машинний рядок іде після них.
    expect(text.indexOf('Полтава')).toBeLessThan(text.indexOf('написала мовна модель'));
  });

  it('sends exactly the digest it always sent when the model was not used', () => {
    const withoutModel = formatMessage({ notification_type: 'nightly_digest', payload: {
      ...digestPayload, aiSummary: null, aiGenerated: false
    } });
    expect(withoutModel).not.toContain('мовна модель');
    expect(withoutModel).toBe(formatMessage({ notification_type: 'nightly_digest', payload: digestPayload }));
  });

  it('never prints a stale summary that was not marked as model-written', () => {
    // Прапорець і текст їдуть разом; якщо прапорець знято, рядок не показуємо, навіть коли він є.
    const text = formatMessage({ notification_type: 'nightly_digest', payload: {
      ...digestPayload, aiSummary: 'Щось відхилене.', aiGenerated: false
    } });
    expect(text).not.toContain('Щось відхилене.');
  });

  it('escapes a model-written line like any other untrusted text', () => {
    const text = formatMessage({ notification_type: 'nightly_digest', payload: {
      ...digestPayload, aiSummary: '<script>alert(1)</script>', aiGenerated: true
    } });
    expect(text).not.toContain('<script>');
  });

  it('discloses that part of the signals came from the model', () => {
    // Рядок пишеться не тут: `modelSignalDisclosure` у `src/services/nightly-digest.ts` знає, що
    // саме модель зробила, і віддає готове речення. Форматувальник відповідає лише за те, що воно
    // взагалі доїде до читача — до цього рядка воно лежало в payload і нікуди не друкувалося.
    const text = formatMessage({ notification_type: 'nightly_digest', payload: {
      ...digestPayload, modelSignals: 3,
      modelDisclosure: 'Частину сигналів (3) дала модель — вони не підтверджені джерелом.'
    } }, now);
    expect(text).toContain('Частину сигналів (3) дала модель');
    // Уточнення стоїть після пояснення, до якого воно є уточненням, і перед вказівкою про укриття:
    // спершу чим є рівень, потім чого під ним ніхто не підтверджував, і аж тоді що робити.
    expect(text.indexOf('Рівень сформовано з публічних сигналів'))
      .toBeLessThan(text.indexOf('Частину сигналів (3)'));
    expect(text.indexOf('Частину сигналів (3)'))
      .toBeLessThan(text.indexOf('У разі тривоги'));
  });

  it('sends exactly the digest it always sent when no signal came from the model', () => {
    // Нуль модельних сигналів — типовий стан: вони існують лише за увімкненого
    // `analytical_threats_enabled` (міграція 040, DEFAULT false). Порожня згадка про модель у цьому
    // стані знецінила б попередження там, де воно справді потрібне, тож рядка не має бути взагалі.
    const withoutModel = formatMessage({ notification_type: 'nightly_digest', payload: {
      ...digestPayload, modelSignals: 0, modelDisclosure: null
    } });
    expect(withoutModel).not.toContain('дала модель');
    expect(withoutModel).toBe(formatMessage({ notification_type: 'nightly_digest', payload: digestPayload }));
  });

  it('escapes the disclosure line and ignores a non-string payload value', () => {
    // Payload приходить із JSONB і несе те, що записав планувальник БУДЬ-якої версії: рядок від
    // старішого бінарника, який поля не знав, має зникнути так само тихо, як `null`.
    const escaped = formatMessage({ notification_type: 'nightly_digest', payload: {
      ...digestPayload, modelDisclosure: '<b>Частину сигналів</b> дала модель.'
    } });
    expect(escaped).not.toContain('<b>Частину');
    const wrongType = formatMessage({ notification_type: 'nightly_digest', payload: {
      ...digestPayload, modelDisclosure: 7
    } });
    expect(wrongType).toBe(formatMessage({ notification_type: 'nightly_digest', payload: digestPayload }));
  });
});

/**
 * Два повідомлення, які дивляться НАЗАД: зведення після простою і розбір атаки після відбою
 * (рішення власника 20.08.2026). Обидва мають читатися як довідка, а не як тривога, і обидва
 * говорять про повідомлення каналів, а не про засоби — саме це тут і перевіряється.
 */
describe('повідомлення, що дивляться назад', () => {
  it('зведення після простою підбиває підсумок і не має вигляду попередження', () => {
    const text = formatMessage({ notification_type: 'downtime_digest', payload: {
      from: '2026-08-07T22:40:00.000Z', to: '2026-08-08T00:12:00.000Z', silent: true, omitted: 2,
      locations: [
        { locationName: 'Київська область', messages: 7, classes: ['ударні БпЛА'],
          line: 'Київська область — 7 повідомлень (ударні БпЛА), 01:40–03:12' },
        { locationName: 'Полтавська область', messages: 3, classes: ['балістика'],
          line: 'Полтавська область — 3 повідомлення (балістика), 02:05–02:31' }
      ]
    } }, now);
    expect(text).toContain('🕓');
    expect(text).toContain('Київська область — 7 повідомлень');
    expect(text).toContain('Ще місць: 2');
    // Числа — це повідомлення каналів, і повідомлення каже це вголос.
    expect(text).toContain('кількість повідомлень каналів, а не кількість цілей');
    // Ніякого силуету тривоги і жодного заклику до дії просто зараз.
    expect(text).not.toContain('⚠️');
    expect(text).not.toContain('🔴');
    expect(text).not.toContain('в укриття.');
  });

  it('зведення без жодного місця каже це прямо, а не лишає порожнечу', () => {
    const text = formatMessage({ notification_type: 'downtime_digest', payload: {
      from: '2026-08-07T22:40:00.000Z', to: '2026-08-08T00:12:00.000Z', locations: [], omitted: 0
    } }, now);
    expect(text).toContain('Нових повідомлень по ваших підписках за цей час не було.');
  });

  it('розбір атаки несе застереження першим рядком, до першого числа', () => {
    const text = formatMessage({ notification_type: 'attack_debrief', payload: {
      locationName: 'Київ', durationMinutes: 92, messages: 14,
      lines: [
        'Тривога тривала 1 година 32 хв.',
        'За цей час канали писали про: ударні БпЛА — 11 повідомлень; балістика — 3 повідомлення.',
        'Кількість, яку називали самі джерела: ударні БпЛА — до 10 (найбільше, назване в одному повідомленні).',
        'Повідомляли про роботу ППО: Бровари, Київ.'
      ],
      disclaimer: 'Це підсумок повідомлень моніторингових каналів за час тривоги, а не офіційні дані про наслідки.'
    } }, now);
    expect(text.indexOf('Це підсумок повідомлень')).toBeLessThan(text.indexOf('11 повідомлень'));
    expect(text).toContain('📋 <b>Розбір атаки — Київ</b>');
    expect(text).toContain('Повідомляли про роботу ППО: Бровари, Київ.');
    // Розбір не сміє мати силуету тривоги, відбою чи попередження.
    for (const marker of ['🔴', '⚪', '⚠️']) expect(text).not.toContain(marker);
  });
});
