import { describe, expect, test } from 'bun:test';
import {
  GITHUB_API_VERSION,
  LedgerGithubError,
  createGithubApi,
} from '../src/index.js';

function expectGithubError(error, code) {
  expect(error).toBeInstanceOf(LedgerGithubError);
  expect(error.code).toBe(code);
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function fakeFetch(routes, calls = []) {
  return async (url, options) => {
    const key = `${url.pathname}${url.search}`;
    calls.push({ key, url, options });
    const route = routes.get(key);
    if (route === undefined) return jsonResponse({ message: 'missing fake route' }, { status: 404 });
    return typeof route === 'function' ? route(url, options) : route;
  };
}

function api(routes, options = {}) {
  return createGithubApi({
    fetch: fakeFetch(routes, options.calls),
    token: 'test-token',
    apiBaseUrl: 'https://api.example.test',
    ...options,
  });
}

describe('bounded injected GitHub API reads', () => {
  test('sends explicit authentication and immutable API version headers', async () => {
    const calls = [];
    const client = api(new Map([['/repos/example/wiki', jsonResponse({ id: 1 })]]), { calls });
    expect(await client.getJson('/repos/example/wiki')).toEqual({ id: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].options.method).toBe('GET');
    expect(calls[0].options.headers.Authorization).toBe('Bearer test-token');
    expect(calls[0].options.headers['X-GitHub-Api-Version']).toBe(GITHUB_API_VERSION);
    expect(calls[0].options.redirect).toBe('error');
  });

  test('preserves a GitHub Enterprise API path prefix', async () => {
    let requestedUrl = null;
    const client = createGithubApi({
      fetch: async (url) => {
        requestedUrl = url.href;
        return jsonResponse({ id: 1 });
      },
      token: 'test-token',
      apiBaseUrl: 'https://ghe.example.test/api/v3/',
    });
    expect(await client.getJson('/repos/example/wiki')).toEqual({ id: 1 });
    expect(requestedUrl).toBe('https://ghe.example.test/api/v3/repos/example/wiki');
  });

  test('requires injected fetch, explicit token, and a safe API base URL', () => {
    expect(() => createGithubApi({ token: 'x' })).toThrow();
    try {
      createGithubApi({ fetch: async () => new Response(), token: '' });
    } catch (error) {
      expectGithubError(error, 'missing-github-token');
    }
    for (const apiBaseUrl of [
      'ftp://localhost/api',
      'http://api.example.test',
      'https://user:password@api.example.test',
      'https://api.example.test?route=other',
    ]) {
      let thrown = null;
      try {
        createGithubApi({ fetch: async () => new Response(), token: 'x', apiBaseUrl });
      } catch (error) {
        thrown = error;
      }
      expectGithubError(thrown, 'invalid-api-base-url');
    }
  });

  test('rejects cross-origin and non-root-relative endpoints', async () => {
    const client = api(new Map());
    for (const endpoint of ['https://evil.example/data', '//evil.example/data', 'repos/example/wiki']) {
      try {
        await client.getJson(endpoint);
      } catch (error) {
        expectGithubError(error, 'invalid-api-endpoint');
      }
    }
  });

  test('rejects HTTP failures, malformed JSON, invalid UTF-8, and empty JSON bodies', async () => {
    const routes = new Map([
      ['/http', jsonResponse({ message: 'no' }, { status: 403 })],
      ['/json', new Response('{nope')],
      ['/utf8', new Response(Uint8Array.from([0xc3, 0x28]))],
      ['/empty', new Response('')],
    ]);
    const client = api(routes);
    for (const [endpoint, code] of [
      ['/http', 'github-api-error'],
      ['/json', 'invalid-github-json'],
      ['/utf8', 'invalid-github-utf8'],
      ['/empty', 'empty-github-response'],
    ]) {
      try {
        await client.getJson(endpoint);
      } catch (error) {
        expectGithubError(error, code);
      }
    }
  });

  test('enforces a timeout across the injected fetch and response body', async () => {
    const client = createGithubApi({
      fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
      token: 'test-token',
      apiBaseUrl: 'https://api.example.test',
      timeoutMs: 5,
    });
    try {
      await client.getJson('/slow');
    } catch (error) {
      expectGithubError(error, 'github-request-timeout');
    }
  });

  test('enforces declared and streamed body limits', async () => {
    const routes = new Map([
      ['/declared', new Response('12345', { headers: { 'content-length': '5' } })],
      ['/streamed', new Response('12345')],
    ]);
    const client = api(routes, { maxBodyBytes: 4 });
    for (const endpoint of ['/declared', '/streamed']) {
      try {
        await client.getBytes(endpoint);
      } catch (error) {
        expectGithubError(error, 'github-response-too-large');
      }
    }
  });
});

describe('bounded explicit GitHub pagination', () => {
  test('collects object pages and verifies stable total_count completeness', async () => {
    const calls = [];
    const routes = new Map([
      ['/checks?per_page=2&page=1', jsonResponse({ total_count: 3, check_runs: [{ id: 1 }, { id: 2 }] })],
      ['/checks?per_page=2&page=2', jsonResponse({ total_count: 3, check_runs: [{ id: 3 }] })],
    ]);
    const client = api(routes, { calls, perPage: 2 });
    expect(await client.paginate('/checks', { itemsKey: 'check_runs', totalKey: 'total_count' })).toEqual([
      { id: 1 }, { id: 2 }, { id: 3 },
    ]);
    expect(calls.map(({ key }) => key)).toEqual([
      '/checks?per_page=2&page=1',
      '/checks?per_page=2&page=2',
    ]);
  });

  test('uses one empty sentinel page when an array endpoint ends on a full page', async () => {
    const routes = new Map([
      ['/labels?per_page=2&page=1', jsonResponse([{ id: 1 }, { id: 2 }])],
      ['/labels?per_page=2&page=2', jsonResponse([])],
    ]);
    const client = api(routes, { perPage: 2 });
    expect(await client.paginate('/labels')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test('fails on incomplete, changing, oversized, and overlong pagination', async () => {
    const cases = [
      {
        routes: new Map([['/items?per_page=2&page=1', jsonResponse({ total_count: 3, items: [{ id: 1 }] })]]),
        options: { perPage: 2 },
        settings: { itemsKey: 'items', totalKey: 'total_count' },
        code: 'incomplete-pagination',
      },
      {
        routes: new Map([
          ['/items?per_page=2&page=1', jsonResponse({ total_count: 3, items: [{ id: 1 }, { id: 2 }] })],
          ['/items?per_page=2&page=2', jsonResponse({ total_count: 4, items: [{ id: 3 }, { id: 4 }] })],
        ]),
        options: { perPage: 2 },
        settings: { itemsKey: 'items', totalKey: 'total_count' },
        code: 'pagination-total-changed',
      },
      {
        routes: new Map([['/items?per_page=2&page=1', jsonResponse({ total_count: 3, items: [{ id: 1 }, { id: 2 }] })]]),
        options: { perPage: 2, maxItems: 2 },
        settings: { itemsKey: 'items', totalKey: 'total_count' },
        code: 'github-pagination-item-limit',
      },
      {
        routes: new Map([['/items?per_page=1&page=1', jsonResponse([{ id: 1 }])]]),
        options: { perPage: 1, maxPages: 1 },
        settings: {},
        code: 'github-pagination-page-limit',
      },
    ];
    for (const item of cases) {
      const client = api(item.routes, item.options);
      try {
        await client.paginate('/items', item.settings);
      } catch (error) {
        expectGithubError(error, item.code);
      }
    }
  });
});
