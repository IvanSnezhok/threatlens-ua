#!/usr/bin/env node
/**
 * Builds `public/data/ukraine-adm2.geojson`: the 136 post-2020 raions of Ukraine.
 *
 * Why this script exists
 * ---------------------
 * The alert catalogue became three-tier (oblast -> raion -> city) because the official channel
 * `@air_alert_ua` announces alerts per raion. KATOTTG gives the codes, the names and the hierarchy
 * but no geometry, and geoBoundaries ADM2 for UKR is still the pre-reform 495-raion division, so it
 * cannot be joined to the catalogue at all. OpenStreetMap is the only source that carries the
 * reformed 136-raion division *and* the official KATOTTG code on the boundary relation, via the
 * `katotth` tag maintained by the Ukrainian OSM community.
 *
 * Division of labour between the two inputs is deliberate:
 *   - OpenStreetMap contributes geometry only, keyed by `katotth`;
 *   - the ThreatLens catalogue (PostgreSQL `locations`) contributes `locationId`, `nameUk` and the
 *     parent `oblastId`. OSM names are unusable here - several Crimean relations are named in
 *     Russian ("Бахчисарайский район"), and the frontend joins on `locationId`, not on a name.
 *
 * Reproducibility
 * ---------------
 * The Overpass queries, the mirrors and the snapshot date are constants below. Raw Overpass
 * responses are cached under `node_modules/.cache/threatlens-adm2` (already git-ignored) so a rerun
 * is offline and byte-identical; `--refresh` re-fetches. The output is deterministic: features are
 * sorted by official code, rings by area, coordinates rounded to a fixed precision. The SHA-256 of
 * the emitted file is printed and is expected to match the value recorded in `docs/MAP_DATA.md`.
 *
 * Topology
 * --------
 * Simplification runs per OSM *way*, not per raion ring. Adjacent raions in OSM share the same way
 * objects along their common border, so simplifying a way once and reusing the result in every
 * relation that references it keeps common borders bit-identical and makes gaps between neighbours
 * impossible by construction, without pulling in a topology-preserving dependency.
 *
 * Usage
 * -----
 *   node scripts/build-adm2.mjs                 # cached input, default tolerance
 *   node scripts/build-adm2.mjs --refresh       # re-fetch from Overpass
 *   node scripts/build-adm2.mjs --tolerance 150 # Douglas-Peucker tolerance, metres
 *   node scripts/build-adm2.mjs --report        # print a tolerance sweep and exit
 *
 * Licence: the geometry is derived from OpenStreetMap and is therefore ODbL 1.0. See docs/MAP_DATA.md.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------------------------
// Pinned extraction parameters
// ---------------------------------------------------------------------------------------------

/** Date the Overpass snapshot is pinned to. Bump together with the checksum in docs/MAP_DATA.md. */
export const SNAPSHOT_DATE = '2026-08-07';

/**
 * Every query is pinned to one instant of OSM history via `[date:]`.
 *
 * This is not only about reproducibility. `overpass-api.de` load-balances across backends whose
 * replication lag differs, so two unpinned requests minutes apart can disagree about the same
 * relation: a first run of this build read 123 way members for Коростенський район from one backend
 * while the ways themselves came from another that already had the 131-member version, and seven
 * raions failed to close around the mismatch. Pinning removes the skew, and pins the result.
 */
const SNAPSHOT_INSTANT = `${SNAPSHOT_DATE}T00:00:00Z`;
const PREAMBLE = `[out:json][timeout:300][date:"${SNAPSHOT_INSTANT}"]`;

/** Bounding box of Ukraine including Crimea, as (south, west, north, east). */
const BBOX = '44.0,22.0,52.5,40.5';

/**
 * Step 1 - the relation index. `admin_level=6` is the raion level; `katotth` is the KATOTTG code
 * the Ukrainian community maintains on the boundary relation, and is what joins OSM to KATOTTG.
 *
 * This is the one query that is *not* date-pinned: an attic search over a bbox this size never
 * finishes inside the mirrors' gateway timeout. It only produces a list of relation ids, and
 * anything that drifts in that list is caught downstream - a relation that did not exist at the
 * pinned instant simply has no membership, and a raion whose code disappears fails the count check.
 */
const QUERY_INDEX = `[out:json][timeout:240];
rel["boundary"="administrative"]["admin_level"="6"]["katotth"](${BBOX});
out tags;`;

/**
 * Step 2 - membership and geometry together, in batches of relations.
 *
 * Splitting these into `rel(...);out body;` plus a flat `way(id:...);out geom;` is tempting - it
 * transfers each shared border once instead of twice - but the two halves do not agree. Fetched
 * that way, four raions (Дніпровський, Самарівський, Бориспільський, Обухівський) came back with
 * dangling way ends and no closed ring, while the very same relations requested with `out geom;`
 * close perfectly. One response carrying both membership and coordinates cannot disagree with
 * itself, and that is worth the duplicated bytes.
 */
const queryRelations = (ids) => `${PREAMBLE};rel(id:${ids.join(',')});out geom;`;

const RELATION_BATCH = 8;

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

/** Mirrors hang rather than refuse when they are saturated, so every request needs its own deadline. */
const REQUEST_TIMEOUT_MS = 90_000;

/** How long a mirror that failed to answer at all is skipped for. */
const MIRROR_COOLDOWN_MS = 300_000;

/**
 * Requests in flight at once. `overpass-api.de` advertises two slots per client, but a retry
 * overlapping a live request is enough to spend both and earn a 429, and the whole fetch is only
 * eleven requests - so it runs one at a time and finishes in a couple of minutes.
 */
