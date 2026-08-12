import { fail, OwnerAlphaError } from '../errors.js';

export const GITHUB_JSON_MAX_BYTES = 2 * 1024 * 1024;
export const GITHUB_API_VERSION = '2022-11-28';

const SHA_RE = /^[0-9a-f]{40}$/u;
const ID_RE = /^[1-9][0-9]*$/u;
const NONTERMINAL_STATES = new Set(['queued', 'in_progress', 'pending', 'waiting', 'requested']);
const TERMINAL_FAILURES = new Set([
  'action_required',
  'cancelled',
  'failure',
  'neutral',
  'skipped',
  'stale',
  'startup_failure',
  'timed_out',
]);
const DEPLOYMENT_PENDING_STATES = new Set(['created', 'queued', 'pending', 'in_progress']);
const DEPLOYMENT_FAILURE_STATES = new Set(['error', 'failure', 'inactive']);

function exactSha(value) {
  if (typeof value !== 'string' || !SHA_RE.test(value)) {
    fail('invalid-application-sha', 'applicationSha must be one lowercase 40-character Git object ID');
  }
  return value;
}

function exactId(value, location = 'runId') {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !ID_RE.test(text)) {
    fail('invalid-deployment-run-id', `${location} must be one explicit positive decimal ID`);
  }
  return text;
}

function exactPositiveInteger(value, location) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('invalid-deployment-input', `${location} must be a positive safe integer`);
  }
  return value;
}

function validateConfig(config) {
  const workflow = config?.workflow;
  const live = config?.live;
  const limits = config?.limits;
  if (workflow?.provider !== 'github-actions'
    || typeof workflow.repository !== 'string'
    || !/^[^/\s]+\/[^/\s]+$/u.test(workflow.repository)
    || typeof workflow.name !== 'string'
    || typeof workflow.path !== 'string'
    || workflow.event !== 'push'
    || typeof workflow.branch !== 'string'
    || !Array.isArray(workflow.jobs)
    || workflow.jobs.length === 0
    || new Set(workflow.jobs).size !== workflow.jobs.length
    || workflow.jobs.some((name) => typeof name !== 'string' || name.length === 0)
    || workflow.jobs.filter((name) => name === 'deploy').length !== 1
    || workflow.environment !== 'github-pages'
    || typeof live?.baseUrl !== 'string'
    || !Number.isSafeInteger(limits?.networkTimeoutMs)
    || limits.networkTimeoutMs < 1
    || !Number.isSafeInteger(limits?.requestTimeoutMs)
    || limits.requestTimeoutMs < 1) {
    fail('invalid-deployment-config', 'deployment verification requires one validated GitHub Actions owner-alpha config');
  }
  let environmentUrl;
  try {
    environmentUrl = new URL(live.baseUrl);
  } catch {
    fail('invalid-deployment-config', 'config.live.baseUrl must be an exact HTTPS URL');
  }
  if (environmentUrl.protocol !== 'https:'
    || environmentUrl.username
    || environmentUrl.password
    || environmentUrl.search
    || environmentUrl.hash) {
    fail('invalid-deployment-config', 'config.live.baseUrl must be an exact credential-free HTTPS URL');
  }
  const [owner, repository] = workflow.repository.split('/');
  return { workflow, limits, owner, repository, environmentUrl };
}

function mergeDependencies(config, overrides = {}) {
  const dependencies = {
    fetch: globalThis.fetch,
    clock: Date.now,
    sleep: (milliseconds, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }
      const finish = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      const timer = setTimeout(finish, milliseconds);
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    retryIntervalMs: config.limits.requestTimeoutMs,
    ...overrides,
  };
  if (typeof dependencies.fetch !== 'function'
    || typeof dependencies.clock !== 'function'
    || typeof dependencies.sleep !== 'function'
    || typeof dependencies.setTimer !== 'function'
    || typeof dependencies.clearTimer !== 'function'
    || !Number.isSafeInteger(dependencies.retryIntervalMs)
    || dependencies.retryIntervalMs < 1) {
    fail('invalid-deployment-dependencies', 'fetch, clock, sleep, timer, and retry interval seams are required');
  }
  return dependencies;
}

