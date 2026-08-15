import { pool } from '../db/pool.js';
import { buildLocationLabels, type LocationRow } from '../domain/location-label.js';

/**
 * Підписи каталогу, полічені раз і перечитувані рідко.
 *
 * Правило живе в `src/domain/location-label.ts` і залежить від УСЬОГО каталогу: щоб вирішити, чи
 * потрібне «Миколаїв» уточнення, треба знати, чи є в країні другий Миколаїв. Обходити 652 рядки на
 * кожне сповіщення — марно, а фан-аут проходить раз на секунду.
 *
 * Стан тут обмежений за побудовою: рівно один запис на локацію, тобто стеля — розмір каталогу, а не
 * трафіку. Це не кеш відповідей і не черга; він не росте від того, що приходить більше повідомлень.
 *
 * Каталог змінюється лише під час синхронізації KATOTTG, тож година свіжості з запасом покриває
 * будь-яку правку, а до того моменту нове місто просто зветься власною назвою — це і є поведінка
 * без уточнення, а не помилка.
 */
const CATALOGUE_TTL_MS = 60 * 60 * 1000;

/**
 * Підписи й самі рядки з одного завантаження.
 *
 * Обидва потрібні одному й тому самому викликачеві: підпис — щоб назвати місце однозначно, рядки —
 * щоб `scopeToSubscription` могла пройти ланцюгом предків і лишити читачеві тільки його напрямок.
 * Два кеші означали б два запити й два моменти свіжості для одного факту.
 */
export interface LocationCatalogue {
  labels: Map<string, string>;
  rows: LocationRow[];
}

const EMPTY: LocationCatalogue = { labels: new Map(), rows: [] };

let cached: LocationCatalogue | null = null;
let loadedAt = 0;
let inFlight: Promise<LocationCatalogue> | null = null;

/**
 * Мапа `id → підпис`.
 *
 * Паралельні виклики під час першого завантаження діляться однією обіцянкою: фан-аут і доставка
 * ходять сюди незалежно, і два запити до каталогу замість одного нічого б не купили.
 *
 * Помилка читання НЕ кидається далі: підпис — це уточнення, а не сама новина, і сповіщення про
 * тривогу не має падати через те, що довідник тимчасово недоступний. Порожня мапа означає «без
 * уточнень», тобто рівно ту поведінку, яка була до цього модуля.
 */
export async function locationCatalogue(now = Date.now()): Promise<LocationCatalogue> {
  if (cached && now - loadedAt < CATALOGUE_TTL_MS) return cached;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const result = await pool.query<LocationRow>(
        `SELECT id,name_uk,type,parent_id FROM locations`
      );
      cached = { labels: buildLocationLabels(result.rows), rows: result.rows };
      loadedAt = now;
      return cached;
    } catch {
      return cached ?? EMPTY;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Скидає кеш. Потрібен інтеграційним тестам, які правлять каталог між випадками. */
export function resetLocationCatalogue(): void {
  cached = null;
  loadedAt = 0;
  inFlight = null;
}
