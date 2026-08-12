// ------------------------------------------------------------------------------------------------
// Вигрузка хронології: серіалізація вибраних записів у чотири формати
// ------------------------------------------------------------------------------------------------
//
// Модуль навмисно не знає ні про DOM, ні про мережу. Він отримує вже завантажені записи, вже
// зроблений вибір і словники підписів — і повертає рядок. Уся робота з буфером обміну, файлом і
// чекбоксами лишається в `app.js`, бо це різні причини для зміни: формат таблиці міняють тоді, коли
// хтось не зміг відкрити файл, а поведінку кнопки — коли міняється сторінка.
//
// Чому це окремий файл, а не ще двісті рядків у `app.js`: `eslint.config.js` прямо каже, що `web/`
// свідомо поза TypeScript-програмою, тож тягнути серіалізатори з `src/` не можна — це зламало б ту
// межу. А лишити їх усередині сторінки означало б поховати єдину частину вигрузки, яка має
// нетривіальні правила (екранування), у файлі на пів мегабайта.
//
// ЩО САМЕ ЛОКАЛІЗУЄТЬСЯ. Три формати з чотирьох читає людина, і вони несуть підписи: «ударних БпЛА»,
// «не перевірено», «оцінка моделі». JSON не несе — він віддає рядки бази як вони є. Це не
// непослідовність: людина, яка відкриває .csv у таблиці, читає слова, а той, хто бере .json,
// збирається зіставляти його з базою, і перекладене `evidence_level` зробило б це неможливим.

/**
 * Формати, у порядку, у якому їх показує селект.
 *
 * `mime` іде в `Blob`, `extension` — в імʼя файлу. `clipboardHint` існує тому, що не всякий формат
 * однаково поводиться в буфері: .txt і .md вставляються в лист як є, а .csv у поле для тексту
 * виглядає рядками з крапками з комою, і сказати про це треба до натискання, а не після.
 */
export const HISTORY_EXPORT_FORMATS = [
  { id: 'txt', label: 'Простий текст (.txt)', extension: 'txt', mime: 'text/plain;charset=utf-8' },
  { id: 'csv', label: 'Таблиця (.csv)', extension: 'csv', mime: 'text/csv;charset=utf-8' },
  { id: 'md', label: 'Markdown (.md)', extension: 'md', mime: 'text/markdown;charset=utf-8' },
  { id: 'json', label: 'JSON (.json)', extension: 'json', mime: 'application/json;charset=utf-8' }
];

/** Колонки трьох людських форматів, в одному місці — щоб .txt, .csv і .md не розʼїхались. */
const COLUMNS = [
  { key: 'started_at', title: 'Початок' },
  { key: 'threat_type', title: 'Тип загрози' },
  { key: 'evidence_level', title: 'Доказовість' },
  { key: 'origin', title: 'Походження' },
  { key: 'status', title: 'Стан' },
  { key: 'title', title: 'Назва' },
  { key: 'summary', title: 'Опис' },
  { key: 'ended_at', title: 'Завершення' },
  { key: 'id', title: 'Ідентифікатор' }
];

/**
 * Роздільник CSV — крапка з комою, і це свідомий відхід від RFC 4180.
 *
 * Excel обирає роздільник за локаллю системи, а не за вмістом файлу: в українській локалі кома вже
 * зайнята як десятковий знак, тож файл із комами лягає в ОДНУ колонку — рівно та поломка, по яку
 * людина й приходить скаржитись. Крапку з комою Excel у цій локалі розбирає правильно, Google Sheets
 * і LibreOffice визначають роздільник самі й приймають обидва. Отже, вибір між «правильно за
 * стандартом» і «відкривається в тому, чим користуються» — і він зроблений на користь другого.
 */
const CSV_DELIMITER = ';';

/**
 * BOM попереду CSV, бо без нього Excel читає файл як ANSI і кирилиця перетворюється на кракозябри.
 * Інші читачі BOM мовчки пропускають, тож ціна нульова.
 */
const CSV_BOM = '﻿';

/** Значення, якого немає. Одне слово на всі формати, щоб порожня клітинка не читалась як помилка. */
const ABSENT = '—';

function localTime(value) {
  if (!value) return ABSENT;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? ABSENT : parsed.toLocaleString('uk-UA');
}

/**
 * Значення однієї колонки, вже підписане словами.
 *
 * `names` — це ті самі словники, якими підписана сторінка (`threatNames`, `evidenceNames`,
 * `statusNames`, `originNames` з `app.js`). Вони передаються, а не імпортуються, щоб вигрузка не
 * могла розійтися з екраном: якщо колись хтось перейменує «моніторинг», файл перейменується разом
 * із карткою, а не через півроку.
 *
 * Невідоме значення повертається як є, а не ховається за прочерком: незнайомий статус у файлі — це
 * знахідка для того, хто його читає, і зникнути вона не повинна.
 */
function cell(item, key, names) {
  if (key === 'started_at' || key === 'ended_at') return localTime(item[key]);
  if (key === 'threat_type') return names.threat?.[item.threat_type] ?? item.threat_type ?? ABSENT;
  if (key === 'evidence_level') return names.evidence?.[item.evidence_level] ?? item.evidence_level ?? ABSENT;
  if (key === 'status') return names.status?.[item.status] ?? item.status ?? ABSENT;
  // Походження — єдина колонка, де відсутність значення означає щось конкретне: подію написали
  // правила. Порожньої клітинки тут бути не може, інакше читач вирішить, що дані загубились.
  if (key === 'origin') return item.origin === 'model' ? (names.origin?.model ?? 'оцінка моделі') : (names.origin?.deterministic ?? 'правила');
  const value = item[key];
  return value === null || value === undefined || value === '' ? ABSENT : String(value);
}

