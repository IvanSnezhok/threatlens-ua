-- Settlements the monitoring channels name and the catalogue did not hold.
--
-- The hand-labelled gold corpus (`tests/fixtures/classifier-gold.json`) separates two kinds of miss:
-- a message the rules read wrongly, and a message the rules read correctly about a place that is not
-- in `locations` at all. The second kind was twenty-one messages of the sampled 191 — "Пара
-- реактивних на Згурівку", "Курс на н.п. Дігтярі та Мала Дівиця", "Жуляни 2 балістики падають" —
-- every one of them a correct report that raised nothing, because a threat event has to be
-- somewhere. No regex change can rescue those; only rows can.
--
-- ## Why these rows are not in the catalogue already
--
-- `src/services/location-catalog.ts` imports KATOTTG categories `O` (oblast), `K` (special city),
-- `P` (raion) and `M` (місто) — 461 cities. Every settlement below is category `X` (селище міського
-- типу) or `C` (село), which the importer does not read and deliberately should not: 29 240 rows of
-- villages would swamp the catalogue and make ambiguity the normal case rather than the exception.
-- These eighteen are added by hand because the archive shows the channels naming them.
--
-- ## Where the codes come from, and what was checked
--
-- Every code below was read out of the official workbook the sync itself downloads
-- (`KATOTTG_URL`, kodifikator-07-07.xlsx, version 07.07.2026) with `parseKatottgWorkbook`, and the
-- parent raion and hromada in the same row were used to confirm the settlement is the one the
-- messages mean. The homonym count is recorded for each: Ukraine holds seven villages called
-- Погреби and eighteen called Озерне, and picking the wrong one would be exactly the invented
-- geography this work exists to remove.
--
--   Обухівка   UA12020170010095010  Дніпровський р-н, Дніпропетровська обл.   (4 homonyms)
--     "Дніпропетровщина: 6х БпЛА курсом на Обухівку" — the oblast is named in the message.
--   Карнаухівка UA12040150020083955 Кам'янський р-н, Дніпропетровська обл.    (2 homonyms)
--     "🛵 БпЛА в районі н.п. Карнаухівка на Дніпропетровщині."
--   Погреби    UA32060090040088774  Броварський р-н, Київська обл.            (7 homonyms)
--     "Погреби - Троя рух БПЛА." — Троєщина is across the Desna from this one, and it shares a
--     hromada (Зазимська) with Зазим'я, which the same feed names in the same nights.
--   Озерне     UA18040350030097353  Житомирський р-н, Житомирська обл.        (18 homonyms)
--     "🛵Житомирщина: знову на Андрушівку - Озерне" — the airbase settlement east of Zhytomyr.
--   Білогородка UA32080010010043861 Бучанський р-н, Київська обл.             (3 homonyms)
--   Чабани     UA32140170010072394  Фастівський р-н, Київська обл.            (2 homonyms)
--   Сарата     UA51040190010067512  Білгород-Дністровський р-н, Одеська обл.  (2 homonyms)
--   Дігтярі    UA74080150020098715  Прилуцький р-н, Чернігівська обл.         (2 homonyms)
--     Named in the same message as Мала Дівиця, which is in the same raion.
--
-- The other ten are the only settlement of that name in Ukraine.
--
-- Rows whose name is shared with a settlement that is **not** in the catalogue stay a documented
-- coverage limitation rather than a silent one: a future message about the Poltava Погреби would
-- resolve to the Kyiv one. `src/domain/classifier.ts` refuses a name held by two catalogue rows
-- unless the message names the oblast, which is the mechanism that will pick them apart if the
-- second row is ever added.
--
-- ## The leaf tier is called `city`
--
-- `locations.type` has no `settlement` value and the KATOTTG importer writes `city` for every
-- populated place it inserts. These follow it, so the fanout, the map and the alert reconciliation
-- treat them exactly like any other imported settlement. No coordinates are set, for the same reason
-- the importer sets none: the workbook does not carry them and guessing at them would put a marker
-- on the map in a place nobody verified.
--
-- ## The parent link
--
-- The raion row exists only after the KATOTTG sync has run, which is true in production and false in
-- a freshly migrated test database. The parent is therefore the raion when it is there and the
-- oblast when it is not — the same fallback `importKatottgEntries` uses for a city whose raion is
-- missing. A settlement inserted against the oblast is not re-pointed by a later sync, because the
-- sync only reads categories it imports; that is a known, bounded imprecision in the hierarchy, not
-- in the name resolution.

