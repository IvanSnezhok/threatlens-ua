import { describe, expect, it } from 'vitest';
import { REDACTED, fakeExec, redactSecrets, spawnExec, type ExecStep } from './exec.js';

/**
 * The exec harness, which is where "Ops API має запускати тільки визначений сценарій оновлення, а не
 * довільні shell-команди" is either true or false.
 *
 * The property is not "the runner builds sensible arguments" — that is `./runner.test.ts`. It is the
 * stronger one underneath: **there is no shell**, so an argument containing shell metacharacters is
 * data. These tests prove it by running a real subprocess with real metacharacters and reading back
 * what the child actually received.
 *
 * `git rev-parse --sq-quote` is the instrument: it prints its arguments shell-quoted, so if anything
 * between here and the child had expanded `$(id)` the output would say so.
 */

const GIT_TIMEOUT = 15_000;

describe('spawnExec', () => {
  const exec = spawnExec({ logTailBytes: 8192, redact: [] });

  it('passes shell metacharacters to the child as literal bytes', async () => {
    const result = await exec({
      command: 'git',
      args: ['rev-parse', '--sq-quote', '$(id)', '; rm -rf /', '`whoami`', '&& touch /tmp/threatlens-pwned'],
      timeoutMs: GIT_TIMEOUT
    });
    expect(result.code).toBe(0);
    // Every one of them comes back quoted, i.e. unexpanded. A shell anywhere on this path would have
    // substituted the first and the third and split the second.
    expect(result.stdout.trim()).toBe(`'$(id)' '; rm -rf /' '\`whoami\`' '&& touch /tmp/threatlens-pwned'`);
  });

  it('does not merge two arguments that a shell would have split', async () => {
    const result = await exec({
      command: 'git', args: ['rev-parse', '--sq-quote', 'one two', 'three'], timeoutMs: GIT_TIMEOUT
    });
    expect(result.stdout.trim()).toBe(`'one two' 'three'`);
  });

  it('kills a command that outruns its timeout instead of waiting for it', async () => {
    const started = Date.now();
    // The `command` union is a compile-time boundary on what the RUNNER may build; this test is
    // about the harness's own mechanics, so it steps around it deliberately.
    const result = await exec({ command: 'sleep' as never, args: ['30'], timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('reports a missing binary as a failed step rather than a thrown promise', async () => {
    const result = await exec({
      command: 'threatlens-no-such-binary' as never, args: [], timeoutMs: GIT_TIMEOUT
    });
    // Every caller in `./runner.ts` treats a non-zero result as a journalled failure; an exception
    // would escape that and leave a run row with no terminal state.
    expect(result.code).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain('threatlens-no-such-binary');
  });

  it('strips the configured secrets out of captured output', async () => {
    const secret = 'runner-token-0123456789abcdef0123456789';
    const redacting = spawnExec({ logTailBytes: 8192, redact: [secret] });
    const result = await redacting({
      command: 'git', args: ['rev-parse', '--sq-quote', secret], timeoutMs: GIT_TIMEOUT
    });
    // `deployment_runs.log_tail` is rendered verbatim on the ops page. A build log that echoed the
    // runner token would publish it to everyone holding an ops password.
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).toContain(REDACTED);
  });

  it('keeps only the tail of an oversized stream', async () => {
    const long = 'x'.repeat(4000);
    const bounded = spawnExec({ logTailBytes: 512, redact: [] });
    const result = await bounded({
      command: 'git', args: ['rev-parse', '--sq-quote', long], timeoutMs: GIT_TIMEOUT
    });
    expect(result.stdout.length).toBeLessThanOrEqual(512);
    // The END of the output, which is where a build's actual error message lives.
    expect(result.stdout.trimEnd().endsWith(`'`)).toBe(true);
  });
});

describe('redactSecrets', () => {
  it('replaces every occurrence, not only the first', () => {
    const secret = 'S3CRET-VALUE-0123';
    expect(redactSecrets(`aa ${secret} bb ${secret} cc`, [secret]))
      .toBe(`aa ${REDACTED} bb ${REDACTED} cc`);
  });

  it('ignores values too short to be secrets', () => {
    // A two-character "secret" would redact half of every log line and destroy the thing the tail
    // exists for. The real values here are a 32-character token and a database password.
    expect(redactSecrets('a la carte', ['la'])).toBe('a la carte');
    expect(redactSecrets('', ['whatever-long-enough'])).toBe('');
  });
});

describe('fakeExec', () => {
  it('records every step in order and answers by exact command line', async () => {
    const fake = fakeExec({ 'git status --porcelain': { stdout: ' M src/x.ts\n' } });
    const clean = await fake.exec({ command: 'git', args: ['rev-parse', 'HEAD'], timeoutMs: 1 });
    const dirty = await fake.exec({ command: 'git', args: ['status', '--porcelain'], timeoutMs: 1 });
    expect(clean).toEqual({ code: 0, stdout: '', stderr: '', timedOut: false });
    expect(dirty.stdout).toBe(' M src/x.ts\n');
    expect(fake.lines).toEqual(['git rev-parse HEAD', 'git status --porcelain']);
  });

  it('exposes the whole step so a test can assert on env and timeouts too', async () => {
    const fake = fakeExec();
    const step: ExecStep = {
      command: 'docker', args: ['compose', 'build', 'app'], timeoutMs: 5, env: { APP_COMMIT: 'abc' }
    };
    await fake.exec(step);
    expect(fake.calls[0]!.env).toEqual({ APP_COMMIT: 'abc' });
  });
});
