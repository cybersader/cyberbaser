import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { validateOwnerAlphaConfig } from '../src/config.js';
import { OwnerAlphaError } from '../src/errors.js';
import {
  createMemoryEditSessionStore,
  createOwnerAlphaHandler,
  createReaderHandler,
  recoverOwnerAlphaJobs,
  runOwnerAlphaServer,
  startOwnerAlphaServer,
  startReaderServer,
} from '../src/server.js';

const execFileAsync = promisify(execFile);

const APP_ROOT = path.resolve(import.meta.dir, '..');
const EXAMPLE = path.join(APP_ROOT, 'owner-alpha.example.json');
const ORIGIN = 'http://127.0.0.1:4317';
const HOST = '127.0.0.1:4317';
const READER_ORIGIN = 'http://127.0.0.1:4318';
const READER_HOST = '127.0.0.1:4318';
const TOKENS = Object.freeze({
  process: 'a'.repeat(43),
  csrf: 'b'.repeat(43),
  bootstrap: 'c'.repeat(43),
  edit: 'd'.repeat(43),
});
const cleanup = [];

async function exampleConfig(change = null) {
  const raw = JSON.parse(await readFile(EXAMPLE, 'utf8'));
  change?.(raw);
  return validateOwnerAlphaConfig(raw);
}

function request(pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Request(`${ORIGIN}${pathname}`, {
    method,
    headers: { Host: HOST, ...headers },
    body,
  });
}

function readerRequest(pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Request(`${READER_ORIGIN}${pathname}`, {
    method,
    headers: { Host: READER_HOST, ...headers },
    body,
  });
}

async function privateConfigFile(root) {
  const file = path.join(root, 'owner-alpha.local.json');
  await writeFile(file, await readFile(EXAMPLE), { mode: 0o600 });
  return file;
}

function tokenFactory(...values) {
  let index = 0;
  return () => values[index++];
}

function fixtureJob(jobId = 'job-1') {
  return {
    jobId,
    state: 'checking',
    revision: 2,
    createdAt: '2026-07-31T10:00:00.000Z',
    updatedAt: '2026-07-31T10:00:02.000Z',
    recovery: {
      classification: 'restart-safe',
      automatic: true,
      instruction: 'Discard incomplete check output and rerun deterministic checks.',
    },
    failure: null,
    privatePath: '/private/cyberbase/Notes/Page.md',
    secret: 'must-not-leak',
  };
}

async function handlerFixture({
  source = '---\ntitle: Exact & <source>\n---\n\nBody\n',
  saveEdit = async () => ({ jobId: 'job-1', state: 'accepted' }),
  lookupJob = async (jobId) => fixtureJob(jobId),
  siteRoot,
  publicRoot,
  config: configInput,
} = {}) {
  const config = configInput ?? await exampleConfig();
  const calls = [];
  const editSessions = createMemoryEditSessionStore({
    createToken: () => TOKENS.edit,
  });
  const fetch = createOwnerAlphaHandler({
    config,
    siteRoot,
    publicRoot,
    editSessions,
    createToken: tokenFactory(TOKENS.process, TOKENS.csrf, TOKENS.bootstrap),
    createJobId: () => 'job-accepted',
    createEditSession: async (input) => {
      calls.push(input);
      return { source: { text: source }, relativePath: input.renderer.relativePath, slug: input.renderer.slug };
    },
    saveEdit,
    lookupJob,
  });
  return { config, fetch, calls };
}

async function readerFixture({ siteRoot, config: configInput } = {}) {
  const config = configInput ?? await exampleConfig();
  return {
    config,
    fetch: createReaderHandler({ config, siteRoot }),
  };
}

async function openEdit(fetch, query = 'relativePath=Notes%2FPage.md&slug=Notes%2Fpage') {
  const bootstrap = await fetch(request(`/owner/bootstrap?token=${TOKENS.bootstrap}`));
  const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
  const response = await fetch(request(`/owner/edit?${query}`, { headers: { Cookie: cookie } }));
  const body = await response.text();
  const csrf = body.match(/data-csrf="([^"]+)"/u)?.[1];
  const editSessionId = body.match(/data-edit-session-id="([^"]+)"/u)?.[1];
  return { bootstrap, response, body, cookie, csrf, editSessionId };
}

