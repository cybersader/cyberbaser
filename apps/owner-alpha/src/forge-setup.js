// "Publishing access" in the owner app: connect GitHub through the publisher,
// pick the one repository, see status, disconnect. The node only relays: it
// asks the publisher's forge control socket and shows the user code and plain
// status. It never receives, stores or forwards a forge credential.
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import path from 'node:path';
import { computePolicyRevision, retargetGithubRepository, validateOwnerAlphaConfig } from './config.js';
import { OwnerAlphaError, fail } from './errors.js';
import { FORGE_PROBLEMS, validFullName } from './publisher/forge-access.js';
import { forgeRequest } from './publisher/forge-control.js';

const MESSAGES = Object.freeze({
  ...FORGE_PROBLEMS,
  'publisher-unavailable': 'The publisher is not running, so GitHub cannot be reached from here. Start Cyberbaser again.',
  'forge-unsupported': 'This node publishes with a pasted token. Change it with the publisher command, not here.',
  'forge-failed': 'Something went wrong talking to GitHub. Try again.',
  'forge-busy': 'The publisher is busy. Try again in a moment.',
  'config-write-failed': 'The repository was connected, but the settings file could not be updated.',
});

// One line under a repository the picker cannot use.
const SHORT_PROBLEMS = Object.freeze({
  'permissions-too-broad': 'App has more than file access here; reduce it in GitHub',
  'permissions-missing': 'App cannot update files here',
  'app-on-other-repositories': 'App is also on other repositories; limit it to this one',
  'repository-not-installed': 'You cannot push to this repository',
});

function message(code) {
  return MESSAGES[code] ?? MESSAGES['forge-failed'];
}

/**
 * Rewrites the node's own config file so its repository is `fullName`. The
 * caller restarts to adopt it; the policy revision changes with the repository.
 */