INSERT INTO locations (id, parent_id, type, name_uk, official_code, aliases)
SELECT 'katottg-' || lower(settlement.code),
       COALESCE(
         (SELECT raion.id FROM locations raion WHERE raion.official_code = settlement.raion_code),
         settlement.oblast_id
       ),
       'city', settlement.name_uk, settlement.code, ARRAY[lower(settlement.name_uk)]
  FROM (VALUES
    -- Київська область
    ('UA32060110010087428', 'UA32060000000012455', 'ua-32', 'Згурівка'),
    ('UA32060070010067563', 'UA32060000000012455', 'ua-32', 'Велика Димерка'),
    ('UA32060090010046220', 'UA32060000000012455', 'ua-32', 'Зазим’я'),
    ('UA32060090040088774', 'UA32060000000012455', 'ua-32', 'Погреби'),
    ('UA32080010010043861', 'UA32080000000084076', 'ua-32', 'Білогородка'),
    ('UA32080030010080493', 'UA32080000000084076', 'ua-32', 'Бородянка'),
    ('UA32080090020082865', 'UA32080000000084076', 'ua-32', 'Крюківщина'),
    ('UA32140070010070369', 'UA32140000000020217', 'ua-32', 'Глеваха'),
    ('UA32140170010072394', 'UA32140000000020217', 'ua-32', 'Чабани'),
    -- Чернігівська область
    ('UA74100190010032782', 'UA74100000000047140', 'ua-74', 'Козелець'),
    ('UA74080150020098715', 'UA74080000000030554', 'ua-74', 'Дігтярі'),
    ('UA74080090010045475', 'UA74080000000030554', 'ua-74', 'Мала Дівиця'),
    -- Дніпропетровська область
    ('UA12020170010095010', 'UA12020000000052809', 'ua-12', 'Обухівка'),
    ('UA12040150020083955', 'UA12040000000032213', 'ua-12', 'Карнаухівка'),
    -- Сумська область
    ('UA59080310010046655', 'UA59080000000057897', 'ua-59', 'Юнаківка'),
    ('UA59080290010046940', 'UA59080000000057897', 'ua-59', 'Хотінь'),
    -- Житомирська область
    ('UA18040350030097353', 'UA18040000000058965', 'ua-18', 'Озерне'),
    -- Одеська область
    ('UA51040190010067512', 'UA51040000000032911', 'ua-51', 'Сарата')
  ) AS settlement(code, raion_code, oblast_id, name_uk)
ON CONFLICT DO NOTHING;

-- Kyiv districts.
--
-- Троєщина and Жуляни are administrative districts *inside* the city of Kyiv, so KATOTTG holds no
-- row for either: the codifier stops at the city. (The one "Троєщина" in the workbook,
-- UA68060210300096089, is an unrelated village in Khmelnytskyi oblast and is not being added.)
-- Making them rows of their own would invent a tier the catalogue does not have and would put a
-- second Kyiv on the map; they are aliases of the city instead, which is also what a reader needs —
-- a ballistic impact at Zhuliany is a Kyiv event, and the fanout already carries a Kyiv event to
-- every subscriber of the city.
--
-- "Троя" is the shorthand every monitoring channel in the archive actually uses; the full
-- "Троєщина" never appears in the sampled corpus at all. It is added for that reason and not as a
-- guess: no settlement in Ukraine is called Троя, so the alias has exactly one referent. The one
-- collision the declension engine can reach from it — the numeral "троє" — is suppressed by name in
-- `NEVER_A_PLACE`, and significance still requires the message to name a threat.
UPDATE locations
   SET aliases = (SELECT array_agg(DISTINCT alias)
                    FROM unnest(aliases || ARRAY['троєщина', 'троя', 'жуляни']) AS alias)
 WHERE id = 'ua-80';

-- "Запоріжжя" is the city, not the oblast.
--
-- The seed gave the alias to `ua-23` (Запорізька область), and because the catalogue is read longest
-- name first, every bare "Запоріжжя" in a threat message resolved to the oblast and the city was
-- unreachable — the row existed and could never be named. The gold corpus disagrees with the seed on
-- every message that says it: "🚀 КАБи на Запоріжжі", "БпЛА курсом на Запоріжжя з півдня" and the
-- nightly forecast list "(Суми, Харків, Запоріжжя, Дніпро, Одеса)" are all read as the city by a
-- reviewer, and the last of those names it in a list of cities.
--
-- This makes the pair consistent with the one the catalogue already got right: `ua-80` holds "київ"
-- and the oblast `ua-32` holds "київщина" and "київська область", so a bare "Київ" is the city. The
-- oblast keeps "запорізька область" and is reachable through the oblast-adjective rule
-- ("Запорізької області", "Запорізькою областю") exactly like every other oblast; nothing that
-- resolved the oblast by its own name stops resolving it. The alert-channel lookup normalises
-- "Запорізька область" to "запорізька" and matches the row by prefix, so it is unaffected.
UPDATE locations SET aliases = array_remove(aliases, 'запоріжжя') WHERE id = 'ua-23';
