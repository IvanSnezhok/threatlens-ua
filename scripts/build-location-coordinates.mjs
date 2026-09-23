#!/usr/bin/env node
/**
 * Builds `migrations/056_location_coordinates.sql`, which gives every catalogue city and hromada
 * that OpenStreetMap can place without guessing a point.
 *
 * Why this script exists
 * ---------------------
 * The KATOTTG importer (`src/services/location-catalog.ts`) writes names, codes and the hierarchy.
 * It never writes coordinates, so only the hand-seeded rows had a point: 461 of 488 cities and all
 * 1772 hromadas were NULL. A threat track is drawn between the catalogue places its messages named,
 * so most of its nodes had nowhere to stand. The head of a live track at Ірпінь published
 * `coordinates: null`.
 *
 * OpenStreetMap has a point for every settlement. The Ukrainian community tags settlements and
 * hromada boundaries with `katotth`, the official KATOTTG code. That is the code the catalogue keeps
 * in `official_code` and derives its `katottg-ua…` ids from, so the code is the join. A name is
 * only a fallback, and only inside the polygon of the row's own raion.
 *
 * What a row gets, strongest evidence first
 * -----------------------------------------
 *   city     1. The `place=city|town|village|hamlet` node that carries the row's `katotth`.
 *            2. Otherwise, the one node WITHOUT a code that bears the row's name inside its raion
 *               (ADM2). For the two rows parented straight to an oblast, inside that oblast (ADM1).
 *   hromada  1. The centre of its `admin_level=7` relation (`out center`, the bbox centre), if that
 *               centre falls inside the raion. A crescent-shaped hromada can have it next door.
 *            2. Otherwise, its administrative-centre settlement: the relation's `admin_centre`
 *               member. Where there is no relation at all (all of Crimea), the settlement of the
 *               hromada whose name the hromada's adjective is formed from (Андріївська <- Андріївка).
 *   raion    Nothing. `src/services/threat-vectors.ts` falls back to the ADM2 polygon centroid and
 *            publishes it as approximate. A catalogue point would be published as a position.
 *
 * Several candidates for one row leave the row NULL, and the report names it. That covers two nodes
 * with one code, two same-name places in one raion, and two settlements equally close to a
 * hromada's name. A wrong point draws a track through a place nobody named; a missing one only
 * shortens the track.
 *
 * Reproducibility
 * ---------------
 * The catalogue snapshot and the raw Overpass answers are cached under
 * `node_modules/.cache/threatlens-coordinates`, so a rerun is offline and byte-identical. Rows are
 * sorted by kind and id, coordinates have a fixed precision, and nothing in the output reads the
 * clock. `--refresh` re-reads the catalogue and re-fetches OSM.
 *
 * Unlike `build-adm2.mjs`, the queries are not date-pinned. The ADM2 build pins because a relation's
 * membership and its ways have to agree across answers. Here every answer is self-contained: a node
 * carries its own coordinates, and Overpass computes a relation's centre inside the answer that
 * names it. The one cross-answer lookup, a relation's `admin_centre` member, fails closed. The
 * `timestamp_osm_base` of each answer is printed and written into the migration header instead.
 *
 * Usage
 * -----
 *   node scripts/build-location-coordinates.mjs                  # cached inputs
 *   node scripts/build-location-coordinates.mjs --refresh        # re-read the catalogue, re-fetch OSM
 *   node scripts/build-location-coordinates.mjs --out <file.sql> # e.g. a later refresh migration
 *
 * Licence: the coordinates are derived from OpenStreetMap and are therefore ODbL 1.0. See
 * docs/MAP_DATA.md.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { BBOX, cached, METRES_PER_DEG_LAT, metresPerDegLon, overpass, selectRelations } from './build-adm2.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------------------------
// Extraction parameters
// ---------------------------------------------------------------------------------------------

const USER_AGENT = 'ThreatLensUA-coordinates-builder/1.0 (+https://github.com/threatlens-ua)';

/** The classes Ukrainian settlements are mapped as, from a city down to a хутір. */
const PLACE_FILTER = '["place"~"^(city|town|village|hamlet)$"]';

/**
 * The country-wide requests, one at a time, through the ADM2 builder's mirror rotation and
 * politeness rules: the settlements that carry `katotth`, and the hromada relations.
 */
const QUERIES = {
  'settlements-tagged': `[out:json][timeout:300];node${PLACE_FILTER}["katotth"](${BBOX});out;`,
  hromadas: `[out:json][timeout:300];rel["boundary"="administrative"]["admin_level"="7"]["katotth"](${BBOX});out center;`
};