async function saveRequest(fetch, open, overrides = {}, headers = {}) {
  return fetch(request('/api/edits', {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      Cookie: open.cookie,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({
      editSessionId: open.editSessionId,
      editedText: 'changed\n',
      csrf: open.csrf,
      ...overrides,
    }),
  }));
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('owner-alpha loopback server boundary', () => {
  test('binds Bun only to the validated numeric loopback host and configured port', async () => {
    const config = await exampleConfig();
    let options;
    const server = { stop() {} };
    const result = startOwnerAlphaServer({
      config,
      fetch: () => new Response('ok'),
      serve(value) {
        options = value;
        return server;
      },
    });

    expect(result).toBe(server);
    expect(options.hostname).toBe('127.0.0.1');
    expect(options.port).toBe(4317);
    expect(typeof options.fetch).toBe('function');

    const readerResult = startReaderServer({
      config,
      fetch: () => new Response('ok'),
      serve(value) {
        options = value;
        return server;
      },
    });
    expect(readerResult).toBe(server);
    expect(options.hostname).toBe('127.0.0.1');
    expect(options.port).toBe(4318);
  });

  test('requires the exact Host header and does not accept aliases', async () => {
    const { fetch } = await handlerFixture();
    for (const host of ['localhost:4317', '127.0.0.1', '127.0.0.1:80', 'evil.invalid']) {
      const response = await fetch(new Request(`${ORIGIN}/owner/edit?relativePath=Notes%2FPage.md&slug=Notes%2Fpage`, {
        headers: { Host: host },
      }));
      expect(response.status).toBe(421);
      expect(await response.json()).toEqual({ error: { code: 'invalid-host' } });
    }
  });

  test('emits strict browser security headers and an HttpOnly Strict process cookie', async () => {
    const { fetch } = await handlerFixture();
    const opened = await openEdit(fetch);

    expect(opened.response.status).toBe(200);
    expect(opened.response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(opened.response.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(opened.response.headers.get('content-security-policy')).not.toContain("'unsafe-inline'");
    expect(opened.response.headers.get('x-frame-options')).toBe('DENY');
    expect(opened.bootstrap.status).toBe(303);
    expect(opened.bootstrap.headers.get('location')).toBe(`${READER_ORIGIN}/cyberbase/`);
    expect(opened.bootstrap.headers.get('set-cookie')).toBe(
      `owner_alpha_session=${TOKENS.process}; Path=/; HttpOnly; SameSite=Strict`,
    );
    expect(opened.response.headers.get('set-cookie')).toBeNull();
  });

  test('requires one process bootstrap before any owner route becomes readable', async () => {
    const { fetch } = await handlerFixture();
    const denied = await fetch(request('/owner/edit?relativePath=Notes%2FPage.md&slug=Notes%2Fpage'));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: { code: 'invalid-session' } });

    const invalid = await fetch(request(`/owner/bootstrap?token=${'z'.repeat(43)}`));
    expect(invalid.status).toBe(403);
    const opened = await openEdit(fetch);
    expect(opened.response.status).toBe(200);

    const replay = await fetch(request(`/owner/bootstrap?token=${TOKENS.bootstrap}`));
    expect(replay.status).toBe(403);
    expect(await replay.json()).toEqual({ error: { code: 'invalid-bootstrap' } });
  });
});

describe('configured private-address server boundary', () => {
  const PRIVATE_HOST = '100.100.100.100';
  const PRIVATE_ORIGIN = `http://${PRIVATE_HOST}:4317`;

  async function privateFixture() {
    return handlerFixture({
      config: await exampleConfig((raw) => { raw.listen.host = PRIVATE_HOST; }),
    });
  }

  function privateRequest(pathname, { method = 'GET', headers = {}, body } = {}) {
    return new Request(`${PRIVATE_ORIGIN}${pathname}`, {
      method,
      headers: { Host: `${PRIVATE_HOST}:4317`, ...headers },
      body,
    });
  }

  test('passes the exact configured private host to both Bun servers', async () => {
    const config = await exampleConfig((raw) => { raw.listen.host = PRIVATE_HOST; });
    const seen = [];
    const server = { stop() {} };
    startOwnerAlphaServer({
      config,
      fetch: () => new Response('ok'),
      serve(options) {
        seen.push({ hostname: options.hostname, port: options.port });
        return server;
      },
    });
    startReaderServer({
      config,
      fetch: () => new Response('ok'),
      serve(options) {
        seen.push({ hostname: options.hostname, port: options.port });
        return server;
      },
    });
    expect(seen).toEqual([
      { hostname: PRIVATE_HOST, port: 4317 },
      { hostname: PRIVATE_HOST, port: 4318 },
    ]);
  });

  test('accepts only the configured private Host and rejects loopback aliases', async () => {
    const { fetch } = await privateFixture();
    const bootstrap = await fetch(privateRequest(`/owner/bootstrap?token=${TOKENS.bootstrap}`));
    expect(bootstrap.status).toBe(303);
    expect(bootstrap.headers.get('location')).toBe(`http://${PRIVATE_HOST}:4318/cyberbase/`);

    for (const host of ['127.0.0.1:4317', 'localhost:4317', '100.100.100.101:4317', `${PRIVATE_HOST}:4318`]) {
      const response = await fetch(new Request(`http://${host}/owner/edit?relativePath=Notes%2FPage.md&slug=Notes%2Fpage`, {
        headers: { Host: host },
      }));
      expect(response.status).toBe(421);
    }
  });
});

describe('per-device owner sessions', () => {
  const DEVICE_TWO = Object.freeze({
    session: 'e'.repeat(43),
    csrf: 'f'.repeat(43),
    bootstrap: 'g'.repeat(43),
  });
  const DEVICE_THREE = Object.freeze({
    session: 'h'.repeat(43),
    csrf: 'i'.repeat(43),
    bootstrap: 'j'.repeat(43),
  });

  async function multiDeviceFixture() {
    const config = await exampleConfig();
    // The store loops until the token is unused, so multi-open tests need
    // distinct edit-session tokens.
    let editCount = 0;
    const editSessions = createMemoryEditSessionStore({
      createToken: () => `${TOKENS.edit.slice(0, 41)}${String(editCount++).padStart(2, '0')}`,
    });
    const fetch = createOwnerAlphaHandler({
      config,
      editSessions,
      createToken: tokenFactory(
        TOKENS.process, TOKENS.csrf, TOKENS.bootstrap,
        DEVICE_TWO.session, DEVICE_TWO.csrf, DEVICE_TWO.bootstrap,
        DEVICE_THREE.session, DEVICE_THREE.csrf, DEVICE_THREE.bootstrap,
      ),
      createJobId: () => 'job-accepted',
      createEditSession: async (input) => ({
        source: { text: '---\ntitle: T\n---\n\nBody\n' },
        relativePath: input.renderer.relativePath,
        slug: input.renderer.slug,
      }),
      saveEdit: async () => ({ jobId: 'job-accepted', state: 'accepted' }),
      lookupJob: async (jobId) => fixtureJob(jobId),
    });
    return { fetch };
  }

  test('each consumed bootstrap issues a distinct session cookie and CSRF token', async () => {
    const { fetch } = await multiDeviceFixture();
    const first = await openEdit(fetch);
    expect(first.cookie).toBe(`owner_alpha_session=${TOKENS.process}`);
    expect(first.csrf).toBe(TOKENS.csrf);

    const second = fetch.issueBootstrap();
    expect(second).toBe(DEVICE_TWO.bootstrap);
    const bootstrapped = await fetch(request(`/owner/bootstrap?token=${second}`));
    expect(bootstrapped.status).toBe(303);
    const secondCookie = bootstrapped.headers.get('set-cookie').split(';', 1)[0];
    expect(secondCookie).toBe(`owner_alpha_session=${DEVICE_TWO.session}`);

    const secondEdit = await fetch(request('/owner/edit?relativePath=Notes%2FPage.md&slug=Notes%2Fpage', {
      headers: { Cookie: secondCookie },
    }));
    expect(secondEdit.status).toBe(200);
    const secondCsrf = (await secondEdit.text()).match(/data-csrf="([^"]+)"/u)?.[1];
    expect(secondCsrf).toBe(DEVICE_TWO.csrf);

    const firstStillValid = await fetch(request('/owner/edit?relativePath=Notes%2FPage.md&slug=Notes%2Fpage', {
      headers: { Cookie: first.cookie },
    }));
    expect(firstStillValid.status).toBe(200);
  });

  test('rejects a Save that pairs one device cookie with another device CSRF token', async () => {
    const { fetch } = await multiDeviceFixture();
    const first = await openEdit(fetch);
    const bootstrapped = await fetch(request(`/owner/bootstrap?token=${fetch.issueBootstrap()}`));
    const secondCookie = bootstrapped.headers.get('set-cookie').split(';', 1)[0];

    const crossed = await fetch(request('/api/edits', {
      method: 'POST',
      headers: { Origin: ORIGIN, Cookie: secondCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        editSessionId: first.editSessionId,
        editedText: 'changed\n',
        csrf: first.csrf,
      }),
    }));
    expect(crossed.status).toBe(403);
    expect(await crossed.json()).toEqual({ error: { code: 'invalid-csrf' } });
  });

  test('re-arming replaces only the unused bootstrap link and never active sessions', async () => {
    const { fetch } = await multiDeviceFixture();
    const first = await openEdit(fetch);

    const armed = fetch.issueBootstrap();
    const rearmed = fetch.issueBootstrap();
    expect(rearmed).not.toBe(armed);

    const staleLink = await fetch(request(`/owner/bootstrap?token=${armed}`));
    expect(staleLink.status).toBe(403);

    const freshLink = await fetch(request(`/owner/bootstrap?token=${rearmed}`));
    expect(freshLink.status).toBe(303);

    const firstStillValid = await fetch(request('/owner/edit?relativePath=Notes%2FPage.md&slug=Notes%2Fpage', {
      headers: { Cookie: first.cookie },
    }));
    expect(firstStillValid.status).toBe(200);
  });
});

