import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
    .replace('addVectorLayers();', bodyOf('addVectorLayers'));
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
      'threat-vector-nodes', 'threat-vector-order'
    ]);
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

  it('keeps the style.load block free of straight apostrophes in Ukrainian words', () => {
    // balanced() treats ' as a string delimiter and does not skip comments, so one «обʼєкт» written
    // with U+0027 desynchronises the parser for the rest of the block and every layer assertion in
    // this file starts testing a nonsense list. The file's convention is the modifier letter ʼ.
    const block = styleLoadBlock();                    // the raw slice, before the .replace() calls
    expect(block).not.toMatch(/[а-яіїєґА-ЯІЇЄҐ]'[а-яіїєґА-ЯІЇЄҐ]/u);
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
  });
});
