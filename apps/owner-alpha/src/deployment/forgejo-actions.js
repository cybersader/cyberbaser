import path from 'node:path';
import { fail, OwnerAlphaError } from '../errors.js';
import { deepFreeze, isPlainObject } from '../json.js';

export const FORGEJO_JSON_MAX_BYTES = 2 * 1024 * 1024;
export const FORGEJO_SUPPORTED_MAJOR = 16;

const SHA_RE = /^[0-9a-f]{40}$/u;
const ID_RE = /^[1-9][0-9]*$/u;
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u;
const NONTERMINAL_STATES = new Set(['unknown', 'waiting', 'running', 'blocked']);
const TERMINAL_FAILURES = new Set(['failure', 'cancelled', 'skipped']);
const RETRYABLE_HTTP = new Set([408, 425, 429]);

function exactSha(value) {
  if (typeof value !== 'string' || !SHA_RE.test(value)) {
    fail('invalid-application-sha', 'applicationSha must be one lowercase 40-character Git object ID');
  }
  return value;
}

function exactId(value, location, code = 'invalid-deployment-input') {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !ID_RE.test(text)) {
    fail(code, `${location} must be one explicit positive decimal ID`);
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
  const limits = config?.limits;
  const live = config?.live;
  if (workflow?.provider !== 'forgejo-actions'
    || typeof workflow.apiBaseUrl !== 'string'
    || typeof workflow.repository !== 'string'
    || !/^[^/\s]+\/[^/\s]+$/u.test(workflow.repository)
    || typeof workflow.path !== 'string'
    || workflow.event !== 'push'
    || typeof workflow.branch !== 'string'
    || !Array.isArray(workflow.jobs)
    || workflow.jobs.length === 0
    || new Set(workflow.jobs).size !== workflow.jobs.length
    || workflow.jobs.some((name) => typeof name !== 'string' || name.length === 0)
    || typeof workflow.deploymentJob !== 'string'
    || workflow.jobs.filter((name) => name === workflow.deploymentJob).length !== 1
    || typeof live?.baseUrl !== 'string'
    || !Number.isSafeInteger(limits?.networkTimeoutMs)
    || limits.networkTimeoutMs < 1
    || !Number.isSafeInteger(limits?.requestTimeoutMs)
    || limits.requestTimeoutMs < 1) {
    fail('invalid-deployment-config', 'deployment verification requires one validated Forgejo Actions owner-alpha config');
  }
  let apiBaseUrl;
  let destinationUrl;
  try {
    apiBaseUrl = new URL(workflow.apiBaseUrl);
    destinationUrl = new URL(live.baseUrl);
  } catch {
    fail('invalid-deployment-config', 'Forgejo API and live base URLs must be exact HTTPS URLs');
  }
  if (apiBaseUrl.protocol !== 'https:'
    || apiBaseUrl.username
    || apiBaseUrl.password
    || apiBaseUrl.search
    || apiBaseUrl.hash
    || apiBaseUrl.pathname !== '/api/v1'
    || apiBaseUrl.toString() !== workflow.apiBaseUrl
    || destinationUrl.protocol !== 'https:'
    || destinationUrl.username
    || destinationUrl.password
    // A self-hosted Forgejo publication may sit on a non-default port; the
    // canonical toString() check below still rejects an explicit :443.
    || destinationUrl.search
    || destinationUrl.hash
    || !destinationUrl.pathname.endsWith('/')
    || destinationUrl.toString() !== live.baseUrl) {
    fail('invalid-deployment-config', 'Forgejo API and live base URLs must be canonical credential-free HTTPS URLs');
  }
  const [owner, repository] = workflow.repository.split('/');
  return deepFreeze({ workflow, limits, owner, repository, apiBaseUrl, destinationUrl });
}