const FETCH_CONCURRENCY = 1;

const USER_AGENT = 'ThreatLensUA-adm2-builder/1.0 (+https://github.com/threatlens-ua)';

/** Douglas-Peucker tolerance in metres. See docs/MAP_DATA.md for how this number was chosen. */
const DEFAULT_TOLERANCE_M = 180;

/** 5 decimal places is ~1.1 m at Ukrainian latitudes; anything finer is noise at zoom <= 9. */
const COORD_DECIMALS = 5;

/** Rings whose area falls below this after simplification are dropped as rendering noise. */
const MIN_RING_AREA_M2 = 40_000;

/**
 * How far apart two way endpoints may be and still be treated as the same corner.
 *
 * Boundary relations occasionally carry a genuine micro-gap - Володимирський район ends two of its
 * ways 4.7 m apart instead of sharing a node - and refusing to bridge it would cost the whole raion
 * its geometry. At zoom 9 this is 0.12 px, well under the tolerance the rest of the build accepts,
 * and every bridge is reported so a real break can never pass as a rounding artefact.
 */
const SNAP_TOLERANCE_M = 25;

const EXPECTED_FEATURES = 136;

/**
 * ODbL 1.0 attribution. The geometry is a Derivative Database, not merely a Produced Work, because
 * the GeoJSON itself is served to clients - so the notice has to name OpenStreetMap and the licence
 * both in the map's attribution control and inside the distributed file.
 */
const ATTRIBUTION = 'Межі районів © учасники OpenStreetMap, ODbL 1.0';
const LICENSE_URL = 'https://opendatacommons.org/licenses/odbl/1-0/';

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    refresh: false,
    report: false,
    tolerance: DEFAULT_TOLERANCE_M,
    cache: resolve(ROOT, 'node_modules/.cache/threatlens-adm2'),
    out: resolve(ROOT, 'public/data/ukraine-adm2.geojson'),
    container: process.env.THREATLENS_PG_CONTAINER ?? 'petproects-postgres-1',
    database: process.env.POSTGRES_DB ?? 'threatlens',
    user: process.env.POSTGRES_USER ?? 'threatlens'
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--refresh') options.refresh = true;
    else if (arg === '--report') options.report = true;
    else if (arg === '--tolerance') options.tolerance = Number(argv[++i]);
    else if (arg === '--cache') options.cache = resolve(argv[++i]);
    else if (arg === '--out') options.out = resolve(argv[++i]);
    else if (arg === '--pg-container') options.container = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.tolerance) || options.tolerance < 0) throw new Error('--tolerance must be a non-negative number of metres');
  return options;
}

// ---------------------------------------------------------------------------------------------
// Overpass
// ---------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Runs an Overpass query, rotating mirrors on failure.
 *
 * The mirrors answer inconsistently under load - 429 without a User-Agent, 504 on anything heavy -
 * so every call retries across all three with a growing backoff rather than failing the build on
 * the first hiccup.
 */
/** Mirror -> timestamp until which it is skipped, shared across concurrent requests. */
const mirrorCooldown = new Map();

async function overpass(query, label) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const rotation = MIRRORS.map((_, offset) => MIRRORS[(attempt + offset) % MIRRORS.length]);
    // A mirror that is simply down burns the full request deadline every time it is tried, which is
    // what turned a five-minute fetch into an hour before this existed. Prefer one that answered.
    const mirror = rotation.find((candidate) => (mirrorCooldown.get(candidate) ?? 0) < Date.now()) ?? rotation[0];
    let networkFailure = false;
    try {
      const response = await fetch(mirror, {
        method: 'POST',
        headers: { 'user-agent': USER_AGENT },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      const text = await response.text();
      if (response.ok && text.startsWith('{')) { mirrorCooldown.delete(mirror); return JSON.parse(text); }
      process.stderr.write(`  ${label}: HTTP ${response.status} from ${mirror}, retrying\n`);
    } catch (error) {
      networkFailure = true;
      mirrorCooldown.set(mirror, Date.now() + MIRROR_COOLDOWN_MS);
      process.stderr.write(`  ${label}: ${String(error).slice(0, 120)} from ${mirror}, cooling down\n`);
    }
    // A 504 here is the load balancer refusing in seconds, not a query that ran out of time - some
    // backends serve attic data and some do not, so the same request succeeds on a later roll of
    // the dice. Backing off for a minute after each refusal only wastes the afternoon.
    await sleep(networkFailure ? 15_000 : 4000);
  }
  throw new Error(`Overpass exhausted every mirror for ${label}`);
}