function createDeadline(timeoutMs, externalSignal, dependencies) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    fail('invalid-deployment-timeout', 'timeoutMs must be a positive safe integer');
  }
  const startedAt = dependencies.clock();
  if (!Number.isFinite(startedAt)) fail('invalid-clock', 'injected clock must return finite epoch milliseconds');
  const controller = new AbortController();
  const state = {
    kind: null,
    startedAt,
    deadlineAt: startedAt + timeoutMs,
    maximumPauses: Math.ceil(timeoutMs / dependencies.retryIntervalMs),
    pauses: 0,
  };
  const abort = (kind, reason) => {
    if (controller.signal.aborted) return;
    state.kind = kind;
    controller.abort(reason);
  };
  const onExternalAbort = () => abort('external', externalSignal.reason);
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true });
  const timer = dependencies.setTimer(
    () => abort('deadline', new DOMException('Verification deadline expired', 'TimeoutError')),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    state,
    remaining() {
      const now = dependencies.clock();
      if (!Number.isFinite(now)) fail('invalid-clock', 'injected clock must return finite epoch milliseconds');
      return Math.max(0, state.deadlineAt - now);
    },
    async pause() {
      const remaining = this.remaining();
      if (controller.signal.aborted || remaining <= 0 || state.pauses >= state.maximumPauses) return false;
      state.pauses += 1;
      try {
        await dependencies.sleep(Math.min(dependencies.retryIntervalMs, remaining), controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      }
      return !controller.signal.aborted && this.remaining() > 0;
    },
    close() {
      dependencies.clearTimer(timer);
      externalSignal?.removeEventListener?.('abort', onExternalAbort);
    },
  };
}

function throwAbort(deadline, timeoutCode, timeoutMessage) {
  if (!deadline.signal.aborted) return;
  if (deadline.state.kind === 'external') {
    fail('deployment-observation-aborted', 'deployment observation was aborted by its caller');
  }
  fail(timeoutCode, timeoutMessage);
}

function githubHeaders() {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'cyberbaser-owner-alpha',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
}

function statusOf(response) {
  return Number.isSafeInteger(response?.status) ? response.status : 0;
}