function mergeDependencies(expected, overrides = {}) {
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
    retryIntervalMs: expected.limits.requestTimeoutMs,
    getForgejoObserverToken: null,
    ...overrides,
  };
  if (typeof dependencies.fetch !== 'function'
    || typeof dependencies.clock !== 'function'
    || typeof dependencies.sleep !== 'function'
    || typeof dependencies.setTimer !== 'function'
    || typeof dependencies.clearTimer !== 'function'
    || !Number.isSafeInteger(dependencies.retryIntervalMs)
    || dependencies.retryIntervalMs < 1
    || (dependencies.getForgejoObserverToken !== null
      && typeof dependencies.getForgejoObserverToken !== 'function')) {
    fail('invalid-deployment-dependencies', 'Forgejo fetch, clock, sleep, timer, retry interval, and optional token callback seams are invalid');
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
    () => abort('deadline', new DOMException('Observation deadline expired', 'TimeoutError')),
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

function shouldRetryStatus(status) {
  return status === 0 || RETRYABLE_HTTP.has(status) || status >= 500;
}

function isRedirectFetchError(error) {
  let current = error;
  for (let depth = 0; current && depth < 3; depth += 1) {
    const code = typeof current.code === 'string' ? current.code : '';
    const message = typeof current.message === 'string' ? current.message : '';
    if (/redirect/iu.test(code) || /redirect/iu.test(message)) return true;
    current = current.cause;
  }
  return false;
}

async function retryOrFail(deadline, code, message, details = {}) {
  if (await deadline.pause()) return true;
  throwAbort(deadline, code, message);
  fail(code, message, details);
}

function assertEndpoint(endpoint, expected) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    fail('forgejo-endpoint-invalid', 'Forgejo request endpoint is invalid');
  }
  if (url.origin !== expected.apiBaseUrl.origin || url.username || url.password) {
    fail('forgejo-endpoint-origin-mismatch', 'Forgejo request endpoint must remain on the configured API origin');
  }
  return url;
}

function awaitWithSignal(value, signal) {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function requestHeaders(dependencies, signal) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': 'cyberbaser-owner-alpha',
  };
  if (dependencies.getForgejoObserverToken !== null) {
    const token = await awaitWithSignal(dependencies.getForgejoObserverToken(), signal);
    if (token !== null) {
      if (typeof token !== 'string'
        || !/^[A-Za-z0-9._~+\/-]+={0,2}$/u.test(token)) {
        fail('forgejo-observer-token-invalid', 'Forgejo observer token callback returned an invalid token');
      }
      headers.Authorization = `Bearer ${token}`;
    }
  }
  return headers;
}

async function readBoundedBody(response, tooLargeCode) {
  const declared = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > FORGEJO_JSON_MAX_BYTES) {
    fail(tooLargeCode, 'Forgejo response exceeded the bounded JSON body limit', {
      maxBytes: FORGEJO_JSON_MAX_BYTES,
    });
  }
  if (!response?.body || typeof response.body.getReader !== 'function') {
    fail('forgejo-response-body-unavailable', 'Forgejo response must expose a readable body stream');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > FORGEJO_JSON_MAX_BYTES) {
        await reader.cancel();
        fail(tooLargeCode, 'Forgejo response exceeded the bounded JSON body limit', {
          maxBytes: FORGEJO_JSON_MAX_BYTES,
        });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function fetchJson(endpoint, expected, deadline, dependencies, { timeoutCode, tooLargeCode }) {
  throwAbort(deadline, timeoutCode, 'the Forgejo observation deadline expired');
  const url = assertEndpoint(endpoint, expected);
  let response;
  try {
    response = await dependencies.fetch(url.toString(), {
      method: 'GET',
      headers: await requestHeaders(dependencies, deadline.signal),
      redirect: 'error',
      signal: deadline.signal,
    });
  } catch (error) {
    throwAbort(deadline, timeoutCode, 'the Forgejo observation deadline expired during a request');
    if (isRedirectFetchError(error)) {
      fail('forgejo-redirect-forbidden', 'Forgejo request redirects are forbidden');
    }
    throw error;
  }
  const status = Number.isSafeInteger(response?.status) ? response.status : 0;
  if (status !== 200) return { status, value: null };
  let bytes;
  try {
    bytes = await readBoundedBody(response, tooLargeCode);
  } catch (error) {
    throwAbort(deadline, timeoutCode, 'the Forgejo observation deadline expired while reading a response');
    throw error;
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { status, value: JSON.parse(text) };
  } catch {
    fail('forgejo-invalid-json', 'Forgejo returned invalid UTF-8 JSON');
  }
}

function classifyStatus(value, location) {
  if (value === 'success') return 'success';
  if (NONTERMINAL_STATES.has(value)) return null;
  if (TERMINAL_FAILURES.has(value)) return value;
  fail('deployment-status-unsupported', `${location} returned an unsupported Forgejo status`, {
    status: typeof value === 'string' ? value : 'non-string',
  });
}

function parseVersion(value) {
  const version = value?.version;
  const match = typeof version === 'string' ? version.match(VERSION_RE) : null;
  if (!match || Number(match[1]) !== FORGEJO_SUPPORTED_MAJOR) {
    fail('forgejo-version-unsupported', `Forgejo ${FORGEJO_SUPPORTED_MAJOR}.x is required`);
  }
  return version;
}

async function versionPreflight(expected, deadline, dependencies, boundVersion = null) {
  const endpoint = `${expected.workflow.apiBaseUrl}/version`;
  let attempts = 0;
  while (true) {
    attempts += 1;
    let fetched;
    try {
      fetched = await fetchJson(endpoint, expected, deadline, dependencies, {
        timeoutCode: 'forgejo-version-timeout',
        tooLargeCode: 'forgejo-version-response-too-large',
      });
    } catch (error) {
      if (error instanceof OwnerAlphaError) throw error;
      if (await retryOrFail(deadline, 'forgejo-version-timeout', 'Forgejo version preflight did not complete before the deadline', { attempts })) continue;
    }
    if (fetched.status !== 200) {
      if (!shouldRetryStatus(fetched.status)) {
        fail('forgejo-version-unavailable', 'Forgejo version endpoint did not return HTTP 200', { status: fetched.status });
      }
      if (await retryOrFail(deadline, 'forgejo-version-timeout', 'Forgejo version preflight did not complete before the deadline', { attempts, status: fetched.status })) continue;
    }
    const version = parseVersion(fetched.value);
    if (boundVersion !== null && version !== boundVersion) {
      fail('forgejo-instance-identity-mismatch', 'Forgejo instance version changed after the deployment run was bound');
    }
    return { version, endpoint, attempts };
  }
}

function eventPayload(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > FORGEJO_JSON_MAX_BYTES) {
    fail('deployment-run-event-payload-invalid', 'Forgejo run event_payload must be one bounded JSON string');
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail('deployment-run-event-payload-invalid', 'Forgejo run event_payload must contain valid JSON');
  }
  if (!isPlainObject(parsed)) {
    fail('deployment-run-event-payload-invalid', 'Forgejo run event_payload must contain one JSON object');
  }
  return parsed;
}