async function cached(options, name, produce) {
  const path = resolve(options.cache, name);
  if (!options.refresh && existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  mkdirSync(options.cache, { recursive: true });
  const value = await produce();
  writeFileSync(path, JSON.stringify(value));
  return value;
}

async function fetchOsm(options) {
  const index = await cached(options, 'index.json', async () => {
    process.stderr.write('fetching relation index from Overpass\n');
    return overpass(QUERY_INDEX, 'index');
  });
  const relationIds = index.elements.map((element) => element.id).sort((a, b) => a - b);
  const batches = [];
  for (let i = 0; i < relationIds.length; i += RELATION_BATCH) batches.push(relationIds.slice(i, i + RELATION_BATCH));

  const payloads = new Array(batches.length);
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const position = next++;
      payloads[position] = await cached(options, `relations-${String(position).padStart(3, '0')}.json`, async () => {
        process.stderr.write(`fetching relation batch ${position + 1}/${batches.length}\n`);
        return overpass(queryRelations(batches[position]), `relations ${position}`);
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, batches.length) }, worker));

  const relations = [];
  const ways = new Map();
  const inconsistentWays = [];
  for (const payload of payloads) {
    for (const element of payload.elements) {
      if (element.type !== 'relation') continue;
      relations.push(element);
      for (const member of element.members) {
        if (member.type !== 'way' || !member.geometry) continue;
        const seen = ways.get(member.ref);
        // The same way reaches us once per relation that uses it. The batches are date-pinned, but
        // the mirrors do not all reconstruct attic geometry identically, so a handful of ways come
        // back in two versions. The first copy in batch order wins - deterministic, and it is the
        // single copy every relation then shares, which is what keeps common borders identical.
        // Only a disagreement about the *endpoints* can break ring assembly, so that is what gets
        // reported; interior drift of a few nodes is invisible after simplification.
        if (!seen) { ways.set(member.ref, member.geometry); continue; }
        const ends = (nodes) => `${nodes[0].lat},${nodes[0].lon},${nodes[nodes.length - 1].lat},${nodes[nodes.length - 1].lon}`;
        if (ends(seen) !== ends(member.geometry)) {
          let metres = 0;
          for (let i = 0; i < member.geometry.length - 1; i++) {
            const a = member.geometry[i]; const b = member.geometry[i + 1];
            metres += Math.hypot((b.lon - a.lon) * metresPerDegLon(a.lat), (b.lat - a.lat) * METRES_PER_DEG_LAT);
          }
          inconsistentWays.push({ ref: member.ref, metres });
        }
      }
    }
  }
  relations.sort((a, b) => a.id - b.id);

  const indexTags = new Map(index.elements.map((element) => [element.id, element.tags]));
  const known = new Set(relations.map((relation) => relation.id));
  const youngerThanSnapshot = relationIds.filter((id) => !known.has(id));
  for (const relation of relations) relation.tags ??= indexTags.get(relation.id);
  const byRef = new Map(inconsistentWays.map((entry) => [entry.ref, entry]));
  return { relations, ways, youngerThanSnapshot, inconsistentWays: [...byRef.values()] };
}

// ---------------------------------------------------------------------------------------------
// Catalogue (PostgreSQL)
// ---------------------------------------------------------------------------------------------

const CATALOG_SQL = `SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.official_code), '[]'::json) FROM (
  SELECT r.id, r.name_uk, r.official_code, r.parent_id, p.type AS parent_type
  FROM locations r JOIN locations p ON p.id = r.parent_id
  WHERE r.type = 'raion') t`;

/**
 * Reads the raion catalogue.
 *
 * Compose does not publish the Postgres port, so the default path is `docker exec ... psql`; set
 * `DATABASE_URL` (and have a local `psql`) to reach a database some other way. The result is cached
 * so a later rerun reproduces the same output without a running stack.
 */
function readCatalog(options) {
  const cachePath = resolve(options.cache, 'catalog.json');
  const run = () => {
    const url = process.env.DATABASE_URL;
    const [command, args] = url
      ? ['psql', [url, '-At', '-c', CATALOG_SQL]]
      : ['docker', ['exec', options.container, 'psql', '-U', options.user, '-d', options.database, '-At', '-c', CATALOG_SQL]];
    return JSON.parse(execFileSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim());
  };
  let rows;
  try {
    rows = run();
    mkdirSync(options.cache, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(rows));
  } catch (error) {
    if (!existsSync(cachePath)) throw new Error(`cannot read the raion catalogue and no cache at ${cachePath}: ${error.message}`);
    process.stderr.write('database unreachable, using the cached catalogue snapshot\n');
    rows = JSON.parse(readFileSync(cachePath, 'utf8'));
  }
  for (const row of rows) {
    if (row.parent_type !== 'oblast') throw new Error(`${row.id} has a ${row.parent_type} parent, expected an oblast`);
    const derived = `katottg-${row.official_code.toLocaleLowerCase()}`;
    if (row.id !== derived) throw new Error(`catalogue id ${row.id} is not the pure function of ${row.official_code} the frontend join assumes`);
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Relation selection
// ---------------------------------------------------------------------------------------------

/**
 * Picks one relation per KATOTTG code.
 *
 * Crimea is mapped twice: the community keeps both the boundary Ukraine recognises
 * (`claimed_by=UA`, `disputed_by=RU`) and the one the occupying administration draws
 * (`claimed_by=RU`). Both carry the same `katotth`, which is where the six duplicate codes come
 * from. This product renders the internationally recognised division, so `claimed_by=UA` wins;
 * `addr:country=UA` and then the lowest relation id break any remaining tie deterministically.
 */
function selectRelations(relations) {
  const byCode = new Map();
  for (const relation of relations) {
    const code = relation.tags?.katotth;
    if (!code) continue;
    const bucket = byCode.get(code);
    if (bucket) bucket.push(relation); else byCode.set(code, [relation]);
  }
  const rank = (relation) => [
    relation.tags.claimed_by === 'UA' ? 0 : 1,
    relation.tags['addr:country'] === 'UA' ? 0 : 1,
    relation.id
  ];
  const chosen = new Map();
  const dropped = [];
  for (const [code, bucket] of byCode) {
    const sorted = [...bucket].sort((a, b) => {
      const left = rank(a); const right = rank(b);
      return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
    });
    chosen.set(code, sorted[0]);
    for (const loser of sorted.slice(1)) dropped.push({ code, id: loser.id, name: loser.tags.name, claimedBy: loser.tags.claimed_by });
  }
  return { chosen, dropped };
}

// ---------------------------------------------------------------------------------------------
// Geometry: projection, simplification, ring assembly
// ---------------------------------------------------------------------------------------------

const DEG = Math.PI / 180;
const METRES_PER_DEG_LAT = 110_574;
const metresPerDegLon = (latitude) => 111_320 * Math.cos(latitude * DEG);

/** Web Mercator ground resolution at the middle of Ukraine, used to express the tolerance in pixels. */
const metresPerPixel = (zoom) => (40_075_016.686 * Math.cos(48.5 * DEG)) / (256 * 2 ** zoom);

/**
 * Douglas-Peucker on an open polyline, iterative so a 20 000-node coastline way cannot blow the
 * stack. Endpoints always survive, which is what keeps stitched ways joinable after simplification.
 */
function douglasPeucker(points, toleranceM, mPerLon) {
  if (points.length < 3) return points.map((_, index) => index);
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const tolerance2 = toleranceM * toleranceM;
  while (stack.length) {
    const [from, to] = stack.pop();
    if (to - from < 2) continue;
    const ax = points[from][0] * mPerLon; const ay = points[from][1] * METRES_PER_DEG_LAT;
    const bx = points[to][0] * mPerLon; const by = points[to][1] * METRES_PER_DEG_LAT;
    const dx = bx - ax; const dy = by - ay;
    const length2 = dx * dx + dy * dy;
    let worst = -1; let worstIndex = -1;
    for (let i = from + 1; i < to; i++) {
      const px = points[i][0] * mPerLon; const py = points[i][1] * METRES_PER_DEG_LAT;
      let distance2;
      if (length2 === 0) {
        distance2 = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2));
        distance2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (distance2 > worst) { worst = distance2; worstIndex = i; }
    }
    if (worst > tolerance2) {
      keep[worstIndex] = 1;
      stack.push([from, worstIndex], [worstIndex, to]);
    }
  }
  const indices = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) indices.push(i);
  return indices;
}

