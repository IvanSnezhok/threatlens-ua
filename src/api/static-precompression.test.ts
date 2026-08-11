import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain build script, deliberately not part of the TypeScript program.
import { PRECOMPRESSED_ENCODINGS, compress, precompressibleFiles } from '../../scripts/precompress-static.mjs';

/**
 * The guard that makes committed pre-encoded assets safe to have.
 *
 * `Caddyfile` serves `public/data/*.geojson` through `file_server { precompressed br gzip }`, which
 * means a Brotli-capable browser — nearly all of them — receives the contents of the `.br` sibling
 * and never looks at the `.geojson` next to it. A sibling that has fallen behind its source is
 * therefore not a stale cache that expires; it is the site quietly serving last year's raion
 * boundaries to every visitor, indefinitely, while the file an operator inspects on disk looks
 * right.
 *
 * Nothing in editing a `.geojson` forces anyone to remember `npm run build:static`. This does.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const REGENERATE = 'npm run build:static';

const FILES: string[] = precompressibleFiles();

function inflate(encoding: string, bytes: Buffer): Buffer {
  return encoding === 'br' ? brotliDecompressSync(bytes) : gunzipSync(bytes);
}

describe('precompressed static assets', () => {
  it('covers the GeoJSON layers the map downloads', () => {
    // Not a hardcoded list for its own sake: if a fourth layer is added and this test still names
    // three, the new one ships without siblings and silently loses the optimisation.
    expect(FILES).toEqual([
      'public/data/ukraine-adm0.geojson',
      'public/data/ukraine-adm1.geojson',
      'public/data/ukraine-adm2.geojson'
    ]);
  });

  it.each(FILES.flatMap((file) => PRECOMPRESSED_ENCODINGS.map((encoding: string) => [file, encoding] as const)))(
    '%s.%s inflates back to its source, byte for byte',
    (file, encoding) => {
      const sibling = `${file}.${encoding}`;
      expect(existsSync(resolve(ROOT, sibling)), `${sibling} is missing — run \`${REGENERATE}\``).toBe(true);
      const source = readFileSync(resolve(ROOT, file));
      const inflated = inflate(encoding, readFileSync(resolve(ROOT, sibling)));
      // Length first: a byte-array diff over a megabyte of JSON is unreadable, and a stale sibling
      // almost always differs in length, so this is the message the next person actually gets.
      expect(inflated.length, `${sibling} is stale (${inflated.length} B vs ${source.length} B) — run \`${REGENERATE}\``)
        .toBe(source.length);
      expect(inflated.equals(source), `${sibling} does not match its source — run \`${REGENERATE}\``).toBe(true);
    }
  );

  it.each(FILES)('%s is smaller compressed than raw, in every encoding', (file) => {
    // A sibling bigger than its source is a sibling that costs bytes instead of saving them, which
    // is the reason `public/assets/fonts` is excluded: `.woff2` is already Brotli inside.
    const source = readFileSync(resolve(ROOT, file));
    for (const encoding of PRECOMPRESSED_ENCODINGS) {
      const sibling = readFileSync(resolve(ROOT, `${file}.${encoding}`));
      expect(sibling.length, `${file}.${encoding} is not smaller than its source`).toBeLessThan(source.length);
    }
    // Brotli is the entire reason the siblings are committed rather than left to `encode`: Caddy can
    // serve `.br` but has no Brotli compressor of its own. If it ever stopped beating gzip here,
    // the extra file in the repository would be paying for nothing.
    const brotli = readFileSync(resolve(ROOT, `${file}.br`)).length;
    const gzip = readFileSync(resolve(ROOT, `${file}.gz`)).length;
    expect(brotli).toBeLessThan(gzip);
  });

  it('is deterministic within one runtime', () => {
    // zlib may legitimately emit different DEFLATE bytes on macOS and Linux while both streams
    // inflate to the identical source. Freshness is proved above by round-tripping the committed
    // sibling; determinism means two runs in the SAME build environment agree byte for byte.
    const file = FILES[0]!;
    const source = readFileSync(resolve(ROOT, file));
    for (const encoding of PRECOMPRESSED_ENCODINGS) {
      const first = compress(encoding, source);
      const second = compress(encoding, source);
      expect(first.equals(second), `${encoding} output changed between runs`).toBe(true);
    }
  });
});
