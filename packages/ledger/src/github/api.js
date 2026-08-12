import { LedgerGithubError } from './contract.js';

export const GITHUB_API_VERSION = '2022-11-28';
export const GITHUB_API_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const GITHUB_API_MAX_PAGES = 20;
export const GITHUB_API_MAX_ITEMS = 2_000;
export const GITHUB_API_PER_PAGE = 100;
export const GITHUB_API_TIMEOUT_MS = 15_000;

function fail(code, message, details = {}) {
  throw new LedgerGithubError(code, message, details);
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('invalid-api-bound', `${label} must be a positive safe integer`);
  }
  return value;
}

function requireFetch(value) {
  if (typeof value !== 'function') fail('invalid-fetch', 'fetch must be an injected function');
  return value;
}

function requireToken(value) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('missing-github-token', 'an explicit GitHub token is required');
  }
  return value;
}

function requireBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('invalid-api-base-url', 'apiBaseUrl must be an absolute HTTPS URL');
  }
  const loopbackHttp = url.protocol === 'http:'
    && new Set(['localhost', '127.0.0.1', '[::1]']).has(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    fail('invalid-api-base-url', 'apiBaseUrl must use HTTPS, except for loopback HTTP in tests');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    fail('invalid-api-base-url', 'apiBaseUrl must not contain credentials, a query, or a fragment');
  }
  url.pathname = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/, '');
  return url;
}

function parseEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('/') || endpoint.startsWith('//')) {
    fail('invalid-api-endpoint', 'GitHub API endpoint must be an API-root-relative path');
  }
  let parsed;
  try {
    parsed = new URL(endpoint, 'https://endpoint.invalid');
  } catch {
    fail('invalid-api-endpoint', 'GitHub API endpoint is not a valid URL path');
  }
  if (parsed.origin !== 'https://endpoint.invalid' || parsed.hash !== '') {
    fail('invalid-api-endpoint', 'GitHub API endpoint must remain an API-root-relative path without a fragment');
  }
  return parsed;
}

function endpointUrl(baseUrl, endpoint) {
  const parsed = parseEndpoint(endpoint);
  const prefix = baseUrl.pathname === '/' ? '' : baseUrl.pathname;
  const url = new URL(baseUrl.origin);
  url.pathname = `${prefix}${parsed.pathname}`;
  url.search = parsed.search;
  return url;
}

