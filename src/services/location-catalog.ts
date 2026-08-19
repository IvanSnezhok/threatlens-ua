import { createHash } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { invalidateLocationLexemeCache } from '../repositories/events.js';

export interface KatottgEntry {
  code: string;
  /** KATOTTG code of the oblast (level A) the row belongs to. */
  regionCode: string;
  /** KATOTTG code of the enclosing raion (level B); null for oblast and special-city rows. */
  raionCode: string | null;
  /** KATOTTG code of the enclosing hromada (level C); null above that level. */
  hromadaCode: string | null;
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
    // The sheet is a depth-first listing, so the surviving level columns spell out the full parent
    // chain of the current row: B is its raion, C its hromada. Carrying them out of the parser is
    // what lets the catalogue be three-tier instead of oblast -> city.
    if (code && regionCode && category && name) {
      entries.push({
        code, regionCode, raionCode: levels.B ?? null, hromadaCode: levels.C ?? null,
        category, name: name.trim()
      });
    }
  }
  if (entries.length < minimumEntries) throw new Error(`KATOTTG workbook yielded only ${entries.length} entries`);
  return entries;
}

/** KATOTTG category letters used by the importer. */
export const KATOTTG_OBLAST = 'O';
export const KATOTTG_SPECIAL_CITY = 'K';
export const KATOTTG_RAION = 'P';
export const KATOTTG_HROMADA = 'H';
export const KATOTTG_CITY = 'M';

function katottgId(code: string): string {
  return `katottg-${code.toLocaleLowerCase()}`;
}

/**
 * Spellings a raion can appear under in free text.
 *
 * KATOTTG stores the bare adjective ("Мелітопольський"); `@air_alert_ua` writes the full form
 * ("Повітряна тривога в • Мелітопольський район", "Відбій тривоги в Одеський район"), and other
 * feeds decline it. Only masculine raion forms are emitted as bare adjectives — oblast names are
 * feminine ("Харківська область"), so a bare "харківський" cannot shadow an oblast the way a bare
 * "харківська" would.
 *
 * Hromadas used to be folded in here as aliases of the raion around them. They are rows of their
 * own now ({@link hromadaAliases}), so this function no longer answers for them: an alias that
 * spells a hromada on the raion row would compete with the hromada's own name for the same text.
 */
export function raionAliases(name: string): string[] {
  const base = name.toLocaleLowerCase('uk-UA');
  const aliases = new Set<string>([base, `${base} район`]);
  const stem = base.replace(/ий$/u, '');
  if (stem !== base) { aliases.add(`${stem}ого району`); aliases.add(`${stem}ому районі`); }
  return [...aliases];
}

/**
 * Spellings a hromada can appear under — and, deliberately, not one spelling more.
 *
 * ## Why the catalogue grew a fourth tier
 *
 * Until migration 051 a hromada was two aliases on the raion that contains it, so «Харківська
 * територіальна громада» — the label the alert mirror publishes — resolved to Харківський район.
 * That was a defensible reading while the alert feed only spoke in raions. It stopped being one
 * when `skog` became the granular feed (migration 050): it publishes communities, and folding them
 * upward threw that granularity away at the catalogue door. A reader inside Харківська громада and
 * a reader in a village forty kilometres out both got «Харківський район», and one of them was
 * being warned about somewhere else.
 *
 * ## Why the head word is mandatory
 *
 * Every alias here ends in «громада». The bare adjective is NEVER emitted, and this is a safety
 * rule rather than a stylistic one: hromada names are feminine, so a bare «харківська» would sit in
 * the same lexeme space as «Харківська область» and outrank it — `normalizeForCatalogue` strips the
 * «область» affix before matching, so the oblast arrives at the query as exactly that string. The
 * same trap already cost this project three oblasts once (see `catalogueLookupForms` in
 * `src/services/ingestion.ts`); it is not being reopened at 1772 new rows of scale.
 */
export function hromadaAliases(name: string): string[] {
  const base = name.toLocaleLowerCase('uk-UA');
  return [`${base} територіальна громада`, `${base} громада`];
}

/** The name a hromada carries in the catalogue — the form the alert mirrors publish. */
export function hromadaName(name: string): string {
  return `${name} територіальна громада`;
}

export interface CatalogPlanRow {
  id: string;
  nameUk: string;
  officialCode: string;
  aliases: string[];
  /** KATOTTG codes of acceptable parents, most specific first. */
  parentCodes: string[];
}

export interface CatalogPlan {
  raions: CatalogPlanRow[];
  hromadas: CatalogPlanRow[];
  cities: CatalogPlanRow[];
}

/**
 * Turns a parsed workbook into the rows the catalogue should hold, without touching the database.
 *
 * Every id is a pure function of the KATOTTG code, which is what makes a re-import idempotent: the
 * second run addresses exactly the rows the first one wrote.
 */
