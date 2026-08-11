/**
 * Repeatable resource benchmark for the public read path.
 *
 * Why this exists
 * ---------------
 * `Dockerfile` caps the V8 old space and `compose.yaml` caps the container, and the two numbers are
 * a pair: the heap must hit its own limit first (V8 collects hard and survives) so that the cgroup
 * limit stays the last resort (an OOM-kill with no chance to collect). `src/deployer/
 * compose-contract.test.ts` proves the two numbers are consistent with each other and with the SSE
 * worst case. What a static test cannot prove is the part that decides whether the pair is set high
 * ENOUGH: what the process actually holds while a crowd is reading it.
 *
 * So this runs the real server, in its own process, under the exact `--max-old-space-size` the
 * Dockerfile declares, and reports what it costs. It is the measurement CLAUDE.md asks for before a
 * resource limit is changed, and it is a script rather than a test because it needs a database
 * seeded to a shape a truncating harness must never leave behind.
 *
 * What it measures, and what it does not
 * -------------------------------------
 * It measures the API read path: the location catalogue, the snapshot memo, and open SSE streams —
 * the three things that hold bytes proportional to how many people are reading. It does NOT start
 * the ingestion workers, the bot or the schedulers, so the numbers are a FLOOR for the deployment,
 * not a ceiling. Read them as "the read path alone costs at least this much".
 *
 * Load is spread across synthetic client addresses through `X-Forwarded-For`, which the server
 * already trusts (`trustProxy: true`) because Caddy sits in front of it. That is not a way around
 * the rate limiter — it is what a crowd of real readers looks like, and hammering one address would
 * measure the limiter instead of the read path.
 *
 * Usage
 * -----
 *   docker run -d --name tl-bench-pg -e POSTGRES_USER=bench -e POSTGRES_PASSWORD=bench \
 *     -e POSTGRES_DB=bench -p 15439:5432 postgres:18-alpine
 *   export DATABASE_URL=postgresql://bench:bench@127.0.0.1:15439/bench
 *   npx tsx src/db/migrate.ts
 *   TL_BENCH_SCRATCH_DB=1 npx tsx scripts/memory-benchmark.ts [--streams 500] [--locations 31000]
 *
 * `TL_BENCH_SCRATCH_DB=1` is required and the database must be on the loopback: this script WRITES
 * (it seeds a catalogue of the size a KATOTTG import produces), so it must never be pointed at
 * anything whose contents matter.
 */
import { execFileSync } from 'node:child_process';
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);

// ------------------------------------------------------------------------------------------------
// The server side of the fork
// ------------------------------------------------------------------------------------------------

async function serve(): Promise<void> {
  const { buildServer } = await import('../src/api/server.js');
  const app = await buildServer();
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  // Sampled from INSIDE the process, because `ps` reports RSS and RSS cannot tell a heap that is
  // holding bytes from one that has simply not been asked to give them back yet.
  setInterval(() => {
    const usage = process.memoryUsage();
    process.send?.({ kind: 'usage', heapUsed: usage.heapUsed, external: usage.external, rss: usage.rss });
  }, 200).unref();
  process.send?.({ kind: 'ready', url });
  process.on('message', (message: { kind?: string }) => {
    if (message?.kind === 'stop') void app.close().then(() => process.exit(0));
  });
}

// ------------------------------------------------------------------------------------------------
// Sampling
// ------------------------------------------------------------------------------------------------

interface Sample { rss: number; heapUsed: number; external: number }

const MIB = 1024 * 1024;
const mib = (bytes: number) => (bytes / MIB).toFixed(1).padStart(7);

class Peaks {
  private peak: Sample = { rss: 0, heapUsed: 0, external: 0 };
  observe(sample: Sample): void {
    this.peak = {
      rss: Math.max(this.peak.rss, sample.rss),
      heapUsed: Math.max(this.peak.heapUsed, sample.heapUsed),
      external: Math.max(this.peak.external, sample.external)
    };
  }
  read(): Sample { return { ...this.peak }; }
  reset(): void { this.peak = { rss: 0, heapUsed: 0, external: 0 }; }
}

// ------------------------------------------------------------------------------------------------
// Load
// ------------------------------------------------------------------------------------------------

/** One synthetic reader per request: the rate limiter keys on `request.ip`, and so does production. */
function clientAddress(index: number): string {
  return `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`;
}

const agent = new http.Agent({ keepAlive: false, maxSockets: Infinity });

