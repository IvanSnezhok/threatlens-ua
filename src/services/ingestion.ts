import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Counter, Gauge, type Histogram, type Registry } from 'prom-client';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { parseAlertChannelMessage } from '../domain/alert-parser.js';
import { classifyMessage, CLASSIFIER_VERSION, isDeEscalation, significanceRejection } from '../domain/classifier.js';
import { isBlockedPlaceToken, tokenize } from '../domain/place-morphology.js';
import {
  applyDeEscalation, cachedLocationLexemes, ingestThreat, LOCATION_HIERARCHY_MAX_DEPTH,
  recordClassification, withinDeliveryAge,
  type ClassificationDecision, type ClassificationLogEntry, type LocationLexemeRow
} from '../repositories/events.js';
import {
  AERIAL_MIRROR_SOURCE_ID, AERIAL_MIRROR_STATE_SOURCE_ID, AERIAL_MIRROR_USER_AGENT,
  aerialMirrorRawUrl, aerialMirrorUpstream, parseAerialMirrorPayload, toAlarmSnapshotBody,
  type AerialMirrorRawSnapshot, type AerialMirrorUpstream
} from '../sources/aerial-mirror.js';
import {
  ALERT_LEVELS, asAlertLevel, strongerAlertLevel,
  type AlertKind, type AlertLevel, type NormalizedMessage
} from '../types.js';
import { alertPokeMetrics, pokeAlertStarted, pokeLiveThreat } from './alert-poke.js';
import { legSchedulerMetrics, startLegScheduler, type SchedulerLeg } from './leg-scheduler.js';
import { markSourceError, markSourceSuccess } from './operations.js';
// One-way import, on purpose: the observations are ops instrumentation and this file stays free of
// ops code by calling four named functions rather than by growing a second metrics block.
import {
  countChannelError, countDroppedAlarmRecords, observeAlertPropagation,
  observeClassificationDuration, observeIngestionLag, observeSourceCacheAge
} from './publication.js';
import { retrospectiveGate, retrospectiveGateMetrics } from './retrospective-gate.js';
import { scheduleShadowClassification, shadowClassifierMetrics } from './shadow-classifier.js';
import {
  CODEX_CLASSIFIER_VERSION, classifyWithCodex, contextLineForVerdict, contextLocationIdsFor,
  recordPrimaryComparison, type CodexClassifyInput, type ModelAssessment
} from './codex-classifier.js';
import { codexClassifierMode } from './codex-settings.js';
import { appendLocationContext, contextExcerpt, contextLine } from './model-context.js';

interface AlarmRecord {
  externalId: string;
  locationKey: string;
  locationName: string;
  /**
   * The region the feed filed this row under, when it says so — «Дніпропетровська область» for a
   * hromada nested beneath it. Used ONLY to break a tie between catalogue rows that spell the same
   * (see {@link resolveLocationId}); it never widens a match and never invents one.
   */
  parentName?: string;
  alertType: string;
  active: boolean;
  startedAt: Date;
  /**
   * Колір і різновид, які назвало ЦЕ джерело про ЦЕЙ рядок, або `null` — не назвало.
   *
   * Не `alertType` і ніколи ним не стане. `alertType` — тотожність періоду (`alert_periods`
   * унікальний по (location_id, alert_type, started_at), зведення шукає активний період саме по
   * цій парі), тож диференційований різновид, записаний туди, зробив би перехід жовтий→червоний
   * ДРУГИМ періодом — з відбоєм першого посеред тривоги, яка щойно посилилася.
   *
   * `null` тут — звичайний і найчастіший стан, і він мусить бути явним: `undefined` було б «поле
   * не дійшло», а це різні речі для запису, який гасить колір, що вже стоїть у таблиці.
   */
  alertLevel: AlertLevel | null;
  alertKind: AlertKind | null;
}

const alarmTypeMap: Record<string, string> = {
  AIR: 'air_raid', AIR_RAID: 'air_raid', ARTILLERY: 'artillery', ARTILLERY_SHELLING: 'artillery',
  URBAN_FIGHTS: 'urban_fighting', CHEMICAL: 'chemical', NUCLEAR: 'nuclear'
};

/**
 * Єдиний тип тривоги, який ця система має право записати в `alert_periods`.
 *
 * Не смак і не спрощення — це те, чим весь низ за течією вже є. `outbox.ts` рендерить КОЖЕН
 * `alert_start` як «🔴 Повітряна тривога — …», `alert-parser.ts` рухає стан лише на «Повітряна
 * тривога»/«Відбій тривоги», а в базі за весь час існування проєкту 6644 періоди і 100 % із них
 * `air_raid`. Тобто «повітряна» — не поле, а інваріант.
 *
 * `alerts.in.ua` цей інваріант ламає мовчки: у зрізі 22.09.2026 з 43 активних тривог 36 були
 * `air_raid`, 6 — `artillery_shelling` і 1 — `urban_fights`, причому прифронтові громади стоять у
 * цих станах роками (Вовчанська — з 20.05.2024). Без цього фільтра перше ж вдале опитування
 * відкрило б сім періодів, розіслало б по них пуш «🔴 Повітряна тривога» про обстріл, який триває
 * два роки, і поклало б дворічний `started_at` у таймлайн і місячну аналітику.
 *
 * Тому: інші типи не пишуться, а рахуються — `threatlens_alarm_records_dropped_total{source,reason}`,
 * де `reason` — сам тип (`artillery`, `urban_fighting`). Втрата видима, а не тиха, і день, коли
 * система навчиться показувати артилерійську небезпеку окремою
 * сутністю з власним формулюванням, почнеться з цього лічильника, а не з мовчазного перейменування
 * обстрілу на повітряну тривогу.
 */
const INGESTED_ALERT_TYPE = 'air_raid';

/**
 * Який бік загрози називає `threat_type` з `alerts.in.ua`, і нічого більше.
 *
 * Тут рівно ті значення, які ФІД справді віддає: зріз 22.09.2026 (51 активна тривога, 31 із
 * `threats[]`) дав `drones` і `unspecified_missiles`, і більше нічого. Невідоме значення не додає
 * НІЧОГО — ні дронів, ні ракет: різновид, якого ніхто не оголошував, ця система не вигадує, і
 * тривога тоді лишається без різновиду, а не отримує здогаданий. Нове значення дописується сюди
 * після того, як його побачили в тілі, а не замість того.
 */
const alarmThreatAxis: Record<string, 'drones' | 'missiles'> = {
  drones: 'drones',
  unspecified_missiles: 'missiles',
  // Ці два в живому зрізі не траплялися, але стоять у опублікованому переліку `threat_type` поруч
  // із `unspecified_missiles`, і під час масованого удару приїде саме вони. Дописані як ЧИТАННЯ
  // переліку, а не як здогад: обидва — ракета, тією самою віссю.
  ballistic_missiles: 'missiles',
  cruise_missiles: 'missiles'
  // Рештa переліку (`air_defense`, `mig31k_departure`, `tactic_aircraft_activity`,
  // `strategic_aircraft_activity`, `guided_aerial_bombs`, `unknown`) навмисно не дає осі. Робота
  //ППО — не різновид загрози, зліт носія — не пуск, а КАБ у постанові про диференційовані тривоги
  // взагалі не названий. Тривога тоді лишається з кольором і без різновиду, і це чесне тіло.
};

/**
 * Різновид загрози з `threats[]`: обидві осі разом дають `drones_missiles`, одна — себе, жодної —
 * `null`.
 *
 * `null` повертається і тоді, коли `threats[]` немає взагалі: у тому самому зрізі 17 із 51 тривоги
 * мали колір і не мали жодної загрози в масиві. Колір без різновиду — нормальне тіло, а не
 * половина тіла.
 */
function alarmKindFromThreats(value: unknown): AlertKind | null {
  let drones = false;
  let missiles = false;
  for (const raw of Array.isArray(value) ? value : []) {
    const threat = asObject(raw);
    if (!threat) continue;
    const axis = alarmThreatAxis[String(threat.threat_type ?? threat.threatType ?? '')];
    if (axis === 'drones') drones = true;
    else if (axis === 'missiles') missiles = true;
  }
  if (drones && missiles) return 'drones_missiles';
  return drones ? 'drones' : missiles ? 'missiles' : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validDate(value: unknown, fallback = new Date()): Date {
  const date = value ? new Date(String(value)) : fallback;
  return Number.isNaN(date.getTime()) ? fallback : date;
}

export function normalizeAlarmResponse(body: unknown): { records: AlarmRecord[]; candidateCount: number } {
  const root = asObject(body);
  const rows = Array.isArray(body) ? body
    : Array.isArray(root?.states) ? root.states
      : Array.isArray(root?.alerts) ? root.alerts
        : Array.isArray(root?.data) ? root.data : [];
  const records: AlarmRecord[] = [];
  let candidateCount = 0;
  rows.forEach((raw, regionIndex) => {
    const region = asObject(raw);
    if (!region) return;
    const nested = [region.activeAlerts, region.active_alerts, region.alarms, region.alerts]
      .find(Array.isArray) as unknown[] | undefined;
    const alertRows = nested ?? [region];
    alertRows.forEach((alertRaw, alertIndex) => {
      const alert = asObject(alertRaw);
      if (!alert) return;
      candidateCount += 1;
      // Ключ локації беремо ЛИШЕ з поля, назва якого каже «локація»/«регіон», і ніколи з `id`
      // самого рядка. `id` у кожного фіда — ідентифікатор ТРИВОГИ, а не місця: через цю гілку
      // `alerts.in.ua` роками віддавав сюди 8757, 76016, 185413, вони йшли в
      // `locations.id OR official_code`, не збігалися ні з чим — і джерело падало на «no provider
      // locations matched» з першого дня, тобто не працювало ЖОДНОГО разу.
      //
      // `location_uid` цього фіда теж не ключ: це його власна нумерація («356» — Дніпропетровщина),
      // яка з КАТОТТГ не має нічого спільного. Збіг із нашим `official_code` був би випадковим і
      // тихим, тому сюди не подається зовсім — місце шукається за назвою.
      const locationKey = String(alert.locationId ?? alert.regionId ?? alert.region_id
        ?? region.locationId ?? region.regionId ?? region.region_id ?? '');
      const locationName = String(alert.locationName ?? alert.regionName ?? alert.region_name
        ?? alert.location_title ?? region.locationName ?? region.regionName ?? region.region_name
        ?? region.location_title ?? region.name ?? '');
      if (!locationKey && !locationName) return;
      // `alerts.in.ua` завжди каже, під чим лежить рядок: у громади є `location_raion`, у району й
      // міста — лише `location_oblast`. Беремо ВУЖЧИЙ із наявних: район відрізняє дві однойменні
      // громади, яких область не відрізняє (Вовчанська — Чугуївський район, Харківщина).
      const parentNameRaw = alert.parentName ?? alert.parent_name ?? alert.location_raion
        ?? alert.location_oblast ?? region.parentName ?? region.parent_name;
      const parentName = typeof parentNameRaw === 'string' && parentNameRaw.trim() ? parentNameRaw.trim() : undefined;
      const rawType = String(alert.alertType ?? alert.type ?? alert.alert_type ?? 'AIR').toUpperCase();
      const status = String(alert.status ?? region.status ?? '').toLowerCase();
      const activeValue = alert.active ?? alert.isActive ?? alert.is_active ?? region.active ?? region.isActive;
      // `/v1/alerts/active.json` не має жодного поля «активна»: він віддає САМЕ відкриті тривоги і
      // каже це через `finished_at: null`. Без цієї гілки `status` порожній, булевого поля немає,
      // вкладеного масиву немає — і кожен рядок ставав `active: false`, тобто вдале опитування
      // писало б у таблицю сорок три ПОГАШЕНІ тривоги. Наявність ключа тут і є формою відповіді:
      // дата в ньому означає «закрита», і ми це так і читаємо.
      const active = typeof activeValue === 'boolean' ? activeValue
        : 'finished_at' in alert ? alert.finished_at === null || alert.finished_at === undefined
          : nested ? true : ['active','ongoing','true','1'].includes(status);
      const startedAt = validDate(alert.startedAt ?? alert.started_at ?? alert.start ?? alert.lastUpdate
        ?? region.startedAt ?? region.started_at ?? region.lastUpdate);
      // Колір із двох форм, які його несуть, і з жодної іншої:
      //
      //   * `alertLevel` — тіло знімка дзеркала, яке будує `toAlarmSnapshotBody`;
      //   * `alert_level` — `alerts.in.ua` (`/v1/alerts/active.json`), де поле стоїть НА ТРИВОЗІ,
      //     поруч із `alert_type`; у знятому зрізі 22.09.2026 19:47 колір мали всі 43 активні
      //     тривоги (23 червоних, 20 жовтих), різновид — 30 із них.
      //
      // Ukraine Alarm v3 кольору не несе взагалі — у його тілі є `regionType` і
      // `activeAlerts[].type`, і жодного поля рівня, — тож ця гілка дає `null`, і це правда про
      // API, а не прогалина в читанні. Коли API додасть рівень, він читається тут.
      //
      // `asAlertLevel` відкидає все, що не `yellow` і не `red`: перелік домену розширюється
      // міграцією, а не тілом, яке приїхало вночі.
      const alertLevel = asAlertLevel(alert.alertLevel ?? alert.alert_level
        ?? region.alertLevel ?? region.alert_level);
      records.push({
        externalId: String(alert.id ?? `${locationKey || locationName}-${rawType}-${startedAt.toISOString()}-${regionIndex}-${alertIndex}`),
        locationKey,
        locationName,
        ...(parentName ? { parentName } : {}),
        alertType: alarmTypeMap[rawType] ?? rawType.toLocaleLowerCase(),
        active,
        startedAt,
        alertLevel,
        // Різновид виводиться з `threats[]` і ніколи з `alert_type`: `alert_type` лишається
        // `air_raid`. Дзеркало `threats[]` не має, тож там різновид — `null` при живому кольорі, і
        // це очікувано: klimenko називає колір, але не називає, чим саме загрожують.
        alertKind: alarmKindFromThreats(alert.threats ?? region.threats)
      });
    });
  });
  return { records, candidateCount };
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export interface LocationCandidate {
  id: string;
  type: string;
  match_rank: number;
}

// Exact name and alias hits outrank prefix hits; an ambiguous tier is rejected instead of
// silently returning an arbitrary region.
export function pickLocationMatch(candidates: LocationCandidate[]): string | null {
  for (const rank of [0, 1, 2]) {
    const tier = candidates.filter((candidate) => Number(candidate.match_rank) === rank);
    if (!tier.length) continue;
    if (rank === 2) return tier.length === 1 ? tier[0]!.id : null;
    const administrative = tier.filter((candidate) => candidate.type === 'oblast' || candidate.type === 'special_city');
    const preferred = administrative.length ? administrative : tier;
    return preferred.length === 1 ? preferred[0]!.id : null;
  }
  return null;
}

/**
 * Apostrophe characters folded away on both sides of a name comparison.
 *
 * Ukrainian raion and hromada names carry an apostrophe — Кам'янський, Куп'янський, Слов'янський —
 * and the character used for it differs between the KATOTTG workbook, the alert APIs and the
 * Telegram channel, which prints U+2019. Passed as a bind parameter to `translate()` rather than
 * concatenated into the statement.
 */
const APOSTROPHE_CHARACTERS = "'‘’ʼ`´";

/**
 * The alias branch is written as array containment, not as `EXISTS (SELECT … unnest(aliases) …)`.
 *
 * The two are the same question — «is $1 among this row's normalised aliases» — and the second one
 * is the one an index can answer. An `unnest()` inside `EXISTS` is a set-returning subplan evaluated
 * per row, which pins the whole statement to a sequential scan: an OR-chain is all-or-nothing for
 * the planner, so one unindexable branch costs the other two their indexes as well.
 * `location_aliases_normalized` (migration 053) is the same fold applied by a stable expression, and
 * `@>` against it is served by a GIN index. Semantics are unchanged, including the NULL cases: a row
 * with no aliases produces an empty array, which contains nothing, exactly as the EXISTS returned
 * false.
 */
const LOCATION_MATCH_SQL = `SELECT id,type,
     CASE WHEN translate(lower(name_uk),$3,'')=$1 THEN 0
          WHEN location_aliases_normalized(aliases,$3) @> ARRAY[$1::text] THEN 1
          ELSE 2 END AS match_rank
   FROM locations
   WHERE translate(lower(name_uk),$3,'')=$1
      OR location_aliases_normalized(aliases,$3) @> ARRAY[$1::text]
      OR translate(lower(name_uk),$3,'') LIKE $2||'%' ESCAPE E'\\\\'
   LIMIT 50`;

/**
 * Progressively narrower spellings to try for one published location name.
 *
 * The alert channel publishes a city and the hromada around it as a single label —
 * "м. Харків та Харківська територіальна громада" — which matches nothing in the catalogue as
 * written. The full label is still tried first, in case a feed ever spells a row exactly.
 *
 * What follows it is the HROMADA half, then the city half. That order is the whole point of
 * migration 051: both halves name a real row now, and the hromada is the one the label actually
 * claims. Resolving to the city would be narrower than what the source said — the alert covers the
 * hromada, of which the city is one part — and narrowing an official alert is the one direction
 * this project never takes. The city stays as the fallback for a catalogue that has not imported
 * the hromada yet, which is exactly what it was before.
 *
 * This is a narrowing, not a guess; the refusal-on-ambiguity rule still applies to every candidate
 * individually.
 */
export function locationNameCandidates(raw: string): string[] {
  const base = raw.replace(/\s+/gu, ' ').trim().replace(/[.,;:!?]+$/u, '').trim();
  const candidates: string[] = [];
  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && !candidates.includes(trimmed)) candidates.push(trimmed);
  };
  push(base);
  const compound = /^(.+?)\s+та\s+(.+територіальн[а-яіїєґ]*\s+громад[а-яіїєґ]*)$/iu.exec(base);
  if (compound) { push(compound[2]!); push(compound[1]!); }
  return candidates;
}