describe('owner-alpha runtime startup', () => {
  test('builds before binding, then serves browse, edit, Save, and status through one runtime', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'owner-alpha-runtime-'));
    cleanup.push(projectRoot);
    await execFileAsync('git', ['init', '-q', projectRoot]);
    await writeFile(path.join(projectRoot, '.gitignore'), '.workspace/\n');
    const events = [];
    let ownerFetch;
    let readerFetch;
    const configFile = await privateConfigFile(projectRoot);

    const started = await runOwnerAlphaServer({
      configFile,
      projectRoot,
      rebuildSite: async ({ config, projectRoot: receivedRoot }) => {
        events.push('rebuild');
        expect(config.listen.port).toBe(4317);
        expect(receivedRoot).toBe(projectRoot);
        const siteRoot = path.join(projectRoot, config.workspace.site);
        await mkdir(siteRoot, { recursive: true });
        await writeFile(path.join(siteRoot, 'index.html'), '<!doctype html><h1>Runtime Cyberbase</h1>');
      },
      loadPipeline: async ({ config, projectRoot: receivedRoot, context }) => {
        events.push('pipeline');
        expect(config.listen.port).toBe(4317);
        expect(receivedRoot).toBe(projectRoot);
        expect(context.storeRoot).toBe(path.join(projectRoot, '.workspace/owner-alpha/store'));
        return {
          saveEdit: async ({ jobId }) => ({ jobId, state: 'accepted' }),
          getJob: async (jobId) => fixtureJob(jobId),
        };
      },
      createHandler: (options) => createOwnerAlphaHandler({
        ...options,
        createToken: tokenFactory(TOKENS.process, TOKENS.csrf, TOKENS.bootstrap),
        createJobId: () => 'job-runtime',
        createEditSession: async () => ({ source: { text: '# Runtime source\n' } }),
      }),
      serve(options) {
        events.push(`serve-${options.port}`);
        expect(options.hostname).toBe('127.0.0.1');
        if (options.port === 4317) ownerFetch = options.fetch;
        else if (options.port === 4318) readerFetch = options.fetch;
        else throw new Error(`unexpected port ${options.port}`);
        return { stop() {}, url: new URL(`http://127.0.0.1:${options.port}`) };
      },
    });

    expect(started.ownerOrigin).toBe(ORIGIN);
    expect(started.readerOrigin).toBe(READER_ORIGIN);
    expect(started.bootstrapToken).toBe(TOKENS.bootstrap);
    expect(await started.recovery).toEqual([]);
    expect(events).toEqual(['rebuild', 'pipeline', 'serve-4317', 'serve-4318']);

    const browsed = await readerFetch(readerRequest('/cyberbase/'));
    expect(browsed.status).toBe(200);
    expect(await browsed.text()).toContain('Runtime Cyberbase');

    const opened = await openEdit(ownerFetch);
    expect(opened.response.status).toBe(200);
    expect(opened.body).toContain('# Runtime source');

    const saved = await saveRequest(ownerFetch, opened, { editedText: '# Updated runtime source\n' });
    expect(saved.status).toBe(202);
    expect(await saved.json()).toEqual({
      jobId: 'job-runtime',
      state: 'accepted',
      statusUrl: '/owner/jobs/job-runtime',
      jsonUrl: '/api/jobs/job-runtime',
    });

    const status = await ownerFetch(request('/api/jobs/job-runtime', {
      headers: { Cookie: opened.cookie },
    }));
    expect(status.status).toBe(200);
    expect((await status.json()).state).toBe('checking');
  });
});

