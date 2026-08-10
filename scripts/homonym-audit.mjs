#!/usr/bin/env -S npx tsx
/**
 * Ranks every settlement name in the catalogue by how badly a homonym could misplace it.
 *
 * Why this script exists
 * ---------------------
 * `src/services/location-catalog.ts` imports KATOTTG categories `O`, `K`, `P` and `M` — oblasts,
 * the two special cities, raions and the 461 *міста*. Everything below that tier reaches the
 * catalogue only by hand, through a migration: 024 added eighteen settlements the monitoring
 * channels name, 031 added four more after the Obukhiv incident. Each such row is one name in a
 * country that reuses names heavily — 50 Степанівка, 97 Миколаївка — and the classifier's defence
 * against picking the wrong one is **collision refusal**: `resolveSpanCollisions` in
 * `src/domain/classifier.ts` drops a span two catalogue rows claim unless something ranks them, and
 * `pickAmongTied` ranks them by the oblast the message itself named.
 *
 * That defence only arms when there are two rows. A name held by exactly ONE catalogue row wins its
 * span unopposed however many namesakes exist in Ukraine and whatever oblast the message names —
 * which is precisely how «Дніпропетровщина: БпЛА курсом на Богуслав» painted Обухівський район,
 * Київська область, 400 km away, for an hour on 2026-08-10 (see `migrations/031`). The catalogue
 * therefore carries a standing, invisible exposure: for every sole-bearer row, the number of
 * same-name settlements sitting in *other* oblasts is the number of ways a correct report can be
 * rendered in the wrong place. This script makes that number visible and sorts by it.
 *
 * What it does NOT do is import anything. A high score is a *question*, not a defect: most of these
 * names are never going to be written by a monitoring channel, and adding 29 000 villages would make
 * ambiguity the normal case rather than the exception (the reason the importer stops at `M` in the
 * first place). The procedure for turning a row of this report into a catalogue row — archive
 * evidence first, workbook verification second, opposite-oblast control third — is in
 * `docs/OPERATIONS.md`, «Аудит тезок каталогу», and the precedents are migrations 024, 031 and 032.
 *
 * How the score is built
 * ----------------------
 *   bearers    catalogue rows spelling this name (case-folded, `name_uk` of a city/special_city row)
 *   here       workbook settlements of the name inside the oblast(s) those rows sit in
 *   elsewhere  workbook settlements of the name in ANY OTHER oblast — the misplacement surface
 *   oblasts    how many distinct other oblasts those namesakes are spread across
 *   risk       elsewhere × (bearers === 1)
 *
 * The multiplier is one or zero rather than a weight because a second bearer does not *reduce* the
 * risk, it changes the failure mode: with two rows the span is contested, the tie-break runs, and a
 * message that names no oblast gets silence instead of a wrong answer. Silence is the outcome this
 * module already prefers (two Городок, two Південне). So sole-bearer rows are ranked among
 * themselves by `elsewhere`, and contested names are listed separately, unscored, because they are
 * guarded rather than safe — the guard can still pick the wrong one of two if the message names an
 * oblast that neither row is in.
 *
 * Reproducibility
 * ---------------
 * Both inputs are cached under `node_modules/.cache/threatlens-homonyms` (git-ignored) so a rerun is
 * offline and byte-identical; `--refresh` re-fetches both. The output is deterministic: rows sorted
 * by risk, then by `elsewhere`, then by name, then by KATOTTG code, with no clock anywhere in it.
 * The workbook's SHA-256 is printed so a report can be tied to the codifier revision it was read
 * from — the same discipline `scripts/build-adm2.mjs` applies to its Overpass snapshot.
 *
 * Usage
 * -----
 *   npx tsx scripts/homonym-audit.mjs                      # cached inputs, top 20
 *   npx tsx scripts/homonym-audit.mjs --refresh            # re-download workbook, re-read catalogue
 *   npx tsx scripts/homonym-audit.mjs --top 50             # deeper table
 *   npx tsx scripts/homonym-audit.mjs --all                # every sole-bearer row, ranked
 *   npx tsx scripts/homonym-audit.mjs --locations dump.json  # audit a dump instead of the database
 *   npx tsx scripts/homonym-audit.mjs --json report.json   # machine-readable alongside the table
 *
 * It is run with `tsx` rather than bare `node` for one reason: it reads the workbook through
 * `parseKatottgWorkbook` from `src/services/location-catalog.ts` and downloads it from the
 * `KATOTTG_URL` in `src/config.ts` — the very function and the very document the nightly sync uses —
 * so an audit can never disagree with the importer about what the codifier says.
 *
 * Licence: KATOTTG is published by the Ministry of Development of Communities and Territories of
 * Ukraine as open data. See `KATOTTG_URL` in `src/config.ts` for the pinned document.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { config } from '../src/config.js';
import { parseKatottgWorkbook } from '../src/services/location-catalog.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * KATOTTG categories that denote a place a threat message can name.
 *
 * `K` special city, `M` місто, `X` селище міського типу, `C` село. Excluded: `O` oblast, `P` raion
 * and `H` hromada (they are tiers, not settlements, and the catalogue holds the first two already),
 * and `B` — райони в містах, the 108 city districts, whose names ("Київський", "Центральний") are
 * adjectives that belong to no settlement and would flood the table with noise.
 */
