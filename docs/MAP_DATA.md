# Map data: provenance, licence, rebuild

The map draws three boundary layers, from two different sources under the same licence.

| Layer | File | Source | Contents |
|---|---|---|---|
| ADM0 | `public/data/ukraine-adm0.geojson` | geoBoundaries `UKR`, release commit `9469f09` | the recognised border of Ukraine |
| ADM1 | `public/data/ukraine-adm1.geojson` | geoBoundaries `UKR`, release commit `9469f09` | 27 oblast-level units including the AR of Crimea and Sevastopol |
| ADM2 | `public/data/ukraine-adm2.geojson` | OpenStreetMap via Overpass | the 136 raions of the 2020 reform |

Every one of them is derived from OpenStreetMap and is licensed under **ODbL 1.0**. See
[Attribution](#attribution) — the obligation is not satisfied by the basemap's own credit line.

`data/map/README.md` holds the operational notes for the basemap and the pinned ADM0/ADM1
checksums. This file covers where the boundaries come from and how ADM2 is rebuilt.

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