async function readBoundedBody(response, maxBytes, tooLargeCode) {
  const declared = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    fail(tooLargeCode, 'GitHub response exceeded the bounded JSON body limit', { maxBytes });
  }
  if (!response?.body || typeof response.body.getReader !== 'function') {
    fail('github-response-body-unavailable', 'GitHub response must expose a readable body stream');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        fail(tooLargeCode, 'GitHub response exceeded the bounded JSON body limit', { maxBytes });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function fetchJson(endpoint, deadline, dependencies, { timeoutCode, tooLargeCode }) {
  throwAbort(deadline, timeoutCode, 'the deployment observation deadline expired');
  let response;
  try {
    response = await dependencies.fetch(endpoint, {
      method: 'GET',
      headers: githubHeaders(),
      redirect: 'error',
      signal: deadline.signal,
    });
  } catch (error) {
    throwAbort(deadline, timeoutCode, 'the deployment observation deadline expired during a request');
    throw error;
  }
  const status = statusOf(response);
  if (status !== 200) return { status, value: null };
  let bytes;
  try {
    bytes = await readBoundedBody(response, GITHUB_JSON_MAX_BYTES, tooLargeCode);
  } catch (error) {
    throwAbort(deadline, timeoutCode, 'the deployment observation deadline expired while reading a response');
    throw error;
  }
  try {
    return { status, value: JSON.parse(bytes.toString('utf8')) };
  } catch {
    fail('github-invalid-json', 'GitHub returned invalid JSON');
  }
}

function shouldRetryStatus(status) {
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
}

async function retryOrFail(deadline, code, message, details = {}) {
  if (await deadline.pause()) return true;
  throwAbort(deadline, code, message);
  fail(code, message, details);
}

function normalizeRun(run) {
  return {
    runId: String(run?.id ?? ''),
    workflowId: String(run?.workflow_id ?? ''),
    runAttempt: run?.run_attempt,
    name: run?.name,
    path: run?.path,
    event: run?.event,
    headBranch: run?.head_branch,
    headSha: run?.head_sha,
    status: run?.status,
    conclusion: run?.conclusion ?? null,
    htmlUrl: run?.html_url,
  };
}

function assertRunIdentity(run, expected, { requireAttempt = true } = {}) {
  const normalized = normalizeRun(run);
  if (!ID_RE.test(normalized.runId)
    || !ID_RE.test(normalized.workflowId)
    || (requireAttempt && (!Number.isSafeInteger(normalized.runAttempt) || normalized.runAttempt < 1))
    || normalized.name !== expected.workflow.name
    || normalized.path !== expected.workflow.path
    || normalized.event !== expected.workflow.event
    || normalized.headBranch !== expected.workflow.branch
    || normalized.headSha !== expected.applicationSha
    || typeof normalized.htmlUrl !== 'string'
    || normalized.htmlUrl.length === 0) {
    fail('deployment-run-identity-mismatch', 'GitHub Actions run does not match the exact configured workflow, SHA, branch, and event');
  }
  if (expected.runId && normalized.runId !== expected.runId) {
    fail('deployment-run-id-mismatch', 'GitHub Actions response changed the explicitly bound run ID');
  }
  if (expected.runAttempt && normalized.runAttempt !== expected.runAttempt) {
    fail('deployment-run-attempt-mismatch', 'GitHub Actions response changed the explicitly bound run attempt');
  }
  return normalized;
}

function frozenBinding(run, repository) {
  return Object.freeze({
    provider: 'github-actions',
    repository,
    runId: run.runId,
    workflowId: run.workflowId,
    runAttempt: run.runAttempt,
    name: run.name,
    path: run.path,
    event: run.event,
    headBranch: run.headBranch,
    headSha: run.headSha,
    htmlUrl: run.htmlUrl,
  });
}

async function discoverWithDeadline({ config, applicationSha }, expected, deadline, dependencies) {
  const query = new URLSearchParams({
    head_sha: applicationSha,
    branch: expected.workflow.branch,
    event: expected.workflow.event,
    per_page: '100',
  });
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(expected.owner)}/${encodeURIComponent(expected.repository)}/actions/runs?${query}`;
  let attempts = 0;
  while (true) {
    attempts += 1;
    let fetched;
    try {
      fetched = await fetchJson(endpoint, deadline, dependencies, {
        timeoutCode: 'deployment-run-discovery-timeout',
        tooLargeCode: 'deployment-run-discovery-response-too-large',
      });
    } catch (error) {
      if (error instanceof OwnerAlphaError) throw error;
      if (await retryOrFail(deadline, 'deployment-run-discovery-timeout', 'GitHub Actions run discovery did not complete before the deadline', { attempts })) continue;
    }
    if (fetched.status !== 200) {
      if (!shouldRetryStatus(fetched.status)) {
        fail('deployment-run-discovery-unavailable', 'GitHub Actions run discovery did not return HTTP 200', { status: fetched.status });
      }
      if (await retryOrFail(deadline, 'deployment-run-discovery-timeout', 'GitHub Actions run discovery did not complete before the deadline', { attempts, status: fetched.status })) continue;
    }
    const value = fetched.value;
    if (!Number.isSafeInteger(value?.total_count)
      || value.total_count < 0
      || value.total_count > 100
      || !Array.isArray(value.workflow_runs)
      || value.workflow_runs.length !== value.total_count) {
      fail('deployment-run-discovery-invalid-response', 'GitHub run discovery must return one complete bounded result set');
    }
    const normalized = value.workflow_runs.map((run) => normalizeRun(run));
    if (new Set(normalized.map((run) => run.runId)).size !== normalized.length) {
      fail('deployment-run-discovery-ambiguous', 'GitHub run discovery returned duplicate run identities');
    }
    const matches = [];
    for (const run of value.workflow_runs) {
      const candidate = normalizeRun(run);
      if (candidate.name === expected.workflow.name
        && candidate.path === expected.workflow.path
        && candidate.event === expected.workflow.event
        && candidate.headBranch === expected.workflow.branch
        && candidate.headSha === applicationSha) {
        matches.push(assertRunIdentity(run, { ...expected, applicationSha }));
      }
    }
    if (matches.length > 1) {
      fail('deployment-run-discovery-ambiguous', 'more than one GitHub Actions run matched the exact application SHA and configured workflow');
    }
    if (matches.length === 1) {
      return Object.freeze({
        binding: frozenBinding(matches[0], expected.workflow.repository),
        endpoint,
        attempts,
      });
    }
    if (value.workflow_runs.length > 0) {
      fail('deployment-run-identity-mismatch', 'discovered GitHub Actions runs did not match the exact configured workflow, SHA, branch, and event');
    }
    if (await retryOrFail(deadline, 'deployment-run-discovery-timeout', 'no exact GitHub Actions run appeared before the deadline', { attempts })) continue;
  }
}

function runTerminalState(run) {
  if (run.status === 'completed') {
    if (run.conclusion === 'success') return 'success';
    if (TERMINAL_FAILURES.has(run.conclusion)) return run.conclusion;
    return 'unknown-terminal';
  }
  if (run.status === 'success') return 'success';
  if (TERMINAL_FAILURES.has(run.status)) return run.status;
  if (NONTERMINAL_STATES.has(run.status)) return null;
  return 'invalid-status';
}

function normalizeJobs(value, expected, boundRun) {
  if (!Number.isSafeInteger(value?.total_count)
    || value.total_count !== expected.workflow.jobs.length
    || !Array.isArray(value.jobs)
    || value.jobs.length !== value.total_count) {
    fail('deployment-jobs-identity-mismatch', 'the bound run must contain exactly the configured ordered jobs');
  }
  const jobs = value.jobs.map((job) => ({
    id: String(job?.id ?? ''),
    name: job?.name,
    runId: String(job?.run_id ?? ''),
    runAttempt: job?.run_attempt,
    workflowName: job?.workflow_name,
    headBranch: job?.head_branch,
    headSha: job?.head_sha,
    status: job?.status,
    conclusion: job?.conclusion ?? null,
    htmlUrl: job?.html_url,
  }));
  if (new Set(jobs.map((job) => job.name)).size !== jobs.length
    || jobs.some((job, index) => job.name !== expected.workflow.jobs[index])
    || jobs.some((job) => !ID_RE.test(job.id)
      || job.runId !== boundRun.runId
      || job.runAttempt !== boundRun.runAttempt
      || job.workflowName !== expected.workflow.name
      || job.headBranch !== expected.workflow.branch
      || job.headSha !== boundRun.headSha
      || typeof job.htmlUrl !== 'string'
      || job.htmlUrl.length === 0)) {
    fail('deployment-jobs-identity-mismatch', 'jobs must be unique, ordered, and bound to the exact configured workflow run');
  }
  return jobs;
}

function jobTerminalState(job) {
  if (job.status === 'completed') {
    if (job.conclusion === 'success') return 'success';
    if (TERMINAL_FAILURES.has(job.conclusion)) return job.conclusion;
    return 'unknown-terminal';
  }
  if (job.status === 'success') return 'success';
  if (TERMINAL_FAILURES.has(job.status)) return job.status;
  if (NONTERMINAL_STATES.has(job.status)) return null;
  return 'invalid-status';
}

async function fetchSuccessfulJobs(expected, boundRun, deadline, dependencies) {
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(expected.owner)}/${encodeURIComponent(expected.repository)}/actions/runs/${boundRun.runId}/jobs?per_page=100`;
  const fetched = await fetchJson(endpoint, deadline, dependencies, {
    timeoutCode: 'deployment-jobs-timeout',
    tooLargeCode: 'deployment-jobs-response-too-large',
  });
  if (fetched.status !== 200) {
    if (shouldRetryStatus(fetched.status)) return null;
    fail('deployment-jobs-unavailable', 'GitHub Actions jobs endpoint did not return HTTP 200', { status: fetched.status });
  }
  const jobs = normalizeJobs(fetched.value, expected, boundRun);
  for (const job of jobs) {
    const terminal = jobTerminalState(job);
    if (terminal && terminal !== 'success') {
      fail('deployment-job-not-successful', 'a configured job reached a terminal non-success state', { job: job.name, conclusion: terminal });
    }
  }
  if (!jobs.every((job) => jobTerminalState(job) === 'success')) return null;
  return { endpoint, jobs, deployJob: jobs.find((job) => job.name === 'deploy') };
}

