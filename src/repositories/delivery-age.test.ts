import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { deliveryAgeCeilingMs, withinDeliveryAge } from './events.js';

/**
 * Стеля віку повідомлення (рішення власника 20.08.2026).
 *
 * Один предикат, від якого залежить, чи побачить людина попередження, — тож перевіряються рівно ті
 * його властивості, на які спирається решта системи: межа береться з налаштування щоразу (воно
 * гаряче), нуль вимикає стелю, і рівно на межі повідомлення вже застаріле.
 */
describe('стеля віку для доставки', () => {
  const booted = config.SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES;
  afterEach(() => { config.SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES = booted; });

  const now = new Date('2026-08-20T12:00:00.000Z');
  const agedBy = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  it('типово пропускає годину і не пропускає години', () => {
    expect(config.SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES).toBe(60);
    expect(withinDeliveryAge(agedBy(59), now)).toBe(true);
    // Рівно на межі — вже пізно. Інакше «не старше за годину» означало б «не старше за годину й одну
    // мілісекунду», і те саме повідомлення поводилося б по-різному залежно від округлення.
    expect(withinDeliveryAge(agedBy(60), now)).toBe(false);
    expect(withinDeliveryAge(agedBy(180), now)).toBe(false);
  });

  it('читає налаштування на кожен виклик, бо оператор змінює його на живому процесі', () => {
    config.SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES = 15;
    expect(deliveryAgeCeilingMs()).toBe(15 * 60_000);
    expect(withinDeliveryAge(agedBy(20), now)).toBe(false);
    config.SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES = 240;
    expect(withinDeliveryAge(agedBy(20), now)).toBe(true);
  });

  it('нуль вимикає стелю повністю', () => {
    config.SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES = 0;
    expect(deliveryAgeCeilingMs()).toBeNull();
    expect(withinDeliveryAge(agedBy(10_000), now)).toBe(true);
  });

  it('повідомлення з майбутнього не вважається застарілим', () => {
    // Годинник каналу попереду нашого — щоденна дрібниця, і вона не сміє глушити свіже попередження.
    expect(withinDeliveryAge(new Date(now.getTime() + 60_000), now)).toBe(true);
  });
});
