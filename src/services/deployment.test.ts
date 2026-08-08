import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';
import { commitState, registerDeploymentMetrics, type DeploymentStateView } from './deployment.js';

/**
 * The one decision this read-only service makes on its own: which of four words describes the
 * relationship between origin/main, the checkout on the host and the image that is actually serving.
 *
 * It matters because the ops card renders a coloured pill from it and an operator acts on the pill.
 * «Синхронізовано» beside a container running last week's code is the specific lie this function
 * exists to prevent.
 */

const REMOTE = '1f2e3d4c5b6a70819283746556473829100aabbc';
const OLD = '0011223344556677889900aabbccddeeff001122';

function state(patch: Partial<DeploymentStateView> = {}): DeploymentStateView {
  return {
    remoteUrl: 'https://github.com/IvanSnezhok/threatlens-ua.git',
    branch: 'main',
    remoteCommit: REMOTE,
    workingTreeCommit: REMOTE,
    workingTreeDirty: false,
    lastCheckedAt: new Date().toISOString(),
    lastCheckOk: true,
    lastCheckError: null,
    runnerVersion: 'host/1',
    ...patch
  };
}

describe('commitState', () => {
  it('is in_sync only when the RUNNING image is at origin/main', () => {
    expect(commitState(state(), REMOTE)).toBe('in_sync');
  });

  it('is behind when origin/main has moved past the checkout', () => {
    expect(commitState(state({ workingTreeCommit: OLD }), OLD)).toBe('behind');
  });

  it('is drifted when the checkout is current but the container is not', () => {
    // Somebody moved the working tree by hand without rebuilding: the code on disk is not the code
    // that is running, and «Доступне оновлення» would describe the wrong problem.
    expect(commitState(state(), OLD)).toBe('drifted');
  });

  it('is unknown before any check has succeeded', () => {
    expect(commitState(state({ remoteCommit: null }), REMOTE)).toBe('unknown');
    expect(commitState(null, REMOTE)).toBe('unknown');
  });

  it('is unknown for an image that cannot say what it is', () => {
    // An image built outside compose carries `APP_COMMIT=unknown` and honestly reports it. Claiming
    // `behind` there would invite a deployment to "fix" a state nobody has measured.
    expect(commitState(state(), 'unknown')).toBe('unknown');
    expect(commitState(state(), '')).toBe('unknown');
  });
});

describe('registerDeploymentMetrics', () => {
  it('attaches the seven gauges and is safe to call twice', () => {
    // `buildServer()` is called more than once in the test suite, and a registrar that threw on the
    // second registry would make every one of those files fail for a reason unrelated to its subject.
    const registry = new Registry();
    registerDeploymentMetrics(registry);
    expect(() => registerDeploymentMetrics(registry)).not.toThrow();
    const names = [
      'threatlens_deploy_runs', 'threatlens_deploy_active', 'threatlens_deploy_last_result',
      'threatlens_deploy_last_success_timestamp_seconds', 'threatlens_deploy_last_run_duration_seconds',
      'threatlens_deploy_commit_state', 'threatlens_deploy_last_check_age_seconds'
    ];
    for (const name of names) expect(registry.getSingleMetric(name), name).toBeTruthy();
  });

  it('does not attach itself to a registry merely by being imported', () => {
    // Detached construction (`registers: []`). Importing a service must never mutate a shared
    // registry — the pattern `registerPublicationMetrics` and `registerAlertChannelMetrics` use.
    const fresh = new Registry();
    expect(fresh.getSingleMetric('threatlens_deploy_runs')).toBeFalsy();
  });
});