/**
 * The settlements WITHOUT `katotth`, fetched only for the raions (or oblasts) where a row consults
 * them.
 *
 * A node without a code is only a name. The matching turns to such nodes only after a row's tagged
 * evidence has run out, and only inside the polygon of the row's raion (or oblast). The same filter
 * over the whole bounding box returns 40 000 nodes, almost all of them in Russia, Belarus, Moldova,
 * Romania and Poland. On a busy mirror it ran past the 90 s request deadline, and every retry
 * started another server-side query. The matching therefore runs twice. The first pass, with no
 * untagged nodes, records which units it asked about. Only those units' bounding boxes are fetched,
 * in one request, and the second pass is the result. A row that asked about nothing in the first
 * pass reached its answer on tagged evidence alone, so the second pass gives it the same answer.
 */
const untaggedQuery = (boxes) =>
  `[out:json][timeout:300];(${boxes.map((box) => `node${PLACE_FILTER}[!"katotth"](${box});`).join('')});out;`;

/**
 * How far outside its raion a node may lie and still be accepted on its `katotth` alone.
 *
 * The code already names the raion, so point-in-polygon here guards against a mis-tagged node, and a
 * mis-tagged node lands in some other raion tens or hundreds of kilometres away. The check must not
 * reject a disagreement between two correct sources. When this was written, 23 of the 29 419 tagged
 * nodes fell outside their KATOTTG raion, the furthest by 12.4 km. Those are villages around
 * Sevastopol, Інкерман among them, that KATOTTG assigns to Бахчисарайський район and OSM draws
 * inside the city's boundary. Every acceptance outside the polygon is listed in the report.
 */
const TAGGED_TOLERANCE_M = 15_000;

/** 4 decimals is ~11 m, the precision the seeded rows already carry. */
const COORD_DECIMALS = 4;

/** The bar this dataset was built to. A refresh that falls below it fails rather than thinning the catalogue. */
const COVERAGE_FLOOR = { city: 0.95, hromada: 0.9 };

/** The frontend's ADM1 join (`localLocationId` in `web/app.js`): ISO 3166-2, except where KATOTTG numbers differ. */
const ADM1_ISO_TO_ID = { 'UA-09': 'ua-44', 'UA-30': 'ua-80', 'UA-40': 'ua-85', 'UA-77': 'ua-73' };

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    refresh: false,
    cache: resolve(ROOT, 'node_modules/.cache/threatlens-coordinates'),
    out: resolve(ROOT, 'migrations/056_location_coordinates.sql'),
    container: process.env.THREATLENS_PG_CONTAINER ?? 'threatlens-ua-postgres-1',
    database: process.env.POSTGRES_DB ?? 'threatlens',
    user: process.env.POSTGRES_USER ?? 'threatlens'
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--refresh') options.refresh = true;
    else if (arg === '--cache') options.cache = resolve(argv[++i]);
    else if (arg === '--out') options.out = resolve(argv[++i]);
    else if (arg === '--pg-container') options.container = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!/^\d{3}_[\w-]+\.sql$/.test(basename(options.out))) throw new Error('--out must name a migration file, NNN_name.sql');
  return options;
}

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

const CATALOGUE_SQL = `SELECT coalesce(json_agg(json_build_object(
    'id', id, 'parent_id', parent_id, 'type', type, 'name_uk', name_uk, 'official_code', official_code,
    'latitude', latitude, 'longitude', longitude) ORDER BY id), '[]'::json)
  FROM locations WHERE type <> 'country'`;

/**
 * The catalogue, read once and cached like the OSM answers.
 *
 * The snapshot is cached rather than re-read on every run because the migration is a function of
 * it. The rows are the ones that were NULL when it was read, so rebuilding from a database the
 * migration has already filled would drop them. Compose does not publish the Postgres port, so
 * the default path is `docker exec … psql`, as in the other map-data scripts. Set `DATABASE_URL`
 * (with a local `psql`) to read another database.
 */
