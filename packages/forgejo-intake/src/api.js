import {
  deepFreeze,
  decodeUtf8,
  fail,
  FORGEJO_INTAKE_MAX_API_BYTES,
  FORGEJO_INTAKE_SUPPORTED_MAJOR,
  FORGEJO_INTAKE_TIMEOUT_MS,
  requireDecimalId,
  requirePositiveInteger,
  requireSha,
  requireString,
} from './contract.js';
import { validateForgejoIntakeConfig } from './config.js';

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u;

function requireFetch(value) {
  if (typeof value !== 'function') fail('invalid-fetch', 'fetch must be an injected function');
  return value;
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

function createDeadline(timeoutMs, externalSignal, dependencies) {
  const controller = new AbortController();
  let kind = null;
  const abort = (nextKind, reason) => {
    if (controller.signal.aborted) return;
    kind = nextKind;
    controller.abort(reason);
  };
  const onExternalAbort = () => abort('external', externalSignal.reason);
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true });
  const timer = dependencies.setTimer(
    () => abort('deadline', new DOMException('Forgejo intake deadline expired', 'TimeoutError')),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    throwIfAborted() {
      if (!controller.signal.aborted) return;
      if (kind === 'external') fail('forgejo-intake-aborted', 'Forgejo intake was aborted by its caller');
      fail('forgejo-intake-timeout', 'Forgejo intake exceeded its total deadline');
    },
    close() {
      dependencies.clearTimer(timer);
      externalSignal?.removeEventListener?.('abort', onExternalAbort);
    },
  };
}

