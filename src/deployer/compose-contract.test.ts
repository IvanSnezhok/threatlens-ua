import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEPLOY_MANUAL_SERVICES, DEPLOY_REF, DEPLOY_RESTART_SERVICES } from './runner.js';

/**
 * Structural proof of the deployment threat model, in the files that actually decide it.
 *
 * `src/deployer/runner.test.ts` proves what the runner does. None of that matters if the topology is
 * wrong: an `app` container with the Docker socket mounted is unauthenticated host root behind a
 * public HTTP surface, and no amount of correct argv makes up for it. So the claims of
 * `docs/OPERATIONS.md` — the socket is not in `app`, the runner publishes no host port, Caddy proxies
 * exactly one upstream — are asserted here against the shipped `compose.yaml` and `Caddyfile`.
 *
 * Deliberately a text analysis and not a YAML parse: this project has no YAML dependency, and adding
 * one so that a test can read four files would be a worse trade than a twenty-line block splitter.
 */

const ROOT = resolve(import.meta.dirname, '../..');

function read(relative: string): string {
  return readFileSync(resolve(ROOT, relative), 'utf8');
}

/**
 * Whether a path reaches the deployment checkout — which is the only question that matters for
 * anything Caddy now reads from disk. `git ls-files` would answer it for a file that is already
 * committed and answer it wrongly for one staged in the same change as the config that serves it,
 * so the test is "on disk and not ignored" instead. `git check-ignore` exits 0 when it IS ignored.
 */
function shipsInCheckout(relative: string): boolean {
  if (!existsSync(resolve(ROOT, relative))) return false;
  try {
    execFileSync('git', ['check-ignore', '-q', '--', relative], { cwd: ROOT, stdio: 'ignore' });
    return false;
  } catch {
    return true;
  }
}

const COMPOSE = read('compose.yaml');

/** Every top-level `services:` entry, mapped to its own block of the file. */
function serviceBlocks(): Map<string, string> {
  const lines = COMPOSE.split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === 'services:');
  expect(start, 'compose.yaml has no services: block').toBeGreaterThan(-1);
  const blocks = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([a-z0-9_-]+):\s*$/.exec(line);
    // A key at column 0 ends the services block (`volumes:` at the bottom of the file).
    const topLevel = /^[a-z]/.test(line);
    if (header || topLevel) {
      if (current) blocks.set(current, buffer.join('\n'));
      current = header?.[1] ?? null;
      buffer = [];
      if (topLevel && !header) break;
      continue;
    }
    if (current) buffer.push(line);
  }
  if (current) blocks.set(current, buffer.join('\n'));
  return blocks;
}

const SERVICES = serviceBlocks();

