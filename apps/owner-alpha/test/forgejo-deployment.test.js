import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  FORGEJO_JSON_MAX_BYTES,
  FORGEJO_SUPPORTED_MAJOR,
  OwnerAlphaError,
  discoverDeploymentRun,
  discoverForgejoActionsRun,
  monitorDeploymentRun,
  monitorForgejoActionsDeployment,
  validateOwnerAlphaConfig,
  verifyForgejoActionsDeployment,
} from '../src/index.js';

const APP_ROOT = path.resolve(import.meta.dir, '..');
const SHA = '0123456789abcdef0123456789abcdef01234567';
const TOKEN = 'test-observer-value';

async function config() {
  const raw = JSON.parse(await readFile(path.join(APP_ROOT, 'owner-alpha.forgejo.example.json'), 'utf8'));
  raw.limits.requestTimeoutMs = 5;
  raw.limits.networkTimeoutMs = 100;
  return validateOwnerAlphaConfig(raw);
}

// A self-hosted Forgejo instance that cannot bind 443. Only the API origin is
// ported here; $.live.baseUrl stays portless because the adapter still requires
// a portless canonical destination URL.
const PORTED_ORIGIN = 'https://127.0.0.2:8443';

async function portedConfig() {
  const raw = JSON.parse(await readFile(path.join(APP_ROOT, 'owner-alpha.forgejo.example.json'), 'utf8'));
  raw.limits.requestTimeoutMs = 5;
  raw.limits.networkTimeoutMs = 100;
  raw.repository.remote.url = `${PORTED_ORIGIN}/wp3-owner/fixture.git`;
  raw.owner.identity = 'wp3-owner';
  raw.workflow.apiBaseUrl = `${PORTED_ORIGIN}/api/v1`;
  raw.workflow.repository = 'wp3-owner/fixture';
  return validateOwnerAlphaConfig(raw);
}

function portedRun(overrides = {}) {
  return run({
    html_url: `${PORTED_ORIGIN}/wp3-owner/fixture/actions/runs/17`,
    repository: { id: 123, full_name: 'wp3-owner/fixture' },
    ...overrides,
  });
}

function run(overrides = {}) {
  return {
    id: 456,
    index_in_repo: 17,
    workflow_id: 'publish-site.yml',
    commit_sha: SHA,
    event: 'push',
    trigger_event: 'push',
    status: 'running',
    html_url: 'https://forgejo.example/owner/repository/actions/runs/17',
    repository: { id: 123, full_name: 'owner/repository' },
    event_payload: JSON.stringify({ ref: 'refs/heads/main', after: SHA, commits: [{ id: 'f'.repeat(40) }] }),
    ...overrides,
  };
}

function jobs(status = 'running') {
  return [
    { id: 701, run_id: 456, attempt: 1, handle: 'build-handle', name: 'build', needs: [], status },
    { id: 702, run_id: 456, attempt: 1, handle: 'deploy-handle', name: 'deploy', needs: ['build'], status },
  ];
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers });
}

function queueFetch(responses, observations = []) {
  const queue = [...responses];
  return async (url, options) => {
    observations.push({ url, options });
    if (queue.length === 0) throw new Error(`unexpected fetch ${url}`);
    const next = queue.shift();
    return typeof next === 'function' ? next(url, options) : next;
  };
}

function version(value = '16.0.2') {
  return json({ version: value });
}

function listing(entries, totalCount = entries.length) {
  return json({ total_count: totalCount, workflow_runs: entries });
}

function fakeTime({ start = 0 } = {}) {
  let now = start;
  return {
    clock: () => now,
    sleep: async (milliseconds, signal) => {
      if (signal?.aborted) throw signal.reason;
      now += milliseconds;
    },
    setTimer: () => ({ fake: true }),
    clearTimer: () => {},
    retryIntervalMs: 5,
  };
}

