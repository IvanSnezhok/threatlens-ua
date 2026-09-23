# Map data: provenance, licence, rebuild

The map draws three boundary layers, and the location catalogue carries a point for its cities and
hromadas. They come from two different sources under the same licence.

| Dataset | File | Source | Contents |
|---|---|---|---|
| ADM0 | `public/data/ukraine-adm0.geojson` | geoBoundaries `UKR`, release commit `9469f09` | the recognised border of Ukraine |
| ADM1 | `public/data/ukraine-adm1.geojson` | geoBoundaries `UKR`, release commit `9469f09` | 27 oblast-level units including the AR of Crimea and Sevastopol |
| ADM2 | `public/data/ukraine-adm2.geojson` | OpenStreetMap via Overpass | the 136 raions of the 2020 reform |
| Catalogue coordinates | `migrations/056_location_coordinates.sql` → `locations.latitude/longitude` | OpenStreetMap via Overpass | a point for 461 cities and 1 764 hromadas |

Every one of them is derived from OpenStreetMap and is licensed under **ODbL 1.0**. See
[Attribution](#attribution) — the obligation is not satisfied by the basemap's own credit line.

`data/map/README.md` holds the operational notes for the basemap and the pinned ADM0/ADM1
checksums. This file covers where the boundaries and the catalogue coordinates come from, and how
ADM2 and the coordinates are rebuilt.

## Why ADM2 does not come from geoBoundaries

The catalogue is three-tier — oblast → raion → city — because the official alert channel
[`@air_alert_ua`](https://t.me/air_alert_ua) announces alerts per raion. Raions therefore need
geometry, and the two obvious sources do not provide it:

- **KATOTTG** is the authority for raion codes, names and hierarchy, and carries no geometry at all.
- **geoBoundaries ADM2 for `UKR`** still publishes the *pre-reform* division: 495 features, Latin
  names, no codes. The 2020 reform replaced roughly 490 raions with 136. It cannot be joined to the
  catalogue, and drawing it would show a country that no longer exists administratively.

**OpenStreetMap** is the source that has both. The Ukrainian community maintains a `katotth` tag —
the official KATOTTG code — on each `admin_level=6` boundary relation. Those codes match the
catalogue exactly: 136 of 136, with no unmatched code in either direction.

## How `ukraine-adm2.geojson` is built

`scripts/build-adm2.mjs` produces the file. It takes **geometry from OSM and everything else from
the ThreatLens catalogue**: `locationId`, `nameUk` and the parent `oblastId` are read from the
`locations` table, joined to OSM on `katotth` = `official_code`. OSM names are deliberately not
used — several Crimean relations are named in Russian, and the frontend joins on `locationId`.

```bash
node scripts/build-adm2.mjs              # rebuild from the cached snapshot
node scripts/build-adm2.mjs --refresh    # re-fetch from Overpass
node scripts/build-adm2.mjs --report     # print the tolerance/size trade-off table
```

The catalogue is read through `docker exec petproects-postgres-1 psql` by default, since Compose
does not publish the Postgres port; set `DATABASE_URL` to reach a database another way. Raw
Overpass responses and the catalogue snapshot are cached under `node_modules/.cache/threatlens-adm2`,
so a rerun is offline and byte-identical.

### The snapshot is pinned, and membership travels with geometry

Every Overpass query except the relation index carries `[date:"2026-08-07T00:00:00Z"]`. This is not
only about reproducibility. `overpass-api.de` load-balances across backends with different
replication lag, and two unpinned requests minutes apart can disagree: a first run of this build
read 123 way members for Коростенський район from one backend while the ways themselves came from
another that already held the 131-member version, and seven raions failed to close around the
mismatch.

For the same reason the geometry is fetched as `rel(id:…);out geom;` in batches of eight, rather
than as a cheaper `out body;` plus a flat `way(id:…);out geom;`. The split form transfers each
shared border once instead of twice, but the two halves do not have to agree — fetched that way,
four raions came back with dangling way ends while the very same relations requested with
`out geom;` closed perfectly. A response carrying both membership and coordinates cannot disagree
with itself.

Even pinned, the mirrors do not reconstruct attic geometry byte-identically: 9 ways out of 8 235
arrive in two versions. Each relation keeps the copy its own response closed with, so those are the
only borders in the file that can differ between two neighbours — 65.7 km, 0.101% of all boundary.
The build lists them by way id on every run.

### Crimea is mapped twice

Six KATOTTG codes carry two relations each: the boundary Ukraine recognises (`claimed_by=UA`,
`disputed_by=RU`) and the one drawn by the occupying administration (`claimed_by=RU`). The build
selects `claimed_by=UA`, consistent with the rest of the product's territorial semantics, and
reports every relation it drops.

### Shared borders cannot split

Simplification runs per OSM **way**, not per raion ring. Adjacent raions reference the same way
object along their common border, so simplifying each way once and reusing the result gives both
sides a bit-identical vertex chain — gaps between neighbours are impossible by construction, with no
topology-preserving dependency involved. The build verifies this afterwards by counting shared
edges: an interior border must appear exactly twice in the output.

Where OSM itself has a break — a relation ending two ways a few metres apart instead of sharing a
node — the builder bridges gaps up to 25 m and reports every bridge with its distance. At the pinned
snapshot none were needed.

The audit on the shipped file: **22 222 edges shared by exactly two raions, 0 used more than twice**
— no overlaps, no split borders. The 6 652 single-use edges (8 116 km) are the outward-facing hull:
the state border, the coastline, and the walls around Kyiv and Sevastopol, which are not raions and
so have no partner polygon.

### Size and tolerance

Douglas-Peucker at **180 m**, coordinates rounded to 5 decimals. The full-resolution assembly is
10.50 MB over 528 977 vertices; the shipped file is **1.05 MB over 51 318 vertices**, 0.31 MB gzipped
— and Caddy serves `/data/` with `encode zstd gzip`, so 0.31 MB is what a phone actually downloads.

180 m is a maximum deviation of 0.89 px at zoom 9, the deepest zoom the raion layer is designed for.
The layer is drawn at every zoom — a raion a source named is lit on the country-wide view too — and
error shrinks as the map zooms out, so the shallow end costs nothing: 0.11 px at zoom 6, less than
half of that at the map's opening zoom of 5.1. `--report` prints the whole curve:

| tolerance | vertices | raw | gzip | max error @z6 | @z9 | @z11 |
|---:|---:|---:|---:|---:|---:|---:|
| 0 | 528 977 | 10.50 MB | 3.00 MB | 0.00 | 0.00 | 0.00 |
| 100 m | 69 501 | 1.41 MB | 0.42 MB | 0.06 px | 0.49 px | 1.97 px |
| 150 m | 56 529 | 1.15 MB | 0.34 MB | 0.09 px | 0.74 px | 2.96 px |
| **180 m** | **51 318** | **1.05 MB** | **0.31 MB** | **0.11 px** | **0.89 px** | **3.55 px** |
| 300 m | 39 234 | 0.81 MB | 0.23 MB | 0.19 px | 1.48 px | 5.92 px |

Change it with `--tolerance`; the budget for this file is 1.5 MB, so 100 m still fits if the layer
ever needs to look right past zoom 10.

## Catalogue coordinates

The KATOTTG importer writes the catalogue's names, codes and hierarchy, but never a coordinate.
Until migration 056 only the hand-seeded rows had one: the oblasts, Kyiv, Sevastopol and 27 oblast
capitals. That left 461 of 488 cities and all 1 772 hromadas NULL. A threat track is drawn between
the catalogue places its messages named, so most of its nodes had nowhere to stand. The head of a
live track at Ірпінь published `coordinates: null`.

`scripts/build-location-coordinates.mjs` fills these rows from OpenStreetMap and writes the result
as a migration, `migrations/056_location_coordinates.sql`.

### How a row is matched

The join is the one ADM2 uses, the `katotth` tag. The Ukrainian community puts it on raion
relations, and also on 29 419 settlement nodes and on the 1 469 hromada relations
(`admin_level=7`). Its value is the catalogue's `official_code`. A name is only a fallback, and
only inside a polygon.

| Row | Evidence, strongest first |
|---|---|
| city | 1. the `place=city\|town\|village\|hamlet` node carrying the row's `katotth`<br>2. the one node without a code that bears the row's name inside the raion's ADM2 polygon (the oblast's ADM1 polygon for the two rows parented straight to an oblast) |
| hromada | 1. the centre of its `admin_level=7` relation (Overpass `out center`, the centre of the bounding box), if it falls inside the raion's polygon<br>2. otherwise, the relation's `admin_centre` member<br>3. with no relation at all (every Crimean hromada), the settlement of the hromada whose name the hromada's adjective is formed from: Андріївська ← Андріївка, Яркополенська ← Ярке Поле |
| raion | nothing. `src/services/threat-vectors.ts` falls back to the ADM2 centroid and publishes it as approximate |

- **Several candidates leave a row NULL.** That covers two nodes with one code, two same-name
  untagged places in one raion, and two settlements matching a hromada's name equally well. A
  wrong point draws a track through a place nobody named; a missing one only shortens the track.
- **A node matched on its `katotth` may lie up to 15 km outside its raion polygon.** The code
  already names the raion, so the check exists to catch a mis-tagged node, which lands tens or
  hundreds of kilometres away. It must not reject two correct sources that disagree. At this
  snapshot 23 of the 29 419 tagged nodes lie outside their KATOTTG raion, the furthest by 12.4 km.
  These are villages around Sevastopol that KATOTTG places in Бахчисарайський район and OSM draws
  inside the city. Every such acceptance is printed: Інкерман at 8.9 km, and four Crimean
  hromada centres.
- **A hromada's point is the centre of an area, not a position.** `threat-vectors.ts` publishes it
  as `approximate`.

### Coverage

| Type | With coordinates after 056 | How |
|---|---|---|
| city | **488 of 488** (100%) | 27 seeded before; 459 by `katotth`; 2 by name (Сімферополь, Старий Крим, whose nodes carry no code) |
| hromada | **1 764 of 1 772** (99.5%) | 1 453 relation centres; 16 `admin_centre` members where the centre fell outside the raion; 295 Crimean administrative centres by name |
| raion | 0 of 136 | by design, see above |

Eight hromadas stay NULL, all in Crimea. Курська has two equally good candidates, Курське and
Курортне. For the other seven, no settlement named after the hromada appears among its tagged
nodes or among the untagged nodes of its raion: Верхньосадівська, Орлинівська (Бахчисарайський),
Зуйська (Білогірський), Побєдненська (Джанкойський), Завітненська (Керченський), Завітненська and
Орджонікідзевська (Феодосійський).

Two independent checks. The build compares OSM with the 27 capitals that were seeded by hand before
any of this: median 0.4 km, maximum 2.4 km (Павлоград). The catalogue's points for ten places were
also checked against Wikidata's coordinates (P625), and all are within 1.04 km: Ірпінь, Буча,
Бровари, Біла Церква (a seeded row 056 leaves alone), Славутич, Васильків, Ромни, Кременчук,
Нікополь, Ізмаїл.

### Rebuild

```bash
node scripts/build-location-coordinates.mjs            # rebuild the migration from the cached snapshot
node scripts/build-location-coordinates.mjs --refresh  # re-read the catalogue, re-fetch Overpass
node scripts/build-location-coordinates.mjs --refresh --out migrations/0NN_location_coordinates_refresh.sql
```

- The catalogue is read the way the other map-data scripts read it, `docker exec
  threatlens-ua-postgres-1 psql`. `THREATLENS_PG_CONTAINER` or `DATABASE_URL` points it elsewhere.
  The catalogue snapshot and every Overpass answer are cached under
  `node_modules/.cache/threatlens-coordinates`. A rerun without `--refresh` is offline and
  byte-identical, and prints the SHA-256 recorded below.
- **An applied migration is never edited.** When a KATOTTG release adds places, or OSM corrections
  are worth a new snapshot, run with `--refresh` and a new `--out`. The new snapshot holds only the
  rows that are still NULL, and the new file fills only those.
- **The queries are not date-pinned.** ADM2 pins because a relation's membership and its ways must
  agree across answers. Here each answer stands alone: a node carries its own coordinates, and
  Overpass computes a relation's centre inside the answer that names it. The `timestamp_osm_base`
  of each answer goes into the migration header instead. An answer from a database more than seven
  days old is refused and another mirror asked. On 2026-09-23 one mirror answered from 2026-05-06,
  and nothing else in its answer looked wrong. A truncated answer (a `remark`) is refused as well.
- **Untagged settlements are fetched only where they are asked for.** The country-wide filter
  returns 40 000 nodes, almost all of them outside Ukraine, and on a busy mirror it ran past the
  90 s request deadline. The matching therefore runs twice. The first pass, with no untagged nodes,
  records which raions it looked in. Only those raions' bounding boxes are fetched, in one request.
  At this snapshot that is the ten Crimean raions.
- **A fresh database needs the file twice.** Migrations run before the first KATOTTG import, so 056
  finds only the settlements that migrations 024, 031 and 032 seeded. The file only writes where
  both columns are NULL, so it is safe to apply again after the first import:
  `docker compose exec -T postgres psql -U threatlens -d threatlens < migrations/056_location_coordinates.sql`.

### `primary_settlement`

Before 056, "has coordinates" also meant "hand-seeded first-order place", and the classifier relied
on it. Its third homonym tie-break (`pickAmongTied`) resolves a bare «Миколаїв» to the oblast
capital because only the capital had coordinates; the town in Lviv oblast had none. 056 gives both
of them coordinates. So it first copies the old meaning into `locations.primary_settlement`, then
writes the points. The column is added nullable, filled only where it is NULL, and then made
`NOT NULL DEFAULT false`, so applying the file a second time cannot promote the rows it filled.
`listLocationLexemes` reads the column as the lexeme's `geocoded` flag. The map's city layer
(`cityCollection` in `web/app.js`) draws only primary settlements, so it keeps its 29 dots.
`/api/v1/locations` sends coordinates only for primary rows. The other 2 225 points would add
about 22 KB of zstd to every catalogue fetch (46.5 → 68.9 KB, measured on a copy of the production
catalogue), and no client reads them there.

### Provenance of the coordinates

| Field | Value |
|---|---|
| Catalogue snapshot | `2026-09-23T08:52:26Z`, `threatlens-ua-postgres-1` |
| `timestamp_osm_base` | `2026-09-23T08:50:51Z` (tagged settlements, hromada relations); `2026-09-23T08:58:00Z` (untagged settlements, the ten Crimean raions) |
| Overpass mirrors | as ADM2: `overpass-api.de`, `overpass.kumi.systems`, `overpass.private.coffee` |
| Rows written | 2 225: 461 cities, 1 764 hromadas |
| Coordinate precision | 4 decimals (~11 m), as the seeded rows |
| SHA-256 of `056_location_coordinates.sql` | `b422674ffaed218109b1c9b358fd1e4857ae57fe63e58e7e620d73c082a5bf8c` |

## Attribution

The boundary layers are a **Derivative Database** under ODbL, not merely a Produced Work: the
GeoJSON itself is served to clients at `/data/*.geojson`. Two things follow.

1. **The map's attribution control must credit the boundaries separately from the basemap.** The
   basemap's own "© OpenStreetMap contributors" covers the tiles, not this database. The required
   text is:

   > Межі: © учасники OpenStreetMap, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)

