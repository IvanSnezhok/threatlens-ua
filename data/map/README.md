# Production map assets

Place a self-hosted PMTiles archive and its MapLibre style JSON in this directory,
then set `MAP_STYLE_URL` to the public style URL. The development default uses
OpenFreeMap so the application is usable before production cartography is built.

The live operational layers are always served by ThreatLens as GeoJSON/SSE and do
not depend on the basemap provider. Preserve OpenStreetMap/OpenMapTiles attribution
for every derived basemap.

## Sovereignty and administrative overlays

`public/data/ukraine-adm0.geojson` and `public/data/ukraine-adm1.geojson` are pinned
from geoBoundaries `UKR` release commit `9469f09`. The ADM1 dataset contains the
Autonomous Republic of Crimea (`UA-43`) and Sevastopol (`UA-40`) in `shapeGroup=UKR`.
The application renders this overlay above the basemap so a basemap provider cannot
silently redefine the product's territorial semantics.

Source: https://www.geoboundaries.org/api/current/gbOpen/UKR/ADM0/ and
https://www.geoboundaries.org/api/current/gbOpen/UKR/ADM1/. Boundary source is
OpenStreetMap/Wambacher through geoBoundaries and is licensed under ODbL 1.0.

Pinned SHA-256:

- ADM0: `c7266254f5d3994b4fb2019c861cb4f01775b7ad96c949fc84f892d56d9cfa7f`
- ADM1: `4a5947e7497574d51f93255dfa7e03dce0c7acf6ecee52d25773a5205854a399`