function normalizeForCatalogue(name: string): string {
  return name.toLocaleLowerCase('uk-UA')
    .replace(/['‘’ʼ`´]/gu, '')
    .replace(/^(м\.|місто|обл\.|область)\s*/u, '').replace(/\s+(обл\.|область)$/u, '').trim();
}

/**
 * The normalized spellings to try for one candidate, most literal first.
 *
 * `normalizeForCatalogue` strips the «область» affix, which is what lets «Київська обл.» find
 * «Київська область». Stripping it *before* the query is also how three oblasts used to resolve to
 * the wrong row: the catalogue gives the occupied oblast capitals their declined forms as aliases —
 * `донецька` on Донецьк, `луганська` on Луганськ, `івано-франківська` on Івано-Франківськ — and once
 * «Донецька область» has been cut down to `донецька` that alias is an EXACT hit at rank 1, while the
 * oblast it actually names is only a rank 2 prefix hit. `pickLocationMatch` prefers the better rank,
 * as it should, and answered Донецьк. Донеччина and Луганщина are under alert almost permanently, so
 * this was not a rare edge: it was two of the loudest rows in every snapshot landing on a city.
 *
 * The fix is to ask the literal question first. The unstripped spelling matches the oblast's own
 * `name_uk` at rank 0 and wins outright; only when nothing matches it does the stripped form run and
 * behave exactly as it did before. Names with no affix to strip — every raion the alert channel
 * publishes — produce one form, so the extra query is paid only where the two spellings differ.
 */
function catalogueLookupForms(candidate: string): string[] {
  const literal = candidate.toLocaleLowerCase('uk-UA').replace(/['‘’ʼ`´]/gu, '').trim();
  return [...new Set([literal, normalizeForCatalogue(candidate)])].filter(Boolean);
}

export interface LocationQuery {
  locationKey?: string;
  locationName: string;
  /**
   * The enclosing region the feed filed this name under, when it says so. Optional, and consulted
   * only where the name alone is ambiguous — see {@link narrowByParent}.
   */
  parentName?: string;
}

/**
 * The candidates that lie under `parentName`, when that is the only thing telling them apart.
 *
 * ## Why this exists
 *
 * Hromada names repeat. Of the 1772 hromadas the catalogue gained in migration 051, 135 share a
 * name with a hromada in another raion — Калинівська, Миколаївська, Степанівська and so on — and
 * `pickLocationMatch` refuses a tie rather than guessing, which is the right default and which
 * would have left those 135 unresolvable forever.
 *
 * They are not actually ambiguous in the data, though. `skog` nests communities under the oblast
 * that holds them and `klimenko` keys its object by oblast name, so every row arrives already
 * carrying the answer; only 31 of the 135 still collide once the oblast is known. The parser was
 * throwing that away because `AerialMirrorRegion` had nowhere to put it.
 *
 * ## Why it narrows and never widens
 *
 * This runs only on a tier `pickLocationMatch` was about to reject, and it can only ever REMOVE
 * candidates. If the parent does not resolve, or resolves to something that holds none of them, or
 * still holds more than one, the answer stays "no match" — exactly what it was without the hint. A
 * hint can therefore turn a refusal into a resolution, and can never turn one row into a different
 * one.
 */
async function narrowByParent(
  candidates: LocationCandidate[], parentName: string
): Promise<string | null> {
  const parentId = await resolveLocationId({ locationName: parentName });
  if (!parentId) return null;
  const under = await pool.query<{ id: string }>(
    `WITH RECURSIVE climb(id, ancestor_id, depth, path) AS (
         SELECT id, id, 0, ARRAY[id] FROM locations WHERE id = ANY($1::text[])
       UNION ALL
         SELECT c.id, parent.id, c.depth+1, c.path||parent.id
           FROM climb c JOIN locations self ON self.id = c.ancestor_id
                        JOIN locations parent ON parent.id = self.parent_id
          WHERE c.depth < ${LOCATION_HIERARCHY_MAX_DEPTH} AND NOT (parent.id = ANY(c.path))
     )
     SELECT DISTINCT id FROM climb WHERE ancestor_id = $2`,
    [candidates.map((candidate) => candidate.id), parentId]
  );
  return under.rowCount === 1 ? under.rows[0]!.id : null;
}

async function lookupLocationId(query: LocationQuery): Promise<string | null> {
  if (query.locationKey) {
    const byCode = await pool.query<{ id: string }>(
      `SELECT id FROM locations WHERE id=$1 OR official_code=$1 LIMIT 1`, [query.locationKey]
    );
    if (byCode.rowCount) return byCode.rows[0]!.id;
  }
  if (!query.locationName) return null;
  for (const candidate of locationNameCandidates(query.locationName)) {
    for (const normalized of catalogueLookupForms(candidate)) {
      const rows = await pool.query<LocationCandidate>(
        LOCATION_MATCH_SQL, [normalized, escapeLikePattern(normalized), APOSTROPHE_CHARACTERS]
      );
      const matched = pickLocationMatch(rows.rows);
      if (matched) return matched;
      // Only the tier that was rejected is worth narrowing, and only the exact tiers: a prefix hit
      // is a guess about the text and does not become a better guess for having a parent.
      if (!query.parentName) continue;
      for (const rank of [0, 1]) {
        const tier = rows.rows.filter((row) => Number(row.match_rank) === rank);
        if (tier.length < 2) continue;
        const narrowed = await narrowByParent(tier, query.parentName);
        if (narrowed) return narrowed;
        break;
      }
    }
  }
  return null;
}

/**
 * The answers to «which catalogue row is this label», remembered for as long as the catalogue is.
 *
 * ## Why a memo and not a faster query
 *
 * The question is asked once per published label per poll and the set of labels barely moves: the
 * aggregated mirror feed emits all twenty-five oblasts on EVERY poll by design, the granular feed
 * re-lists the same raions minute after minute, and `narrowByParent` asks for the same oblast name
 * again for every ambiguous hromada under it. At a four-second poll across two feeds that is on the
 * order of 900 resolutions a minute, of which perhaps a dozen are questions we have not already
 * answered. Migration 053 makes each one index-served; this makes the repeated ones free.
 *
 * ## What the answer is allowed to depend on
 *
 * `lookupLocationId` reads nothing but `locations` and its three arguments, so the key is the whole
 * argument triple and the generation is the catalogue.
 *
 * ## How the generation is observed, and why it is not a reset function
 *
 * `src/repositories/events.ts` already owns catalogue invalidation: `invalidateLocationLexemeCache()`
 * is called by `location-catalog.ts` after the import COMMIT, and `cachedLocationLexemes()` then
 * hands out a NEW array. Array identity is therefore an exact generation counter for the only writer
 * this application has, and it is the seam that module already exposes — `indexFor` in
 * `src/domain/classifier.ts` keys its token index on the same identity. Inventing a second reset
 * function here would mean a second lifecycle to keep in agreement with the first, and the one that
 * is not wired into the import is the one that goes stale.
 *
 * Reading it costs a resolved promise once the catalogue is warm. When it is cold this pays for the
 * catalogue load — which any process that classifies a message pays anyway, six hours at a time —
 * and when that load FAILS the resolution runs unmemoised rather than failing: a catalogue query
 * that times out must not turn a poll that would have worked into a source error.
 *
 * ## Negative answers
 *
 * They have to be cached — an unmapped hromada is otherwise re-asked fifteen times a minute forever,
 * which is the most expensive query shape there is, since a miss is the one that can match no index
 * entry and read the furthest. They also have to expire: a catalogue gap is normally closed by an
 * import, which moves the generation, but a row inserted by hand is a writer neither cache knows
 * about, and a permanently negative memo would hide it until the next restart. A minute is short
 * enough that nobody notices and long enough to remove fourteen of every fifteen polls' worth.
 */
const LOCATION_MEMO_MISS_TTL_MS = 60_000;
/**
 * Cleared wholesale rather than evicted one by one at this size. The catalogue has ~31 000 rows and
 * the live label set is in the hundreds, so reaching this bound means a source has started emitting
 * unbounded distinct labels — in which case the memo is worthless anyway and the only thing worth
 * guaranteeing is that it cannot grow into the heap.
 */
const LOCATION_MEMO_MAX_ENTRIES = 8192;

const locationMemo = new Map<string, { id: string | null; at: number }>();
let locationMemoCatalogue: LocationLexemeRow[] | null = null;

async function resolveLocationId(query: LocationQuery): Promise<string | null> {
  const catalogue = await cachedLocationLexemes().catch(() => null);
  if (!catalogue) return lookupLocationId(query);
  if (catalogue !== locationMemoCatalogue) {
    locationMemo.clear();
    locationMemoCatalogue = catalogue;
  }
  // NUL-separated: no catalogue label contains it, so no two distinct triples can collide on one key.
  const key = `${query.locationKey ?? ''}\u0000${query.locationName}\u0000${query.parentName ?? ''}`;
  const memoized = locationMemo.get(key);
  if (memoized && (memoized.id !== null || Date.now() - memoized.at < LOCATION_MEMO_MISS_TTL_MS)) {
    return memoized.id;
  }
  const id = await lookupLocationId(query);
  if (locationMemo.size >= LOCATION_MEMO_MAX_ENTRIES) locationMemo.clear();
  locationMemo.set(key, { id, at: Date.now() });
  return id;
}

/**
 * Назви місць, яких каталог не має, по джерелах.
 *
 * Дві дороги сходяться в одну структуру, бо питання одне: «яких населених пунктів нам бракує, і хто
 * їх називає». Офіційні фіди називають місце полем відповіді, і {@link recordUnresolvedLocations}
 * ПЕРЕПИСУЄ рядок джерела на кожен знімок — там `count` означає «стільки не зіставлено в останньому
 * знімку». Моніторингові канали називають місце прозою, по одному повідомленню, і там накопичується:
 * `count` означає «стільки разів від старту процесу ми бачили назву, якої не знаємо». Семантика
 * різна, бо різні самі джерела; структура одна, бо `/ops` питає про них однаково.
 */
export interface UnresolvedLocationReport {
  sourceId: string;
  count: number;
  samples: string[];
  observedAt: string;
}

const unresolvedLocationState = new Map<string, UnresolvedLocationReport>();

/**
 * Стеля структури, а не метрики.
 *
 * Назви місць з чужої прози — це необмежений словник, і мітка Prometheus з нього була б
 * кардинальним вибухом. Тут вони живуть у памʼяті процесу, тож стеля потрібна все одно: джерел
 * стільки, скільки рядків у `sources` (нині ~60), але рядок може завести будь-який `sourceId`, а
 * зразків на джерело — стільки, скільки різних невпізнаних слів напише канал за добу.
 */
const UNRESOLVED_SOURCES_MAX = 64;
const UNRESOLVED_SAMPLES_MAX = 20;

export function unresolvedLocationReports(): UnresolvedLocationReport[] {
  return [...unresolvedLocationState.values()];
}

/** Витісняє найдавніше спостережене джерело, коли карта вперлася в стелю. */
function makeRoomForSource(sourceId: string): void {
  if (unresolvedLocationState.has(sourceId) || unresolvedLocationState.size < UNRESOLVED_SOURCES_MAX) return;
  let oldest: UnresolvedLocationReport | null = null;
  for (const report of unresolvedLocationState.values()) {
    if (!oldest || report.observedAt < oldest.observedAt) oldest = report;
  }
  if (oldest) unresolvedLocationState.delete(oldest.sourceId);
}

// Unmapped provider locations are a catalogue gap, not a source outage: they are counted and
// logged, but never reported through markSourceError.
function recordUnresolvedLocations(sourceId: string, unresolved: string[], log?: { warn: Function }): void {
  const samples = [...new Set(unresolved)].sort().slice(0, UNRESOLVED_SAMPLES_MAX);
  const previous = unresolvedLocationState.get(sourceId);
  makeRoomForSource(sourceId);
  unresolvedLocationState.set(sourceId, {
    sourceId, count: unresolved.length, samples, observedAt: new Date().toISOString()
  });
  if (!unresolved.length || previous?.samples.join('|') === samples.join('|')) return;
  log?.warn({ sourceId, unresolvedCount: unresolved.length, unresolvedLocations: samples },
    'provider locations could not be mapped to the local location catalogue');
}

/**
 * Слова, які МОГЛИ БУТИ назвою місця, з повідомлення, що не дало каталогу жодного місця.
 *
 * Навіщо. `no_location` на моніторинговому каналі — це правильно складене повідомлення про загрозу,
 * яке не підняло нічого, бо названого села немає в каталозі. Досі з нього лишався тільки лічильник:
 * `threatlens_classification_rejections_total{reason="no_location"}` казав, що діра є, і ніколи не
 * казав, ЯКА. Офіційні фіди такої проблеми не мають — вони називають місце окремим полем, і воно
 * їде в {@link recordUnresolvedLocations}. Це та сама дорога для прози.
 *
 * Як. Тим самим токенізатором, яким каталог ріже і повідомлення, і власні назви
 * (`src/domain/place-morphology.ts`) — другий токенізатор поряд із першим означав би, що «Кам'янець-
 * Подільський» у двох місцях коду є різною кількістю слів. Груба форма ознаки — слово з великої
 * літери, і чотири відсіви до неї, кожен проти конкретного шуму справжніх каналів:
 *
 *  * слово на початку речення відкидається — «Увага», «Загроза», «Терміново» стоять там завжди;
 *  * слово, писане капслоком чи з великою літерою всередині, відкидається — це «ППО», «РФ», «БпЛА»,
 *    «МіГ», тобто саме той словник, яким канал пише про зброю, а не про місце;
 *  * кирилиця й щонайменше три літери — латиниця тут є хіба в назві каналу й у посиланні;
 *  * {@link isBlockedPlaceToken} — сторони світу й звичайні слова, які морфологія вміє довести до
 *    справжньої назви («південним», «мені»). Каталог відкидає їх при розборі, і список гіпотез не
 *    має права показувати оператору те, що система свідомо не читає як місце.
 *
 * Сусідні слова, що пройшли відсів і розділені одним пробілом, склеюються: «Нова Каховка» — одна
 * гіпотеза, а не дві. Це ЗДОГАДКИ, а не назви: рядок у `/ops` читають очима, щоб вирішити, чи це
 * пропущене село, чи просто прізвище.
 */
const UNKNOWN_PLACE_MIN_LENGTH = 3;
const CYRILLIC_WORD = /^\p{Script=Cyrillic}[\p{Script=Cyrillic}'’ʼ-]*$/u;
const SENTENCE_END = /[.!?…:;\n]/u;

export function unknownPlaceCandidates(text: string): string[] {
  // Токенізується ОРИГІНАЛ, а не зведений до нижнього регістру рядок, яким його годує каталог.
  // `tokenize` — чиста регулярка по межах слова, регістр їй байдужий, а зсуви `start`/`end` мають
  // вказувати в той самий рядок, у якому ще видно велику літеру. Порівнювати зсуви від зведеного
  // тексту з оригіналом було б припущенням, що зведення не змінює довжини, — правдивим для
  // кирилиці й неправдивим взагалі.
  const tokens = tokenize(text);
  const candidates: string[] = [];
  let run: string[] = [];
  let runEnd = -1;
  for (const token of tokens) {
    const raw = text.slice(token.start, token.end);
    const lowered = raw.toLocaleLowerCase('uk-UA');
    // Перше слово речення пишеться з великої літери незалежно від того, що воно означає, тож ознака
    // там не несе інформації. Продовження склейки — виняток: «Нова Каховка» після крапки почалася б
    // з відкинутого слова, але друге слово її все одно підбере наступною ітерацією.
    const before = text.slice(0, token.start);
    const sentenceStart = !before.trim() || SENTENCE_END.test(before.slice(before.trimEnd().length - 1) || '.');
    const capitalised = raw[0] !== lowered[0] && raw.slice(1) === lowered.slice(1);
    const plausible = capitalised && !sentenceStart
      && raw.length >= UNKNOWN_PLACE_MIN_LENGTH && CYRILLIC_WORD.test(raw)
      && !isBlockedPlaceToken(token.key.toLocaleLowerCase('uk-UA'), true);
    if (plausible && (runEnd < 0 || text.slice(runEnd, token.start) === ' ')) {
      run.push(raw);
      runEnd = token.end;
      continue;
    }
    if (run.length) candidates.push(run.join(' '));
    run = plausible ? [raw] : [];
    runEnd = plausible ? token.end : -1;
  }
  if (run.length) candidates.push(run.join(' '));
  return [...new Set(candidates)];
}

/**
 * Дописує гіпотези одного повідомлення до накопиченого рядка джерела.
 *
 * Накопичує, а не переписує: у прози немає «знімка», з якого можна було б перечитати все наново, і
 * рядок, переписаний останнім повідомленням, показував би оператору одне слово замість переліку
 * дір. Стеля зразків тримає його скінченним, лічильник рахує спостереження — щоб «одне село
 * згадали сто разів» і «сто різних сіл по разу» не виглядали однаково.
 */
function recordUnknownPlaces(sourceId: string, candidates: string[]): void {
  if (!candidates.length) return;
  const previous = unresolvedLocationState.get(sourceId);
  makeRoomForSource(sourceId);
  const samples = [...new Set([...(previous?.samples ?? []), ...candidates])]
    .sort().slice(0, UNRESOLVED_SAMPLES_MAX);
  unresolvedLocationState.set(sourceId, {
    sourceId, count: (previous?.count ?? 0) + candidates.length, samples,
    observedAt: new Date().toISOString()
  });
}

/** Тестовий шов: стан живе в модулі, а сюїти в одному форку діляться ним. */
export function resetUnresolvedLocations(): void {
  unresolvedLocationState.clear();
}

/**
 * The one lock every writer of official alert state takes, as the first statement of its
 * transaction: `runSnapshotPass`, `applyAlertChannelStates` and `expireStuckAlertChannelAlerts`.
 * Nothing outside this module writes `alert_source_states` or `alert_periods`, and
 * `tests/integration/alert-state-lock.test.ts` fails if that stops being true.
 *
 * Distinct from `migrate()`'s 841005211 and `APP_SETTINGS_LOCK`'s 841005212, for the reason given
 * there: unrelated writers must not queue behind each other.
 *
 * ## Why one global lock and not row locks
 *
 * Each source's pass re-reconciles every location that source has ever held, in the order its own
 * rows come back, and each reconcile takes `FOR UPDATE` on that location's active period. Two
 * sources that share active periods — the mirror every four seconds, alerts.in.ua every seven, and
 * during a mass attack that is most of the map — take the same row locks in opposite orders. On
 * 22.09.2026 a reproduction of exactly that lost a pass to `deadlock detected` in twenty-five rounds
 * out of twenty-five: the losing source went to `error`, its leg backed off, and any alert raised
 * only in that pass waited for the next one. Row locks also cannot protect the one row that does not
 * exist yet: two passes that both see no active period for a new alert each INSERT their own, and
 * with starts a few seconds apart the unique key does not stop them — two «🔴 Повітряна тривога»,
 * later two «Відбій». And the aggregate is read BEFORE the period lock, so a pass could decide
 * «ended» from a picture that omits the other pass's uncommitted «still active».
 *
 * A single lock taken before anything is read closes all three: the passes run one after another,
 * and each reads everything the previous one committed. «Everything the previous one committed»
 * holds only under READ COMMITTED, where each statement takes a fresh snapshot after the lock is
 * granted; under REPEATABLE READ the snapshot would predate the lock and every race above returns.
 * Nothing in `src/` sets another level, and nothing may.
 *
 * The price is that they no longer overlap. The time held is not the leg's wall time (1.27 s mean
 * on production, mostly the HTTP fetch) but the reconcile, which walks every row the source has EVER
 * held: measured ~1.8 ms a row when nothing changes and ~4 ms when writing, so ~0.25 s for the
 * mirror's 132 rows today and seconds once a source has accumulated a thousand. A writer waits for
 * whatever is queued ahead of it, where losing the deadlock cost a whole backed-off leg.
 * Uncontended, the lock is one round trip.
 *
 * ## What bounds the wait
 *
 * `statement_timeout` (15 s, `src/db/pool.ts`), which covers the whole lock statement, wait
 * included. A holder that stalls between statements is cut off sooner by
 * `idle_in_transaction_session_timeout` (10 s), which terminates its session and the lock with it; a
 * holder that keeps running statements is not bounded, but every waiter is, and it fails as an
 * ordinary source error — rolled back, `markSourceError` — instead of hanging on a pool connection
 * forever. A waiter that gave up wrote nothing, so it can never produce a false «Офіційний відбій».
 * What it costs differs by writer: a snapshot leg retries on its own backoff and the next pass
 * restates the whole picture, so there the result is a late alert; a LIVE alert-channel message is
 * not retried (`src/sources/telegram.ts` logs and drops it), so its 🔴 is missed until a reconnect
 * backfill re-reads it, and its 🟢 waits for the `ALERT_CHANNEL_MAX_ALERT_SECONDS` backstop.
 */
export const ALERT_STATE_LOCK = 841005213;

/**
 * `BEGIN` plus {@link ALERT_STATE_LOCK}, in that order and with nothing in between: a row lock taken
 * before the advisory lock would be held while waiting for it, which is the inversion the lock
 * exists to remove.
 */
async function beginAlertStateTransaction(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [ALERT_STATE_LOCK]);
  } catch (error) {
    // 57014 is `query_canceled`: `statement_timeout` fired while another writer held the lock. The
    // bare message — «canceling statement due to statement timeout» — would reach `sources.last_error`
    // saying nothing about which statement, so it is named here. The caller still rolls back.
    if ((error as { code?: string }).code === '57014') {
      throw new Error(
        `alert state lock not acquired: another alert writer held it past statement_timeout (${(error as Error).message})`,
        { cause: error }
      );
    }
    throw error;
  }
}

/**
 * Recomputes the global alert period for one (location, alert type) from every source state.
 *
 * Shared by both reconciliation paths — the polled snapshot adapters and the event-driven alert
 * channel — so the two-source rule has exactly one implementation. Must run inside a transaction
 * that opened with {@link beginAlertStateTransaction} and has already written the source state it
 * is meant to observe.
 */
/**
 * One `alert.started` row, as its writer saw it — the two instants the propagation metric is the
 * difference between.
 *
 * Reported rather than observed in place because both are true only after the COMMIT: a metric
 * recorded inside the transaction would count an alert that was rolled back, and a poke raised
 * inside it would send the hub to read a row it cannot see yet.
 */
export interface AlertStartRecord {
  alertId: string;
  locationId: string;
  /**
   * `min(provider_started_at)` over the source rows that hold this alert — i.e. the moment the
   * UPSTREAM says the alert began, which for the mirror is the `changed`/`lastUpdate` stamp its
   * payload carries and for an alert channel is the Telegram publication time. `null` when no source
   * offered one and the period was stamped `now()`; there is then nothing to measure.
   */
  upstreamStartedAt: Date | null;
  /** `system_event_log.created_at` of the row just appended — our publication instant. */
  publishedAt: Date;
}

async function reconcileAggregateAlert(
  client: PoolClient, locationId: string, alertType: string, sourceId: string
): Promise<AlertStartRecord | null> {
  // A source still holds the alert while it reports it, and for ALERT_END_DEBOUNCE_SECONDS after
  // it stops: one missed poll must never produce an "Офіційний відбій". The two-source rule is
  // unchanged — bool_or still means "no configured source holds it any more".
  //
  // The debounce is keyed on `missing_since`, which only the snapshot path ever sets. A source that
  // publishes an explicit all-clear leaves it NULL, so its rows drop out of the aggregate the moment
  // the all-clear lands: the window is for sources that go quiet, not for sources that speak.
  // ## Why a source also has to be ALIVE to hold an alert
  //
  // The debounce above is one half of a pair and, until 2026-08-12, the only half that existed. It
  // answers "a source went quiet for a moment" — hold the alert, one missed poll must not clear the
  // map. What nothing answered was the mirror image: how long may a source hold an alert while
  // showing no sign of life at all?
  //
  // On 2026-08-12 the MTProto collector stopped receiving updates while remaining subscribed and
  // connected. Its `alert_source_states` row for Kyiv stayed `active=true`, frozen at 09:53 UTC. The
  // HTTP mirror — an independent source polling the same executive-authority state — cleared Kyiv at
  // 11:33 UTC, correctly and on time. The map still showed an alert at 16:23, because `bool_or`
  // weighs a row nobody has touched in five hours exactly as heavily as one written a minute ago.
  //
  // So liveness is now a condition of holding. `sources.last_success_at` is the signal, and it is
  // usable for this ONLY because the collector heartbeat stopped lying in the same change: it used
  // to advance every minute on a timer regardless of whether anything was arriving, which made this
  // column true by construction. See `TELEGRAM_SILENCE_ALERT_SECONDS` in `src/sources/telegram.ts`.
  //
  // NOT `alert_source_states.last_seen_at`, which would look like the obvious choice and is a trap:
  // for an event-driven channel that column only moves when a message about THIS location arrives,
  // so a genuine hours-long alert nobody has posted about since it began carries a stale value.
  // Expiring on it would manufacture false all-clears on exactly the alerts that matter most.
  //
  // ## The condition that makes this safe: `any_alive`
  //
  // A dead row is discounted ONLY while some other source for the same location is alive. When
  // every source has fallen silent — a database outage, a network partition, the whole process
  // restarting, a test harness that resets `last_success_at` — the rule switches off entirely and
  // the aggregate falls back to what it always was.
  //
  // This is not caution for its own sake. The first version of this change omitted the condition,
  // and the existing alert suite answered immediately: twenty-one of twenty-six tests went red,
  // every one of them because `resetDatabase` nulls `last_success_at` and so every source looked
  // dead at once. That is the shape of the real failure too. Without `any_alive`, "we have lost
  // contact with everything" and "everyone has published an all-clear" become the same state, and
  // the map would clear itself during precisely the outage in which nobody can correct it — a
  // false "Офіційний відбій", which `CONTEXT.md` treats as the unrecoverable failure.
  //
  // With it, the rule says something much narrower and much more defensible: a source that is
  // demonstrably dead may not outvote a source that is demonstrably alive. Losing everything
  // changes nothing, which is the correct behaviour when the honest answer is "we do not know".
  //
  // `ALERT_SOURCE_LIVENESS_SECONDS` defaults to an hour — sixty times the collector heartbeat and
  // twice its own silence guard — so "dead" means comprehensively dead rather than briefly late,
  // and every discounted row increments a counter so the trade is visible rather than silent.
  // ## The API decides. Channels are the fallback, and only when there is no API at all
  //
  // An air-raid alert and its all-clear are declared from an API whenever one is reachable. A
  // Telegram channel may declare them only while EVERY alert API is unreachable.
  //
  // The two kinds of source differ in a way that decides this. An API serves a snapshot: "here is
  // the complete picture right now", a claim the next poll re-states, corrects or contradicts. A
  // channel publishes events: "an alert started in X", once, and if that sentence is missed, arrives
  // out of order, or is written in a shape the parser does not know, nothing afterwards contradicts
  // it. A missed snapshot is self-healing. A missed event is a state that stays wrong until somebody
  // notices — which is exactly what happened on 2026-08-12, when a frozen channel row held Kyiv
  // under alert for six hours while the HTTP mirror had correctly cleared it at 11:33 UTC.
  //
  // `api_available` is deliberately GLOBAL rather than per-location, and that is the whole mechanism.
  // A snapshot source that is alive and does not mention this location is not silent about it — it is
  // saying there is no alert here. Scoping the check to rows that exist for this location would
  // invert that: the moment an API cleared a location its row would go quiet, the location would
  // look API-less, and the channels would take over and re-raise what the API had just ended.
  //
  // ## What this gives up
  //
  // A channel that is right while every API is wrong can no longer correct them. That is a real
  // loss and it is the owner's explicit decision, made after watching the opposite failure: the
  // channel path is the one that can freeze undetected, and on this deployment it did.
  //
  // Note what "available" costs to satisfy: one alert API, enabled, with a success inside
  // `ALERT_SOURCE_LIVENESS_SECONDS`. If every API is down, dead or switched off, the channels take
  // over automatically and the rule below is the same one that ran before this change.
  //
  // ## Колір рахується ПОРУЧ із цією диз'юнкцією, а не всередині неї
  //
  // Усе, що вирішує «тривога є чи немає», лишається дослівно тим, чим було: `bool_or(counts AND
  // holds)`, ті самі `would_hold`, `alive`, `is_api`, той самий дебаунс. Рівень читається з тих
  // самих рядків, ПІСЛЯ того, як вони вже отримали право тримати тривогу, і тому не може зробити
  // `holds`, `counts` чи `would_hold` хибними — у виразах вище його просто немає. Рядок без
  // кольору важить рівно стільки ж, скільки важив завжди.
  const aggregate = await client.query<{
    active: boolean; started_at: Date | null;
    ignored_precedence: number; ignored_stale: number; api_available: boolean;
    declared: AlertDeclaration[] | null;
  }>(
    `WITH api AS (
       SELECT EXISTS (
         SELECT 1 FROM sources
          WHERE adapter_type = ANY($5::text[]) AND enabled
            AND last_success_at > now()-($4::int * interval '1 second')
       ) AS available
     )
     SELECT bool_or(counts AND holds) AS active,
            min(provider_started_at) FILTER (WHERE counts AND holds) AS started_at,
            -- Two different reasons a row was not allowed to hold, kept apart because they mean
            -- opposite things to whoever reads the metric: precedence is the rule working as
            -- designed and is expected whenever a channel and an API disagree, while stale means a
            -- source has gone dead and is the signal that something needs fixing.
            count(*) FILTER (WHERE NOT counts AND would_hold)::int AS ignored_precedence,
            count(*) FILTER (WHERE counts AND would_hold AND NOT holds)::int AS ignored_stale,
            bool_or(api_available) AS api_available,
            -- Колір і різновид рівно тих рядків, що ТРИМАЮТЬ тривогу. Правило «найсильніший
            -- перемагає» рахується в TypeScript (strongestDeclaredAlert), а не тут: воно має одну
            -- реалізацію на три згортки й перевіряється без бази. Масив обмежений числом джерел на
            -- пару (location, alert_type) — одиниці, не тисячі.
            --
            -- Фільтр по alert_level IS NOT NULL навмисний: різновид без кольору — це форма, якої
            -- жоден фід не віддає, і брати його означало б підписати тривогу «ракетна», якої ніхто
            -- не називав червоною чи жовтою.
            json_agg(json_build_object('level',alert_level,'kind',alert_kind))
              FILTER (WHERE counts AND holds AND alert_level IS NOT NULL) AS declared
     FROM (
       SELECT would_hold, provider_started_at, api_available, alert_level, alert_kind,
              -- Which rows are allowed a vote at all: API rows when an API is reachable, every row
              -- otherwise. A row that is not counted cannot hold the alert and cannot end it.
              CASE WHEN api_available THEN is_api ELSE true END AS counts,
              -- Liveness still applies inside whichever set is voting: a dead row may not outvote a
              -- live one, and when nothing is alive the aggregate keeps what it had.
              CASE WHEN bool_or(alive) FILTER (WHERE CASE WHEN api_available THEN is_api ELSE true END)
                        OVER () THEN would_hold AND alive ELSE would_hold END AS holds
       FROM (
         SELECT a.active OR COALESCE(a.missing_since > now()-($3::int * interval '1 second'),false)
                  AS would_hold,
                COALESCE(s.last_success_at > now()-($4::int * interval '1 second'),false) AS alive,
                s.adapter_type = ANY($5::text[]) AS is_api,
                a.provider_started_at, a.alert_level, a.alert_kind,
                (SELECT available FROM api) AS api_available
         FROM alert_source_states a JOIN sources s ON s.id=a.source_id
         WHERE a.location_id=$1 AND a.alert_type=$2
       ) row_state
     ) source_state`,
    [locationId, alertType, config.ALERT_END_DEBOUNCE_SECONDS, config.ALERT_SOURCE_LIVENESS_SECONDS,
      [...ALERT_API_ADAPTER_TYPES]]
  );
  const row = aggregate.rows[0];
  const ignoredStale = row?.ignored_stale ?? 0;
  const ignoredPrecedence = row?.ignored_precedence ?? 0;
  // Counted by REASON only — see the counter's declaration for why the location id may not be a
  // label. Which locations are affected is a question `alert_source_states` answers exactly.
  if (ignoredStale > 0) alertStaleSourcesIgnored.inc({ reason: 'stale' }, ignoredStale);
  if (ignoredPrecedence > 0) alertStaleSourcesIgnored.inc({ reason: 'api_precedence' }, ignoredPrecedence);
  // Рівень зводиться тут, ПІСЛЯ рішення про ввімкнено/вимкнено і незалежно від нього: якщо жоден
  // рядок не тримає тривоги, масив порожній і пара — два `null`, тобто рівно те, що було до
  // диференційованого оповіщення.
  const declared = strongestDeclaredAlert(aggregate.rows[0]?.declared ?? []);
  const global = await client.query<{ id: string; alert_level: AlertLevel | null; alert_kind: AlertKind | null }>(
    `SELECT id,alert_level,alert_kind FROM alert_periods
      WHERE location_id=$1 AND alert_type=$2 AND status='active' FOR UPDATE`,
    [locationId, alertType]
  );
  if (aggregate.rows[0]?.active && !global.rowCount) {
    // `alert_periods` is unique on (location_id, alert_type, started_at). A provider that really
    // did end an alert and then re-lists it with the identical start timestamp used to collide
    // here and roll back the entire snapshot — every other location in the same poll included.
    // The conflict reopens that period instead: the alert is visible on the map either way, so
    // the unique index can never hide an active alert or discard a snapshot. Nothing is returned
    // only when the period is already active. That used to happen when two adapters reconciled the
    // same location concurrently; `ALERT_STATE_LOCK` now serialises them, so the guard is a second
    // line rather than the one that runs, and the transaction that reopened it still emits the event.
    //
    // `published_at` is refreshed here and nowhere else on this branch — but ONLY when the period
    // had genuinely stopped being public first. A period whose `ended_at` is younger than the
    // longest possible hold was still being served a millisecond ago by branch 2 of
    // `activeAlerts()` (`status='ended' AND published_at <= cutoff AND ended_at > cutoff`), so
    // stamping a fresh `published_at` on it satisfies NEITHER branch — the row is `'active'` with a
    // `published_at` newer than the cutoff — and the red oblast polygon disappears from the public
    // map for the rest of the hold. That is a retraction of an already-published official alert
    // caused by nothing but a provider flap, and `docs/ARCHITECTURE.md` §Consistency rules calls
    // that direction unrecoverable.
    //
    // Keeping the old value in that case cannot publish anything early: the row was already public
    // at that instant, which is exactly the condition being tested. A gap LONGER than the hold is a
    // genuinely new public fact — the all-clear had already been released — and still gets a fresh
    // timestamp, so a reopened alert can never look older than the cutoff it should be held behind.
    //
    // `config.PUBLICATION_DELAY_SECONDS` and not the mode in force: the bound is the widest window
    // in which `activeAlerts` could still have been serving the row, and in `live` mode the cutoff
    // is `now()` so `published_at <= cutoff` holds either way and the branch is unobservable.
    const created = await client.query<{ id: string }>(
      `INSERT INTO alert_periods(location_id,alert_type,status,started_at,external_id,alert_level,alert_kind)
       VALUES ($1,$2,'active',COALESCE($3,now()),$4,$6,$7)
       ON CONFLICT (location_id,alert_type,started_at) DO UPDATE
         SET status='active',ended_at=NULL,updated_at=now(),
             -- Перевідкриття — це новий публічний факт, тож колір береться поточний, а
             -- alert_level_changed_at обнуляється: заміни ще не було, перший колір заміною не є.
             alert_level=EXCLUDED.alert_level,alert_kind=EXCLUDED.alert_kind,
             alert_level_changed_at=NULL,
             published_at = CASE
               WHEN alert_periods.ended_at > now() - make_interval(secs => $5::int)
                 THEN alert_periods.published_at
               ELSE now() END
         WHERE alert_periods.status<>'active'
       RETURNING id`,
      [locationId, alertType, aggregate.rows[0].started_at, `aggregate:${locationId}:${alertType}:${Date.now()}`,
        config.PUBLICATION_DELAY_SECONDS, declared.level, declared.kind]
    );
    if (created.rowCount) {
      // `RETURNING created_at` rather than a second read or a `Date.now()`: this column IS the
      // instant every downstream bound is measured from — the hub's head query, the publication
      // cutoff and `threatlens_sse_delivery_lag_seconds` all read it — so taking the propagation
      // metric from anything else would produce two numbers that do not compose.
      const logged = await client.query<{ created_at: Date }>(
        `INSERT INTO system_event_log(event_type,payload) VALUES ('alert.started',$1) RETURNING created_at`,
        // `level`/`kind` їдуть у корисному навантаженні поруч із `alertId`, а не замість чогось.
        // Читач події має право знати колір одразу; актуальнішою правдою лишається рядок періоду —
        // на момент розсилки колір міг уже ЗМІНИТИСЯ, і подія про це не знає й не мусить.
        [JSON.stringify({
          alertId: created.rows[0]!.id, locationId, sourceId,
          level: declared.level, kind: declared.kind
        })]
      );
      return {
        alertId: created.rows[0]!.id,
        locationId,
        upstreamStartedAt: aggregate.rows[0].started_at,
        publishedAt: logged.rows[0]!.created_at
      };
    }
  } else if (!aggregate.rows[0]?.active && global.rowCount) {
    const ended = await client.query<{ id: string }>(
      `UPDATE alert_periods SET status='ended',ended_at=now(),updated_at=now()
       WHERE id=ANY($1::uuid[]) RETURNING id`, [global.rows.map((row) => row.id)]
    );
    for (const row of ended.rows) {
      await client.query(`INSERT INTO system_event_log(event_type,payload) VALUES ('alert.ended',$1)`,
        [JSON.stringify({ alertId: row.id, locationId, sourceId })]);
    }
  } else if (aggregate.rows[0]?.active && global.rowCount) {
    // ## Зміна кольору всередині тієї самої тривоги
    //
    // Єдина гілка, якої тут не було. Період ЖИВИЙ і лишається живим: жодного INSERT, жодного
    // `status`, жодного `ended_at`, `started_at` не рухається. Це UPDATE прикмет — і рівно тому
    // читач не отримує ні другого «🔴 Повітряна тривога», ні відбою, якого не було.
    //
    // Умова гілки — `active AND rowCount`, тобто «зведення каже ввімкнено, і період уже
    // ввімкнений». На періоді, якого немає або який завершено, колір не з'являється ніколи: перша
    // гілка створює період уже з кольором, друга завершує його не чіпаючи кольору, а сюди
    // неактивний період просто не потрапляє.
    //
    // `WHERE` у самому UPDATE — не оптимізація, а друга половина умови: між читанням і записом
    // усередині цієї ж транзакції рядок заблоковано `FOR UPDATE`, але предикат робить «пишемо лише
    // те, що справді інше» властивістю запиту, а не послідовності дій навколо нього. Нуль рядків —
    // нормальна відповідь, і тоді події немає.
    const current = global.rows[0]!;
    if (current.alert_level !== declared.level || current.alert_kind !== declared.kind) {
      const changed = await client.query<{ alert_level_changed_at: Date }>(
        `UPDATE alert_periods
            SET alert_level=$2,alert_kind=$3,alert_level_changed_at=now(),updated_at=now()
          WHERE id=$1 AND status='active'
            AND (alert_level IS DISTINCT FROM $2 OR alert_kind IS DISTINCT FROM $3)
          RETURNING alert_level_changed_at`,
        [current.id, declared.level, declared.kind]
      );
      if (changed.rowCount) {
        // У ТІЙ САМІЙ транзакції, що й UPDATE: рядок періоду й подія про його зміну не мають права
        // розійтися навіть на мить — читач, який побачив би подію без рядка, підписав би зміну
        // кольору, якої в таблиці немає.
        //
        // `previousLevel`/`previousKind` — те, що стояло ДО заміни, бо саме різниця й є змістом
        // повідомлення: «було жовте, стало червоне». Без них читачеві довелося б згадувати, що йому
        // казали, а `alert.started` він міг і не бачити.
        await client.query(
          `INSERT INTO system_event_log(event_type,payload) VALUES ('alert.level_changed',$1)`,
          [JSON.stringify({
            alertPeriodId: current.id,
            locationId,
            level: declared.level,
            previousLevel: current.alert_level,
            kind: declared.kind,
            previousKind: current.alert_kind,
            changedAt: changed.rows[0]!.alert_level_changed_at.toISOString()
          })]
        );
      }
    }
  }
  // Ends deliberately report nothing. They are not poked and not measured: the asymmetry — starts
  // fast, ends unhurried — is the product decision this whole path implements, and it is the same
  // direction `ALERT_END_DEBOUNCE_SECONDS` already takes. See `src/services/alert-poke.ts`.
  return null;
}

/**
 * What a committed reconcile pass owes the rest of the process: one metric per start, and at most
 * one poke for the batch.
 *
 * Both callers of `reconcileAggregateAlert` funnel through here so the "after COMMIT, never inside"
 * rule has one implementation rather than two that drift. Nothing here can throw into a caller that
 * has already committed: `observeAlertPropagation` is total, and `pokeAlertStarted` only arms a
 * timer.
 */
function announceAlertStarts(sourceId: string, started: readonly AlertStartRecord[]): void {
  if (!started.length) return;
  for (const record of started) {
    observeAlertPropagation(sourceId, record.publishedAt, record.upstreamStartedAt);
  }
  // ONE poke for the whole transaction, however many oblasts it raised. Bound 1 of the three in
  // `src/services/alert-poke.ts`.
  pokeAlertStarted();
}

/** Колір і різновид, як їх назвало одне джерело про одну локацію. */
export interface AlertDeclaration {
  level: AlertLevel | null;
  kind: AlertKind | null;
}

/**
 * Правило «найсильніший перемагає», в одному екземплярі на всі три згортки.
 *
 * Колір — найсильніший із названих (`red` > `yellow` > не назвали): обережність тут дорожча за
 * консенсус, бо ціна заниженого кольору — людина, яка не пішла в укриття, а ціна завищеного —
 * людина, яка пішла даремно. `CONTEXT.md`, «Межі безпеки».
 *
 * Різновид — того рядка, чий колір переміг, і ЛИШЕ якщо на цьому кольорі він один. Двоє кажуть
 * `drones` і `missiles` на червоному — різновид `null`, а не `drones_missiles`: «і те, і те» — це
 * твердження, яке мусить зробити джерело, а не ми за нього. Рядки того рівня, що мовчать про
 * різновид, не сперечаються ні з ким: мовчання — не третя думка.
 *
 * Порожній вхід дає пару з двох `null`, тобто «звичайна тривога», яка показується точно так, як
 * показувалася завжди.
 */
export function strongestDeclaredAlert(declarations: readonly AlertDeclaration[]): AlertDeclaration {
  let level: AlertLevel | null = null;
  for (const declaration of declarations) level = strongerAlertLevel(level, declaration.level);
  let kind: AlertKind | null = null;
  for (const declaration of declarations) {
    if (declaration.level !== level || declaration.kind === null) continue;
    if (kind !== null && kind !== declaration.kind) return { level, kind: null };
    kind = declaration.kind;
  }
  return { level, kind };
}

/**
 * Folds provider rows that turned out to name the same catalogue row.
 *
 * `alert_source_states` is unique on `(source_id, location_id, alert_type)`, so duplicates were
 * never a correctness problem at rest — the upsert simply let the last write win. They became a
 * *meaning* problem when the aerial mirror moved to raion and hromada granularity, because the
 * catalogue is three-tier and folds a hromada into its raion: on one live poll «Чугуївський район»
 * and «Вовчанська територіальна громада» were both alight, and both are `katottg-ua63140…`. Last
 * write wins then makes `provider_started_at` depend on the order the upstream happened to list two
 * labels in, and the period's start time is what the timeline and the monthly analytics read.
 *
 * The fold is: a location holds if ANY row holding it says so, and it started at the EARLIEST start
 * among the rows that hold it. Both halves are the over-warning direction, which is the one this
 * project takes deliberately. When nothing holds, the earliest start still wins so an inactive row
 * carries a stable timestamp rather than a coin flip.
 *
 * Колір складається тим самим «найсильніший перемагає», що й у зведенні: дві мітки, які впали в
 * один рядок каталогу, не мають права ПОСЛАБИТИ одна одну — червоний район, згорнутий у ту саму
 * локацію, що й жовта громада, лишає локацію червоною. Різновид береться того боку, чий колір
 * переміг; при однаковому кольорі й РІЗНИХ різновидах — `null`, бо вигадувати різновид, якого ніхто
 * не оголошував, ця система не має права.
 *
 * Applies to every snapshot source, not only the mirror. The two APIs have never been observed to
 * emit two labels for one location, so for them this is a no-op that removes a latent nondeterminism.
 */
function dedupeResolvedRecords<T extends AlarmRecord & { locationId: string }>(records: T[]): T[] {
  const byLocation = new Map<string, T>();
  for (const record of records) {
    const key = `${record.locationId}:${record.alertType}`;
    const existing = byLocation.get(key);
    if (!existing) { byLocation.set(key, record); continue; }
    const winner = existing.active === record.active
      ? (record.startedAt < existing.startedAt ? record : existing)
      : (record.active ? record : existing);
    const declared = strongestDeclaredAlert([
      { level: existing.alertLevel, kind: existing.alertKind },
      { level: record.alertLevel, kind: record.alertKind }
    ]);
    byLocation.set(key, {
      ...winner,
      active: existing.active || record.active,
      startedAt: winner.startedAt,
      alertLevel: declared.level,
      alertKind: declared.kind
    });
  }
  return [...byLocation.values()];
}

async function persistOfficialAlertSnapshot(sourceId: string, body: unknown): Promise<{ resolved: number; unresolved: string[] }> {
  const normalized = normalizeAlarmResponse(body);
  if (normalized.candidateCount > 0 && normalized.records.length === 0) {
    throw new Error(`${sourceId}: response contained alerts but none could be normalized`);
  }
  // Ворота типу стоять ПЕРЕД пошуком локації, а не після: інакше прифронтова громада, яку ми все
  // одно не запишемо, з'їдала б запит до каталогу на кожному опитуванні (шість рядків × 8.6 раза на
  // хвилину) і, що гірше, потрапляла б у `unresolved` — тобто в лог «не знайшли місце» про рядок,
  // місце якого нас не цікавить.
  const airRaid: AlarmRecord[] = [];
  const droppedByType = new Map<string, number>();
  for (const record of normalized.records) {
    if (record.alertType === INGESTED_ALERT_TYPE) airRaid.push(record);
    else droppedByType.set(record.alertType, (droppedByType.get(record.alertType) ?? 0) + 1);
  }
  for (const [alertType, count] of droppedByType) countDroppedAlarmRecords(sourceId, alertType, count);
  const resolved: Array<AlarmRecord & { locationId: string }> = [];
  const unresolved: string[] = [];
  for (const record of airRaid) {
    const locationId = await resolveLocationId({
      locationKey: record.locationKey,
      locationName: record.locationName,
      ...(record.parentName ? { parentName: record.parentName } : {})
    });
    if (locationId) resolved.push({ ...record, locationId });
    else unresolved.push(record.locationName || record.locationKey);
  }
  // «Прийшли тривоги, і жодна не лягла на каталог» — це зламане читання, і воно має бути помилкою
  // джерела, а не тихим нулем. Рахується від ВІДФІЛЬТРОВАНИХ рядків: відповідь, у якій були самі
  // обстріли, нічого не втратила й падати не повинна.
  if (airRaid.length > 0 && resolved.length === 0) {
    throw new Error(`${sourceId}: no provider locations matched local locations (${unresolved.slice(0, 5).join(', ')})`);
  }
  const deduped = dedupeResolvedRecords(resolved);
  await runSnapshotPass(sourceId, deduped);
  // Distinct catalogue rows written, not provider labels read: after the fold above those are no
  // longer the same number.
  return { resolved: deduped.length, unresolved };
}

/** One `alert_source_states` row as the snapshot pass needs to see it before deciding to write. */
interface StoredSourceState {
  location_id: string;
  alert_type: string;
  active: boolean;
  provider_started_at: Date | null;
  external_id: string | null;
  alert_level: AlertLevel | null;
  alert_kind: AlertKind | null;
}

/**
 * Whether the blanket clear and the upserts would leave every row exactly as it already is.
 *
 * Deliberately unforgiving: any row the snapshot names that is missing, any field that differs by so
 * much as a millisecond, any row the snapshot omits that is still active — and the answer is no and
 * the full pass runs. The cost of a false «no» is one wasted pass; the cost of a false «yes» is a
 * row that silently stops tracking its provider.
 *
 * ## Чому колір тут ОБОВ'ЯЗКОВО мусить порівнюватися
 *
 * Це не повнота заради повноти, а єдиний спосіб, яким зміна рівня взагалі може бути помічена.
 * Перехід жовтий→червоний усередині тієї самої тривоги не змінює НІЧОГО з того, що ця функція
 * порівнювала раніше: район той самий, `active` той самий `true`, `provider_started_at` той самий —
 * тривога ж не починалася заново, — і `external_id` теж, бо будується з назви, типу й старту.
 * Знімок із червоним виглядав би як точна копія знімка з жовтим, запис не відбувся б, у рядку
 * джерела лишився б жовтий, зведення прочитало б жовтий — і читач ніколи не дізнався б про
 * посилення. Відмова тиха: жодної помилки, жодної метрики, просто колір, який не рухається.
 */
function snapshotWritesAreNoop(
  stored: StoredSourceState[], records: Array<AlarmRecord & { locationId: string }>
): boolean {
  const byKey = new Map(stored.map((row) => [`${row.location_id}:${row.alert_type}`, row]));
  for (const record of records) {
    const row = byKey.get(`${record.locationId}:${record.alertType}`);
    if (!row) return false;
    if (row.active !== record.active) return false;
    if (row.provider_started_at?.getTime() !== record.startedAt.getTime()) return false;
    if (row.external_id !== record.externalId) return false;
    if (row.alert_level !== record.alertLevel) return false;
    if (row.alert_kind !== record.alertKind) return false;
    byKey.delete(`${record.locationId}:${record.alertType}`);
  }
  // Whatever the snapshot did not name must already be inactive, or the blanket clear would stamp a
  // fresh `missing_since` on it and start its debounce — the opposite of a no-op.
  for (const row of byKey.values()) if (row.active) return false;
  return true;
}

/**
 * The snapshot transaction: rewrite what this source holds, then recompute every aggregate it can
 * affect.
 *
 * ## Why the writes are conditional and the reconcile is not
 *
 * The first half is a blanket clear plus one upsert per reported row — for the granular mirror feed
 * that is one UPDATE over every row the source has ever held plus fifty-odd upserts, fifteen times a
 * minute, forever. Most of those passes write nothing new: the feed re-lists the same raions, and
 * the upstream extract behind it only refreshes every eleven seconds, so at a four-second poll two
 * passes in three restate a picture already in the table.
 *
 * So the pass asks the table first. The rows this source holds are already read here — the
 * reconcile needs every one of them — and reading three more columns with them is free. If every
 * reported row already stands in the table with the same `active`, `provider_started_at` and
 * `external_id`, and every row NOT reported is already inactive, then the blanket clear and the
 * upserts would each write a row back to the value it already had, and the only columns that would
 * differ afterwards are `last_seen_at`/`updated_at` — which nothing reads. The liveness rule in
 * `reconcileAggregateAlert` reads `sources.last_success_at` precisely BECAUSE
 * `alert_source_states.last_seen_at` is the wrong signal for it; see the comment there.
 *
 * Comparing STATE rather than the response bytes is what makes this safe to hold as a fact. A digest
 * of the body would be a claim about a previous run of this process, and it would go on being
 * believed after a restore, a manual `DELETE`, or a truncated table. This claim is read out of the
 * same transaction that acts on it: if anything has moved the rows, the comparison fails and the
 * full pass runs. It is also strictly more effective, because the mirror's body changes its
 * `cachedat` on every refresh while saying exactly the same thing about the country.
 *
 * What is NEVER skipped is the reconcile. The aggregate is time-dependent: a row that went missing
 * three polls ago holds its alert until `ALERT_END_DEBOUNCE_SECONDS` elapses, and the pass that
 * notices the deadline has passed is this one. A feed can report the same picture for hours — an
 * empty raw payload on a quiet night reports it by definition — so tying the reconcile to a change
 * in the feed would leave `alert_periods` rows open until the country next changed state. An
 * «Офіційний відбій» that arrives late is the safe direction; one that never arrives is not.
 */
async function runSnapshotPass(
  sourceId: string, records: Array<AlarmRecord & { locationId: string }>
): Promise<void> {
  const client = await pool.connect();
  try {
    await beginAlertStateTransaction(client);
    const affected = await client.query<StoredSourceState>(
      `SELECT location_id,alert_type,active,provider_started_at,external_id,alert_level,alert_kind
         FROM alert_source_states WHERE source_id=$1`,
      [sourceId]
    );
    const affectedKeys = new Set(affected.rows.map((row) => `${row.location_id}:${row.alert_type}`));
    if (!snapshotWritesAreNoop(affected.rows, records)) {
      // Everything this source held is provisionally missing. `missing_since` is stamped only on the
      // poll where a *holding* row goes quiet, so repeated absences never push the deadline forward,
      // and a row that was already inactive is not made to look freshly missing.
      //
      // Колір тут НЕ гаситься, і це навмисно: поки рядок у вікні дебаунсу, він усе ще ТРИМАЄ
      // тривогу, а тримає він її тим кольором, який назвав востаннє. Занулити колір разом із
      // `active` означало б, що джерело, яке пропустило одне опитування, мовчки знижує червоний до
      // «без кольору», не припиняючи при цьому тримати тривогу. Коли воно перестане тримати,
      // зведення перестане його читати — фільтр `counts AND holds` і є тим вимикачем.
      await client.query(
        `UPDATE alert_source_states
           SET active=false,missing_since=CASE WHEN active THEN now() ELSE missing_since END,
               last_seen_at=now(),updated_at=now()
         WHERE source_id=$1`,
        [sourceId]
      );
      for (const record of records) {
        affectedKeys.add(`${record.locationId}:${record.alertType}`);
        await client.query(
          `INSERT INTO alert_source_states(source_id,location_id,alert_type,active,provider_started_at,
             external_id,alert_level,alert_kind)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (source_id,location_id,alert_type) DO UPDATE SET
             active=EXCLUDED.active,provider_started_at=EXCLUDED.provider_started_at,
             external_id=EXCLUDED.external_id,
             -- Колір ЗАМІНЮЄТЬСЯ тим, що джерело сказало зараз, включно з «нічого»: знявши колір,
             -- джерело знімає його, а не лишає вчорашній. Тотожності рядка це не чіпає — ключ
             -- конфлікту той самий (source_id, location_id, alert_type), і зміна кольору не може
             -- створити другого рядка.
             alert_level=EXCLUDED.alert_level,alert_kind=EXCLUDED.alert_kind,
             missing_since=CASE WHEN EXCLUDED.active THEN NULL ELSE alert_source_states.missing_since END,
             last_seen_at=now(),updated_at=now()`,
          [sourceId, record.locationId, record.alertType, record.active, record.startedAt,
            record.externalId, record.alertLevel, record.alertKind]
        );
      }
    }
    const started: AlertStartRecord[] = [];
    for (const key of affectedKeys) {
      const [locationId, alertType] = key.split(':');
      const record = await reconcileAggregateAlert(client, locationId!, alertType!, sourceId);
      if (record) started.push(record);
    }
    await client.query('COMMIT');
    announceAlertStarts(sourceId, started);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function syncOfficialAlerts(log?: { warn: Function }): Promise<void> {
  if (!config.UKRAINE_ALARM_API_TOKEN) return;
  if (!await sourceCollectionEnabled('ukraine-alarm')) return;
  try {
    const response = await fetch(config.UKRAINE_ALARM_API_URL, {
      headers: { Authorization: config.UKRAINE_ALARM_API_TOKEN, Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok) throw new Error(`Ukraine Alarm API ${response.status}`);
    const snapshot = await persistOfficialAlertSnapshot('ukraine-alarm', await response.json());
    await markSourceSuccess('ukraine-alarm');
    recordUnresolvedLocations('ukraine-alarm', snapshot.unresolved, log);
  } catch (error) {
    await markSourceError('ukraine-alarm', error);
    countChannelError('ukraine-alarm', 'collect');
    throw error;
  }
}

export async function syncAlertsInUa(log?: { warn: Function }): Promise<void> {
  if (!config.ALERTS_IN_UA_TOKEN) return;
  if (!await sourceCollectionEnabled('alerts-in-ua')) return;
  try {
    const response = await fetch(config.ALERTS_IN_UA_URL, {
      headers: { Authorization: `Bearer ${config.ALERTS_IN_UA_TOKEN}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000)
    });
    if (!response.ok) throw new Error(`Alerts.in.ua API ${response.status}`);
    const snapshot = await persistOfficialAlertSnapshot('alerts-in-ua', await response.json());
    await markSourceSuccess('alerts-in-ua');
    recordUnresolvedLocations('alerts-in-ua', snapshot.unresolved, log);
  } catch (error) {
    await markSourceError('alerts-in-ua', error);
    countChannelError('alerts-in-ua', 'collect');
    throw error;
  }
}

/**
 * The community aerial-alert mirror — the one official-family snapshot source that needs no token.
 *
 * Structurally identical to the two adapters above: fetch, normalize, hand the whole national
 * picture to `persistOfficialAlertSnapshot`, let the aggregate decide. One thing is different, and
 * it is the reason this function exists rather than a third `config.*_URL` on the generic path.
 *
 * ## The mirror may not clear the map on the strength of a response we do not believe
 *
 * `persistOfficialAlertSnapshot` clears everything the source holds before re-raising what the
 * response reports. For an API that answers "here is the country, right now" that is correct. For a
 * third-party republication it is correct only while the republication is *live*, and a mirror has a
 * failure mode the APIs do not: it can keep answering 200 with a well-formed body long after the
 * process feeding it has stopped. Every region then reads `alertnow: false`, the snapshot is
 * structurally perfect, and running it would publish «Офіційний відбій» for the entire country
 * during an attack. That is the direction docs/ARCHITECTURE.md §Consistency rules calls
 * unrecoverable.
 *
 * `parseAerialMirrorPayload` is therefore called BEFORE anything is persisted and throws on a
 * `cachedat` older than `AERIAL_MIRROR_STALE_SECONDS`. The throw lands in the catch below, becomes
 * `markSourceError`, and `alert_source_states` is never opened — so a frozen mirror holds its alerts
 * instead of clearing them, and the operator sees an unhealthy source rather than a quiet map.
 *
 * The accepted cost of that choice, stated plainly because docs/OPERATIONS.md has to answer for it:
 * a mirror that freezes while holding alerts holds them until it recovers. There is no sweeper for
 * this source — `expireStuckAlertChannelAlerts` is scoped to `mtproto_alert_channel` rows — so an
 * over-warning map is the deliberate failure direction, and releasing a permanently dead mirror's
 * holds is a documented operator action.
 *
 * What this cannot catch: a mirror serving stale *alert state* under a fresh `cachedat`. Nothing in
 * the payload distinguishes that from a genuinely quiet country, and the debounce plus the two-source
 * aggregate are the only defences left. It is the strongest argument for not running the mirror as
 * the sole alert source.
 *
 * ## Two feeds, and the rule for choosing between them
 *
 * See `collectAerialMirrorSnapshot`. Nothing about the paragraphs above changes: whichever feed is
 * read, the result reaches `persistOfficialAlertSnapshot` only after a parser has accepted it, and
 * every refusal on every path is a throw into the catch below.
 */
export async function syncAerialMirror(log?: { warn: Function }): Promise<void> {
  if (!config.AERIAL_MIRROR_ENABLED) return;
  if (!await sourceCollectionEnabled(AERIAL_MIRROR_SOURCE_ID)) return;
  const name = config.AERIAL_MIRROR_RAW_SOURCE.trim();
  try {
    if (!name) {
      // Задокументований відступ оператора: жодної деталізації, самі області з агрегованого фіда.
      // Він лишається, бо саме сюди відходять, коли апстрім переробить своє тіло, — але типовим уже
      // не є, і в ньому оператор СВІДОМО приймає обласні згортки. Прапорця рівня в цих записах немає,
      // тож перевірка `toAlarmSnapshotBody` їх і не стосується: вона про фіди, у яких поруч із
      // областю є райони, які їй суперечать.
      aerialMirrorPolls.inc({ mode: 'unified_only' });
      const snapshot = parseAerialMirrorPayload(
        await fetchAerialMirror(config.AERIAL_MIRROR_URL), new Date(), config.AERIAL_MIRROR_STALE_SECONDS
      );
      observeSourceCacheAge(AERIAL_MIRROR_SOURCE_ID, 'aggregated', snapshot.ageSeconds);
      const persistedOblasts = await persistOfficialAlertSnapshot(
        AERIAL_MIRROR_SOURCE_ID, toAlarmSnapshotBody(snapshot)
      );
      await markSourceSuccess(AERIAL_MIRROR_SOURCE_ID);
      recordUnresolvedLocations(AERIAL_MIRROR_SOURCE_ID, persistedOblasts.unresolved, log);
      return;
    }
    const upstream = aerialMirrorUpstream(name);
    if (!upstream) throw new Error(`unknown aerial mirror upstream: ${name}`);
    const snapshot = await collectAerialMirrorSnapshot(upstream, new Date(), log);
    aerialMirrorDroppedOblasts.set(snapshot.droppedRollupOblasts);
    const persisted = await persistOfficialAlertSnapshot(
      AERIAL_MIRROR_SOURCE_ID, toAlarmSnapshotBody(snapshot, upstream.oblastLayer)
    );
    await markSourceSuccess(AERIAL_MIRROR_SOURCE_ID);
    recordUnresolvedLocations(AERIAL_MIRROR_SOURCE_ID, persisted.unresolved, log);
  } catch (error) {
    await markSourceError(AERIAL_MIRROR_SOURCE_ID, error);
    countChannelError(AERIAL_MIRROR_SOURCE_ID, 'collect');
    throw error;
  }
}

/**
 * Друге джерело того самого дзеркала: фід, чий рівень області є оголошенням влади.
 *
 * Окремим джерелом, а не другим фідом у знімку вище, з причини, написаної біля
 * {@link AERIAL_MIRROR_STATE_SOURCE_ID}: знімок гасить усе, чого в ньому немає, тож два фіди в
 * одному знімку означали б, що збій одного гасить те, що тримає другий. Тут кожен відповідає лише
 * за себе, а зведення обʼєднує їх тим самим `bool_or` із дебаунсом і перевіркою живості.
 *
 * Цей фід не має громад — і саме тому він не заміняє фід деталізації, а доповнює його: у зрізі
 * 19.08.2026 він не знав про повітряну тривогу для Нікопольської та Марганецької громад.
 */
export async function syncAerialMirrorState(log?: { warn: Function }): Promise<void> {
  if (!config.AERIAL_MIRROR_ENABLED) return;
  const upstream = aerialMirrorUpstream(config.AERIAL_MIRROR_STATE_SOURCE);
  if (!upstream) return;
  if (!await sourceCollectionEnabled(AERIAL_MIRROR_STATE_SOURCE_ID)) return;
  try {
    const now = new Date();
    const snapshot = upstream.parse(
      await fetchAerialMirror(aerialMirrorRawUrl(config.AERIAL_MIRROR_URL, config.AERIAL_MIRROR_STATE_SOURCE)),
      now, config.AERIAL_MIRROR_STALE_SECONDS
    );
    observeSourceCacheAge(AERIAL_MIRROR_STATE_SOURCE_ID, 'state', snapshot.ageSeconds);
    aerialMirrorPolls.inc({ mode: 'state' });
    // Типово саме цей фід (`klimenko`) — єдиний, який несе колір, тож здебільшого числа метрики
    // приходять звідси. Виставляється на кожному придатному опитуванні: рухоме число і є доказом
    // того, що колір досі надходить.
    recordReportedAlertLevels(AERIAL_MIRROR_STATE_SOURCE_ID, snapshot.byThreatLevel);
    // Порожній знімок цього фіда — це «жодна область не оголошена цілою», і це нормальний стан
    // країни: постійні Луганщина й Крим є завжди, тож нуль записів тут означав би, що фід зламався.
    // `persistOfficialAlertSnapshot` сам відмовиться від тіла, у якому нічого не розпізналося.
    const persisted = await persistOfficialAlertSnapshot(
      AERIAL_MIRROR_STATE_SOURCE_ID, toAlarmSnapshotBody(snapshot, upstream.oblastLayer)
    );
    await markSourceSuccess(AERIAL_MIRROR_STATE_SOURCE_ID);
    recordUnresolvedLocations(AERIAL_MIRROR_STATE_SOURCE_ID, persisted.unresolved, log);
  } catch (error) {
    aerialMirrorPolls.inc({ mode: 'state_unusable' });
    await markSourceError(AERIAL_MIRROR_STATE_SOURCE_ID, error);
    countChannelError(AERIAL_MIRROR_STATE_SOURCE_ID, 'collect');
    throw error;
  }
}

/**
 * Одна нога — два джерела дзеркала, послідовно й без взаємного скасування.
 *
 * `allSettled`, а не `all`: фід деталізації і фід оголошень незалежні, і збій одного не має
 * скасовувати роботу другого. Помилка все одно піднімається наверх — планувальник рахує невдачу ноги
 * й розводить наступний прохід, — але лише після того, як обидва отримали свій шанс.
 */
export async function syncAerialMirrorPair(log?: { warn: Function }): Promise<void> {
  const granular = await syncAerialMirror(log).then(() => null, (error: unknown) => error);
  if (config.AERIAL_MIRROR_STATE_SOURCE.trim() && config.AERIAL_MIRROR_REQUEST_GAP_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, config.AERIAL_MIRROR_REQUEST_GAP_MS));
  }
  const state = await syncAerialMirrorState(log).then(() => null, (error: unknown) => error);
  const failure = granular ?? state;
  if (failure) throw failure;
}

/** The database switch is checked immediately before a polled adapter touches its provider. */
async function sourceCollectionEnabled(sourceId: string): Promise<boolean> {
  const result = await pool.query<{ enabled: boolean }>(
    `SELECT enabled FROM sources WHERE id=$1`, [sourceId]
  );
  return result.rows[0]?.enabled === true;
}

/**
 * Validators and the last body each feed URL served.
 *
 * Bounded by construction: the keys are the two or three mirror URLs this process polls, and an
 * entry is replaced, never appended to.
 */
const mirrorFeedCache = new Map<string, { etag?: string; lastModified?: string; body: unknown }>();

/**
 * One GET against the mirror, conditional on what it served last time.
 *
 * ## Why conditional
 *
 * The leg polls every four seconds; the upstream `skog` extract refreshes about every eleven. Most
 * polls therefore re-downloaded and re-parsed a body identical to the one before it — the full
 * national picture, twice per pass, forever. An `If-None-Match`/`If-Modified-Since` pair turns that
 * into a 304 with no body at all: the bytes stay on the mirror's side of the wire and `JSON.parse`
 * is not called. The mirror is a free, unauthenticated community endpoint, so spending fewer of its
 * bytes is also the courteous reading of the User-Agent this adapter identifies itself with.
 *
 * ## Why a 304 is not a shortcut past the freshness gate
 *
 * «Not modified» is a statement about BYTES, never about alerts, and the body it refers to carries
 * `cachedat` — so an unchanged body is, with every second that passes, an OLDER body. The cached
 * copy is therefore returned to be re-parsed against the CURRENT instant, exactly as a freshly
 * downloaded one would be: `readCachedAt` (`src/sources/aerial-mirror.ts`) still measures its age,
 * `threatlens_source_cache_age_seconds` still records that age growing, and a mirror frozen behind a
 * stable ETag still throws `AerialMirrorStaleError` the moment it passes
 * `AERIAL_MIRROR_STALE_SECONDS`. A 304 buys a request; it does not buy belief.
 *
 * A conditional request is also never the reason a poll counts as missing: the response arrived, so
 * the poll succeeded and `markSourceSuccess` runs exactly where it ran before. What a 304 does NOT
 * do is decide whether anything is written — `runSnapshotPass` asks the table that question, because
 * an answer derived from HTTP would be a claim about this process rather than about the rows.
 */
async function fetchAerialMirror(url: string): Promise<unknown> {
  const cached = mirrorFeedCache.get(url);
  const headers: Record<string, string> = {
    Accept: 'application/json', 'User-Agent': AERIAL_MIRROR_USER_AGENT
  };
  if (cached?.etag) headers['If-None-Match'] = cached.etag;
  if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (response.status === 304 && cached) return cached.body;
  // 429 included: the published limit is two requests per second per host and this leg's worst case
  // at its three-second floor is 0.67 rps, so a 429 means something else is sharing the egress IP —
  // a source error, not a reason to touch alert state.
  if (!response.ok) throw new Error(`Aerial alert mirror ${response.status}`);
  const body = await response.json();
  // `headers` is absent on a hand-rolled response object; a feed with no validators simply never
  // gets a conditional request, which is the correct degradation rather than a reason to guess one.
  const etag = response.headers?.get('etag') ?? undefined;
  const lastModified = response.headers?.get('last-modified') ?? undefined;
  mirrorFeedCache.set(url, {
    body, ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {})
  });
  return body;
}

/**
 * Reads the mirror at the finest granularity it will give, and decides what to believe.
 *
 * The mirror serves two bodies. `?source=ual&raw` is Ukraine Alarm's own payload — `State`,
 * `District` and `Community` entries, which after resolution are oblasts, raions and (through the
 * catalogue's hromada aliases) raions again. The bare URL is the aggregator's `states` object, which
 * is twenty-five oblast rows and nothing finer. The raw feed is the primary; the aggregated one is
 * the fallback and, in one specific case, the witness.
 *
 * ## The quiet-versus-broken rule
 *
 * A raw payload that lists nothing alight is ambiguous in the worst possible way. It is what a
 * genuinely calm night looks like — and refusing it would put this source into `error` every time
 * the country was at peace, which is both wrong and would train an operator to ignore the health
 * card. It is ALSO what a half-broken upstream looks like: `cachedat` fresh, envelope intact, `raw`
 * empty because whatever fills it has stopped. Believed, that empty list clears every raion the
 * mirror was holding.
 *
 * Nothing inside the payload separates the two, so the rule reaches outside it: **when the raw feed
 * reports no air-raid region, ask the aggregated feed before believing it.**
 *
 *   - aggregated feed also reports nothing alight → the country is quiet. The empty raw snapshot is
 *     accepted and the mirror clears normally (through the end debounce, as always).
 *   - aggregated feed reports at least one oblast alight → the raw feed is not describing the
 *     present. Fall back to the aggregated body for this poll, at oblast granularity, under the same
 *     `source_id` — degraded resolution beats a wrong all-clear — and log it.
 *   - aggregated feed cannot be read either → **hold.** The throw escapes, `markSourceError` runs and
 *     `alert_source_states` is never opened. Two unreadable feeds are not evidence of peace.
 *
 * The same fallback carries a raw payload the parser REFUSED outright — stale, future, non-array,
 * unreadable entries. There the aggregated feed is a substitute rather than a witness, but the
 * ordering and the both-fail outcome are identical, so it is one path.
 *
 * ## Request budget
 *
 * The endpoint publishes two requests per second per host. The common case — the raw feed answers
 * and something is alight — is ONE request; the cross-check happens only when the raw feed found
 * nothing or was refused. The two requests are sequenced with `AERIAL_MIRROR_REQUEST_GAP_MS` between
 * them and are never issued together: during research two requests inside one second were answered
 * with a truncated body, which is the precise failure the parsers exist to refuse.
 *
 * Setting `AERIAL_MIRROR_RAW_SOURCE=''` skips the raw feed entirely and restores the original
 * oblast-only behaviour, one request per poll.
 */
async function collectAerialMirrorSnapshot(
  upstream: AerialMirrorUpstream, now: Date, log?: { warn: Function }
): Promise<AerialMirrorRawSnapshot> {
  const stale = config.AERIAL_MIRROR_STALE_SECONDS;
  const name = config.AERIAL_MIRROR_RAW_SOURCE.trim();
  // Вік того, що фід щойно віддав, — за його власним `cachedat`. Записується на КОЖНОМУ читанні:
  // різниця між фідами і є ціною деталізації, і саме вона привела до зміни типового апстріму.
  const record = <T extends AerialMirrorRawSnapshot>(feed: string, snapshot: T): T => {
    observeSourceCacheAge(AERIAL_MIRROR_SOURCE_ID, feed, snapshot.ageSeconds);
    return snapshot;
  };

  let granular: AerialMirrorRawSnapshot | null = null;
  let reason = '';
  try {
    granular = record('granular', upstream.parse(
      await fetchAerialMirror(aerialMirrorRawUrl(config.AERIAL_MIRROR_URL, name)), now, stale
    ));
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  if (granular && granular.regions.length) {
    aerialMirrorPolls.inc({ mode: 'granular' });
    for (const level of ['State', 'District', 'Community', 'other'] as const) {
      aerialMirrorRawRegions.set({ level }, granular.byLevel[level]);
    }
    recordReportedAlertLevels(AERIAL_MIRROR_SOURCE_ID, granular.byThreatLevel);
    return granular;
  }

  // Другий запит, рознесений у часі. Він тут СВІДОК, а не заміна: агрегований фід знає лише області
  // й світить їх, коли світиться будь-яка частина, тож підняти з нього тривогу означало б оголосити
  // те, чого влада не оголошувала. Єдине питання, на яке він відповідає, — «країна тиха чи фід
  // зламався»; будь-яка інша його відповідь закінчується тим, що ми не пишемо нічого.
  if (config.AERIAL_MIRROR_REQUEST_GAP_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, config.AERIAL_MIRROR_REQUEST_GAP_MS));
  }
  const witness = parseAerialMirrorPayload(
    await fetchAerialMirror(config.AERIAL_MIRROR_URL), now, stale
  );
  observeSourceCacheAge(AERIAL_MIRROR_SOURCE_ID, 'witness', witness.ageSeconds);
  const witnessActive = witness.regions.filter((region) => region.active).length;

  if (granular && !witnessActive) {
    // Тиша, підтверджена свідком. Порожній знімок — чесний: це те, що сказав основний фід.
    aerialMirrorPolls.inc({ mode: 'granular_quiet' });
    for (const level of ['State', 'District', 'Community', 'other'] as const) {
      aerialMirrorRawRegions.set({ level }, 0);
    }
    // Підтверджена тиша — це нулі й у кольорах: жоден вузол нічого не тримає, отже нікому й
    // називати колір. Замерзле число тут було б гірше за нуль — воно виглядало б як триваючий
    // червоний.
    recordReportedAlertLevels(AERIAL_MIRROR_SOURCE_ID, { yellow: 0, red: 0, unknown: 0 });
    return granular;
  }

  // Основний фід не читається (або каже «тихо», а свідок каже інакше). Раніше тут відбувався відкат
  // на агрегований фід — і саме він створював обласні тривоги, яких ніхто не оголошував: за добу
  // 10 % опитувань падали сюди, а за тиждень із цього виходило 212 обласних періодів, зокрема 32 по
  // Харківщині. Тепер ми не пишемо НІЧОГО: стан цього джерела лишається таким, яким був, зведення
  // тримає його через дебаунс і живість, а решта джерел (фід оголошень, канали ОВА) не зачеплені.
  aerialMirrorPolls.inc({ mode: granular ? 'granular_disputed_held' : 'granular_unusable_held' });
  const detail = granular
    ? `granular feed reported no air-raid region while the aggregated witness reports ${witnessActive}`
      + ` (${granular.entryCount} entries, ${granular.readableCount} readable)`
    : reason;
  log?.warn(
    { sourceId: AERIAL_MIRROR_SOURCE_ID, upstream: name, reason: detail, witnessActive },
    'aerial mirror granular feed unusable; holding alert state instead of asserting oblast rollups'
  );
  throw new Error(`aerial mirror granular feed unusable: ${detail}`);
}

// ------------------------------------------------------------------------------------------------
// Event-driven official alert sources: the Tier A alert Telegram channels
// ------------------------------------------------------------------------------------------------

/**
 * These are official Tier A sources that happen to publish over MTProto instead of HTTPS.
 * What they are *not* is snapshots: `persistOfficialAlertSnapshot` clears every state a source
 * holds before re-raising the reported ones, which is correct for an API that returns the complete
 * national picture on every poll and catastrophic for a channel that says "an alert started in one
 * raion" — every other raion would be cleared by the next message about a single oblast.
 *
 * So this path is per-location and additive: 🔴 raises exactly the rows it names, 🟢 lowers exactly
 * the rows it names, and every other row of the same source is left untouched.
 *
 * Every function below takes the source id from its caller. `alert_source_states` has always been
 * keyed on `(source_id, location_id, alert_type)` and `reconcileAggregateAlert` has always taken a
 * source id, so several administrations holding an alert over the same raion at the same time is
 * the storage model working as designed, not a special case: each one owns its own row, and the
 * aggregate is what the map shows.
 */

/** Adapter type of an alert channel: a channel whose messages may start and end alert periods. */
export const ALERT_CHANNEL_ADAPTER_TYPE = 'mtproto_alert_channel';

/**
 * Adapter types that read an air-raid API rather than somebody's prose.
 *
 * These decide whether a location is under alert. Telegram channels do not, unless every one of
 * these is unreachable — see {@link reconcileAggregateAlert} for the rule and for why it exists.
 *
 * `aerial_alerts_mirror` is in the list despite being a community republisher rather than an
 * authority of its own: what puts it here is the SHAPE of what it serves. It answers "here is the
 * complete national picture right now", which is a claim that can be checked, corrected and — most
 * importantly — falsified by the next poll. A channel post is an event with no such property: it
 * says what changed, once, and if the sentence is missed or misread nothing later contradicts it.
 * The distinction this list draws is snapshot versus event, not official versus unofficial.
 */
export const ALERT_API_ADAPTER_TYPES = ['alerts_in_ua', 'ukraine_alarm', 'aerial_alerts_mirror'] as const;

/**
 * The national channel https://t.me/air_alert_ua.
 *
 * Named because it is the row `config.ALERT_CHANNEL_USERNAME` falls back to when the registry cannot
 * be read, and because the operational documentation refers to it by id. It carries no privilege
 * over the other rows: it is read from the registry like all of them.
 */
export const ALERT_CHANNEL_SOURCE_ID = 'air-alert-ua';

/**
 * Which feed actually moved the mirror's alert state, per poll.
 *
 * `granular` is the healthy steady state. `granular_quiet` is «країна тиха, і свідок це підтверджує».
 * The two `_held` series are the ones to watch: they mean the detailed feed could not be read (or
 * disagreed with the witness) and this source therefore asserted NOTHING — the previous state stands
 * until the debounce or another source moves it. Before migration 050 that case fell back to the
 * aggregated oblast feed instead, which is how «тривога в Харківській області» reached subscribers
 * on nights when only two of its raions were declared: 10 % of polls landed there, and a week of
 * them produced 212 oblast periods. `state` and `state_unusable` are the second source, the one that
 * carries a genuine whole-oblast declaration.
 */
const aerialMirrorPolls = new Counter({
  name: 'threatlens_aerial_mirror_polls_total',
  help: 'Aerial mirror polls by which feed supplied the snapshot',
  labelNames: ['mode'],
  registers: []
});

/**
 * Regions the raw feed had alight at the last poll, by administrative level.
 *
 * A gauge and not a counter: it is a description of the present picture, and it is the number that
 * shows the upgrade doing what it exists for — `District` and `Community` above zero is granularity
 * the aggregated feed cannot express at all. Reset to zero on a corroborated quiet poll so a calm
 * night reads as calm rather than as the last wave, frozen.
 */
const aerialMirrorRawRegions = new Gauge({
  name: 'threatlens_aerial_mirror_raw_regions',
  help: 'Air-raid regions in the last usable raw aerial-mirror poll, by upstream region type',
  labelNames: ['level'],
  registers: []
});

/**
 * Обласні записи, які фід деталізації оголосив увімкненими, а парсер відкинув як згортку з районів.
 *
 * Це число — рівно ті «тривоги в області», яких влада не оголошувала і яких ця система більше не
 * повторює. Воно НЕ є помилкою й не має падати до нуля: на звичайну ніч із районними тривогами воно
 * дорівнює кільком одиницям, і саме так виглядає правило, що працює.
 */
const aerialMirrorDroppedOblasts = new Gauge({
  name: 'threatlens_aerial_mirror_dropped_rollup_oblasts',
  help: 'Oblast rows the granular feed marked alight and this adapter refused as a rollup, last poll',
  registers: []
});

/**
 * Вузли дзеркала, що ТРИМАЮТЬ тривогу, за кольором, який вони назвали, на останньому придатному
 * опитуванні.
 *
 * Метрика існує заради однієї відмінності, якої більше не видно ніде: «кольору зараз ніхто не
 * називає» і «фід перестав слати кольори» виглядають однаково — обидва ряди в нулі. Різниця в
 * русі: у першому випадку числа ходять протягом нальоту, у другому стоять мертво, і щоб це
 * побачити, число мусить існувати. Саме тому ряди виставляються НА КОЖНОМУ придатному опитуванні,
 * включно з нулями, а не лише тоді, коли є що показати.
 *
 * Рівно три ряди, зафіксовані на етапі компіляції: `yellow`, `red` і `unknown`. Мітки локації тут
 * немає й бути не може — на які саме райони припав колір, точно відповідає `alert_source_states`, а
 * метрика з 31 000 можливих значень мітки поклала б Prometheus. `unknown` — вузли, чий колір не
 * `yellow` і не `red`: у знімок він не потрапляє й у базу не пишеться, але мовчки зникнути теж не
 * має права. Ненульовий `unknown` означає рівно одне: апстрім почав називати колір, якого домен не
 * знає, і перелік треба розширювати міграцією.
 *
 * Сумується по фідах дзеркала, бо їх два й кожен опитується окремо (міграція 050: `skog` для
 * деталізації, `klimenko` для оголошень області). Фід без кольорів дає нулі й нічого не псує.
 */
const alertLevelsReported = new Gauge({
  name: 'threatlens_alert_levels_reported',
  help: 'Holding aerial-mirror nodes by the differentiated alert level they reported, last usable poll',
  labelNames: ['level'],
  registers: []
});

/**
 * Останній прочитаний розподіл кольорів, по одному запису на фід дзеркала.
 *
 * Обмежена за побудовою: ключі — це два (найбільше три) ідентифікатори джерел дзеркала, які цей
 * процес опитує, і запис замінюється, а не додається. Та сама форма, що й `mirrorFeedCache`.
 */
const reportedLevelsByFeed = new Map<string, Record<AlertLevel | 'unknown', number>>();

function recordReportedAlertLevels(
  sourceId: string, counts: Record<AlertLevel | 'unknown', number>
): void {
  reportedLevelsByFeed.set(sourceId, counts);
  for (const level of [...ALERT_LEVELS, 'unknown'] as const) {
    let total = 0;
    for (const feed of reportedLevelsByFeed.values()) total += feed[level];
    alertLevelsReported.set({ level }, total);
  }
}

const alertChannelMessages = new Counter({
  name: 'threatlens_alert_channel_messages_total',
  help: 'Messages read from the official alert Telegram channels, by source and parse outcome',
  labelNames: ['source', 'outcome'],
  registers: []
});
const alertChannelStuckAlerts = new Counter({
  name: 'threatlens_alert_channel_stuck_alerts_total',
  help: 'Alert-channel states force-cleared because no all-clear arrived within the maximum duration',
  labelNames: ['source'],
  registers: []
});
/**
 * Rows discounted from the alert aggregate because their source showed no sign of life.
 *
 * The visible price of the two precedence rules in `reconcileAggregateAlert`, split by `reason`
 * because the two readings are opposites.
 *
 * `stale` means a source is holding alerts while showing no sign of life — either the failure the
 * liveness rule exists to survive, or that rule misfiring on a source whose normal update interval
 * exceeds `ALERT_SOURCE_LIVENESS_SECONDS`. Both demand a look.
 *
 * `api_precedence` means a Telegram channel wanted to hold an alert that no API agreed with. That is
 * the rule working as designed, and a steady low rate is normal — channels lag and lead the APIs by
 * seconds all day. A sustained HIGH rate says something else: either the channels are seeing
 * something the APIs are not, or a channel is stuck, and the archive is where to look next.
 *
 * Neither number is visible anywhere else — without it the aggregate simply comes out different.
 *
 * ## Why `reason` is the ONLY label
 *
 * It used to carry the location id too. prom-client keeps every label tuple it has ever seen for
 * the life of the process, and this counter is incremented from the reconcile of every
 * (location, alert_type) pair a snapshot touches — which since migration 051 means hromadas. One
 * busy night of raion- and hromada-level holds writes thousands of permanent child metrics, each
 * one a resident object AND a line in every `/metrics` scrape from then until restart, to answer a
 * question nobody asks of a counter: «which location» is a question about state, and
 * `alert_source_states` holds that state exactly, with the source, the timestamps and the
 * `missing_since` the metric could never carry. What the counter is for is the RATE and its split,
 * and both survive the drop untouched.
 */
const alertStaleSourcesIgnored = new Counter({
  name: 'threatlens_alert_stale_sources_ignored_total',
  help: 'Alert-holding source rows discounted from the aggregate, by why they were not counted',
  labelNames: ['reason'],
  registers: []
});
const monitorMessages = new Counter({
  name: 'threatlens_monitor_messages_total',
  help: 'Messages read from the OSINT monitoring channels, by classification outcome',
  labelNames: ['source', 'outcome'],
  registers: []
});
/**
 * Повідомлення, старші за стелю доставки (`SOURCE_MESSAGE_MAX_DELIVERY_AGE_MINUTES`).
 *
 * Кожне з них класифіковано, заархівовано й дописано в контекст локацій — і жодне не дійшло до
 * людини. Мітка `path` розділяє два різні діагнози, які без неї виглядали б однаково:
 *
 *  * `backfill` — дозбір читає стару історію. Це нормальна робота; число дорівнює тому, скільки
 *    вікна простою вже нікого не стосується;
 *  * `live` — живий колектор віддав годинної давнини пост. Стала ненульова величина тут означає, що
 *    MTProto систематично довозить пропущені апдейти після реконекту, і саме ці повідомлення до цієї
 *    стелі йшли в бот як щойно опубліковані.
 */
const staleForDelivery = new Counter({
  name: 'threatlens_messages_stale_for_delivery_total',
  help: 'Source messages archived without delivery because they were older than the delivery age ceiling',
  labelNames: ['source', 'path'],
  registers: []
});
/**
 * Archive writes that were dropped so the pipeline could carry on.
 *
 * A non-zero value means the classification archive has holes and any count taken from it is a
 * lower bound. It is deliberately a separate signal from the ingestion error path: losing analytics
 * is not an outage, and must never be reported as one.
 */
const classificationLogFailures = new Counter({
  name: 'threatlens_classification_log_failures_total',
  help: 'Classification-archive writes that failed and were dropped without failing ingestion',
  labelNames: ['source'],
  registers: []
});
const threatWithdrawals = new Counter({
  name: 'threatlens_threat_withdrawals_total',
  help: 'Source assertion withdrawals, by outcome',
  labelNames: ['source', 'outcome'],
  registers: []
});
/**
 * Every archived decision, by the rule version that made it and what it decided.
 *
 * The version label is the point. `message_classifications` records it per row, but nothing exported
 * it, so "did the new rules change the mix of decisions" was a question that could only be answered
 * by querying the database after the fact. With this, a version bump shows up on the dashboard as
 * one series ending and another beginning, and the shapes can be compared directly.
 */
const classificationDecisions = new Counter({
  name: 'threatlens_classifications_total',
  help: 'Deterministic classifications archived, by classifier version and decision',
  labelNames: ['version', 'decision'],
  registers: []
});
/**
 * Why a message raised nothing, per source.
 *
 * The two reasons are different operational findings and must not be summed.
 * `no_threat_recognised` concentrated on one channel means its vocabulary has drifted away from the
 * rules; `no_location` concentrated on one channel means it names settlements the catalogue does not
 * hold. The first is fixed in `src/domain/classifier.ts`, the second in the location importer, and
 * before this counter existed the only way to tell them apart was to read the archive by hand.
 */
const classificationRejections = new Counter({
  name: 'threatlens_classification_rejections_total',
  help: 'Messages that raised nothing, by source and rejection reason',
  labelNames: ['source', 'reason'],
  registers: []
});
/**
 * How often the rules turn a live threat into no threat.
 *
 * The dangerous direction, and the one this project can least afford to get wrong: a wrong all-clear
 * is silent, and the reader who acts on it is the reader who is under the drone. `threat_withdrawals`
 * already counts withdrawal *outcomes*, including the ones that closed nothing; this counts only the
 * transitions that actually ended a live event, and carries the classifier version so that a rule
 * change which starts producing them is visible as a step in the series rather than as an incident
 * report weeks later.
 */
const threatToDeEscalation = new Counter({
  name: 'threatlens_threat_to_de_escalation_total',
  help: 'De-escalations that ended a live threat event, by source and classifier version',
  labelNames: ['source', 'version'],
  registers: []
});

/**
 * Attaches this module's metrics to a Prometheus registry, mirroring `registerOccupationMetrics`.
 * Nothing in `src/services` owns the HTTP registry, so the wiring lives wherever the registry is
 * created. The monitoring-channel counter rides along rather than adding a second call site, and so
 * do the shadow-classifier and retrospective-gate ones: both modules are reached only through this
 * one.
 */
export function registerAlertChannelMetrics(registry: Registry): void {
  const metrics: ReadonlyArray<[string, Counter<string> | Gauge<string> | Histogram<string>]> = [
    ['threatlens_aerial_mirror_polls_total', aerialMirrorPolls],
    ['threatlens_aerial_mirror_raw_regions', aerialMirrorRawRegions],
    ['threatlens_aerial_mirror_dropped_rollup_oblasts', aerialMirrorDroppedOblasts],
    ['threatlens_alert_channel_messages_total', alertChannelMessages],
    ['threatlens_alert_channel_stuck_alerts_total', alertChannelStuckAlerts],
    ['threatlens_alert_levels_reported', alertLevelsReported],
    ['threatlens_alert_stale_sources_ignored_total', alertStaleSourcesIgnored],
    ['threatlens_monitor_messages_total', monitorMessages],
    ['threatlens_messages_stale_for_delivery_total', staleForDelivery],
    ['threatlens_classification_log_failures_total', classificationLogFailures],
    ['threatlens_threat_withdrawals_total', threatWithdrawals],
    ['threatlens_classifications_total', classificationDecisions],
    ['threatlens_classification_rejections_total', classificationRejections],
    ['threatlens_threat_to_de_escalation_total', threatToDeEscalation],
    ...shadowClassifierMetrics(),
    ...retrospectiveGateMetrics(),
    // Same rule as the two above: both modules are reached only through this one, and a second call
    // site in `buildServer()` would be a second place to forget.
    ...legSchedulerMetrics(),
    ...alertPokeMetrics()
  ];
  for (const [name, metric] of metrics) {
    if (!registry.getSingleMetric(name)) registry.registerMetric(metric);
  }
}

export interface AlertChannelMessage {
  externalId: string;
  /** Telegram publication time. The clock printed inside the message is never used. */
  publishedAt: Date;
  editedAt?: Date | null;
  text: string;
  rawPayload?: Record<string, unknown>;
}

export interface AlertChannelIngestSummary {
  events: number;
  ignored: number;
  unrecognized: number;
  /** Source-state rows written. */
  applied: number;
  /** Rows left alone because a newer channel event had already been applied to them. */
  skippedStale: number;
  unresolved: string[];
}

interface AlertChannelState {
  locationId: string;
  alertType: string;
  active: boolean;
  observedAt: Date;
  externalId: string;
}

function compareExternalId(left: string, right: string): number {
  const a = Number(left); const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) ? a - b : left.localeCompare(right);
}

/**
 * Keeps the raw message for provenance and for the edit trail.
 *
 * `UNIQUE (source_id, external_id, content_hash)` means a replayed message is a no-op while an
 * edited one lands as a second row against the same Telegram id — the revision history comes for
 * free, and an unrecognised format is recorded rather than only logged.
 */
async function recordAlertChannelMessage(
  sourceId: string, message: AlertChannelMessage, status: string
): Promise<void> {
  const hash = createHash('sha256').update(message.text).digest('hex');
  await pool.query(
    `INSERT INTO source_messages(source_id,external_id,published_at,edited_at,raw_text,raw_payload,
       content_hash,processing_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (source_id,external_id,content_hash) DO NOTHING`,
    [sourceId, message.externalId, message.publishedAt, message.editedAt ?? null,
      message.text, JSON.stringify(message.rawPayload ?? {}), hash, status]
  );
}

async function applyAlertChannelStates(
  sourceId: string, states: AlertChannelState[]
): Promise<{ applied: number; skippedStale: number }> {
  if (!states.length) return { applied: 0, skippedStale: 0 };
  const client = await pool.connect();
  try {
    await beginAlertStateTransaction(client);
    let applied = 0;
    let skippedStale = 0;
    const started: AlertStartRecord[] = [];
    for (const state of states) {
      // The `WHERE` on the conflict branch is the ordering guard. Channel messages can arrive out of
      // order after a reconnect, and an all-clear from an hour ago must never overwrite an alert
      // declared five minutes ago; zero returned rows means exactly that and is not an error.
      //
      // `missing_since` is cleared on both branches. It is the marker the snapshot debounce reads,
      // and an explicit 🟢 is not a source going quiet — inheriting that window here would delay
      // every genuine all-clear this channel publishes.
      //
      // `alert_level`/`alert_kind` пишуться ЯВНИМ NULL, а не пропускаються. Канал ОВА кольору не
      // публікує: `parseAlertChannelMessage` читає 🔴/🟢 і назви місць, і поняття рівня в його
      // граматиці немає взагалі. Пропустити стовпці означало б «лишити те, що стояло» — і рядок
      // каналу вічно тримав би колір, який колись приїхав звідкись іще, хоча сам канал про нього
      // нічого не знає й не може ні підтвердити, ні зняти. NULL тут — це не «немає небезпеки», а
      // «це джерело кольору не називає», і саме так його читає зведення: рядок тримає тривогу
      // нарівні з усіма, але в суперечку про колір не вступає.
      const upsert = await client.query<{ location_id: string }>(
        `INSERT INTO alert_source_states(source_id,location_id,alert_type,active,provider_started_at,
           external_id,last_event_at,missing_since,alert_level,alert_kind)
         VALUES ($1,$2,$3,$4,CASE WHEN $4 THEN $5::timestamptz ELSE NULL END,$6,$5,NULL,NULL,NULL)
         ON CONFLICT (source_id,location_id,alert_type) DO UPDATE SET
           active=EXCLUDED.active,
           provider_started_at=CASE
             WHEN EXCLUDED.active AND alert_source_states.active THEN alert_source_states.provider_started_at
             WHEN EXCLUDED.active THEN EXCLUDED.provider_started_at
             ELSE alert_source_states.provider_started_at END,
           external_id=EXCLUDED.external_id,
           last_event_at=EXCLUDED.last_event_at,
           missing_since=NULL,
           alert_level=NULL,alert_kind=NULL,
           last_seen_at=now(),updated_at=now()
         WHERE alert_source_states.last_event_at IS NULL
            OR alert_source_states.last_event_at <= EXCLUDED.last_event_at
         RETURNING location_id`,
        [sourceId, state.locationId, state.alertType, state.active,
          state.observedAt, state.externalId]
      );
      if (!upsert.rowCount) { skippedStale += 1; continue; }
      applied += 1;
      const record = await reconcileAggregateAlert(client, state.locationId, state.alertType, sourceId);
      if (record) started.push(record);
    }
    await client.query('COMMIT');
    // The channel path has no acquisition lag to remove — it is pushed to, not polled — but the two
    // one-second workers downstream are the same two, and a 🔴 arriving over MTProto pays them
    // exactly as a snapshot does. `provider_started_at` here is the Telegram publication time, so
    // the propagation metric measures the same thing under a different `source` label.
    announceAlertStarts(sourceId, started);
    return { applied, skippedStale };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Applies a batch of messages from one alert channel.
 *
 * The live collector passes one message; the reconnect backfill passes a bounded history window.
 * Both go through the same code because the batch is first **folded to one terminal state per
 * location** — the newest event wins — and only that state is written. Replaying a window therefore
 * converges on the situation as it stands right now instead of re-emitting an hours-old alert and
 * its all-clear as a fresh pair of notifications.
 *
 * `sourceId` is the registry row the messages came from, and it is the whole of what keeps two
 * administrations reporting the same raion apart. Passing the wrong one would attribute one
 * authority's all-clear to another and end an alert the other body never withdrew.
 */
export async function ingestAlertChannelMessages(
  sourceId: string, messages: AlertChannelMessage[], log?: { warn: Function }
): Promise<AlertChannelIngestSummary> {
  const summary: AlertChannelIngestSummary = {
    events: 0, ignored: 0, unrecognized: 0, applied: 0, skippedStale: 0, unresolved: []
  };
  if (!config.ALERT_CHANNEL_ENABLED || !messages.length) return summary;
  const ordered = [...messages].sort((left, right) =>
    left.publishedAt.getTime() - right.publishedAt.getTime()
    || compareExternalId(left.externalId, right.externalId));

  const desired = new Map<string, AlertChannelState>();
  const unresolved: string[] = [];
  for (const message of ordered) {
    // Measured from the channel's own timestamp, not from ours: the number an operator needs is
    // "how old was this when we accepted it", and our clock cannot answer that.
    observeIngestionLag(sourceId, (Date.now() - message.publishedAt.getTime()) / 1000);
    const startedAt = Date.now();
    try {
      const parsed = parseAlertChannelMessage(message.text, message.publishedAt);
      if (parsed.kind === 'unrecognized') {
        summary.unrecognized += 1;
        alertChannelMessages.inc({ source: sourceId, outcome: 'unrecognized' });
        countChannelError(sourceId, 'parse');
        await recordAlertChannelMessage(sourceId, message, 'unrecognized');
        // A channel that changes its wording must make this loud. Silently reporting no alerts is the
        // one outcome an alert source is never allowed to have. Ordinary channel prose does not reach
        // here — the parser files it as `ignored: 'unrelated'` — so this warning stays a signal on a
        // channel that publishes news between its alerts.
        log?.warn(
          { sourceId, externalId: message.externalId, headline: parsed.headline },
          'alert channel message matched no known format and was not applied'
        );
        continue;
      }
      if (parsed.kind === 'ignored') {
        summary.ignored += 1;
        alertChannelMessages.inc({ source: sourceId, outcome: `ignored:${parsed.reason}` });
        await recordAlertChannelMessage(sourceId, message, 'ignored');
        continue;
      }
      summary.events += 1;
      alertChannelMessages.inc({ source: sourceId, outcome: parsed.event.action });
      await recordAlertChannelMessage(sourceId, message, 'alert');
      for (const name of parsed.event.locationNames) {
        const locationId = await resolveLocationId({ locationName: name });
        if (!locationId) { unresolved.push(name); continue; }
        desired.set(`${locationId}:${parsed.event.alertType}`, {
          locationId,
          alertType: parsed.event.alertType,
          active: parsed.event.action === 'start',
          observedAt: parsed.event.observedAt,
          externalId: `${sourceId}:${message.externalId}`
        });
      }
    } finally {
      // In a `finally` because two of the three branches `continue`; a per-branch call would
      // silently stop measuring the day a fourth branch is added.
      observeClassificationDuration('alert', (Date.now() - startedAt) / 1000);
    }
  }

  const outcome = await applyAlertChannelStates(sourceId, [...desired.values()]);
  summary.applied = outcome.applied;
  summary.skippedStale = outcome.skippedStale;
  summary.unresolved = unresolved;
  // Reported only when there is something to report: unlike a poll, a single message is not a
  // statement about every location, so a resolvable message must not erase the standing gap report.
  if (unresolved.length) recordUnresolvedLocations(sourceId, unresolved, log);
  return summary;
}

/**
 * Backstop for the one failure mode the event model has and the snapshot model does not.
 *
 * A 🟢 that is never delivered — a disconnect, a message the parser does not recognise, a location
 * the channel spells differently on the way out — leaves an alert active forever. This clears any
 * channel state that has been active for longer than `ALERT_CHANNEL_MAX_ALERT_SECONDS`, logs it and
 * counts it. The bound is set far above any real alert precisely so that firing is a defect signal,
 * not routine behaviour: if it fires, an all-clear was missed and the operator needs to know.
 *
 * It sweeps **every** row whose adapter type is an alert channel, deliberately including the ones
 * `enabled=false` currently switches off. Disabling a channel stops it being read; it does not
 * withdraw the alerts it was holding when it was switched off, and without this those rows would
 * hold their locations on the map with no collector left that could ever clear them.
 */
export async function expireStuckAlertChannelAlerts(log?: { warn: Function }): Promise<number> {
  if (!config.ALERT_CHANNEL_ENABLED) return 0;
  const client = await pool.connect();
  try {
    await beginAlertStateTransaction(client);
    const stuck = await client.query<{
      source_id: string; location_id: string; alert_type: string; started_at: string;
    }>(
      `UPDATE alert_source_states
          SET active=false,missing_since=NULL,last_seen_at=now(),updated_at=now()
        WHERE source_id IN (SELECT id FROM sources WHERE adapter_type=$1) AND active=true
          AND COALESCE(provider_started_at,last_event_at,updated_at)
              < now()-($2::int * interval '1 second')
        RETURNING source_id,location_id,alert_type,
                  COALESCE(provider_started_at,last_event_at,updated_at)::text AS started_at`,
      [ALERT_CHANNEL_ADAPTER_TYPE, config.ALERT_CHANNEL_MAX_ALERT_SECONDS]
    );
    // A backstop pass only ever LOWERS a source row, so it normally reconciles alerts to an end and
    // reports nothing. It is not structurally incapable of the other direction: clearing one
    // administration's stuck row re-runs the aggregate, and if a second source still holds that
    // location while no global period is open, the same call opens one. Rare, and cheaper to handle
    // than to argue away.
    const started: Array<{ sourceId: string; record: AlertStartRecord }> = [];
    for (const row of stuck.rows) {
      const record = await reconcileAggregateAlert(client, row.location_id, row.alert_type, row.source_id);
      if (record) started.push({ sourceId: row.source_id, record });
      alertChannelStuckAlerts.inc({ source: row.source_id });
      log?.warn({
        sourceId: row.source_id, locationId: row.location_id, alertType: row.alert_type,
        startedAt: row.started_at, maximumSeconds: config.ALERT_CHANNEL_MAX_ALERT_SECONDS
      }, 'alert channel state cleared by the maximum alert duration guard: an all-clear was missed');
    }
    await client.query('COMMIT');
    for (const entry of started) announceAlertStarts(entry.sourceId, [entry.record]);
    return stuck.rowCount ?? 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The newest Telegram message id already stored for a source, or null when none is.
 *
 * Used by the reconnect backfill to tell whether its bounded window actually met the archive or
 * stopped short of it, leaving a stretch of the channel nobody has ever read. `external_id` is text
 * because other adapters put non-numeric ids there; the cast is guarded so a source that has ever
 * stored one cannot make this throw and take the backfill down with it.
 */
export async function newestStoredExternalId(sourceId: string): Promise<number | null> {
  const result = await pool.query<{ newest: string | null }>(
    `SELECT max(external_id::bigint)::text AS newest FROM source_messages
      WHERE source_id=$1 AND external_id ~ '^[0-9]+$'`,
    [sourceId]
  );
  const newest = Number(result.rows[0]?.newest ?? Number.NaN);
  return Number.isFinite(newest) ? newest : null;
}

export interface AlertTelegramChannel {
  sourceId: string;
  /** Lower-cased, without the leading `@`. */
  username: string;
}

/**
 * The Telegram channels allowed to start and end official alerts, read from `sources`.
 *
 * `enabled` is a real gate here, exactly as it is for the OSINT monitors: fifteen of the twenty-one
 * registered Tier A rows are switched off because their published wording has never been observed or
 * cannot be read safely, and the flag is the only thing that keeps alert-declaring authority away
 * from those channels. Nothing in the code writes this column — see
 * `migrations/014_multi_channel_alert_routing.sql` for why the collector no longer flips it on.
 *
 * `config.ALERT_CHANNEL_ENABLED` sits above it as the deployment-level kill switch, mirroring
 * `OSINT_MONITOR_ENABLED`: the environment decides whether this path runs at all, and the catalogue
 * decides which channels it runs over.
 */
export async function loadAlertChannels(): Promise<AlertTelegramChannel[]> {
  if (!config.ALERT_CHANNEL_ENABLED) return [];
  const result = await pool.query<{ id: string; telegram_username: string }>(
    `SELECT id,lower(telegram_username) AS telegram_username FROM sources
     WHERE adapter_type=$1 AND enabled=true AND telegram_username IS NOT NULL
     ORDER BY id`,
    [ALERT_CHANNEL_ADAPTER_TYPE]
  );
  return result.rows
    .map((row) => ({
      sourceId: row.id,
      username: (row.telegram_username ?? '').trim().replace(/^@/, '').toLowerCase()
    }))
    .filter((channel) => channel.username);
}

// ------------------------------------------------------------------------------------------------
// Monitoring Telegram channels: the classifier path, driven from `sources`
// ------------------------------------------------------------------------------------------------

/** Adapter type of an OSINT monitoring channel. Never reaches the alert reconciler — see below. */
export const MONITOR_ADAPTER_TYPE = 'mtproto_monitor';

/** Adapter type of the Air Force channel: the same classifier path, but an official Tier A source. */
const CLASSIFIER_ADAPTER_TYPES = ['mtproto', MONITOR_ADAPTER_TYPE] as const;

/**
 * Every handle claimed by an alert-channel row, `enabled` or not.
 *
 * Disabled is included on purpose: a switched-off Tier A row must not become collectable through
 * the classifier by having its handle duplicated onto a monitoring row. Interpolated into the two
 * queries below, where `$1` is the alert-channel adapter type.
 */
const ALERT_CHANNEL_HANDLES_SQL =
  `SELECT lower(telegram_username) FROM sources WHERE adapter_type=$1 AND telegram_username IS NOT NULL`;

export interface MonitoredTelegramChannel {
  sourceId: string;
  /** Lower-cased, without the leading `@`. */
  username: string;
  adapterType: string;
}

/**
 * The Telegram channels whose messages go through the classifier, read from `sources`.
 *
 * This is the whole list. Adding a monitoring channel is a row, not a code change, and the row is
 * what binds a username to the `source_id` that will own its evidence — get that wrong and the
 * independence-group rule silently attributes one publisher's reporting to another.
 *
 * Two things this deliberately does *not* return:
 *
 *  * **Any alert channel.** Their adapter type is `mtproto_alert_channel` and is not in
 *    {@link CLASSIFIER_ADAPTER_TYPES}; on top of that, a row claiming a username that *any*
 *    alert-channel row also claims is dropped outright, as is a row claiming the configured
 *    fallback username. A monitoring row can therefore never be routed to the alert reconciler,
 *    and cannot shadow an official channel by claiming its name — which matters far more now that
 *    twenty-one handles carry alert authority instead of one.
 *  * **Disabled rows.** `enabled=false` stops every classifier route, including the Air Force row.
 *    A registry read failure still gets the one-channel fallback in `resolveChannelRoutes`; a
 *    successful empty result is obeyed.
 */
export async function loadMonitoredTelegramChannels(): Promise<MonitoredTelegramChannel[]> {
  if (!config.OSINT_MONITOR_ENABLED) {
    // The kill switch stops the OSINT monitors only; the Air Force channel is not OSINT.
    const airForce = await pool.query<{ id: string; telegram_username: string; adapter_type: string }>(
      `SELECT id,lower(telegram_username) AS telegram_username,adapter_type FROM sources
       WHERE telegram_username IS NOT NULL AND adapter_type='mtproto'
         AND enabled=true
         AND lower(telegram_username) NOT IN (${ALERT_CHANNEL_HANDLES_SQL})
       ORDER BY id`,
      [ALERT_CHANNEL_ADAPTER_TYPE]
    );
    return toMonitoredChannels(airForce.rows);
  }
  const result = await pool.query<{ id: string; telegram_username: string; adapter_type: string }>(
    `SELECT id,lower(telegram_username) AS telegram_username,adapter_type FROM sources
     WHERE telegram_username IS NOT NULL
       AND adapter_type = ANY($2::text[])
       AND enabled = true
       AND lower(telegram_username) NOT IN (${ALERT_CHANNEL_HANDLES_SQL})
     ORDER BY id`,
    [ALERT_CHANNEL_ADAPTER_TYPE, [...CLASSIFIER_ADAPTER_TYPES]]
  );
  return toMonitoredChannels(result.rows);
}

function toMonitoredChannels(
  rows: Array<{ id: string; telegram_username: string; adapter_type: string }>
): MonitoredTelegramChannel[] {
  const alertChannel = config.ALERT_CHANNEL_USERNAME;
  return rows
    .map((row) => ({
      sourceId: row.id,
      username: (row.telegram_username ?? '').trim().replace(/^@/, '').toLowerCase(),
      adapterType: row.adapter_type
    }))
    .filter((channel) => channel.username && channel.username !== alertChannel);
}

/**
 * Suppression window for a monitoring channel repeating itself.
 *
 * These channels publish in bursts during an attack, and a burst is mostly restatement: the same
 * threat type over the same place, minutes apart. Every restatement that reaches `ingestThreat`
 * lands on the existing event, appends a `threat.updated` row to the system event log and therefore
 * fans out to *every* subscriber of that location again — the outbox idempotency key carries the
 * event-log version, so a repeat is a new notification, not a duplicate that collapses.
 *
 * The key is (source, threat type, locations), so this only ever collapses a source restating the
 * same thing. A different location, a different threat type, or the same report from a *different*
 * channel all pass through untouched — which matters, because corroboration between two monitors is
 * exactly what promotes an event to `confirmed`.
 *
 * In-process state, matching the documented single-replica deployment. Losing it on restart costs
 * one extra notification per active threat.
 */
const monitorCoalesceState = new Map<string, number>();

function coalesceKey(sourceId: string, classified: ReturnType<typeof classifyMessage>): string {
  const places = classified.nationalScope
    ? ['ua']
    : classified.locations.map((location) => location.id).sort();
  return `${sourceId}|${classified.threatType}|${places.join(',')}`;
}

/** Test seam: the window is wall-clock, so a suite that ingests twice in one tick needs a reset. */
export function resetMonitorCoalescing(): void {
  monitorCoalesceState.clear();
}

function shouldCoalesce(key: string, now: number): boolean {
  const windowMs = config.OSINT_MONITOR_COALESCE_SECONDS * 1000;
  if (windowMs <= 0) return false;
  for (const [existing, at] of monitorCoalesceState) {
    if (at < now - windowMs) monitorCoalesceState.delete(existing);
  }
  const previous = monitorCoalesceState.get(key);
  if (previous !== undefined && previous >= now - windowMs) return true;
  monitorCoalesceState.set(key, now);
  return false;
}

/**
 * Stores a message the pipeline is not going to act on, and returns its id.
 *
 * The conflict branch is a no-op update rather than `DO NOTHING` because the id is needed to attach
 * a classification record: a replayed message must keep its original status and still be linkable.
 */
async function recordUnprocessedMessage(message: NormalizedMessage, status: string): Promise<string> {
  const hash = createHash('sha256').update(message.text).digest('hex');
  const result = await pool.query<{ id: string }>(
    `INSERT INTO source_messages(source_id,external_id,published_at,edited_at,raw_text,raw_payload,content_hash,processing_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (source_id,external_id,content_hash)
       DO UPDATE SET received_at=source_messages.received_at
     RETURNING id`,
    [message.sourceId, message.externalId, message.publishedAt, message.editedAt ?? null,
      message.text, JSON.stringify(message.rawPayload), hash, status]
  );
  return result.rows[0]!.id;
}

/**
 * The decisions that put an event on the map, and therefore the only ones a model may annotate.
 *
 * `de_escalation` is absent and that is the important omission: a withdrawal carries an event id too,
 * and a model remark filed against a claim somebody has just taken back is the one shape of
 * "enrichment" that could read as an argument for putting it back. The three listed here are the
 * branches that assert something.
 */
const PUBLISHING_DECISIONS: ReadonlySet<ClassificationDecision> =
  new Set<ClassificationDecision>(['event_created', 'event_merged', 'redirect']);

/**
 * Archives one decision without ever letting the archive break the pipeline.
 *
 * The write is outside the ingestion transaction and its failure is a counter, not an exception:
 * during a mass attack the thing that must keep working is the map, and an analytics row is not
 * worth a dropped threat event. What is lost when this fails is one row of history, and the counter
 * says so.
 */
/**
 * Що знає архівний шлях понад {@link ClassificationLogEntry}, коли класифікувала модель (міграція 049):
 * сам вхід моделі — для рядка звірки «правила проти моделі», який пишеться, щойно в повідомлення є
 * id, — і локації контексту, куди дописати цей вердикт для наступного повідомлення.
 */
interface ArchiveEntry extends ClassificationLogEntry {
  /** Вердикт моделі став класифікацією (або придушив її): тіньовий виклик не потрібен — він уже був. */
  modelClassified?: boolean;
  primaryInput?: CodexClassifyInput;
  modelAssessment?: ModelAssessment | null;
  contextLocationIds?: string[];
  /** Що про джерело знає конвеєр: для рядка контексту. */
  sourceName?: string | null;
  /** Вкладення, що качалися паралельно з класифікацією; див. `ProcessMessageOptions.pendingMedia`. */
  pendingMedia?: Promise<ClassificationLogEntry['media']>;
}

/** Назва, рівень і офіційність джерела — один запит на джерело, памʼять процесу на десять хвилин. */
const sourceDescriptors = new Map<string, { at: number; value: { name: string; tier: string; official: boolean } | null }>();
const SOURCE_DESCRIPTOR_TTL_MS = 10 * 60_000;

export async function sourceDescriptor(sourceId: string): Promise<{ name: string; tier: string; official: boolean } | null> {
  const cached = sourceDescriptors.get(sourceId);
  if (cached && Date.now() - cached.at < SOURCE_DESCRIPTOR_TTL_MS) return cached.value;
  const row = await pool.query<{ name: string; tier: string; official: boolean }>(
    `SELECT name,tier,official FROM sources WHERE id=$1`, [sourceId]
  ).catch(() => ({ rows: [] as Array<{ name: string; tier: string; official: boolean }> }));
  const value = row.rows[0] ?? null;
  sourceDescriptors.set(sourceId, { at: Date.now(), value });
  return value;
}

/** Тестовий шов. */
export function resetSourceDescriptors(): void {
  sourceDescriptors.clear();
}

/**
 * Запис у контекст локацій (міграція 049) — для кожного повідомлення, у будь-якому режимі: контекст
 * має бути готовий до дня, коли модель стане основною, а не починатися з нуля того дня. Локації —
 * названі в класифікації, їхні області, і «ua», коли місця немає зовсім.
 */
async function noteInLocationContexts(entry: ArchiveEntry): Promise<void> {
  if (!config.MODEL_CONTEXT_ENABLED) return;
  const ids = entry.contextLocationIds?.length
    ? entry.contextLocationIds
    : await contextLocationIdsFor(entry.classified).catch(() => ['ua']);
  const located = entry.classified.locations.length > 0;
  const targets = located ? ids.filter((id) => id !== 'ua') : ids;
  const text = entry.message?.text ?? entry.classified.summary;
  // Повідомлення старше за стелю доставки в контекст ІДЕ — власне заради цього воно й обробляється, —
  // але позначене. Модель, яка читає цей контекст, має бачити різницю між «джерело сказало це, і
  // людей попередили» і «джерело сказало це, а ми дізналися запізно»: без позначки годинної давнини
  // пост із дозбору читається як подія, що сталася й на яку відреагували.
  const verdict = contextLineForVerdict(
    entry.sourceName ? { name: entry.sourceName } : null, entry.sourceId, text,
    entry.modelAssessment ?? null, entry.primaryInput?.rules ?? entry.classified, entry.decision, contextExcerpt
  );
  const stale = !withinDeliveryAge(entry.publishedAt);
  const line = contextLine(entry.publishedAt, stale ? `${verdict} · дізналися запізно, не доставлялося` : verdict);
  await appendLocationContext(targets, line);
}

async function archiveClassification(entry: ArchiveEntry): Promise<void> {
  // The shadow classifier hangs off this one function rather than off the four branches that call
  // it, because "the deterministic decision is final and written down" is exactly the moment a second
  // opinion becomes meaningful and cannot influence anything. It is started before the archive write
  // is awaited on purpose — the two are independent, neither waits for the other, and the model call
  // is fire-and-forget in both directions.
  //
  // У режимі `classifier_mode=codex` модель уже відповіла на це повідомлення ДО рішення, і її
  // відповідь уже є класифікацією (або придушенням): другий виклик нічого не додав би, крім витрати,
  // а рядок звірки «правила проти моделі» пишеться нижче з того самого вердикту.
  //
  // The original text and envelope are passed because an image/audio-only post can have no useful
  // deterministic summary, and because an analytical promotion must preserve its source identity.
  if (!entry.modelClassified) {
    // ЄДИНЕ місце, де чекають на файл, що качався паралельно, — і це не критичний шлях: сюди
    // доходять уже після того, як `ingestThreat` закомітив подію й підняв поштовх, тож попередження
    // вже в дорозі. У режимі `codex` цієї гілки немає взагалі: там файл потрібен був ДО рішення,
    // колектор його дочекався сам, і `pendingMedia` порожній.
    const media = entry.pendingMedia ? await entry.pendingMedia : entry.media;
    scheduleShadowClassification({
      sourceMessageId: entry.sourceMessageId,
      sourceId: entry.sourceId,
      publishedAt: entry.publishedAt,
      text: entry.message?.text ?? entry.classified.summary,
      classified: entry.classified,
      media,
      message: entry.message,
      allowAnalyticalPromotion: entry.decision === 'ignored' || entry.decision === 'unrecognized',
      // The complement of the flag above, and the reason both live on this one line: a message either
      // was refused by the rules — in which case the model may fill the gap — or it was published, in
      // which case the model may only annotate what was published, into a table nothing public reads
      // (`./analytical-enrichment.ts`, migration 045). Deriving both from `entry.decision` here is what
      // makes them exclusive by construction rather than by a rule two call sites have to remember.
      //
      // `entry.eventId` is set only on the branch that ran `ingestThreat`, and the decision is checked
      // anyway: a future branch that starts carrying an event id for some other reason must not
      // silently acquire the right to have the model write remarks against it.
      ...(PUBLISHING_DECISIONS.has(entry.decision) && entry.eventId
        ? {
            publishedClaim: {
              eventId: entry.eventId,
              threatType: entry.classified.threatType,
              // What the rules took out of THIS message, not what the event holds after every merge:
              // the enrichment write re-checks each proposed place against the event as it stands, so
              // this list only has to be the honest baseline of the current reading.
              locationIds: entry.classified.locations.map((location) => location.id),
              directionText: entry.classified.directionText ?? null,
              nationalScope: entry.classified.nationalScope
            }
          }
        : {}),
      historical: entry.historical
    });
  }
  classificationDecisions.inc({ version: entry.classifierVersion ?? CLASSIFIER_VERSION, decision: entry.decision });
  try {
    await recordClassification(entry);
  } catch (error) {
    classificationLogFailures.inc({ source: entry.sourceId });
    countChannelError(entry.sourceId, 'persist');
    console.warn(JSON.stringify({
      level: 'warn', msg: 'classification archive write failed', sourceId: entry.sourceId,
      decision: entry.decision, error: error instanceof Error ? error.message : String(error)
    }));
  }
  // Звірка й контекст — після архіву, поза транзакцією, і ніколи не коштують повідомленню нічого.
  if (entry.modelAssessment && entry.primaryInput) {
    await recordPrimaryComparison(entry.primaryInput, entry.sourceMessageId, entry.modelAssessment, entry.contextLocationIds ?? [])
      .catch(() => undefined);
  }
  await noteInLocationContexts(entry).catch(() => undefined);
}

export interface ProcessMessageOptions {
  /**
   * Marks the message as coming from an OSINT monitoring channel, which enables burst coalescing
   * and the per-source metric. It grants nothing: the alert reconciler is unreachable from here for
   * every caller alike.
   */
  monitor?: boolean;
  /**
   * The message is being replayed from the catch-up backfill rather than read live.
   *
   * Passed straight through to `ingestThreat`, which is where it means something: a message already
   * past its own thirty-minute validity window lands in the archive and appends nothing to
   * `system_event_log`, so it can reach neither the map nor a subscriber. Everything else on this
   * path — classification, the significance rejection, burst coalescing, the decision archive — is
   * deliberately identical for a replayed message and a live one.
   */
  historical?: boolean;
  /**
   * Вкладення, які ще качаються, коли класифікація вже почалася.
   *
   * Існує рівно для одного випадку: єдиний споживач файлу — тіньовий класифікатор, тобто
   * відʼєднаний шлях, який читає його ПІСЛЯ того, як подію записано й поштовх піднято. Колектор
   * (`src/sources/telegram.ts`) у цьому випадку не чекає на завантаження перед викликом, а віддає
   * сюди проміс; чекають на нього в {@link archiveClassification}, де файл і потрібен.
   *
   * Не другий спосіб передати `media`: коли на файл чекає ОСНОВНИЙ класифікатор, колектор
   * завантажує його сам і кладе в `message.media`, як і раніше, а це поле лишається порожнім.
   * Обидва поля заповненими не бувають.
   */
  pendingMedia?: Promise<NormalizedMessage['media']>;
}

/**
 * The measured wrapper around the classifier path.
 *
 * The body below is unchanged and lives in {@link classifyAndIngest}; this exists only so the two
 * observations have somewhere to stand that every caller passes through. The duration is taken in a
 * `finally` because four of the five terminal branches return early, and a per-branch call would
 * silently stop measuring the day a sixth branch is added.
 */
export async function processMessage(message: NormalizedMessage, options: ProcessMessageOptions = {}) {
  // Ingestion lag is measured from the source's own timestamp, not from ours: the number an operator
  // needs is "how old was this when we accepted it", and our clock cannot answer that.
  observeIngestionLag(message.sourceId, (Date.now() - message.publishedAt.getTime()) / 1000);
  // Рахується ТУТ, а не в `ingestThreat`: там лічильник побачив би лише ті повідомлення, що дійшли
  // до події, і мовчав би про застарілі, які правила відкинули раніше. Оператор питає «скільки
  // старого нам довозять», а не «скільки старого стало б подією».
  if (!withinDeliveryAge(message.publishedAt)) {
    staleForDelivery.inc({ source: message.sourceId, path: options.historical ? 'backfill' : 'live' });
  }
  const startedAt = Date.now();
  try {
    return await classifyAndIngest(message, options);
  } finally {
    observeClassificationDuration('classifier', (Date.now() - startedAt) / 1000);
  }
}

async function classifyAndIngest(message: NormalizedMessage, options: ProcessMessageOptions = {}) {
  // Кешований і той САМИЙ масив на кожне повідомлення: `indexFor` у класифікаторі мемоїзує індекс
  // за ідентичністю масиву, тож свіжий масив на кожен виклик означав повну переіндексацію каталогу
  // (~300k записів) на кожне повідомлення — саме це роздувало контейнер до гігабайтів під час атак.
  const locations = await cachedLocationLexemes();
  const rules = classifyMessage(message.text, locations);
  const count = (outcome: string) => {
    if (options.monitor) monitorMessages.inc({ source: message.sourceId, outcome });
  };
  const sourceInfo = await sourceDescriptor(message.sourceId);
  // Спільні для кожної гілки нижче поля архівного запису про модель (міграція 049). Порожні в режимі
  // `rules`; у режимі `codex` — наповнюються після виклику моделі, який стоїть ПІСЛЯ відбою правил:
  // відбій — єдине рішення, яке модель не ухвалює.
  let classified = rules;
  let primaryInput: CodexClassifyInput | undefined;
  let modelAssessment: ModelAssessment | null = null;
  let modelClassified = false;
  let modelSuppressed = false;
  let contextLocationIds: string[] | undefined;
  const modelFields = () => ({
    primaryInput, modelAssessment, modelClassified, contextLocationIds,
    sourceName: sourceInfo?.name ?? null,
    ...(modelClassified ? { classifierVersion: CODEX_CLASSIFIER_VERSION } : {}),
    assessment: modelAssessment ? {
      model: modelAssessment.model, confidence: modelAssessment.confidence, timing: modelAssessment.timing,
      probability: modelAssessment.probability, note: modelAssessment.note
    } : null
  });
  // A source withdrawing its own earlier claim — "ТУшки неактивні", "ціль знищена", "не відмічаємо
  // ознак застосування стратегічної авіації". This is the only evidence a publisher ever gives that
  // a threat is over; before it moved state, a threat could fade only on the 30-minute timer.
  //
  // What it retracts is bounded by the publisher: `applyDeEscalation` closes this source's own
  // assertions and decays this source's own risk signals, and an event ends only when nothing holds
  // it any more. Nothing here reaches `alert_source_states` or `alert_periods` — an OSINT channel
  // cannot publish an "Офіційний відбій".
  if (isDeEscalation(classified)) {
    const outcome = await applyDeEscalation(message, classified);
    count('de_escalation');
    threatWithdrawals.inc({
      source: message.sourceId,
      outcome: outcome.withdrawal.endedEventIds.length ? 'event_withdrawn'
        : outcome.withdrawal.withdrawnAssertions ? 'assertions_withdrawn' : 'nothing_asserted'
    });
    // Only when something was actually live and is now not: a withdrawal that closed nothing is a
    // publisher tidying up, and counting it here would bury the transitions that matter.
    if (outcome.withdrawal.endedEventIds.length) {
      threatToDeEscalation.inc({ source: message.sourceId, version: CLASSIFIER_VERSION });
    }
    await archiveClassification({
      sourceId: message.sourceId, sourceMessageId: outcome.sourceMessageId,
      publishedAt: message.publishedAt, classified, decision: 'de_escalation', media: message.media,
      message, historical: options.historical, pendingMedia: options.pendingMedia,
      withdrawal: outcome.withdrawal, ...modelFields()
    });
    return { deEscalation: true as const, classified, withdrawal: outcome.withdrawal };
  }
  // Модель як основний класифікатор (міграція 049). Стоїть ПІСЛЯ відбою правил — модель не має права
  // оголосити, що загрози немає, — і ПЕРЕД перевіркою значущості, бо саме значущість вона й вирішує.
  // Кожен запасний вихід (`fallback`) лишає класифікацію правил недоторканою: повідомлення не губиться.
  if ((await codexClassifierMode()) === 'codex') {
    primaryInput = { message, rules, lexemes: locations, source: sourceInfo };
    const primary = await classifyWithCodex(primaryInput);
    contextLocationIds = primary.contextLocationIds;
    if (primary.status !== 'fallback') {
      classified = primary.classified;
      modelAssessment = primary.assessment;
      modelClassified = true;
      modelSuppressed = primary.status === 'suppressed';
    }
  }
  const rejection = significanceRejection(classified);
  if (rejection) {
    const sourceMessageId = await recordUnprocessedMessage(message, 'ignored');
    count('ignored');
    // «Модель придушила» — не «правила не впізнали твердження». Обидва повертають
    // `not_an_assertion`, бо `notSignificant` будує класифікацію з `intent:'none'`, і на лічильнику
    // вони зливалися в одне слово: оператор не міг відрізнити «словник каналу поїхав» від «модель
    // мовчить саме про цей канал». Слово те саме, що вже пише архів у `ignored_reason` нижче, —
    // один факт має мати одну назву, у якій би поверхні його не читали.
    classificationRejections.inc({
      source: message.sourceId, reason: modelSuppressed ? 'model_not_significant' : rejection
    });
    // Місце, якого каталог не має, — єдина причина відмови, з якої можна щось ПОЧИНИТИ, і єдина, з
    // якої досі не лишалося назви. Лише для моніторингових каналів: офіційні фіди називають місце
    // полем, і їхні назви вже їдуть через `recordUnresolvedLocations`.
    if (rejection === 'no_location' && options.monitor) {
      recordUnknownPlaces(message.sourceId, unknownPlaceCandidates(message.text));
    }
    await archiveClassification({
      sourceId: message.sourceId, sourceMessageId, publishedAt: message.publishedAt, classified,
      media: message.media,
      message, historical: options.historical, pendingMedia: options.pendingMedia,
      // "Recognised nothing", "recognised something that is nowhere" and "recognised a report about
      // last night" are three different findings: the first says the vocabulary has drifted or the
      // message was never about a threat, the second says the place is missing from the catalogue,
      // and the third says the rules read the message as retrospective and refused it. Collapsing
      // them into one word is what made "why was this ignored?" unanswerable. `ignored_reason` keeps
      // the precise rejection either way; `decision` is the coarse split a dashboard groups on, and
      // the retrospective one is kept apart because it is the only refusal that discards a message
      // in which a threat *and* a place were both recognised.
      decision: rejection === 'retrospective' ? 'ignored_retrospective'
        : rejection === 'no_location' ? 'ignored' : 'unrecognized',
      // «Модель упевнено не побачила загрози» — своя причина, бо відтворюється не правилами, а
      // моделлю в той момент, і саме це має прочитати той, хто розбирає, чому повідомлення змовчали.
      ignoredReason: modelSuppressed ? 'model_not_significant' : rejection, ...modelFields()
    });
    return { ignored: true as const };
  }
  if (options.monitor && shouldCoalesce(coalesceKey(message.sourceId, classified), Date.now())) {
    // Kept as provenance with its own status: the text is preserved and auditable, it simply does
    // not raise the event again.
    const sourceMessageId = await recordUnprocessedMessage(message, 'coalesced');
    count('coalesced');
    await archiveClassification({
      sourceId: message.sourceId, sourceMessageId, publishedAt: message.publishedAt, classified,
      decision: 'coalesced', ignoredReason: 'restated_within_coalesce_window', media: message.media,
      message, historical: options.historical, pendingMedia: options.pendingMedia, ...modelFields()
    });
    return { coalesced: true as const };
  }
  // The grey band, and the only model call in this codebase that is awaited on the ingestion path.
  //
  // It sits here — after coalescing, before `ingestThreat` — for three reasons. After coalescing,
  // because a restatement inside the burst window publishes nothing anyway and paying a model call
  // to suppress a suppression would be spending quota during an attack for no effect. Before
  // `ingestThreat`, because the alternative is publishing and retracting, and a threat that appears
  // on the map and in a subscriber's Telegram and then vanishes is worse than the false positive it
  // was meant to fix. And outside `ingestThreat` rather than inside it, because that function opens
  // the transaction: a slow model must not hold a database connection or a row lock.
  //
  // `retrospectiveGate` never throws and never returns `archive` for anything the classifier did not
  // already mark `suspect`. Off, over quota, unreachable, slow, or answering prose — every one of
  // those is `publish`, which is exactly what this line does when the branch is not taken. See
  // `src/services/retrospective-gate.ts` for why that is structural rather than a convention.
  if (classified.retrospective?.verdict === 'suspect') {
    const gate = await retrospectiveGate({
      sourceId: message.sourceId, text: message.text, classified
    });
    if (gate.verdict === 'archive') {
      const sourceMessageId = await recordUnprocessedMessage(message, 'ignored');
      count('ignored');
      // A rejection reason of its own, and deliberately not `retrospective`: that word means the
      // rules refused the message and a replay reproduces the refusal. This one is a model's opinion
      // at one moment and reproduces as nothing, which is precisely what somebody auditing a
      // suppression needs to be told before they read anything else.
      classificationRejections.inc({ source: message.sourceId, reason: 'retrospective_model' });
      await archiveClassification({
        sourceId: message.sourceId, sourceMessageId, publishedAt: message.publishedAt, classified,
        decision: 'ignored_retrospective_model', ignoredReason: 'retrospective_model', media: message.media,
        message, historical: options.historical, pendingMedia: options.pendingMedia, ...modelFields()
      });
      return { ignored: true as const };
    }
  }
  count('classified');
  const result = await ingestThreat(message, classified, {
    historical: options.historical,
    ...(modelAssessment ? { assessment: {
      model: modelAssessment.model, classifierVersion: modelAssessment.classifierVersion,
      timing: modelAssessment.timing, probability: modelAssessment.probability,
      expectedFrom: modelAssessment.expectedFrom, expectedUntil: modelAssessment.expectedUntil,
      note: modelAssessment.note
    } } : {})
  });
  // Миттєве поширення для ЖИВОЇ загрози — те саме, що `alert.started` має відтоді, як зʼявився
  // `./alert-poke.ts`, і чого не мав моніторинговий шлях. Ціна мовчання тут детермінована: тік
  // хаба SSE (1 с, `src/services/sse.ts`) плюс тік фан-ауту (1 с, `src/bot/outbox.ts`) плюс тік
  // відправника (1 с) — нуль-три секунди на попередженні, яке часто є ЄДИНИМ, що існує, бо влада
  // ще не заговорила.
  //
  // Дві умови, і жодна не є здогадкою про зміст:
  //
  //  * `result.published` — транзакція справді дописала рядок у `system_event_log`. Повідомлення
  //    старше за стелю віку, дублікат і злиття-без-змін не пишуть нічого, і будити двох опитувачів
  //    заради порожнього SELECT — чиста витрата;
  //  * `timing === 'now'` — подія є живою загрозою. Очікувана («увечері очікується») за
  //    `CONTEXT.md` живою загрозою не є: вона не заливає територію, йде тихим повідомленням без
  //    заклику в укриття, і купувати для неї секунду немає з чого. Подія правил — завжди «зараз»
  //    (там `modelAssessment` порожній), тож режим `rules` поводиться так, наче цього рядка немає.
  //
  // Відбій, де-ескалація й повтор у вікні склеювання сюди не доходять зовсім: обидві гілки
  // повертаються вище. І сам поштовх не змінює НІЧОГО, крім моменту опитування: затримка публікації
  // живе в SELECT хаба (`sse.ts`), і жоден рядок тут її не торкається.
  if (result.published && (modelAssessment?.timing ?? 'now') === 'now') pokeLiveThreat();
  if (result.withdrawal.withdrawnAssertions || result.withdrawal.endedEventIds.length) {
    threatWithdrawals.inc({
      source: message.sourceId,
      outcome: result.withdrawal.endedEventIds.length ? 'event_withdrawn' : 'assertions_withdrawn'
    });
  }
  await archiveClassification({
    sourceId: message.sourceId, sourceMessageId: result.sourceMessageId,
    publishedAt: message.publishedAt, classified, media: message.media,
    message, historical: options.historical, pendingMedia: options.pendingMedia,
    // `redirect` keeps its own decision because it is the only message class that asserts and
    // withdraws at once; `createdEvent` still records whether the event it asserted was new.
    decision: classified.intent === 'redirect' ? 'redirect' : result.created ? 'event_created' : 'event_merged',
    eventId: result.id, createdEvent: result.created, withdrawal: result.withdrawal, ...modelFields()
  });
  return result;
}

export async function seedDemoData(): Promise<void> {
  if (!config.DEMO_SOURCE_ENABLED) return;
  const live = await pool.query(
    `SELECT 1 FROM threat_events e JOIN event_evidence ee ON ee.event_id=e.id
     JOIN source_messages sm ON sm.id=ee.source_message_id
     WHERE sm.source_id='demo' AND e.status IN ('observed','confirmed','active') AND e.valid_until>now() LIMIT 1`
  );
  if (live.rowCount) {
    await markSourceSuccess('demo');
    return;
  }
  const publishedAt = new Date();
  const demos = [
    'Ударні БпЛА у напрямку Київської області. Демонстраційне повідомлення.',
    'Загроза балістики для Полтавщини. Демонстраційне повідомлення.'
  ];
  for (const [index, text] of demos.entries()) {
    await processMessage({
      sourceId: 'demo',
      externalId: `demo-${publishedAt.getTime()}-${index}-${createHash('sha1').update(text).digest('hex').slice(0, 8)}`,
      publishedAt: new Date(publishedAt.getTime() - index * 180_000),
      text,
      rawPayload: { demo: true }
    });
  }
  await markSourceSuccess('demo');
}

// ------------------------------------------------------------------------------------------------
// The collection scheduler
// ------------------------------------------------------------------------------------------------

/**
 * Per-provider polling floors, in seconds. Compiled constants, deliberately NOT settings.
 *
 * Each one is a property of somebody else's server: a published rate limit, or a published cache
 * duration past which a faster poll returns the byte-identical body. An operator may slow the alert
 * legs down with `ALERT_POLL_INTERVAL_SECONDS` and may not speed any of them past its provider's
 * floor, because the consequence of getting that wrong is a 429 — or a blocked token — during the
 * one hour of the year the source matters. The provenance of each number is written out beside
 * `ALERT_POLL_INTERVAL_SECONDS` in `src/config.ts`; the summary is:
 *
 *   * mirror — 3 s, its own documented cache TTL (2 rps/host published separately).
 *   * alerts.in.ua — 7 s = 8.6 req/min, inside the 8–10 soft band and the 12/min hard limit.
 *   * Ukraine Alarm — 15 s, because NOTHING is documented and an undocumented budget is not a budget
 *     to spend against.
 */
export const AERIAL_MIRROR_MIN_POLL_SECONDS = 3;
export const ALERTS_IN_UA_MIN_POLL_SECONDS = 7;
export const UKRAINE_ALARM_MIN_POLL_SECONDS = 15;

/**
 * Cadence of the legs that are not alert STATE.
 *
 * The alert-channel backstop is a sweep over `alert_source_states`, not a request to anybody: it
 * costs one statement and it exists to catch a 🟢 that never arrived, bounded by
 * `ALERT_CHANNEL_MAX_ALERT_SECONDS` — a full day. Running it four times faster would change nothing
 * about when it fires and would add a statement to the pool the fast legs now share. It stays where
 * the old shared interval had it.
 */
export const SLOW_LEG_INTERVAL_SECONDS = 15;

/**
 * Pure. The gap in force for one alert leg: the operator's cadence, clamped up by that provider's
 * floor.
 *
 * Exported because it is the whole of «чому дзеркало опитується частіше за Ukraine Alarm» and the
 * one thing a test of the floors has to be able to call without a scheduler.
 */
export function alertLegIntervalMs(floorSeconds: number): number {
  return Math.max(config.ALERT_POLL_INTERVAL_SECONDS, floorSeconds) * 1000;
}

/**
 * The legs, split by what they are: alert STATE on a fast per-provider cadence, everything else at
 * fifteen seconds.
 *
 * Exported for the unit tests, which assert the split and the floors without arming a timer.
 */
export function ingestionLegs(log: { info: Function; warn: Function; error: Function }): SchedulerLeg[] {
  return [
    // ---- alert state, fast --------------------------------------------------------------------
    {
      // Обидва фіди дзеркала — в ОДНІЙ нозі, послідовно. Не двома ногами з двома розкладами: вони
      // б'ють в один хост, а планувальник не координує ноги між собою, тож дві ноги рано чи пізно
      // збіглися б в одну мілісекунду — рівно та пара запитів усередині секунди, на якій дзеркало
      // віддає обрізане тіло. Пауза між ними — той самий `AERIAL_MIRROR_REQUEST_GAP_MS`.
      name: 'aerial-mirror',
      run: () => syncAerialMirrorPair(log),
      intervalMs: () => alertLegIntervalMs(AERIAL_MIRROR_MIN_POLL_SECONDS)
    },
    {
      name: 'alerts-in-ua',
      run: () => syncAlertsInUa(log),
      intervalMs: () => alertLegIntervalMs(ALERTS_IN_UA_MIN_POLL_SECONDS)
    },
    {
      name: 'ukraine-alarm',
      run: () => syncOfficialAlerts(log),
      intervalMs: () => alertLegIntervalMs(UKRAINE_ALARM_MIN_POLL_SECONDS)
    },
    // ---- everything else, unchanged ------------------------------------------------------------
    // The channel is pushed to, not polled; the only thing the scheduler owes it is the
    // maximum-duration backstop, which has to run whether or not any message arrives.
    {
      name: 'alert-channel-backstop',
      run: () => expireStuckAlertChannelAlerts(log),
      intervalMs: () => SLOW_LEG_INTERVAL_SECONDS * 1000
    }
  ];
}

/**
 * Starts one self-rescheduling chain per leg.
 *
 * ## What replaced `Promise.allSettled` over one `setInterval`, and why the guarantee survived
 *
 * The old shape ran all four legs inside one tick and needed `allSettled` rather than `all` for a
 * specific reason: `all` settles at the FIRST rejection and leaves the others running, so the shared
 * `finally { running = false }` released the overlap guard with a nationwide snapshot still
 * half-applied — and a rejection is the *normal* case here, because every sync function rethrows
 * after `markSourceError`. A second `persistOfficialAlertSnapshot` starting concurrently with the
 * first can compute the aggregate from a half-applied snapshot and produce a spurious «Офіційний
 * відбій» / re-open pair.
 *
 * That hazard is unchanged and so is the protection, by a stronger mechanism: each leg's next pass
 * is armed in the `finally` of its previous one, so no timer exists while a pass is in flight and a
 * second pass of the same leg is unrepresentable rather than merely refused. What the split removes
 * is the accidental half of the old guard — one leg's slow upstream no longer suppresses the other
 * three, which is exactly the case that used to cost fifteen seconds of every leg's freshness.
 *
 * Two legs of DIFFERENT sources can now overlap, and their alert-state transactions still cannot:
 * each opens with `ALERT_STATE_LOCK`, so a snapshot pass, a channel message and the backstop run
 * one at a time. The `FOR UPDATE` on the shared `alert_periods` row was not enough on its own — it
 * is taken after the aggregate is read, and two sources took those row locks in opposite orders and
 * deadlocked; see {@link ALERT_STATE_LOCK}.
 */
export function startIngestionScheduler(
  log: { info: Function; warn: Function; error: Function },
  deps: Parameters<typeof startLegScheduler>[2] = {}
): () => void {
  return startLegScheduler(ingestionLegs(log), log, deps);
}