function get(base: URL, path: string, reader: number): Promise<number> {
  return new Promise((done, fail) => {
    const request = http.get({
      agent, host: base.hostname, port: base.port, path,
      headers: { 'x-forwarded-for': clientAddress(reader), 'accept-encoding': 'identity' }
    }, (response) => {
      response.resume();
      response.on('end', () => done(response.statusCode ?? 0));
    });
    request.on('error', fail);
  });
}

interface StreamHandle { close: () => void }

function openStream(base: URL, reader: number): Promise<StreamHandle> {
  return new Promise((done, fail) => {
    const request = http.get({
      agent, host: base.hostname, port: base.port, path: '/api/v1/stream',
      headers: { 'x-forwarded-for': clientAddress(reader), accept: 'text/event-stream' }
    }, (response) => {
      // Never read the body. A consumer that does not drain is exactly the case
      // `SSE_MAX_BUFFERED_BYTES` exists for, and it is the worst case the ceiling is sized against.
      response.pause();
      done({ close: () => { request.destroy(); response.destroy(); } });
    });
    request.on('error', fail);
  });
}

async function wave(base: URL, path: string, readers: number, offset: number): Promise<Map<number, number>> {
  const statuses = await Promise.all(
    Array.from({ length: readers }, (_, index) => get(base, path, offset + index).catch(() => 0))
  );
  const tally = new Map<number, number>();
  for (const status of statuses) tally.set(status, (tally.get(status) ?? 0) + 1);
  return tally;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// ------------------------------------------------------------------------------------------------
// Seeding
// ------------------------------------------------------------------------------------------------

/**
 * A catalogue the size KATOTTG produces. The route serialises every row on a cache miss, so the
 * catalogue is the largest single body the process ever builds, and its size is the reason the old
 * per-request path was the memory bug fixed in commit 867ef6d.
 */
async function seedCatalogue(target: number): Promise<number> {
  const { pool } = await import('../src/db/pool.js');
  const existing = Number((await pool.query(`SELECT count(*)::text AS n FROM locations`)).rows[0].n);
  if (existing >= target) return existing;
  const parent = (await pool.query(`SELECT id FROM locations WHERE type='oblast' LIMIT 1`)).rows[0]?.id ?? null;
  await pool.query(
    `INSERT INTO locations(id,parent_id,type,name_uk,latitude,longitude)
     SELECT 'bench-' || g, $1, 'hromada', 'Бенчмаркова громада ' || g, 48.5 + g % 100 * 0.01, 31.5 + g % 100 * 0.01
     FROM generate_series(1, $2::int) g
     ON CONFLICT (id) DO NOTHING`,
    [parent, target - existing]
  );
  return Number((await pool.query(`SELECT count(*)::text AS n FROM locations`)).rows[0].n);
}

// ------------------------------------------------------------------------------------------------
// The driver
// ------------------------------------------------------------------------------------------------

function flag(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** The two numbers this benchmark exists to check, read from the files that declare them. */
function declaredLimits(): { heapMib: number; containerMib: number } {
  const heapMib = Number(/--max-old-space-size=(\d+)/.exec(readFileSync(resolve(ROOT, 'Dockerfile'), 'utf8'))?.[1]);
  const compose = readFileSync(resolve(ROOT, 'compose.yaml'), 'utf8');
  const app = compose.slice(compose.indexOf('\n  app:'));
  const limit = /memory:\s*(\d+)([gm])/.exec(app);
  return { heapMib, containerMib: Number(limit![1]) * (limit![2] === 'g' ? 1024 : 1) };
}

function openFileLimit(): number {
  try { return Number(execFileSync('sh', ['-c', 'ulimit -n'], { encoding: 'utf8' }).trim()); }
  catch { return Number.POSITIVE_INFINITY; }
}

async function drive(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  if (process.env.TL_BENCH_SCRATCH_DB !== '1') {
    throw new Error('refusing to run without TL_BENCH_SCRATCH_DB=1 — this script WRITES to DATABASE_URL');
  }
  if (!/@(127\.0\.0\.1|localhost|\[::1\]):/.test(databaseUrl)) {
    throw new Error(`refusing to seed a non-loopback database: ${databaseUrl.replace(/:[^:@]*@/, ':***@')}`);
  }
  if (process.env.NODE_ENV === 'production') throw new Error('refusing to run with NODE_ENV=production');

  const declared = declaredLimits();
  // `--heap` overrides the Dockerfile's cap so a proposed ceiling can be measured BEFORE it is
  // written down. Without it this benchmark can only ever confirm the number already in the tree.
  const heapMib = flag('heap', declared.heapMib);
  const containerMib = declared.containerMib;
  const wanted = flag('streams', 500);
  const files = openFileLimit();
  // Every stream is a socket in THIS process too. Asking for more than the descriptor table holds
  // measures the benchmark's own failure, not the server's.
  const streams = Math.min(wanted, Math.max(0, files - 200));
  const readers = flag('readers', 300);
  const catalogue = flag('locations', 31000);

  console.log(`declared: --max-old-space-size=${declared.heapMib} MiB inside a ${containerMib} MiB container`
    + (heapMib === declared.heapMib ? '' : `  (running under --heap ${heapMib})`));
  const rows = await seedCatalogue(catalogue);
  console.log(`catalogue: ${rows} locations`);
  if (streams < wanted) console.log(`streams: ${streams} of ${wanted} requested (ulimit -n is ${files})`);
  await (await import('../src/db/pool.js')).pool.end();

  const child = fork(SELF, ['--role', 'server'], {
    execArgv: ['--import', 'tsx', `--max-old-space-size=${heapMib}`],
    env: { ...process.env, TL_BENCH_ROLE: 'server' },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc']
  });

  const peaks = new Peaks();
  let last: Sample = { rss: 0, heapUsed: 0, external: 0 };
  const base = await new Promise<URL>((done, fail) => {
    child.on('message', (message: any) => {
      if (message.kind === 'ready') done(new URL(message.url));
      if (message.kind === 'usage') { last = message; peaks.observe(message); }
    });
    child.on('exit', (code) => fail(new Error(`server exited before it was ready (code ${code})`)));
  });

  const phases: Array<[string, Sample]> = [];
  const record = async (name: string, body: () => Promise<void>) => {
    peaks.reset();
    await body();
    await sleep(1500);           // let the sampler see the tail of the phase
    phases.push([name, peaks.read()]);
    console.log(`  ${name.padEnd(28)} rss ${mib(peaks.read().rss)} MiB  heap ${mib(peaks.read().heapUsed)} MiB  external ${mib(peaks.read().external)} MiB`);
  };

  console.log('\nphases (peaks over the phase, sampled inside the server process):');
  let reader = 0;
  const held: StreamHandle[] = [];
  try {
    await record('rest', async () => { await sleep(3000); });

    await record(`catalogue ×${readers} ×3`, async () => {
      for (let round = 0; round < 3; round += 1) {
        const tally = await wave(base, '/api/v1/locations', readers, reader);
        reader += readers;
        if (!tally.has(200)) throw new Error(`catalogue wave answered ${[...tally.keys()].join(',')}`);
      }
    });

    await record(`snapshot ×${readers} ×3`, async () => {
      for (let round = 0; round < 3; round += 1) {
        const tally = await wave(base, '/api/v1/snapshot', readers, reader);
        reader += readers;
        if (!tally.has(200)) throw new Error(`snapshot wave answered ${[...tally.keys()].join(',')}`);
      }
    });

    await record(`${streams} idle SSE streams`, async () => {
      for (let index = 0; index < streams; index += 1) {
        held.push(await openStream(base, reader + index));
        if (index % 50 === 49) await sleep(50);
      }
      reader += streams;
      await sleep(5000);
    });

    await record(`snapshot ×${readers} with streams`, async () => {
      const tally = await wave(base, '/api/v1/snapshot', readers, reader);
      reader += readers;
      if (!tally.has(200)) throw new Error(`snapshot wave answered ${[...tally.keys()].join(',')}`);
    });
  } finally {
    for (const stream of held) stream.close();
    child.send({ kind: 'stop' });
    await sleep(500);
    child.kill('SIGKILL');
  }

  const worst = phases.reduce((a, b) => (b[1].rss > a[1].rss ? b : a));
  const headroom = containerMib - worst[1].rss / MIB;
  console.log(`\nworst phase: ${worst[0]}`);
  console.log(`  peak rss      ${mib(worst[1].rss)} MiB`);
  console.log(`  peak heap     ${mib(worst[1].heapUsed)} MiB  of ${heapMib} MiB old-space cap`);
  console.log(`  container     ${String(containerMib).padStart(7)} MiB limit → ${headroom.toFixed(1)} MiB unused`);
  console.log(`  final sample  rss ${mib(last.rss)} MiB`);
  if (worst[1].rss / MIB > containerMib) {
    console.log('\nVERDICT: the read path alone exceeds the container limit.');
    process.exitCode = 1;
  } else if (headroom < containerMib * 0.25) {
    console.log('\nVERDICT: under 25% of the container limit is left for everything this script does not start.');
    process.exitCode = 1;
  } else {
    console.log('\nVERDICT: the read path fits, with the margin above left for the workers, the bot and the schedulers.');
  }
}

if (process.env.TL_BENCH_ROLE === 'server') await serve();
else await drive();
