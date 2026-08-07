import { createHash } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { config } from '../config.js';
import { pool } from '../db/pool.js';

export interface KatottgEntry {
  code: string;
  regionCode: string;
  category: string;
  name: string;
}

function decodeXml(value: string): string {
  return value.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function textNodes(xml: string): string {
  return decodeXml([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((match) => match[1] ?? '').join(''));
}

export function parseKatottgWorkbook(bytes: Uint8Array, minimumEntries = 1000): KatottgEntry[] {
  const archive = unzipSync(bytes);
  const sharedXml = archive['xl/sharedStrings.xml']; const sheetBytes = archive['xl/worksheets/sheet1.xml'];
  if (!sharedXml || !sheetBytes) throw new Error('KATOTTG workbook does not contain expected XLSX parts');
  const shared = [...strFromU8(sharedXml).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => textNodes(match[1] ?? ''));
  const sheet = strFromU8(sheetBytes); const entries: KatottgEntry[] = [];
  const levelColumns = ['A','B','C','D','E']; const levels: Record<string, string> = {};
  for (const rowMatch of sheet.matchAll(/<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    if (Number(rowMatch[1]) < 5) continue;
    const values: Record<string, string> = {};
    for (const cell of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cell[1] ?? ''; const contents = cell[2] ?? '';
      const reference = attributes.match(/\br="([A-G])\d+"/)?.[1];
      const raw = contents.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      if (!reference || raw == null) continue;
      values[reference] = /\bt="s"/.test(attributes) ? shared[Number(raw)] ?? '' : decodeXml(raw);
    }
    levelColumns.forEach((column, index) => {
      if (!values[column]) return;
      levels[column] = values[column];
      levelColumns.slice(index + 1).forEach((lower) => { delete levels[lower]; });
    });
    const code = [...levelColumns].reverse().map((column) => levels[column]).find(Boolean);
    const regionCode = levels.A; const category = values.F; const name = values.G;
    if (code && regionCode && category && name) entries.push({ code, regionCode, category, name: name.trim() });
  }
  if (entries.length < minimumEntries) throw new Error(`KATOTTG workbook yielded only ${entries.length} entries`);
  return entries;
}

async function importEntries(entries: KatottgEntry[], checksum: string): Promise<number> {
  const regions = entries.filter((entry) => entry.category === 'O');
  const cities = entries.filter((entry) => entry.category === 'M');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const regionIds = new Map<string, string>();
    for (const region of regions) {
      const matched = await client.query<{ id: string }>(
        `SELECT id FROM locations WHERE type IN ('oblast','special_city') AND
          (lower(name_uk)=lower($1) OR lower(name_uk) LIKE lower($1)||' %'
           OR EXISTS (SELECT 1 FROM unnest(aliases) alias WHERE lower(alias)=lower($1)))
         ORDER BY type='oblast' DESC LIMIT 1`, [region.name]
      );
      if (!matched.rowCount) continue;
      const id = matched.rows[0]!.id; regionIds.set(region.code, id);
      await client.query(`UPDATE locations SET official_code=COALESCE(official_code,$2) WHERE id=$1`, [id, region.code]);
    }
    let imported = 0;
    for (const city of cities) {
      const parentId = regionIds.get(city.regionCode); if (!parentId) continue;
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM locations WHERE type IN ('city','special_city') AND lower(name_uk)=lower($1)
         AND (parent_id=$2 OR id IN ('ua-80','ua-85')) ORDER BY latitude IS NOT NULL DESC LIMIT 1`,
        [city.name, parentId]
      );
      if (existing.rowCount) {
        await client.query(`UPDATE locations SET official_code=$2 WHERE id=$1`, [existing.rows[0]!.id, city.code]);
      } else {
        await client.query(
          `INSERT INTO locations(id,parent_id,type,name_uk,official_code,aliases)
           VALUES ($1,$2,'city',$3,$4,$5) ON CONFLICT (id) DO UPDATE SET name_uk=$3,parent_id=$2,official_code=$4`,
          [`katottg-${city.code.toLocaleLowerCase()}`, parentId, city.name, city.code, [city.name.toLocaleLowerCase('uk-UA')]]
        );
      }
      imported += 1;
    }
    await client.query(
      `INSERT INTO reference_dataset_syncs(dataset_id,source_url,source_version,source_sha256,imported_rows,status)
       VALUES ('katottg',$1,$2,$3,$4,'success')
       ON CONFLICT (dataset_id) DO UPDATE SET source_url=$1,source_version=$2,source_sha256=$3,
         imported_rows=$4,status='success',error=NULL,synced_at=now()`,
      [config.KATOTTG_URL, config.KATOTTG_VERSION, checksum, imported]
    );
    await client.query('COMMIT');
    return imported;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function syncLocationCatalog(force = false): Promise<number> {
  if (!config.KATOTTG_SYNC_ENABLED) return 0;
  const current = await pool.query(
    `SELECT 1 FROM reference_dataset_syncs WHERE dataset_id='katottg' AND status='success'
     AND source_version=$1 AND synced_at>now()-interval '6 days'`, [config.KATOTTG_VERSION]
  );
  if (current.rowCount && !force) return 0;
  try {
    const response = await fetch(config.KATOTTG_URL, { signal: AbortSignal.timeout(45_000) });
    if (!response.ok) throw new Error(`KATOTTG download ${response.status}`);
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > 20 * 1024 * 1024) throw new Error('KATOTTG workbook exceeds 20 MiB limit');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('KATOTTG workbook exceeds 20 MiB limit');
    const checksum = createHash('sha256').update(bytes).digest('hex');
    return importEntries(parseKatottgWorkbook(bytes), checksum);
  } catch (error) {
    await pool.query(
      `INSERT INTO reference_dataset_syncs(dataset_id,source_url,source_version,source_sha256,imported_rows,status,error)
       VALUES ('katottg',$1,$2,'unavailable',0,'failed',$3)
       ON CONFLICT (dataset_id) DO UPDATE SET status='failed',error=$3,synced_at=now()`,
      [config.KATOTTG_URL, config.KATOTTG_VERSION, String(error).slice(0, 800)]
    ).catch(() => undefined);
    throw error;
  }
}

export function startLocationCatalogScheduler(log: { info: Function; error: Function }): () => void {
  const run = () => syncLocationCatalog()
    .then((imported) => imported && log.info({ imported, version: config.KATOTTG_VERSION }, 'KATOTTG cities imported'))
    .catch((error) => log.error({ error }, 'KATOTTG synchronization failed'));
  const timer = setInterval(run, 24 * 60 * 60_000); timer.unref(); void run();
  return () => clearInterval(timer);
}
