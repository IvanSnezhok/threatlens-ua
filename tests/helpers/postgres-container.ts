import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Ephemeral PostgreSQL used by the integration suite.
 *
 * Two modes:
 *  - `TEST_DATABASE_URL` is set (CI, GitHub Actions `services: postgres`): the harness connects to
 *    that server and never touches Docker.
 *  - otherwise: a throwaway `postgres:18-alpine` container is started on a dedicated port and
 *    removed again on teardown.
 *
 * The port and container name are deliberately not 5432/15433 — the repository runs other
 * PostgreSQL containers and this suite must never collide with them.
 */
export const CONTAINER_NAME = process.env.TEST_PG_CONTAINER ?? 'threatlens-integration-pg';
export const CONTAINER_PORT = Number(process.env.TEST_PG_PORT ?? 15437);
export const CONTAINER_IMAGE = process.env.TEST_PG_IMAGE ?? 'postgres:18-alpine';

const PG_USER = 'threatlens_test';
const PG_PASSWORD = 'threatlens_test';
const PG_DATABASE = 'threatlens_test';

export const CONTAINER_DATABASE_URL =
  `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${CONTAINER_PORT}/${PG_DATABASE}`;

export interface StartResult {
  databaseUrl: string;
  /** `external` means an already-running server was reused and must not be torn down. */
  mode: 'external' | 'container';
}

async function docker(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run('docker', args, { encoding: 'utf8' });
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await docker(['info', '--format', '{{.ServerVersion}}']);
    return true;
  } catch {
    return false;
  }
}

async function containerIsReady(): Promise<boolean> {
  try {
    await docker(['exec', CONTAINER_NAME, 'pg_isready', '-U', PG_USER, '-d', PG_DATABASE, '-q']);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await containerIsReady()) return;
    if (Date.now() > deadline) throw new Error(`${CONTAINER_NAME} did not become ready within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function stopContainer(): Promise<void> {
  await docker(['rm', '-f', '-v', CONTAINER_NAME]).catch(() => undefined);
}

export async function startContainer(): Promise<StartResult> {
  const external = process.env.TEST_DATABASE_URL;
  if (external) return { databaseUrl: external, mode: 'external' };

  await stopContainer();
  await docker([
    'run', '-d',
    '--name', CONTAINER_NAME,
    '-e', `POSTGRES_USER=${PG_USER}`,
    '-e', `POSTGRES_PASSWORD=${PG_PASSWORD}`,
    '-e', `POSTGRES_DB=${PG_DATABASE}`,
    '-p', `127.0.0.1:${CONTAINER_PORT}:5432`,
    // Durability is worthless for a container that is deleted at the end of the run, and turning it
    // off keeps the seven migrations plus per-test truncation fast.
    CONTAINER_IMAGE,
    '-c', 'fsync=off',
    '-c', 'full_page_writes=off',
    '-c', 'synchronous_commit=off'
  ]);
  await waitUntilReady(60_000);
  return { databaseUrl: CONTAINER_DATABASE_URL, mode: 'container' };
}