/** Переноси рядків у полі — вороги і таблиці, і рядкового формату; клітинка мусить лишитись одним рядком. */
function flatten(value) {
  return String(value).replace(/\s+/gu, ' ').trim();
}

/**
 * Екранування CSV за RFC 4180: у лапки береться все, що містить роздільник, лапки або перенос, а
 * самі лапки подвоюються.
 *
 * Провідні `=`, `+`, `-` і `@` знешкоджуються апострофом. Це не косметика: Excel і Google Sheets
 * виконують клітинку, яка починається з цих знаків, як формулу, і рядок «=1+1» із назви події
 * перетвориться на 2, а спеціально складений — на спробу витягти дані. Назви й описи в цьому файлі
 * приходять із Telegram-каналів, тобто пишуться сторонніми людьми, і поводитись із ними як із
 * довіреними не можна.
 */
function csvCell(value) {
  const text = flatten(value);
  const guarded = /^[=+\-@\t\r]/u.test(text) ? `'${text}` : text;
  return /["\n\r;,]/u.test(guarded) ? `"${guarded.replace(/"/gu, '""')}"` : guarded;
}

/** У таблиці Markdown вертикальна риска — межа клітинки, тож у тексті вона мусить бути екранована. */
function mdCell(value) {
  return flatten(value).replace(/\|/gu, '\\|');
}

function toTxt(items, names, meta) {
  const blocks = items.map((item) => COLUMNS
    .map((column) => `${column.title}: ${flatten(cell(item, column.key, names))}`)
    .join('\n'));
  return `${meta}\n\n${blocks.join('\n\n')}\n`;
}

function toCsv(items, names) {
  const header = COLUMNS.map((column) => csvCell(column.title)).join(CSV_DELIMITER);
  const rows = items.map((item) => COLUMNS
    .map((column) => csvCell(cell(item, column.key, names)))
    .join(CSV_DELIMITER));
  // CRLF, бо його розуміють усі, а самого LF — не всі старі читачі Windows.
  return `${CSV_BOM}${[header, ...rows].join('\r\n')}\r\n`;
}

function toMarkdown(items, names, meta) {
  const header = `| ${COLUMNS.map((column) => column.title).join(' | ')} |`;
  const divider = `| ${COLUMNS.map(() => '---').join(' | ')} |`;
  const rows = items.map((item) => `| ${COLUMNS.map((column) => mdCell(cell(item, column.key, names))).join(' | ')} |`);
  return `${meta}\n\n${[header, divider, ...rows].join('\n')}\n`;
}

/**
 * Рядок-шапка над людськими форматами.
 *
 * Він потрібен не для краси. Вигружений фрагмент хронології живе далі власним життям — у листі, у
 * звіті, у чужій таблиці — і без дати вигрузки та кількості записів його неможливо ні перевірити,
 * ні відтворити. Застереження про те, чим ці записи НЕ є, їде разом із ними з тієї ж причини, з
 * якої воно стоїть у нічному дайджесті: витягнутий з інтерфейсу рядок втрачає весь контекст
 * сторінки, на якій його читали.
 */
function exportMeta(count, now) {
  const stamp = (now ?? new Date()).toLocaleString('uk-UA');
  return `ThreatLens UA — хронологія подій\nВигружено: ${stamp}\nЗаписів: ${count}\n`
    + 'Це нормалізовані повідомлення джерел, а не перелік атак, пусків чи влучань.';
}

/**
 * Серіалізує вибрані записи у вказаний формат.
 *
 * @param {Array<Record<string, unknown>>} items записи хронології, як їх віддав `/api/v1/history`
 * @param {string} format один із `HISTORY_EXPORT_FORMATS[].id`
 * @param {{ threat?: Record<string,string>, evidence?: Record<string,string>,
 *           status?: Record<string,string>, origin?: Record<string,string> }} names словники підписів
 * @param {Date} [now] момент вигрузки; параметр існує заради відтворюваності в перевірках
 * @returns {string} вміст файлу або те, що лягає в буфер обміну — це один і той самий рядок
 */
export function buildHistoryExport(items, format, names = {}, now) {
  const rows = Array.isArray(items) ? items : [];
  // JSON віддає рядки бази без жодного дотику: той, хто його бере, зіставлятиме їх із базою, і
  // перекладене значення зробило б зіставлення неможливим. Шапки він теж не несе — вона зробила б
  // документ невалідним JSON, а дата вигрузки в масиві подій не має де стояти.
  if (format === 'json') return `${JSON.stringify(rows, null, 2)}\n`;
  const meta = exportMeta(rows.length, now);
  if (format === 'csv') return toCsv(rows, names);
  if (format === 'md') return toMarkdown(rows, names, meta);
  return toTxt(rows, names, meta);
}

/** Імʼя файлу: латиницею й з датою, щоб кілька вигрузок не перезаписували одна одну в теці завантажень. */
export function historyExportFilename(format, now) {
  const chosen = HISTORY_EXPORT_FORMATS.find((entry) => entry.id === format) ?? HISTORY_EXPORT_FORMATS[0];
  const day = (now ?? new Date()).toISOString().slice(0, 10);
  return `threatlens-history-${day}.${chosen.extension}`;
}

/** MIME обраного формату, для `Blob`. */
export function historyExportMime(format) {
  return (HISTORY_EXPORT_FORMATS.find((entry) => entry.id === format) ?? HISTORY_EXPORT_FORMATS[0]).mime;
}
