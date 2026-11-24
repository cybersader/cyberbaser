// ForgeAccess: how the publisher obtains a short-lived push credential for the
// one configured repository. Vendor-neutral surface, provider modules behind it:
//
//   status({ check })          -> plain status, never a credential
//   startSignIn()              -> { userCode, verificationUri, expiresAt } (interactive providers)
//   cancelSignIn()
//   listRepositories()         -> repositories the credential can reach, with their fit
//   selectRepository(fullName) -> bind the credential to exactly one repository
//   saveToken(token, fullName) -> pasted-token providers only (publisher CLI, never the node)
//   disconnect()               -> forget the credential
//   pushCredential(remoteUrl)  -> { username, password, host } for one push; in-process only
//   boundCredential()          -> { repository, remoteUrl, username, password, host } to read the bound
//                                 repository into the publisher's own mirror; in-process only
//
// Credentials live only in this process and in its owner-only state directory.
// Nothing returned by any method except pushCredential contains one, and no
// error message or detail ever carries a token or a response body.
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { OwnerAlphaError, fail } from '../errors.js';

export const FORGE_PROBLEMS = Object.freeze({
  'code-expired': 'The sign-in code expired before it was entered. Start again.',
  denied: 'Sign-in was cancelled on GitHub. Start again when you are ready.',
  'device-flow-disabled': 'The Cyberbaser GitHub App does not allow device sign-in. Its registration needs "Enable Device Flow".',
  'app-misconfigured': 'GitHub did not recognise this app. Check the client ID in the settings.',
  revoked: 'The Cyberbaser app was uninstalled, or its sign-in was revoked on GitHub. Connect again to keep publishing.',
  'sign-in-expired': 'The GitHub sign-in is more than six months old and has to be renewed. Connect again.',
  'permissions-too-broad': 'The app was given more than "Contents: write". Cyberbaser refuses it. Reduce its permissions in GitHub.',
  'permissions-missing': 'The app cannot write files in that repository. Give it "Contents: write" in GitHub.',
  'app-on-other-repositories': 'The app can also write to other repositories. In GitHub, limit it to only this one.',
  'repository-not-installed': 'The app is not installed on that repository, or you cannot push to it.',
  'repository-mismatch': 'The picked repository is not the one this site publishes to yet. Restart Cyberbaser to switch.',
  'token-invalid': 'That token was refused. Paste a fine-grained token with "Contents: read and write" on the one repository.',
  'github-unreachable': 'GitHub could not be reached. Cyberbaser will try again.',
  'starter-refused': 'That change was not published: it is not exactly the starter publish.yml, or your notes changed on GitHub meanwhile. Try again.',
});

const GITHUB_API_VERSION = '2022-11-28';
const RENEW_MARGIN_MS = 10 * 60 * 1000;
const MAX_PAGES = 10;
const FULL_NAME = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]{1,100})$/u;
const STATE_VERSION = 1;

function problem(code) {
  return new OwnerAlphaError(code, FORGE_PROBLEMS[code] ?? 'GitHub access failed');
}

export function validFullName(value) {
  const match = typeof value === 'string' ? FULL_NAME.exec(value) : null;
  return match !== null && !match[2].endsWith('.') && match[2] !== '.' && match[2] !== '..';
}

// ---- owner-only state --------------------------------------------------

async function privateDirectory(directory, uid) {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) fail('forge-unsafe-state', 'forge state needs an absolute directory');
  try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.uid !== uid || (entry.mode & 0o7777) !== 0o700 || await realpath(directory) !== directory) {
    fail('forge-unsafe-state', 'forge state directory must be a real owner-only directory');
  }
}