const SETTLEMENT_CATEGORIES = new Set(['K', 'M', 'X', 'C']);

/** Catalogue tiers whose `name_uk` a message resolves as a settlement rather than as a territory. */
const CATALOGUE_TIERS = new Set(['city', 'special_city']);

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    refresh: false,
    all: false,
    top: 20,
    locations: null,
    json: null,
    cache: resolve(ROOT, 'node_modules/.cache/threatlens-homonyms'),
    container: process.env.THREATLENS_PG_CONTAINER ?? 'threatlens-ua-postgres-1',
    database: process.env.POSTGRES_DB ?? 'threatlens',
    user: process.env.POSTGRES_USER ?? 'threatlens'
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--refresh') options.refresh = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--top') options.top = Number(argv[++i]);
    else if (arg === '--locations') options.locations = resolve(argv[++i]);
    else if (arg === '--json') options.json = resolve(argv[++i]);
    else if (arg === '--cache') options.cache = resolve(argv[++i]);
    else if (arg === '--pg-container') options.container = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.top) || options.top < 1) throw new Error('--top must be a positive integer');
  return options;
}

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/**
 * The workbook, cached as bytes.
 *
 * Cached rather than re-fetched because the codifier is a 1.4 MB download from a ministry host that
 * is not always up, and an audit that cannot run during an outage is an audit nobody runs.
 */