function readCatalogue(options) {
  const path = resolve(options.cache, 'catalogue.json');
  if (!options.refresh && existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  const url = process.env.DATABASE_URL;
  const [command, args] = url
    ? ['psql', [url, '-At', '-c', CATALOGUE_SQL]]
    : ['docker', ['exec', options.container, 'psql', '-U', options.user, '-d', options.database, '-At', '-c', CATALOGUE_SQL]];
  const snapshot = {
    readAt: new Date().toISOString(),
    source: url ? 'DATABASE_URL' : options.container,
    rows: JSON.parse(execFileSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim())
  };
  mkdirSync(options.cache, { recursive: true });
  writeFileSync(path, JSON.stringify(snapshot));
  return snapshot;
}

/** An answer served from an OSM database older than this is refused and another mirror is asked. */
const MAX_OSM_BASE_AGE_MS = 7 * 24 * 60 * 60_000;

/**
 * Why an Overpass answer must not be cached, or null when it may be.
 *
 * A mirror that runs out of time or memory mid-answer still says 200, with the elements it managed
 * to print and a `remark` saying so. A mirror can also serve a database months old. On 2026-09-23
 * one answered from 2026-05-06, and nothing else in that answer looked wrong. Either would silently
 * thin or date the dataset. The age is checked at fetch time only, so a cached answer stays usable
 * offline for as long as it is kept.
 */
function refusal(payload) {
  if (payload.remark) return `truncated answer (${payload.remark.slice(0, 120)})`;
  const base = payload.osm3s?.timestamp_osm_base;
  if (!base || !Number.isFinite(Date.parse(base))) return 'an answer without timestamp_osm_base';
  return Date.now() - Date.parse(base) > MAX_OSM_BASE_AGE_MS ? `an answer from a database dated ${base}` : null;
}

/** One Overpass answer, cached under `name`. */
function fetchCached(options, name, query) {
  return cached(options, `${name}.json`, () => {
    process.stderr.write(`fetching ${name} from Overpass\n`);
    return overpass(query, name, { userAgent: USER_AGENT, reject: refusal });
  });
}

/**
 * The untagged settlements inside the units the first matching pass asked about, as Overpass
 * bounding boxes rounded outward to 0.01°. The cache file is named after the query, so a rerun that
 * asks about the same units reads it back, and one that asks about others fetches afresh.
 */
function fetchUntagged(options, units, polygons) {
  const boxes = [...new Set([...units].map((id) => {
    const [west, south, east, north] = polygons.get(id).box;
    const down = (value) => (Math.floor(value * 100) / 100).toFixed(2);
    const up = (value) => (Math.ceil(value * 100) / 100).toFixed(2);
    return `${down(south)},${down(west)},${up(north)},${up(east)}`;
  }))].sort();
  if (!boxes.length) return { elements: [] };
  const query = untaggedQuery(boxes);
  return fetchCached(options, `settlements-untagged-${createHash('sha256').update(query).digest('hex').slice(0, 12)}`, query);
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

/** ADM1 and ADM2 polygons keyed by catalogue id; the two id spaces (`ua-NN`, `katottg-…`) do not meet. */
function loadPolygons() {
  const polygons = new Map();
  const add = (id, geometry) => {
    const rings = (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates).flat();
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const ring of rings) {
      for (const [x, y] of ring) {
        box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y);
        box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
      }
    }
    polygons.set(id, { rings, box });
  };
  const features = (file) => JSON.parse(readFileSync(resolve(ROOT, 'public/data', file), 'utf8')).features;
  for (const feature of features('ukraine-adm1.geojson')) {
    const iso = feature.properties.shapeISO;
    add(ADM1_ISO_TO_ID[iso] ?? iso.toLowerCase(), feature.geometry);
  }
  for (const feature of features('ukraine-adm2.geojson')) add(feature.properties.locationId, feature.geometry);
  return polygons;
}

/** Even-odd ray casting over every ring, so holes and multipolygon parts need no bookkeeping. */
function contains(polygon, [x, y]) {
  const [west, south, east, north] = polygon.box;
  if (x < west || x > east || y < south || y > north) return false;
  let inside = false;
  for (const ring of polygon.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Metres from the point to the polygon's boundary when outside it; 0 inside. */
function distanceOutsideM(polygon, point) {
  if (contains(polygon, point)) return 0;
  const mPerLon = metresPerDegLon(point[1]);
  const px = point[0] * mPerLon; const py = point[1] * METRES_PER_DEG_LAT;
  let best = Infinity;
  for (const ring of polygon.rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const ax = ring[i][0] * mPerLon; const ay = ring[i][1] * METRES_PER_DEG_LAT;
      const dx = ring[i + 1][0] * mPerLon - ax; const dy = ring[i + 1][1] * METRES_PER_DEG_LAT - ay;
      const length2 = dx * dx + dy * dy;
      const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2));
      best = Math.min(best, (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2);
    }
  }
  return Math.sqrt(best);
}

