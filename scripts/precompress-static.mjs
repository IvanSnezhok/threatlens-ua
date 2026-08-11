#!/usr/bin/env node
/**
 * Writes the `.br` and `.gz` siblings that Caddy serves for `public/data/*.geojson`.
 *
 * Why the bytes are committed rather than produced at build time
 * -------------------------------------------------------------
 * Caddy serves these three files itself, from a read-only bind mount of the checkout (`Caddyfile`,
 * `compose.yaml`) — not from the application image. So a sibling that exists only inside a Docker
 * build is a sibling Caddy never sees. The checkout is the delivery path, therefore the checkout is
 * where the compressed forms have to live.
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
 * this script, and the unit suite fails naming the command.
 *
 * Usage: `npm run build:static`
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * Only `public/data`. `public/assets` is off limits by construction: `app.js` and `app.css` are
 * esbuild output, they are in `.gitignore`, and they are built inside the image — a sibling for them
 * would go stale on the very next `npm run build:web` with nothing to catch it.
 */
export const PRECOMPRESSED_DIR = 'public/data';
export const PRECOMPRESSED_EXTENSION = '.geojson';
/** In the order Caddy's `precompressed br gzip` prefers them. */
export const PRECOMPRESSED_ENCODINGS = ['br', 'gz'];

/** Every source file that must have a sibling, repo-relative and sorted. */
export function precompressibleFiles() {
  return readdirSync(resolve(ROOT, PRECOMPRESSED_DIR))
    .filter((name) => name.endsWith(PRECOMPRESSED_EXTENSION))
    .sort()
    .map((name) => `${PRECOMPRESSED_DIR}/${name}`);
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
  const files = precompressibleFiles();
  if (files.length === 0) {
    console.error(`no ${PRECOMPRESSED_EXTENSION} files under ${PRECOMPRESSED_DIR}`);
    process.exitCode = 1;
    return;
  }
  for (const file of files) {
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
  const total = files.reduce((sum, file) => sum + statSync(resolve(ROOT, file)).size, 0);
  console.log(`\n${files.length} files, ${kib(total)} raw. Commit the .br and .gz siblings with the source.`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
