import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          environment: 'node'
        }
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['./tests/helpers/global-setup.ts'],
          setupFiles: ['./tests/helpers/setup-env.ts'],
          // Every integration file shares one PostgreSQL database and truncates it between tests,
          // so files must never overlap. `fileParallelism` is a root-only option and would also
          // serialise the unit project; pinning this project to one fork serialises exactly the
          // files that need it.
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          maxConcurrency: 1,
          sequence: { concurrent: false },
          testTimeout: 30_000,
          hookTimeout: 120_000
        }
      }
    ]
  }
});