function exactEnvironmentUrl(value, expected) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('deployment-environment-url-mismatch', 'GitHub Pages environment_url must be an exact HTTPS URL');
  }
  if (url.protocol !== 'https:'
    || url.username
    || url.password
    || url.hash
    || url.href !== expected.environmentUrl.href) {
    fail('deployment-environment-url-mismatch', 'GitHub Pages environment_url must exactly match config.live.baseUrl');
  }
  return url.href;
}

async function fetchSuccessfulEnvironment(expected, boundRun, deployJob, deadline, dependencies) {
  const query = new URLSearchParams({
    sha: boundRun.headSha,
    environment: expected.workflow.environment,
    per_page: '100',
  });
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(expected.owner)}/${encodeURIComponent(expected.repository)}/deployments?${query}`;
  const fetched = await fetchJson(endpoint, deadline, dependencies, {
    timeoutCode: 'deployment-environment-timeout',
    tooLargeCode: 'deployment-environment-response-too-large',
  });
  if (fetched.status !== 200) {
    if (shouldRetryStatus(fetched.status)) return null;
    fail('deployment-environment-unavailable', 'GitHub deployments endpoint did not return HTTP 200', { status: fetched.status });
  }
  if (!Array.isArray(fetched.value) || fetched.value.length > 100) {
    fail('deployment-environment-invalid-response', 'GitHub deployments must be one bounded array');
  }
  const candidates = fetched.value.filter((deployment) => deployment?.sha === boundRun.headSha
    && deployment?.ref === expected.workflow.branch
    && deployment?.task === 'deploy'
    && deployment?.environment === expected.workflow.environment
    && deployment?.original_environment === expected.workflow.environment
    && deployment?.performed_via_github_app?.slug === 'github-actions'
    && ID_RE.test(String(deployment?.id ?? '')));
  if (candidates.length > 1) {
    fail('deployment-environment-ambiguous', 'more than one GitHub Pages deployment matched the bound run');
  }
  if (candidates.length === 0) {
    if (fetched.value.length > 0) {
      fail('deployment-environment-identity-mismatch', 'GitHub deployment did not match the exact SHA, branch, task, and configured environment');
    }
    return null;
  }
  const deployment = candidates[0];
  const statusesEndpoint = `https://api.github.com/repos/${encodeURIComponent(expected.owner)}/${encodeURIComponent(expected.repository)}/deployments/${deployment.id}/statuses?per_page=100`;
  const statusesFetched = await fetchJson(statusesEndpoint, deadline, dependencies, {
    timeoutCode: 'deployment-environment-timeout',
    tooLargeCode: 'deployment-status-response-too-large',
  });
  if (statusesFetched.status !== 200) {
    if (shouldRetryStatus(statusesFetched.status)) return null;
    fail('deployment-status-unavailable', 'GitHub deployment statuses endpoint did not return HTTP 200', { status: statusesFetched.status });
  }
  const statuses = statusesFetched.value;
  if (!Array.isArray(statuses) || statuses.length < 1 || statuses.length > 100) {
    fail('deployment-status-invalid-response', 'GitHub deployment statuses must be one non-empty bounded array');
  }
  const latest = statuses[0];
  if (DEPLOYMENT_FAILURE_STATES.has(latest?.state)) {
    fail('deployment-environment-not-successful', 'GitHub Pages deployment reached a terminal non-success state', { state: latest.state });
  }
  if (DEPLOYMENT_PENDING_STATES.has(latest?.state)) return null;
  if (latest?.state !== 'success') {
    fail('deployment-status-invalid-state', 'GitHub deployment returned an unsupported state', { state: latest?.state });
  }
  if (latest.environment !== expected.workflow.environment
    || latest.target_url !== deployJob.htmlUrl
    || latest.log_url !== deployJob.htmlUrl) {
    fail('deployment-environment-job-mismatch', 'GitHub Pages deployment status must be tied to the exact deploy job URL');
  }
  const environmentUrl = exactEnvironmentUrl(latest.environment_url, expected);
  return Object.freeze({
    deploymentId: String(deployment.id),
    environment: deployment.environment,
    state: latest.state,
    environmentUrl,
    deploymentJobId: deployJob.id,
    deploymentJobUrl: deployJob.htmlUrl,
    runId: boundRun.runId,
    apiUrl: endpoint,
    statusesApiUrl: statusesEndpoint,
  });
}