export function planCatalogImport(entries: KatottgEntry[]): CatalogPlan {
  const raions = entries.filter((entry) => entry.category === KATOTTG_RAION).map((raion) => ({
    id: katottgId(raion.code),
    nameUk: `${raion.name} район`,
    officialCode: raion.code,
    aliases: raionAliases(raion.name),
    parentCodes: [raion.regionCode]
  }));
  const hromadas = entries.filter((entry) => entry.category === KATOTTG_HROMADA).map((hromada) => ({
    id: katottgId(hromada.code),
    nameUk: hromadaName(hromada.name),
    officialCode: hromada.code,
    aliases: hromadaAliases(hromada.name),
    // Same fallback shape as a city: a hromada whose raion is missing still hangs off its oblast
    // rather than being dropped, because a row that is not in the catalogue cannot be alerted at all.
    parentCodes: [...new Set([hromada.raionCode, hromada.regionCode].filter((code): code is string => !!code))]
  }));
  const cities = entries.filter((entry) => entry.category === KATOTTG_CITY).map((city) => ({
    id: katottgId(city.code),
    nameUk: city.name,
    officialCode: city.code,
    aliases: [city.name.toLocaleLowerCase('uk-UA')],
    // The hromada is the real parent now that hromadas are rows; the raion and then the oblast stay
    // as fallbacks so a city whose hromada is missing from the workbook is still attached somewhere.
    //
    // This ordering is what keeps a city subscriber whole. The alert fan-out walks the ancestors and
    // descendants of the ALERTED location, so when «Харківська територіальна громада» is the alerted
    // row, a chat subscribed to Харків only hears it if the city sits UNDER that hromada. Leaving
    // cities parented to the raion would have made every hromada alert silent for the city inside it
    // — the exact readers standing closest to it.
    parentCodes: [...new Set(
      [city.hromadaCode, city.raionCode, city.regionCode].filter((code): code is string => !!code)
    )]
  }));
  return { raions, hromadas, cities };
}

export interface CatalogImportSummary {
  raions: number;
  hromadas: number;
  cities: number;
  reparentedCities: number;
}

/**
 * Writes a parsed workbook into `locations`.
 *
 * Oblasts and the two special cities are matched against the seeded rows by name and only tagged
 * with their official code; raions and hromadas are inserted wholesale; cities are re-pointed at
 * their hromada. The city lookup accepts any of hromada, raion or oblast as the current parent, so
 * the first run after each tier was added migrates the rows the previous shape left behind and
 * every later run is a no-op.
 */
