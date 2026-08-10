-- ================================================================================================
-- 031 — the four settlements whose absence made the catalogue name the wrong oblast
-- ================================================================================================
--
-- What was reported
-- -----------------
-- On 2026-08-10 at 14:50 Kyiv the map's territory panel showed **Обухівський район, Київська
-- область** carrying a live UAV threat whose direction read «курсом на Самар». Самар, Нікополь,
-- Синельникове and Шахтарське are all Dnipropetrovsk-area; Обухівський район is 400 km away. The
-- panel labelled it «найближча територія з контуром», i.e. the unmapped-ancestor climb in
-- `src/domain/territory-state.ts` had walked up from a settlement to the first parent that owns a
-- polygon. The climb was correct. The settlement it climbed from was not.
--
-- The message was `osint-rynda` 6b1e7d29-dbb5-4df2-a731-f418f66c62f4, 2026-08-10 11:50:11Z, in full:
--
--     Дніпропетровщина:
--     БпЛА курсом на Богуслав
--     Реактивний БпЛА курсом на Божедарівку
--
-- Classification f28dcf4d-4821-4f45-9eab-fcaffac67441 (v6) resolved «Богуслав» to
-- `katottg-ua32120010010027554` — Богуслав, місто, Обухівський район, Київська область — and wrote
-- it into event bbce2a36-72f5-4d97-b778-f8db016b8893 as `reported_direction`. From there the climb
-- painted Обухівський район, and every later message merged into that event (Синельникове, Самар)
-- re-rendered the panel with the newest direction text against the oldest wrong territory.
--
-- Ukraine holds exactly two Богуслав. The catalogue held one:
--
--   UA32120010010027554  M  Богуслав  Обухівський р-н, Київська обл.      ← in the catalogue
--   UA12120010020096111  C  Богуслав  Павлоградський р-н, Дніпропетровська обл.
--
-- The one the message meant is the second, which is nine kilometres from Павлоград — a place the
-- same feed named in the same event twenty minutes earlier. The message named its oblast in its own
-- first line and the catalogue overruled it.
--
-- Why the oblast in the message did not save it
-- ---------------------------------------------
-- `pickAmongTied` in `src/domain/classifier.ts` reads the oblasts a message names, and it is the
-- tie-break that separates the two Південне and the two Городок. But it runs only inside
-- `resolveSpanCollisions`, i.e. only when **two catalogue rows claim the same span**. With one row
-- there is no collision, nothing is tied, and the tie-break never executes: a single row wins
-- unopposed no matter which oblast the message just named. Migration 024 wrote this down as a known
-- limitation — "a future message about the Poltava Погреби would resolve to the Kyiv one" — and
-- named the mechanism that ends it: "`src/domain/classifier.ts` refuses a name held by two catalogue
-- rows unless the message names the oblast, which is the mechanism that will pick them apart if the
-- second row is ever added." This migration adds the second rows.
--
-- Why the fix is rows and not a rule
-- ----------------------------------
-- A guard of the shape "drop a settlement whose oblast the message did not name" was measured
-- against the archive before it was rejected. Twenty-two stored classifications resolve a settlement
-- outside every oblast they name, and most of them are correct reporting, not defects:
--
--   «Чернігівщина: Реактивний БпЛА курсом на Славутич»          — Славутич is a Kyiv-oblast city
--                                                                  enclosed by Chernihiv oblast;
--   «БпЛА з Брянської обл., рф — на північ Сумщини, курсом на
--     Новгород-Сіверський»                                      — a cross-oblast vector, stated;
--   «БпЛА курсом на Запоріжжя з півдня. / БпЛА на заході
--     Чернігівщини, курс південний.»                            — two independent lines;
--   the nightly Molfar/War-Monitor bulletins                    — national lists of cities.
--
-- The rule would have suppressed all of those. Nothing lexical separates them from the defects; only
-- geography does, and KATOTTG rows carry no coordinates. So the classifier is left alone and the
-- catalogue is corrected, which is also the cheaper failure mode: an added row can only ever make an
-- ambiguous name refuse, and refusing is what this module already does with two Городок.
--
-- What each row fixes, with the archived misresolution it repairs
-- --------------------------------------------------------------
-- Every code was read out of the official workbook the sync itself downloads (`KATOTTG_URL`,
-- kodifikator-07-07.xlsx) with `parseKatottgWorkbook`, and the raion and hromada in the same row
-- were used to confirm the settlement is the one the messages mean. The homonym count across all of
-- Ukraine is recorded for each, in the convention migration 024 set.
--
--   Богуслав       UA12120010020096111  Павлоградський р-н, Дніпропетровська обл.   (2 homonyms)
--     Category C, Богданівська громада. Fixes classification f28dcf4d (above), which put
--     Обухівський район on the map. Павлоград, Вербки and Петропавлівка — its neighbours — are all
--     already in the catalogue and all named by the same feed on the same night.
--
--   Золочів        UA63020050010064235  Богодухівський р-н, Харківська обл.         (2 homonyms)
--     Category X, Золочівська громада. The catalogue held only Золочів, місто, Львівська обл.
--     (UA46040070010068975), so two archived messages sent a Kharkiv drone to Lviv oblast:
--     8ef447a6-28b2-4852-bbcf-65a7d24817bf «Реактивний БПЛА на Харківщину з БНР попереднім курсом
--     на Золочів» and 09264f03-ef64-4bab-a907-e2eea613a809 «Харківщина: … БпЛА курсом на Золочів».
--     Both name Харківщина in the same sentence. Дергачі and Барвінкове, resolved correctly in the
--     second message, are the same raion neighbourhood.
--
--   Миколаївка     UA59080130010087968  Сумський р-н, Сумська обл.                  (97 homonyms)
--     Category X, Миколаївська громада. Ninety-seven is the largest homonym count in this file and
--     the row is added anyway, because the catalogue's single Миколаївка is
--     `katottg-ua14120130010079249` (місто, Краматорський р-н, Донецька обл.) and it was being
--     painted for Sumy border traffic: a4d3b0ac-7df8-4ecf-b019-61d39f10fceb «Сумщина: БпЛА повз
--     Хотінь ➡️ у напрямку Миколаївки/Степанівки» and a66137b9-7a22-4734-ada2-b0ad7adf4cc9
--     «Сумщина: реактивний БпЛА ➡️ в напрямку Миколаївки». Хотінь (added by 024) and Степанівка are
--     the two settlements either side of this one on the border; all three sit in Сумський район.
--     With two rows a bare, oblast-less «Миколаївка» now resolves to nothing instead of to Donetsk,
--     which is the outcome this module already prefers for «Городок».
--
--   Липова Долина  UA59060070010030190  Роменський р-н, Сумська обл.                (1 homonym)
--     Category X, Липоводолинська громада, and the only settlement of that name in Ukraine. This
--     row is not a homonym fix but a nesting fix: with no two-word row to claim the span,
--     02ece8e9-78c3-401b-a18e-654bfb199a55 «Сумщина: БпЛА ➡️ на півночі від Липової Долини» matched
--     the second word alone and resolved Долина, Калуський р-н, Івано-Франківська обл. — the far
--     west of the country. `resolveLocations` gives the longest name the text it covers, so the
--     two-word row takes the span and Долина is unreachable from it.
--
-- Verified against the production catalogue export before it was written: with these four rows the
-- six archived misresolutions above all resolve into the oblast their own message names, «Київщина:
-- БпЛА курсом на Богуслав», «Львівщина: … на Золочів» and «Донеччина: … на Миколаївку» still resolve
-- to the Kyiv, Lviv and Donetsk rows, and every other resolution in the sampled window is unchanged.
--
-- Not fixed here, and deliberately
-- --------------------------------
-- Божедарівка — the second place in the incident message, twelve archived mentions, all
-- Dnipropetrovsk (UA12040010010084655, смт, Кам'янський р-н) — resolves to nothing today and would
-- resolve correctly if added. It is a *silent-drop* coverage gap, not invented geography, so it
-- belongs to the same class of work migration 024 did rather than to this repair; Степанівка
-- (UA59080250010051865, Сумський р-н, 50 homonyms) is the same. Both are reported rather than
-- smuggled in, so that the decision to widen coverage is taken on its own evidence.
--
-- Tier, parent and coordinates follow migration 024 exactly: `locations.type` has no `settlement`
-- value so the leaf tier is `city`; the parent is the raion when the KATOTTG sync has created it and
-- the oblast when it has not (a fresh test database); and no coordinates are set, because the
-- workbook carries none and `geocoded` is the catalogue's own marker of a first-order row — giving
-- one to a village would make it win `pickAmongTied` against the city it must not outrank.

INSERT INTO locations (id, parent_id, type, name_uk, official_code, aliases)
SELECT 'katottg-' || lower(settlement.code),
       COALESCE(
         (SELECT raion.id FROM locations raion WHERE raion.official_code = settlement.raion_code),
         settlement.oblast_id
       ),
       'city', settlement.name_uk, settlement.code, ARRAY[lower(settlement.name_uk)]
  FROM (VALUES
    -- Дніпропетровська область
    ('UA12120010020096111', 'UA12120000000089862', 'ua-12', 'Богуслав'),
    -- Харківська область
    ('UA63020050010064235', 'UA63020000000066931', 'ua-63', 'Золочів'),
    -- Сумська область
    ('UA59080130010087968', 'UA59080000000057897', 'ua-59', 'Миколаївка'),
    ('UA59060070010030190', 'UA59060000000086008', 'ua-59', 'Липова Долина')
  ) AS settlement(code, raion_code, oblast_id, name_uk)
ON CONFLICT DO NOTHING;
