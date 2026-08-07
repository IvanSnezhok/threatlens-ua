import type { TestProject } from 'vitest/node';
import { dockerAvailable, startContainer, stopContainer } from './postgres-container.js';

/**
 * Boots the database the integration project runs against.
 *
 * If neither `TEST_DATABASE_URL` nor Docker is available the suite is skipped *loudly*: the reason
 * is printed and `integrationDatabaseUrl` is provided as `null` so every integration file reports
 * as skipped instead of silently passing. Setting `REQUIRE_INTEGRATION_DB=1` (CI does) turns the
 * skip into a hard failure, so a broken CI database can never be mistaken for a green run.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const required = process.env.REQUIRE_INTEGRATION_DB === '1';

  if (!process.env.TEST_DATABASE_URL && !(await dockerAvailable())) {
    const reason = 'Docker is not available and TEST_DATABASE_URL is unset — PostgreSQL integration tests are SKIPPED.';
    if (required) throw new Error(`REQUIRE_INTEGRATION_DB=1 but ${reason}`);
    console.warn(`\n[integration] ${reason}\n[integration] Start Docker or export TEST_DATABASE_URL to run them.\n`);
    project.provide('integrationDatabaseUrl', null);
    return async () => undefined;
  }

  let started;
  try {
    started = await startContainer();
  } catch (error) {
    const reason = `PostgreSQL could not be started: ${error instanceof Error ? error.message : String(error)}`;
    if (required) throw new Error(`REQUIRE_INTEGRATION_DB=1 but ${reason}`, { cause: error });
    console.warn(`\n[integration] ${reason} — PostgreSQL integration tests are SKIPPED.\n`);
    project.provide('integrationDatabaseUrl', null);
    return async () => undefined;
  }

  project.provide('integrationDatabaseUrl', started.databaseUrl);
  return async () => {
    if (started.mode === 'container') await stopContainer();
  };
}