function forgeUrl(value, expected, location) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('deployment-run-identity-mismatch', `${location} must be one URL on the Forgejo origin`);
  }
  if (url.origin !== expected.apiBaseUrl.origin || url.username || url.password || value.length === 0) {
    fail('deployment-run-identity-mismatch', `${location} must be one URL on the Forgejo origin`);
  }
  return url.toString();
}

function normalizeRun(run, expected, applicationSha, bound = null) {
  const runId = exactId(run?.id, 'run.id', 'deployment-run-identity-mismatch');
  const runNumber = exactPositiveInteger(run?.index_in_repo, 'run.index_in_repo');
  const repositoryId = exactId(run?.repository?.id, 'run.repository.id', 'deployment-run-identity-mismatch');
  const workflowId = run?.workflow_id;
  const payload = eventPayload(run?.event_payload);
  const expectedRef = `refs/heads/${expected.workflow.branch}`;
  const normalized = {
    runId,
    runNumber,
    repositoryId,
    workflowId,
    event: run?.event,
    triggerEvent: run?.trigger_event,
    ref: payload.ref,
    headSha: run?.commit_sha,
    htmlUrl: forgeUrl(run?.html_url, expected, 'run.html_url'),
    status: run?.status,
  };
  classifyStatus(normalized.status, 'Forgejo run');
  if (workflowId !== path.posix.basename(expected.workflow.path)
    || normalized.headSha !== applicationSha
    || normalized.event !== 'push'
    || normalized.triggerEvent !== 'push'
    || run?.repository?.full_name !== expected.workflow.repository
    || payload.ref !== expectedRef
    || payload.after !== applicationSha) {
    fail('deployment-run-identity-mismatch', 'Forgejo Actions run does not match the exact configured workflow, SHA, branch, event, and repository');
  }
  if (bound
    && (runId !== bound.runId
      || runNumber !== bound.runNumber
      || repositoryId !== bound.repositoryId
      || workflowId !== bound.workflowId
      || normalized.event !== bound.event
      || normalized.triggerEvent !== bound.triggerEvent
      || normalized.ref !== bound.ref
      || normalized.headSha !== bound.headSha
      || normalized.htmlUrl !== bound.htmlUrl)) {
    fail('deployment-run-identity-mismatch', 'Forgejo Actions response changed an immutable bound run field');
  }
  return normalized;
}