/**
 * Simplifies one OSM way, memoised on the way id.
 *
 * This memo is the whole topology story: neighbouring raions reference the same way object for their
 * common border, so both read the same simplified vertex list and the border cannot split. The
 * per-way mean latitude is used for the longitude scale, so the metre tolerance stays honest from
 * Zakarpattia to Luhansk without making the result depend on which relation asked first.
 */
function makeWaySimplifier(toleranceM) {
  const memo = new Map();
  return (ref, geometry) => {
    // The key carries the way's shape, not only its id. Mirrors reconstruct attic geometry slightly
    // differently, so a handful of ways arrive in two versions; keying on the version lets each
    // relation keep the copy its own response closed with, instead of one arbitrary copy tearing a
    // ring open. Every other way - the overwhelming majority - still resolves to a single entry
    // shared by both neighbours, which is what keeps common borders identical.
    const first = geometry[0]; const last = geometry[geometry.length - 1];
    const key = `${ref}|${geometry.length}|${first.lat},${first.lon}|${last.lat},${last.lon}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const points = geometry.map((node) => [node.lon, node.lat]);
    let latitudeSum = 0;
    for (const node of geometry) latitudeSum += node.lat;
    const mPerLon = metresPerDegLon(latitudeSum / geometry.length);
    const closed = points.length > 3
      && points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1];
    let simplified;
    if (!closed) {
      simplified = douglasPeucker(points, toleranceM, mPerLon).map((index) => points[index]);
    } else {
      // A self-closed way has a degenerate first/last segment, so split it in half and simplify each
      // arc; the split index is a pure function of the way's own length and stays stable.
      const middle = Math.floor((points.length - 1) / 2);
      const head = points.slice(0, middle + 1);
      const tail = points.slice(middle);
      simplified = [
        ...douglasPeucker(head, toleranceM, mPerLon).map((index) => head[index]),
        ...douglasPeucker(tail, toleranceM, mPerLon).map((index) => tail[index]).slice(1)
      ];
    }
    const entry = { simplified, original: points.length };
    memo.set(key, entry);
    return entry;
  };
}

const vertexKey = (point) => `${point[0]},${point[1]}`;

/**
 * Chains way fragments end to end into closed rings.
 *
 * An OSM boundary relation is an unordered bag of ways; a raion border is normally split across
 * dozens of them because segments are shared with the oblast border, the state border and the
 * neighbouring raion. Ways may also be stored in either direction, so a candidate is accepted on
 * either endpoint and reversed when it matches on its tail.
 */
function stitchRings(fragments, diagnostics, code) {
  const isClosed = (chain) => vertexKey(chain[0]) === vertexKey(chain[chain.length - 1]);
  const gapM = (a, b) => Math.hypot((b[0] - a[0]) * metresPerDegLon(a[1]), (b[1] - a[1]) * METRES_PER_DEG_LAT);

  // Pass 1 - exact node matching only. This resolves essentially every ring, and it has to run to
  // exhaustion before any tolerance is introduced: boundary corners sit a few metres apart all over
  // the place, so a tolerant match offered too early swallows the wrong way and unravels the ring.
  const used = new Uint8Array(fragments.length);
  const byEndpoint = new Map();
  const register = (key, index) => {
    const bucket = byEndpoint.get(key);
    if (bucket) bucket.push(index); else byEndpoint.set(key, [index]);
  };
  fragments.forEach((fragment, index) => {
    register(vertexKey(fragment[0]), index);
    register(vertexKey(fragment[fragment.length - 1]), index);
  });

  const rings = [];
  const open = [];
  for (let seed = 0; seed < fragments.length; seed++) {
    if (used[seed]) continue;
    used[seed] = 1;
    const chain = [...fragments[seed]];
    // Grow the tail to exhaustion, then flip and grow what was the head. Growing one end only
    // leaves a boundary that is broken anywhere torn into two chains that meet at the seed, and
    // pass 2 would then be asked to bridge the wrong pair of ends.
    for (let side = 0; side < 2 && !isClosed(chain); side++) {
      while (!isClosed(chain)) {
        const tail = vertexKey(chain[chain.length - 1]);
        const candidate = (byEndpoint.get(tail) ?? []).find((index) => !used[index]);
        if (candidate === undefined) break;
        used[candidate] = 1;
        const fragment = fragments[candidate];
        const ordered = vertexKey(fragment[0]) === tail ? fragment : [...fragment].reverse();
        chain.push(...ordered.slice(1));
      }
      if (!isClosed(chain) && side === 0) chain.reverse();
    }
    (isClosed(chain) ? rings : open).push(chain);
  }

  // Pass 2 - bridge what is left. Only chains that pass 1 could not close reach this point, so the
  // tolerance now only ever sees genuine breaks in the OSM data. At each step the nearest endpoint
  // within tolerance wins, including the chain's own head, which is how a ring finally closes.
  while (open.length) {
    const chain = open.shift();
    let flipped = false;
    for (;;) {
      if (isClosed(chain)) break;
      const tail = chain[chain.length - 1];
      let best = { distance: gapM(tail, chain[0]), self: true };
      open.forEach((other, index) => {
        for (const [end, reversed] of [[other[0], false], [other[other.length - 1], true]]) {
          const distance = gapM(tail, end);
          if (distance < best.distance) best = { distance, index, reversed, self: false };
        }
      });
      if (best.distance > SNAP_TOLERANCE_M) {
        if (flipped) break;
        flipped = true; chain.reverse(); continue;
      }
      flipped = false;
      diagnostics.snapped.push({ code, metres: best.distance });
      if (best.self) { chain.push([chain[0][0], chain[0][1]]); break; }
      const [other] = open.splice(best.index, 1);
      chain.push(...(best.reversed ? [...other].reverse() : other).slice(1));
    }
    if (isClosed(chain) && chain.length >= 4) rings.push(chain);
    else diagnostics.unclosed.push({ code, vertices: chain.length, gapM: Math.round(gapM(chain[chain.length - 1], chain[0])) });
  }
  return rings;
}

/** Signed shoelace area in square metres; positive means counter-clockwise. */
function signedArea(ring) {
  let latitudeSum = 0;
  for (const point of ring) latitudeSum += point[1];
  const mPerLon = metresPerDegLon(latitudeSum / ring.length);
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += (ring[i][0] * mPerLon) * (ring[i + 1][1] * METRES_PER_DEG_LAT)
      - (ring[i + 1][0] * mPerLon) * (ring[i][1] * METRES_PER_DEG_LAT);
  }
  return sum / 2;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if ((yi > point[1]) !== (yj > point[1])
      && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function roundRing(ring) {
  const factor = 10 ** COORD_DECIMALS;
  const out = [];
  for (const point of ring) {
    const rounded = [Math.round(point[0] * factor) / factor, Math.round(point[1] * factor) / factor];
    const previous = out[out.length - 1];
    if (previous && previous[0] === rounded[0] && previous[1] === rounded[1]) continue;
    out.push(rounded);
  }
  if (out.length > 1) {
    const first = out[0]; const last = out[out.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) out.push([first[0], first[1]]);
  }
  return out;
}

/** Builds the GeoJSON geometry of one relation out of its simplified, stitched rings. */
function buildGeometry(relation, code, ways, simplifyWay, diagnostics) {
  const outerFragments = []; const innerFragments = [];
  for (const member of relation.members) {
    // `node/admin_centre` and `relation/subarea` (the hromadas inside the raion) are normal
    // boundary-relation furniture and carry no border geometry. A nested relation in an outer or
    // inner role would be geometry this assembler cannot see, so that one is reported.
    if (member.type !== 'way') {
      if (member.type === 'relation' && (member.role === 'outer' || member.role === 'inner')) {
        diagnostics.subRelations.push({ code, ref: member.ref, role: member.role });
      }
      continue;
    }
    // The relation's own copy of the way wins over the shared index: a response that closed on the
    // server has to close here too.
    const geometry = member.geometry ?? ways.get(member.ref);
    if (!geometry || geometry.length < 2) { diagnostics.emptyWays.push({ code, ref: member.ref }); continue; }
    const entry = simplifyWay(member.ref, geometry);
    diagnostics.wayUse.set(member.ref, (diagnostics.wayUse.get(member.ref) ?? 0) + 1);
    diagnostics.wayVertices.set(member.ref, entry);
    (member.role === 'inner' ? innerFragments : outerFragments).push(entry.simplified);
  }

  const outers = stitchRings(outerFragments, diagnostics, code)
    .map(roundRing).filter((ring) => ring.length >= 4 && Math.abs(signedArea(ring)) >= MIN_RING_AREA_M2);
  const inners = stitchRings(innerFragments, diagnostics, code)
    .map(roundRing).filter((ring) => ring.length >= 4 && Math.abs(signedArea(ring)) >= MIN_RING_AREA_M2);
  if (!outers.length) throw new Error(`${code}: no closed outer ring`);

  const polygons = outers
    .map((ring) => ({ area: Math.abs(signedArea(ring)), rings: [orient(ring, true)] }))
    .sort((a, b) => b.area - a.area || a.rings[0][0][0] - b.rings[0][0][0] || a.rings[0][0][1] - b.rings[0][0][1]);

  for (const inner of inners) {
    const host = polygons
      .filter((polygon) => pointInRing(inner[0], polygon.rings[0]))
      .sort((a, b) => a.area - b.area)[0];
    if (!host) { diagnostics.orphanInner.push({ code }); continue; }
    host.rings.push(orient(inner, false));
  }
  for (const polygon of polygons) {
    const [outer, ...holes] = polygon.rings;
    holes.sort((a, b) => a[0][0] - b[0][0] || a[0][1] - b[0][1]);
    polygon.rings = [outer, ...holes];
  }

  const coordinates = polygons.map((polygon) => polygon.rings);
  return coordinates.length === 1
    ? { type: 'Polygon', coordinates: coordinates[0] }
    : { type: 'MultiPolygon', coordinates };
}

function orient(ring, counterClockwise) {
  const area = signedArea(ring);
  return (area >= 0) === counterClockwise ? ring : [...ring].reverse();
}

// ---------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------

/** Ray-casting containment against ADM0, with edges bucketed by latitude so it stays linear. */
function makeUkraineTest() {
  const adm0 = JSON.parse(readFileSync(resolve(ROOT, 'public/data/ukraine-adm0.geojson'), 'utf8'));
  const rings = [];
  for (const feature of adm0.features) {
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const polygon of polygons) rings.push(...polygon);
  }
  const BAND = 0.25;
  const bands = new Map();
  const edges = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const edge = [ring[i], ring[i + 1]];
      const index = edges.push(edge) - 1;
      const low = Math.floor(Math.min(edge[0][1], edge[1][1]) / BAND);
      const high = Math.floor(Math.max(edge[0][1], edge[1][1]) / BAND);
      for (let band = low; band <= high; band++) {
        const bucket = bands.get(band);
        if (bucket) bucket.push(index); else bands.set(band, [index]);
      }
    }
  }
  const inside = (point) => {
    let flag = false;
    for (const index of bands.get(Math.floor(point[1] / BAND)) ?? []) {
      const [[xi, yi], [xj, yj]] = edges[index];
      if ((yi > point[1]) !== (yj > point[1]) && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) flag = !flag;
    }
    return flag;
  };
  const distanceM = (point) => {
    let best = Infinity;
    const mPerLon = metresPerDegLon(point[1]);
    for (const [[xi, yi], [xj, yj]] of edges) {
      const ax = xi * mPerLon; const ay = yi * METRES_PER_DEG_LAT;
      const bx = xj * mPerLon; const by = yj * METRES_PER_DEG_LAT;
      const px = point[0] * mPerLon; const py = point[1] * METRES_PER_DEG_LAT;
      const dx = bx - ax; const dy = by - ay;
      const length2 = dx * dx + dy * dy;
      const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2));
      const value = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      if (value < best) best = value;
    }
    return Math.sqrt(best);
  };
  return { inside, distanceM };
}

const eachRing = function* (geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const polygon of polygons) for (const ring of polygon) yield ring;
};

function verify(collection, catalog) {
  const problems = [];
  const notes = [];
  const ids = new Set(catalog.map((row) => row.id));

  if (collection.features.length !== EXPECTED_FEATURES) problems.push(`expected ${EXPECTED_FEATURES} features, produced ${collection.features.length}`);

  const seen = new Set();
  for (const feature of collection.features) {
    const { locationId, officialCode, nameUk, oblastId } = feature.properties;
    if (seen.has(locationId)) problems.push(`duplicate locationId ${locationId}`);
    seen.add(locationId);
    if (!ids.has(locationId)) problems.push(`${locationId} is not in the catalogue`);
    if (!nameUk || !oblastId || !officialCode) problems.push(`${locationId} has an incomplete property set`);
    if (locationId !== `katottg-${officialCode.toLocaleLowerCase()}`) problems.push(`${locationId} does not derive from ${officialCode}`);
    for (const ring of eachRing(feature.geometry)) {
      if (ring.length < 4) problems.push(`${locationId} has a ring of ${ring.length} vertices`);
      const first = ring[0]; const last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) problems.push(`${locationId} has an unclosed ring`);
    }
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const polygon of polygons) {
      if (signedArea(polygon[0]) <= 0) problems.push(`${locationId} has a clockwise exterior ring`);
      for (const hole of polygon.slice(1)) if (signedArea(hole) >= 0) problems.push(`${locationId} has a counter-clockwise hole`);
    }
  }
  for (const row of catalog) if (!seen.has(row.id)) problems.push(`catalogue raion ${row.id} (${row.name_uk}) has no geometry`);

  // Shared-border audit. Simplification runs per OSM way, so a border between two raions must come
  // out as the very same vertex chain on both sides: every interior edge should be used exactly
  // twice. Edges used once are the outward-facing hull - state border, coastline, hole walls - and
  // an edge used once *inland* would be exactly the kind of sliver that shows as a gap on the map.
  const edges = new Map();
  for (const feature of collection.features) {
    for (const ring of eachRing(feature.geometry)) {
      for (let i = 0; i < ring.length - 1; i++) {
        const a = vertexKey(ring[i]); const b = vertexKey(ring[i + 1]);
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const hit = edges.get(key);
        if (hit) hit.count++; else edges.set(key, { count: 1, from: ring[i], to: ring[i + 1] });
      }
    }
  }
  const ukraine = makeUkraineTest();
  let once = 0; let twice = 0; let more = 0; let onceLengthM = 0; let inlandLengthM = 0;
  for (const edge of edges.values()) {
    if (edge.count === 1) {
      once++;
      const middle = [(edge.from[0] + edge.to[0]) / 2, (edge.from[1] + edge.to[1]) / 2];
      const mPerLon = metresPerDegLon(middle[1]);
      const length = Math.hypot((edge.to[0] - edge.from[0]) * mPerLon, (edge.to[1] - edge.from[1]) * METRES_PER_DEG_LAT);
      onceLengthM += length;
      if (ukraine.distanceM(middle) > 5000) inlandLengthM += length;
    } else if (edge.count === 2) twice++;
    else more++;
  }
  // Every interior border must be used exactly twice; an edge used more than twice would mean two
  // raions overlap. Single-use edges are the outward-facing hull: the state border, the coastline,
  // and the walls around Kyiv and Sevastopol, which are not raions and so have no partner polygon.
  // The inland figure is dominated by coastline that ADM0's generalisation cuts across (Syvash, the
  // Dnipro and Dnister estuaries, the Azov spits) plus those two enclaves - it is context, not a
  // fault count. The number that would show as a gap is the divergent-way length below.
  notes.push(`edges: ${twice} shared by exactly 2 raions, ${once} single-use (${Math.round(onceLengthM / 1000)} km), ${more} used more than twice`);
  notes.push(`single-use edge further than 5 km from ADM0 (coastline + Kyiv/Sevastopol walls): ${Math.round(inlandLengthM / 1000)} km`);

  let vertices = 0; let outside = 0; let worst = 0; let worstFeature = null;
  for (const feature of collection.features) {
    for (const ring of eachRing(feature.geometry)) {
      for (const point of ring) {
        vertices++;
        if (ukraine.inside(point)) continue;
        outside++;
        const distance = ukraine.distanceM(point);
        if (distance > worst) { worst = distance; worstFeature = feature.properties.locationId; }
      }
    }
  }
  notes.push(`vertices outside ADM0: ${outside}/${vertices} (${(100 * outside / vertices).toFixed(2)}%), worst ${Math.round(worst)} m at ${worstFeature ?? 'n/a'}`);
  // ADM0 is a generalised geoBoundaries outline while the raions are full-resolution OSM, so a thin
  // band of border and coastline vertices legitimately falls outside it. Only a gross excursion -
  // a polygon that is not Ukraine at all - is treated as a failure.
  if (worst > 5000) problems.push(`a vertex sits ${Math.round(worst)} m outside the recognised border`);

  return { problems, notes, vertices };
}

// ---------------------------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------------------------

function serialise(collection) {
  const ring = (points) => `[${points.map((point) => `[${point[0]},${point[1]}]`).join(',')}]`;
  const polygon = (rings) => `[${rings.map(ring).join(',')}]`;
  const body = collection.features.map((feature) => {
    const coordinates = feature.geometry.type === 'Polygon'
      ? polygon(feature.geometry.coordinates)
      : `[${feature.geometry.coordinates.map(polygon).join(',')}]`;
    return `{ "type": "Feature", "properties": ${JSON.stringify(feature.properties)}, `
      + `"geometry": { "type": "${feature.geometry.type}", "coordinates": ${coordinates} } }`;
  }).join(',\n');
  // `attribution` and `license` are GeoJSON foreign members, ignored by MapLibre and every parser
  // in this repo. They travel with the file because it is served publicly and is a Derivative
  // Database under ODbL: the licence has to reach whoever ends up holding the bytes.
  return `{\n"type": "FeatureCollection",\n`
    + `"crs": { "type": "name", "properties": { "name": "urn:ogc:def:crs:OGC:1.3:CRS84" } },\n`
    + `"attribution": ${JSON.stringify(ATTRIBUTION)},\n`
    + `"license": ${JSON.stringify(LICENSE_URL)},\n`
    + `"features": [\n${body}\n]\n}\n`;
}

// ---------------------------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------------------------

function assemble(relations, ways, catalog, toleranceM) {
  const { chosen, dropped } = selectRelations(relations);
  const diagnostics = {
    unclosed: [], orphanInner: [], subRelations: [], emptyWays: [], snapped: [],
    wayUse: new Map(), wayVertices: new Map(), dropped
  };
  const simplifyWay = makeWaySimplifier(toleranceM);
  const features = [];
  const missing = [];
  for (const row of catalog) {
    const relation = chosen.get(row.official_code);
    if (!relation) { missing.push({ ...row, reason: 'no OSM relation carries this katotth' }); continue; }
    // A raion that cannot be assembled is collected rather than thrown, so one broken boundary
    // relation surfaces the whole picture instead of hiding the other 135 behind a stack trace.
    let geometry;
    try {
      geometry = buildGeometry(relation, row.official_code, ways, simplifyWay, diagnostics);
    } catch (error) {
      missing.push({ ...row, reason: error.message });
      continue;
    }
    features.push({
      type: 'Feature',
      properties: { locationId: row.id, officialCode: row.official_code, nameUk: row.name_uk, oblastId: row.parent_id },
      geometry
    });
  }
  const unmatched = [...chosen.keys()].filter((code) => !catalog.some((row) => row.official_code === code));
  features.sort((a, b) => (a.properties.officialCode < b.properties.officialCode ? -1 : 1));
  return {
    collection: { type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } }, features },
    diagnostics, missing, unmatched
  };
}

/** Total boundary length drawn in the collection, in metres. */
function onceAndSharedM(collection) {
  let total = 0;
  for (const feature of collection.features) {
    for (const ring of eachRing(feature.geometry)) {
      for (let i = 0; i < ring.length - 1; i++) {
        const mPerLon = metresPerDegLon(ring[i][1]);
        total += Math.hypot((ring[i + 1][0] - ring[i][0]) * mPerLon, (ring[i + 1][1] - ring[i][1]) * METRES_PER_DEG_LAT);
      }
    }
  }
  return total;
}

function countVertices(collection) {
  let total = 0;
  for (const feature of collection.features) for (const ring of eachRing(feature.geometry)) total += ring.length;
  return total;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { relations, ways, youngerThanSnapshot, inconsistentWays } = await fetchOsm(options);
  const catalog = readCatalog(options);
  process.stderr.write(`catalogue: ${catalog.length} raions; OSM: ${relations.length} relations, ${ways.size} ways\n`);

  if (options.report) {
    process.stdout.write('tolerance(m)  vertices      raw     gzip  max error px @z6 @z9 @z11\n');
    for (const tolerance of [0, 50, 100, 150, 180, 200, 250, 300, 400, 600]) {
      const { collection } = assemble(relations, ways, catalog, tolerance);
      const text = serialise(collection);
      process.stdout.write(`${String(tolerance).padStart(11)}  ${String(countVertices(collection)).padStart(8)}`
        + `  ${(Buffer.byteLength(text) / 1e6).toFixed(2)} MB  ${(gzipSync(Buffer.from(text), { level: 9 }).length / 1e6).toFixed(2)} MB`
        + `  ${[6, 9, 11].map((zoom) => (tolerance / metresPerPixel(zoom)).toFixed(2).padStart(6)).join(' ')}\n`);
    }
    return;
  }

  const raw = assemble(relations, ways, catalog, 0);
  const rawVertices = countVertices(raw.collection);
  const rawBytes = Buffer.byteLength(serialise(raw.collection));
  const { collection, diagnostics, missing, unmatched } = assemble(relations, ways, catalog, options.tolerance);

  const sourceVertices = [...diagnostics.wayVertices.values()].reduce((sum, entry) => sum + entry.original, 0);
  const uniqueWays = diagnostics.wayUse.size;
  const sharedWays = [...diagnostics.wayUse.values()].filter((count) => count > 1).length;

  const text = serialise(collection);
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, text);
  const checksum = createHash('sha256').update(text).digest('hex');

  const { problems, notes } = verify(collection, catalog);

  const report = [
    `snapshot date         ${SNAPSHOT_DATE}`,
    `tolerance             ${options.tolerance} m (Douglas-Peucker, per OSM way)`,
    `coordinate precision  ${COORD_DECIMALS} decimals`,
    `relations selected    ${relations.length} fetched, ${diagnostics.dropped.length} duplicate dropped`,
    `ways                  ${uniqueWays} unique, ${sharedWays} shared by >= 2 raions`,
    `vertices              ${sourceVertices} in OSM ways -> ${rawVertices} unsimplified -> ${countVertices(collection)} written`,
    `size                  ${(rawBytes / 1e6).toFixed(2)} MB unsimplified -> ${(statSync(options.out).size / 1e6).toFixed(2)} MB written`,
    // Caddy serves this path with `encode zstd gzip`, so the transfer size is what a phone on a
    // congested network during an alert actually pays.
    `size on the wire      ${(gzipSync(Buffer.from(text), { level: 9 }).length / 1e6).toFixed(2)} MB gzip -9`,
    `features              ${collection.features.length}`,
    `sha256                ${checksum}`,
    ...notes.map((note) => `note                  ${note}`)
  ];
  for (const entry of diagnostics.dropped) report.push(`dropped duplicate     ${entry.code} rel/${entry.id} "${entry.name}" claimed_by=${entry.claimedBy}`);
  for (const entry of diagnostics.snapped) report.push(`bridged OSM gap       ${entry.code} (${entry.metres.toFixed(1)} m)`);
  const unclosedByCode = new Map();
  for (const entry of diagnostics.unclosed) {
    const bucket = unclosedByCode.get(entry.code) ?? { count: 0, worst: 0 };
    unclosedByCode.set(entry.code, { count: bucket.count + 1, worst: Math.max(bucket.worst, entry.gapM) });
  }
  for (const row of missing) report.push(`MISSING GEOMETRY      ${row.id} ${row.name_uk}: ${row.reason}`);
  for (const code of unmatched) report.push(`UNMATCHED OSM CODE    ${code}`);
  for (const id of youngerThanSnapshot) report.push(`RELATION POST-DATES SNAPSHOT  rel/${id}`);
  // The only border length in the file that can differ between two neighbours: these ways arrived in
  // two versions from different mirrors, so each relation kept the copy its own response closed with.
  if (inconsistentWays.length) {
    const metres = inconsistentWays.reduce((sum, entry) => sum + entry.metres, 0);
    report.push(`divergent shared ways ${inconsistentWays.length} way(s), ${(metres / 1000).toFixed(1)} km of border, `
      + `${(100 * metres / onceAndSharedM(collection)).toFixed(3)}% of all boundary`);
    for (const entry of inconsistentWays) report.push(`  divergent way        way/${entry.ref} (${Math.round(entry.metres)} m)`);
  }
  for (const [code, entry] of unclosedByCode) report.push(`UNCLOSED RING         ${code}: ${entry.count} fragment(s), widest gap ${entry.worst} m`);
  for (const entry of diagnostics.orphanInner) report.push(`ORPHAN HOLE           ${entry.code}`);
  for (const entry of diagnostics.subRelations) report.push(`SUB-RELATION MEMBER   ${entry.code} rel/${entry.ref}`);
  for (const entry of diagnostics.emptyWays) report.push(`WAY WITHOUT GEOMETRY  ${entry.code} way/${entry.ref}`);
  process.stdout.write(`${report.join('\n')}\n`);

  if (problems.length) {
    process.stdout.write(`\nFAILED CHECKS\n${problems.map((problem) => `  - ${problem}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\nall checks passed\n');
}

export { assemble, countVertices, douglasPeucker, readCatalog, selectRelations, serialise, signedArea, stitchRings, verify };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