async function readBoundedBody(response, maxBytes) {
  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader !== null) {
    if (!/^\d+$/.test(lengthHeader)) fail('invalid-content-length', 'GitHub response has an invalid Content-Length');
    const declared = Number(lengthHeader);
    if (!Number.isSafeInteger(declared) || declared > maxBytes) {
      fail('github-response-too-large', `GitHub response exceeds ${maxBytes} bytes`, { declared });
    }
  }

  if (!response.body) return Buffer.alloc(0);
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
        fail('github-response-too-large', `GitHub response exceeds ${maxBytes} bytes`, { received: total });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function decodeJson(bytes, endpoint) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('invalid-github-utf8', `GitHub API returned invalid UTF-8 for ${endpoint}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail('invalid-github-json', `GitHub API returned malformed JSON for ${endpoint}: ${error.message}`);
  }
}

function paginationEndpoint(endpoint, page, perPage) {
  const parsed = parseEndpoint(endpoint);
  parsed.searchParams.set('per_page', String(perPage));
  parsed.searchParams.set('page', String(page));
  return `${parsed.pathname}${parsed.search}`;
}

export function createGithubApi({
  fetch: fetchImpl,
  token,
  apiBaseUrl = 'https://api.github.com',
  maxBodyBytes = GITHUB_API_MAX_BODY_BYTES,
  maxPages = GITHUB_API_MAX_PAGES,
  maxItems = GITHUB_API_MAX_ITEMS,
  perPage = GITHUB_API_PER_PAGE,
  timeoutMs = GITHUB_API_TIMEOUT_MS,
} = {}) {
  const requestFetch = requireFetch(fetchImpl);
  const githubToken = requireToken(token);
  const baseUrl = requireBaseUrl(apiBaseUrl);
  const bodyLimit = requirePositiveInteger(maxBodyBytes, 'maxBodyBytes');
  const pageLimit = requirePositiveInteger(maxPages, 'maxPages');
  const itemLimit = requirePositiveInteger(maxItems, 'maxItems');
  const pageSize = requirePositiveInteger(perPage, 'perPage');
  const requestTimeout = requirePositiveInteger(timeoutMs, 'timeoutMs');
  if (pageSize > 100) fail('invalid-api-bound', 'perPage must not exceed GitHub maximum 100');

  async function request(endpoint, {
    accept = 'application/vnd.github+json',
    maxBytes = bodyLimit,
    redirect = 'error',
  } = {}) {
    const url = endpointUrl(baseUrl, endpoint);
    const byteLimit = requirePositiveInteger(maxBytes, 'maxBytes');
    if (!['error', 'follow'].includes(redirect)) {
      fail('invalid-redirect-mode', 'redirect must be error or follow');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeout);
    try {
      const response = await requestFetch(url, {
        method: 'GET',
        headers: {
          Accept: accept,
          Authorization: `Bearer ${githubToken}`,
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          'User-Agent': '@cyberbaser/ledger',
        },
        redirect,
        signal: controller.signal,
      });
      if (!response || typeof response.ok !== 'boolean' || !response.headers) {
        fail('invalid-fetch-response', 'injected fetch returned an invalid response');
      }
      if (redirect === 'follow' && response.url !== '') {
        const finalUrl = new URL(response.url);
        if (finalUrl.protocol !== 'https:') {
          fail('unsafe-github-redirect', 'GitHub download redirect must end at an HTTPS URL');
        }
      }
      const bytes = await readBoundedBody(response, byteLimit);
      if (!response.ok) {
        fail('github-api-error', `GitHub API returned HTTP ${response.status} for ${url.pathname}`, {
          status: response.status,
        });
      }
      return bytes;
    } catch (error) {
      if (error instanceof LedgerGithubError) throw error;
      if (controller.signal.aborted) {
        fail('github-request-timeout', `GitHub API request timed out for ${url.pathname}`);
      }
      fail('github-request-failed', `GitHub API request failed for ${url.pathname}`, {
        cause: error?.message ?? String(error),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function getJson(endpoint, options = {}) {
    const bytes = await request(endpoint, options);
    if (bytes.length === 0) fail('empty-github-response', `GitHub API returned an empty response for ${endpoint}`);
    return decodeJson(bytes, endpoint);
  }

  async function getBytes(endpoint, options = {}) {
    return request(endpoint, options);
  }

  async function paginate(endpoint, { itemsKey = null, totalKey = null, accept } = {}) {
    const collected = [];
    let expectedTotal = null;
    for (let page = 1; page <= pageLimit; page += 1) {
      const pageEndpoint = paginationEndpoint(endpoint, page, pageSize);
      const value = await getJson(pageEndpoint, { accept });
      let items;
      if (itemsKey === null) {
        items = value;
      } else {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          fail('invalid-paginated-response', `GitHub pagination response for ${endpoint} must be an object`);
        }
        items = value[itemsKey];
        if (totalKey !== null) {
          const total = value[totalKey];
          if (!Number.isSafeInteger(total) || total < 0) {
            fail('invalid-pagination-total', `GitHub pagination response for ${endpoint} has an invalid ${totalKey}`);
          }
          if (expectedTotal === null) expectedTotal = total;
          else if (expectedTotal !== total) {
            fail('pagination-total-changed', `GitHub pagination total changed while reading ${endpoint}`);
          }
          if (expectedTotal > itemLimit) {
            fail('github-pagination-item-limit', `GitHub pagination exceeds ${itemLimit} items`, {
              total: expectedTotal,
            });
          }
        }
      }
      if (!Array.isArray(items)) {
        fail('invalid-paginated-response', `GitHub pagination response for ${endpoint} must contain an array`);
      }
      if (items.length > pageSize) {
        fail('invalid-page-size', `GitHub pagination response for ${endpoint} exceeds requested page size`);
      }
      collected.push(...items);
      if (collected.length > itemLimit) {
        fail('github-pagination-item-limit', `GitHub pagination exceeds ${itemLimit} items`);
      }

      if (expectedTotal !== null) {
        if (collected.length > expectedTotal) {
          fail('pagination-total-mismatch', `GitHub pagination returned more items than ${totalKey}`);
        }
        if (collected.length === expectedTotal) return collected;
        if (items.length < pageSize) {
          fail('incomplete-pagination', `GitHub pagination ended before ${totalKey} items were returned`, {
            expected: expectedTotal,
            actual: collected.length,
          });
        }
      } else if (items.length < pageSize) {
        return collected;
      }
    }
    fail('github-pagination-page-limit', `GitHub pagination exceeds ${pageLimit} pages`);
  }

  return Object.freeze({ getBytes, getJson, paginate });
}