async function expectCode(action, code) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerAlphaError);
    expect(error.code).toBe(code);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    return error;
  }
  throw new Error(`expected OwnerAlphaError(${code})`);
}

async function discovery(overrides = {}) {
  const cfg = await config();
  const observations = [];
  const fetch = queueFetch([
    version(),
    listing([run()]),
    json(run()),
    json(jobs()),
  ], observations);
  const result = await discoverForgejoActionsRun({ config: cfg, applicationSha: SHA }, {
    fetch,
    ...fakeTime(),
    ...overrides,
  });
  return { cfg, result, observations };
}

describe('Forgejo Actions exact discovery binding', () => {
  test('exports the fixed compatibility and response limits', () => {
    expect(FORGEJO_SUPPORTED_MAJOR).toBe(16);
    expect(FORGEJO_JSON_MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  test('preflights version, issues only bounded GETs, and returns normalized run/job identity', async () => {
    const { result, observations } = await discovery();
    expect(result.binding).toEqual({
      provider: 'forgejo-actions',
      apiBaseUrl: 'https://forgejo.example/api/v1',
      instanceVersion: '16.0.2',
      repository: 'owner/repository',
      repositoryId: '123',
      runId: '456',
      runNumber: 17,
      workflowId: 'publish-site.yml',
      configuredWorkflowPath: '.forgejo/workflows/publish-site.yml',
      event: 'push',
      triggerEvent: 'push',
      ref: 'refs/heads/main',
      headSha: SHA,
      htmlUrl: 'https://forgejo.example/owner/repository/actions/runs/17',
      jobs: [
        { id: '701', name: 'build', attempt: 1, handle: 'build-handle', needs: [] },
        { id: '702', name: 'deploy', attempt: 1, handle: 'deploy-handle', needs: ['build'] },
      ],
    });
    expect(observations).toHaveLength(4);
    expect(new URL(observations[0].url).pathname).toBe('/api/v1/version');
    const query = new URL(observations[1].url);
    expect(query.pathname).toBe('/api/v1/repos/owner/repository/actions/runs');
    expect(Object.fromEntries(query.searchParams)).toEqual({
      event: 'push',
      head_sha: SHA,
      ref: 'refs/heads/main',
      workflow_id: 'publish-site.yml',
      page: '1',
      limit: '2',
    });
    expect(observations.map(({ options }) => options.method)).toEqual(['GET', 'GET', 'GET', 'GET']);
    expect(observations.every(({ options }) => options.redirect === 'error')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('event_payload');
    expect(JSON.stringify(result)).not.toContain('Authorization');
  });

  test('uses the optional per-request token callback without retaining credential material', async () => {
    let tokenReads = 0;
    const headers = [];
    const { result, observations } = await discovery({
      getForgejoObserverToken: async () => {
        tokenReads += 1;
        return TOKEN;
      },
    });
    for (const observation of observations) headers.push(observation.options.headers.Authorization);
    expect(tokenReads).toBe(4);
    expect(headers).toEqual(Array(4).fill(`Bearer ${TOKEN}`));
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  test('retries zero results and fixes the first candidate without listing again', async () => {
    const cfg = await config();
    const observations = [];
    const fetch = queueFetch([
      version(),
      listing([], 0),
      listing([run()]),
      json(run()),
      json([jobs()[0]]),
      json(run()),
      json(jobs()),
    ], observations);
    const result = await discoverForgejoActionsRun({ config: cfg, applicationSha: SHA }, {
      fetch,
      ...fakeTime(),
    });
    expect(result.binding.runId).toBe('456');
    const listCalls = observations.filter(({ url }) => new URL(url).pathname.endsWith('/actions/runs'));
    expect(listCalls).toHaveLength(2);
    expect(observations.slice(-4).map(({ url }) => new URL(url).pathname)).toEqual([
      '/api/v1/repos/owner/repository/actions/runs/456',
      '/api/v1/repos/owner/repository/actions/runs/456/jobs',
      '/api/v1/repos/owner/repository/actions/runs/456',
      '/api/v1/repos/owner/repository/actions/runs/456/jobs',
    ]);
  });

  test('retries jobs whose Forgejo attempt and handle are still initializing', async () => {
    const cfg = await config();
    const observations = [];
    const initializing = [
      jobs()[0],
      { ...jobs()[1], attempt: 0, handle: '', status: 'blocked' },
    ];
    const fetch = queueFetch([
      version(),
      listing([run()]),
      json(run()),
      json(initializing),
      json(run()),
      json(jobs()),
    ], observations);
    const result = await discoverForgejoActionsRun({ config: cfg, applicationSha: SHA }, {
      fetch,
      ...fakeTime(),
    });
    expect(result.binding.jobs).toEqual([
      { id: '701', name: 'build', attempt: 1, handle: 'build-handle', needs: [] },
      { id: '702', name: 'deploy', attempt: 1, handle: 'deploy-handle', needs: ['build'] },
    ]);
    expect(observations.filter(({ url }) => new URL(url).pathname.endsWith('/456/jobs'))).toHaveLength(2);
  });

  test('fails if a terminal run never exposes bindable job identity fields', async () => {
    const cfg = await config();
    await expectCode(() => discoverForgejoActionsRun({ config: cfg, applicationSha: SHA }, {
      fetch: queueFetch([
        version(),
        listing([run()]),
        json(run({ status: 'success' })),
        json([jobs('success')[0], { ...jobs('success')[1], attempt: 0, handle: '' }]),
      ]),
      ...fakeTime(),
    }), 'deployment-jobs-identity-mismatch');
  });

  test('treats API run-array order as irrelevant to configured job evidence order', async () => {
    const cfg = await config();
    const fetch = queueFetch([version(), listing([run()]), json(run()), json([...jobs()].reverse())]);
    const result = await discoverForgejoActionsRun({ config: cfg, applicationSha: SHA }, { fetch, ...fakeTime() });
    expect(result.binding.jobs.map((job) => job.name)).toEqual(['build', 'deploy']);
  });

  test('treats dependency identity as a set across discovery and monitoring', async () => {
    const cfg = structuredClone(await config());
    cfg.workflow.jobs = ['build', 'verify', 'deploy'];
    const threeJobs = (status, needs) => [
      { id: 701, run_id: 456, attempt: 1, handle: 'build-handle', name: 'build', needs: [], status },
      { id: 703, run_id: 456, attempt: 1, handle: 'verify-handle', name: 'verify', needs: [], status },
      { id: 702, run_id: 456, attempt: 1, handle: 'deploy-handle', name: 'deploy', needs, status },
    ];
    const discovered = await discoverForgejoActionsRun({ config: cfg, applicationSha: SHA }, {
      fetch: queueFetch([
        version(),
        listing([run()]),
        json(run()),
        json(threeJobs('running', ['verify', 'build'])),
      ]),
      ...fakeTime(),
    });
    expect(discovered.binding.jobs.at(-1).needs).toEqual(['build', 'verify']);
    const monitored = await monitorForgejoActionsDeployment({
      config: cfg,
      applicationSha: SHA,
      boundRun: discovered.binding,
    }, {
      fetch: queueFetch([
        version(),
        json(run({ status: 'success' })),
        json(threeJobs('success', ['build', 'verify'])),
      ]),
      ...fakeTime(),
    });
    expect(monitored.publication.state).toBe('success');
  });

  test('fails closed on multiple, duplicate, and incomplete bounded run results', async () => {
    const cfg = await config();
    const cases = [
      [listing([run(), run({ id: 457, index_in_repo: 18 })], 2), 'deployment-run-discovery-ambiguous'],
      [listing([run(), run()], 2), 'deployment-run-discovery-ambiguous'],
      [listing([run()], 2), 'deployment-run-discovery-invalid-response'],
      [json({ total_count: 0, workflow_runs: [run()] }), 'deployment-run-discovery-invalid-response'],
    ];
    for (const [response, code] of cases) {
      await expectCode(() => discoverForgejoActionsRun({ config: cfg, applicationSha: SHA }, {
        fetch: queueFetch([version(), response]),
        ...fakeTime(),
      }), code);
    }
  });

  test('rejects wrong SHA, ref, workflow, repository, event, and contradictory event payloads', async () => {
    const cfg = await config();
    const variants = [
      run({ commit_sha: 'f'.repeat(40) }),
      run({ workflow_id: 'other.yml' }),
      run({ repository: { id: 123, full_name: 'owner/other' } }),
      run({ event: 'workflow_dispatch' }),
      run({ trigger_event: 'workflow_dispatch' }),
      run({ event_payload: JSON.stringify({ ref: 'refs/heads/release', after: SHA }) }),
      run({ event_payload: JSON.stringify({ ref: 'refs/heads/main', after: 'f'.repeat(40) }) }),
    ];
    for (const candidate of variants) {
      await expectCode(() => discoverForgejoActionsRun({ config: cfg, applicationSha: SHA }, {
        fetch: queueFetch([version(), listing([candidate])]),
        ...fakeTime(),
      }), 'deployment-run-identity-mismatch');
    }
    for (const payload of ['{', '[]', null]) {
      await expectCode(() => discoverForgejoActionsRun({ config: cfg, applicationSha: SHA }, {
        fetch: queueFetch([version(), listing([run({ event_payload: payload })])]),
        ...fakeTime(),
      }), 'deployment-run-event-payload-invalid');
    }
  });

  test('rejects unsupported versions and changed instance identity', async () => {
    const cfg = await config();
    for (const value of ['15.9.9', '17.0.0', 'Forgejo 16', null]) {
      await expectCode(() => discoverForgejoActionsRun({ config: cfg, applicationSha: SHA }, {
        fetch: queueFetch([version(value)]),
        ...fakeTime(),
      }), 'forgejo-version-unsupported');
    }
    const { result } = await discovery();
    await expectCode(() => monitorForgejoActionsDeployment({
      config: cfg,
      applicationSha: SHA,
      boundRun: result.binding,
    }, { fetch: queueFetch([version('16.0.3')]), ...fakeTime() }), 'forgejo-instance-identity-mismatch');
  });

  test('rejects malformed, extra, duplicate, failed, unsupported, and dependency-mismatched jobs', async () => {
    const cfg = await config();
    const cases = [
      [[...jobs(), { id: 703, run_id: 456, attempt: 1, handle: 'extra', name: 'lint', needs: [], status: 'running' }], 'deployment-jobs-identity-mismatch'],
      [[jobs()[0], { ...jobs()[1], name: 'build' }], 'deployment-jobs-identity-mismatch'],
      [[jobs()[0], { ...jobs()[1], id: 701 }], 'deployment-jobs-identity-mismatch'],
      [[jobs()[0], { ...jobs()[1], status: 'failure' }], 'deployment-job-not-successful'],
      [[jobs()[0], { ...jobs()[1], status: 'queued' }], 'deployment-status-unsupported'],
      [[jobs()[0], { ...jobs()[1], needs: [] }], 'deployment-job-dependency-mismatch'],
      [[jobs()[0], { ...jobs()[1], run_id: 999 }], 'deployment-jobs-identity-mismatch'],
      [[jobs()[0], { ...jobs()[1], handle: null }], 'deployment-jobs-identity-mismatch'],
      [[jobs()[0], { ...jobs()[1], attempt: -1 }], 'deployment-jobs-identity-mismatch'],
    ];
    for (const [jobPayload, code] of cases) {
      await expectCode(() => discoverForgejoActionsRun({ config: cfg, applicationSha: SHA }, {
        fetch: queueFetch([version(), listing([run()]), json(run()), json(jobPayload)]),
        ...fakeTime(),
      }), code);
    }
  });
});

describe('Forgejo Actions stored-binding monitoring', () => {
  test('reobserves only the exact stored run/jobs and emits owner-policy publication evidence', async () => {
    const { cfg, result } = await discovery();
    const observations = [];
    const fetch = queueFetch([version(), json(run({ status: 'success' })), json(jobs('success'))], observations);
    const deployment = await monitorForgejoActionsDeployment({
      config: cfg,
      applicationSha: SHA,
      boundRun: result.binding,
    }, { fetch, ...fakeTime() });
    expect(observations.map(({ url }) => new URL(url).pathname)).toEqual([
      '/api/v1/version',
      '/api/v1/repos/owner/repository/actions/runs/456',
      '/api/v1/repos/owner/repository/actions/runs/456/jobs',
    ]);
    expect(deployment.provider).toBe('forgejo-actions');
    expect(deployment.run).toMatchObject({ id: '456', status: 'success', instanceVersion: '16.0.2' });
    expect(deployment.jobs.names).toEqual(['build', 'deploy']);
    expect(deployment.publication).toEqual({
      state: 'success',
      deploymentJobName: 'deploy',
      deploymentJobId: '702',
      deploymentJobAttempt: 1,
      deploymentJobHandle: 'deploy-handle',
      destinationUrl: 'https://published.example/site/',
      destinationSource: 'owner-policy',
      forgeEnvironmentAttested: false,
    });
    expect(JSON.stringify(deployment)).not.toMatch(/environmentId|deploymentId|apiResponse|event_payload/u);
  });

  test('keeps a ported API origin through discovery, the stored binding, and reobservation', async () => {
    const cfg = await portedConfig();
    const discoveryCalls = [];
    const discovered = await discoverForgejoActionsRun({ config: cfg, applicationSha: SHA }, {
      fetch: queueFetch([
        version(),
        listing([portedRun()]),
        json(portedRun()),
        json(jobs()),
      ], discoveryCalls),
      ...fakeTime(),
    });
    expect(discovered.binding.apiBaseUrl).toBe(`${PORTED_ORIGIN}/api/v1`);
    expect(discovered.binding.repository).toBe('wp3-owner/fixture');
    expect(discovered.binding.htmlUrl).toBe(`${PORTED_ORIGIN}/wp3-owner/fixture/actions/runs/17`);
    expect(discoveryCalls.map(({ url }) => new URL(url).origin))
      .toEqual(Array(4).fill(PORTED_ORIGIN));
    expect(discoveryCalls.map(({ url }) => new URL(url).port)).toEqual(Array(4).fill('8443'));
    expect(new URL(discoveryCalls[0].url).pathname).toBe('/api/v1/version');
    expect(new URL(discoveryCalls[1].url).pathname)
      .toBe('/api/v1/repos/wp3-owner/fixture/actions/runs');

    const monitorCalls = [];
    const deployment = await monitorForgejoActionsDeployment({
      config: cfg,
      applicationSha: SHA,
      boundRun: discovered.binding,
    }, {
      fetch: queueFetch([
        version(),
        json(portedRun({ status: 'success' })),
        json(jobs('success')),
      ], monitorCalls),
      ...fakeTime(),
    });
    expect(monitorCalls.map(({ url }) => new URL(url).origin))
      .toEqual(Array(3).fill(PORTED_ORIGIN));
    expect(monitorCalls.map(({ url }) => new URL(url).pathname)).toEqual([
      '/api/v1/version',
      '/api/v1/repos/wp3-owner/fixture/actions/runs/456',
      '/api/v1/repos/wp3-owner/fixture/actions/runs/456/jobs',
    ]);
    expect(deployment.publication.state).toBe('success');
    expect(deployment.publication.destinationUrl).toBe('https://published.example/site/');
  });

  test('rejects a stored binding whose API origin drops or changes the explicit port', async () => {
    const cfg = await portedConfig();
    const discovered = await discoverForgejoActionsRun({ config: cfg, applicationSha: SHA }, {
      fetch: queueFetch([version(), listing([portedRun()]), json(portedRun()), json(jobs())]),
      ...fakeTime(),
    });
    for (const apiBaseUrl of ['https://127.0.0.2/api/v1', 'https://127.0.0.2:9443/api/v1']) {
      const boundRun = structuredClone(discovered.binding);
      boundRun.apiBaseUrl = apiBaseUrl;
      let fetches = 0;
      await expectCode(() => monitorForgejoActionsDeployment({ config: cfg, applicationSha: SHA, boundRun }, {
        fetch: async () => { fetches += 1; return version(); },
        ...fakeTime(),
      }), 'deployment-run-binding-invalid');
      expect(fetches).toBe(0);
    }
  });

  test('validates the stored binding before any network access', async () => {
    const { cfg, result } = await discovery();
    for (const change of [
      (binding) => { binding.provider = 'github-actions'; },
      (binding) => { binding.headSha = 'f'.repeat(40); },
      (binding) => { binding.repository = 'owner/other'; },
      (binding) => { binding.jobs[1].needs = []; },
    ]) {
      const boundRun = structuredClone(result.binding);
      change(boundRun);
      let fetches = 0;
      await expectCode(() => monitorForgejoActionsDeployment({ config: cfg, applicationSha: SHA, boundRun }, {
        fetch: async () => { fetches += 1; return version(); },
        ...fakeTime(),
      }), 'deployment-run-binding-invalid');
      expect(fetches).toBe(0);
    }
  });

  test('rejects rerun ID, attempt, handle, dependency, missing-job, and run-field drift', async () => {
    const { cfg, result } = await discovery();
    const cases = [
      [run({ status: 'success' }), [jobs('success')[0], { ...jobs('success')[1], id: 999 }], 'deployment-job-rerun-identity-mismatch'],
      [run({ status: 'success' }), [jobs('success')[0], { ...jobs('success')[1], attempt: 2 }], 'deployment-job-rerun-identity-mismatch'],
      [run({ status: 'success' }), [jobs('success')[0], { ...jobs('success')[1], handle: 'new-handle' }], 'deployment-job-rerun-identity-mismatch'],
      [run({ status: 'success' }), [jobs('success')[0], { ...jobs('success')[1], needs: [] }], 'deployment-job-rerun-identity-mismatch'],
      [run({ status: 'success' }), [jobs('success')[0]], 'deployment-jobs-identity-mismatch'],
      [run({ status: 'success', index_in_repo: 18 }), jobs('success'), 'deployment-run-identity-mismatch'],
    ];
    for (const [runPayload, jobPayload, code] of cases) {
      await expectCode(() => monitorForgejoActionsDeployment({ config: cfg, applicationSha: SHA, boundRun: result.binding }, {
        fetch: queueFetch([version(), json(runPayload), json(jobPayload)]),
        ...fakeTime(),
      }), code);
    }
  });

  test('rejects terminal run/job failures and unsupported status vocabulary', async () => {
    const { cfg, result } = await discovery();
    const cases = [
      [run({ status: 'failure' }), jobs('running'), 'deployment-run-not-successful'],
      [run({ status: 'success' }), [jobs('success')[0], { ...jobs('success')[1], status: 'cancelled' }], 'deployment-job-not-successful'],
      [run({ status: 'completed' }), jobs('success'), 'deployment-status-unsupported'],
      [run({ status: 'success' }), [jobs('success')[0], { ...jobs('success')[1], status: 'queued' }], 'deployment-status-unsupported'],
    ];
    for (const [runPayload, jobPayload, code] of cases) {
      await expectCode(() => monitorForgejoActionsDeployment({ config: cfg, applicationSha: SHA, boundRun: result.binding }, {
        fetch: queueFetch([version(), json(runPayload), json(jobPayload)]),
        ...fakeTime(),
      }), code);
    }
  });

  test('does not rediscover or substitute a missing bound run/job', async () => {
    const { cfg, result } = await discovery();
    for (const [response, code] of [
      [json({}, 404), 'deployment-run-external-identity-failure'],
      [json({}, 401), 'deployment-run-external-identity-failure'],
    ]) {
      const observations = [];
      await expectCode(() => monitorForgejoActionsDeployment({ config: cfg, applicationSha: SHA, boundRun: result.binding }, {
        fetch: queueFetch([version(), response], observations),
        ...fakeTime(),
      }), code);
      expect(observations.some(({ url }) => new URL(url).pathname.endsWith('/actions/runs'))).toBe(false);
    }
    await expectCode(() => monitorForgejoActionsDeployment({ config: cfg, applicationSha: SHA, boundRun: result.binding }, {
      fetch: queueFetch([version(), json(run()), json({}, 404)]),
      ...fakeTime(),
    }), 'deployment-job-external-identity-failure');
  });
});

describe('Forgejo HTTP, deadline, dispatcher, and combined verification contracts', () => {
  test('fails unsupported dispatch providers before fetch', async () => {
    let fetches = 0;
    const unknown = { workflow: { provider: 'gitea-actions' } };
    await expectCode(() => discoverDeploymentRun({ config: unknown, applicationSha: SHA }, {
      fetch: async () => { fetches += 1; },
    }), 'unsupported-deployment-provider');
    await expectCode(() => monitorDeploymentRun({ config: unknown, applicationSha: SHA, boundRun: {} }, {
      fetch: async () => { fetches += 1; },
    }), 'unsupported-deployment-provider');
    expect(fetches).toBe(0);
  });

  test('dispatches Forgejo discovery and monitoring without changing signatures', async () => {
    const cfg = await config();
    const discovered = await discoverDeploymentRun({ config: cfg, applicationSha: SHA }, {
      fetch: queueFetch([version(), listing([run()]), json(run()), json(jobs())]),
      ...fakeTime(),
    });
    const monitored = await monitorDeploymentRun({ config: cfg, applicationSha: SHA, boundRun: discovered.binding }, {
      fetch: queueFetch([version(), json(run({ status: 'success' })), json(jobs('success'))]),
      ...fakeTime(),
    });
    expect(discovered.binding.provider).toBe('forgejo-actions');
    expect(monitored.publication.state).toBe('success');
  });

  test('combined verification shares the supplied bounded operation and returns both phases', async () => {
    const cfg = await config();
    const result = await verifyForgejoActionsDeployment({ config: cfg, applicationSha: SHA }, {
      fetch: queueFetch([
        version(), listing([run()]), json(run()), json(jobs()),
        version(), json(run({ status: 'success' })), json(jobs('success')),
      ]),
      ...fakeTime(),
    });
    expect(result.discovery.binding.runId).toBe('456');
    expect(result.deployment.publication.state).toBe('success');
  });

  test('fails immediately on authentication and other non-retryable statuses but retries transient statuses', async () => {
    const cfg = await config();
    for (const status of [401, 403, 404]) {
      let calls = 0;
      await expectCode(() => discoverForgejoActionsRun({ config: cfg, applicationSha: SHA }, {
        fetch: async () => { calls += 1; return json({}, status); },
        ...fakeTime(),
      }), 'forgejo-version-unavailable');
      expect(calls).toBe(1);
    }
    let transientCalls = 0;
    const fetch = queueFetch([
      () => { transientCalls += 1; return json({}, 503); },
      () => { transientCalls += 1; return version(); },
      listing([run()]), json(run()), json(jobs()),
    ]);
    const result = await discoverForgejoActionsRun({ config: cfg, applicationSha: SHA }, { fetch, ...fakeTime() });
    expect(result.binding.runId).toBe('456');
    expect(transientCalls).toBe(2);
  });

  test('fails a forbidden redirect immediately without retrying or re-reading a token', async () => {
    const cfg = await config();
    let fetches = 0;
    let tokenReads = 0;
    const error = new TypeError('fetch failed', {
      cause: new Error('redirect mode is set to error'),
    });
    await expectCode(() => discoverForgejoActionsRun({ config: cfg, applicationSha: SHA, timeoutMs: 100 }, {
      fetch: async () => {
        fetches += 1;
        throw error;
      },
      getForgejoObserverToken: async () => {
        tokenReads += 1;
        return TOKEN;
      },
      ...fakeTime(),
    }), 'forgejo-redirect-forbidden');
    expect(fetches).toBe(1);
    expect(tokenReads).toBe(1);
  });

  test('distinguishes external abort from deadline expiry', async () => {
    const cfg = await config();
    const controller = new AbortController();
    controller.abort(new Error('caller stopped'));
    await expectCode(() => discoverForgejoActionsRun({ config: cfg, applicationSha: SHA, signal: controller.signal }, {
      fetch: async () => { throw new Error('must not fetch'); },
      ...fakeTime(),
    }), 'deployment-observation-aborted');

    await expectCode(() => discoverForgejoActionsRun({ config: cfg, applicationSha: SHA, timeoutMs: 5 }, {
      fetch: async () => json({}, 503),
      ...fakeTime(),
    }), 'forgejo-version-timeout');
  });

  test('rejects malformed JSON, unavailable streams, declared oversize, and streamed oversize', async () => {
    const cfg = await config();
    await expectCode(() => discoverForgejoActionsRun({ config: cfg, applicationSha: SHA }, {
      fetch: queueFetch([new Response('{', { status: 200 })]),
      ...fakeTime(),
    }), 'forgejo-invalid-json');
    await expectCode(() => discoverForgejoActionsRun({ config: cfg, applicationSha: SHA }, {
      fetch: queueFetch([new Response(Uint8Array.from([0x22, 0xff, 0x22]), { status: 200 })]),
      ...fakeTime(),
    }), 'forgejo-invalid-json');
    await expectCode(() => discoverForgejoActionsRun({ config: cfg, applicationSha: SHA }, {
      fetch: queueFetch([{ status: 200, headers: new Headers(), body: null }]),
      ...fakeTime(),
    }), 'forgejo-response-body-unavailable');
    await expectCode(() => discoverForgejoActionsRun({ config: cfg, applicationSha: SHA }, {
      fetch: queueFetch([{ status: 200, headers: new Headers({ 'content-length': String(FORGEJO_JSON_MAX_BYTES + 1) }), body: new Response('{}').body }]),
      ...fakeTime(),
    }), 'forgejo-version-response-too-large');
    await expectCode(() => discoverForgejoActionsRun({ config: cfg, applicationSha: SHA }, {
      fetch: queueFetch([new Response(`"${'x'.repeat(FORGEJO_JSON_MAX_BYTES + 1)}"`, { status: 200 })]),
      ...fakeTime(),
    }), 'forgejo-version-response-too-large');
  });

  test('bounds a stalled observer-token lookup by the caller deadline', async () => {
    const cfg = await config();
    await expectCode(() => discoverForgejoActionsRun({ config: cfg, applicationSha: SHA, timeoutMs: 10 }, {
      fetch: async () => { throw new Error('must not fetch'); },
      getForgejoObserverToken: async () => new Promise(() => {}),
    }), 'forgejo-version-timeout');
  });

  test('rejects invalid observer tokens without placing them in errors', async () => {
    const cfg = await config();
    for (const value of ['', ' spaced ', 'two words', 'line\nbreak', 42]) {
      await expectCode(() => discoverForgejoActionsRun({ config: cfg, applicationSha: SHA }, {
        fetch: async () => { throw new Error('must not fetch'); },
        getForgejoObserverToken: async () => value,
        ...fakeTime(),
      }), 'forgejo-observer-token-invalid');
    }
  });
});
