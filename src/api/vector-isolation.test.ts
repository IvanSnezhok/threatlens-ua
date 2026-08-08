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
      'territory-icon-slot-0', 'territory-icon-slot-1', 'territory-icon-slot-2', 'territory-icon-badge'
    ]);
  });

  it('keeps the threat icons above every other layer', () => {
    // Іконки — головний показник карти, тож вони додаються без якоря й лягають на самий верх.
    const iconIds = ['territory-icon-slot-0', 'territory-icon-slot-1', 'territory-icon-slot-2', 'territory-icon-badge'];
    const lastVector = Math.max(...['threat-vector-sequence', 'threat-vector-direction', 'threat-vector-transit',
      'threat-vector-nodes', 'threat-vector-order'].map((id) => order.indexOf(id)));
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
    for (const id of ['threat-vector-sequence', 'threat-vector-direction', 'threat-vector-transit', 'threat-vector-nodes', 'threat-vector-order']) {
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

function* permutations<T>(items: T[]): Generator<T[]> {
  if (items.length <= 1) { yield [...items]; return; }
  for (let index = 0; index < items.length; index += 1) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) yield [items[index]!, ...tail];
  }
}

/**
 * `liveLayers`, the per-DOM-click flag and `openTerritory`, sliced contiguously out of the raw
 * `style.load` block. They are adjacent and comment-free in the source, which is what lets one
 * slice carry the whole mechanism.
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
   */
  function dispatch(order: string[], present: Map<string, string>, existing: Set<string>): string[] {
    const opened: string[] = [];
    const map = {
      getLayer: (id: string) => (existing.has(id) ? { id } : undefined),
      queryRenderedFeatures: (_point: unknown, options: { layers: string[] }) => options.layers
        .filter((id) => present.has(id))
        .map((id) => ({ layer: { id }, properties: { locationId: present.get(id) } }))
    };
    const openTerritory = factory()(map, iconLayerIds, raionFillLayerIds, (id: string) => { opened.push(id); });
    const originalEvent = { type: 'click' };
    for (const layerId of order) {
      if (!present.has(layerId)) continue;
      openTerritory({
        originalEvent,
        point: { x: 10, y: 10 },
        features: [{ layer: { id: layerId }, properties: { locationId: present.get(layerId) } }]
      });
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
      name: 'an icon stack beats the city, the raion and the oblast under it',
      present: new Map([
        ['territory-icon-slot-0', 'icon'], ['territory-icon-badge', 'icon'],
        ['ukraine-region-fill', 'oblast'], ['alert-raion-fill', 'raion'], ['threat-raion-fill', 'raion'],
        ['city-hit', 'city']
      ]),
      hidden: [] as string[],
      opens: ['icon']
    },
    {
      name: 'a city dot beats the raion and the oblast under it',
      present: new Map([
        ['ukraine-region-fill', 'oblast'], ['alert-raion-fill', 'raion'], ['threat-raion-fill', 'raion'],
        ['consequence-raion-fill', 'raion'], ['city-hit', 'city']
      ]),
      hidden: [] as string[],
      opens: ['city']
    },
    {
      name: 'three raion fills over one polygon open the raion once, not the oblast and not thrice',
      present: new Map([
        ['ukraine-region-fill', 'oblast'], ['alert-raion-fill', 'raion'], ['threat-raion-fill', 'raion'],
        ['consequence-raion-fill', 'raion']
      ]),
      hidden: [] as string[],
      opens: ['raion']
    },
    {
      // Нижче RAION_ZOOM_MIN районних заливок під точкою немає взагалі, тож клік завжди обласний.
      name: 'below the raion zoom the oblast wins because nothing finer is drawn',
      present: new Map([['ukraine-region-fill', 'oblast']]),
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
      hidden: iconLayerIds,
      opens: ['raion']
    }
  ];

  it.each(cases)('$name, in every listener order', ({ present, hidden, opens }) => {
    const existing = new Set(everyLayer.filter((id) => !hidden.includes(id)));
    const firing = [...present.keys()];
    let orders = 0;
    for (const order of permutations(firing)) {
      orders += 1;
      expect(dispatch(order, present, existing), `listener order ${order.join(' > ')}`).toEqual(opens);
    }
    expect(orders).toBeGreaterThan(0);
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
  const parameters = ['snapshot', 'activePage', 'map', 'mapLayersReady', 'codexPollTimer', 'renderedRoute',
    'renderMapPage', 'renderHistory', 'renderAttacks', 'renderAnalytics', 'renderSources', 'renderOps', 'renderAbout'];

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
      { version: 1 }, () => route, null, false, null, null,
      stub('map'), stub('history'), stub('attacks'), stub('analytics'), stub('sources'), stub('ops'), stub('about')
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
});