async function readWorkbook(options) {
  const path = resolve(options.cache, 'kodifikator.xlsx');
  if (options.refresh || !existsSync(path)) {
    process.stderr.write(`downloading ${config.KATOTTG_URL}\n`);
    const response = await fetch(config.KATOTTG_URL, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`KATOTTG download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    mkdirSync(options.cache, { recursive: true });
    writeFileSync(path, bytes);
  }
  const bytes = readFileSync(path);
  return { bytes: new Uint8Array(bytes), sha256: createHash('sha256').update(bytes).digest('hex'), path };
}

/**
 * Every catalogue row a message can resolve as a settlement, with the oblast it hangs under.
 *
 * The oblast is walked to rather than read off `parent_id`, because migrations 024, 031 and 032
 * attach a settlement to its raion when the KATOTTG sync has created that row and to the oblast when
 * it has not — the ancestor is the answer that holds in both databases, and it is the same climb
 * `listLocationLexemes` and the territory panel make.
 */
const CATALOGUE_SQL = `SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.id), '[]'::json) FROM (
  WITH RECURSIVE ancestry(id, ancestor_id) AS (
    SELECT id, id FROM locations
    UNION ALL
    SELECT a.id, parent.id FROM ancestry a
      JOIN locations child ON child.id = a.ancestor_id
      JOIN locations parent ON parent.id = child.parent_id
  )
  SELECT l.id, l.name_uk, l.type, l.official_code,
         (SELECT o.official_code FROM ancestry a JOIN locations o ON o.id = a.ancestor_id
           WHERE a.id = l.id AND o.type IN ('oblast','special_city') LIMIT 1) AS oblast_code,
         (SELECT o.id FROM ancestry a JOIN locations o ON o.id = a.ancestor_id
           WHERE a.id = l.id AND o.type IN ('oblast','special_city') LIMIT 1) AS oblast_id
    FROM locations l
   WHERE l.type IN ('city','special_city')) t`;

/**
 * Reads the catalogue.
 *
 * Compose does not publish the Postgres port, so the default path is `docker exec … psql`, exactly
 * as `scripts/build-adm2.mjs` does it; set `DATABASE_URL` (with a local `psql`) to reach a database
 * some other way, or pass `--locations <file>` to audit a dump — the file is the JSON array this
 * query returns, which is what makes an audit possible from an export with no database at all.
 */
function readCatalogue(options) {
  if (options.locations) return JSON.parse(readFileSync(options.locations, 'utf8'));
  const cachePath = resolve(options.cache, 'catalogue.json');
  if (!options.refresh && existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, 'utf8'));
  const url = process.env.DATABASE_URL;
  const [command, args] = url
    ? ['psql', [url, '-At', '-c', CATALOGUE_SQL]]
    : ['docker', ['exec', options.container, 'psql', '-U', options.user, '-d', options.database, '-At', '-c', CATALOGUE_SQL]];
  let rows;
  try {
    rows = JSON.parse(execFileSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim());
  } catch (error) {
    if (!existsSync(cachePath)) throw new Error(`cannot read the catalogue and no cache at ${cachePath}: ${error.message}`);
    process.stderr.write('database unreachable, using the cached catalogue snapshot\n');
    return JSON.parse(readFileSync(cachePath, 'utf8'));
  }
  mkdirSync(options.cache, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(rows));
  return rows;
}

// ---------------------------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------------------------

/** Case folding must match the classifier's, which lowercases with the Ukrainian locale. */
const fold = (name) => name.trim().toLocaleLowerCase('uk-UA');

/**
 * Groups the workbook's settlements by folded name and joins the catalogue onto it.
 *
 * Pure, and exported for that reason: it takes parsed rows and returns rows, so the scoring can be
 * exercised — from a REPL or from a future test — with neither the network nor a database, exactly
 * as `scripts/build-adm2.mjs` exports its assembly steps.
 */
export function auditCatalogue(entries, catalogue) {
  const oblastNames = new Map();
  for (const entry of entries) if (entry.category === 'O' || entry.category === 'K') oblastNames.set(entry.code, entry.name);

  const settlementsByName = new Map();
  for (const entry of entries) {
    if (!SETTLEMENT_CATEGORIES.has(entry.category)) continue;
    const key = fold(entry.name);
    const bucket = settlementsByName.get(key);
    if (bucket) bucket.push(entry); else settlementsByName.set(key, [entry]);
  }

  const catalogueByName = new Map();
  for (const row of catalogue) {
    if (!CATALOGUE_TIERS.has(row.type)) continue;
    const key = fold(row.name_uk);
    const bucket = catalogueByName.get(key);
    if (bucket) bucket.push(row); else catalogueByName.set(key, [row]);
  }

  const rows = [];
  for (const [key, bearers] of catalogueByName) {
    const namesakes = settlementsByName.get(key) ?? [];
    // A special city IS its own oblast-level code, so `oblast_code` covers Kyiv and Sevastopol too.
    const held = new Set(bearers.map((bearer) => bearer.oblast_code).filter(Boolean));
    const elsewhere = namesakes.filter((entry) => !held.has(entry.regionCode));
    const otherOblasts = new Set(elsewhere.map((entry) => entry.regionCode));
    rows.push({
      name: bearers[0].name_uk,
      key,
      bearers: bearers.map((bearer) => ({
        id: bearer.id, oblastId: bearer.oblast_id, oblastCode: bearer.oblast_code, code: bearer.official_code
      })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      here: namesakes.length - elsewhere.length,
      elsewhere: elsewhere.length,
      oblasts: otherOblasts.size,
      oblastNames: [...otherOblasts].map((code) => oblastNames.get(code) ?? code).sort(),
      // Absent from the workbook entirely: a seeded row whose name the codifier does not carry, or
      // one whose spelling has drifted from it. Worth seeing, never a homonym risk.
      unknownToWorkbook: namesakes.length === 0,
      risk: bearers.length === 1 ? elsewhere.length : 0
    });
  }
  rows.sort((a, b) =>
    b.risk - a.risk || b.elsewhere - a.elsewhere
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    || (a.bearers[0].code < b.bearers[0].code ? -1 : 1));
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

/** Displayed width of a string, counting the wide symbols the names never use as 1. */
const pad = (value, width, right = false) => {
  const text = String(value);
  const fill = ' '.repeat(Math.max(0, width - [...text].length));
  return right ? fill + text : text + fill;
};

function renderTable(rows, limit) {
  const shown = rows.slice(0, limit);
  const nameWidth = Math.max(4, ...shown.map((row) => [...row.name].length));
  const idWidth = Math.max(13, ...shown.map((row) => [...row.bearers[0].id].length));
  const lines = [
    `${pad('risk', 4, true)}  ${pad('name', nameWidth)}  ${pad('catalogue row', idWidth)}  `
    + `${pad('obl', 5)}  ${pad('here', 4, true)}  ${pad('elsewhere', 9, true)}  ${pad('oblasts', 7, true)}  spread`
  ];
  for (const row of shown) {
    lines.push(`${pad(row.risk, 4, true)}  ${pad(row.name, nameWidth)}  ${pad(row.bearers[0].id, idWidth)}  `
      + `${pad(row.bearers[0].oblastId ?? '—', 5)}  ${pad(row.here, 4, true)}  ${pad(row.elsewhere, 9, true)}  `
      + `${pad(row.oblasts, 7, true)}  ${row.oblastNames.slice(0, 4).join(', ')}`
      + (row.oblastNames.length > 4 ? `, +${row.oblastNames.length - 4}` : ''));
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workbook = await readWorkbook(options);
  const entries = parseKatottgWorkbook(workbook.bytes);
  const catalogue = readCatalogue(options);
  const rows = auditCatalogue(entries, catalogue);

  const settlements = entries.filter((entry) => SETTLEMENT_CATEGORIES.has(entry.category)).length;
  const sole = rows.filter((row) => row.bearers.length === 1);
  const contested = rows.filter((row) => row.bearers.length > 1);
  const exposed = sole.filter((row) => row.risk > 0);
  const unknown = rows.filter((row) => row.unknownToWorkbook);
  const limit = options.all ? sole.length : Math.min(options.top, sole.length);

  const header = [
    `workbook              ${workbook.path}`,
    `workbook sha256       ${workbook.sha256}`,
    `workbook rows         ${entries.length} total, ${settlements} settlements (categories K, M, X, C)`,
    `catalogue rows        ${catalogue.length} city/special_city`,
    `distinct names        ${rows.length} (${sole.length} held by one row, ${contested.length} by two or more)`,
    `exposed names         ${exposed.length} sole-bearer names with a namesake in another oblast`,
    `total exposure        ${exposed.reduce((sum, row) => sum + row.elsewhere, 0)} same-name settlements outside the bearer's oblast`,
    `not in the workbook   ${unknown.length}${unknown.length ? `: ${unknown.map((row) => row.name).join(', ')}` : ''}`
  ];

  process.stdout.write(`${header.join('\n')}\n\n`);
  process.stdout.write(`TOP ${limit} BY RISK (risk = elsewhere × sole bearer)\n`);
  process.stdout.write(`${renderTable(sole, limit)}\n`);

  if (contested.length) {
    process.stdout.write('\nGUARDED BY A SECOND CATALOGUE ROW (the span collides, so the tie-break runs)\n');
    process.stdout.write(`${renderTable(contested, contested.length)}\n`);
  }

  if (options.json) {
    mkdirSync(dirname(options.json), { recursive: true });
    writeFileSync(options.json, `${JSON.stringify({ workbook: workbook.sha256, rows }, null, 2)}\n`);
    process.stderr.write(`wrote ${options.json}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
