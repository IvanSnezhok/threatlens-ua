import { pool } from '../db/pool.js';
import { ORIGIN_ZONES, originZoneById } from '../domain/origin-zones.js';
import type { OriginZoneId } from '../types.js';

/**
 * Зони походження, які джерела називали останнім часом.
 *
 * Це НЕ подія і не стан території: жодна зона нікого не тримає під тривогою, не входить у ризик і не
 * породжує сповіщення. Вона відповідає рівно на одне питання — «звідки останнім часом повідомляли
 * активність» — і живе окремо від усього, що стверджує стан всередині країни. Саме тому й окремий
 * сервіс: перемішати її з `territories[]` означало б, що акваторія Чорного моря починає поводитися
 * як область.
 */

/**
 * Скільки зона лишається «активною» після останньої згадки.
 *
 * Дев'яносто хвилин — це приблизна тривалість одного епізоду: від «зліт» чи «пуски з акваторії» до
 * того, як усе, що злетіло, доходить до цілей або збивається. Довше вікно лишало б іконку висіти над
 * морем після того, як епізод скінчився, — а це рівно та форма брехні, з якою боровся детектор тиші
 * колектора: показувати як актуальне те, що ним уже не є.
 */
const ORIGIN_ACTIVITY_WINDOW_MS = 90 * 60 * 1000;

export interface OriginZoneActivity {
  zoneId: OriginZoneId;
  name: string;
  /** [довгота, широта] — грубий якір зони, не позиція чогось. */
  anchor: [number, number];
  /** Класи зброї, названі разом із зоною. Порожній масив, якщо жоден не розпізнано. */
  threatTypes: string[];
  lastReportedAt: string;
  /** Скільки повідомлень назвали зону у вікні, і скільки незалежних джерел за ними стоїть. */
  reports: number;
  sources: number;
}

/**
 * Зони, названі у вікні активності, найсвіжіші першими.
 *
 * Читає лише `message_classifications` — тобто те, що вже вичитано з тексту, — і не звертається ні
 * до подій, ні до тривог. Порожній масив тут абсолютно нормальний: більшість повідомлень походження
 * не називає, і тиша в цьому списку означає «джерела не сказали звідки», а не «нічого не летить».
 */
export async function activeOriginZones(now = new Date()): Promise<OriginZoneActivity[]> {
  const since = new Date(now.getTime() - ORIGIN_ACTIVITY_WINDOW_MS);
  const { rows } = await pool.query<{
    origin_zone: string;
    threat_types: string[] | null;
    last_reported_at: Date;
    reports: string;
    sources: string;
  }>(
    `SELECT origin_zone,
            array_remove(array_agg(DISTINCT threat_type), NULL) AS threat_types,
            max(published_at) AS last_reported_at,
            count(*) AS reports,
            count(DISTINCT source_id) AS sources
       FROM message_classifications
      WHERE origin_zone IS NOT NULL
        AND published_at > $1
      GROUP BY origin_zone
      ORDER BY max(published_at) DESC`,
    [since]
  );

  const activity: OriginZoneActivity[] = [];
  for (const row of rows) {
    // Зона, якої вже немає в каталозі, мовчки випадає. Ідентифікатори стабільні, але перейменування
    // або вилучення зони не має валити знімок: рядок в архіві лишається, а на карті його просто
    // немає — і це чесніше, ніж намалювати точку, для якої немає ні назви, ні якоря.
    const zone = originZoneById(row.origin_zone);
    if (!zone) continue;
    activity.push({
      zoneId: zone.id,
      name: zone.name,
      anchor: zone.anchor,
      threatTypes: row.threat_types ?? [],
      lastReportedAt: row.last_reported_at.toISOString(),
      reports: Number(row.reports),
      sources: Number(row.sources)
    });
  }
  return activity;
}

/** Каталог для довідки — щоб фронт міг підписати зону, якої зараз немає в активних. */
export function originZoneCatalogue(): Array<{ zoneId: OriginZoneId; name: string; anchor: [number, number] }> {
  return ORIGIN_ZONES.map((zone) => ({ zoneId: zone.id, name: zone.name, anchor: zone.anchor }));
}
