import { isAbsolute } from 'node:path';
import { z } from 'zod';

/**
 * The deployment runner's own configuration, deliberately NOT part of `src/config.ts`.
 *
 * Two separate reasons, and either one on its own would be enough:
 *
 *   1. **Different process, different secrets.** `src/config.ts` is parsed by `app`, which is fed
 *      the whole `.env` — bot token, MTProto session, ops password. The runner is fed six named
 *      variables (`compose.yaml`) and must never learn to expect more. A shared schema is a standing
 *      invitation to read one of the app's secrets from here "just this once".
 *   2. **Different failure semantics.** `app` must start with almost anything so that a
 *      misconfiguration is visible on a page rather than as a container that never listens. The
 *      runner is the opposite: a runner without a real token, or pointed at a path that is not an
 *      absolute repository root, must not start at all. Everything it does is irreversible.
 *
 * Note what is NOT here. **The branch and the restarted service list are not variables.**
 * `refs/heads/main` and `['app','caddy']` are frozen constants in `./runner.ts`. The issue puts
 * "оновлення з довільної гілки, tag або fork" out of scope, and the way a scope boundary survives is
 * by not existing as a setting somebody can set.
 */
const deployerEnvSchema = z.object({
  /**
   * The checkout the scenario operates on, as an ABSOLUTE path that is identical inside this
   * container and on the host.
   *
   * `docker compose` runs in here; the daemon that executes the resulting mounts runs out there. A
   * relative bind mount in `compose.yaml` is resolved daemon-side against `--project-directory`,
   * which is a host path — so if the checkout were mounted at, say, `/repo` inside, every relative
   * mount in the file would resolve against `/repo` on the host and point at nothing.
   */
  DEPLOY_REPO_PATH: z.string().min(1).refine((value) => isAbsolute(value), {
    message: 'DEPLOY_REPO_PATH must be an absolute path, identical inside the container and on the host'
  }),
  /**
   * The one remote the scenario will deploy from, compared byte for byte against what
   * `git remote get-url origin` prints. A checkout whose origin has been repointed refuses with
   * `remote_mismatch` rather than shipping somebody else's main.
   */
  DEPLOY_REPO_URL: z.string().url().refine((value) => value.startsWith('https://'), {
    message: 'DEPLOY_REPO_URL must be an https:// URL; SSH and private forks are a separate key-management decision'
  }),
  /**
   * Shared bearer between `app` and this process, compared with `timingSafeEqual`.
   *
   * Thirty-two characters is not a guess: this token is the only thing between anyone who can reach
   * the compose network and a process holding the host's Docker socket. Refusing to start is the
   * correct response to a weak one — the alternative is a runner that looks configured.
   */
  DEPLOY_RUNNER_TOKEN: z.string().min(32,
    'DEPLOY_RUNNER_TOKEN must be at least 32 characters: it guards a process that holds the Docker socket'),
  /** Where the journal is written. The scenario never restarts this database — see `./runner.ts`. */
  DEPLOY_DATABASE_URL: z.string().min(1),
  /** Must match `name:` in compose.yaml, or the scenario would build a second stack beside the live one. */
  DEPLOY_COMPOSE_PROJECT: z.string().min(1).default('threatlens'),
  DEPLOY_PORT: z.coerce.number().int().min(1).max(65_535).default(9000),
  DEPLOY_LIVE_URL: z.string().url().default('http://app:3000/health/live'),
  DEPLOY_READY_URL: z.string().url().default('http://app:3000/health/ready'),
  /**
   * How long the new container has to answer `/health/ready` with the deployed commit.
   *
   * The bound is what makes a failure a failure. Without it a crash-looping container would leave a
   * run in `waiting_ready` forever, which reads as "still working" on the ops card — the single most
   * misleading state this feature could produce.
   */
  DEPLOY_READY_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(3600).default(300),
  DEPLOY_READY_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(60).default(5),
  /** A cold `npm ci` plus a web bundle on a small VPS is minutes, not seconds. */
  DEPLOY_BUILD_TIMEOUT_SECONDS: z.coerce.number().int().min(60).max(7200).default(1800),
  DEPLOY_MIGRATE_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
  DEPLOY_START_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  /**
   * Floor between two accepted triggers. A rejected trigger writes NO run row (429), so a double
   * click cannot fill the journal with attempts that never touched anything.
   */
  DEPLOY_MIN_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(60),
  /**
   * How often the runner refreshes `deployment_state` from `git ls-remote` on its own.
   *
   * `ls-remote` touches nothing in the working tree and costs one HTTPS request, which is what makes
   * a background cadence acceptable at all. 0 disables it: the card then shows only what the last
   * explicit «Перевірити» found, which is a legitimate choice for a host on a metered link.
   */
  DEPLOY_CHECK_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(86_400).default(900),
  /** Ceiling on the captured output kept per run. 8 KiB is a screenful of the end of a build log. */
  DEPLOY_LOG_TAIL_BYTES: z.coerce.number().int().min(512).max(1_048_576).default(8192)
});

export type DeployerConfig = z.infer<typeof deployerEnvSchema>;

/**
 * Parses an explicit environment. Exported separately from {@link loadDeployerConfig} so the tests —
 * and anything that ever wants two configurations in one process — never have to mutate
 * `process.env`.
 */
export function parseDeployerConfig(env: NodeJS.ProcessEnv): DeployerConfig {
  return deployerEnvSchema.parse(env);
}

/**
 * Reads `process.env`, throwing a zod error that names the offending variable.
 *
 * Called from `./index.ts` at boot and from nowhere else. Deliberately a FUNCTION rather than a
 * parsed module constant: importing `./runner.ts` in a unit test must not require a valid runner
 * environment, and a module-level `parse(process.env)` would make it.
 */
export function loadDeployerConfig(): DeployerConfig {
  return parseDeployerConfig(process.env);
}