function normalizeJobs(value, expected, runId, { allowInitializingIdentity = false } = {}) {
  if (!Array.isArray(value) || value.length > 1024) {
    fail('deployment-jobs-invalid-response', 'Forgejo run jobs must be one bounded array');
  }
  const jobs = value.map((job) => {
    const attempt = job?.attempt;
    const handle = job?.handle;
    const attemptReady = Number.isSafeInteger(attempt) && attempt >= 1;
    const attemptInitializing = allowInitializingIdentity && attempt === 0;
    const handleReady = typeof handle === 'string' && handle.length > 0;
    const handleInitializing = allowInitializingIdentity && handle === '';
    if ((!attemptReady && !attemptInitializing) || (!handleReady && !handleInitializing)) {
      fail('deployment-jobs-identity-mismatch', 'Forgejo job identity fields are invalid');
    }
    const normalized = {
      id: exactId(job?.id, 'job.id', 'deployment-jobs-identity-mismatch'),
      runId: exactId(job?.run_id, 'job.run_id', 'deployment-jobs-identity-mismatch'),
      name: job?.name,
      attempt,
      handle,
      identityReady: attemptReady && handleReady,
      needs: Array.isArray(job?.needs) ? [...job.needs].sort() : job?.needs,
      status: job?.status,
    };
    if (normalized.runId !== runId
      || typeof normalized.name !== 'string'
      || normalized.name.length === 0
      || !Array.isArray(normalized.needs)
      || normalized.needs.some((name) => typeof name !== 'string' || name.length === 0)
      || new Set(normalized.needs).size !== normalized.needs.length) {
      fail('deployment-jobs-identity-mismatch', 'Forgejo job identity fields are incomplete or contradictory');
    }
    classifyStatus(normalized.status, `Forgejo job ${normalized.name}`);
    return normalized;
  });
  const names = jobs.map((job) => job.name);
  const ids = jobs.map((job) => job.id);
  if (new Set(names).size !== names.length || new Set(ids).size !== ids.length) {
    fail('deployment-jobs-identity-mismatch', 'Forgejo jobs must have unique names and IDs');
  }
  const unknown = names.filter((name) => !expected.workflow.jobs.includes(name));
  if (unknown.length > 0) {
    fail('deployment-jobs-identity-mismatch', 'Forgejo run contained an unconfigured job', { jobs: unknown.sort() });
  }
  return jobs;
}

function exactJobSet(jobs, expected) {
  return jobs.length === expected.workflow.jobs.length
    && expected.workflow.jobs.every((name) => jobs.some((job) => job.name === name));
}

function assertDeploymentNeeds(jobs, expected) {
  const deployment = jobs.find((job) => job.name === expected.workflow.deploymentJob);
  const required = expected.workflow.jobs.filter((name) => name !== expected.workflow.deploymentJob).sort();
  const actual = [...deployment.needs].sort();
  if (actual.length !== required.length || actual.some((name, index) => name !== required[index])) {
    fail('deployment-job-dependency-mismatch', 'the configured deployment job must need every other configured job exactly');
  }
}

function bindingFrom(run, jobs, expected, version) {
  return deepFreeze({
    provider: 'forgejo-actions',
    apiBaseUrl: expected.workflow.apiBaseUrl,
    instanceVersion: version,
    repository: expected.workflow.repository,
    repositoryId: run.repositoryId,
    runId: run.runId,
    runNumber: run.runNumber,
    workflowId: run.workflowId,
    configuredWorkflowPath: expected.workflow.path,
    event: run.event,
    triggerEvent: run.triggerEvent,
    ref: run.ref,
    headSha: run.headSha,
    htmlUrl: run.htmlUrl,
    jobs: expected.workflow.jobs.map((name) => {
      const job = jobs.find((entry) => entry.name === name);
      return deepFreeze({
        id: job.id,
        name: job.name,
        attempt: job.attempt,
        handle: job.handle,
        needs: deepFreeze([...job.needs]),
      });
    }),
  });
}