function distanceM(a, b) {
  return Math.hypot((b[0] - a[0]) * metresPerDegLon((a[1] + b[1]) / 2), (b[1] - a[1]) * METRES_PER_DEG_LAT);
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

/** Case, whitespace and apostrophe folding. KATOTTG writes ’ (U+2019); OSM mostly ʼ (U+02BC) or '. */
export const fold = (text) => text.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('uk-UA').replace(/['‘’ʼ`´]/gu, '’');

/**
 * The part of a hromada's name its administrative centre shares: «Андріївська територіальна
 * громада» -> «андріїв». Most names are `-ська/-цька/-зька` adjectives; a few are plain ones
 * («Садова», «Цілинна») and lose only their ending.
 */
export function hromadaStem(name) {
  const adjective = fold(name).replace(/\s+(територіальна\s+)?громада$/u, '');
  return /(ська|цька|зька)$/u.test(adjective) ? adjective.slice(0, -4) : adjective.replace(/[аяі]$/u, '');
}

const ADJECTIVE_ENDING = /(ий|ій|е|є|а|я)$/u;
const SETTLEMENT_ENDING = /(ське|ський|ська|ськ|ка|ки|не|ве|е|є|я|а|и|і|ий|о)$/u;

/**
 * How strongly a settlement name matches a hromada stem: the length of their common prefix, or 0.
 *
 * A match must share at least three letters and reach to within two letters of the shorter of the
 * stem and the name's root. Those two letters absorb the alternations adjective formation makes:
 * Плодове -> Плодівська, Кача -> Качинська, Верхоріччя -> Верхоріченська. Two-word names are also
 * tried in the fused form a compound adjective takes: Ярке Поле -> Яркополенська, Сари-Баш ->
 * Сарибашівська.
 */
export function nameScore(stem, name) {
  const folded = fold(name);
  const variants = new Set([folded]);
  const words = folded.split(/[\s-]+/u).filter(Boolean);
  if (words.length > 1) {
    const head = words[0].replace(ADJECTIVE_ENDING, '');
    variants.add(words.join(''));
    variants.add(`${head}о${words.slice(1).join('')}`);
    variants.add(`${head}о-${words.slice(1).join('-')}`);
  }
  let best = 0;
  for (const variant of variants) {
    let common = 0;
    while (common < stem.length && common < variant.length && stem[common] === variant[common]) common++;
    const root = variant.replace(SETTLEMENT_ENDING, '');
    if (common >= 3 && common >= Math.min(root.length, stem.length) - 2) best = Math.max(best, common);
  }
  return best;
}

/**
 * Every name a node answers to. The Russian and the former names matter in Crimea. There OSM's
 * `name` is Russian and KATOTTG still carries names the settlements no longer officially bear
 * (Красноперекопська громада, whose centre is Яни Капу).
 */
const NAME_KEYS = ['name:uk', 'name', 'old_name:uk', 'old_name', 'alt_name:uk', 'alt_name', 'name:ru'];

function bestName(stem, node) {
  let best = { score: 0, name: null };
  for (const key of NAME_KEYS) {
    for (const name of (node.tags[key] ?? '').split(';')) {
      if (!name.trim()) continue;
      const score = nameScore(stem, name);
      if (score > best.score) best = { score, name: name.trim() };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------

const KATOTTH = /^UA\d{17}$/;

/** The oblast, raion and hromada digits of a KATOTTG code: every settlement of a hromada shares them. */
const hromadaPrefix = (code) => code.slice(0, 9);

const pointOf = (node) => [node.lon, node.lat];
const nodeLabel = (node) => node.tags['name:uk'] ?? node.tags.name ?? `n/${node.id}`;
const km = (metres) => `${(metres / 1000).toFixed(1)} km`;
const hasPoint = (row) => row.latitude != null && row.longitude != null;

function push(map, key, value) {
  const bucket = map.get(key);
  if (bucket) bucket.push(value); else map.set(key, [value]);
}

/** Attaches each row's raion and oblast, walked up `parent_id`. */
function linkCatalogue(rows) {
  const byId = new Map(rows.map((row) => [row.id, { ...row }]));
  for (const row of byId.values()) {
    let cursor = byId.get(row.parent_id);
    for (let depth = 0; cursor && depth < 8; depth++, cursor = byId.get(cursor.parent_id)) {
      if (cursor.type === 'raion') row.raion ??= cursor;
      if (cursor.type === 'oblast' || cursor.type === 'special_city') { row.oblast = cursor; break; }
    }
  }
  return byId;
}

function indexSettlements(tagged, untagged) {
  const byCode = new Map();
  const byHromada = new Map();
  const byId = new Map();
  const malformed = [];
  for (const node of tagged) {
    byId.set(node.id, node);
    const code = node.tags.katotth.trim();
    if (!KATOTTH.test(code)) { malformed.push(node); continue; }
    push(byCode, code, node);
    push(byHromada, hromadaPrefix(code), node);
  }
  for (const node of untagged) byId.set(node.id, node);
  return { byCode, byHromada, byId, untagged, malformed };
}

/** The unit a row's point is confirmed against: its raion, or its oblast when it hangs straight under one. */
function parentOf(row, polygons) {
  const unit = row.raion ?? row.oblast;
  return { name: unit?.name_uk ?? 'no parent', id: unit?.id, polygon: unit ? polygons.get(unit.id) : undefined };
}

/**
 * Untagged nodes inside a unit's polygon, computed once per unit. Every unit asked about is
 * recorded: the first matching pass runs without untagged nodes, and the set it records is what
 * {@link fetchUntagged} fetches for the second.
 */
function untaggedInside(context, parent) {
  if (!parent.polygon) return [];
  context.consulted.add(parent.id);
  let nodes = context.untaggedCache.get(parent.id);
  if (!nodes) {
    nodes = context.settlements.untagged.filter((node) => contains(parent.polygon, pointOf(node)));
    context.untaggedCache.set(parent.id, nodes);
  }
  return nodes;
}

const matched = (method, point, source, extra = {}) => ({ status: 'matched', method, point, source, ...extra });

function matchSettlement(row, context) {
  const parent = parentOf(row, context.polygons);
  const tagged = row.official_code ? context.settlements.byCode.get(row.official_code) ?? [] : [];
  let rejected = null;
  if (tagged.length > 1) {
    return { status: 'ambiguous', reason: `${tagged.length} OSM nodes carry katotth=${row.official_code}: `
      + tagged.map((node) => `n/${node.id} ${nodeLabel(node)}`).join(', ') };
  }
  if (tagged.length === 1) {
    const [node] = tagged;
    const outsideM = parent.polygon ? distanceOutsideM(parent.polygon, pointOf(node)) : 0;
    if (outsideM <= TAGGED_TOLERANCE_M) return matched('katotth', pointOf(node), `n/${node.id}`, { outsideM, parentName: parent.name });
    rejected = `n/${node.id} carries its katotth but lies ${km(outsideM)} outside ${parent.name}`;
  }
  if (!parent.polygon) return { status: 'unmatched', reason: rejected ?? `no node carries katotth=${row.official_code} and ${parent.name} has no polygon to search by name` };
  const name = fold(row.name_uk);
  const named = untaggedInside(context, parent)
    .filter((node) => [node.tags['name:uk'], node.tags.name].some((value) => value && fold(value) === name));
  if (named.length === 1) return matched('name', pointOf(named[0]), `n/${named[0].id}`);
  if (named.length > 1) {
    return { status: 'ambiguous', reason: `${named.length} untagged places named «${row.name_uk}» inside ${parent.name}: `
      + named.map((node) => `n/${node.id}`).join(', ') };
  }
  return { status: 'unmatched', reason: rejected ?? `no node carries katotth=${row.official_code} and no untagged place of that name lies inside ${parent.name}` };
}

/**
 * Whether a settlement node may stand in for a hromada.
 *
 * A tagged node must belong to the hromada by its code and lie within the tagged tolerance of the
 * raion. An untagged node must lie inside the raion outright.
 */
function centreVerdict(row, node, raion) {
  const code = node.tags.katotth?.trim();
  if (code) {
    if (!KATOTTH.test(code) || hromadaPrefix(code) !== hromadaPrefix(row.official_code)) {
      return { ok: false, reason: `n/${node.id} ${nodeLabel(node)} belongs to another hromada (katotth=${code})` };
    }
    const outsideM = raion.polygon ? distanceOutsideM(raion.polygon, pointOf(node)) : 0;
    return outsideM <= TAGGED_TOLERANCE_M
      ? { ok: true, outsideM }
      : { ok: false, reason: `n/${node.id} ${nodeLabel(node)} lies ${km(outsideM)} outside ${raion.name}` };
  }
  return raion.polygon && contains(raion.polygon, pointOf(node))
    ? { ok: true, outsideM: 0 }
    : { ok: false, reason: `untagged n/${node.id} ${nodeLabel(node)} lies outside ${raion.name}` };
}

function matchHromada(row, context) {
  if (!row.official_code) return { status: 'unmatched', reason: 'the row has no official_code to match on' };
  const raion = parentOf(row, context.polygons);
  const notes = [];
  const relation = context.relations.get(row.official_code);
  if (relation?.center) {
    const centre = [relation.center.lon, relation.center.lat];
    if (raion.polygon && contains(raion.polygon, centre)) return matched('relation', centre, `r/${relation.id}`);
    notes.push(`the centre of r/${relation.id} falls outside ${raion.name}`);
    const member = relation.members?.find((entry) => entry.type === 'node' && entry.role === 'admin_centre');
    const node = member && context.settlements.byId.get(member.ref);
    if (node) {
      const verdict = centreVerdict(row, node, raion);
      if (verdict.ok) {
        return matched('admin_centre', pointOf(node), `n/${node.id}`, { centre: nodeLabel(node), outsideM: verdict.outsideM, parentName: raion.name });
      }
      notes.push(verdict.reason);
    } else if (member) {
      notes.push(`its admin_centre n/${member.ref} is not a settlement node`);
    }
  }

  const stem = hromadaStem(row.name_uk);
  const candidates = [];
  for (const node of context.settlements.byHromada.get(hromadaPrefix(row.official_code)) ?? []) {
    const verdict = centreVerdict(row, node, raion);
    if (verdict.ok) candidates.push({ node, outsideM: verdict.outsideM });
  }
  for (const node of untaggedInside(context, raion)) candidates.push({ node, outsideM: 0 });
  const scored = candidates.map((candidate) => ({ ...candidate, ...bestName(stem, candidate.node) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.node.id - b.node.id);
  if (!scored.length) {
    return { status: 'unmatched', reason: [...notes, `no settlement of the hromada is named after «${stem}…»`].join('; ') };
  }
  const [best] = scored;
  const tied = scored.filter((candidate) => candidate.score === best.score);
  if (tied.length > 1) {
    return { status: 'ambiguous', reason: [...notes, `${tied.length} settlements match «${stem}…» equally: `
      + tied.map((candidate) => `n/${candidate.node.id} ${candidate.name}`).join(', ')].join('; ') };
  }
  return matched('admin_centre_name', pointOf(best.node), `n/${best.node.id}`,
    { centre: best.name, outsideM: best.outsideM, parentName: raion.name });
}

/**
 * The whole join, pure: catalogue rows and OSM answers in, one outcome per city and hromada out,
 * plus the units whose untagged settlements were asked about. Exported, like the assembly steps of
 * `build-adm2.mjs`, so it can run without a network or a database.
 */
export function buildCoordinates(rows, osm, untagged, polygons) {
  const catalogue = linkCatalogue(rows);
  const settlements = indexSettlements(osm['settlements-tagged'].elements, untagged);
  const { chosen: relations, dropped } = selectRelations(osm.hromadas.elements);
  const context = { settlements, relations, polygons, untaggedCache: new Map(), consulted: new Set() };
  const results = [];
  for (const row of [...catalogue.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (row.type !== 'city' && row.type !== 'hromada') continue;
    const outcome = row.type === 'city' ? matchSettlement(row, context) : matchHromada(row, context);
    results.push({ row, existing: hasPoint(row), ...outcome });
  }
  return { catalogue, results, dropped, malformed: settlements.malformed, consulted: context.consulted };
}

// ---------------------------------------------------------------------------------------------
// Coverage and output
// ---------------------------------------------------------------------------------------------

function measureCoverage(catalogue, results) {
  const coverage = {};
  for (const type of ['city', 'hromada', 'raion']) {
    const rows = [...catalogue.values()].filter((row) => row.type === type);
    const existing = rows.filter(hasPoint).length;
    const filled = results.filter((result) => result.row.type === type && !result.existing && result.status === 'matched').length;
    coverage[type] = { total: rows.length, existing, filled, after: existing + filled };
  }
  return coverage;
}

const percent = (part, whole) => `${(whole ? (100 * part) / whole : 0).toFixed(1)}%`;
const shortName = (name) => name.replace(/ територіальна громада$/u, ' громада');
const sqlString = (text) => `'${text.replaceAll("'", "''")}'`;
const comment = (text) => text.replace(/[\r\n]+/gu, ' ');

/** One group of the VALUES list: a Ukrainian heading, then one row per catalogue place. */
const SECTIONS = [
  { type: 'city', method: 'katotth', heading: 'Міста: вузол place=* з тим самим кодом katotth' },
  { type: 'city', method: 'name', heading: 'Міста без вузла з кодом: єдиний вузол без коду з тією самою назвою в полігоні свого району' },
  { type: 'hromada', method: 'relation', heading: 'Громади: центр адмінвідношення admin_level=7 з тим самим кодом katotth' },
  { type: 'hromada', method: 'admin_centre', heading: 'Громади, чий центр відношення випадає за межі району: адмінцентр, учасник відношення з роллю admin_centre' },
  { type: 'hromada', method: 'admin_centre_name', heading: 'Громади без відношення в OSM (Крим): адмінцентр, від назви якого утворено назву громади' }
];

function rowComment(result) {
  const name = result.row.type === 'hromada' ? shortName(result.row.name_uk) : result.row.name_uk;
  return comment(result.centre ? `${name} → ${result.centre} (${result.source})` : `${name} (${result.source})`);
}

export function renderMigration({ filename, results, coverage, provenance }) {
  const number = filename.slice(0, 3);
  const fill = results.filter((result) => result.status === 'matched' && !result.existing);
  const { city, hromada, raion } = coverage;
  const lines = [
    `-- ${number} — координати міст і громад каталогу, з OpenStreetMap.`,
    '--',
    '-- ЗГЕНЕРОВАНО скриптом `node scripts/build-location-coordinates.mjs`. Рядки VALUES не правляться',
    '-- руками: перезапустіть скрипт. Як і звідки, описано в docs/MAP_DATA.md, «Catalogue coordinates».',
    '--',
    '-- ================================================================================================',
    '-- Чому',
    '-- ================================================================================================',
    '--',
    '-- Імпортер KATOTTG пише назви, коди й ієрархію, але не координати. Точку мали лише рядки, засіяні',
    '-- руками. Трек загрози малюється між місцями каталогу, тож більшості його вузлів не було де стати:',
    '-- голова живого треку в Ірпені віддавала `coordinates: null`. З координатами до цієї міграції',
    `-- (знімок каталогу ${provenance.catalogueDate}): міст ${city.existing} з ${city.total}, громад ${hromada.existing} з ${hromada.total}.`,
    '--',
    '-- ================================================================================================',
    '-- Звідки точки',
    '-- ================================================================================================',
    '--',
    '-- OpenStreetMap через Overpass. Ключ — тег `katotth`: українська спільнота ставить на населені',
    '-- пункти й на межі громад офіційний код KATOTTG, той самий, що лежить в `official_code`. Назва —',
    '-- лише запасний шлях, і лише всередині полігона свого району.',
    `-- Знімок бази OSM (timestamp_osm_base): ${provenance.osmBase}.`,
    '--',
    '--   * Місто — вузол place=city|town|village|hamlet з його кодом. Без такого вузла — єдиний вузол',
    '--     без коду з тією самою назвою в полігоні свого району (ADM2) чи області (ADM1).',
    '--   * Громада — центр її адмінвідношення admin_level=7, якщо центр лежить у полігоні її району.',
    '--     Інакше — її адмінцентр: учасник відношення з роллю admin_centre. Де відношення немає зовсім',
    '--     (увесь Крим), адмінцентр шукається за назвою: громаду названо прикметником від нього.',
    '--   * Район не заповнюється. Вектор бере центроїд полігона ADM2 і публікує його як наближений;',
    '--     точку з каталогу він опублікував би як положення.',
    '--',
    '-- Рядок, на який припадає кілька кандидатів, лишається NULL, і скрипт його називає. Хибна точка',
    '-- провела б трек через місце, якого ніхто не називав; відсутня лише вкорочує трек.',
    '--',
    '-- Покриття після міграції:',
    `--   міста   ${city.after} з ${city.total} (${percent(city.after, city.total)})`,
    `--   громади ${hromada.after} з ${hromada.total} (${percent(hromada.after, hromada.total)})`,
    `--   райони  ${raion.after} з ${raion.total} (за задумом)`,
    '--',
    '-- ================================================================================================',
    '-- Ознака першорядного місця: `primary_settlement`',
    '-- ================================================================================================',
    '--',
    '-- Досі «має координати» означало «засіяно руками», і на цьому стояв класифікатор. Третій тай-брейк',
    '-- `pickAmongTied` віддає голий «Миколаїв» обласному центру, бо координати мав лише він, а не',
    '-- Миколаїв Львівської області. Ця міграція дає координати і другому, тож ознака переїжджає в окрему',
    '-- колонку, і порядок тут важливий. Спершу колонка заповнюється з координат, поки вони ще означають',
    '-- «засіяно руками»; потім пишуться нові координати. Колонка додається без NOT NULL і заповнюється',
    '-- лише там, де вона NULL. Тому повторний прогін не позначить першорядними рядки, які дістали',
    '-- координати тут. Нові рядки імпортера дістають false.',
    '--',
    '-- ================================================================================================',
    '-- Ідемпотентність',
    '-- ================================================================================================',
    '--',
    '-- Оновлюються лише рядки, де і latitude, і longitude — NULL. Наявні координати не перезаписуються',
    '-- ніколи, і повторний прогін оновлює 0 рядків. Id, якого в базі немає, нічого не оновлює. На свіжій',
    '-- базі каталог KATOTTG імпортується ПІСЛЯ міграцій, тож тут координати дістануть лише рядки міграцій',
    '-- 024, 031 і 032. Після першого імпорту файл безпечно прогнати ще раз вручну:',
    `--   docker compose exec -T postgres psql -U threatlens -d threatlens < migrations/${filename}`,
    '--',
    '-- Ліцензія: координати — похідна база даних OpenStreetMap, ODbL 1.0 (docs/MAP_DATA.md, «Attribution»).',
    '',
    'ALTER TABLE locations ADD COLUMN IF NOT EXISTS primary_settlement boolean;',
    'UPDATE locations SET primary_settlement = (latitude IS NOT NULL) WHERE primary_settlement IS NULL;',
    'ALTER TABLE locations',
    '  ALTER COLUMN primary_settlement SET DEFAULT false,',
    '  ALTER COLUMN primary_settlement SET NOT NULL;',
    '',
    'COMMENT ON COLUMN locations.primary_settlement IS',
    "  'Hand-seeded first-order row: an oblast, a special city or an oblast capital. The classifier breaks a homonym tie towards it (pickAmongTied reads it as geocoded). Until migration 056 coordinates were that marker; 056 copied them here before giving cities and hromadas OpenStreetMap coordinates. Rows the KATOTTG importer writes get false.';",
    ''
  ];
  if (!fill.length) {
    lines.push('-- Знімок не дав жодної нової точки: оновлювати нічого.');
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    'UPDATE locations AS l',
    '   SET latitude = v.latitude, longitude = v.longitude',
    '  FROM (VALUES'
  );
  const entries = [];
  for (const section of SECTIONS) {
    const members = fill.filter((result) => result.row.type === section.type && result.method === section.method);
    if (!members.length) continue;
    entries.push({ heading: `${section.heading} (${members.length})` });
    for (const result of members) {
      const [longitude, latitude] = result.point;
      entries.push({ value: `(${sqlString(result.row.id)}, ${latitude.toFixed(COORD_DECIMALS)}, ${longitude.toFixed(COORD_DECIMALS)})`, note: rowComment(result) });
    }
  }
  const lastValue = entries.findLastIndex((entry) => entry.value);
  entries.forEach((entry, index) => {
    if (entry.heading) lines.push(`    -- ${entry.heading}`);
    else lines.push(`    ${entry.value}${index === lastValue ? '' : ','} -- ${entry.note}`);
  });
  lines.push(
    '  ) AS v(id, latitude, longitude)',
    ' WHERE l.id = v.id',
    '   AND l.latitude IS NULL',
    '   AND l.longitude IS NULL;'
  );
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const snapshot = readCatalogue(options);
  const osm = {};
  for (const [name, query] of Object.entries(QUERIES)) osm[name] = await fetchCached(options, name, query);
  const polygons = loadPolygons();
  const { consulted } = buildCoordinates(snapshot.rows, osm, [], polygons);
  const untagged = await fetchUntagged(options, consulted, polygons);
  const { catalogue, results, dropped, malformed } = buildCoordinates(snapshot.rows, osm, untagged.elements, polygons);
  const coverage = measureCoverage(catalogue, results);

  const osmBases = [...new Set([...Object.values(osm), untagged].map((answer) => answer.osm3s?.timestamp_osm_base).filter(Boolean))].sort();
  const provenance = { catalogueDate: snapshot.readAt.slice(0, 10), osmBase: osmBases.join(' / ') };
  const text = renderMigration({ filename: basename(options.out), results, coverage, provenance });
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, text);

  const methods = (type) => SECTIONS.filter((section) => section.type === type)
    .map((section) => `${results.filter((result) => result.row.type === type && !result.existing && result.method === section.method).length} ${section.method}`)
    .join(', ');
  const line = (type) => {
    const entry = coverage[type];
    return `${entry.after} of ${entry.total} (${percent(entry.after, entry.total)}) = ${entry.existing} already set + ${entry.filled} filled`;
  };
  const report = [
    `catalogue             ${snapshot.rows.length} rows, read ${snapshot.readAt} from ${snapshot.source}`,
    `OSM                   ${osm['settlements-tagged'].elements.length} tagged settlement nodes; ${untagged.elements.length} untagged ones `
      + `in the ${consulted.size} unit(s) that asked for them; ${osm.hromadas.elements.length} hromada relations; `
      + `timestamp_osm_base ${provenance.osmBase}`,
    `coverage city         ${line('city')} (${methods('city')})`,
    `coverage hromada      ${line('hromada')} (${methods('hromada')})`,
    `coverage raion        ${line('raion')} - left NULL by design: threat-vectors.ts draws the ADM2 centroid as approximate`
  ];

  // The seeded rows are an independent check on the whole join: they were placed by hand, long before
  // this script, and the migration never touches them.
  const deviations = results.filter((result) => result.existing && result.status === 'matched')
    .map((result) => ({ name: result.row.name_uk, metres: distanceM([result.row.longitude, result.row.latitude], result.point) }))
    .sort((a, b) => a.metres - b.metres);
  if (deviations.length) {
    const median = deviations[Math.floor(deviations.length / 2)];
    const worst = deviations.at(-1);
    report.push(`seeded rows vs OSM    ${deviations.length} compared: median ${km(median.metres)}, max ${km(worst.metres)} (${worst.name})`);
  }
  for (const entry of dropped) report.push(`dropped duplicate     ${entry.code} r/${entry.id} "${entry.name}" claimed_by=${entry.claimedBy}`);
  if (malformed.length) report.push(`malformed katotth     ${malformed.length} node(s), e.g. n/${malformed[0].id} "${malformed[0].tags.katotth}"`);
  for (const result of results.filter((entry) => entry.status === 'matched' && entry.outsideM > 0)) {
    report.push(`outside parent        ${result.row.name_uk}: ${result.source} lies ${km(result.outsideM)} outside ${result.parentName}, accepted on its katotth`);
  }
  const place = (row) => `${row.type.padEnd(8)}${row.id} ${row.name_uk} (${[row.raion?.name_uk, row.oblast?.name_uk].filter(Boolean).join(', ')})`;
  for (const result of results.filter((entry) => entry.status === 'ambiguous' && !entry.existing)) report.push(`AMBIGUOUS  ${place(result.row)}: ${result.reason}`);
  for (const result of results.filter((entry) => entry.status === 'unmatched' && !entry.existing)) report.push(`UNMATCHED  ${place(result.row)}: ${result.reason}`);
  const fillCount = results.filter((result) => result.status === 'matched' && !result.existing).length;
  report.push(`migration             ${relative(ROOT, options.out)}: ${fillCount} rows, sha256 ${createHash('sha256').update(text).digest('hex')}`);
  process.stdout.write(`${report.join('\n')}\n`);

  const problems = Object.entries(COVERAGE_FLOOR)
    .filter(([type, floor]) => coverage[type].after < floor * coverage[type].total)
    .map(([type, floor]) => `${type} coverage ${percent(coverage[type].after, coverage[type].total)} is below the ${percent(floor, 1)} floor`);
  if (problems.length) {
    process.stdout.write(`\nFAILED CHECKS\n${problems.map((problem) => `  - ${problem}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\nall checks passed\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
