import { THREAT_TYPES } from '../types.js';
import { tokenize, type PlaceToken } from './place-morphology.js';
import {
  COARSE_TYPES, COMBINED_WIDEN_MAX_KM, greatCircleKm, mergeReachKm, reportPositions, trackWindow,
  type ReportedPlace
} from './threat-motion.js';

/**
 * До якої живої події приєднується нове повідомлення про загрозу. Правило чисте й детерміноване:
 * жодної бази, жодної моделі, жодного годинника. `ingestThreat` (`src/repositories/events.ts`)
 * збирає кандидатів і їхні місця двома обмеженими запитами, а вирішує тут.
 *
 * Раніше подія приймала будь-яке повідомлення того самого класу, що ділило з нею хоч одне місце,
 * тридцять хвилин від останньої згадки. Тому спільна область склеювала різні групи, одна подія йшла
 * Славутич → Чорнобиль → Київ → Кропивницький (Київ → Кропивницький — 250 км за 116 с), а одна група
 * розпадалася на `uav`, `unknown` і `combined`, бо клас мусив збігтися дослівно. Тепер повідомлення
 * приєднується до події, лише коли виконано все:
 *
 *  1. **Класи сумісні.** Той самий клас; або один бік `unknown`, а другий конкретний; або `combined`
 *     і один із класів, з яких комбінована атака складається (`uav`, `cruise_missile`,
 *     `ballistic_missile`). Злиття клас лише уточнює і ніколи не звужує: подія `unknown` бере клас
 *     повідомлення, одиничний клас із повідомленням `combined` стає `combined`.
 *  2. **Подія свіжа.** Від її останнього спостереження до часу повідомлення минуло не більше за
 *     горизонт її класу — ті самі вікна, що ріжуть трек (`TRACK_WINDOW_MINUTES`). Виняток —
 *     очікувана подія (не «зараз») з відкритим вікном: її новина стосується вікна, а не останньої
 *     згадки, тож вона зливається як завжди — той самий клас і хоч одне спільне місце.
 *  3. **Місце те саме або досяжне.** Позиція повідомлення — місце, куди воно ставить ціль
 *     (`reportPositions`, ті самі позиції, що стають вузлами треку), — або збігається з однією з
 *     ПОТОЧНИХ позицій події міського, громадського чи районного рівня (з повідомлень у вікні її
 *     класу), або досяжна з голови події — найконкретнішого місця її найновішої класифікації.
 *     Досяжність — суворіша з двох класів (`mergeReachKm`): для того, що летить, — стеля швидкості ×
 *     час, ті самі числа, що рвуть трек; для вогню, який з області в область не летить, — стала межа:
 *     40 км для реактивної, ствольної артилерії й мінометів, 70 км для КАБ. Комбіноване зведення
 *     розширює подію крилатих ракет чи балістики лише в межах 150 км від її голови. Спільна область
 *     сама по собі не зливає нічого, хіба що і повідомлення, і подія називають лише області. Місце
 *     без координат порівнюється лише назвою.
 *  4. **Кілька кандидатів** — перемагає найближча голова, потім найсвіжіша подія.
 *
 * Повідомлення, що називає кілька місць для різних груп («6 на Бровари, 3 на Бориспіль»), не
 * ділиться: воно приєднується щонайбільше до однієї події або створює одну, як і раніше. Судить його
 * та сама позиція, яку з нього взяв би трек, тож зведення по кількох областях приєднується до групи,
 * біля якої воно ставить ціль, а не до першої події, з якою ділить хоч якусь назву.
 */

/** Місце каталогу таким, яким його бачить правило: тип і точка [довгота, широта], якщо є. */
export interface MergePlace {
  id: string;
  type: string;
  point: readonly [number, number] | null;
}

/** Місця одного повідомлення. */
export interface MergePlaces {
  /** Куди воно ставить ціль: одне місце або пара «звідки → куди» (`reportPositions`). */
  positions: readonly MergePlace[];
  /** Усе, що воно стверджує: позиції й контекст («Київщина» поруч із «Бровари»). */
  named: readonly MergePlace[];
}

/** Одна класифікація події з архіву. */
export interface MergeReport extends MergePlaces {
  atMs: number;
}

export interface MergeMessage extends MergePlaces {
  threatType: string;
  atMs: number;
}

export interface MergeCandidate {
  id: string;
  threatType: string;
  lastObservedAtMs: number;
  /** Очікувана подія (`timing <> 'now'`) з відкритим вікном (`expected_until > now()`). */
  expectedOpen: boolean;
  /** Місця, до яких подію прив'язано (`threat_event_locations`), за весь її вік. */
  attached: MergePlaces;
  /** Її класифікації з архіву (`message_classifications`), у будь-якому порядку. */
  reports: readonly MergeReport[];
}

