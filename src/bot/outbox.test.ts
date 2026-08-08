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
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      locationName: '<b>Київ</b>', threatType: 'uav', evidenceLevel: 'monitoring',
      summary: '<script>alert(1)</script>', validUntil: 'soon'
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
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      locationName: 'Київ', threatType: 'ballistic_missile', evidenceLevel: 'confirmed',
      summary: 'Загроза застосування балістики', validUntil: '2026-08-08T00:38:46.000Z'
    } }, now);
    expect(text).toContain('Актуально до 03:38 (ще ~25 хв)');
    expect(text).not.toContain('2026-08-08T00:38:46.000Z');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('spells out the evidence level instead of leaking the database enum', () => {
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      locationName: 'Київ', threatType: 'ballistic_missile', evidenceLevel: 'confirmed', summary: 'Пуски'
    } }, now);
    expect(text).toContain('Підтверджено кількома джерелами');
    expect(text).not.toContain('confirmed');
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
      summary: 'Загроза балістики', validUntil: '2026-08-08T00:38:46.000Z'
    } }, now);
    expect(text.indexOf('перейдіть до укриття')).toBeGreaterThan(text.indexOf('Загроза балістики'));
    expect(text.indexOf('Підтверджено кількома джерелами')).toBeGreaterThan(text.indexOf('перейдіть до укриття'));
  });

  it('cleans channel formatting out of the summary and keeps a single leading emoji', () => {
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      locationName: 'Київ', threatType: 'ballistic_missile', evidenceLevel: 'confirmed',
      summary: '⚠️Загроза  застосування балістики триває..'
    } }, now);
    expect(text).toContain('⚠️ <b>Київ — балістичні ракети</b>');
    expect(text).toContain('Загроза застосування балістики триває.');
    expect(text).not.toContain('триває..');
    expect(text.match(/⚠️/g)).toHaveLength(1);
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

  it('gives the whole picture in the first message about a threat', () => {
    const text = formatMessage({ notification_type: 'threat_update', payload: {
      ...standing, updateKind: 'initial', changes: ['initial']
    } }, now);
    expect(text).toContain('Ударні БпЛА курсом на північ області.');
    expect(text).toContain('Повідомляють моніторингові канали');
    expect(text).toContain('Актуально до 03:38');
    expect(text).not.toContain('оновлення');
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
});