async function readBoundedBody(response, maxBytes, signal) {
  const length = response.headers.get('content-length');
  if (length !== null) {
    if (!/^\d+$/u.test(length)) fail('invalid-content-length', 'Forgejo response has invalid Content-Length');
    const declared = Number(length);
    if (!Number.isSafeInteger(declared) || declared > maxBytes) {
      fail('forgejo-response-too-large', `Forgejo response exceeds ${maxBytes} bytes`, {
        declared: Number.isSafeInteger(declared) ? declared : null,
      });
    }
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await awaitWithSignal(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        fail('forgejo-response-too-large', `Forgejo response exceeds ${maxBytes} bytes`, {
          received: total,
        });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function decodeJson(bytes, endpoint) {
  if (bytes.length === 0) fail('empty-forgejo-response', `Forgejo returned an empty response for ${endpoint}`);
  const text = decodeUtf8(bytes, `Forgejo response for ${endpoint}`);
  try {
    return JSON.parse(text);
  } catch {
    fail('invalid-forgejo-json', `Forgejo returned malformed JSON for ${endpoint}`);
  }
}

function requireApiUrl(value, origin, label) {
  requireString(value, label, { maxBytes: 2048 });
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('invalid-forgejo-url', `${label} must be an absolute URL`);
  }
  if (
    url.origin !== origin
    || url.username !== ''
    || url.password !== ''
    || value.includes('?')
    || value.includes('#')
    || url.toString() !== value
  ) {
    fail('invalid-forgejo-url', `${label} must be a canonical URL on the configured Forgejo origin`);
  }
  return value;
}

function positiveId(value, label) {
  return requireDecimalId(value, label);
}

function normalizeVersion(value) {
  const version = requireString(value?.version, 'version.version', {
    maxBytes: 128,
  });
  const match = version.match(VERSION_RE);
  if (!match) fail('invalid-forgejo-version', 'Forgejo returned an invalid semantic version');
  const major = Number(match[1]);
  if (major !== FORGEJO_INTAKE_SUPPORTED_MAJOR) {
    fail(
      'unsupported-forgejo-version',
      `Forgejo intake supports major ${FORGEJO_INTAKE_SUPPORTED_MAJOR}`,
      { actualMajor: major },
    );
  }
  return version;
}

function normalizeRepository(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid-forgejo-repository', 'Forgejo repository response must be an object');
  }
  const repository = {
    id: positiveId(value.id, 'repository.id'),
    fullName: requireString(value.full_name, 'repository.full_name', { maxBytes: 256 }),
    cloneUrl: requireString(value.clone_url, 'repository.clone_url', { maxBytes: 2048 }),
    defaultBranch: requireString(value.default_branch, 'repository.default_branch', { maxBytes: 255 }),
  };
  if (
    repository.fullName !== expected.repository.fullName
    || repository.cloneUrl !== expected.repository.url
    || repository.defaultBranch !== expected.repository.baseBranch
  ) {
    fail('forgejo-repository-mismatch', 'Forgejo repository metadata does not match owner configuration');
  }
  return repository;
}

function normalizePullRequest(value, expected, number, repositoryId) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid-forgejo-pull-request', 'Forgejo pull request response must be an object');
  }
  if (value.number !== number || value.state !== 'open' || value.draft !== false) {
    fail('unsupported-forgejo-pull-request', 'Forgejo pull request must be the exact open non-draft request');
  }
  const baseRepositoryId = positiveId(value.base?.repo?.id, 'pull_request.base.repo.id');
  const baseRepositoryName = requireString(
    value.base?.repo?.full_name,
    'pull_request.base.repo.full_name',
    { maxBytes: 256 },
  );
  const baseRef = requireString(value.base?.ref, 'pull_request.base.ref', { maxBytes: 255 });
  if (
    baseRepositoryId !== repositoryId
    || baseRepositoryName !== expected.repository.fullName
    || baseRef !== expected.repository.baseBranch
  ) {
    fail('pull-request-base-mismatch', 'pull request base does not match owner configuration');
  }
  const baseSha = requireSha(value.base?.sha, 'pull_request.base.sha');
  const headSha = requireSha(value.head?.sha, 'pull_request.head.sha');
  if (baseSha === headSha) fail('pull-request-no-change', 'pull request base and head must differ');
  const author = {
    id: positiveId(value.user?.id, 'pull_request.user.id'),
    login: requireString(value.user?.login, 'pull_request.user.login', { maxBytes: 100 }),
  };
  const pullRequestUrl = requireApiUrl(
    value.html_url,
    expected.forgejo.origin,
    'pull_request.html_url',
  );
  if (new URL(pullRequestUrl).pathname !== `/${expected.repository.owner}/${expected.repository.name}/pulls/${number}`) {
    fail('pull-request-url-mismatch', 'pull request URL does not match owner, repository, and number');
  }
  return {
    number,
    url: pullRequestUrl,
    title: requireString(value.title, 'pull_request.title', {
      maxBytes: 8 * 1024,
      rejectControls: false,
    }),
    body: value.body === null || value.body === undefined
      ? ''
      : requireString(value.body, 'pull_request.body', {
          nonEmpty: false,
          maxBytes: 32 * 1024,
          rejectControls: false,
        }),
    createdAt: requireString(value.created_at, 'pull_request.created_at', { maxBytes: 128 }),
    baseSha,
    headSha,
    author,
  };
}

function normalizeUser(value, expectedAuthor) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid-forgejo-user', 'Forgejo user response must be an object');
  }
  const user = {
    id: positiveId(value.id, 'user.id'),
    login: requireString(value.login, 'user.login', { maxBytes: 100 }),
  };
  if (user.id !== expectedAuthor.id || user.login !== expectedAuthor.login) {
    fail('forgejo-user-mismatch', 'refetched Forgejo user does not match the pull request author');
  }
  if (value.is_bot === true || value.active === false || value.prohibit_login === true) {
    fail('unsupported-forgejo-user', 'Lane A v1 requires one active human Forgejo account');
  }
  return user;
}

