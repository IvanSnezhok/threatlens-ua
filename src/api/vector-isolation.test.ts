import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THREAT_ICON_LABELS_UK, THREAT_ICON_PATHS } from '../domain/threat-icons.js';

/**
 * Structural proof that the operator-only extrapolation cannot reach a public response.
 *
 * The product commitment is that the map shows only what was explicitly reported. Threat vectors add
 * a second, *calculated* layer for operators, and the only durable way to keep the two apart is to
 * make the leak impossible to commit rather than impossible to forget. Three independent checks,
 * each of which fails the build on its own:
 *
 *  1. **Module graph.** Nothing that builds a public payload may reach
 *     `src/services/vector-projection.ts` or `src/api/ops-vector-routes.ts` through any chain of
 *     imports, however long.
 *  2. **Table names.** The `ops_`-prefixed projection tables may only be named by the two ops
 *     modules and the migration that creates them. A public module that wants the data has to type
 *     the name, which this test refuses.
 *  3. **Map layer order.** The vector layers are additions, not rearrangements: the state border
 *     stays above every fill, the Crimea sovereignty label stays readable, and the occupation layers
 *     keep their anchor.
 *
 * A runtime counterpart lives in `tests/integration/threat-vector.test.ts`: it plants a projection
 * and asserts no public endpoint, snapshot or SSE frame ever repeats it.
 */

const ROOT = resolve(import.meta.dirname, '../..');

const OPS_ONLY_MODULES = [
  'src/services/vector-projection.ts',
  'src/api/ops-vector-routes.ts'
];

/**
 * Modules that produce something a member of the public can read: HTTP payloads, SSE frames and
 * Telegram messages.
 *
 * `src/api/server.ts` is deliberately absent. It is the composition root — it registers the ops
 * plugin exactly as it already registers `/ops/api` and `/ops/run-assessment` — so it is expected to
 * reach ops code. What must never reach it is anything that *builds a response*, which is the list
 * below.
 */
const PUBLIC_ENTRY_POINTS = [
  'src/api/vector-routes.ts',
  'src/api/occupation-routes.ts',
  'src/services/threat-vectors.ts',
  'src/repositories/events.ts',
  'src/services/sse.ts',
  'src/services/publication.ts',
  'src/services/ingestion.ts',
  'src/services/risk.ts',
  'src/services/analytics.ts',
  'src/services/operations.ts',
  'src/services/nightly-digest.ts',
  'src/services/occupation.ts',
  'src/services/location-catalog.ts',
  'src/services/recommended-channels.ts',
  'src/bot/bot.ts',
  'src/bot/outbox.ts'
];

function read(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

function walk(directory: string, extensions: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(ROOT, directory))) {
    const relative = join(directory, entry);
    const full = resolve(ROOT, relative);
    if (statSync(full).isDirectory()) out.push(...walk(relative, extensions));
    else if (extensions.some((extension) => entry.endsWith(extension))) out.push(relative);
  }
  return out;
}

/** Static and dynamic relative imports alike; both are edges in the graph a refactor could add. */
function relativeImportsOf(relativePath: string): string[] {
  const source = read(relativePath);
  const specifiers = [
    ...source.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)
  ].map((match) => match[1]!);
  const directory = relativePath.split('/').slice(0, -1).join('/');
  return specifiers.map((specifier) => {
    const resolved = join(directory, specifier).replaceAll('\\', '/');
    return resolved.replace(/\.js$/, '.ts');
  });
}

function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    let imports: string[];
    try {
      imports = relativeImportsOf(current);
    } catch {
      continue; // a non-source import (JSON, asset) is not an edge worth following
    }
    for (const next of imports) if (!seen.has(next)) queue.push(next);
  }
  return seen;
}

describe('module graph', () => {
  it.each(PUBLIC_ENTRY_POINTS)('%s cannot reach the extrapolation, at any depth', (entry) => {
    const reachable = reachableFrom(entry);
    for (const opsModule of OPS_ONLY_MODULES) {
      expect(
        reachable.has(opsModule),
        `${entry} reaches ${opsModule}: ${[...reachable].join(' -> ')}`
      ).toBe(false);
    }
  });

  it('lets the ops module reach the public chain, and not the other way round', () => {
    expect(reachableFrom('src/services/vector-projection.ts')).toContain('src/services/threat-vectors.ts');
    expect(reachableFrom('src/services/threat-vectors.ts')).not.toContain('src/services/vector-projection.ts');
  });

  it('keeps the public route plugin free of the ops route plugin', () => {
    const reachable = reachableFrom('src/api/vector-routes.ts');
    expect(reachable).not.toContain('src/api/ops-vector-routes.ts');
  });
});

describe('extrapolation storage', () => {
  // Assembled rather than written out, so this file does not itself match the search it performs.
  const TABLE_PREFIX = `ops_${'threat_vector'}`;
  const ALLOWED = new Set([
    'src/services/vector-projection.ts',
    'src/api/ops-vector-routes.ts'
  ]);

  it('is named only by the two ops modules', () => {
    const offenders = walk('src', ['.ts'])
      .filter((file) => !ALLOWED.has(file))
      .filter((file) => read(file).includes(TABLE_PREFIX));
    expect(offenders, `${TABLE_PREFIX}* tables named outside the ops modules`).toEqual([]);
  });

  it('is unknown to the browser bundle source', () => {
    expect(read('web/app.js')).not.toContain(TABLE_PREFIX);
  });

  it('is created by migration 016 and by no other migration', () => {
    const creating = walk('migrations', ['.sql']).filter((file) => read(file).includes(`CREATE TABLE IF NOT EXISTS ${TABLE_PREFIX}`));
    expect(creating).toEqual(['migrations/016_threat_vectors.sql']);
  });

  it('marks every stored row as a calculation by constraint, not by convention', () => {
    const migration = read('migrations/016_threat_vectors.sql');
    const checks = migration.match(/CHECK \(data_nature = 'calculated'\)/g) ?? [];
    // Once on the projection, once on each candidate row.
    expect(checks.length).toBe(2);
    // An extrapolation is never allowed to describe itself as high-confidence.
    expect(migration).toContain(`CHECK (confidence IN ('low','medium'))`);
  });
});

// ------------------------------------------------------------------------------------------------
// Map layer order
// ------------------------------------------------------------------------------------------------

interface AddedLayer { id: string; beforeId: string | null }

const APP_SOURCE = read('web/app.js');

/**
 * Every layer `addVectorLayers()` contributes, in insertion order.
 *
 * Named once because three separate assertions depend on the same list — the exact global order, the
 * "icons stay on top" rule and the shared anchor — and a family that grew in one of them and not in
 * the others would leave the other two silently describing a map that no longer exists.
 */
const VECTOR_LAYER_IDS = [
  'threat-vector-sequence', 'threat-vector-direction', 'threat-vector-transit',
  'threat-vector-nodes', 'threat-vector-order',
  'threat-vector-arrowhead', 'threat-vector-class'
];

/** Span of the balanced bracket that opens at `start`, inclusive of both brackets. */
function balanced(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === `'` || character === '"' || character === '`') { quote = character; continue; }
    if (character === open) depth += 1;
    else if (character === close) { depth -= 1; if (depth === 0) return index; }
  }
  throw new Error('unbalanced source');
}

function bodyOf(functionName: string): string {
  const declaration = APP_SOURCE.indexOf(`function ${functionName}(`);
  if (declaration === -1) throw new Error(`${functionName} not found in web/app.js`);
  const brace = APP_SOURCE.indexOf('{', APP_SOURCE.indexOf(')', declaration));
  return APP_SOURCE.slice(brace, balanced(APP_SOURCE, brace, '{', '}') + 1);
}

/**
 * The order MapLibre actually receives the layers in, not the order they happen to be written in.
 *
 * `initMap` calls two helpers that are declared further up the file, so plain source order would
 * report the occupation and vector layers before every layer they are supposed to follow. Inlining
 * the two helper bodies at their call sites reconstructs the real sequence, which is the thing the
 * sovereignty rules actually depend on.
 */
/** The raw `map.on('style.load', …)` call, before any helper is inlined into it. */
function styleLoadBlock(): string {
  const styleLoad = APP_SOURCE.indexOf(`map.on('style.load'`);
  return APP_SOURCE.slice(styleLoad, balanced(APP_SOURCE, APP_SOURCE.indexOf('(', styleLoad), '(', ')') + 1);
}

function executionOrderSource(): string {
  return styleLoadBlock()
    .replace('addOccupationLayers();', bodyOf('addOccupationLayers'))
    .replace('addVectorLayers();', bodyOf('addVectorLayers'))
    .replace('addTerritoryIconLayers();', bodyOf('addTerritoryIconLayers'));
}

/**
 * Every `selector { … }` rule of a stylesheet, flattened.
 *
 * At-rule preludes fall away with their outer brace, which is exactly what a scan for a property
 * inside a given selector wants: `@media … { .map-stage { … } }` yields the inner rule.
 */
function rulesMatching(css: string, selector: RegExp): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: string[] = [];
  for (const rule of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selector.test(rule[1]!)) rules.push(rule[0]!);
  }
  return rules;
}