async function monitorWithDeadline({ applicationSha, boundRun, runId }, expected, deadline, dependencies) {
  const explicitRunId = exactId(boundRun?.runId ?? runId);
  if (boundRun?.headSha && boundRun.headSha !== applicationSha) {
    fail('deployment-run-head-mismatch', 'bound run SHA must exactly equal applicationSha');
  }
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(expected.owner)}/${encodeURIComponent(expected.repository)}/actions/runs/${explicitRunId}`;
  let attempts = 0;
  while (true) {
    attempts += 1;
    let fetched;
    try {
      fetched = await fetchJson(endpoint, deadline, dependencies, {
        timeoutCode: 'deployment-run-monitor-timeout',
        tooLargeCode: 'deployment-run-response-too-large',
      });
    } catch (error) {
      if (error instanceof OwnerAlphaError) throw error;
      if (await retryOrFail(deadline, 'deployment-run-monitor-timeout', 'the bound GitHub Actions run was not verified before the deadline', { attempts })) continue;
    }
    if (fetched.status !== 200) {
      if (!shouldRetryStatus(fetched.status)) {
        fail('deployment-run-unavailable', 'the explicitly bound GitHub Actions run did not return HTTP 200', { status: fetched.status });
      }
      if (await retryOrFail(deadline, 'deployment-run-monitor-timeout', 'the bound GitHub Actions run was not verified before the deadline', { attempts, status: fetched.status })) continue;
    }
    const run = assertRunIdentity(fetched.value, {
      ...expected,
      applicationSha,
      runId: explicitRunId,
      runAttempt: boundRun?.runAttempt,
    });
    const terminal = runTerminalState(run);
    if (terminal && terminal !== 'success') {
      fail('deployment-run-not-successful', 'the bound GitHub Actions run reached a terminal non-success state', { conclusion: terminal });
    }
    if (terminal !== 'success') {
      if (await retryOrFail(deadline, 'deployment-run-monitor-timeout', 'the bound GitHub Actions run did not complete successfully before the deadline', { attempts, status: run.status })) continue;
    }
    const stableRun = frozenBinding(run, expected.workflow.repository);
    let jobResult;
    try {
      jobResult = await fetchSuccessfulJobs(expected, stableRun, deadline, dependencies);
    } catch (error) {
      if (error instanceof OwnerAlphaError) throw error;
      jobResult = null;
    }
    if (!jobResult) {
      if (await retryOrFail(deadline, 'deployment-jobs-timeout', 'the exact configured jobs did not complete successfully before the deadline', { attempts })) continue;
    }
    let environment;
    try {
      environment = await fetchSuccessfulEnvironment(expected, stableRun, jobResult.deployJob, deadline, dependencies);
    } catch (error) {
      if (error instanceof OwnerAlphaError) throw error;
      environment = null;
    }
    if (!environment) {
      if (await retryOrFail(deadline, 'deployment-environment-timeout', 'the successful GitHub Pages deployment did not appear before the deadline', { attempts })) continue;
    }
    return Object.freeze({
      provider: 'github-actions',
      repository: expected.workflow.repository,
      run: stableRun,
      runApiUrl: endpoint,
      jobs: Object.freeze({
        apiUrl: jobResult.endpoint,
        names: Object.freeze(jobResult.jobs.map((job) => job.name)),
        entries: Object.freeze(jobResult.jobs.map((job) => Object.freeze({ ...job }))),
      }),
      environment,
      attempts,
    });
  }
}

export async function discoverGithubActionsRun(
  { config, applicationSha, timeoutMs, signal } = {},
  dependencyOverrides = {},
) {
  const expected = validateConfig(config);
  const sha = exactSha(applicationSha);
  const dependencies = mergeDependencies(expected, dependencyOverrides);
  const deadline = createDeadline(timeoutMs ?? expected.limits.networkTimeoutMs, signal, dependencies);
  try {
    throwAbort(deadline, 'deployment-run-discovery-timeout', 'GitHub Actions run discovery deadline expired');
    return await discoverWithDeadline({ config, applicationSha: sha }, expected, deadline, dependencies);
  } finally {
    deadline.close();
  }
}

export async function monitorGithubActionsDeployment(
  { config, applicationSha, boundRun, runId, timeoutMs, signal } = {},
  dependencyOverrides = {},
) {
  const expected = validateConfig(config);
  const sha = exactSha(applicationSha);
  const dependencies = mergeDependencies(expected, dependencyOverrides);
  const deadline = createDeadline(timeoutMs ?? expected.limits.networkTimeoutMs, signal, dependencies);
  try {
    throwAbort(deadline, 'deployment-run-monitor-timeout', 'GitHub Actions monitoring deadline expired');
    return await monitorWithDeadline({ applicationSha: sha, boundRun, runId }, expected, deadline, dependencies);
  } finally {
    deadline.close();
  }
}

export async function verifyGithubActionsDeployment(
  { config, applicationSha, timeoutMs, signal } = {},
  dependencyOverrides = {},
) {
  const expected = validateConfig(config);
  const sha = exactSha(applicationSha);
  const dependencies = mergeDependencies(expected, dependencyOverrides);
  const deadline = createDeadline(timeoutMs ?? expected.limits.networkTimeoutMs, signal, dependencies);
  try {
    throwAbort(deadline, 'deployment-run-discovery-timeout', 'GitHub Actions verification deadline expired');
    const discovery = await discoverWithDeadline({ config, applicationSha: sha }, expected, deadline, dependencies);
    const deployment = await monitorWithDeadline({
      applicationSha: sha,
      boundRun: discovery.binding,
    }, expected, deadline, dependencies);
    return Object.freeze({ discovery, deployment });
  } finally {
    deadline.close();
  }
}

export const discoverDeploymentRun = discoverGithubActionsRun;
export const monitorDeploymentRun = monitorGithubActionsDeployment;