export function createForgeStateFile({ directory, name, uid = process.getuid() }) {
  const file = path.join(directory, name);
  return Object.freeze({
    async read() {
      await privateDirectory(directory, uid);
      let handle;
      try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
      try {
        const entry = await handle.stat();
        if (!entry.isFile() || entry.nlink !== 1 || entry.uid !== uid || (entry.mode & 0o077) !== 0 || entry.size > 64 * 1024) {
          fail('forge-unsafe-state', 'forge state file must be a private regular file');
        }
        const value = JSON.parse(await handle.readFile('utf8'));
        return value?.v === STATE_VERSION ? value : null;
      } finally { await handle.close(); }
    },
    async write(value) {
      await privateDirectory(directory, uid);
      const temporary = path.join(directory, `.${name}.${randomBytes(6).toString('hex')}`);
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ ...value, v: STATE_VERSION })}\n`);
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temporary, file);
      const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await parent.sync(); } finally { await parent.close(); }
    },
    async remove() {
      try { await unlink(file); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    },
  });
}

// ---- GitHub HTTP ---------------------------------------------------------

export function createGithubHttp({ apiBaseUrl = 'https://api.github.com', webBaseUrl = 'https://github.com', fetch = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const api = new URL(apiBaseUrl);
  const web = new URL(webBaseUrl);
  async function call(url, init) {
    let response;
    try { response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw problem('github-unreachable'); }
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    return { status: response.status, body };
  }
  return Object.freeze({
    // OAuth endpoints answer form posts with JSON when asked to.
    login(route, fields) {
      return call(new URL(route, web), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Cyberbaser' },
        body: new URLSearchParams(fields).toString(),
      });
    },
    get(route, token) {
      const url = new URL(route, api);
      if (url.origin !== api.origin) fail('forge-invalid-route', 'GitHub API route left the API origin');
      return call(url, { method: 'GET', headers: {
        Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': 'Cyberbaser', Authorization: `Bearer ${token}`,
      } });
    },
  });
}

// ---- shared helpers ----------------------------------------------------

function pushHostFrom(remoteUrl) {
  return new URL(remoteUrl).host;
}

function githubRemote(fullName) {
  return `https://github.com/${fullName}.git`;
}

function exactPermissions(permissions) {
  if (!permissions || typeof permissions !== 'object') return 'permissions-missing';
  const entries = Object.entries(permissions);
  const extra = entries.filter(([name]) => !['contents', 'metadata'].includes(name));
  if (extra.length > 0 || permissions.contents === 'admin') return 'permissions-too-broad';
  if (permissions.contents !== 'write' || permissions.metadata !== 'read') return 'permissions-missing';
  return null;
}

function publicRepository(repository, installation) {
  return {
    fullName: repository.full_name,
    private: repository.private === true,
    updatedAt: typeof repository.pushed_at === 'string' ? repository.pushed_at
      : typeof repository.updated_at === 'string' ? repository.updated_at : null,
    account: installation.account?.login ?? null,
    installationId: installation.id,
    // The fit of this repository for publishing, decided here, not in the browser.
    problem: exactPermissions(installation.permissions)
      ?? (installation.repository_selection !== 'selected' || installation.repositoryCount !== 1 ? 'app-on-other-repositories' : null)
      ?? (repository.permissions?.push === true ? null : 'repository-not-installed'),
  };
}

function serial() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}

// ---- github-app provider -------------------------------------------------

/**
 * GitHub App user-to-server tokens through the OAuth device flow. Device flow and
 * its refresh need only the public client ID, never a client secret:
 * https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
 * https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
 */