describe('automatic startup recovery', () => {
  test('enumerates durable jobs and resumes only states marked automatic', async () => {
    const config = await exampleConfig();
    const resumed = [];
    const results = await recoverOwnerAlphaJobs({
      config,
      context: {},
      listJobs: async () => [
        { jobId: 'job-accepted', recovery: { automatic: true } },
        { jobId: 'job-completed', recovery: { automatic: false } },
        { jobId: 'job-live-retry', recovery: { automatic: true } },
      ],
      pipeline: {
        async resumeJob({ jobId }) {
          resumed.push(jobId);
          return { jobId, state: 'completed' };
        },
      },
    });

    expect(resumed).toEqual(['job-accepted', 'job-live-retry']);
    expect(results.map((result) => result.jobId)).toEqual(resumed);
  });

  test('fails closed when resumable durable jobs have no resume adapter', async () => {
    const config = await exampleConfig();
    try {
      await recoverOwnerAlphaJobs({
        config,
        context: {},
        listJobs: async () => [{ jobId: 'job-accepted', recovery: { automatic: true } }],
        pipeline: {},
      });
    } catch (error) {
      expect(error).toBeInstanceOf(OwnerAlphaError);
      expect(error.code).toBe('automatic-recovery-unavailable');
      return;
    }
    throw new Error('expected automatic recovery to fail closed');
  });
});

