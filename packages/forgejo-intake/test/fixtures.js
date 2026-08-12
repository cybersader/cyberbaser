import { expect } from 'bun:test';
import { ForgejoIntakeError } from '../src/index.js';

export const BASE_SHA = '1111111111111111111111111111111111111111';
export const HEAD_SHA = '2222222222222222222222222222222222222222';
export const CONFIG = {
  schemaVersion: 1,
  forgejo: {
    apiBaseUrl: 'https://forge.example:8443/api/v1',
  },
  repository: {
    url: 'https://forge.example:8443/owner/wiki.git',
    owner: 'owner',
    name: 'wiki',
    baseBranch: 'main',
  },
};

export function repositoryPayload(overrides = {}) {
  return {
    id: 731,
    full_name: 'owner/wiki',
    clone_url: CONFIG.repository.url,
    default_branch: 'main',
    ...overrides,
  };
}

export function pullRequestPayload(overrides = {}) {
  return {
    number: 42,
    state: 'open',
    draft: false,
    html_url: 'https://forge.example:8443/owner/wiki/pulls/42',
    title: 'Correct one typo',
    body: 'Preserve every untouched byte.',
    created_at: '2026-08-10T12:34:56.789Z',
    user: { id: 123, login: 'alice' },
    base: {
      ref: 'main',
      sha: BASE_SHA,
      repo: { id: 731, full_name: 'owner/wiki' },
    },
    head: {
      sha: HEAD_SHA,
      repo: { id: 900, full_name: 'alice/wiki' },
    },
    ...overrides,
  };
}

export function userPayload(overrides = {}) {
  return {
    id: 123,
    login: 'alice',
    active: true,
    prohibit_login: false,
    is_bot: false,
    ...overrides,
  };
}

export function jsonResponse(value, init = {}) {
  const body = JSON.stringify(value);
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      ...(init.headers ?? {}),
    },
  });
}

export function queueFetch(entries, calls = []) {
  const queue = [...entries];
  return async (url, options) => {
    calls.push({ url: url.toString(), options });
    if (queue.length === 0) throw new Error('unexpected fetch');
    const next = queue.shift();
    return typeof next === 'function' ? next(url, options) : next;
  };
}

export function expectCode(callback, code) {
  try {
    const value = callback();
    if (value && typeof value.then === 'function') {
      return value.then(
        () => { throw new Error(`expected ${code}`); },
        (error) => {
          expect(error).toBeInstanceOf(ForgejoIntakeError);
          if (code !== undefined) expect(error.code).toBe(code);
        },
      );
    }
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ForgejoIntakeError);
    if (code !== undefined) expect(error.code).toBe(code);
  }
}