2. **Share-alike.** The derived database is offered under ODbL 1.0. It is already published in a
   machine-readable form at `/data/ukraine-adm2.geojson`, and each file carries `attribution` and
   `license` members so the licence travels with the bytes.

The catalogue coordinates are a Derivative Database as well. `/api/v1/locations` sends coordinates
only for the hand-seeded primary rows. The OpenStreetMap points reach clients through the payloads
that name a place: threat events, risk assessments, a location's timeline and the vector nodes.
They are offered under the same ODbL 1.0, and migration 056 names the source and the licence in its
header. On the map, the OpenStreetMap notice is the attribution-control credit quoted above, and its
wording names the boundaries only («Межі»).

## Provenance record

| Field | Value |
|---|---|
| Snapshot instant | `2026-08-07T00:00:00Z` |
| Overpass mirrors | `overpass-api.de`, `overpass.kumi.systems`, `overpass.private.coffee` |
| Relations fetched | 142, of which 6 are the `claimed_by=RU` Crimean duplicates |
| Features written | 136 of 136 catalogue raions (114 Polygon, 22 MultiPolygon, 38 holes) |
| Douglas-Peucker tolerance | 180 m |
| Coordinate precision | 5 decimals (~1.1 m) |
| SHA-256 of `ukraine-adm2.geojson` | `189e08e1812d71f52327490a3efcf1f3477d5d6882ab3b41c076bc18892a7968` |

The build re-run from cache reproduces that checksum exactly.

### Known deviations

- 4.60% of vertices (2 360 of 51 318) fall outside `ukraine-adm0.geojson`, the furthest by 3 510 m in
  Чернігівський район. This is a disagreement between sources, not a stray polygon: ADM0 is a
  generalised geoBoundaries outline while the raions are full-resolution OSM. For scale, the
  existing ADM1 layer has 10.75% of its vertices outside the same ADM0.
- The nine divergent ways listed by every build run.

Re-run the build after a KATOTTG release changes the raion set, or when OSM corrections matter
enough to be worth a new snapshot. Bump `SNAPSHOT_DATE` in the script, run with `--refresh`, and
record the new checksum here.
