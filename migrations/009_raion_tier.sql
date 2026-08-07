-- Raion tier for the location catalogue.
--
-- The official alert channel `@air_alert_ua` announces at raion and hromada level ("Повітряна
-- тривога в • Мелітопольський район"), so `locations` grows a third level between oblast and city:
-- oblast -> raion -> city. The rows themselves are written by the KATOTTG importer
-- (src/services/location-catalog.ts); this migration only makes the schema ready for them.
--
-- 001_init.sql already allows 'raion' and 'hromada' in the type CHECK. The constraint is restated
-- here so a database created from an older, narrower definition converges on the same set, and the
-- pair of statements is written to be safe to re-run on its own.
ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_type_check;
ALTER TABLE locations ADD CONSTRAINT locations_type_check
  CHECK (type IN ('country','oblast','special_city','raion','hromada','city'));

-- Fanout and event queries used to cross a single parent edge; with the raion in between they walk
-- the tree, so the parent lookup stops being an incidental sequential scan over every location.
CREATE INDEX IF NOT EXISTS locations_parent_idx ON locations(parent_id);

-- Raion rows carry the hromada spellings the channel uses in their alias array, and matching is
-- done by exact lowercase alias. The type/name index keeps the catalogue listing endpoint, which
-- orders by (type, name_uk), from re-sorting a catalogue that is now several times larger.
CREATE INDEX IF NOT EXISTS locations_type_name_idx ON locations(type, name_uk);