function validateBoundRun(boundRun, expected, applicationSha) {
  if (!isPlainObject(boundRun)
    || boundRun.provider !== 'forgejo-actions'
    || boundRun.apiBaseUrl !== expected.workflow.apiBaseUrl
    || typeof boundRun.instanceVersion !== 'string'
    || boundRun.repository !== expected.workflow.repository
    || boundRun.workflowId !== path.posix.basename(expected.workflow.path)
    || boundRun.configuredWorkflowPath !== expected.workflow.path
    || boundRun.event !== 'push'
    || boundRun.triggerEvent !== 'push'
    || boundRun.ref !== `refs/heads/${expected.workflow.branch}`
    || boundRun.headSha !== applicationSha
    || typeof boundRun.htmlUrl !== 'string'
    || !Array.isArray(boundRun.jobs)
    || boundRun.jobs.length !== expected.workflow.jobs.length) {
    fail('deployment-run-binding-invalid', 'stored Forgejo deployment binding does not match configuration and applicationSha');
  }
  parseVersion({ version: boundRun.instanceVersion });
  const normalized = {
    ...boundRun,
    repositoryId: exactId(boundRun.repositoryId, 'boundRun.repositoryId', 'deployment-run-binding-invalid'),
    runId: exactId(boundRun.runId, 'boundRun.runId', 'deployment-run-binding-invalid'),
    runNumber: exactPositiveInteger(boundRun.runNumber, 'boundRun.runNumber'),
    htmlUrl: forgeUrl(boundRun.htmlUrl, expected, 'boundRun.htmlUrl'),
  };
  const seenNames = new Set();
  const seenIds = new Set();
  normalized.jobs = boundRun.jobs.map((job, index) => {
    const expectedName = expected.workflow.jobs[index];
    const normalizedJob = {
      id: exactId(job?.id, `boundRun.jobs[${index}].id`, 'deployment-run-binding-invalid'),
      name: job?.name,
      attempt: exactPositiveInteger(job?.attempt, `boundRun.jobs[${index}].attempt`),
      handle: job?.handle,
      needs: job?.needs,
    };
    if (normalizedJob.name !== expectedName
      || typeof normalizedJob.handle !== 'string'
      || normalizedJob.handle.length === 0
      || !Array.isArray(normalizedJob.needs)
      || normalizedJob.needs.some((name) => typeof name !== 'string' || name.length === 0)
      || new Set(normalizedJob.needs).size !== normalizedJob.needs.length
      || seenNames.has(normalizedJob.name)
      || seenIds.has(normalizedJob.id)) {
      fail('deployment-run-binding-invalid', 'stored Forgejo job binding is incomplete, duplicated, or out of configured order');
    }
    seenNames.add(normalizedJob.name);
    seenIds.add(normalizedJob.id);
    return normalizedJob;
  });
  const deployment = normalized.jobs.find((job) => job.name === expected.workflow.deploymentJob);
  const requiredNeeds = expected.workflow.jobs.filter((name) => name !== expected.workflow.deploymentJob).sort();
  const actualNeeds = [...deployment.needs].sort();
  if (actualNeeds.length !== requiredNeeds.length
    || actualNeeds.some((name, index) => name !== requiredNeeds[index])) {
    fail('deployment-run-binding-invalid', 'stored Forgejo deployment-job dependencies do not match configuration');
  }
  return normalized;
}

async function getRun(endpoint, expected, applicationSha, deadline, dependencies, bound = null) {
  const fetched = await fetchJson(endpoint, expected, deadline, dependencies, {
    timeoutCode: 'deployment-run-monitor-timeout',
    tooLargeCode: 'deployment-run-response-too-large',
  });
  if (fetched.status !== 200) return { status: fetched.status, run: null };
  return { status: 200, run: normalizeRun(fetched.value, expected, applicationSha, bound) };
}

async function getJobs(endpoint, expected, runId, deadline, dependencies, options = {}) {
  const fetched = await fetchJson(endpoint, expected, deadline, dependencies, {
    timeoutCode: 'deployment-jobs-timeout',
    tooLargeCode: 'deployment-jobs-response-too-large',
  });
  if (fetched.status !== 200) return { status: fetched.status, jobs: null };
  return { status: 200, jobs: normalizeJobs(fetched.value, expected, runId, options) };
}