describe('compose topology', () => {
  it('defines the five services the runbook names', () => {
    expect([...SERVICES.keys()].sort()).toEqual(['app', 'backup', 'caddy', 'deployer', 'postgres']);
  });

  it('pins the project name so the runner addresses the running stack', () => {
    // `docker compose -p threatlens` from inside the runner has to name the SAME project the host
    // started. An inferred name would build a second stack beside the live one and the update would
    // appear to do nothing at all.
    expect(COMPOSE).toMatch(/^name:\s*threatlens\s*$/m);
  });

  it('never gives the Docker socket to anything but the runner', () => {
    // The single most important line in this file. `app` terminates public HTTP, SSE, ~54 MTProto
    // channels, a Telegram bot and model output; the socket is unauthenticated root on the host.
    for (const [name, block] of SERVICES) {
      if (name === 'deployer') continue;
      expect(block, `service ${name} mounts the Docker socket`).not.toContain('docker.sock');
    }
    expect(SERVICES.get('deployer')).toContain('/var/run/docker.sock:/var/run/docker.sock');
  });

  it('never gives anything privileged mode or a socket-adjacent capability', () => {
    for (const [name, block] of SERVICES) {
      expect(block, `service ${name} is privileged`).not.toMatch(/privileged:\s*true/);
      expect(block, `service ${name} adds capabilities`).not.toMatch(/cap_add:/);
      expect(block, `service ${name} shares the host PID namespace`).not.toMatch(/pid:\s*["']?host/);
    }
  });

  it('publishes no host port for the runner', () => {
    const deployer = SERVICES.get('deployer')!;
    // `expose`, never `ports`. Reachable on the compose network and from nowhere else, which is what
    // makes the bearer token a second lock rather than the only one.
    expect(deployer).toMatch(/^\s+expose:/m);
    expect(deployer).not.toMatch(/^\s+ports:/m);
  });

  it('keeps the application secrets out of the runner', () => {
    const deployer = SERVICES.get('deployer')!;
    // `.env` holds the bot token, the MTProto session and the ops password. A process that holds the
    // Docker socket has no use for any of them, and `env_file` would hand it all three.
    expect(deployer).not.toContain('env_file');
    for (const secret of ['TELEGRAM_SESSION', 'TELEGRAM_BOT_TOKEN', 'OPS_PASSWORD', 'CODEX_API_KEY']) {
      expect(deployer, `the runner is handed ${secret}`).not.toContain(secret);
    }
  });

  it('parameterises the app image with the commit it was built from', () => {
    expect(SERVICES.get('app')).toMatch(/APP_COMMIT:\s*"\$\{APP_COMMIT:-unknown\}"/);
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toMatch(/^ARG APP_COMMIT=unknown$/m);
    expect(dockerfile).toMatch(/^ENV APP_COMMIT=\$\{APP_COMMIT\}$/m);
    // After every COPY: an ARG invalidates the cache from where it appears, and these two change on
    // every commit. Declared at the top of the stage they would rebuild `npm ci` for each deploy.
    expect(dockerfile.indexOf('ARG APP_COMMIT')).toBeGreaterThan(dockerfile.lastIndexOf('COPY '));
  });

  it('builds the runner from its own Dockerfile and runs only its own output', () => {
    expect(SERVICES.get('deployer')).toContain('dockerfile: deploy/Dockerfile');
    const dockerfile = read('deploy/Dockerfile');
    expect(dockerfile).toContain('CMD ["node", "dist/deployer/index.js"]');
    // Only `dist/deployer` is copied into the runtime stage: the application's compiled output never
    // ships in the container that holds the socket.
    expect(dockerfile).toContain('COPY --from=build /app/dist/deployer ./dist/deployer');
    expect(dockerfile).not.toMatch(/COPY --from=build \/app\/dist \./);
  });
});

describe('the public edge', () => {
  const CADDYFILE = read('Caddyfile');
  /** Directives only. The comments in that file discuss the policies they explain, by name. */
  const DIRECTIVES = CADDYFILE.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
  /** Caddy's `precompressed` takes encoding names; these are the siblings it then looks for. */
  const SIBLING_EXTENSION: Record<string, string> = { br: 'br', gzip: 'gz', zstd: 'zst' };

  it('proxies exactly one upstream, and it is the application', () => {
    const proxies = [...CADDYFILE.matchAll(/reverse_proxy\s+(\S+)/g)].map((match) => match[1]);
    // The runner is on the same bridge network as Caddy. ONE upstream is what keeps it unreachable
    // from the internet no matter what an attacker knows about the topology. A set, not a list:
    // `reverse_proxy app:3000` is now written twice — once as the fail-safe for a static path Caddy
    // cannot find on disk, once for everything else — and both name the same single upstream.
    expect(new Set(proxies)).toEqual(new Set(['app:3000']));
    expect(CADDYFILE).not.toContain('deployer');
  });

  it('serves from disk only the asset trees that are checked into git', () => {
    // The premise of the whole edge-static block. Caddy reads the deployment CHECKOUT; `app` reads
    // the IMAGE. The two agree only for files git versions, so a path served from disk that is not
    // tracked would be served stale, or 404, depending on the day.
    const served = [...CADDYFILE.matchAll(/@static path (.+)/g)].flatMap((match) => match[1]!.trim().split(/\s+/));
    expect(served).toEqual(['/data/*', '/assets/fonts/*']);
    for (const prefix of ['public/data', 'public/assets/fonts']) {
      const tracked = execFileSync('git', ['ls-files', prefix], { cwd: ROOT, encoding: 'utf8' }).trim();
      expect(tracked, `${prefix} is served from disk but nothing in it is tracked`).not.toBe('');
    }
    // esbuild output, `.gitignore`d, present only inside the image: it must keep going through the
    // proxy or a fresh checkout would serve a bundle that does not exist.
    expect(CADDYFILE).not.toContain('/assets/app.');
  });

  it('mounts those trees into Caddy read-only, at the root the Caddyfile expects', () => {
    const caddy = SERVICES.get('caddy')!;
    const root = /root \* (\S+)/.exec(CADDYFILE)?.[1];
    expect(root).toBe('/srv/public');
    for (const tree of ['data', 'assets/fonts']) {
      expect(caddy, `public/${tree} is not mounted into Caddy`).toContain(`./public/${tree}:${root}/${tree}:ro`);
    }
    // `:ro` is the point. Caddy terminates the public internet; the checkout it reads is the same
    // one the deployment runner does `git fetch` into.
    for (const mount of caddy.matchAll(/^\s+- \.\/public\/\S+$/gm)) {
      expect(mount[0], 'a public mount is writable').toMatch(/:ro$/);
    }
  });

  it('never lets an unhashed asset claim immutability', () => {
    // None of these filenames carry a content hash, so every cache policy here has to have an end.
    // `immutable` on `/data/*` would mean a corrected boundary never reaching a browser that has the
    // old one — and `max-age=0` from `@fastify/static` is what keeps `index.html` and the bundle
    // honest, which is exactly why they are not in the block above.
    expect(DIRECTIVES).not.toContain('immutable');
    const policies = [...DIRECTIVES.matchAll(/Cache-Control "([^"]+)"/g)].map((match) => match[1]!);
    expect(policies.length).toBeGreaterThan(0);
    for (const policy of policies) {
      const maxAge = /max-age=(\d+)/.exec(policy)?.[1];
      expect(maxAge, `no max-age in "${policy}"`).toBeDefined();
      // A month. Long enough to be worth doing, short enough that a wrong asset self-corrects
      // without anyone having to think about cache busting.
      expect(Number(maxAge), `"${policy}" outlives a deployment cycle`).toBeLessThanOrEqual(2_592_000);
    }
  });

  it('asks for precompressed siblings that the repository actually carries', () => {
    const encodings = /precompressed ([a-z ]+)/.exec(DIRECTIVES)?.[1]!.trim().split(/\s+/);
    expect(encodings).toEqual(['br', 'gzip']);
    // Caddy has no Brotli compressor; `encode zstd gzip` is what it can produce on the fly, and the
    // `.br` files are what it can only serve. Both halves have to stay declared.
    expect(DIRECTIVES).toMatch(/^\s+encode zstd gzip$/m);
    for (const encoding of encodings!) {
      const extension = SIBLING_EXTENSION[encoding];
      expect(extension, `\`precompressed ${encoding}\` names an encoding Caddy has no extension for`).toBeDefined();
      for (const file of readdirSync(resolve(ROOT, 'public/data')).filter((name) => name.endsWith('.geojson'))) {
        expect(
          shipsInCheckout(`public/data/${file}.${extension}`),
          `public/data/${file}.${extension} does not reach the checkout — run \`npm run build:static\``
        ).toBe(true);
      }
    }
  });
});

describe('the memory ceiling', () => {
  it('keeps the V8 heap cap below the cgroup limit, with room for external memory', () => {
    // The pairing this project has been bitten by: a process that hits its cgroup limit is OOM-killed
    // with no chance to collect, while a heap that hits its OWN limit collects hard and survives. So
    // the heap cap must stay strictly under the container limit, and the gap must cover the memory
    // V8 does not count — socket buffers above all.
    const heapMib = Number(/--max-old-space-size=(\d+)/.exec(read('Dockerfile'))?.[1]);
    expect(heapMib).toBeGreaterThan(0);
    const limit = /memory:\s*(\d+)([gm])/.exec(SERVICES.get('app')!);
    const limitMib = Number(limit![1]) * (limit![2] === 'g' ? 1024 : 1);
    expect(heapMib).toBeLessThan(limitMib);

    // The largest BOUNDED consumer of external memory is the slow-SSE-consumer worst case, and it is
    // bounded by two constants. Read them rather than restate them: raising either one without
    // raising this ceiling is the change that would make the container OOM under a crowd. Searched
    // across `src/api` rather than pinned to one file, because which module owns the stream
    // transport is not the thing this test is about.
    const api = readdirSync(resolve(ROOT, 'src/api'))
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => read(`src/api/${file}`)).join('\n');
    const streams = Number(/SSE_MAX_STREAMS = (\d+)/.exec(api)?.[1]);
    const buffered = Number(/SSE_MAX_BUFFERED_BYTES = (\d+) \* 1024/.exec(api)?.[1]);
    expect(streams, 'SSE_MAX_STREAMS is not declared anywhere in src/api — the SSE worst case is now unbounded, or this test lost track of it').toBeGreaterThan(0);
    expect(buffered, 'SSE_MAX_BUFFERED_BYTES is not declared anywhere in src/api — see above').toBeGreaterThan(0);
    const sseMib = (streams * buffered) / 1024;
    expect(limitMib - heapMib, `${limitMib - heapMib} MiB of headroom against ${sseMib} MiB of SSE buffers`)
      .toBeGreaterThan(sseMib);
  });
});

describe('runner isolation', () => {
  it('imports nothing outside node:*, pg, zod and its own directory', () => {
    // `eslint.config.js` enforces this as a lint rule; this is the same claim as a test, so it also
    // holds for anyone running the suite without the linter.
    const directory = resolve(ROOT, 'src/deployer');
    const offenders: string[] = [];
    for (const file of readdirSync(directory)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      // Comments are stripped first. English prose in this package uses the word "from" in front of
      // quoted phrases often enough that scanning the raw text reports sentences as imports.
      const source = readFileSync(resolve(directory, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
      for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const specifier = match[1]!;
        const allowed = specifier.startsWith('node:')
          || specifier === 'pg' || specifier === 'zod'
          || /^\.\/[^/]+$/.test(specifier);
        if (!allowed) offenders.push(`${file}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('names one ref and two restartable services, as constants', () => {
    expect(DEPLOY_REF).toBe('refs/heads/main');
    expect(DEPLOY_RESTART_SERVICES).toEqual(['app', 'caddy']);
    expect(DEPLOY_MANUAL_SERVICES).toEqual(['postgres', 'backup', 'deployer']);
    // The three excluded services must be real services, or the drift probe reports on nothing.
    for (const service of DEPLOY_MANUAL_SERVICES) expect([...SERVICES.keys()]).toContain(service);
    for (const service of DEPLOY_RESTART_SERVICES) expect([...SERVICES.keys()]).toContain(service);
  });

  it('keeps every reference to the deployed ref in one place', () => {
    // A second literal `refs/heads/main` in the runner would be a second place to change the
    // boundary. The database CHECK in migration 023 is the deliberate exception: it is the lock that
    // holds when the code is wrong.
    const runner = read('src/deployer/runner.ts');
    const occurrences = runner.match(/refs\/heads\/main/g) ?? [];
    // Once in DEPLOY_REF, once inside the fetch refspec constant, and once in its comment.
    expect(occurrences.length).toBeLessThanOrEqual(4);
    const migration = read('migrations/023_deployment_and_backfill.sql');
    expect(migration).toContain(`CHECK (remote_ref = 'refs/heads/main')`);
  });
});