describe('server-side edit sessions and one Save', () => {
  test('accepts only relativePath and slug, creates the source session server-side, and preserves textarea bytes', async () => {
    const source = '\n&<textarea>\n</textarea>\n';
    const { fetch, calls } = await handlerFixture({ source });
    const opened = await openEdit(fetch);

    expect(opened.response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].renderer).toEqual({ relativePath: 'Notes/Page.md', slug: 'Notes/page' });
    expect(opened.body).toContain(`<textarea id="edited-text" name="editedText" spellcheck="false" autocomplete="off">\n\n&amp;&lt;textarea>\n&lt;/textarea>\n</textarea>`);
    expect(opened.body.match(/<button\b/gu)).toHaveLength(1);
    expect(opened.body).toContain('Save and publish');
    expect(opened.body).not.toContain('Apply');
    expect(opened.body).not.toContain('Commit');
    expect(opened.body).not.toContain('Push');
    expect(opened.body).not.toContain('Deploy');
  });

  test('rejects aliases, duplicate parameters, and unknown edit query fields', async () => {
    const { fetch, calls } = await handlerFixture();
    const bootstrap = await fetch(request(`/owner/bootstrap?token=${TOKENS.bootstrap}`));
    const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
    const queries = [
      'path=Notes%2FPage.md&slug=Notes%2Fpage',
      'relativePath=Notes%2FPage.md&relativePath=Other.md&slug=Notes%2Fpage',
      'relativePath=Notes%2FPage.md&slug=Notes%2Fpage&root=%2Ftmp',
    ];
    for (const query of queries) {
      const response = await fetch(request(`/owner/edit?${query}`, { headers: { Cookie: cookie } }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: 'invalid-edit-query' } });
    }
    expect(calls).toHaveLength(0);
  });

  test('rejects missing or cross-origin POSTs before calling the Save pipeline', async () => {
    let saves = 0;
    const { fetch } = await handlerFixture({ saveEdit: async () => { saves += 1; } });
    const opened = await openEdit(fetch);

    for (const origin of [null, 'http://localhost:4317', 'https://127.0.0.1:4317', 'https://evil.invalid']) {
      const headers = {
        Cookie: opened.cookie,
        'Content-Type': 'application/json',
      };
      if (origin !== null) headers.Origin = origin;
      const response = await fetch(request('/api/edits', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          editSessionId: opened.editSessionId,
          editedText: 'changed\n',
          csrf: opened.csrf,
        }),
      }));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: { code: 'invalid-origin' } });
    }
    expect(saves).toBe(0);
  });

  test('requires the process cookie and CSRF token, then sends only bound session and edited text to Save', async () => {
    const saves = [];
    const { fetch } = await handlerFixture({
      saveEdit: async (input) => {
        saves.push(input);
        return { jobId: 'job-accepted', state: 'accepted' };
      },
    });
    const opened = await openEdit(fetch);

    const noCookie = await fetch(request('/api/edits', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: '{}',
    }));
    expect(noCookie.status).toBe(403);

    const badCsrf = await saveRequest(fetch, opened, { csrf: 'd'.repeat(43) });
    expect(badCsrf.status).toBe(403);
    expect(saves).toHaveLength(0);

    const accepted = await saveRequest(fetch, opened, { editedText: 'exact edited text\n' });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({
      jobId: 'job-accepted',
      state: 'accepted',
      statusUrl: '/owner/jobs/job-accepted',
      jsonUrl: '/api/jobs/job-accepted',
    });
    expect(saves).toEqual([{
      jobId: 'job-accepted',
      session: {
        source: { text: '---\ntitle: Exact & <source>\n---\n\nBody\n' },
        relativePath: 'Notes/Page.md',
        slug: 'Notes/page',
      },
      editedText: 'exact edited text\n',
    }]);

    const replay = await saveRequest(fetch, opened);
    expect(replay.status).toBe(410);
    expect(saves).toHaveLength(1);
  });

  test('returns 202 only after Save reports exact durable acceptance', async () => {
    let accept;
    let settled = false;
    const acceptance = new Promise((resolve) => { accept = resolve; });
    const { fetch } = await handlerFixture({
      saveEdit: () => acceptance,
      lookupJob: async () => { throw new Error('Save acceptance must not be inferred by polling'); },
    });
    const opened = await openEdit(fetch);

    const pending = saveRequest(fetch, opened).then((value) => {
      settled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    accept({ jobId: 'job-accepted', state: 'accepted' });
    const accepted = await pending;
    expect(accepted.status).toBe(202);
    expect((await accepted.json()).jobId).toBe('job-accepted');
  });

  test('returns a startup pipeline error instead of issuing a phantom job route', async () => {
    const { fetch } = await handlerFixture({
      saveEdit: async () => { throw new OwnerAlphaError('lock-busy', 'busy'); },
      lookupJob: async () => null,
    });
    const opened = await openEdit(fetch);

    const rejected = await saveRequest(fetch, opened);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ error: { code: 'lock-busy' } });
  });

  test('does not return an error while local durable acceptance is still pending', async () => {
    const config = await exampleConfig((raw) => { raw.limits.requestTimeoutMs = 50; });
    const { fetch } = await handlerFixture({
      config,
      saveEdit: async () => {
        await new Promise((resolve) => setTimeout(resolve, 75));
        return { jobId: 'job-accepted', state: 'accepted' };
      },
    });
    const opened = await openEdit(fetch);

    const accepted = await saveRequest(fetch, opened);
    expect(accepted.status).toBe(202);
    expect((await accepted.json()).state).toBe('accepted');
  });

  test('enforces JSON content type, a closed body shape, edited byte limits, and total body limits', async () => {
    const config = await exampleConfig((raw) => {
      raw.limits.maxReplacementBytes = 8;
      raw.limits.maxChangedBytes = 16;
      raw.limits.maxSourceBytes = 32;
      raw.limits.maxArtifactBytes = 512;
    });
    const { fetch } = await handlerFixture({ config });
    const opened = await openEdit(fetch);

    const wrongType = await fetch(request('/api/edits', {
      method: 'POST',
      headers: { Origin: ORIGIN, Cookie: opened.cookie, 'Content-Type': 'text/plain' },
      body: '{}',
    }));
    expect(wrongType.status).toBe(415);

    const invalidUtf8 = await fetch(request('/api/edits', {
      method: 'POST',
      headers: { Origin: ORIGIN, Cookie: opened.cookie, 'Content-Type': 'application/json' },
      body: new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    }));
    expect(invalidUtf8.status).toBe(400);

    const unknown = await saveRequest(fetch, opened, { command: 'git push' });
    expect(unknown.status).toBe(400);

    const editedTooLarge = await saveRequest(fetch, opened, { editedText: 'x'.repeat(33) });
    expect(editedTooLarge.status).toBe(400);

    const bodyTooLarge = await fetch(request('/api/edits', {
      method: 'POST',
      headers: { Origin: ORIGIN, Cookie: opened.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(600) }),
    }));
    expect(bodyTooLarge.status).toBe(413);
  });

  test('expires short-lived edit sessions without invoking Save', async () => {
    let now = 100;
    let saves = 0;
    const config = await exampleConfig();
    const editSessions = createMemoryEditSessionStore({
      ttlMs: 10,
      now: () => now,
      createToken: () => TOKENS.edit,
    });
    const fetch = createOwnerAlphaHandler({
      config,
      editSessions,
      createToken: tokenFactory(TOKENS.process, TOKENS.csrf, TOKENS.bootstrap),
      createEditSession: async () => ({ source: { text: 'source\n' } }),
      saveEdit: async () => { saves += 1; },
      lookupJob: async () => null,
    });
    const opened = await openEdit(fetch);
    now = 111;

    const expired = await saveRequest(fetch, opened);
    expect(expired.status).toBe(410);
    expect(saves).toBe(0);
  });
});