export function createRepositoryRecorder(configFile) {
  return async function recordRepository(fullName) {
    const absolute = path.resolve(configFile);
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw;
    let mode;
    try {
      const entry = await handle.stat();
      if (!entry.isFile() || entry.nlink !== 1 || (entry.mode & 0o077) !== 0) fail('config-write-failed', 'config file is not private');
      mode = entry.mode & 0o600;
      raw = JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
    const before = computePolicyRevision(raw);
    const next = retargetGithubRepository(raw, fullName);
    const after = computePolicyRevision(next);
    if (after === before) return { changed: false, policyRevision: after };
    const temporary = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${randomBytes(6).toString('hex')}`);
    const out = await open(temporary, 'wx', mode || 0o600);
    try {
      await out.writeFile(`${JSON.stringify(next, null, 2)}\n`);
      await out.sync();
    } finally { await out.close(); }
    await rename(temporary, absolute);
    return { changed: true, policyRevision: after };
  };
}

export function createForgeSetup({ config, configFile, request = forgeRequest }) {
  config = validateOwnerAlphaConfig(config);
  if (!config.publisher || !config.forgeAccess) return null;
  const identity = new URL(config.repository.remote.url).pathname.replace(/^\/|\.git$/gu, '');
  const recordRepository = createRepositoryRecorder(configFile);
  let restartFor = null;
  return Object.freeze({
    provider: config.forgeAccess.provider,
    configuredRepository: identity,
    get restartFor() { return restartFor; },
    ask(op, repository) { return request({ socketPath: config.publisher.socketPath, op, repository }); },
    async pick(fullName) {
      const bound = await this.ask('select', fullName);
      let recorded;
      try { recorded = await recordRepository(fullName); }
      catch { throw new OwnerAlphaError('config-write-failed', MESSAGES['config-write-failed']); }
      restartFor = recorded.changed ? fullName : null;
      return { repository: bound.repository.fullName, restartNeeded: recorded.changed };
    },
  });
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function githubPage({ csrfToken, setup }) {
  return `<main class="owner-shell devices-shell forge-shell" id="forge" data-csrf="${escapeHtml(csrfToken)}" data-provider="${escapeHtml(setup.provider)}" data-configured="${escapeHtml(setup.configuredRepository)}">
<header class="owner-header"><h1>Publishing to GitHub</h1><p class="lede">Cyberbaser publishes by updating files in one repository. GitHub access stays with the publisher, a separate part of this app; this page never sees it.</p></header>
<section class="devices-section forge-section" aria-labelledby="forge-heading">
<h2 id="forge-heading" class="visually-hidden">GitHub access</h2>
<div id="forge-panel" class="forge-panel" aria-live="polite"><p class="devices-empty">Checking GitHub access…</p></div>
<noscript><p>Connecting GitHub needs scripting enabled in this browser.</p></noscript>
</section>
</main>`;
}

function parseBody(fields) {
  return (text) => {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...fields, 'csrf'].sort().join(',')) throw new Error('fields');
    return value;
  };
}

function publicState(setup, status) {
  const out = { ...status };
  if (out.message === undefined && out.problem) out.message = message(out.problem);
  if (setup.restartFor && out.repository === setup.restartFor) {
    out.state = 'restart-needed';
    out.message = `Restart Cyberbaser to start publishing to ${setup.restartFor}.`;
    delete out.problem;
  }
  return out;
}

/** Routes under /owner/github. Returns null for any other path. */
export async function handleForgeSetup({ request, url, csrfToken, setup, tools }) {
  if (url.pathname !== '/owner/github' && !url.pathname.startsWith('/owner/github/')) return null;
  const { html, json, errorResponse, response, pageShell, readBoundedJson, sameSecret } = tools;
  if (setup === null) return errorResponse(404, 'forge-setup-unavailable');
  if (url.search !== '') return errorResponse(400, 'unexpected-query');
  const failure = (error) => {
    const code = error instanceof OwnerAlphaError ? error.code : 'forge-failed';
    return json({ ok: false, code: MESSAGES[code] ? code : 'forge-failed', message: message(code) }, code === 'publisher-unavailable' ? 503 : 409);
  };
  if (url.pathname === '/owner/github') {
    if (!['GET', 'HEAD'].includes(request.method)) return response(null, 405, { Allow: 'GET, HEAD' });
    return html(request.method === 'HEAD' ? null : pageShell({
      title: 'Publishing to GitHub', script: '/owner/assets/github.js', bodyClass: 'devices-page forge-page',
      body: githubPage({ csrfToken, setup }),
    }));
  }
  const reads = { '/owner/github/state': 'status', '/owner/github/check': 'check', '/owner/github/repositories': 'repositories' };
  if (Object.hasOwn(reads, url.pathname)) {
    if (request.method !== 'GET') return response(null, 405, { Allow: 'GET' });
    try {
      const result = await setup.ask(reads[url.pathname]);
      if (reads[url.pathname] === 'repositories') {
        return json({ ok: true, truncated: result.truncated === true, repositories: result.repositories.map((row) => ({
          fullName: row.fullName, private: row.private, updatedAt: row.updatedAt, problem: row.problem,
          problemMessage: row.problem === null ? null : SHORT_PROBLEMS[row.problem] ?? message(row.problem) })) });
      }
      return json({ ok: true, ...publicState(setup, result) });
    } catch (error) { return failure(error); }
  }
  const writes = { '/owner/github/start': [], '/owner/github/cancel': [], '/owner/github/disconnect': [], '/owner/github/select': ['repository'] };
  if (!Object.hasOwn(writes, url.pathname)) return errorResponse(404, 'not-found');
  if (request.method !== 'POST') return response(null, 405, { Allow: 'POST' });
  let body;
  try { body = await readBoundedJson(request, 1024, parseBody(writes[url.pathname])); }
  catch (error) { return errorResponse(error?.status ?? 400, 'invalid-forge-body'); }
  if (!sameSecret(body.csrf, csrfToken)) return errorResponse(403, 'invalid-csrf');
  try {
    if (url.pathname === '/owner/github/select') {
      if (!validFullName(body.repository)) return errorResponse(400, 'invalid-forge-body');
      return json({ ok: true, ...(await setup.pick(body.repository)) });
    }
    const op = url.pathname.slice('/owner/github/'.length);
    const result = await setup.ask(op);
    return json({ ok: true, ...(op === 'start' ? { userCode: result.userCode, verificationUri: result.verificationUri, expiresAt: result.expiresAt } : {}) });
  } catch (error) { return failure(error); }
}
