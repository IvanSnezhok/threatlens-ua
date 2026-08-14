import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Утримує екранування там, де воно вже поставлене й де його одного разу забули.
 *
 * `web/app.js` будує HTML шаблонними рядками й має `escapeHtml`, викликаний у 414 з 1112 місць
 * інтерполяції. Проблема була не в покритті, а в тому, що правила не існувало: те саме поле
 * екранувалося в одному рядку й лишалося сирим у сусідньому — `item.evidenceLevel` йшов у клас
 * сирим на 976, а рядком нижче той самий `item.evidenceLevel` екранувався для показу; `item.id`
 * писався сирим у `data-event` і екранованим у `data-pick` на одному й тому ж рядку.
 *
 * Значення тут серверні, тож дірки це не давало. Але «не давало» трималося на тому, які саме
 * колонки має схема сьогодні: `threat_type` оголошено як `text NOT NULL` БЕЗ жодного CHECK (на
 * відміну від `risk_level`, `evidence_level` і `assessment_confidence`, які його мають), а пише його
 * класифікатор із тексту телеграм-повідомлень. Резервна гілка `threatNames[…] ?? item.threat_type`
 * друкує саме сире значення колонки — тобто рівно той шлях, на якому «серверне значення» перестає
 * бути гарантією.
 *
 * ЧОМУ ТУТ ПЕРЕЛІК, А НЕ ЗАГАЛЬНЕ ПРАВИЛО. Загальне правило «жодної сирої інтерполяції всередині
 * лапок атрибута» зараз має 73 винятки, майже всі — локальні змінні будівників форм в `/ops`
 * (`${value}`, `${id}`, `${field}`) і числа. Тест, який одразу червоний, ніхто не лагодить — його
 * вимикають. Тому тут пінуються місця, які вже приведені до ладу, і кожен новий рядок сюди
 * додається разом із виправленням, а не замість нього.
 */

const APP_SOURCE = readFileSync(resolve(import.meta.dirname, '../../web/app.js'), 'utf8');

/** Місця, які мусять лишитися екранованими, у формі, у якій вони стоять у джерелі. */
const PINNED = [
  'data-location="${escapeHtml(item.location_id)}"',
  'data-assessment="${escapeHtml(item.id)}"',
  'data-event="${escapeHtml(item.id)}"',
  'class="event-card ${escapeHtml(item.evidenceLevel)}',
  'escapeHtml(threatNames[item.threat_type] ?? item.threat_type)',
  'escapeHtml(levelNames[item.risk_level] ?? item.risk_level)',
  'class="evidence ${escapeHtml(item.evidence_level)}"',
  'data-detail="${escapeHtml(item.id)}"',
  'class="trend ${escapeHtml(row.trend)}"',
  'TIER ${escapeHtml(source.tier)}',
  'escapeHtml(statuses[source.status] ?? source.status)',
  'escapeHtml(states[verdict.threatState] || verdict.threatState)'
];

/** Сирі форми тих самих місць. Повернення будь-якої з них — це відкат виправлення. */
const FORBIDDEN = [
  'data-location="${item.location_id}"',
  'data-assessment="${item.id}"',
  'data-event="${item.id}"',
  'class="event-card ${item.evidenceLevel}',
  '${threatNames[item.threat_type] ?? item.threat_type}',
  '${levelNames[item.risk_level] ?? item.risk_level}',
  'class="evidence ${item.evidence_level}"',
  'data-detail="${item.id}"',
  'class="trend ${row.trend}"',
  'TIER ${source.tier}',
  '${statuses[source.status] ?? source.status}',
  '${states[verdict.threatState] || verdict.threatState}'
];

describe('HTML escaping in the public renderers', () => {
  it.each(PINNED)('keeps %s escaped', (fragment) => {
    expect(APP_SOURCE).toContain(fragment);
  });

  it.each(FORBIDDEN)('never lets %s come back raw', (fragment) => {
    expect(APP_SOURCE).not.toContain(fragment);
  });

  it('never double-escapes', () => {
    // Обгортка навколо вже обгорнутого друкує «&amp;lt;» замість «<» — помилка, яку видно очима на
    // сторінці, але не видно в діфі, якщо шаблон довгий.
    expect(APP_SOURCE).not.toContain('escapeHtml(escapeHtml(');
  });

  it('escapes both ends of the id that the DOM reads back', () => {
    // `data-event` і `data-pick` на одному рядку історії: колись перший був сирим, другий
    // екранованим. Обидва читаються назад через `dataset` і йдуть у fetch, тож розходження між ними
    // означало б, що те саме значення потрапляє в атрибут двома різними правилами.
    const history = APP_SOURCE.slice(APP_SOURCE.indexOf(`$('#history-results', root).innerHTML`));
    const row = history.slice(0, history.indexOf('\n'));
    expect(row).toContain('data-event="${escapeHtml(item.id)}"');
    expect(row).toContain('data-pick="${escapeHtml(item.id)}"');
  });
});