export function createForgejoApi({
  fetch: fetchImpl,
  getToken = null,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  maxBodyBytes = FORGEJO_INTAKE_MAX_API_BYTES,
  timeoutMs = FORGEJO_INTAKE_TIMEOUT_MS,
} = {}) {
  const requestFetch = requireFetch(fetchImpl);
  if (getToken !== null && typeof getToken !== 'function') {
    fail('invalid-token-callback', 'getToken must be null or an injected function');
  }
  if (typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    fail('invalid-timer', 'timer dependencies must be functions');
  }
  const bodyLimit = requirePositiveInteger(maxBodyBytes, 'maxBodyBytes');
  const totalTimeout = requirePositiveInteger(timeoutMs, 'timeoutMs');
  const dependencies = { setTimer, clearTimer };

  async function requestJson(endpoint, config, deadline) {
    deadline.throwIfAborted();
    const url = new URL(`${config.forgejo.apiBaseUrl}${endpoint}`);
    if (url.origin !== config.forgejo.origin || !url.pathname.startsWith('/api/v1/')) {
      fail('forgejo-endpoint-origin-mismatch', 'Forgejo endpoint escaped the configured API origin');
    }
    const headers = {
      Accept: 'application/json',
      'User-Agent': '@cyberbaser/forgejo-intake',
    };
    try {
      if (getToken !== null) {
        let token;
        try {
          token = await awaitWithSignal(getToken(), deadline.signal);
        } catch {
          deadline.throwIfAborted();
          fail('forgejo-token-failed', 'Forgejo credential callback failed');
        }
        deadline.throwIfAborted();
        if (token !== null) {
          if (typeof token !== 'string' || token.length === 0 || token.length > 4096 || /\s/u.test(token)) {
            fail('invalid-forgejo-token', 'getToken returned an invalid token');
          }
          headers.Authorization = `Bearer ${token}`;
        }
      }
      const response = await awaitWithSignal(requestFetch(url, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: deadline.signal,
      }), deadline.signal);
      if (!response || typeof response.ok !== 'boolean' || !response.headers) {
        fail('invalid-fetch-response', 'injected fetch returned an invalid response');
      }
      const bytes = await readBoundedBody(response, bodyLimit, deadline.signal);
      if (!response.ok) {
        fail('forgejo-api-error', `Forgejo returned HTTP ${response.status} for ${url.pathname}`, {
          status: response.status,
        });
      }
      return decodeJson(bytes, url.pathname);
    } catch (error) {
      if (error?.name === 'ForgejoIntakeError') throw error;
      deadline.throwIfAborted();
      fail('forgejo-request-failed', `Forgejo request failed for ${url.pathname}`);
    }
  }

  async function readPullRequest({ config: inputConfig, pullRequestNumber, signal } = {}) {
    const config = validateForgejoIntakeConfig(inputConfig);
    const number = requirePositiveInteger(pullRequestNumber, 'pullRequestNumber');
    const deadline = createDeadline(totalTimeout, signal, dependencies);
    try {
      const owner = encodeURIComponent(config.repository.owner);
      const name = encodeURIComponent(config.repository.name);
      const instanceVersion = normalizeVersion(
        await requestJson('/version', config, deadline),
      );
      const repositoryValue = await requestJson(`/repos/${owner}/${name}`, config, deadline);
      const repository = normalizeRepository(repositoryValue, config);
      const pullValue = await requestJson(`/repos/${owner}/${name}/pulls/${number}`, config, deadline);
      const pullRequest = normalizePullRequest(pullValue, config, number, repository.id);
      const userValue = await requestJson(
        `/users/${encodeURIComponent(pullRequest.author.login)}`,
        config,
        deadline,
      );
      const user = normalizeUser(userValue, pullRequest.author);
      deadline.throwIfAborted();
      return deepFreeze({
        instanceVersion,
        repository,
        pullRequest: {
          ...pullRequest,
          author: user,
        },
      });
    } finally {
      deadline.close();
    }
  }

  return Object.freeze({ readPullRequest });
}
