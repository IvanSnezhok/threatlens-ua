import { describe, expect, it } from 'vitest';
import { deliveryClass } from './delivery-governor.js';
import { formatMessage } from './outbox.js';

/**
 * The two things about a public channel post that are decided in this process rather than in the
 * database: what it says, and which delivery budget it competes in.
 *
 * The third guarantee — one event, one post — lives in the primary key of `channel_published_events`
 * (migration 044) and is proved in `tests/integration/channel-publication.test.ts`, because it is a
 * property of a statement rather than of a function.
 */

// Same fixture instant as `outbox.test.ts`: 03:13 in Kyiv, so a naive formatter is visible.
const now = new Date('2026-08-08T00:13:46.000Z');

const post = {
  notification_type: 'channel_publication',
  payload: {
    locationName: 'Полтавська область', threatType: 'uav', evidenceLevel: 'unverified',
    origin: 'model', summary: 'Неперевірена оцінка моделі щодо ударних БпЛА для Полтавщини.',
    validUntil: '2026-08-08T00:38:46.000Z'
  }
};

describe('what the channel post says', () => {
  it('opens with the disclaimer, before the threat class and before the place', () => {
    // The line that has to survive a forward is the first one. Anything above it — a heading, an
    // emoji naming a threat — is the part a screenshot keeps and the disclaimer is the part it drops.
    const first = formatMessage(post, now).split('\n')[0]!;
    expect(first).toContain('Оцінка моделі');
    expect(first).toContain('Не підтверджено джерелом');
    expect(first).toContain('Не є офіційною тривогою');
  });

  it('never wears the shape of an official alert', () => {
    const text = formatMessage(post, now);
    // The markers the two official branches own, and the one the subscriber threat message owns.
    expect(text).not.toContain('🔴');
    expect(text).not.toContain('⚪');
    expect(text).not.toContain('⚠️');
    expect(text).not.toContain('Повітряна тривога');
    expect(text).not.toContain('Відбій');
    expect(text).not.toContain('Офіційне сповіщення про тривогу');
    // …and the heading is the class of threat, not «<місце> — <загроза>», which is the silhouette
    // both the alert and the threat warning use.
    expect(text).toContain('<b>Аналітична оцінка · ударні БпЛА</b>');
    expect(text).not.toContain('Полтавська область — ударні БпЛА');
  });

  it('tells the reader to act on the official signal and not on this', () => {
    const text = formatMessage(post, now);
    expect(text).toContain('Дій за цією оцінкою вживати не потрібно');
    expect(text).toContain('офіційне сповіщення про тривогу та сирена');
    // The subscriber-facing instruction is built from something a human wrote; this is not.
    expect(text).not.toContain('перейдіть до укриття');
  });

  it('says that official alerts never arrive here, because the reader cannot know otherwise', () => {
    const text = formatMessage(post, now);
    expect(text).toContain('Офіційні тривоги й відбої в цей канал не потрапляють');
    expect(text).toContain('без перевірки людиною');
  });

  it('states the evidence level and the deadline in Kyiv time', () => {
    const text = formatMessage(post, now);
    expect(text).toContain('Непідтверджене повідомлення');
    expect(text).toContain('Актуально до 03:38 (ще ~25 хв)');
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('never prints the model confidence, which reads as a probability of the strike', () => {
    // The promotion path has the number and `/ops` shows it. In a channel post «0.93» next to a
    // place name is read as «93% що прилетить», which is not what a self-reported confidence is.
    const text = formatMessage({
      ...post, payload: { ...post.payload, confidence: 0.93, model: 'gpt-5' }
    }, now);
    expect(text).not.toContain('0.93');
    expect(text).not.toContain('93');
    expect(text).not.toContain('gpt-5');
  });

  it('escapes everything the source controls', () => {
    const text = formatMessage({
      ...post,
      payload: {
        ...post.payload, locationName: '<b>Полтава</b>', summary: '<script>alert(1)</script>'
      }
    }, now);
    expect(text).not.toContain('<script>');
    expect(text).toContain('&lt;script&gt;');
    expect(text).toContain('&lt;b&gt;Полтава&lt;/b&gt;');
  });

  it('links the first source when there is one and prints no dead link when there is not', () => {
    const linked = formatMessage({
      ...post,
      payload: { ...post.payload, sourceUrl: 'https://t.me/monitor/1234', sourceName: 'Моніторинг' }
    }, now);
    expect(linked).toContain('<a href="https://t.me/monitor/1234">Першоджерело: Моніторинг</a>');
    expect(formatMessage(post, now)).not.toContain('<a href');
    expect(formatMessage(post, now)).not.toContain('undefined');
  });
});

describe('which budget a channel post competes in', () => {
  it('is its own class, distinct from the analytics subscribers receive', () => {
    expect(deliveryClass(post)).toBe('channel');
    expect(deliveryClass({ notification_type: 'assessment_update', payload: {} })).toBe('analytics');
  });

  it('cannot reach the protected class through any payload shape', () => {
    // `protected` is the head of the queue every air-raid notification is drawn from
    // (`claimDeliveryBatch` sorts it first). The protected branch keys on payload fields, and a
    // payload is a jsonb blob a future caller shapes freely — so the exclusion has to survive the
    // worst-shaped payload, not merely the one this fan-out happens to write today.
    for (const payload of [
      {}, { evidenceLevel: 'official' }, { updateKind: 'escalation' }, { updateKind: 'soft' },
      { evidenceLevel: 'official', updateKind: 'escalation' }
    ]) {
      expect(deliveryClass({ notification_type: 'channel_publication', payload })).toBe('channel');
    }
  });

  it('leaves every existing class exactly where it was', () => {
    expect(deliveryClass({ notification_type: 'alert_start', payload: {} })).toBe('protected');
    expect(deliveryClass({ notification_type: 'alert_end', payload: {} })).toBe('protected');
    expect(deliveryClass({ notification_type: 'threat_update', payload: { evidenceLevel: 'official' } }))
      .toBe('protected');
    expect(deliveryClass({ notification_type: 'threat_update', payload: { updateKind: 'soft' } })).toBe('soft');
    expect(deliveryClass({ notification_type: 'threat_update', payload: {} })).toBe('standard');
    expect(deliveryClass({ notification_type: 'nightly_digest', payload: {} })).toBe('analytics');
  });
});