export interface MergeDecision {
  eventId: string;
  /** Клас події після злиття. */
  threatType: string;
  /** Від голови події до найближчої позиції повідомлення, км; `null` — виміряти нема чим. */
  distanceKm: number | null;
  basis: 'expected_window' | 'same_place' | 'coarse_only' | 'reachable';
}

/** Місце, як його приносить запит: рядок архіву класифікацій разом із каталогом. */
export interface MergeRow extends ReportedPlace {
  location_id: string;
  point: readonly [number, number] | null;
}

/**
 * Місця одного повідомлення для правила. Позиції — `reportPositions` над тими самими рядками, що
 * й у треку; текст читається лише тоді, коли треба розрізнити однаково конкретні місця.
 */
export function mergePlaces(rows: readonly MergeRow[], redirect: boolean, text: string): MergePlaces {
  let tokens: PlaceToken[] | null = null;
  const plan = reportPositions(rows, redirect, () => tokens ??= tokenize(text.toLocaleLowerCase('uk-UA')));
  const place = (row: MergeRow): MergePlace => ({ id: row.location_id, type: row.location_type, point: row.point });
  return {
    positions: (plan?.positions ?? []).map(place),
    named: rows.filter((row) => row.role === 'asserted').map(place)
  };
}

/** Складники комбінованої атаки: лише з ними `combined` буває однією групою. */
const COMBINED_PARTS: Readonly<Record<string, true>> = { uav: true, cruise_missile: true, ballistic_missile: true };

/**
 * Клас події після того, як до події класу `eventType` приєдналося повідомлення класу `messageType`,
 * або `null`, коли ці два класи однією групою не бувають.
 *
 * Лише уточнення, ніколи не звуження. `unknown` — це «джерело клас не назвало», а не окремий клас, і
 * повідомлення без класу про ту саму групу нічого з події не забирає. `combined` поглинає свій
 * складник у будь-якому порядку: повідомлення «ракети й дрони на Київ» у події БпЛА називає ракети, і
 * подія, що лишилася б «БпЛА», сховала б їх від читача.
 */
export function joinedThreatType(eventType: string, messageType: string): string | null {
  if (eventType === messageType || messageType === 'unknown') return eventType;
  if (eventType === 'unknown') return messageType;
  if ((eventType === 'combined' && COMBINED_PARTS[messageType]) || (messageType === 'combined' && COMBINED_PARTS[eventType])) {
    return 'combined';
  }
  return null;
}

/** Класи подій, до яких повідомлення цього класу може приєднатися, — фільтр запиту кандидатів. */
export function mergeableEventTypes(messageType: string): string[] {
  return THREAT_TYPES.filter((eventType) => joinedThreatType(eventType, messageType) !== null);
}

/**
 * Голова події, як у треку: позиція її найновішої класифікації — перша позиція пари, бо друга є
 * курсом. Область чи країна головою не стають, поки у вікні є щось конкретніше: їхня точка — не
 * місце, де щось було. Кілька класифікацій з одним часом дають кілька голів.
 */
function headOf(reports: readonly MergeReport[]): { atMs: number; places: MergePlace[] } {
  const fine = (place: MergePlace) => !COARSE_TYPES[place.type];
  const measured = reports.filter((report) => report.positions.some(fine));
  const pool = measured.length ? measured : reports;
  const atMs = Math.max(...pool.map((report) => report.atMs));
  const places: MergePlace[] = [];
  for (const report of pool) {
    if (report.atMs !== atMs) continue;
    const head = measured.length ? report.positions.find(fine) : report.positions[0];
    if (head) places.push(head);
  }
  return { atMs, places };
}

/**
 * Найменша відстань від голови до позицій повідомлення, км, або `null`, коли не виміряно жодної пари.
 * Те саме місце — нуль і без координат. Область чи країна не вимірюються.
 */
function nearestKm(head: readonly MergePlace[], positions: readonly MergePlace[]): number | null {
  let nearest: number | null = null;
  for (const from of head) {
    for (const to of positions) {
      const distance = from.id === to.id ? 0
        : from.point && to.point && !COARSE_TYPES[from.type] && !COARSE_TYPES[to.type]
          ? greatCircleKm(from.point, to.point) : null;
      if (distance !== null && (nearest === null || distance < nearest)) nearest = distance;
    }
  }
  return nearest;
}

