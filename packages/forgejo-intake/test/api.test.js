import { describe, expect, test } from 'bun:test';
import { createForgejoApi } from '../src/index.js';
import {
  CONFIG,
  expectCode,
  jsonResponse,
  pullRequestPayload,
  queueFetch,
  repositoryPayload,
  userPayload,
} from './fixtures.js';

function validResponses(overrides = {}) {
  return [
    jsonResponse(overrides.version ?? { version: '16.0.2' }),
    jsonResponse(overrides.repository ?? repositoryPayload()),
    jsonResponse(overrides.pullRequest ?? pullRequestPayload()),
    jsonResponse(overrides.user ?? userPayload()),
  ];
}

describe('createForgejoApi', () => {
  test('performs exactly four sequential read-only requests and returns frozen metadata', async () => {
    const calls = [];
    let tokenCalls = 0;
    const api = createForgejoApi({
      fetch: queueFetch(validResponses(), calls),
      getToken: () => {
        tokenCalls += 1;
        return 'top-secret-token';
      },
    });
    const snapshot = await api.readPullRequest({
      config: CONFIG,
      pullRequestNumber: 42,
    });

    expect(calls.map((call) => call.url)).toEqual([
      'https://forge.example:8443/api/v1/version',
      'https://forge.example:8443/api/v1/repos/owner/wiki',
      'https://forge.example:8443/api/v1/repos/owner/wiki/pulls/42',
      'https://forge.example:8443/api/v1/users/alice',
    ]);
    expect(tokenCalls).toBe(4);
    for (const { options } of calls) {
      expect(options.method).toBe('GET');
      expect(options.redirect).toBe('error');
      expect(options.headers.Authorization).toBe('Bearer top-secret-token');
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
    expect(snapshot.repository.id).toBe('731');
    expect(snapshot.pullRequest.author).toEqual({ id: '123', login: 'alice' });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.pullRequest.author)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('top-secret-token');
  });

  test('preflights Forgejo major before repository requests', async () => {
    const calls = [];
    const api = createForgejoApi({
      fetch: queueFetch([jsonResponse({ version: '15.0.0' })], calls),
    });
    await expectCode(() => api.readPullRequest({ config: CONFIG, pullRequestNumber: 42 }), 'unsupported-forgejo-version');
    expect(calls).toHaveLength(1);
  });

  test('rejects repository, pull-request, and refetched-user contradictions', async () => {
    for (const [responses, code] of [
      [validResponses({ repository: repositoryPayload({ clone_url: 'https://forge.example:8443/owner/alias.git' }) }), 'forgejo-repository-mismatch'],
      [validResponses({ pullRequest: pullRequestPayload({ state: 'closed' }) }), 'unsupported-forgejo-pull-request'],
      [validResponses({ pullRequest: pullRequestPayload({ draft: true }) }), 'unsupported-forgejo-pull-request'],
      [validResponses({ pullRequest: pullRequestPayload({ html_url: 'https://forge.example:8443/owner/wiki/pulls/999' }) }), 'pull-request-url-mismatch'],
      [validResponses({ pullRequest: pullRequestPayload({ base: { ...pullRequestPayload().base, ref: 'other' } }) }), 'pull-request-base-mismatch'],
      [validResponses({ user: userPayload({ id: 456 }) }), 'forgejo-user-mismatch'],
      [validResponses({ user: userPayload({ is_bot: true }) }), 'unsupported-forgejo-user'],
      [validResponses({ user: userPayload({ active: false }) }), 'unsupported-forgejo-user'],
      [validResponses({ user: userPayload({ prohibit_login: true }) }), 'unsupported-forgejo-user'],
    ]) {
      const api = createForgejoApi({ fetch: queueFetch(responses) });
      await expectCode(() => api.readPullRequest({ config: CONFIG, pullRequestNumber: 42 }), code);
    }
  });

  test('enforces bounded strict JSON responses', async () => {
    const oversized = new Response('12345', {
      headers: { 'content-length': '5' },
    });
    await expectCode(() => createForgejoApi({
      fetch: queueFetch([oversized]),
      maxBodyBytes: 4,
    }).readPullRequest({ config: CONFIG, pullRequestNumber: 42 }), 'forgejo-response-too-large');

    const invalidUtf8 = new Response(new Uint8Array([0xff]), {
      headers: { 'content-length': '1' },
    });
    await expectCode(() => createForgejoApi({
      fetch: queueFetch([invalidUtf8]),
    }).readPullRequest({ config: CONFIG, pullRequestNumber: 42 }), 'invalid-utf8');

    await expectCode(() => createForgejoApi({
      fetch: queueFetch([new Response('{', { headers: { 'content-length': '1' } })]),
    }).readPullRequest({ config: CONFIG, pullRequestNumber: 42 }), 'invalid-forgejo-json');
  });

  test('fails closed on HTTP and transport errors without exposing credentials', async () => {
    const apiError = createForgejoApi({
      fetch: queueFetch([jsonResponse({ message: 'denied' }, { status: 403 })]),
      getToken: () => 'never-report-this',
    });
    try {
      await apiError.readPullRequest({ config: CONFIG, pullRequestNumber: 42 });
      throw new Error('expected API failure');
    } catch (error) {
      expect(error.code).toBe('forgejo-api-error');
      expect(JSON.stringify(error)).not.toContain('never-report-this');
      expect(error.message).not.toContain('never-report-this');
    }

    await expectCode(() => createForgejoApi({
      fetch: async () => { throw new TypeError('network failed'); },
    }).readPullRequest({ config: CONFIG, pullRequestNumber: 42 }), 'forgejo-request-failed');

    try {
      await createForgejoApi({
        fetch: queueFetch(validResponses()),
        getToken: () => { throw new Error('credential callback leaked-secret'); },
      }).readPullRequest({ config: CONFIG, pullRequestNumber: 42 });
      throw new Error('expected token failure');
    } catch (error) {
      expect(error.code).toBe('forgejo-token-failed');
      expect(error.message).not.toContain('leaked-secret');
      expect(JSON.stringify(error)).not.toContain('leaked-secret');
    }
  });

  test('uses one overall deadline and honors caller abort', async () => {
    const timeoutApi = createForgejoApi({
      fetch: () => new Promise(() => {}),
      setTimer: (callback) => {
        queueMicrotask(callback);
        return 1;
      },
      clearTimer: () => {},
    });
    await expectCode(() => timeoutApi.readPullRequest({
      config: CONFIG,
      pullRequestNumber: 42,
    }), 'forgejo-intake-timeout');

    const stalledBodyApi = createForgejoApi({
      fetch: async () => new Response(new ReadableStream({ start() {} })),
      setTimer: (callback) => {
        queueMicrotask(callback);
        return 1;
      },
      clearTimer: () => {},
    });
    await expectCode(() => stalledBodyApi.readPullRequest({
      config: CONFIG,
      pullRequestNumber: 42,
    }), 'forgejo-intake-timeout');

    const controller = new AbortController();
    controller.abort(new DOMException('stop', 'AbortError'));
    const abortedApi = createForgejoApi({ fetch: queueFetch(validResponses()) });
    await expectCode(() => abortedApi.readPullRequest({
      config: CONFIG,
      pullRequestNumber: 42,
      signal: controller.signal,
    }), 'forgejo-intake-aborted');
  });
});