export function createGithubAppAccess({
  clientId, stateDirectory, remoteUrl, http = createGithubHttp(), uid = process.getuid(),
  now = () => Date.now(), secondMs = 1000, setTimer = setTimeout, clearTimer = clearTimeout, pushHost = null,
}) {
  const state = createForgeStateFile({ directory: stateDirectory, name: 'github-app.json', uid });
  const exclusive = serial();
  let pending = null; // { deviceCode, userCode, verificationUri, expiresAt, intervalS, timer }
  let lastProblem = null;

  function clearPending() {
    if (pending?.timer) clearTimer(pending.timer);
    pending = null;
  }

  async function storeTokens(previous, body) {
    if (typeof body?.access_token !== 'string' || typeof body.refresh_token !== 'string'
      || !Number.isSafeInteger(body.expires_in) || !Number.isSafeInteger(body.refresh_token_expires_in)) {
      // Non-expiring tokens mean the registration has "expire user tokens" off.
      throw problem('app-misconfigured');
    }
    const at = now();
    const next = {
      clientId,
      accessToken: body.access_token,
      accessExpiresAt: at + body.expires_in * 1000,
      refreshToken: body.refresh_token,
      refreshExpiresAt: at + body.refresh_token_expires_in * 1000,
      repository: previous?.repository ?? null,
    };
    await state.write(next);
    return next;
  }

  async function forget(code) {
    await state.remove();
    lastProblem = code;
  }

  async function refresh(current) {
    if (current.refreshExpiresAt <= now()) { await forget('sign-in-expired'); throw problem('sign-in-expired'); }
    const { body } = await http.login('/login/oauth/access_token', {
      client_id: clientId, grant_type: 'refresh_token', refresh_token: current.refreshToken,
    });
    if (body?.error === 'bad_refresh_token') { await forget('revoked'); throw problem('revoked'); }
    if (body?.error) throw problem(body.error === 'incorrect_client_credentials' ? 'app-misconfigured' : 'github-unreachable');
    // The old refresh token stops working the moment GitHub answers; persist first.
    return storeTokens(current, body);
  }

  async function usable() {
    const current = await state.read();
    if (current === null || current.clientId !== clientId) return null;
    if (current.accessExpiresAt - RENEW_MARGIN_MS <= now()) return refresh(current);
    return current;
  }

  // One authenticated GET; a 401 gets exactly one refresh, then counts as revoked.
  async function authorizedGet(route) {
    let current = await usable();
    if (current === null) throw problem('revoked');
    let result = await http.get(route, current.accessToken);
    if (result.status === 401) {
      current = await refresh(current);
      result = await http.get(route, current.accessToken);
      if (result.status === 401) { await forget('revoked'); throw problem('revoked'); }
    }
    if (result.status !== 200 || result.body === null) throw problem('github-unreachable');
    return result.body;
  }

  async function paged(route, field) {
    const items = [];
    let total = Infinity;
    for (let page = 1; page <= MAX_PAGES && items.length < total; page++) {
      const separator = route.includes('?') ? '&' : '?';
      const body = await authorizedGet(`${route}${separator}per_page=100&page=${page}`);
      const list = body?.[field];
      if (!Array.isArray(list)) throw problem('github-unreachable');
      total = Number.isSafeInteger(body.total_count) ? body.total_count : items.length + list.length;
      items.push(...list);
      if (list.length === 0) break;
    }
    return { items, truncated: items.length < total };
  }

  async function installations() {
    const { items } = await paged('/user/installations', 'installations');
    return items.filter((entry) => Number.isSafeInteger(entry?.id));
  }

  async function repositoriesOf(installation) {
    const { items, truncated } = await paged(`/user/installations/${installation.id}/repositories`, 'repositories');
    return { items: items.filter((entry) => validFullName(entry?.full_name)), truncated };
  }

  async function reachable() {
    const rows = [];
    let truncated = false;
    for (const installation of await installations()) {
      const { items, truncated: more } = await repositoriesOf(installation);
      truncated ||= more;
      const fit = { ...installation, repositoryCount: more ? Infinity : items.length };
      for (const repository of items) rows.push(publicRepository(repository, fit));
    }
    rows.sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));
    return { repositories: rows, truncated };
  }

  // With a known installation only that installation is listed, not every one.
  async function checkBinding(fullName, installationId = null) {
    let repositories;
    if (installationId === null) ({ repositories } = await reachable());
    else {
      const installation = (await installations()).find((entry) => entry.id === installationId);
      if (!installation) throw problem('repository-not-installed');
      const { items, truncated } = await repositoriesOf(installation);
      const fit = { ...installation, repositoryCount: truncated ? Infinity : items.length };
      repositories = items.map((repository) => publicRepository(repository, fit));
    }
    const row = repositories.find((entry) => entry.fullName === fullName);
    if (!row) throw problem('repository-not-installed');
    if (row.problem) throw problem(row.problem);
    return row;
  }

  function schedulePoll(delayS) {
    const flow = pending;
    flow.timer = setTimer(() => { poll(flow).catch(() => {}); }, delayS * secondMs);
  }

  async function poll(flow) {
    if (pending !== flow) return;
    if (flow.expiresAt <= now()) { clearPending(); lastProblem = 'code-expired'; return; }
    let result;
    try {
      result = await http.login('/login/oauth/access_token', {
        client_id: clientId, device_code: flow.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
    } catch {
      if (pending === flow) schedulePoll(flow.intervalS);
      return;
    }
    if (pending !== flow) return;
    const error = result.body?.error;
    if (error === 'authorization_pending') return schedulePoll(flow.intervalS);
    if (error === 'slow_down') {
      flow.intervalS = Number.isSafeInteger(result.body.interval) && result.body.interval > flow.intervalS
        ? result.body.interval : flow.intervalS + 5;
      return schedulePoll(flow.intervalS);
    }
    clearPending();
    if (error) {
      lastProblem = { expired_token: 'code-expired', token_expired: 'code-expired', access_denied: 'denied',
        device_flow_disabled: 'device-flow-disabled', incorrect_client_credentials: 'app-misconfigured' }[error] ?? 'code-expired';
      return;
    }
    try {
      await exclusive(async () => { await storeTokens(null, result.body); lastProblem = null; });
    } catch (failure) {
      lastProblem = failure instanceof OwnerAlphaError && FORGE_PROBLEMS[failure.code] ? failure.code : 'app-misconfigured';
    }
  }

  return Object.freeze({
    provider: 'github-app',
    interactive: true,

    status({ check = false } = {}) {
      return exclusive(async () => {
        if (pending) {
          return { provider: 'github-app', state: 'waiting-for-code', userCode: pending.userCode,
            verificationUri: pending.verificationUri, expiresAt: new Date(pending.expiresAt).toISOString() };
        }
        let current = await state.read();
        if (current === null || current.clientId !== clientId) {
          return { provider: 'github-app', state: lastProblem ? 'problem' : 'not-connected',
            ...(lastProblem ? { problem: lastProblem, message: FORGE_PROBLEMS[lastProblem] } : {}) };
        }
        try {
          if (check) {
            current = await usable();
            if (current?.repository) await checkBinding(current.repository.fullName, current.repository.installationId ?? null);
            else await installations();
            current = await state.read();
          }
        } catch (failure) {
          const code = failure instanceof OwnerAlphaError && FORGE_PROBLEMS[failure.code] ? failure.code : 'github-unreachable';
          const still = await state.read();
          return { provider: 'github-app', state: 'problem', problem: code, message: FORGE_PROBLEMS[code],
            ...(still?.repository ? { repository: still.repository.fullName } : {}) };
        }
        if (!current.repository) return { provider: 'github-app', state: 'pick-repository' };
        // First-run setup runs this provider with no repository yet (remoteUrl
        // null): any picked repository is connected, and pushCredential still
        // refuses, so a setup-time publisher can never push.
        const matches = remoteUrl === null || current.repository.remoteUrl === remoteUrl;
        return {
          provider: 'github-app', state: matches ? 'connected' : 'problem', repository: current.repository.fullName,
          renewsAutomatically: true, signInRenewBy: new Date(current.refreshExpiresAt).toISOString(),
          ...(matches ? {} : { problem: 'repository-mismatch', message: FORGE_PROBLEMS['repository-mismatch'] }),
        };
      });
    },

    startSignIn() {
      return exclusive(async () => {
        clearPending();
        lastProblem = null;
        // offline_access asks for an expiring token with a refresh token even if
        // the registration has expiry off; GitHub Apps accept no other scope.
        const { status, body } = await http.login('/login/device/code', { client_id: clientId, scope: 'offline_access' });
        if (body?.error === 'device_flow_disabled') throw problem('device-flow-disabled');
        if (status !== 200 || typeof body?.device_code !== 'string' || typeof body.user_code !== 'string'
          || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/u.test(body.user_code) || typeof body.verification_uri !== 'string') {
          throw problem(body?.error === 'incorrect_client_credentials' || body?.error === 'Not Found' ? 'app-misconfigured' : 'github-unreachable');
        }
        const verification = new URL(body.verification_uri);
        if (verification.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(verification.hostname)) throw problem('github-unreachable');
        const intervalS = Number.isSafeInteger(body.interval) && body.interval > 0 ? body.interval : 5;
        const expiresIn = Number.isSafeInteger(body.expires_in) && body.expires_in > 0 ? body.expires_in : 900;
        pending = { deviceCode: body.device_code, userCode: body.user_code, verificationUri: verification.toString(),
          expiresAt: now() + expiresIn * 1000, intervalS, timer: null };
        schedulePoll(intervalS);
        return { userCode: pending.userCode, verificationUri: pending.verificationUri, expiresAt: new Date(pending.expiresAt).toISOString() };
      });
    },

    cancelSignIn() {
      return exclusive(async () => { clearPending(); lastProblem = null; });
    },

    listRepositories() {
      return exclusive(async () => reachable());
    },

    selectRepository(fullName) {
      if (!validFullName(fullName)) return Promise.reject(problem('repository-not-installed'));
      return exclusive(async () => {
        const row = await checkBinding(fullName);
        const current = await state.read();
        if (current === null) throw problem('revoked');
        const repository = { fullName, remoteUrl: githubRemote(fullName), installationId: row.installationId };
        await state.write({ ...current, repository });
        lastProblem = null;
        return { repository: { fullName, remoteUrl: repository.remoteUrl } };
      });
    },

    saveToken() { return Promise.reject(new OwnerAlphaError('forge-unsupported', 'this provider signs in with GitHub instead')); },

    disconnect() {
      return exclusive(async () => { clearPending(); await state.remove(); lastProblem = null; });
    },

    // The one place a credential leaves this module: for one push to the one bound repository.
    pushCredential(targetUrl) {
      return exclusive(async () => {
        const current = await usable();
        if (current === null) throw problem(lastProblem ?? 'revoked');
        if (!current.repository || current.repository.remoteUrl !== targetUrl || targetUrl !== remoteUrl) throw problem('repository-mismatch');
        await checkBinding(current.repository.fullName, current.repository.installationId ?? null);
        const fresh = await usable();
        return { username: 'x-access-token', password: fresh.accessToken, host: pushHost ?? pushHostFrom(targetUrl) };
      });
    },

    // Reading the bound repository into the publisher's mirror. First-run setup
    // (remoteUrl null) may read whichever repository was picked; once a config
    // names the repository, only that one.
    boundCredential() {
      return exclusive(async () => {
        const current = await usable();
        if (current === null) throw problem(lastProblem ?? 'revoked');
        if (!current.repository) throw problem('repository-not-installed');
        if (remoteUrl !== null && current.repository.remoteUrl !== remoteUrl) throw problem('repository-mismatch');
        return { repository: current.repository.fullName, remoteUrl: current.repository.remoteUrl, username: 'x-access-token',
          password: current.accessToken, host: pushHost ?? pushHostFrom(current.repository.remoteUrl) };
      });
    },

    close() { clearPending(); },
  });
}

// ---- token provider ------------------------------------------------------

/** A pasted fine-grained personal access token, validated against the one repository. */
export function createTokenAccess({ stateDirectory, remoteUrl, http = createGithubHttp(), uid = process.getuid(), pushHost = null }) {
  const state = createForgeStateFile({ directory: stateDirectory, name: 'token.json', uid });
  const exclusive = serial();
  let lastProblem = null;

  async function verify(token, fullName) {
    const { status, body } = await http.get(`/repos/${fullName}`, token);
    if (status === 401) throw problem('token-invalid');
    if (status === 404 || status === 403) throw problem('repository-not-installed');
    if (status !== 200 || body?.full_name !== fullName) throw problem('github-unreachable');
    if (body.permissions?.push !== true) throw problem('permissions-missing');
    if (body.permissions?.admin === true) throw problem('permissions-too-broad');
  }

  return Object.freeze({
    provider: 'token',
    interactive: false,
    status({ check = false } = {}) {
      return exclusive(async () => {
        const current = await state.read();
        if (current === null) {
          return { provider: 'token', state: lastProblem ? 'problem' : 'not-connected',
            ...(lastProblem ? { problem: lastProblem, message: FORGE_PROBLEMS[lastProblem] } : {}) };
        }
        if (check) {
          try { await verify(current.token, current.repository.fullName); }
          catch (failure) {
            const code = failure instanceof OwnerAlphaError && FORGE_PROBLEMS[failure.code] ? failure.code : 'github-unreachable';
            return { provider: 'token', state: 'problem', problem: code, message: FORGE_PROBLEMS[code], repository: current.repository.fullName };
          }
        }
        const matches = current.repository.remoteUrl === remoteUrl;
        return { provider: 'token', state: matches ? 'connected' : 'problem', repository: current.repository.fullName,
          renewsAutomatically: false, ...(matches ? {} : { problem: 'repository-mismatch', message: FORGE_PROBLEMS['repository-mismatch'] }) };
      });
    },
    startSignIn() { return Promise.reject(new OwnerAlphaError('forge-unsupported', 'paste a token with the publisher command instead')); },
    cancelSignIn() { return Promise.resolve(); },
    listRepositories() {
      return exclusive(async () => {
        const current = await state.read();
        return { repositories: current ? [{ fullName: current.repository.fullName, private: null, updatedAt: null, account: null, problem: null }] : [], truncated: false };
      });
    },
    selectRepository() { return Promise.reject(new OwnerAlphaError('forge-unsupported', 'a pasted token names its repository when it is saved')); },
    saveToken(token, fullName) {
      // Fine-grained tokens only: a classic token cannot be limited to one repository.
      if (typeof token !== 'string' || !/^github_pat_[A-Za-z0-9_]{20,255}$/u.test(token)) return Promise.reject(problem('token-invalid'));
      if (!validFullName(fullName)) return Promise.reject(problem('repository-not-installed'));
      return exclusive(async () => {
        await verify(token, fullName);
        const repository = { fullName, remoteUrl: githubRemote(fullName) };
        await state.write({ token, repository });
        lastProblem = null;
        return { repository: { ...repository } };
      });
    },
    disconnect() { return exclusive(async () => { await state.remove(); lastProblem = null; }); },
    pushCredential(targetUrl) {
      return exclusive(async () => {
        const current = await state.read();
        if (current === null) throw problem('revoked');
        if (current.repository.remoteUrl !== targetUrl || targetUrl !== remoteUrl) throw problem('repository-mismatch');
        try { await verify(current.token, current.repository.fullName); }
        catch (failure) { if (failure?.code === 'token-invalid') { await state.remove(); lastProblem = 'revoked'; } throw failure; }
        return { username: 'x-access-token', password: current.token, host: pushHost ?? pushHostFrom(targetUrl) };
      });
    },
    boundCredential() {
      return exclusive(async () => {
        const current = await state.read();
        if (current === null) throw problem('revoked');
        if (current.repository.remoteUrl !== remoteUrl) throw problem('repository-mismatch');
        return { repository: current.repository.fullName, remoteUrl: current.repository.remoteUrl, username: 'x-access-token',
          password: current.token, host: pushHost ?? pushHostFrom(current.repository.remoteUrl) };
      });
    },
    close() {},
  });
}

/** The provider named by `config.forgeAccess`, or null when the config has none. */
export function createForgeAccess(config, options = {}) {
  const settings = config.forgeAccess;
  if (!settings) return null;
  const common = { stateDirectory: settings.stateDirectory, remoteUrl: config.repository.remote.url, ...options };
  if (settings.provider === 'github-app') return createGithubAppAccess({ clientId: settings.clientId, ...common });
  if (settings.provider === 'token') {
    const { secondMs, now, setTimer, clearTimer, ...rest } = common;
    return createTokenAccess(rest);
  }
  fail('invalid-config', 'unknown forge access provider');
}