function judge(message: MergeMessage, candidate: MergeCandidate): MergeDecision | null {
  const threatType = joinedThreatType(candidate.threatType, message.threatType);
  if (threatType === null) return null;
  // Якщо архів ще не має жодної класифікації події (її повідомлення закомічене, а рядок архіву
  // пишеться вже після COMMIT), або подію створила промоція моделі, яка в цей архів не пише, подія
  // стоїть на своїх прив'язаних місцях станом на останнє спостереження. Правило ніколи не лишається
  // зовсім без місць події.
  const fallback: MergeReport = { atMs: candidate.lastObservedAtMs, ...candidate.attached };

  if (candidate.expectedOpen) {
    if (candidate.threatType !== message.threatType) return null;
    const attached = new Set(candidate.attached.named.map((place) => place.id));
    if (!message.named.some((place) => attached.has(place.id))) return null;
    const head = headOf(candidate.reports.length ? candidate.reports : [fallback]);
    return {
      eventId: candidate.id, threatType: candidate.threatType,
      distanceKm: nearestKm(head.places, message.positions), basis: 'expected_window'
    };
  }

  const horizonMs = trackWindow(candidate.threatType).horizonSeconds * 1000;
  if (Math.abs(message.atMs - candidate.lastObservedAtMs) > horizonMs) return null;
  const inWindow = candidate.reports.filter((report) => report.atMs >= message.atMs - horizonMs);
  const current = inWindow.length ? inWindow : [fallback];
  const head = headOf(current);
  const positions = message.positions.filter((place) => !COARSE_TYPES[place.type]);
  const currentPositions = new Set(current.flatMap((report) => report.positions).map((place) => place.id));
  const distanceKm = nearestKm(head.places, positions);
  const decision = (basis: MergeDecision['basis']): MergeDecision => ({ eventId: candidate.id, threatType, distanceKm, basis });

  if (positions.some((place) => currentPositions.has(place.id))) return decision('same_place');
  const currentNamed = current.flatMap((report) => report.named);
  const coarseOnly = (places: readonly MergePlace[]) => places.every((place) => COARSE_TYPES[place.type]);
  if (coarseOnly(message.named) && coarseOnly(currentNamed)
    && message.named.some((place) => currentNamed.some((named) => named.id === place.id))) {
    return decision('coarse_only');
  }
  // Одна ціль, яку описують обидва повідомлення, мусить укластися в досяжність обох класів, тож міряє
  // суворіша з двох (`mergeReachKm`). Досяжність класу після злиття тут не годиться: `combined` чи
  // `unknown` мають 1000 км/год, і повідомлення цих класів склеювали б групу БпЛА з усім у радіусі
  // кількох сотень кілометрів; а стала межа вогню (артилерія, КАБ) вирішує, хоч би яким був другий клас.
  const elapsedMs = message.atMs - head.atMs;
  let reachKm = Math.min(mergeReachKm(candidate.threatType, elapsedMs), mergeReachKm(message.threatType, elapsedMs));
  // Зведення, що розширило б подію ракет до `combined`, мусить стояти біля її голови: інакше його
  // остання позиція — найімовірніше, чужа група наприкінці переліку.
  if (threatType === 'combined' && (candidate.threatType === 'cruise_missile' || candidate.threatType === 'ballistic_missile')) {
    reachKm = Math.min(reachKm, COMBINED_WIDEN_MAX_KM);
  }
  if (distanceKm !== null && distanceKm <= reachKm) {
    return decision('reachable');
  }
  return null;
}

/**
 * Подія, до якої приєднується повідомлення, або `null` — тоді воно створює нову. Серед кількох
 * придатних перемагає найближча голова, потім найсвіжіше спостереження, потім id — щоб той самий
 * вхід завжди давав ту саму відповідь.
 */
export function chooseMergeTarget(message: MergeMessage, candidates: readonly MergeCandidate[]): MergeDecision | null {
  let chosen: { decision: MergeDecision; candidate: MergeCandidate } | null = null;
  for (const candidate of candidates) {
    const decision = judge(message, candidate);
    if (!decision) continue;
    const distance = decision.distanceKm ?? Number.POSITIVE_INFINITY;
    const best = chosen?.decision.distanceKm ?? Number.POSITIVE_INFINITY;
    const better = !chosen || distance < best || (distance === best && (
      candidate.lastObservedAtMs > chosen.candidate.lastObservedAtMs
      || (candidate.lastObservedAtMs === chosen.candidate.lastObservedAtMs && candidate.id < chosen.candidate.id)
    ));
    if (better) chosen = { decision, candidate };
  }
  return chosen?.decision ?? null;
}