/** Every `map.addLayer(...)` call, with the layer id it was inserted before. */
function addedLayers(source: string): AddedLayer[] {
  const layers: AddedLayer[] = [];
  const marker = 'map.addLayer(';
  let cursor = source.indexOf(marker);
  while (cursor !== -1) {
    const end = balanced(source, source.indexOf('(', cursor), '(', ')');
    const call = source.slice(cursor, end + 1);
    const id = call.match(/id:\s*'([a-z0-9-]+)'/i)?.[1];
    if (id) {
      const tail = call.match(/\}\s*,\s*(?:'([a-z0-9-]+)'|([A-Za-z_$][\w$]*))\s*\)$/);
      // The anchor may be a local, e.g. `const anchor = map.getLayer('alert-oblast-label') ? … : …`.
      const named = tail?.[2]
        ? source.match(new RegExp(`const ${tail[2]}\\s*=\\s*map\\.getLayer\\('([a-z0-9-]+)'\\)`))?.[1]
        : undefined;
      layers.push({ id, beforeId: tail?.[1] ?? named ?? null });
    }
    cursor = source.indexOf(marker, end + 1);
  }
  return layers;
}

describe('map layer order', () => {
  const layers = addedLayers(executionOrderSource());
  const order = layers.map((layer) => layer.id);

  it('adds the layers in the order the sovereignty rules depend on', () => {
    // Exact sequence, not a subset: a reordering of any two of these changes what the map asserts,
    // and the vector layers must appear only at the end.
    //
    // Within one anchor the later insert sits higher, so the fills read bottom-to-top as
    // threat → alert → consequence → occupation and the outlines as
    // analytic → threat → alert → consequence: the weakest signal never overdraws a stronger one.
    //
    // The chain's two head layers close the family and are appended, never interleaved: an arrowhead
    // has to sit ON the end of its own line rather than under it, and the class chip has to sit over
    // the arrowhead. Both stay under the territory icon stacks, which remain the map's top layer.
    expect(order).toEqual([
      'ukraine-sovereignty-fill', 'ukraine-region-fill', 'ukraine-region-lines', 'ukraine-state-border',
      'threat-oblast-fill', 'threat-raion-fill',
      'alert-oblast-fill', 'alert-raion-fill',
      'consequence-oblast-fill', 'consequence-raion-fill',
      'occupation-fill', 'occupation-hatch', 'occupation-line', 'occupation-contested-line',
      'analytic-raion-line', 'analytic-oblast-line',
      'threat-raion-line', 'threat-oblast-line',
      'alert-raion-line', 'alert-oblast-line',
      'consequence-raion-line', 'consequence-oblast-line',
      'city-hit', 'city-labels', 'crimea-ukraine-label', 'alert-oblast-label', 'alert-raion-label',
      'direction-lines',
      'threat-vector-sequence', 'threat-vector-direction', 'threat-vector-transit',
      'threat-vector-nodes', 'threat-vector-order',
      'threat-vector-arrowhead', 'threat-vector-class',
      'territory-icon-slot-0', 'territory-icon-slot-1', 'territory-icon-slot-2', 'territory-icon-badge'
    ]);
  });

  it('keeps the threat icons above every other layer', () => {
    // Іконки — головний показник карти, тож вони додаються без якоря й лягають на самий верх.
    const iconIds = ['territory-icon-slot-0', 'territory-icon-slot-1', 'territory-icon-slot-2', 'territory-icon-badge'];
    const lastVector = Math.max(...VECTOR_LAYER_IDS.map((id) => order.indexOf(id)));
    for (const id of iconIds) {
      expect(layers.find((layer) => layer.id === id)?.beforeId).toBeNull();
      expect(order.indexOf(id)).toBeGreaterThan(lastVector);
    }
  });

  it('registers every icon image before the first icon layer', () => {
    // Проти мовчазної підміни: глобальний обробник styleimagemissing підставляє прозорий піксель
    // 1×1 на будь-який невідомий id БЕЗ попередження, тож шар, доданий раніше за реєстрацію
    // зображень, малював би ніщо і виглядав би як «іконок просто немає».
    //
    // Перевіряємо СИРИЙ блок style.load, а не executionOrderSource(): там літеральний виклик
    // `addTerritoryIconLayers();` уже замінено тілом функції, indexOf повернув би -1 і твердження
    // перевернулося б на протилежне.
    const block = styleLoadBlock();
    const images = block.indexOf('addThreatIconImages(');
    const layersCall = block.indexOf('addTerritoryIconLayers();');
    expect(images).toBeGreaterThan(-1);
    expect(layersCall).toBeGreaterThan(-1);
    expect(images).toBeLessThan(layersCall);
  });

  it('keeps the four icon layers out of every layer-toggle group', () => {
    // Іконка йде за своїм сімейством, вона не пʼятий перемикач: тон `consequence` гасне разом із
    // «Наслідками», а не окремо від них.
    const start = APP_SOURCE.indexOf('const layerGroups = {');
    expect(start).toBeGreaterThan(-1);
    const literal = APP_SOURCE.slice(start, balanced(APP_SOURCE, APP_SOURCE.indexOf('{', start), '{', '}') + 1);
    expect(literal).not.toContain('territory-icon-');
  });

  it('mirrors every threat-icon glyph and label into the browser bundle', () => {
    // Текстове сканування src/domain/threat-icons.ts тут не працює: там кожен path зібрано з
    // кількох рядків через `+`, тож повного значення в тому файлі немає як суцільного підрядка.
    // Тому значення імпортуються в рантаймі, а web/app.js зобовʼязаний писати кожен path ОДНИМ
    // нерозривним літералом — інакше ця перевірка нічого б не означала.
    for (const value of [...Object.values(THREAT_ICON_PATHS), ...Object.values(THREAT_ICON_LABELS_UK)]) {
      expect(APP_SOURCE, `web/app.js is missing the mirrored value ${value.slice(0, 24)}…`).toContain(value);
    }
  });

  it('anchors every territory-state fill beneath the sovereignty fill', () => {
    // Заливки живуть під суверенітетом і під державним кордоном — інакше колір стану
    // перекриває те, що не є станом.
    for (const id of [
      'threat-oblast-fill', 'threat-raion-fill', 'alert-oblast-fill', 'alert-raion-fill',
      'consequence-oblast-fill', 'consequence-raion-fill'
    ]) {
      expect(layers.find((layer) => layer.id === id)?.beforeId).toBe('ukraine-sovereignty-fill');
    }
  });

  it('anchors every territory-state outline beneath the region lines', () => {
    for (const id of [
      'analytic-raion-line', 'analytic-oblast-line', 'threat-raion-line', 'threat-oblast-line',
      'alert-raion-line', 'alert-oblast-line', 'consequence-raion-line', 'consequence-oblast-line'
    ]) {
      expect(layers.find((layer) => layer.id === id)?.beforeId).toBe('ukraine-region-lines');
    }
  });

  it('no longer draws analytic circles, event dots or their point source', () => {
    // Roadmap acceptance: «Аналітичні кола та glow-ефекти повністю відсутні». The scan covers the
    // whole file, not only the `map.addLayer` sites: a comment naming a deleted layer is a promise
    // the map no longer keeps.
    for (const token of [
      'assessment-halo', 'threat-pulse', 'event-labels', 'live-events',
      'markerCollection', 'circle-blur'
    ]) {
      expect(APP_SOURCE, `web/app.js still names ${token}`).not.toContain(token);
    }
  });

  it('keeps glow out of the stylesheet too', () => {
    // «Аналітичні кола та glow-ефекти повністю відсутні» has a CSS half a JS scan cannot see.
    const CSS = read('web/styles.css');
    const rules = rulesMatching(CSS, /#map\b|\.map-stage\b|\.maplibregl-canvas\b/);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule).not.toMatch(/box-shadow|filter:\s*blur/);
  });

  it('keeps web/app.js free of straight apostrophes in Ukrainian words', () => {
    // balanced() treats ' as a string delimiter and does not skip comments, so one «обʼєкт» written
    // with U+0027 desynchronises the parser for the rest of the slice and every assertion built on
    // it starts testing a nonsense list — or the parser runs off the end of the file and throws.
    // The file's convention is the modifier letter ʼ.
    //
    // The whole file, not only the style.load block: the suites at the bottom of this file slice
    // `renderCurrentRoute`, `writeMapAria`, `updateTerritoryIcons` and `territoryIconCollection`
    // out of the source too, and each of those is one stray apostrophe away from unparseable.
    const block = styleLoadBlock();                    // the raw slice, before the .replace() calls
    expect(block).not.toMatch(/[а-яіїєґА-ЯІЇЄҐ]'[а-яіїєґА-ЯІЇЄҐ]/u);
    expect(APP_SOURCE).not.toMatch(/[а-яіїєґА-ЯІЇЄҐ]'[а-яіїєґА-ЯІЇЄҐ]/u);
  });

  it('never gives the analytic state a fill', () => {
    // «Аналітична оцінка — нейтральний контур без заливки, що НЕ може виглядати як офіційна тривога.»
    const analytic = layers.filter((layer) => layer.id.startsWith('analytic-'));
    expect(analytic.map((layer) => layer.id)).toEqual(['analytic-raion-line', 'analytic-oblast-line']);
    const source = executionOrderSource();
    for (const id of analytic.map((layer) => layer.id)) {
      const call = source.slice(source.indexOf(`id: '${id}'`));
      expect(call.slice(0, 400)).toContain(`type: 'line'`);
      expect(call.slice(0, 400)).toContain('line-dasharray');
    }
  });

  it('keeps the state border above every fill and the Crimea label above the alert labels', () => {
    const anchorOf = (id: string) => layers.find((layer) => layer.id === id)?.beforeId ?? null;
    // Alert fills are pushed under the sovereignty fill, which is itself under the state border.
    expect(anchorOf('alert-oblast-fill')).toBe('ukraine-sovereignty-fill');
    expect(anchorOf('alert-raion-fill')).toBe('ukraine-sovereignty-fill');
    // Alert outlines lose to the golden sovereignty outline around Crimea.
    expect(anchorOf('alert-raion-line')).toBe('ukraine-region-lines');
    expect(anchorOf('alert-oblast-line')).toBe('ukraine-region-lines');
    // Both alert labels sit under the sovereignty label.
    expect(anchorOf('alert-oblast-label')).toBe('crimea-ukraine-label');
    expect(anchorOf('alert-raion-label')).toBe('crimea-ukraine-label');
    // `ukraine-state-border` is added with no anchor after all the fills, so nothing covers it.
    expect(anchorOf('ukraine-state-border')).toBeNull();
    expect(order.indexOf('ukraine-state-border')).toBeGreaterThan(order.indexOf('ukraine-region-fill'));
  });

  it('anchors every occupation layer beneath the sovereignty fill', () => {
    for (const id of ['occupation-fill', 'occupation-hatch', 'occupation-line', 'occupation-contested-line']) {
      expect(layers.find((layer) => layer.id === id)?.beforeId).toBe('ukraine-sovereignty-fill');
    }
  });

  it('inserts the vector chain under the labels instead of on top of the map', () => {
    for (const id of VECTOR_LAYER_IDS) {
      expect(layers.find((layer) => layer.id === id)?.beforeId).toBe('alert-oblast-label');
    }
    // The existing reported-direction layer is untouched: same id, still anchorless, still last of
    // the pre-existing layers.
    expect(layers.find((layer) => layer.id === 'direction-lines')?.beforeId).toBeNull();
  });

  it('still builds its layers on style.load rather than load', () => {
    const source = read('web/app.js');
    expect(source).toContain(`map.on('style.load'`);
    expect(source).not.toContain(`map.on('load'`);
    // Єдиний обробник масштабу у файлі: MapLibre забороняє ['zoom'] усередині filter, тож рівень
    // деталізації іконок перемикається перевипуском джерела, а не виразом у стилі.
    expect(source).toContain(`map.on('zoomend'`);
  });
});

// ------------------------------------------------------------------------------------------------
// Browser-bundle behaviour
// ------------------------------------------------------------------------------------------------

/**
 * `web/app.js` is a browser bundle: it opens with `import maplibregl from 'maplibre-gl'`, touches
 * `document` at module scope and ends by calling `boot()`, so it cannot be imported into a node
 * test. The scans above therefore only ever asserted on its *text*, which is why a wrong decision
 * inside a function body — as opposed to a wrong layer id — went green.
 *
 * The three suites below close that gap without a bundler and without jsdom: they slice the exact
 * source of one declaration out of the file, evaluate it with its free variables injected, and then
 * assert on what it *does*. Everything under test is the shipped text, not a copy of it — rewrite
 * the function and these tests run the rewrite.
 */

/**
 * The full `const NAME = …;` declaration, however many lines its literal spans.
 *
 * A trailing line comment is dropped before the terminator is looked for (`const ICON_CHIP_PX = 30;
 * // CSS px …`). That is safe for the declarations used here, all of which hold numbers, arrays or
 * object literals; a value containing `//` inside a string would need a real tokenizer.
 */
function constDeclaration(name: string): string {
  const start = APP_SOURCE.search(new RegExp(`const ${name}\\s*=`));
  if (start === -1) throw new Error(`const ${name} not found in web/app.js`);
  const code = APP_SOURCE.slice(start, APP_SOURCE.indexOf('\n', start)).replace(/\s*\/\/.*$/, '');
  if (code.trimEnd().endsWith(';')) return code;
  return `${APP_SOURCE.slice(start, balanced(APP_SOURCE, APP_SOURCE.indexOf('{', start), '{', '}') + 1)};`;
}

/** Compiles a slice of the bundle once and returns the factory that binds its free variables. */
function compileSlice<T>(source: string, exported: string, parameters: string[]): (...args: unknown[]) => T {
  return new Function(...parameters, `${source}\nreturn ${exported};`) as unknown as (...args: unknown[]) => T;
}

/** One-shot form of {@link compileSlice}. */
function evaluateSlice<T>(source: string, exported: string, bindings: Record<string, unknown> = {}): T {
  const names = Object.keys(bindings);
  return compileSlice<T>(source, exported, names)(...names.map((name) => bindings[name]));
}

/**
 * Defers a slice to the first test that needs it, and memoises the result.
 *
 * Slicing at `describe` body time would be tidier to read, but `balanced()` throws on a source it
 * cannot parse — and a thrown collection error takes down all of this file's assertions at once,
 * including the apostrophe check that would have named the cause. Lazily, that check still runs and
 * still reports.
 */
function lazy<T>(build: () => T): () => T {
  let value: T;
  let built = false;
  return () => {
    if (!built) { value = build(); built = true; }
    return value;
  };
}

// ------------------------------------------------------------------------------------------------
// A vector that points: the arrowhead is an assertion of movement, and two bases may make it
// ------------------------------------------------------------------------------------------------

/**
 * The arrowhead is the first thing this map has ever drawn that *points*, and the honesty rule is
 * the whole of its specification:
 *
 *   * `reported_transit` — one message said "повз Полтаву на Харків". The publisher asserted the
 *     movement itself, so an arrow repeats the publisher rather than adding to them.
 *   * `reported_direction` — one message said "у напрямку Харкова". A heading was asserted; an
 *     arrival was not. It gets a hollow arrow, drawn from the same statement.
 *   * `observation_sequence` — two messages, two places, two times, and **no source said the target
 *     moved between them**. The ordering is ours. An arrowhead here would convert an ordering this
 *     system imposed into a movement somebody reported, which is the exact claim the product
 *     commitment forbids and the map legend disclaims in so many words.
 *
 * The rule is encoded as data — a lookup table with two keys — rather than as a condition, so a
 * fourth basis added later is silently arrow-less until somebody deliberately types it in. These
 * tests run the shipped collection builder and assert on the features it emits, so they fail on a
 * wrong decision inside the function and not only on a renamed layer.
 */
describe('vector heads', () => {
  interface Head { properties: Record<string, string | number> }

  const bearingSource = lazy(() => [
    `function mercatorY(latitude) ${bodyOf('mercatorY')}`,
    `function segmentBearing(from, to) ${bodyOf('segmentBearing')}`
  ].join('\n'));
  const bearing = lazy(() => evaluateSlice<(from: number[], to: number[]) => number | null>(
    bearingSource(), 'segmentBearing'));

  const headSource = lazy(() => [
    constDeclaration('ARROW_BASIS_IMAGES'),
    bearingSource(),
    `function vectorClassTone(evidenceLevel) ${bodyOf('vectorClassTone')}`,
    `function vectorHeadCollection() ${bodyOf('vectorHeadCollection')}`
  ].join('\n'));

  /** Runs the shipped builder over injected chains and threats, exactly as the bundle calls it. */
  function heads(vectors: unknown[], threats: unknown[] = []): Head[] {
    return evaluateSlice<() => { features: Head[] }>(headSource(), 'vectorHeadCollection', {
      vectors,
      snapshot: { threats },
      iconImageId: (threatType: string, tone: string) => `ti-${threatType}-${tone}`
    })().features;
  }

  const node = (name: string, coordinates: [number, number] | null) => ({
    name, coordinates, coordinatePrecision: coordinates ? 'point' : 'unavailable'
  });
  const leg = (from: number, to: number, basis: string, options: Record<string, unknown> = {}) => ({
    from, to, basis, drawable: true, evidenceLevel: 'monitoring', threatType: 'ballistic_missile', ...options
  });

  const arrows = (features: Head[]) => features.filter((feature) => feature.properties.kind === 'arrow');
  const chips = (features: Head[]) => features.filter((feature) => feature.properties.kind === 'class');

  describe('the bearing an arrow is drawn at', () => {
    /**
     * Mercator, deliberately, not the great circle.
     *
     * MapLibre draws a `LineString` as a straight line in projected space, so the angle the arrow has
     * to match is the angle *on screen*. The initial great-circle bearing is a different number for
     * every leg that is not meridional — 89.6° for a due-east leg at 50°N — and an arrowhead drawn at
     * it would sit visibly askew on its own line. `src/services/vector-projection.ts` computes the
     * great-circle bearing and is right to: it extrapolates a flight, this rotates a glyph.
     */
    it.each([
      ['due east', [30, 50], [31, 50], 90],
      ['due east at 60°N, where the great circle would say 89.6°', [30, 60], [31, 60], 90],
      ['due north', [30, 50], [30, 51], 0],
      ['due south', [30, 50], [30, 49], 180],
      ['due west', [30, 50], [29, 50], 270]
    ])('reads %s', (_name, from, to, expected) => {
      expect(bearing()(from as number[], to as number[])).toBeCloseTo(expected as number, 9);
    });

    it('stays inside [0, 360) for a leg heading north-west', () => {
      const value = bearing()([30, 50], [29, 51])!;
      expect(value).toBeGreaterThan(270);
      expect(value).toBeLessThan(360);
    });

    it('refuses to invent a direction for a leg of zero length', () => {
      // Two different places can share one coordinate — two raion centroids that collapsed, a city
      // and the raion it is the centre of. An arrow there would point wherever atan2(0,0) happened
      // to land, which is a direction nobody reported.
      expect(bearing()([30, 50], [30, 50])).toBeNull();
    });
  });

  describe('which legs may carry one', () => {
    it('gives an arrow to reported_transit and reported_direction, and never to observation_sequence', () => {
      const features = heads([{
        eventId: 'e1', threatType: 'ballistic_missile',
        nodes: [node('Суми', [34.8, 50.9]), node('Полтава', [34.55, 49.59]),
          node('Харків', [36.23, 49.99]), node('Мерефа', [36.05, 49.81])],
        segments: [leg(0, 1, 'reported_transit'), leg(1, 2, 'reported_direction'), leg(2, 3, 'observation_sequence')]
      }]);
      expect(arrows(features).map((feature) => feature.properties.basis))
        .toEqual(['reported_transit', 'reported_direction']);
      expect(arrows(features).map((feature) => feature.properties.arrow))
        .toEqual(['threat-vector-arrow-solid', 'threat-vector-arrow-open']);
    });

    it('draws a chain of nothing but observation_sequence with no arrow at all', () => {
      // The commonest chain there is: three channels naming three places. The dotted line and the
      // node numbers stay; the map still says "ці повідомлення, в цьому порядку" and nothing more.
      const features = heads([{
        eventId: 'e1', threatType: 'uav',
        nodes: [node('Чернігів', [31.29, 51.5]), node('Бровари', [30.79, 50.51]), node('Бориспіль', [30.96, 50.35])],
        segments: [leg(0, 1, 'observation_sequence'), leg(1, 2, 'observation_sequence')]
      }]);
      expect(arrows(features)).toEqual([]);
      // …and the class chip is still there: what is moving was reported, the movement was not.
      expect(chips(features)).toHaveLength(1);
    });

    it('keeps the rule as a table with two keys rather than as a condition', () => {
      // A condition is one `||` away from growing a third branch in a hurry. A table cannot: the
      // weakest rung has no key, so it has no image, so the builder has nothing to place.
      const table = evaluateSlice<Record<string, string>>(
        constDeclaration('ARROW_BASIS_IMAGES'), 'ARROW_BASIS_IMAGES');
      expect(Object.keys(table).sort()).toEqual(['reported_direction', 'reported_transit']);
      expect(table.observation_sequence).toBeUndefined();
    });

    it('places the arrow at the head of the leg, pointing the way the leg was drawn', () => {
      const features = heads([{
        eventId: 'e1', threatType: 'ballistic_missile',
        nodes: [node('Полтава', [34, 50]), node('Харків', [36, 50])],
        segments: [leg(0, 1, 'reported_transit')]
      }]);
      const [arrow] = arrows(features);
      expect((arrow as unknown as { geometry: { coordinates: number[] } }).geometry.coordinates).toEqual([36, 50]);
      expect(arrow!.properties.bearing).toBeCloseTo(90, 9);
    });

    it('draws no arrow on a leg the map is not drawing', () => {
      // `drawable: false` is a leg that exists as a stated fact and has no coordinate for one end.
      // The line is not drawn, so an arrowhead would be a floating glyph asserting a movement
      // between a place and nowhere.
      const features = heads([{
        eventId: 'e1', threatType: 'ballistic_missile',
        nodes: [node('Якась громада', null), node('Харків', [36.23, 49.99])],
        segments: [leg(0, 1, 'reported_transit', { drawable: false })]
      }]);
      expect(arrows(features)).toEqual([]);
      expect(chips(features)).toEqual([]);
    });
  });

  describe('the class chip', () => {
    it('draws one per chain, at the newest point the chain actually reached', () => {
      const features = heads([{
        eventId: 'e1', threatType: 'ballistic_missile',
        nodes: [node('Суми', [34.8, 50.9]), node('Полтава', [34.55, 49.59]), node('Харків', [36.23, 49.99])],
        segments: [leg(0, 1, 'reported_transit'), leg(1, 2, 'reported_transit')]
      }]);
      expect(chips(features)).toHaveLength(1);
      expect((chips(features)[0] as unknown as { geometry: { coordinates: number[] } }).geometry.coordinates)
        .toEqual([36.23, 49.99]);
    });

    it('reuses the registered threat-icon image instead of a second icon pipeline', () => {
      const features = heads([{
        eventId: 'e1', threatType: 'uav',
        nodes: [node('Полтава', [34, 50]), node('Харків', [36, 50])],
        segments: [leg(0, 1, 'reported_transit', { threatType: 'uav', evidenceLevel: 'official' })]
      }]);
      // The same 40-image catalogue the territory stacks draw from: `ti-<class>-<tone>`, with the
      // tone rule of `threatTone` in src/domain/territory-state.ts — official/confirmed → confirmed.
      expect(chips(features)[0]!.properties.icon).toBe('ti-uav-confirmed');
    });

    it('takes the tone of the leg it stands on, never a stronger one', () => {
      const monitoring = heads([{
        eventId: 'e1', threatType: 'uav',
        nodes: [node('Полтава', [34, 50]), node('Харків', [36, 50])],
        segments: [leg(0, 1, 'reported_transit', { threatType: 'uav', evidenceLevel: 'monitoring' })]
      }]);
      expect(chips(monitoring)[0]!.properties.icon).toBe('ti-uav-reported');
    });

    it('names the class the leg reported, not only the class of the event', () => {
      // A chain whose class changed mid-way: the event is filed as `combined`, the newest leg was
      // reported as ballistics. The head says what the newest message said.
      const features = heads([{
        eventId: 'e1', threatType: 'combined',
        nodes: [node('Суми', [34.8, 50.9]), node('Полтава', [34.55, 49.59]), node('Харків', [36.23, 49.99])],
        segments: [
          leg(0, 1, 'reported_transit', { threatType: 'uav' }),
          leg(1, 2, 'reported_transit', { threatType: 'ballistic_missile' })
        ]
      }]);
      expect(chips(features)[0]!.properties.icon).toBe('ti-ballistic_missile-reported');
    });
  });

  describe('the reported-direction lines of the threat payload', () => {
    /**
     * `direction-lines` draws `threat_events.geometry`, which is built from
     * `relation_type='reported_direction'` — a heading a source stated. Same basis, so the same
     * hollow arrowhead, and the class comes from the `LiveEvent` the geometry already belongs to.
     * No server change was needed for this half: `snapshot.threats[]` carries `threatType` beside
     * `geometry`, and joining them in the browser costs one property read.
     */
    it('gets the hollow arrow of a stated heading, and the class of its own event', () => {
      const features = heads([], [{
        id: 't1', title: 'Крилаті ракети на Львівщину', threatType: 'cruise_missile',
        evidenceLevel: 'confirmed',
        geometry: { type: 'LineString', coordinates: [[30, 50], [24, 50]] }
      }]);
      expect(arrows(features)).toHaveLength(1);
      expect(arrows(features)[0]!.properties.arrow).toBe('threat-vector-arrow-open');
      expect(arrows(features)[0]!.properties.basis).toBe('reported_direction');
      expect(arrows(features)[0]!.properties.bearing).toBeCloseTo(270, 9);
      expect(chips(features)[0]!.properties.icon).toBe('ti-cruise_missile-confirmed');
    });

    it('ignores a threat whose geometry is not a line, and a line with one point', () => {
      const features = heads([], [
        { id: 't1', title: 'Точка', threatType: 'uav', geometry: { type: 'Point', coordinates: [30, 50] } },
        { id: 't2', title: 'Огризок', threatType: 'uav', geometry: { type: 'LineString', coordinates: [[30, 50]] } },
        { id: 't3', title: 'Без геометрії', threatType: 'uav', geometry: null }
      ]);
      expect(features).toEqual([]);
    });
  });

  it('says all of this in the legend, and keeps the honesty sentence word for word', () => {
    const legend = bodyOf('renderVectorLegend');
    // The sentence that predates the arrowhead and outlives it. Verbatim, U+02BC and all.
    expect(legend).toContain('Крапкова — різні повідомлення в різний час. Порядок наш; рух не стверджувало жодне джерело.');
    // And the two things the arrowhead added, stated rather than left to be inferred from a glyph.
    expect(legend).toContain('Вістря — рух ствердило саме джерело.');
    expect(legend).toContain('На крапковій лінії вістря немає ніколи');
  });
});

function* permutations<T>(items: T[]): Generator<T[]> {
  if (items.length <= 1) { yield [...items]; return; }
  for (let index = 0; index < items.length; index += 1) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) yield [items[index]!, ...tail];
  }
}

/**
 * `liveLayers`, `litFeature`, the per-DOM-click flag and `openTerritory`, sliced contiguously out of
 * the raw `style.load` block. Nothing else is declared between them, which is what lets one slice
 * carry the whole mechanism.
 */
function clickResolutionSource(): string {
  const block = styleLoadBlock();
  const start = block.indexOf('const liveLayers =');
  const arrow = block.indexOf('const openTerritory =', start);
  if (start === -1 || arrow === -1) throw new Error('the click resolution left the style.load block');
  return `${block.slice(start, balanced(block, block.indexOf('{', block.indexOf('=>', arrow)), '{', '}') + 1)};`;
}

describe('territory click resolution', () => {
  const iconLayerIds = evaluateSlice<string[]>(constDeclaration('iconLayerIds'), 'iconLayerIds');
  const raionFillLayerIds = evaluateSlice<string[]>(constDeclaration('raionFillLayerIds'), 'raionFillLayerIds');
  const everyLayer = [...iconLayerIds, 'ukraine-region-fill', ...raionFillLayerIds, 'city-hit'];
  const factory = lazy(() => compileSlice<(event: unknown) => void>(
    clickResolutionSource(), 'openTerritory',
    ['map', 'iconLayerIds', 'raionFillLayerIds', 'showTerritoryPanel']
  ));

  /**
   * One DOM click, dispatched the way MapLibre dispatches it: `Map.on(type, layerId, listener)`
   * wraps every call in its own delegate, `Evented.fire` walks them in registration order, and each
   * delegate that finds a feature under the point is invoked with the *same* `originalEvent`.
   *
   * `order` is that dispatch order, `present` maps a layer id to the `locationId` its feature would
   * carry under the click, and `existing` is the set of layers that are in the style at all — a
   * canvas failure leaves the four icon layers out of it entirely.
   *
   * `lit` is the set of layers whose feature under the point carries feature-state. MapLibre puts
   * the state on every feature it returns — `{}` for a territory nothing was declared on, because
   * `applyTerritoryLayers` wipes the source and writes only non-empty sets — and that emptiness is
   * the whole signal the raion/oblast guard reads. Stubbing every feature without a `state` would
   * describe a map on which no territory is ever lit.
   */
  function dispatch(
    order: string[], present: Map<string, string>, existing: Set<string>, lit: Set<string>
  ): string[] {
    const opened: string[] = [];
    const featureOf = (id: string) => ({
      layer: { id },
      properties: { locationId: present.get(id) },
      state: lit.has(id) ? { alert: true } : {}
    });
    const map = {
      getLayer: (id: string) => (existing.has(id) ? { id } : undefined),
      queryRenderedFeatures: (_point: unknown, options: { layers: string[] }) => options.layers
        .filter((id) => present.has(id))
        .map(featureOf)
    };
    const openTerritory = factory()(map, iconLayerIds, raionFillLayerIds, (id: string) => { opened.push(id); });
    const originalEvent = { type: 'click' };
    for (const layerId of order) {
      if (!present.has(layerId)) continue;
      openTerritory({ originalEvent, point: { x: 10, y: 10 }, features: [featureOf(layerId)] });
    }
    return opened;
  }

  /**
   * The documented precedence is **icon → city → raion → oblast**, and it must hold whatever order
   * MapLibre happens to call the delegates in — that order is an undocumented implementation
   * detail, and in 5.24 it is registration order, which runs the *coarsest* layer
   * (`ukraine-region-fill`, covering the whole country) ahead of both the raion fills and
   * `city-hit`. So every case below is replayed for every permutation of the delegates that fire.
   *
   * Exactly one panel per DOM click is asserted by the same expectation: the arrays are compared
   * whole, so a second `showTerritoryPanel` call fails just as loudly as none.
   */
  const cases = [
    {
      name: 'an icon stack beats the city, the lit raion and the oblast under it',
      present: new Map([
        ['territory-icon-slot-0', 'icon'], ['territory-icon-badge', 'icon'],
        ['ukraine-region-fill', 'oblast'], ['alert-raion-fill', 'raion'], ['threat-raion-fill', 'raion'],
        ['city-hit', 'city']
      ]),
      lit: ['alert-raion-fill', 'threat-raion-fill'],
      hidden: [] as string[],
      opens: ['icon']
    },
    {
      name: 'a city dot beats the lit raion and the oblast under it',
      present: new Map([
        ['ukraine-region-fill', 'oblast'], ['alert-raion-fill', 'raion'], ['threat-raion-fill', 'raion'],
        ['consequence-raion-fill', 'raion'], ['city-hit', 'city']
      ]),
      lit: ['alert-raion-fill', 'threat-raion-fill', 'consequence-raion-fill'],
      hidden: [] as string[],
      opens: ['city']
    },
    {
      name: 'three raion fills over one lit polygon open the raion once, not the oblast and not thrice',
      present: new Map([
        ['ukraine-region-fill', 'oblast'], ['alert-raion-fill', 'raion'], ['threat-raion-fill', 'raion'],
        ['consequence-raion-fill', 'raion']
      ]),
      lit: ['alert-raion-fill', 'threat-raion-fill', 'consequence-raion-fill'],
      hidden: [] as string[],
      opens: ['raion']
    },
    {
      // Ядро виправлення. Районні заливки існують на кожному масштабі й по всій країні, тож під
      // будь-яким кліком лежить районний полігон. Той, на якому нічого не оголошено, приходить із
      // порожнім feature-state — і мусить віддати клік області, інакше тихий район забирав би його
      // геть усюди, а панель області стала б недосяжною.
      name: 'a raion with no feature-state defers to the oblast',
      present: new Map([
        ['ukraine-region-fill', 'oblast'], ['alert-raion-fill', 'raion'], ['threat-raion-fill', 'raion'],
        ['consequence-raion-fill', 'raion']
      ]),
      lit: [] as string[],
      opens: ['oblast'],
      hidden: [] as string[]
    },
    {
      // Друга половина того самого правила: досить ОДНОГО сімейства зі станом. Три заливки лежать
      // над тим самим полігоном, і стан у них спільний — але запит повертає всі три, тож правило
      // читає їх як одну заяву про район, а не як три незалежні.
      name: 'one lit raion fill beside two quiet ones still beats the oblast, once',
      present: new Map([
        ['ukraine-region-fill', 'oblast'], ['alert-raion-fill', 'raion'], ['threat-raion-fill', 'raion'],
        ['consequence-raion-fill', 'raion']
      ]),
      lit: ['threat-raion-fill'],
      opens: ['raion'],
      hidden: [] as string[]
    },
    {
      // Районні заливки більше не мають minzoom — вони існують на будь-якому масштабі. Порожньою
      // під точкою районна геометрія лишається доти, доки ADM2 у польоті (або взагалі не приїхав),
      // і тоді клік обласний: queryRenderedFeatures не знаходить нічого точнішого.
      name: 'with no raion geometry loaded the oblast wins because nothing finer is drawn',
      present: new Map([['ukraine-region-fill', 'oblast']]),
      lit: [] as string[],
      hidden: [] as string[],
      opens: ['oblast']
    },
    {
      // Деградація: canvas недоступний, чотирьох шарів іконок немає в стилі. queryRenderedFeatures
      // кинув би на неіснуючому шарі — liveLayers() мусить відфільтрувати їх до запиту.
      name: 'a missing icon layer degrades the precision instead of throwing',
      present: new Map([
        ['ukraine-region-fill', 'oblast'], ['alert-raion-fill', 'raion'], ['threat-raion-fill', 'raion']
      ]),
      lit: ['alert-raion-fill', 'threat-raion-fill'],
      hidden: iconLayerIds,
      opens: ['raion']
    }
  ];

  it.each(cases)('$name, in every listener order', ({ present, hidden, lit, opens }) => {
    const existing = new Set(everyLayer.filter((id) => !hidden.includes(id)));
    const firing = [...present.keys()];
    let orders = 0;
    for (const order of permutations(firing)) {
      orders += 1;
      expect(dispatch(order, present, existing, new Set(lit)), `listener order ${order.join(' > ')}`).toEqual(opens);
    }
    expect(orders).toBeGreaterThan(0);
  });

  it('reads the raion feature-state, not merely the presence of a raion fill', () => {
    // Скан по тексту: правило легко звести назад до «є районна фіча — район виграв», і тоді
    // перестановочні випадки вище лишилися б зеленими рівно доти, доки хтось не забув би про
    // порожній стан. Обидві гілки мусять бути в зрізі дослівно.
    const body = clickResolutionSource();
    expect(body).toContain('const litFeature =');
    expect(body).toContain('.some(litFeature)');
    expect(body).toContain('raionFillLayerIds.includes(layerId) && !litRaion');
  });

  it('claims the DOM click on the listener that opens the panel, not on the first one to run', () => {
    // Це і є механізм, який робить попередній тест правдою за будь-якого порядку. Прапорець,
    // поставлений на вході, віддавав би клік найгрубішому шару, і той виходив би по перевірці
    // точності, не відкривши нічого й не давши відкрити нікому.
    const body = clickResolutionSource();
    const claim = body.indexOf('lastTerritoryClick = event.originalEvent');
    const open = body.indexOf('showTerritoryPanel(');
    expect(claim).toBeGreaterThan(-1);
    for (const guard of ['liveLayers(iconLayerIds)', `liveLayers(['city-hit'])`, 'liveLayers(raionFillLayerIds)']) {
      expect(body.indexOf(guard), `guard ${guard} runs after the click is claimed`).toBeLessThan(claim);
    }
    expect(claim).toBeLessThan(open);
  });
});

describe('territory icon stacks', () => {
  const chip = evaluateSlice<number>(constDeclaration('ICON_CHIP_PX'), 'ICON_CHIP_PX');
  const lift = evaluateSlice<number>(constDeclaration('ICON_TIER_LIFT'), 'ICON_TIER_LIFT');
  const badgeTextSize = evaluateSlice<number>(constDeclaration('ICON_BADGE_TEXT_SIZE'), 'ICON_BADGE_TEXT_SIZE');

  const source = lazy(() => [
    constDeclaration('ICON_SLOT_OFFSETS'),
    constDeclaration('ICON_BADGE_OFFSET'),
    constDeclaration('ICON_BADGE_TEXT_SIZE'),
    constDeclaration('ICON_TIER_LIFT'),
    constDeclaration('MAX_ICON_SLOTS'),
    `function territoryIconCollection() ${bodyOf('territoryIconCollection')}`
  ].join('\n'));

  interface Stack { properties: Record<string, [number, number] | string | number> }

  function collect(territories: unknown[], centroids: Record<string, [number, number]>, tier = 'oblast'): Stack[] {
    const collection = evaluateSlice<() => { features: Stack[] }>(source(), 'territoryIconCollection', {
      snapshotTerritories: () => territories,
      iconTier: tier,
      regionCentroid: (id: string) => centroids[id] ?? null,
      iconFamilyVisible: () => true,
      territoryAriaSentence: (territory: { name: string }) => `${territory.name}.`,
      iconImageId: (threatType: string, tone: string) => `ti-${threatType}-${tone}`
    });
    return collection().features;
  }

  /**
   * Kyiv city (`ua-80`, a `special_city`) sits inside the hole of Kyiv oblast (`ua-32`), and the two
   * centroids are 17.4 km apart — 6 px at the map's own opening zoom of 5.1. Both stacks carry
   * `icon-allow-overlap: true`, so MapLibre is explicitly forbidden from resolving the collision;
   * the anchors have to be separated here or the two stacks and their two `+N` badges overprint,
   * which is precisely the Kyiv-raid case the icons exist for. The same superposition happens at
   * raion zoom for every oblast whose centroid falls inside one of its own raions.
   */
  it('lifts a stack that is not an oblast clear of the oblast stack enclosing it', () => {
    const [oblast, city] = collect([
      { locationId: 'ua-32', tier: 'oblast', name: 'Київська область', iconOverflow: 0,
        icons: [{ threatType: 'uav', tone: 'confirmed' }] },
      { locationId: 'ua-80', tier: 'special_city', name: 'м. Київ', iconOverflow: 0,
        icons: [{ threatType: 'ballistic_missile', tone: 'confirmed' }, { threatType: 'uav', tone: 'confirmed' },
          { threatType: 'cruise_missile', tone: 'reported' }, { threatType: 'aviation', tone: 'analytic' }] }
    ], { 'ua-32': [30.458128, 50.302764], 'ua-80': [30.547518, 50.448691] });

    expect(oblast!.properties.off0).toEqual([0, 0]);
    // icon-offset is in pixels × icon-size, so the gap does not melt away as the map zooms out.
    expect((city!.properties.off0 as [number, number])[1]).toBe(lift);
    expect((city!.properties.off1 as [number, number])[1]).toBe(lift);
    expect((city!.properties.off2 as [number, number])[1]).toBe(lift);
    const gap = Math.abs((city!.properties.off0 as [number, number])[1] - (oblast!.properties.off0 as [number, number])[1]);
    expect(gap, 'the two stacks still overlap vertically').toBeGreaterThan(chip);
    // text-offset is in ems of the badge's own text-size, so the «+N» stays glued to its own stack.
    expect((city!.properties.badgeOffset as [number, number])[1]).toBeCloseTo(lift / badgeTextSize, 10);
    expect((oblast!.properties.badgeOffset as [number, number])[1]).toBe(0);
  });

  it('leaves the horizontal slot layout of both tiers untouched', () => {
    const slots = evaluateSlice<Record<number, [number, number][]>>(
      constDeclaration('ICON_SLOT_OFFSETS'), 'ICON_SLOT_OFFSETS');
    const [oblast, city] = collect([
      { locationId: 'ua-32', tier: 'oblast', name: 'Київська область', iconOverflow: 0,
        icons: [{ threatType: 'uav', tone: 'confirmed' }, { threatType: 'mlrs', tone: 'reported' }] },
      { locationId: 'ua-80', tier: 'special_city', name: 'м. Київ', iconOverflow: 0,
        icons: [{ threatType: 'uav', tone: 'confirmed' }, { threatType: 'mlrs', tone: 'reported' }] }
    ], { 'ua-32': [30.458128, 50.302764], 'ua-80': [30.547518, 50.448691] });
    for (const stack of [oblast!, city!]) {
      expect((stack.properties.off0 as [number, number])[0]).toBe(slots[2]![0]![0]);
      expect((stack.properties.off1 as [number, number])[0]).toBe(slots[2]![1]![0]);
    }
  });
});

describe('map live region', () => {
  const ariaSource = lazy(() => `function writeMapAria() ${bodyOf('writeMapAria')}`);

  function write(options: {
    territories: unknown[];
    stacks?: { properties: { locationId: string; aria: string } }[];
    alerts?: { location_name: string }[];
    tier?: string;
  }): string {
    const node = { textContent: '' };
    evaluateSlice<() => void>(ariaSource(), 'writeMapAria', {
      $: () => node,
      territoryIconCollection: () => ({ features: options.stacks ?? [] }),
      iconTier: options.tier ?? 'oblast',
      snapshotTerritories: () => options.territories,
      territoryAriaSentence: (territory: { name: string }) => `${territory.name}: офіційна тривога.`,
      snapshot: options.alerts ? { alerts: options.alerts } : null
    })();
    return node.textContent;
  }

  /**
   * An official alert is a polygon fill, never an icon — `iconCandidatesFor` builds candidates from
   * asserted threats and assessments alone — so a territory whose only state is an alert produces
   * no feature in `territory-icons` at all. Built from the icon stacks, the live region therefore
   * announced one UAV over Odesa and stayed silent about fifteen alerted oblasts: the single most
   * important thing the map was showing.
   */
  it('names an alerted territory that carries no icon, and names it first', () => {
    const text = write({
      territories: [
        { locationId: 'ua-51', tier: 'oblast', name: 'Одеська область', alertActive: false },
        { locationId: 'ua-32', tier: 'oblast', name: 'Київська область', alertActive: true },
        { locationId: 'ua-63', tier: 'oblast', name: 'Харківська область', alertActive: true }
      ],
      stacks: [{ properties: { locationId: 'ua-51', aria: 'Одеська область: ударні БпЛА.' } }]
    });
    expect(text).toContain('Київська область: офіційна тривога.');
    expect(text).toContain('Харківська область: офіційна тривога.');
    expect(text).toContain('Одеська область: ударні БпЛА.');
    expect(text.indexOf('Київська'), 'alerts must lead').toBeLessThan(text.indexOf('Одеська'));
  });

  it('says nothing about a territory that is neither alerted nor stacked', () => {
    const text = write({
      territories: [{ locationId: 'ua-32', tier: 'oblast', name: 'Київська область', alertActive: false }]
    });
    expect(text).toBe('Активних позначок на карті немає.');
  });

  it('counts every announced territory in the honesty suffix, not only the stacked ones', () => {
    const territories = Array.from({ length: 11 }, (_, index) => ({
      locationId: `ua-${index}`, tier: 'oblast', name: `Область ${index}`, alertActive: true
    }));
    const text = write({ territories });
    expect(text).toContain('Показано 8 територій із 11.');
    expect(text).toContain('Область 7: офіційна тривога.');
    expect(text).not.toContain('Область 8:');
  });

  it('keeps the oblast-zoom tier boundary of the stacks', () => {
    const text = write({
      territories: [
        { locationId: 'ua-3222', tier: 'raion', name: 'Бориспільський район', alertActive: true },
        { locationId: 'ua-32', tier: 'oblast', name: 'Київська область', alertActive: true }
      ]
    });
    expect(text).toBe('Київська область: офіційна тривога.');
  });

  it('still falls back to the raw alert list for a payload with no territories', () => {
    const text = write({ territories: [], alerts: [{ location_name: 'Львівська область' }] });
    expect(text).toBe('Львівська область: офіційна тривога.');
  });
});

describe('map text survives a failed icon pipeline', () => {
  const source = lazy(() => `function updateTerritoryIcons() ${bodyOf('updateTerritoryIcons')}`);

  function run(mapLayersReady: boolean, iconLayersReady: boolean): string[] {
    const calls: string[] = [];
    evaluateSlice<() => void>(source(), 'updateTerritoryIcons', {
      mapLayersReady,
      iconLayersReady,
      map: { getSource: () => ({ setData: () => calls.push('setData') }) },
      territoryIconCollection: () => ({ type: 'FeatureCollection', features: [] }),
      writeMapAria: () => calls.push('aria')
    })();
    return calls;
  }

  /**
   * `addThreatIconImages` swallows a missing canvas 2D context, a missing `Path2D` and a throwing
   * `addImage`, which leaves `iconLayersReady` false forever. Gating the live region on that flag
   * made the map's only textual equivalent a dependent of the raster pipeline: the polygons still
   * rendered and `#map-aria` stayed permanently empty.
   */
  it('writes the live region even when the raster icon layers never came up', () => {
    expect(run(true, false)).toEqual(['aria']);
    expect(run(true, true)).toEqual(['setData', 'aria']);
  });

  it('still writes nothing before the map layers exist', () => {
    expect(run(false, true)).toEqual([]);
  });
});

describe('snapshot refresh and the operations console', () => {
  const source = lazy(() => `function renderCurrentRoute(options = {}) ${bodyOf('renderCurrentRoute')}`);
  const parameters = ['snapshot', 'activePage', 'map', 'mapLayersReady', 'codexPollTimer', 'deployPollTimer',
    'renderedRoute',
    'renderMapPage', 'renderHistory', 'renderAttacks', 'renderAnalytics', 'renderSources', 'renderOps',
    'renderOpsSettings', 'renderAbout'];

  /**
   * `renderedRoute`, `map` and `mapLayersReady` are module-level `let`s that the function assigns
   * to. Injected as parameters they become closure variables of one compiled instance, so the
   * assignments survive between calls exactly as they do in the bundle — which is the whole point:
   * the first render and the hundredth have to behave differently.
   */
  function router(route: string): { render: (options?: unknown) => void; calls: string[] } {
    const calls: string[] = [];
    const stub = (name: string) => () => { calls.push(name); };
    const render = compileSlice<(options?: unknown) => void>(source(), 'renderCurrentRoute', parameters)(
      // snapshot, activePage, map, mapLayersReady, codexPollTimer, deployPollTimer, renderedRoute…
      // The deployment card polls `/ops/api/deploy` on its own three-second timer, and leaving `/ops`
      // has to stop it: the node it repaints does not exist on any other route.
      { version: 1 }, () => route, null, false, null, null, null,
      stub('map'), stub('history'), stub('attacks'), stub('analytics'), stub('sources'), stub('ops'),
      stub('settings'), stub('about')
    );
    return { render, calls };
  }

  /**
   * `renderOps()` opens with `contentShell(…)`, which is `#app.replaceChildren(…)` — a full DOM
   * wipe. Driving that from the snapshot meant the 60 s belt and every SSE frame reverted the
   * runtime form to its stored values mid-edit, and discarded a half-typed Basic-auth password. The
   * console reads nothing from `snapshot`; it fetches all of its own data and refreshes itself.
   */
  it('renders the console once on a direct load and then leaves the operator alone', () => {
    const { render, calls } = router('/ops');
    render({ fromSnapshot: true });         // boot() -> loadSnapshot(), the only render /ops ever gets
    expect(calls).toEqual(['ops']);
    render({ fromSnapshot: true });         // the 60 s belt
    render({ fromSnapshot: true });         // an SSE frame, debounced 250 ms
    expect(calls).toEqual(['ops']);
  });

  it('still renders the console when the operator navigates to it', () => {
    const { render, calls } = router('/ops');
    render({ fromSnapshot: true });
    render();                                // a[data-route] click handler calls it bare
    expect(calls).toEqual(['ops', 'ops']);
  });

  it('reads the popstate Event as a navigation, not as a snapshot tick', () => {
    // window.addEventListener('popstate', renderCurrentRoute) passes the Event as `options`, and an
    // Event has no `fromSnapshot` — which is why the flag is compared against true, not truthiness.
    const { render, calls } = router('/ops');
    render({ fromSnapshot: true });
    render({ type: 'popstate' });
    expect(calls).toEqual(['ops', 'ops']);
  });

  it('leaves every other route repainting on every snapshot', () => {
    for (const [route, rendered] of [['/', 'map'], ['/history', 'history'], ['/attacks', 'attacks'],
      ['/analytics', 'analytics'], ['/sources', 'sources'], ['/about', 'about']]) {
      const { render, calls } = router(route!);
      render({ fromSnapshot: true });
      render({ fromSnapshot: true });
      expect(calls, `route ${route}`).toEqual([rendered, rendered]);
    }
  });

  /**
   * The settings registry is the second console screen and carries the same hazard, magnified.
   *
   * `renderOpsSettings()` also opens with `contentShell(…)`, and what it wipes is up to eighty
   * fields — a half-typed bound, a password typed into a secret's replacement input that the server
   * will never send back. Driving that from the snapshot would revert all of it on the 60 s belt.
   * So it takes the same guard as `/ops`, and these cases are what stop the guard being dropped by
   * somebody who reads the branch as a copy of its neighbour.
   */
  it('renders the settings registry once on a direct load and then leaves the operator alone', () => {
    const { render, calls } = router('/ops/settings');
    render({ fromSnapshot: true });         // boot() -> loadSnapshot()
    expect(calls).toEqual(['settings']);
    render({ fromSnapshot: true });         // the 60 s belt
    render({ fromSnapshot: true });         // an SSE frame, debounced 250 ms
    expect(calls).toEqual(['settings']);
  });

  it('still renders the settings registry when the operator navigates to it', () => {
    const { render, calls } = router('/ops/settings');
    render({ fromSnapshot: true });
    render();                                // the a[data-route] click handler calls it bare
    render({ type: 'popstate' });            // and the back button passes an Event
    expect(calls).toEqual(['settings', 'settings', 'settings']);
  });

  /**
   * `/ops/settings` is not `/ops`, and neither route may answer for the other.
   *
   * Both halves are one edit away from breaking: a `startsWith('/ops')` written for tidiness would
   * make the console answer for the registry, and a settings branch placed after the `else` would
   * make «Методологія» answer for both.
   */
  it('keeps the two console routes apart', () => {
    const console_ = router('/ops');
    console_.render({ fromSnapshot: true });
    expect(console_.calls).toEqual(['ops']);

    const settings = router('/ops/settings');
    settings.render({ fromSnapshot: true });
    expect(settings.calls).toEqual(['settings']);

    // Neither falls through to the about page, which is what the bare `else` would have done.
    for (const route of ['/ops', '/ops/settings']) {
      const { render, calls } = router(route);
      render({ fromSnapshot: true });
      expect(calls, `route ${route}`).not.toContain('about');
    }
  });

  /**
   * Leaving the console stops both of its timers, and `/ops/settings` counts as leaving.
   *
   * The deployment card repaints `#deploy-section` every three seconds and the Codex poll watches a
   * node that only `/ops` builds. Neither exists on the registry page, so both must be cleared on
   * the way in — the guard is `route !== '/ops'`, and this is the case that proves the settings
   * route was not quietly folded into it.
   */
  it('stops the console timers when the operator opens the registry', () => {
    const cleared: number[] = [];
    const source_ = `function renderCurrentRoute(options = {}) ${bodyOf('renderCurrentRoute')}`;
    const names = [...parameters, 'clearInterval'];
    const render = compileSlice<(options?: unknown) => void>(source_, 'renderCurrentRoute', names)(
      { version: 1 }, () => '/ops/settings', null, false, 41, 42, null,
      () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {}, () => {},
      (id: number) => { cleared.push(id); }
    );
    render({ fromSnapshot: true });
    expect(cleared).toEqual([41, 42]);
  });
});

/**
 * The settings page's lookup tables, and the one link on it that leaves the application.
 *
 * `docs/` is NOT served: `fastifyStatic` is mounted on `public/`, and `/docs/TOKENS.md` would not
 * even 404 — the SPA not-found handler would answer it with `index.html`, i.e. with the map. So the
 * acquisition steps live inline on the page and the deep link goes to the repository blob. That
 * makes the anchor a real dependency between two files nobody edits together, which is exactly the
 * kind of link that rots in silence: the page would keep rendering «як отримати →» and land the
 * operator at the top of a nine-section document.
 */
describe('the settings registry tables', () => {
  const labels = lazy(() => evaluateSlice<Record<string, string>>(
    constDeclaration('APP_SETTING_LABELS'), 'APP_SETTING_LABELS'));
  const anchors = lazy(() => evaluateSlice<Record<string, string>>(
    constDeclaration('APP_SETTING_DOC_ANCHORS'), 'APP_SETTING_DOC_ANCHORS'));
  const howto = lazy(() => evaluateSlice<Record<string, string[]>>(
    constDeclaration('APP_SETTING_HOWTO'), 'APP_SETTING_HOWTO'));

  it('labels every key by its environment-variable name', () => {
    const keys = Object.keys(labels());
    expect(keys.length).toBeGreaterThan(60);
    for (const key of keys) {
      expect(key, `${key} is not an env-variable name`).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(labels()[key]!.trim().length, `${key} has an empty label`).toBeGreaterThan(0);
    }
  });

  it('points every «як отримати →» at an anchor docs/TOKENS.md actually carries', () => {
    const tokens = read('docs/TOKENS.md');
    const targets = [...new Set(Object.values(anchors()))];
    expect(targets.length).toBeGreaterThan(0);
    for (const anchor of targets) {
      // An explicit HTML anchor, not a heading slug: the link is followed on the repository blob,
      // and a heading rewritten in Ukrainian would silently change a slug that nothing checks.
      expect(tokens, `docs/TOKENS.md has no <a id="${anchor}">`).toContain(`<a id="${anchor}">`);
      expect(howto()[anchor], `no inline steps for ${anchor}`).toBeTruthy();
      expect(howto()[anchor]!.length, `${anchor} has no steps`).toBeGreaterThan(0);
    }
  });

  it('gives every inline instruction block a key that reaches it', () => {
    // The reverse direction. A block nothing points at is dead text that reads as coverage.
    const reachable = new Set(Object.values(anchors()));
    for (const anchor of Object.keys(howto())) {
      expect(reachable.has(anchor), `nothing in APP_SETTING_DOC_ANCHORS reaches ${anchor}`).toBe(true);
    }
  });

  it('labels only keys the registry declares', () => {
    // The tables are labels, not a second registry: the page is built from what the server sends.
    // A label for a key `src/config.ts` no longer has is a label nothing will ever render.
    const config = read('src/config.ts');
    const declared = new Set([...config.matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]!));
    const stray = Object.keys(labels()).filter((key) => !declared.has(key));
    expect(stray, 'labels for keys the schema does not declare').toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------
// «Не вигадуємо географію» as a zoom rule
// ------------------------------------------------------------------------------------------------

/**
 * An alert is declared on named raions, so the country-wide map has to light those raions — not wash
 * the oblast that contains them and reveal the truth only to whoever thinks to zoom in. Two halves of
 * one rule, and both are easy to undo by accident:
 *
 *  1. **A raion polygon is not a zoom level.** No raion layer carries a `minzoom`, and no state
 *     opacity is interpolated over `['zoom']` in any family. Zoom may change line *widths* and label
 *     *sizes* — aesthetics — and it may fade the neutral raion grid in, because that grid is the
 *     basemap rather than a claim. It may not change what the map asserts.
 *  2. **Derived coverage paints nothing.** `partial` — an ancestor of a territory that has its own
 *     outline — is exactly the invented geography the rule forbids: the lit raions inside already
 *     carry the signal. The key is still written into feature-state, and is still the panel's
 *     vocabulary, but no paint expression and no label may read it.
 *
 * `unmapped` is the deliberate exception and must survive both halves: a named place with no outline
 * of its own (a city, a hromada) lights the nearest ancestor that has one, because no finer layer
 * will ever supersede it. That is also what keeps a raion alert on the map while ADM2 is in flight —
 * `claim()` files it as `unmapped` on the oblast, since the raion has no feature to light yet.
 */
describe('raion polygons are a statement, not a zoom level', () => {
  const RAION_LAYERS = [
    'threat-raion-fill', 'alert-raion-fill', 'consequence-raion-fill',
    'analytic-raion-line', 'threat-raion-line', 'alert-raion-line', 'consequence-raion-line',
    'alert-raion-label'
  ];

  /** The whole `map.addLayer(…)` call that declares `id`, from the raw `style.load` block. */
  function layerCall(id: string): string {
    const block = styleLoadBlock();
    const marker = block.indexOf(`id: '${id}'`);
    if (marker === -1) throw new Error(`layer ${id} is no longer declared in the style.load block`);
    const open = block.lastIndexOf('map.addLayer(', marker);
    return block.slice(open, balanced(block, block.indexOf('(', open), '(', ')') + 1);
  }

  const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

  it('gives no raion layer a minzoom', () => {
    for (const id of RAION_LAYERS) {
      expect(layerCall(id), `${id} hides itself below a zoom`).not.toContain('minzoom');
    }
  });

  it('never lets zoom decide how strongly a state is drawn', () => {
    const block = styleLoadBlock();
    // Fills and labels: no zoom term at all.
    expect(occurrences(block, `'fill-opacity': ['interpolate'`)).toBe(0);
    expect(occurrences(block, `'text-opacity'`)).toBe(0);
    // Outlines: exactly one, and it is the neutral raion grid on `alert-raion-line` — the basemap
    // affordance that shows raion borders up close. Its two stops carry the same alert and unmapped
    // values, so only the default (no state at all) branch moves with zoom.
    expect(occurrences(block, `'line-opacity': ['interpolate'`)).toBe(1);
    const grid = layerCall('alert-raion-line');
    expect(grid).toContain(`6,   ['case', alertFlag, .9, unmappedFlag, .66, 0]`);
    expect(grid).toContain(`6.8, ['case', alertFlag, .9, unmappedFlag, .66, .22]`);
  });

  it('reads no derived coverage in any paint expression', () => {
    // Одна перевірка на всі чотири сімейства: жодна фарба не має права назвати похідне покриття.
    expect(styleLoadBlock()).not.toMatch(/[Pp]artial/);
  });

  it('still writes the derived coverage into feature-state', () => {
    // Ключ лишається — його пише той самий один прохід, що й решту одинадцяти, і він є машинно
    // читаним записом про те, що всередині області названо конкретну територію.
    const body = bodyOf('territoryStateOf');
    for (const key of [`'partial'`, `'threatPartial'`, `'consequencePartial'`, `'analyticPartial'`]) {
      expect(body, `territoryStateOf stopped writing ${key}`).toContain(key);
    }
  });

  it('leaves the raion labels to the collision engine', () => {
    // Підпис із allow-overlap на оглядовому масштабі перетворив би пів країни на суцільний текст;
    // саме колізія MapLibre проріджує назви там, де тривога охопила багато районів.
    const label = layerCall('alert-raion-label');
    expect(label).not.toContain('allow-overlap');
    expect(label).not.toContain('ignore-placement');
  });

  it('labels a directly named raion and an outline-less place, and never a derived ancestor', () => {
    const alertLabelCollection = evaluateSlice<(fam: unknown) => { features: { properties: Record<string, string> }[] }>(
      `function alertLabelCollection(fam) ${bodyOf('alertLabelCollection')}`,
      'alertLabelCollection',
      {
        locationIndexes: () => ({ names: new Map([
          ['ua-3222', 'Бориспільський район'], ['ua-32', 'Київська область'], ['ua-51', 'Одеська область']
        ]) }),
        regionCentroid: () => [30, 50],
        regionFeatures: new Map(),
        oblastIds: new Set(['ua-32', 'ua-51'])
      }
    );
    // ua-3222: the raion the source named. ua-51: an oblast holding a named city, so no finer layer
    // will ever supersede it. ua-32: the oblast above ua-3222 — its lit raion says everything.
    const features = alertLabelCollection({
      direct: new Set(['ua-3222']),
      covered: new Set(['ua-32', 'ua-51']),
      unmapped: new Set(['ua-51'])
    }).features;
    expect(features.map((feature) => feature.properties.locationId).sort()).toEqual(['ua-3222', 'ua-51']);
    expect(features.map((feature) => feature.properties.tone).sort()).toEqual(['direct', 'unmapped']);
    expect(features.find((feature) => feature.properties.locationId === 'ua-3222')?.properties)
      .toMatchObject({ level: 'raion', label: 'Бориспільський' });
  });

  it('keeps the icon tier as the map\'s only remaining zoom threshold', () => {
    // Свідома асиметрія: полігони більше не залежать від масштабу, стеки іконок — залежать. Гліф
    // стверджує клас зброї над точкою, і 136 таких заяв оглядовий масштаб не витримує.
    expect(APP_SOURCE).toContain('const ICON_TIER_ZOOM = 6.8;');
    expect(APP_SOURCE).not.toContain('RAION_ZOOM_MIN');
    expect(APP_SOURCE).not.toContain('RAION_ZOOM_FULL');
    // Рівно два пороги, обидва — перемикач рівня стеків: у zoomend і при першій побудові шарів.
    expect(occurrences(APP_SOURCE, '>= ICON_TIER_ZOOM')).toBe(2);
  });
});