async function discoverWithDeadline({ applicationSha }, expected, deadline, dependencies) {
  const version = await versionPreflight(expected, deadline, dependencies);
  const query = new URLSearchParams({
    event: 'push',
    head_sha: applicationSha,
    ref: `refs/heads/${expected.workflow.branch}`,
    workflow_id: path.posix.basename(expected.workflow.path),
    page: '1',
    limit: '2',
  });
  const listEndpoint = `${expected.workflow.apiBaseUrl}/repos/${encodeURIComponent(expected.owner)}/${encodeURIComponent(expected.repository)}/actions/runs?${query}`;
  let attempts = 0;
  let candidate = null;
  while (candidate === null) {
    attempts += 1;
    let fetched;
    try {
      fetched = await fetchJson(listEndpoint, expected, deadline, dependencies, {
        timeoutCode: 'deployment-run-discovery-timeout',
        tooLargeCode: 'deployment-run-discovery-response-too-large',
      });
    } catch (error) {
      if (error instanceof OwnerAlphaError) throw error;
      if (await retryOrFail(deadline, 'deployment-run-discovery-timeout', 'Forgejo Actions run discovery did not complete before the deadline', { attempts })) continue;
    }
    if (fetched.status !== 200) {
      if (!shouldRetryStatus(fetched.status)) {
        fail('deployment-run-discovery-unavailable', 'Forgejo Actions run discovery did not return HTTP 200', { status: fetched.status });
      }
      if (await retryOrFail(deadline, 'deployment-run-discovery-timeout', 'Forgejo Actions run discovery did not complete before the deadline', { attempts, status: fetched.status })) continue;
    }
    const value = fetched.value;
    if (!Number.isSafeInteger(value?.total_count)
      || value.total_count < 0
      || !Array.isArray(value.workflow_runs)
      || value.workflow_runs.length !== Math.min(value.total_count, 2)) {
      fail('deployment-run-discovery-invalid-response', 'Forgejo run discovery must return one complete bounded result set');
    }
    if (value.total_count > 1) {
      fail('deployment-run-discovery-ambiguous', 'more than one Forgejo Actions run matched the exact discovery query');
    }
    if (value.total_count === 0) {
      if (value.workflow_runs.length !== 0) {
        fail('deployment-run-discovery-invalid-response', 'Forgejo zero-count discovery response must have an empty run array');
      }
      if (await retryOrFail(deadline, 'deployment-run-discovery-timeout', 'no exact Forgejo Actions run appeared before the deadline', { attempts })) continue;
    }
    const ids = value.workflow_runs.map((run) => String(run?.id ?? ''));
    if (new Set(ids).size !== ids.length) {
      fail('deployment-run-discovery-ambiguous', 'Forgejo run discovery returned duplicate run identities');
    }
    candidate = normalizeRun(value.workflow_runs[0], expected, applicationSha);
  }

  const runEndpoint = `${expected.workflow.apiBaseUrl}/repos/${encodeURIComponent(expected.owner)}/${encodeURIComponent(expected.repository)}/actions/runs/${candidate.runId}`;
  const jobsEndpoint = `${runEndpoint}/jobs`;
  while (true) {
    attempts += 1;
    let runResult;
    let jobsResult;
    try {
      runResult = await getRun(runEndpoint, expected, applicationSha, deadline, dependencies, candidate);
      if (runResult.status === 200) {
        jobsResult = await getJobs(jobsEndpoint, expected, candidate.runId, deadline, dependencies, {
          allowInitializingIdentity: true,
        });
      }
    } catch (error) {
      if (error instanceof OwnerAlphaError) throw error;
      if (await retryOrFail(deadline, 'deployment-run-discovery-timeout', 'Forgejo run and job identity binding did not complete before the deadline', { attempts })) continue;
    }
    if (runResult.status !== 200) {
      if (!shouldRetryStatus(runResult.status)) {
        fail('deployment-run-unavailable', 'the candidate Forgejo Actions run did not return HTTP 200', { status: runResult.status });
      }
      if (await retryOrFail(deadline, 'deployment-run-discovery-timeout', 'the candidate Forgejo run did not become observable before the deadline', { attempts, status: runResult.status })) continue;
    }
    if (jobsResult.status !== 200) {
      if (!shouldRetryStatus(jobsResult.status)) {
        fail('deployment-jobs-unavailable', 'the candidate Forgejo Actions jobs endpoint did not return HTTP 200', { status: jobsResult.status });
      }
      if (await retryOrFail(deadline, 'deployment-jobs-timeout', 'the candidate Forgejo jobs did not become observable before the deadline', { attempts, status: jobsResult.status })) continue;
    }
    const runTerminal = classifyStatus(runResult.run.status, 'Forgejo run');
    for (const job of jobsResult.jobs) {
      const terminal = classifyStatus(job.status, `Forgejo job ${job.name}`);
      if (terminal && terminal !== 'success') {
        fail('deployment-job-not-successful', 'a configured Forgejo job reached a terminal non-success state before binding completed', { job: job.name, status: terminal });
      }
    }
    if (!exactJobSet(jobsResult.jobs, expected)) {
      if (runTerminal !== null) {
        fail('deployment-jobs-identity-mismatch', 'terminal Forgejo run completed without the exact configured job set');
      }
      if (await retryOrFail(deadline, 'deployment-jobs-timeout', 'the exact configured Forgejo jobs did not appear before the deadline', { attempts })) continue;
    }
    if (!jobsResult.jobs.every((job) => job.identityReady)) {
      if (runTerminal !== null) {
        fail('deployment-jobs-identity-mismatch', 'terminal Forgejo run completed before every configured job exposed a bindable attempt and handle');
      }
      if (await retryOrFail(deadline, 'deployment-jobs-timeout', 'the exact configured Forgejo job identities did not become bindable before the deadline', { attempts })) continue;
    }
    assertDeploymentNeeds(jobsResult.jobs, expected);
    const binding = bindingFrom(runResult.run, jobsResult.jobs, expected, version.version);
    return deepFreeze({ binding, attempts });
  }
}

