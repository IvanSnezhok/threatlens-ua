#!/usr/bin/env node
/**
 * Writes the `.br` and `.gz` siblings for the static assets this deployment serves pre-encoded:
 * `public/data/*.geojson`, which Caddy serves, and `public/assets/*.{js,css}`, which Fastify does.
 *
 * Why the GeoJSON bytes are committed and the bundle bytes are not
 * ----------------------------------------------------------------
 * Caddy serves the three `.geojson` files itself, from a read-only bind mount of the checkout
 * (`Caddyfile`, `compose.yaml`) — not from the application image. So a sibling that exists only
 * inside a Docker build is a sibling Caddy never sees. The checkout is the delivery path, therefore
 * the checkout is where those compressed forms have to live.
 *
 * `/assets/*` is the opposite case: Caddy proxies it to Fastify, the bundle is gitignored esbuild
 * output, and its siblings therefore belong beside it inside the image, written by this same script
 * right after the build that produced them. See {@link BUILT_DIR}.
 *
 * Why precompress at all when `encode gzip` is already on
 * ------------------------------------------------------
 * Two reasons, and the second is the bigger one.
 *
 *   - CPU. `encode` compresses per response, with no cache. Measured on this machine, one cold
 *     request for `ukraine-adm2.geojson` (1024 KiB) costs Caddy ~13.5 ms of CPU for the gzip alone.
 *     A pre-encoded sibling costs a `stat` and a `sendfile`.
 *   - Bytes. Caddy has no Brotli *compressor* — `encode` speaks gzip and zstd only — but
 *     `file_server` will happily serve a `.br` file that something else produced. That is the whole
 *     difference between 300 KiB and 171 KiB for the raion layer, on the one asset every visitor
 *     downloads before the map can draw. There is no other route to it.
 *
 * Fonts get no siblings: `.woff2` is already Brotli inside, and a second pass makes it bigger.
 *
 * The siblings are only correct as long as they decompress back to the source byte for byte, and
 * nothing in a normal edit forces anyone to remember that. `src/api/static-precompression.test.ts`
 * is the thing that remembers: it inflates every sibling and compares. Change a `.geojson`, forget
 * this script, and the unit suite fails naming the command. The bundle half is checked the same way
 * whenever siblings for it exist — and skipped when they do not, because the bundle is gitignored
 * and a checkout is not required to have built one.
 *
 * Usage: `npm run build:static` (the `Dockerfile` runs it after `npm run build`, which is what puts
 * the bundle siblings in the image).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * The COMMITTED half. These three files are Caddy's to serve, from a read-only bind mount of the
 * checkout, so their siblings have to live in the checkout too.
 */
export const PRECOMPRESSED_DIR = 'public/data';
export const PRECOMPRESSED_EXTENSION = '.geojson';

/**
 * The BUILT half, and it is deliberately NOT committed.
 *
 * `app.js` (1.4 MiB) and `app.css` (167 KiB) are esbuild output, they are gitignored, and a sibling
 * of theirs in the checkout would go stale on the very next `npm run build:web` with nothing to
 * catch it. What changed is who serves them: they are NOT on Caddy's bind mount — Caddy proxies
 * `/assets/*` to Fastify, which now registers `@fastify/static` with `preCompressed: true`. So the
 * siblings belong to the IMAGE, where they are produced immediately after the bundle they describe
 * (`Dockerfile`, `npm run build && npm run build:static`) and cannot outlive it. A client that
 * sends `Accept-Encoding: br` then receives `app.js.br` by `stat` and `sendfile`, and Caddy's
 * site-wide `encode` passes an already-encoded response through instead of gzipping a megabyte per
 * cold request.
 *
 * Missing directory or missing bundle is NOT an error: a checkout that has not run `npm run
 * build:web` simply has no built half, and the committed half above still has to be regenerable.
 */
export const BUILT_DIR = 'public/assets';
/** `.woff2` is excluded by omission: it is already Brotli inside, and a second pass makes it bigger. */
export const BUILT_EXTENSIONS = ['.js', '.css'];

/** In the order Caddy's `precompressed br gzip` — and `@fastify/static`'s own negotiation — prefer them. */
export const PRECOMPRESSED_ENCODINGS = ['br', 'gz'];

/** Every source file that must have a sibling, repo-relative and sorted. */
export function precompressibleFiles() {
  return readdirSync(resolve(ROOT, PRECOMPRESSED_DIR))
    .filter((name) => name.endsWith(PRECOMPRESSED_EXTENSION))
    .sort()
    .map((name) => `${PRECOMPRESSED_DIR}/${name}`);
}

/** Every built bundle file that should have a sibling inside the image, repo-relative and sorted. */
export function builtFiles() {
  let names;
  try {
    names = readdirSync(resolve(ROOT, BUILT_DIR));
  } catch {
    return [];
  }
  return names
    // Extension match, not a name list: `.br`, `.gz`, `.map` and the `fonts/` directory all fail it,
    // so a previous run's output can never be compressed again into a sibling of a sibling.
    .filter((name) => BUILT_EXTENSIONS.some((extension) => name.endsWith(extension)))
    .sort()
    .map((name) => `${BUILT_DIR}/${name}`);
}

export function compress(encoding, source) {
  if (encoding === 'gz') return gzipSync(source, { level: 9 });
  // Quality 11 and an explicit size hint: this runs by hand a couple of times per project lifetime,
  // so the ~1.3 s it costs for the largest file buys bytes on every cold visit for free.
  return brotliCompressSync(source, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      [constants.BROTLI_PARAM_SIZE_HINT]: source.length
    }
  });
}

function kib(bytes) {
  return `${String(Math.round(bytes / 1024)).padStart(5)} KiB`;
}

function main() {
  const committed = precompressibleFiles();
  if (committed.length === 0) {
    console.error(`no ${PRECOMPRESSED_EXTENSION} files under ${PRECOMPRESSED_DIR}`);
    process.exitCode = 1;
    return;
  }
  // The built half is optional and silent when absent — see {@link BUILT_DIR}. It is never a reason
  // to fail: `npm run build:static` has to stay runnable in a checkout that has never built the web
  // bundle, which is every checkout that only edits a `.geojson`.
  const built = builtFiles();
  for (const file of [...committed, ...built]) {
    const source = readFileSync(resolve(ROOT, file));
    const parts = [`${file.padEnd(34)} ${kib(source.length)}`];
    for (const encoding of PRECOMPRESSED_ENCODINGS) {
      const target = `${file}.${encoding}`;
      const encoded = compress(encoding, source);
      // Rewritten unconditionally. A sibling that is merely *present* is the failure this script
      // exists to prevent; only one that round-trips to the current source is worth keeping.
      writeFileSync(resolve(ROOT, target), encoded);
      parts.push(`${encoding} ${kib(encoded.length)} (${Math.round((encoded.length / source.length) * 100)}%)`);
    }
    console.log(parts.join('  |  '));
  }
  const total = committed.reduce((sum, file) => sum + statSync(resolve(ROOT, file)).size, 0);
  console.log(`\n${committed.length} files, ${kib(total)} raw. Commit the .br and .gz siblings with the source.`);
  console.log(built.length
    ? `${built.length} built file(s) under ${BUILT_DIR} compressed in place. Do NOT commit those siblings: `
      + 'they are the image\'s, produced next to the bundle they describe.'
    : `No bundle under ${BUILT_DIR}; nothing built to compress. \`npm run build:web\` first if that is unexpected.`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
