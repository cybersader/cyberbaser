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
  createOwnerProposalReviewService,
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

async function privateConfigFile(root, change = null) {
  const file = path.join(root, 'owner-alpha.local.json');
  const raw = JSON.parse(await readFile(EXAMPLE, 'utf8'));
  change?.(raw);
  await writeFile(file, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
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

const REVIEW_QUEUE_ID = 'Q-00000000-0000-4000-8000-000000000001';
const REVIEW_DIGEST = `sha-256=:${Buffer.alloc(32, 7).toString('base64')}:`;
const REVIEW_SUMMARY = Object.freeze({
  schemaVersion: 1,
  artifactType: 'cyberbaser-proposal-review-summary',
  queueId: REVIEW_QUEUE_ID,
  proposalId: 'server-review:test',
  proposalDigest: REVIEW_DIGEST,
  candidateDigest: REVIEW_DIGEST,
  reviewEvidenceDigest: REVIEW_DIGEST,
  source: {
    repository: 'https://github.com/cybersader/cyberbase.git',
    revision: 'a'.repeat(40),
    path: 'docs/example.md',
  },
  receivedAt: '2026-08-20T12:00:00Z',
  expiresAt: '2026-08-21T12:00:00Z',
  state: 'pending-review',
  lane: 'lane-b',
  tier: 'anonymous',
  route: 'full-review',
});
const REVIEW_EVIDENCE = Object.freeze({
  queueId: REVIEW_QUEUE_ID,
  proposal: {
    operation: {
      type: 'quote',
      selector: {
        prefix: 'Correct ',
        quote: 'teh',
        suffix: ' safely.',
      },
      start: 13,
      end: 16,
      baseDigest: REVIEW_DIGEST,
      candidateDigest: REVIEW_DIGEST,
      expectedOldBytesBase64: Buffer.from('teh').toString('base64'),
      replacementBytesBase64: Buffer.from('</pre><script>the</script>').toString('base64'),
    },
    submission: {
      rationale: 'Correct </pre><script>globalThis.pwned = true</script> safely.',
      evidence: ['https://example.invalid/evidence?x=1&y=2'],
    },
  },
  classification: {
    verifiedSubject: null,
    policyStatus: 'valid',
    policyDigest: REVIEW_DIGEST,
    classification: {
      tier: 'anonymous',
      route: 'full-review',
      reasons: ['anonymous-contributor'],
      checks: {},
    },
  },
  state: { state: 'pending-review' },
});
const REVIEW_ENTRY = Object.freeze({
  summary: REVIEW_SUMMARY,
  evidence: REVIEW_EVIDENCE,
  sourceVerification: {
    gitObjectId: 'b'.repeat(40),
  },
});
const DECISION_SUMMARY = Object.freeze({
  queueId: REVIEW_QUEUE_ID,
  action: 'approve',
  reason: 'The exact correction is appropriate.',
  decidedAt: '2026-08-20T12:00:01Z',
  reviewEvidenceDigest: REVIEW_DIGEST,
  proposalId: REVIEW_SUMMARY.proposalId,
  proposalDigest: REVIEW_SUMMARY.proposalDigest,
  candidateDigest: REVIEW_SUMMARY.candidateDigest,
  source: REVIEW_SUMMARY.source,
  receivedAt: REVIEW_SUMMARY.receivedAt,
  expiresAt: REVIEW_SUMMARY.expiresAt,
  lane: REVIEW_SUMMARY.lane,
  tier: REVIEW_SUMMARY.tier,
  route: REVIEW_SUMMARY.route,
});
const REVIEW_DECISION = Object.freeze({
  queueId: REVIEW_QUEUE_ID,
  action: 'approve',
  reason: DECISION_SUMMARY.reason,
  decidedAt: DECISION_SUMMARY.decidedAt,
  decisionAuthority: { type: 'owner-alpha-local', identity: 'cybersader' },
  authorityScope: 'decision-only',
  reviewEvidenceDigest: REVIEW_DIGEST,
  reviewEvidence: REVIEW_EVIDENCE,
});

function reviewServiceFixture({ decided = false, recordCalls = [] } = {}) {
  return Object.freeze({
    async list() {
      return {
        actionable: decided ? [] : [REVIEW_ENTRY],
        history: decided ? [{ decision: REVIEW_DECISION, summary: DECISION_SUMMARY, queueRetained: true }] : [],
        historyTruncated: false,
        nextCursor: null,
      };
    },
    async load() {
      return decided
        ? { entry: null, decision: REVIEW_DECISION }
        : { entry: REVIEW_ENTRY, decision: null };
    },
    async loadDecision() {
      return decided
        ? { decision: REVIEW_DECISION, summary: DECISION_SUMMARY, queueRetained: false }
        : null;
    },
    async record(intent) {
      recordCalls.push(intent);
      return {
        decision: REVIEW_DECISION,
        replayed: false,
        index: { decisions: [DECISION_SUMMARY] },
      };
    },
  });
}

async function handlerFixture({
  source = '---\ntitle: Exact & <source>\n---\n\nBody\n',
  saveEdit = async () => ({ jobId: 'job-1', state: 'accepted' }),
  lookupJob = async (jobId) => fixtureJob(jobId),
  siteRoot,
  publicRoot,
  config: configInput,
  proposalReview = null,
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
    proposalReview,
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

async function openReview(fetch, pathname = '/owner/review') {
  const bootstrap = await fetch(request(`/owner/bootstrap?token=${TOKENS.bootstrap}`));
  const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
  const response = await fetch(request(pathname, { headers: { Cookie: cookie } }));
  return { bootstrap, response, body: await response.text(), cookie };
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

describe('privileged proposal review routes', () => {
  async function enabledFixture(options = {}) {
    const config = await exampleConfig((raw) => {
      raw.proposalReview.enabled = true;
      raw.proposalReview.socketPath = '/run/user/1000/cyberbaser/review.sock';
    });
    return handlerFixture({ config, ...options });
  }

  test('keeps every review route unavailable while the exact feature branch is disabled', async () => {
    const { fetch } = await handlerFixture();
    const opened = await openEdit(fetch);
    for (const pathname of [
      '/owner/review',
      `/owner/review/${REVIEW_QUEUE_ID}`,
      `/owner/decisions/${REVIEW_QUEUE_ID}`,
      '/api/review',
    ]) {
      const response = await fetch(request(pathname, { headers: { Cookie: opened.cookie } }));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { code: 'proposal-review-disabled' } });
    }
  });

  test('renders a content-first inbox and escaped editorial detail under the owner CSP', async () => {
    const { fetch } = await enabledFixture({ proposalReview: reviewServiceFixture() });
    const opened = await openReview(fetch);
    expect(opened.response.status).toBe(200);
    expect(opened.body).toContain('<h1>Proposals</h1>');
    expect(opened.body).toContain('Needs review');
    expect(opened.body).toContain('Decided');
    expect(opened.body).toContain('docs/example.md');
    expect(opened.body).toContain('changed-proposed');
    expect(opened.body).toContain('source remains unchanged');
    expect(opened.body).not.toContain('<dt>Queue ID</dt>');
    expect(opened.body).not.toContain('<dt>Trust</dt>');
    expect(opened.response.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(opened.response.headers.get('content-security-policy')).not.toContain("'unsafe-inline'");

    const edit = await fetch(request('/owner/edit?relativePath=Notes%2FPage.md&slug=Notes%2Fpage', {
      headers: { Cookie: opened.cookie },
    }));
    expect(await edit.text()).toContain('<a href="/owner/review">Review proposals</a>');

    const detail = await fetch(request(`/owner/review/${REVIEW_QUEUE_ID}`, {
      headers: { Cookie: opened.cookie },
    }));
    const detailBody = await detail.text();
    expect(detail.status).toBe(200);
    expect(detailBody).toContain('Review “teh” to “&lt;/pre&gt;&lt;script&gt;the&lt;/script&gt;”');
    expect(detailBody).toContain('<nav class="review-modes" aria-label="Review mode">');
    for (const mode of ['changes', 'proposed', 'current', 'compare']) {
      expect(detailBody).toContain(`?mode=${mode}"`);
    }
    expect(detailBody).toContain('aria-current="page"');
    expect(detailBody).toContain('<div class="mode-panel mode-panel-changes">');
    expect(detailBody).toContain('<aside class="decision-dock" aria-label="Your decision">');
    expect(detailBody).toContain('Decide this proposal');
    expect(detailBody).toContain('<details class="technical-evidence">');
    expect(detailBody).toContain('<summary>Technical evidence</summary>');
    expect(detailBody).toContain('Decision note');
    expect(detailBody).toContain('type="button" data-action="reject"');
    expect(detailBody).toContain('type="button" data-action="approve"');
    expect(detailBody).toContain('<dialog id="decision-dialog"');
    expect(detailBody).toContain('Source remains unchanged');
    expect(detailBody).toContain('anonymous-contributor');
    expect(detailBody).toContain('&lt;/pre&gt;&lt;script&gt;the&lt;/script&gt;');
    expect(detailBody).toContain('Correct &lt;/pre&gt;&lt;script&gt;globalThis.pwned = true&lt;/script&gt; safely.');
    expect(detailBody).not.toContain('<script>globalThis.pwned');
    expect(detailBody).toContain('data-max-reason-bytes="4096"');
    expect(detailBody).toContain('<script src="/owner/assets/review.js" defer></script>');

    const asset = await fetch(request('/owner/assets/review.js', {
      headers: { Cookie: opened.cookie },
    }));
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    const assetBody = await asset.text();
    expect(assetBody).toContain('reviewEvidenceDigest');
    expect(assetBody).toContain('showModal');
    expect(assetBody).toContain("event.key === 'ArrowRight'");
    expect(assetBody).not.toContain('data-review-tab');
  });

  test('labels offset-bound proposals honestly when no quote context is available', async () => {
    const offsetEntry = structuredClone(REVIEW_ENTRY);
    offsetEntry.evidence.proposal.operation.type = 'offset';
    offsetEntry.evidence.proposal.operation.selector = null;
    const service = {
      ...reviewServiceFixture(),
      async load() { return { entry: offsetEntry, decision: null }; },
    };
    const { fetch } = await enabledFixture({ proposalReview: service });
    const opened = await openReview(fetch, `/owner/review/${REVIEW_QUEUE_ID}`);
    expect(opened.response.status).toBe(200);
    expect(opened.body).toContain('Offset operation at bytes 13–16.');
    const compared = await fetch(request(`/owner/review/${REVIEW_QUEUE_ID}?mode=compare`, {
      headers: { Cookie: opened.cookie },
    }));
    const comparedBody = await compared.text();
    expect(compared.status).toBe(200);
    expect(comparedBody).toContain('This offset-bound proposal does not include surrounding quote context.');
    expect(comparedBody).toContain('<div class="mode-panel mode-panel-compare">');
  });

  test('returns bounded review projections and rejects unknown or duplicate list queries', async () => {
    const { fetch } = await enabledFixture({ proposalReview: reviewServiceFixture() });
    const opened = await openReview(fetch);
    const api = await fetch(request('/api/review', { headers: { Cookie: opened.cookie } }));
    expect(api.status).toBe(200);
    const body = await api.json();
    expect(body.actionable).toEqual([{
      summary: REVIEW_SUMMARY,
      sourceVerification: REVIEW_ENTRY.sourceVerification,
    }]);
    expect(JSON.stringify(body)).not.toContain('globalThis.pwned');

    for (const pathname of ['/owner/review?state=expired', '/owner/review?cursor=a&cursor=b']) {
      const invalid = await fetch(request(pathname, { headers: { Cookie: opened.cookie } }));
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: { code: 'invalid-review-query' } });
    }
  });

  test('keeps verified reading text out of list and detail JSON projections', async () => {
    const entry = {
      ...REVIEW_ENTRY,
      document: { baseText: 'private-base-sentinel', candidateText: 'private-candidate-sentinel', reason: null },
    };
    const service = {
      ...reviewServiceFixture(),
      async list() {
        return { actionable: [entry], history: [], historyTruncated: false, nextCursor: null };
      },
      async load() { return { entry, decision: null }; },
    };
    const { fetch } = await enabledFixture({ proposalReview: service });
    const opened = await openReview(fetch);
    for (const pathname of ['/api/review', `/api/review/${REVIEW_QUEUE_ID}`]) {
      const result = await fetch(request(pathname, { headers: { Cookie: opened.cookie } }));
      expect(result.status).toBe(200);
      const payload = await result.json();
      expect(JSON.stringify(payload)).not.toContain('private-base-sentinel');
      expect(JSON.stringify(payload)).not.toContain('private-candidate-sentinel');
      expect(payload.document).toBeUndefined();
    }
  });

  test('requires exact Origin, per-device CSRF, closed JSON, and server-side evidence reload for decisions', async () => {
    const calls = [];
    const { fetch } = await enabledFixture({
      proposalReview: reviewServiceFixture({ recordCalls: calls }),
    });
    const opened = await openReview(fetch, `/owner/review/${REVIEW_QUEUE_ID}`);
    const decisionPath = `/api/review/${REVIEW_QUEUE_ID}/decision`;
    const body = {
      queueId: REVIEW_QUEUE_ID,
      reviewEvidenceDigest: REVIEW_DIGEST,
      action: 'approve',
      reason: 'The exact correction is appropriate.',
      csrf: TOKENS.csrf,
    };

    const crossOrigin = await fetch(request(decisionPath, {
      method: 'POST',
      headers: { Origin: 'https://evil.invalid', Cookie: opened.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
    expect(crossOrigin.status).toBe(403);

    const badCsrf = await fetch(request(decisionPath, {
      method: 'POST',
      headers: { Origin: ORIGIN, Cookie: opened.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, csrf: 'z'.repeat(43) }),
    }));
    expect(badCsrf.status).toBe(403);

    const unknown = await fetch(request(decisionPath, {
      method: 'POST',
      headers: { Origin: ORIGIN, Cookie: opened.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, source: '/tmp/canonical.md' }),
    }));
    expect(unknown.status).toBe(400);

    const accepted = await fetch(request(decisionPath, {
      method: 'POST',
      headers: { Origin: ORIGIN, Cookie: opened.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({
      queueId: REVIEW_QUEUE_ID,
      action: 'approve',
      replayed: false,
      statusUrl: `/owner/decisions/${REVIEW_QUEUE_ID}`,
    });
    expect(calls).toEqual([{
      queueId: REVIEW_QUEUE_ID,
      reviewEvidenceDigest: REVIEW_DIGEST,
      action: 'approve',
      reason: 'The exact correction is appropriate.',
    }]);
  });

  test('maps decision contention and stale snapshot cursors to bounded retry responses', async () => {
    const config = await exampleConfig((raw) => {
      raw.proposalReview.enabled = true;
      raw.proposalReview.socketPath = '/run/user/1000/cyberbaser/review.sock';
    });
    const busyService = {
      ...reviewServiceFixture(),
      async list() { throw new OwnerAlphaError('review-ipc-invalid-cursor', 'stale'); },
      async record() { throw new OwnerAlphaError('lock-busy', 'busy'); },
    };
    const { fetch } = await handlerFixture({ config, proposalReview: busyService });
    const bootstrap = await fetch(request(`/owner/bootstrap?token=${TOKENS.bootstrap}`));
    const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];

    const stale = await fetch(request('/owner/review?cursor=stale', { headers: { Cookie: cookie } }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: { code: 'review-ipc-invalid-cursor' } });

    const blocked = await fetch(request(`/api/review/${REVIEW_QUEUE_ID}/decision`, {
      method: 'POST',
      headers: { Origin: ORIGIN, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queueId: REVIEW_QUEUE_ID,
        reviewEvidenceDigest: REVIEW_DIGEST,
        action: 'reject',
        reason: 'The proposal requires another review pass.',
        csrf: TOKENS.csrf,
      }),
    }));
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: { code: 'lock-busy' } });
  });

  test('redirects decided proposals to a content-first immutable receipt without queue retention', async () => {
    const { fetch } = await enabledFixture({
      proposalReview: reviewServiceFixture({ decided: true }),
    });
    const opened = await openReview(fetch);
    expect(opened.body).toContain('<h2 id="history-heading">Decided</h2>');
    expect(opened.body).toContain('decision-label decision-approve">Approved');
    expect(opened.body).toContain('The exact correction is appropriate.');

    const staleDetail = await fetch(request(`/owner/review/${REVIEW_QUEUE_ID}`, {
      headers: { Cookie: opened.cookie },
      redirect: 'manual',
    }));
    expect(staleDetail.status).toBe(303);
    expect(staleDetail.headers.get('location')).toBe(`/owner/decisions/${REVIEW_QUEUE_ID}`);

    const history = await fetch(request(`/owner/decisions/${REVIEW_QUEUE_ID}`, {
      headers: { Cookie: opened.cookie },
    }));
    const body = await history.text();
    expect(history.status).toBe(200);
    expect(body).toContain('<h1>Approval recorded</h1>');
    expect(body).toContain('<strong>Source unchanged</strong>');
    expect(body).toContain('No application, write, commit, push, rebuild, deployment, or publication started.');
    expect(body).toContain('<summary>Receipt and verification details</summary>');
    expect(body).toContain('No longer retained; exact reviewed evidence is embedded here.');
    expect(body).not.toContain('data-action="approve"');
    expect(body).not.toContain('data-action="reject"');
    expect(body).not.toContain('<dialog');
  });

  test('constructs a review service only for enabled config and binds recording to the configured owner', async () => {
    const disabled = await exampleConfig();
    expect(createOwnerProposalReviewService({ config: disabled })).toBeNull();

    const enabled = await exampleConfig((raw) => {
      raw.proposalReview.enabled = true;
      raw.proposalReview.socketPath = '/run/user/1000/cyberbaser/review.sock';
    });
    const recordCalls = [];
    let recoverCalls = 0;
    const service = createOwnerProposalReviewService({
      config: enabled,
      context: { storeRoot: '/private/store' },
      source: {
        async list() { return { entries: [], nextCursor: null }; },
        async load() { throw new Error('a recorded queue ID must not reload source'); },
      },
      recoverDecisions: async () => {
        recoverCalls += 1;
        return { decisions: [REVIEW_DECISION] };
      },
      recordDecision: async (input) => {
        recordCalls.push(input);
        return { decision: REVIEW_DECISION };
      },
    });
    expect((await service.load(REVIEW_QUEUE_ID)).decision).toBe(REVIEW_DECISION);
    expect((await service.load(REVIEW_QUEUE_ID)).decision).toBe(REVIEW_DECISION);
    expect(recoverCalls).toBe(1);
    await service.record({ queueId: REVIEW_QUEUE_ID });
    expect(recoverCalls).toBe(2);
    await service.load(REVIEW_QUEUE_ID);
    expect(recoverCalls).toBe(2);
    expect(recordCalls[0]).toMatchObject({
      context: { storeRoot: '/private/store' },
      ownerIdentity: 'cybersader',
      intent: { queueId: REVIEW_QUEUE_ID },
    });
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
      recoverDecisions: async (context) => {
        events.push('recover-decisions');
        expect(context.storeRoot).toBe(path.join(projectRoot, '.workspace/owner-alpha/store'));
        return { decisions: [], index: { decisions: [] } };
      },
      recoverJobs: async ({ context }) => {
        events.push('recover-jobs');
        expect(context.storeRoot).toBe(path.join(projectRoot, '.workspace/owner-alpha/store'));
        return [];
      },
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
    expect(events).toEqual([
      'rebuild',
      'pipeline',
      'serve-4317',
      'serve-4318',
      'recover-decisions',
      'recover-jobs',
    ]);

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

  test('constructs the enabled review client, validation source, decision service, and handler without sharing intake authority', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'owner-alpha-review-runtime-'));
    cleanup.push(projectRoot);
    await execFileAsync('git', ['init', '-q', projectRoot]);
    await writeFile(path.join(projectRoot, '.gitignore'), '.workspace/\n');
    const socketPath = '/run/user/1000/cyberbaser/review.sock';
    const configFile = await privateConfigFile(projectRoot, (raw) => {
      raw.proposalReview.enabled = true;
      raw.proposalReview.socketPath = socketPath;
    });
    const client = { list() {}, load() {} };
    const source = { list() {}, load() {} };
    const service = reviewServiceFixture();
    const calls = [];

    const runtime = await runOwnerAlphaServer({
      configFile,
      projectRoot,
      rebuildSite: async () => {},
      loadPipeline: async () => ({
        saveEdit: async () => ({ jobId: 'job-runtime', state: 'accepted' }),
        getJob: async () => null,
      }),
      createReviewClient(options) {
        calls.push(['client', options]);
        return client;
      },
      createReviewSource(options) {
        calls.push(['source', options.client, options.config.proposalReview]);
        return source;
      },
      createReviewService(options) {
        calls.push(['service', options.context.storeRoot, options.source]);
        return service;
      },
      createHandler(options) {
        calls.push(['handler', options.proposalReview]);
        const handler = async () => new Response('owner');
        Object.defineProperties(handler, {
          bootstrapToken: { value: TOKENS.bootstrap },
          issueBootstrap: { value: () => TOKENS.bootstrap },
        });
        return handler;
      },
      createReader: () => async () => new Response('reader'),
      startServers: ({ ownerFetch }) => ({
        ownerOrigin: ORIGIN,
        readerOrigin: READER_ORIGIN,
        bootstrapToken: ownerFetch.bootstrapToken,
        issueBootstrap: ownerFetch.issueBootstrap,
        stop() {},
      }),
      recoverDecisions: async () => ({ decisions: [], index: { decisions: [] } }),
      recoverJobs: async () => [],
    });

    expect(await runtime.recovery).toEqual([]);
    expect(calls).toEqual([
      ['client', { socketPath, requestTimeoutMs: 5000 }],
      ['source', client, {
        enabled: true,
        socketPath,
        requestTimeoutMs: 5000,
        maxListEntries: 100,
      }],
      ['service', path.join(projectRoot, '.workspace/owner-alpha/store'), source],
      ['handler', service],
    ]);
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
    expect(opened.body).not.toContain('Review proposals');
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