describe('configured Quartz static site', () => {
  test('serves the configured cached site with clean URLs and HEAD support', async () => {
    const siteRoot = await mkdtemp(path.join(os.tmpdir(), 'owner-alpha-site-'));
    cleanup.push(siteRoot);
    await mkdir(path.join(siteRoot, 'notes'), { recursive: true });
    await writeFile(path.join(siteRoot, 'index.html'), '<h1>Quartz home</h1>');
    await writeFile(path.join(siteRoot, 'notes', 'index.html'), '<h1>Notes</h1>');
    await writeFile(path.join(siteRoot, 'notes', 'page.html'), '<h1>Clean URL page</h1>');
    const { fetch } = await readerFixture({ siteRoot });

    const home = await fetch(readerRequest('/cyberbase/'));
    expect(home.status).toBe(200);
    expect(home.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await home.text()).toBe('<h1>Quartz home</h1>');

    const nested = await fetch(readerRequest('/cyberbase/notes/'));
    expect(await nested.text()).toBe('<h1>Notes</h1>');

    const cleanUrl = await fetch(readerRequest('/cyberbase/notes/page'));
    expect(cleanUrl.status).toBe(200);
    expect(cleanUrl.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await cleanUrl.text()).toBe('<h1>Clean URL page</h1>');

    const head = await fetch(readerRequest('/cyberbase/', { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength('<h1>Quartz home</h1>')));

    const privilegedRoute = await fetch(readerRequest('/owner/assets/editor.js'));
    expect(privilegedRoute.status).toBe(404);
  });

  test('serves Quartz scripts only on the unprivileged reader origin', async () => {
    const siteRoot = await mkdtemp(path.join(os.tmpdir(), 'owner-alpha-quartz-csp-'));
    cleanup.push(siteRoot);
    await writeFile(path.join(siteRoot, 'index.html'), `<!doctype html><html><body>
<script src="./prescript.js" type="application/javascript" spa-preserve></script>
<script>const fetchData = fetch("./static/contentIndex.json").then(data => data.json())</script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/copy-tex.min.js"></script>
<script src="./postscript.js" type="module"></script>
</body></html>`);
    const { fetch } = await readerFixture({ siteRoot });

    const response = await fetch(readerRequest('/cyberbase/'));
    const body = await response.text();
    const csp = response.headers.get('content-security-policy');
    expect(response.status).toBe(200);
    expect(body).toContain('<script src="./prescript.js"');
    expect(body).toContain('<script>const fetchData');
    expect(body).toContain('copy-tex.min.js');
    expect(body).toContain('<script src="./postscript.js"');
    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  test('cannot reach owner APIs from the reader origin or without bootstrap state', async () => {
    const siteRoot = await mkdtemp(path.join(os.tmpdir(), 'owner-alpha-quartz-script-'));
    cleanup.push(siteRoot);
    await writeFile(path.join(siteRoot, 'index.html'), '<!doctype html><script>globalThis.readerControlled = true</script>');
    const { fetch: readerFetch } = await readerFixture({ siteRoot });
    const { fetch: ownerFetch } = await handlerFixture();

    const rendered = await readerFetch(readerRequest('/cyberbase/'));
    expect(rendered.status).toBe(200);
    expect(await rendered.text()).toContain('readerControlled');
    const readerApi = await readerFetch(readerRequest('/api/edits', { method: 'POST', body: '{}' }));
    expect(readerApi.status).toBe(405);

    const ownerApi = await ownerFetch(request('/api/edits', {
      method: 'POST',
      headers: { Origin: READER_ORIGIN, 'Content-Type': 'application/json' },
      body: '{}',
    }));
    expect(ownerApi.status).toBe(403);
    expect(await ownerApi.json()).toEqual({ error: { code: 'invalid-session' } });
  });

  test('rejects traversal, encoded separators, symlink files, and symlink directories', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'owner-alpha-static-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'owner-alpha-outside-'));
    cleanup.push(root, outside);
    await writeFile(path.join(outside, 'secret.html'), 'private');
    await symlink(path.join(outside, 'secret.html'), path.join(root, 'linked.html'));
    await symlink(outside, path.join(root, 'linked-dir'));
    const { fetch } = await readerFixture({ siteRoot: root });

    for (const pathname of [
      '/cyberbase/%2Fetc%2Fpasswd',
      '/cyberbase/linked.html',
      '/cyberbase/linked-dir/secret.html',
    ]) {
      const response = await fetch(readerRequest(pathname));
      expect([400, 404]).toContain(response.status);
      expect(await response.text()).not.toContain('private');
    }
  });
});

describe('job status routes', () => {
  test('returns a redacted job projection as JSON and a control-free status page', async () => {
    const { fetch } = await handlerFixture();
    const opened = await openEdit(fetch);
    const api = await fetch(request('/api/jobs/job-1', { headers: { Cookie: opened.cookie } }));
    expect(api.status).toBe(200);
    const body = await api.text();
    expect(body).not.toContain('/private/cyberbase');
    expect(body).not.toContain('must-not-leak');
    expect(JSON.parse(body)).toEqual({
      jobId: 'job-1',
      state: 'checking',
      revision: 2,
      createdAt: '2026-07-31T10:00:00.000Z',
      updatedAt: '2026-07-31T10:00:02.000Z',
      recovery: {
        classification: 'restart-safe',
        automatic: true,
        instruction: 'Discard incomplete check output and rerun deterministic checks.',
      },
      failure: null,
    });

    const page = await fetch(request('/owner/jobs/job-1', { headers: { Cookie: opened.cookie } }));
    const pageBody = await page.text();
    expect(page.status).toBe(200);
    expect(pageBody).toContain('This page reports the durable pipeline state. It has no mutation controls.');
    expect(pageBody).not.toContain('<button');
    expect(pageBody).not.toContain('/private/cyberbase');
    expect(pageBody).not.toContain('must-not-leak');
  });
});
