import { describe, expect, test } from 'bun:test';
import { OwnerAlphaError } from '../src/errors.js';
import {
  discoverGithubActionsRun,
  monitorGithubActionsDeployment,
  verifyGithubActionsDeployment,
} from '../src/deployment/github-actions.js';
import {
  discoverDeploymentRun,
  monitorDeploymentRun,
} from '../src/deployment/index.js';
import { confirmLivePage } from '../src/live-confirm.js';

const SHA = 'a'.repeat(40);
const RUN_ID = '12345';
const WORKFLOW_ID = 77;
const PAGE_URL = 'https://cybersader.github.io/cyberbase/guide/?view=full';
const OLD = 'The old exact sentence.';
const NEW = 'The corrected exact sentence.';

const config = Object.freeze({
  workflow: Object.freeze({
    provider: 'github-actions',
    repository: 'cybersader/cyberbase',
    name: 'Publish vault site',
    path: '.github/workflows/publish-site.yml',
    event: 'push',
    branch: 'main',
    jobs: Object.freeze(['build', 'deploy']),
    environment: 'github-pages',
  }),
  live: Object.freeze({ baseUrl: 'https://cybersader.github.io/cyberbase/' }),
  limits: Object.freeze({ requestTimeoutMs: 1_000, networkTimeoutMs: 5_000 }),
});

function response({ status = 200, url = '', json, body = '', headers = {}, redirected = false } = {}) {
  const payload = json === undefined ? body : JSON.stringify(json);
  return {
    status,
    url,
    redirected,
    headers: new Headers({
      'Content-Type': json === undefined ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
      ...headers,
    }),
    get body() { return new Response(payload).body; },
  };
}

function run(overrides = {}) {
  return {
    id: Number(RUN_ID),
    workflow_id: WORKFLOW_ID,
    run_attempt: 1,
    name: config.workflow.name,
    path: config.workflow.path,
    event: config.workflow.event,
    head_branch: config.workflow.branch,
    head_sha: SHA,
    status: 'completed',
    conclusion: 'success',
    html_url: `https://github.com/cybersader/cyberbase/actions/runs/${RUN_ID}`,
    ...overrides,
  };
}

function jobs(overrides = {}) {
  const base = [
    {
      id: 1,
      name: 'build',
      run_id: Number(RUN_ID),
      run_attempt: 1,
      workflow_name: config.workflow.name,
      head_branch: config.workflow.branch,
      head_sha: SHA,
      status: 'completed',
      conclusion: 'success',
      html_url: `https://github.com/cybersader/cyberbase/actions/runs/${RUN_ID}/job/1`,
    },
    {
      id: 2,
      name: 'deploy',
      run_id: Number(RUN_ID),
      run_attempt: 1,
      workflow_name: config.workflow.name,
      head_branch: config.workflow.branch,
      head_sha: SHA,
      status: 'completed',
      conclusion: 'success',
      html_url: `https://github.com/cybersader/cyberbase/actions/runs/${RUN_ID}/job/2`,
    },
  ];
  const entries = overrides.entries ?? base;
  return { total_count: overrides.total_count ?? entries.length, jobs: entries };
}

function deployment(overrides = {}) {
  return {
    id: 9,
    sha: SHA,
    ref: 'main',
    task: 'deploy',
    environment: 'github-pages',
    original_environment: 'github-pages',
    performed_via_github_app: { slug: 'github-actions' },
    ...overrides,
  };
}

function deploymentStatus(overrides = {}) {
  const deployUrl = `https://github.com/cybersader/cyberbase/actions/runs/${RUN_ID}/job/2`;
  return {
    state: 'success',
    environment: 'github-pages',
    target_url: deployUrl,
    log_url: deployUrl,
    environment_url: config.live.baseUrl,
    ...overrides,
  };
}

