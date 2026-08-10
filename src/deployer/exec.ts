import { spawn } from 'node:child_process';

/**
 * The only way this process is allowed to run anything.
 *
 * Everything about the shape here exists to make one property provable by a test rather than by
 * reading code: **no operator-supplied byte ever reaches a subprocess argument.**
 *
 *   * `command` is a UNION of two literals, not a string. There is no expression anywhere in this
 *     package that can produce a third value, so "the runner executed something unexpected" is a
 *     type error rather than an incident.
 *   * `args` is a readonly array of separate strings and `spawn` is called with `shell: false`, so
 *     there is no shell, no word splitting, no globbing and no metacharacter with any meaning. A
 *     semicolon inside an argument is a semicolon.
 *   * The one value that comes from outside — the operator's `expectedRemoteCommit` — is matched
 *     against `/^[0-9a-f]{40}$/` before anything happens and is used ONLY for a comparison. The SHA
 *     that does reach an argv array is the one `git rev-parse` printed.
 *
 * `src/deployer/runner.test.ts` asserts the exact argv sequence against {@link fakeExec}, and asserts
 * that two runs requested by two different operators produce byte-identical argv.
 */

/** The two binaries this package may execute. Widening this union is a deliberate, reviewable act. */
export type ExecCommand = 'git' | 'docker';

export interface ExecStep {
  command: ExecCommand;
  args: readonly string[];
  timeoutMs: number;
  /** Merged over `process.env` for the child only. Used for APP_COMMIT/APP_BUILT_AT at build time. */
  env?: Readonly<Record<string, string>>;
  cwd?: string;
}

export interface ExecResult {
  /** `null` when the process was killed or never started. Only `0` counts as success. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Exec = (step: ExecStep) => Promise<ExecResult>;

export interface SpawnExecOptions {
  /** Ceiling on the retained tail of each stream. Older output is dropped, not buffered. */
  logTailBytes: number;
}

/** What a redacted secret is replaced by. Fixed text so a diff of two log tails stays readable. */
export const REDACTED = '[redacted]';

/**
 * Removes every occurrence of each secret from `text`.
 *
 * Values shorter than eight characters are ignored: a two-character "secret" would redact half of
 * every log line and destroy the thing the tail exists for. Real secrets here are a 32-character
 * bearer token and a database password, and a deployment whose password is under eight characters
 * has a different problem.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** Keeps only the last `limit` characters ever pushed. A `docker compose build` log is unbounded. */
function tailBuffer(limit: number) {
  let value = '';
  return {
    push(chunk: string): void {
      value += chunk;
      if (value.length > limit) value = value.slice(value.length - limit);
    },
    read(): string {
      return value;
    }
  };
}

/**
 * The production {@link Exec}: `spawn` with no shell, a hard timeout and a bounded RAW tail.
 *
 * The output is deliberately NOT redacted here. The first production check failed on exactly that:
 * the Postgres password was a substring of the repository name, the redactor rewrote the origin URL
 * that `git remote get-url` printed, and the runner compared the mangled string against its
 * configuration — a permanent, baffling `remote_mismatch` on a perfectly configured host. Command
 * output feeds COMPARISONS first and the journal second, so secrets are stripped at the journal
 * boundary (`openRunJournal` / `writeDeploymentState`), never at capture.
 *
 * The timeout kills with SIGKILL rather than SIGTERM. `docker compose build` spawns a tree of
 * BuildKit processes; a polite signal to the parent leaves the build running and the runner waiting
 * for output that will never come, which is the shape of hang that made the update button
 * untrustworthy in the first place.
 */
export function spawnExec(options: SpawnExecOptions): Exec {
  const limit = Math.max(256, options.logTailBytes);
  return (step) => new Promise<ExecResult>((settle) => {
    const stdout = tailBuffer(limit);
    const stderr = tailBuffer(limit);
    let timedOut = false;
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settle({
        code,
        stdout: stdout.read(),
        stderr: stderr.read(),
        timedOut
      });
    };
    const child = spawn(step.command, [...step.args], {
      shell: false,
      cwd: step.cwd,
      env: step.env ? { ...process.env, ...step.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, step.timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: string) => stderr.push(chunk));
    // A binary that is not installed (`ENOENT`) never emits `close`. Reported as a failed step with
    // the reason in stderr rather than as a rejected promise: every caller in the runner treats a
    // non-zero result as a recorded, journalled failure, and an exception would escape that.
    child.on('error', (error: Error) => {
      stderr.push(`\n${step.command}: ${error.message}`);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

// ------------------------------------------------------------------------------------------------
// Test double
// ------------------------------------------------------------------------------------------------

/**
 * One canned answer, keyed by the whole command line the runner is expected to issue.
 *
 * A function entry may be async so that a test can give a step a real side effect — the migration
 * test lets the fake `compose run … migrate.js` insert into `schema_migrations`, which is what makes
 * the recorded set difference an assertion about the real reader rather than about a stub.
 */
export type ExecScript = Record<
  string,
  Partial<ExecResult> | ((step: ExecStep) => Partial<ExecResult> | Promise<Partial<ExecResult>>)
>;

export interface FakeExec {
  exec: Exec;
  /** Every step, in order. `commandLine` is what the script keys are matched against. */
  calls: ExecStep[];
  /** `${command} ${args.join(' ')}` for each call, in order — the argv byte-identity assertion. */
  lines: string[];
}

/**
 * A recording {@link Exec} whose answers are looked up by the exact command line.
 *
 * Matching on `${command} ${args.join(' ')}` and not on a prefix is deliberate: the point of the
 * runner tests is that the argv is EXACTLY what the scenario says it is, so a script entry that
 * stops matching because an argument moved must fail, not fall through to a default.
 *
 * An unscripted command answers `code: 0` with empty output. That keeps a test that only cares about
 * one failure short, and any test that cares about the full sequence asserts on {@link FakeExec.lines}.
 */
export function fakeExec(script: ExecScript = {}): FakeExec {
  const calls: ExecStep[] = [];
  const lines: string[] = [];
  const exec: Exec = async (step) => {
    calls.push(step);
    const line = `${step.command} ${step.args.join(' ')}`;
    lines.push(line);
    const entry = script[line];
    const answer = typeof entry === 'function' ? await entry(step) : entry;
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...answer };
  };
  return { exec, calls, lines };
}