export async function importKatottgEntries(
  entries: KatottgEntry[], checksum: string
): Promise<CatalogImportSummary> {
  const regions = entries.filter(
    (entry) => entry.category === KATOTTG_OBLAST || entry.category === KATOTTG_SPECIAL_CITY
  );
  const plan = planCatalogImport(entries);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idsByCode = new Map<string, string>();
    for (const region of regions) {
      const matched = await client.query<{ id: string }>(
        `SELECT id FROM locations WHERE type IN ('oblast','special_city') AND
          (lower(name_uk)=lower($1) OR lower(name_uk) LIKE lower($1)||' %'
           OR EXISTS (SELECT 1 FROM unnest(aliases) alias WHERE lower(alias)=lower($1)))
         ORDER BY type='oblast' DESC LIMIT 1`, [region.name]
      );
      if (!matched.rowCount) continue;
      const id = matched.rows[0]!.id; idsByCode.set(region.code, id);
      await client.query(`UPDATE locations SET official_code=COALESCE(official_code,$2) WHERE id=$1`, [id, region.code]);
    }
    const summary: CatalogImportSummary = { raions: 0, hromadas: 0, cities: 0, reparentedCities: 0 };
    for (const raion of plan.raions) {
      const parentId = raion.parentCodes.map((code) => idsByCode.get(code)).find(Boolean);
      if (!parentId) continue;
      await client.query(
        `INSERT INTO locations(id,parent_id,type,name_uk,official_code,aliases)
         VALUES ($1,$2,'raion',$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET parent_id=$2,name_uk=$3,official_code=$4,aliases=$5`,
        [raion.id, parentId, raion.nameUk, raion.officialCode, raion.aliases]
      );
      idsByCode.set(raion.officialCode, raion.id);
      summary.raions += 1;
    }
    // Hromadas run BETWEEN raions and cities and not in any other order: a hromada needs its raion
    // in `idsByCode` to be parented, and a city needs its hromada there to be re-parented onto it.
    for (const hromada of plan.hromadas) {
      const parentId = hromada.parentCodes.map((code) => idsByCode.get(code)).find(Boolean);
      if (!parentId) continue;
      await client.query(
        `INSERT INTO locations(id,parent_id,type,name_uk,official_code,aliases)
         VALUES ($1,$2,'hromada',$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET parent_id=$2,name_uk=$3,official_code=$4,aliases=$5`,
        [hromada.id, parentId, hromada.nameUk, hromada.officialCode, hromada.aliases]
      );
      idsByCode.set(hromada.officialCode, hromada.id);
      summary.hromadas += 1;
    }
    for (const city of plan.cities) {
      const parents = city.parentCodes.map((code) => idsByCode.get(code)).filter((id): id is string => !!id);
      const parentId = parents[0]; if (!parentId) continue;
      // Re-imports find the row by the code the previous run stamped on it; the first run falls back
      // to a name match under either the new raion parent or the oblast the seed data used.
      const byCode = await client.query<{ id: string; parent_id: string | null }>(
        `SELECT id,parent_id FROM locations WHERE official_code=$1 LIMIT 1`, [city.officialCode]
      );
      const existing = byCode.rowCount ? byCode : await client.query<{ id: string; parent_id: string | null }>(
        `SELECT id,parent_id FROM locations WHERE type IN ('city','special_city') AND lower(name_uk)=lower($1)
           AND (parent_id=ANY($2::text[]) OR id IN ('ua-80','ua-85'))
         ORDER BY latitude IS NOT NULL DESC LIMIT 1`, [city.nameUk, parents]
      );
      if (existing.rowCount) {
        const row = existing.rows[0]!;
        if (row.parent_id !== parentId) summary.reparentedCities += 1;
        // `special_city` rows (Kyiv, Sevastopol) are top-level by design and never get a parent.
        await client.query(
          `UPDATE locations SET official_code=$2,
             parent_id=CASE WHEN type='city' THEN $3 ELSE parent_id END WHERE id=$1`,
          [row.id, city.officialCode, parentId]
        );
      } else {
        await client.query(
          `INSERT INTO locations(id,parent_id,type,name_uk,official_code,aliases)
           VALUES ($1,$2,'city',$3,$4,$5) ON CONFLICT (id) DO UPDATE SET name_uk=$3,parent_id=$2,official_code=$4`,
          [city.id, parentId, city.nameUk, city.officialCode, city.aliases]
        );
      }
      summary.cities += 1;
    }
    await client.query(
      `INSERT INTO reference_dataset_syncs(dataset_id,source_url,source_version,source_sha256,imported_rows,status)
       VALUES ('katottg',$1,$2,$3,$4,'success')
       ON CONFLICT (dataset_id) DO UPDATE SET source_url=$1,source_version=$2,source_sha256=$3,
         imported_rows=$4,status='success',error=NULL,synced_at=now()`,
      [config.KATOTTG_URL, config.KATOTTG_VERSION, checksum, summary.raions + summary.hromadas + summary.cities]
    );
    await client.query('COMMIT');
    // ПІСЛЯ COMMIT: класифікатор працює з кешованим каталогом (`cachedLocationLexemes`), і скинути
    // кеш до фіксації означало б перечитати ще старі рядки й пришити їх на наступні шість годин.
    invalidateLocationLexemeCache();
    return summary;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function syncLocationCatalog(force = false): Promise<CatalogImportSummary> {
  const empty: CatalogImportSummary = { raions: 0, hromadas: 0, cities: 0, reparentedCities: 0 };
  if (!config.KATOTTG_SYNC_ENABLED) return empty;
  const current = await pool.query(
    `SELECT 1 FROM reference_dataset_syncs WHERE dataset_id='katottg' AND status='success'
     AND source_version=$1 AND synced_at>now()-interval '6 days'`, [config.KATOTTG_VERSION]
  );
  if (current.rowCount && !force) return empty;
  try {
    const response = await fetch(config.KATOTTG_URL, { signal: AbortSignal.timeout(45_000) });
    if (!response.ok) throw new Error(`KATOTTG download ${response.status}`);
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > 20 * 1024 * 1024) throw new Error('KATOTTG workbook exceeds 20 MiB limit');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('KATOTTG workbook exceeds 20 MiB limit');
    const checksum = createHash('sha256').update(bytes).digest('hex');
    return importKatottgEntries(parseKatottgWorkbook(bytes), checksum);
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
    .then((summary) => (summary.raions + summary.hromadas + summary.cities) && log.info(
      { ...summary, version: config.KATOTTG_VERSION }, 'KATOTTG raions, hromadas and cities imported'
    ))
    .catch((error) => log.error({ error }, 'KATOTTG synchronization failed'));
  const timer = setInterval(run, 24 * 60 * 60_000); timer.unref(); void run();
  return () => clearInterval(timer);
}