function fakeRuntime(fetcher, { start = 0, retryIntervalMs = 1_000 } = {}) {
  let now = start;
  const calls = [];
  const sleeps = [];
  const timers = [];
  return {
    calls,
    sleeps,
    timers,
    dependencies: {
      retryIntervalMs,
      clock: () => now,
      async sleep(milliseconds) {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
      setTimer(callback, milliseconds) {
        const timer = { callback, milliseconds, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer(timer) { timer.cleared = true; },
      async fetch(url, options) {
        calls.push({ url, options });
        return fetcher(url, options, calls.length);
      },
    },
  };
}

function successfulGithubRuntime(overrides = {}) {
  const queues = {
    discovery: [...(overrides.discovery ?? [])],
    runs: [...(overrides.runs ?? [])],
    jobs: [...(overrides.jobs ?? [])],
    deployments: [...(overrides.deployments ?? [])],
    statuses: [...(overrides.statuses ?? [])],
  };
  return fakeRuntime((url) => {
    if (url.includes('/actions/runs?')) {
      return queues.discovery.shift() ?? response({ json: { total_count: 1, workflow_runs: [run()] } });
    }
    if (url.includes('/jobs?')) {
      return queues.jobs.shift() ?? response({ json: jobs() });
    }
    if (url.includes('/deployments?')) {
      return queues.deployments.shift() ?? response({ json: [deployment()] });
    }
    if (url.includes('/deployments/') && url.includes('/statuses?')) {
      return queues.statuses.shift() ?? response({ json: [deploymentStatus()] });
    }
    return queues.runs.shift() ?? response({ json: run() });
  });
}

async function expectCode(action, code) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerAlphaError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected OwnerAlphaError(${code})`);
}

function liveRuntime(pages, options = {}) {
  const queue = [...pages];
  return fakeRuntime((url) => queue.shift() ?? response({
    url,
    body: `<!doctype html><html><body><p>${NEW}</p></body></html>`,
  }), options);
}

describe('read-only GitHub Actions deployment binding', () => {
  test('generic dispatch preserves GitHub discovery and exact bound-run monitoring', async () => {
    const runtime = successfulGithubRuntime();
    const discovery = await discoverDeploymentRun({ config, applicationSha: SHA }, runtime.dependencies);
    const deploymentResult = await monitorDeploymentRun({
      config,
      applicationSha: SHA,
      boundRun: discovery.binding,
    }, runtime.dependencies);

    expect(discovery.binding).toMatchObject({
      provider: 'github-actions',
      repository: config.workflow.repository,
      runId: RUN_ID,
      runAttempt: 1,
      headSha: SHA,
    });
    expect(deploymentResult).toMatchObject({
      provider: 'github-actions',
      run: { runId: RUN_ID, runAttempt: 1, headSha: SHA },
      environment: { state: 'success', deploymentJobId: '2' },
    });
    expect(runtime.calls.filter((call) => call.url.includes('/actions/runs?'))).toHaveLength(1);
  });

  test('discovers one exact run, binds its ID, and monitors only that run through jobs and Pages', async () => {
    const runtime = successfulGithubRuntime();
    const result = await verifyGithubActionsDeployment({ config, applicationSha: SHA }, runtime.dependencies);

    expect(result.discovery.binding).toMatchObject({
      runId: RUN_ID,
      headSha: SHA,
      headBranch: 'main',
      event: 'push',
      name: config.workflow.name,
      path: config.workflow.path,
    });
    expect(result.deployment.jobs.names).toEqual(['build', 'deploy']);
    expect(result.deployment.environment).toMatchObject({
      state: 'success',
      environment: 'github-pages',
      environmentUrl: config.live.baseUrl,
      deploymentJobId: '2',
      runId: RUN_ID,
    });
    expect(runtime.calls.every((call) => call.options.method === 'GET')).toBe(true);
    expect(new Set(runtime.calls.map((call) => call.options.signal)).size).toBe(1);
    expect(runtime.calls.filter((call) => call.url.includes('/actions/runs?'))).toHaveLength(1);
    expect(runtime.calls.some((call) => call.url.includes(`/actions/runs/${RUN_ID}`))).toBe(true);
    expect(runtime.timers).toHaveLength(1);
    expect(runtime.timers[0].cleared).toBe(true);
  });

  test('rejects competing exact runs instead of guessing the latest', async () => {
    const runtime = successfulGithubRuntime({
      discovery: [response({
        json: { total_count: 2, workflow_runs: [run(), run({ id: 54321 })] },
      })],
    });
    await expectCode(
      () => discoverGithubActionsRun({ config, applicationSha: SHA }, runtime.dependencies),
      'deployment-run-discovery-ambiguous',
    );
  });

  test('rejects wrong workflow name, path, SHA, branch, and event during discovery', async () => {
    for (const changed of [
      { name: 'Other workflow' },
      { path: '.github/workflows/other.yml' },
      { head_sha: 'b'.repeat(40) },
      { head_branch: 'release' },
      { event: 'workflow_dispatch' },
    ]) {
      const runtime = successfulGithubRuntime({
        discovery: [response({ json: { total_count: 1, workflow_runs: [run(changed)] } })],
      });
      await expectCode(
        () => discoverGithubActionsRun({ config, applicationSha: SHA }, runtime.dependencies),
        'deployment-run-identity-mismatch',
      );
    }
  });

  test('never falls back to discovery after an explicit run ID is bound', async () => {
    const runtime = successfulGithubRuntime({ runs: [response({ json: run({ id: 99999 }) })] });
    await expectCode(
      () => monitorGithubActionsDeployment({
        config,
        applicationSha: SHA,
        runId: RUN_ID,
      }, runtime.dependencies),
      'deployment-run-id-mismatch',
    );
    expect(runtime.calls.every((call) => !call.url.includes('/actions/runs?'))).toBe(true);
    expect(runtime.calls[0].url).toContain(`/actions/runs/${RUN_ID}`);
  });

  test('rejects every documented terminal workflow-run failure', async () => {
    for (const conclusion of [
      'action_required',
      'cancelled',
      'failure',
      'neutral',
      'skipped',
      'stale',
      'startup_failure',
      'timed_out',
    ]) {
      const runtime = successfulGithubRuntime({
        runs: [response({ json: run({ conclusion }) })],
      });
      const error = await expectCode(
        () => monitorGithubActionsDeployment({ config, applicationSha: SHA, runId: RUN_ID }, runtime.dependencies),
        'deployment-run-not-successful',
      );
      expect(error.details.conclusion).toBe(conclusion);
    }
  });

  test('rejects wrong, reordered, duplicate, and unsuccessful jobs', async () => {
    const variants = [
      jobs({ entries: jobs().jobs.toReversed() }),
      jobs({ entries: [jobs().jobs[0], { ...jobs().jobs[1], name: 'build' }] }),
      jobs({ entries: [jobs().jobs[0], { ...jobs().jobs[1], head_sha: 'b'.repeat(40) }] }),
    ];
    for (const value of variants) {
      const runtime = successfulGithubRuntime({ jobs: [response({ json: value })] });
      await expectCode(
        () => monitorGithubActionsDeployment({ config, applicationSha: SHA, runId: RUN_ID }, runtime.dependencies),
        'deployment-jobs-identity-mismatch',
      );
    }
    const failed = jobs();
    failed.jobs[0].conclusion = 'failure';
    const runtime = successfulGithubRuntime({ jobs: [response({ json: failed })] });
    await expectCode(
      () => monitorGithubActionsDeployment({ config, applicationSha: SHA, runId: RUN_ID }, runtime.dependencies),
      'deployment-job-not-successful',
    );
  });

  test('requires the exact github-pages deployment and deploy-job environment URL binding', async () => {
    const wrongDeployments = [
      deployment({ sha: 'b'.repeat(40) }),
      deployment({ ref: 'release' }),
      deployment({ environment: 'production' }),
      deployment({ original_environment: 'production' }),
      deployment({ task: 'other' }),
    ];
    for (const value of wrongDeployments) {
      const runtime = successfulGithubRuntime({ deployments: [response({ json: [value] })] });
      await expectCode(
        () => monitorGithubActionsDeployment({ config, applicationSha: SHA, runId: RUN_ID }, runtime.dependencies),
        'deployment-environment-identity-mismatch',
      );
    }

    const wrongJobUrl = successfulGithubRuntime({
      statuses: [response({ json: [deploymentStatus({ target_url: 'https://example.test/job' })] })],
    });
    await expectCode(
      () => monitorGithubActionsDeployment({ config, applicationSha: SHA, runId: RUN_ID }, wrongJobUrl.dependencies),
      'deployment-environment-job-mismatch',
    );

    const wrongEnvironmentUrl = successfulGithubRuntime({
      statuses: [response({ json: [deploymentStatus({ environment_url: 'https://cybersader.github.io/other/' })] })],
    });
    await expectCode(
      () => monitorGithubActionsDeployment({ config, applicationSha: SHA, runId: RUN_ID }, wrongEnvironmentUrl.dependencies),
      'deployment-environment-url-mismatch',
    );
  });

  test('fails terminal deployment statuses and times out boundedly on nonterminal observation', async () => {
    for (const state of ['error', 'failure', 'inactive']) {
      const runtime = successfulGithubRuntime({
        statuses: [response({ json: [deploymentStatus({ state })] })],
      });
      const error = await expectCode(
        () => monitorGithubActionsDeployment({ config, applicationSha: SHA, runId: RUN_ID }, runtime.dependencies),
        'deployment-environment-not-successful',
      );
      expect(error.details.state).toBe(state);
    }

    const runtime = successfulGithubRuntime({
      runs: Array.from({ length: 10 }, () => response({ json: run({ status: 'queued', conclusion: null }) })),
    });
    await expectCode(
      () => monitorGithubActionsDeployment({
        config,
        applicationSha: SHA,
        runId: RUN_ID,
        timeoutMs: 2_000,
      }, runtime.dependencies),
      'deployment-run-monitor-timeout',
    );
    expect(runtime.sleeps).toEqual([1_000, 1_000]);
  });

  test('honors caller abort with the same signal used for observation', async () => {
    const controller = new AbortController();
    controller.abort();
    const runtime = successfulGithubRuntime();
    await expectCode(
      () => discoverGithubActionsRun({
        config,
        applicationSha: SHA,
        signal: controller.signal,
      }, runtime.dependencies),
      'deployment-observation-aborted',
    );
    expect(runtime.calls).toHaveLength(0);
  });
});

describe('exact bounded live confirmation', () => {
  test('confirms one visible replacement, excludes hidden old text, and preserves exact path/query', async () => {
    const html = `<!doctype html><html><head><title>${OLD}</title></head><body>
      <script>${OLD}</script><style>.x{display:none}</style><template>${OLD}</template>
      <p hidden>${OLD}</p><p aria-hidden="true">${OLD}</p><p style="display:none">${OLD}</p>
      <main><p>${NEW}</p></main></body></html>`;
    const runtime = liveRuntime([response({ url: PAGE_URL, body: html })]);
    const result = await confirmLivePage({
      config,
      pageUrl: PAGE_URL,
      oldWitness: OLD,
      newWitness: NEW,
    }, runtime.dependencies);

    expect(result).toMatchObject({
      pageUrl: PAGE_URL,
      finalUrl: PAGE_URL,
      path: '/cyberbase/guide/',
      query: '?view=full',
      oldWitnessAbsent: true,
      newWitnessUnique: true,
      attempts: 1,
      sharedAbortSignal: true,
    });
    expect(runtime.calls[0].options.redirect).toBe('manual');
    expect(runtime.calls[0].options.method).toBe('GET');
  });

  test('retries stale and transient responses, then succeeds under one real deadline signal', async () => {
    const runtime = liveRuntime([
      response({ status: 503, url: PAGE_URL, body: 'unavailable' }),
      response({ url: PAGE_URL, body: `<!doctype html><html><body><p>${OLD}</p></body></html>` }),
      response({ url: PAGE_URL, body: `<!doctype html><html><body><p>${NEW}</p></body></html>` }),
    ]);
    const result = await confirmLivePage({
      config,
      pageUrl: PAGE_URL,
      oldWitness: OLD,
      newWitness: NEW,
    }, runtime.dependencies);

    expect(result.attempts).toBe(3);
    expect(runtime.sleeps).toEqual([1_000, 1_000]);
    expect(new Set(runtime.calls.map((call) => call.options.signal)).size).toBe(1);
    expect(runtime.timers).toHaveLength(1);
    expect(runtime.timers[0].cleared).toBe(true);
  });

  test('times out boundedly when the replacement stays absent or non-unique', async () => {
    for (const body of [
      `<!doctype html><html><body><p>${OLD}</p></body></html>`,
      `<!doctype html><html><body><p>${NEW}</p><p>${NEW}</p></body></html>`,
      `<!doctype html><html><body><p hidden>${NEW}</p></body></html>`,
    ]) {
      const runtime = liveRuntime(Array.from({ length: 4 }, () => response({ url: PAGE_URL, body })));
      const error = await expectCode(
        () => confirmLivePage({
          config,
          pageUrl: PAGE_URL,
          oldWitness: OLD,
          newWitness: NEW,
          timeoutMs: 2_000,
        }, runtime.dependencies),
        'live-confirm-timeout',
      );
      expect(error.details.lastObservation.newWitnessCount).not.toBe(1);
      expect(runtime.sleeps).toEqual([1_000, 1_000]);
    }
  });

  test('rejects redirects and any final origin, path, or query drift', async () => {
    for (const page of [
      response({ status: 302, url: PAGE_URL, headers: { Location: PAGE_URL } }),
      response({ url: 'https://example.test/cyberbase/guide/?view=full', body: `<html><body>${NEW}</body></html>` }),
      response({ url: 'https://cybersader.github.io/cyberbase/other/?view=full', body: `<html><body>${NEW}</body></html>` }),
      response({ url: 'https://cybersader.github.io/cyberbase/guide/?view=compact', body: `<html><body>${NEW}</body></html>` }),
    ]) {
      const runtime = liveRuntime([page]);
      const code = page.status === 302 ? 'live-redirect-rejected' : 'live-final-url-mismatch';
      await expectCode(
        () => confirmLivePage({ config, pageUrl: PAGE_URL, oldWitness: OLD, newWitness: NEW }, runtime.dependencies),
        code,
      );
    }
  });

  test('rejects non-HTML and oversized bodies before witness inspection', async () => {
    const wrongType = liveRuntime([response({
      url: PAGE_URL,
      body: JSON.stringify({ text: NEW }),
      headers: { 'Content-Type': 'application/json' },
    })]);
    await expectCode(
      () => confirmLivePage({ config, pageUrl: PAGE_URL, oldWitness: OLD, newWitness: NEW }, wrongType.dependencies),
      'live-content-type-mismatch',
    );

    const oversized = liveRuntime([response({
      url: PAGE_URL,
      body: `<html><body>${NEW}${'x'.repeat(100)}</body></html>`,
    })]);
    await expectCode(
      () => confirmLivePage({
        config,
        pageUrl: PAGE_URL,
        oldWitness: OLD,
        newWitness: NEW,
        maxBytes: 32,
      }, oversized.dependencies),
      'live-response-too-large',
    );
  });

  test('honors caller abort and deadline timer aborts without starting a second deadline', async () => {
    const caller = new AbortController();
    caller.abort();
    const preAborted = liveRuntime([]);
    await expectCode(
      () => confirmLivePage({
        config,
        pageUrl: PAGE_URL,
        oldWitness: OLD,
        newWitness: NEW,
        signal: caller.signal,
      }, preAborted.dependencies),
      'live-confirm-aborted',
    );
    expect(preAborted.calls).toHaveLength(0);

    let timerCallback;
    const timed = fakeRuntime(async () => {
      timerCallback();
      throw new DOMException('Aborted', 'AbortError');
    });
    timed.dependencies.setTimer = (callback) => {
      timerCallback = callback;
      return callback;
    };
    timed.dependencies.clearTimer = () => {};
    await expectCode(
      () => confirmLivePage({ config, pageUrl: PAGE_URL, oldWitness: OLD, newWitness: NEW }, timed.dependencies),
      'live-confirm-timeout',
    );
    expect(timed.calls).toHaveLength(1);
  });

  test('rejects a target outside the configured HTTPS origin/base and overlapping witnesses', async () => {
    const runtime = liveRuntime([]);
    await expectCode(
      () => confirmLivePage({
        config,
        pageUrl: 'https://example.test/cyberbase/guide/',
        oldWitness: OLD,
        newWitness: NEW,
      }, runtime.dependencies),
      'live-url-outside-configured-base',
    );
    await expectCode(
      () => confirmLivePage({
        config,
        pageUrl: PAGE_URL,
        oldWitness: 'sentence',
        newWitness: 'corrected sentence',
      }, runtime.dependencies),
      'invalid-live-witnesses',
    );
  });
});