function assertObservedJobs(bound, observed, expected) {
  if (!exactJobSet(observed, expected)) {
    fail('deployment-jobs-identity-mismatch', 'the bound Forgejo run no longer exposes the exact configured job set');
  }
  for (const boundJob of bound.jobs) {
    const job = observed.find((entry) => entry.name === boundJob.name);
    if (job.id !== boundJob.id
      || job.attempt !== boundJob.attempt
      || job.handle !== boundJob.handle
      || job.needs.length !== boundJob.needs.length
      || job.needs.some((name, index) => name !== boundJob.needs[index])) {
      fail('deployment-job-rerun-identity-mismatch', 'Forgejo job ID, attempt, handle, or dependency identity changed after binding');
    }
  }
}

async function monitorWithDeadline({ applicationSha, boundRun }, expected, deadline, dependencies) {
  const bound = validateBoundRun(boundRun, expected, applicationSha);
  await versionPreflight(expected, deadline, dependencies, bound.instanceVersion);
  const runEndpoint = `${expected.workflow.apiBaseUrl}/repos/${encodeURIComponent(expected.owner)}/${encodeURIComponent(expected.repository)}/actions/runs/${bound.runId}`;
  const jobsEndpoint = `${runEndpoint}/jobs`;
  let attempts = 0;
  while (true) {
    attempts += 1;
    let runResult;
    let jobsResult;
    try {
      runResult = await getRun(runEndpoint, expected, applicationSha, deadline, dependencies, bound);
      if (runResult.status === 200) {
        jobsResult = await getJobs(jobsEndpoint, expected, bound.runId, deadline, dependencies);
      }
    } catch (error) {
      if (error instanceof OwnerAlphaError) throw error;
      if (await retryOrFail(deadline, 'deployment-run-monitor-timeout', 'the bound Forgejo Actions run was not verified before the deadline', { attempts })) continue;
    }
    if (runResult.status !== 200) {
      if (!shouldRetryStatus(runResult.status)) {
        fail('deployment-run-external-identity-failure', 'the explicitly bound Forgejo run is unavailable', { status: runResult.status });
      }
      if (await retryOrFail(deadline, 'deployment-run-monitor-timeout', 'the bound Forgejo run was not verified before the deadline', { attempts, status: runResult.status })) continue;
    }
    if (jobsResult.status !== 200) {
      if (!shouldRetryStatus(jobsResult.status)) {
        fail('deployment-job-external-identity-failure', 'the explicitly bound Forgejo jobs are unavailable', { status: jobsResult.status });
      }
      if (await retryOrFail(deadline, 'deployment-jobs-timeout', 'the bound Forgejo jobs were not verified before the deadline', { attempts, status: jobsResult.status })) continue;
    }
    assertObservedJobs(bound, jobsResult.jobs, expected);
    const runTerminal = classifyStatus(runResult.run.status, 'Forgejo run');
    if (runTerminal && runTerminal !== 'success') {
      fail('deployment-run-not-successful', 'the bound Forgejo Actions run reached a terminal non-success state', { status: runTerminal });
    }
    for (const job of jobsResult.jobs) {
      const terminal = classifyStatus(job.status, `Forgejo job ${job.name}`);
      if (terminal && terminal !== 'success') {
        fail('deployment-job-not-successful', 'a bound Forgejo job reached a terminal non-success state', { job: job.name, status: terminal });
      }
    }
    if (runTerminal !== 'success' || !jobsResult.jobs.every((job) => classifyStatus(job.status, `Forgejo job ${job.name}`) === 'success')) {
      if (await retryOrFail(deadline, 'deployment-run-monitor-timeout', 'the bound Forgejo run and jobs did not complete successfully before the deadline', { attempts })) continue;
    }
    const deploymentJob = jobsResult.jobs.find((job) => job.name === expected.workflow.deploymentJob);
    return deepFreeze({
      provider: 'forgejo-actions',
      repository: expected.workflow.repository,
      run: {
        id: bound.runId,
        number: bound.runNumber,
        workflowId: bound.workflowId,
        headSha: bound.headSha,
        status: 'success',
        htmlUrl: bound.htmlUrl,
        instanceVersion: bound.instanceVersion,
      },
      jobs: {
        names: deepFreeze([...expected.workflow.jobs]),
        entries: deepFreeze(expected.workflow.jobs.map((name) => {
          const job = jobsResult.jobs.find((entry) => entry.name === name);
          return deepFreeze({
            id: job.id,
            name: job.name,
            attempt: job.attempt,
            handle: job.handle,
            needs: deepFreeze([...job.needs]),
            status: 'success',
          });
        })),
      },
      publication: {
        state: 'success',
        deploymentJobName: deploymentJob.name,
        deploymentJobId: deploymentJob.id,
        deploymentJobAttempt: deploymentJob.attempt,
        deploymentJobHandle: deploymentJob.handle,
        destinationUrl: expected.destinationUrl.toString(),
        destinationSource: 'owner-policy',
        forgeEnvironmentAttested: false,
      },
      attempts,
    });
  }
}

export async function discoverForgejoActionsRun(
  { config, applicationSha, timeoutMs, signal } = {},
  dependencyOverrides = {},
) {
  const expected = validateConfig(config);
  const sha = exactSha(applicationSha);
  const dependencies = mergeDependencies(expected, dependencyOverrides);
  const deadline = createDeadline(timeoutMs ?? expected.limits.networkTimeoutMs, signal, dependencies);
  try {
    throwAbort(deadline, 'deployment-run-discovery-timeout', 'Forgejo Actions run discovery deadline expired');
    return await discoverWithDeadline({ applicationSha: sha }, expected, deadline, dependencies);
  } finally {
    deadline.close();
  }
}

export async function monitorForgejoActionsDeployment(
  { config, applicationSha, boundRun, timeoutMs, signal } = {},
  dependencyOverrides = {},
) {
  const expected = validateConfig(config);
  const sha = exactSha(applicationSha);
  const bound = validateBoundRun(boundRun, expected, sha);
  const dependencies = mergeDependencies(expected, dependencyOverrides);
  const deadline = createDeadline(timeoutMs ?? expected.limits.networkTimeoutMs, signal, dependencies);
  try {
    throwAbort(deadline, 'deployment-run-monitor-timeout', 'Forgejo Actions monitoring deadline expired');
    return await monitorWithDeadline({ applicationSha: sha, boundRun: bound }, expected, deadline, dependencies);
  } finally {
    deadline.close();
  }
}

export async function verifyForgejoActionsDeployment(
  { config, applicationSha, timeoutMs, signal } = {},
  dependencyOverrides = {},
) {
  const expected = validateConfig(config);
  const sha = exactSha(applicationSha);
  const dependencies = mergeDependencies(expected, dependencyOverrides);
  const deadline = createDeadline(timeoutMs ?? expected.limits.networkTimeoutMs, signal, dependencies);
  try {
    throwAbort(deadline, 'deployment-run-discovery-timeout', 'Forgejo Actions verification deadline expired');
    const discovery = await discoverWithDeadline({ applicationSha: sha }, expected, deadline, dependencies);
    const deployment = await monitorWithDeadline({
      applicationSha: sha,
      boundRun: discovery.binding,
    }, expected, deadline, dependencies);
    return deepFreeze({ discovery, deployment });
  } finally {
    deadline.close();
  }
}
