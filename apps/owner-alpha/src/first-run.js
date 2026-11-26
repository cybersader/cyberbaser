// First-run setup: a short guided flow shown only until setup is complete.
//
// It runs before the node has a configuration: the owner opens a one-time,
// loopback-only setup link, connects GitHub through the publisher (which alone
// holds the credential), the node makes its private copy of the notes, and the
// owner optionally pairs a phone and an agent. Every step is saved to an
// owner-only state file, so a restart resumes at the same step. Nothing is
// published during setup except one change the owner approves on screen: a
// starter publish.yml listing exactly the folders they picked, which the
// publisher checks byte for byte before it pushes. The node copies the notes
// from the publisher's mirror, so it never holds a GitHub credential, even for
// a private repository.
import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import yaml from 'js-yaml';
import { CONFIG_SCHEMA_VERSION, validateOwnerAlphaConfig } from './config.js';
import { OwnerAlphaError, fail } from './errors.js';
import { forgeRequest } from './publisher/forge-control.js';
import { FORGE_PROBLEMS, validFullName } from './publisher/forge-access.js';
import { CALLBACK_PATHS, validCode, validState as validFlowState } from './publisher/github-app-manifest.js';
import { handleForgeSetup } from './forge-setup.js';
import { STARTER_COMMIT_MESSAGE, STARTER_PATH, starterPublishYml, validStarterFolder } from './starter-publish.js';
import { handleDeviceRoutes, ownerHttpTools, pairFormHtml } from './server.js';

const exec = promisify(execFile);

export const SETUP_STEPS = Object.freeze(['welcome', 'github', 'notes', 'website', 'phone', 'agent', 'done']);
// Long enough to finish GitHub's pages and come back; still one use.
export const SETUP_LINK_TTL_MS = 60 * 60_000;
export const SETUP_STATE_FILE = 'setup.json';
const MAX_SETUP_SESSIONS = 8;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_FOLDERS = 200;
const MAX_WORKFLOW_FILES = 24;
const MAX_WORKFLOW_BYTES = 64 * 1024;
const MAX_NOTE_COUNT = 200_000;
const NOTES_DIRECTORY = 'notes';
const STEP_TITLES = Object.freeze({
  welcome: 'Welcome', github: 'Connect GitHub', notes: 'Your notes', website: 'Your website',
  phone: 'Pair your phone', agent: 'Pair an agent', done: 'Done',
});

// ---------------------------------------------------------------- state file

export function initialSetupState() {
  return {
    v: 1,
    step: 'welcome',
    repository: null,
    notes: { phase: 'idle', message: null, count: null, branch: null, publishYml: null, allowCount: null,
      choice: null, folders: [], site: null, detected: null },
    website: { url: null, source: null },
    phone: null,
    agent: null,
    completedAt: null,
  };
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validState(value) {
  return plainObject(value) && value.v === 1 && SETUP_STEPS.includes(value.step)
    && (value.repository === null || validFullName(value.repository))
    && plainObject(value.notes) && plainObject(value.website)
    && (value.completedAt === null || typeof value.completedAt === 'string');
}

async function privateDirectory(directory) {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) fail('setup-state-invalid', 'setup state needs one absolute directory');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && entry.uid !== process.getuid())) {
    fail('setup-state-invalid', 'setup state directory must be a private directory owned by this account');
  }
}

async function writePrivateFile(file, text) {
  const temporary = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, file);
}

/** Durable setup state: one owner-only JSON file, replaced atomically, writes in order. */
export async function openSetupState(directory) {
  await privateDirectory(directory);
  const file = path.join(directory, SETUP_STATE_FILE);
  let current;
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const entry = await handle.stat();
      if (!entry.isFile() || entry.nlink !== 1 || (entry.mode & 0o077) !== 0 || entry.size > MAX_STATE_BYTES) {
        fail('setup-state-invalid', 'setup state file must be a small private file');
      }
      current = JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
    if (!validState(current)) fail('setup-state-invalid', 'setup state file is not recognized');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (error instanceof OwnerAlphaError) throw error;
      fail('setup-state-invalid', 'setup state file could not be read');
    }
    current = initialSetupState();
  }
  let queue = Promise.resolve();
  return Object.freeze({
    directory,
    read: () => structuredClone(current),
    // `change` receives a copy and returns the next state; writes never interleave.
    update(change) {
      const next = queue.then(async () => {
        const proposed = change(structuredClone(current));
        if (!validState(proposed)) throw new TypeError('invalid setup state');
        await writePrivateFile(file, `${JSON.stringify(proposed, null, 2)}\n`);
        current = proposed;
        return structuredClone(current);
      });
      queue = next.catch(() => {});
      return next;
    },
  });
}

// --------------------------------------------------------------- setup links

/**
 * One outstanding setup link at a time: single use, short-lived, never stored.
 * Issuing a new one replaces the old. A finished setup issues none.
 */
export function createSetupLinks({ createToken, sameSecret, clock = Date.now, ttlMs = SETUP_LINK_TTL_MS, isComplete = () => false }) {
  let outstanding = null;
  return Object.freeze({
    issue() {
      if (isComplete()) fail('setup-complete', 'setup is finished; use the owner sign-in link');
      outstanding = { token: createToken(), expiresAt: clock() + ttlMs };
      return outstanding.token;
    },
    consume(value) {
      const held = outstanding;
      if (held === null || !sameSecret(value, held.token)) return false;
      outstanding = null;
      return clock() < held.expiresAt;
    },
  });
}

// ------------------------------------------------------------- notes, site

function cleanGitEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ASKPASS: '/bin/false' };
}

export async function defaultSetupGit(cwd, args) {
  const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'protocol.file.allow=never',
    '-c', 'protocol.ext.allow=never', '-c', 'submodule.recurse=false', ...args],
  { cwd, env: cleanGitEnv(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 15 * 60_000 });
  return String(stdout).trim();
}

export function githubRemoteUrl(fullName) {
  return `https://github.com/${fullName}.git`;
}

async function countNotes(root) {
  let count = 0;
  const walk = async (directory, depth) => {
    if (depth > 32 || count >= MAX_NOTE_COUNT) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) count += 1;
    }
  };
  await walk(root, 0);
  return count;
}

async function topFolders(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && validStarterFolder(entry.name))
    .map((entry) => entry.name).sort((a, b) => a.localeCompare(b)).slice(0, MAX_FOLDERS);
}

async function readSmall(file, maximum) {
  try {
    const entry = await lstat(file);
    if (!entry.isFile() || entry.size > maximum) return null;
    return await readFile(file, 'utf8');
  } catch { return null; }
}

/** What publish.yml says, read the way the publisher reads it: fail closed. */
export function inspectPublishYml(text) {
  if (text === null) return { publishYml: 'missing', allowCount: null };
  let parsed;
  try { parsed = yaml.load(text); } catch { return { publishYml: 'invalid', allowCount: null }; }
  if (!plainObject(parsed) || (parsed.allow !== undefined && !Array.isArray(parsed.allow))) return { publishYml: 'invalid', allowCount: null };
  return { publishYml: 'present', allowCount: Array.isArray(parsed.allow) ? parsed.allow.length : 0 };
}

/**
 * Where the site is published, from what the repository itself says: a GitHub
 * Pages workflow (actions/deploy-pages) and an optional CNAME file. No extra
 * GitHub permission is used. Returns null when nothing says so.
 */
export async function detectWebsite(root, fullName) {
  const directory = path.join(root, '.github', 'workflows');
  let names = [];
  try { names = (await readdir(directory)).filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/u.test(name)).sort().slice(0, MAX_WORKFLOW_FILES); }
  catch { names = []; }
  let workflow = null;
  for (const name of names) {
    const text = await readSmall(path.join(directory, name), MAX_WORKFLOW_BYTES);
    if (text === null) continue;
    let parsed;
    try { parsed = yaml.load(text); } catch { continue; }
    if (!plainObject(parsed) || !plainObject(parsed.jobs)) continue;
    const deploys = Object.values(parsed.jobs).some((job) => plainObject(job) && Array.isArray(job.steps)
      && job.steps.some((step) => plainObject(step) && typeof step.uses === 'string' && step.uses.startsWith('actions/deploy-pages@')));
    if (!deploys) continue;
    const on = parsed.on ?? parsed[true];
    const branches = plainObject(on) && plainObject(on.push) && Array.isArray(on.push.branches) ? on.push.branches : [];
    workflow = {
      path: `.github/workflows/${name}`,
      name: typeof parsed.name === 'string' && parsed.name.length <= 255 ? parsed.name : name,
      jobs: Object.keys(parsed.jobs).slice(0, 32),
      branch: typeof branches[0] === 'string' ? branches[0] : null,
    };
    break;
  }
  let cname = null;
  for (const candidate of ['CNAME', 'static/CNAME', 'quartz/static/CNAME', 'public/CNAME', 'docs/CNAME']) {
    const text = await readSmall(path.join(root, candidate), 512);
    const host = text?.trim().toLowerCase();
    if (host && /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(host)) { cname = { host, file: candidate }; break; }
  }
  if (workflow === null && cname === null) return null;
  const [owner, name] = fullName.split('/');
  const pagesHost = `${owner.toLowerCase()}.github.io`;
  const pagesUrl = `https://${pagesHost}${name.toLowerCase() === pagesHost ? '/' : `/${name}/`}`;
  return {
    url: cname ? `https://${cname.host}/` : pagesUrl,
    pagesUrl,
    foundIn: cname ? cname.file : workflow.path,
    workflow,
  };
}

/**
 * The site address the vault declares for its renderer (`.cyberbaser/site.yml`
 * site.baseUrl, `https://host/path/` or `host[/path]`), as one canonical https
 * URL ending in "/", or null. Only used as the private site's page identity.
 */
export function declaredSiteUrl(text) {
  if (typeof text !== 'string') return null;
  let parsed;
  try { parsed = yaml.load(text, { schema: yaml.CORE_SCHEMA }); } catch { return null; }
  const declared = plainObject(parsed) && plainObject(parsed.site) ? parsed.site.baseUrl : undefined;
  if (typeof declared !== 'string' || declared.trim() === '' || declared.length > 512) return null;
  const value = declared.trim();
  let url;
  try { url = new URL(/^https?:\/\//iu.test(value) ? value.replace(/^http:/iu, 'https:') : `https://${value}`); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port || !url.hostname.includes('.')) return null;
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  return url.toString();
}

/**
 * Makes the node's private copy of the notes and reports what it found. Runs
 * in the background; every phase is saved, so a restart picks it up again.
 *
 * With `mirror` and `refresh`, the publisher fetches (it alone holds the GitHub
 * credential) into its mirror and the node clones that local copy; nothing on
 * the node's side ever names a credential. Without them (development only) the
 * node clones `fetchUrlFor(fullName)` itself.
 */
export function createNotesPreparer({ state, directory, checkout = path.join(directory, NOTES_DIRECTORY), git = defaultSetupGit,
  fetchUrlFor = githubRemoteUrl, buildSite = null, mirror = null, refresh = null }) {
  let running = null;
  const phase = (fields) => state.update((current) => ({ ...current, notes: { ...current.notes, ...fields } }));
  const local = mirror === null ? [] : ['-c', 'protocol.file.allow=always', '-c', `safe.directory=${mirror}`];

  async function existingCopyMatches(fullName, wanted) {
    try {
      const entry = await lstat(checkout);
      if (!entry.isDirectory()) return false;
      const head = await git(checkout, ['rev-parse', 'HEAD']);
      return (await git(checkout, ['remote', 'get-url', 'origin'])) === githubRemoteUrl(fullName)
        && /^[0-9a-f]{40}$/u.test(head) && (wanted === null || head === wanted);
    } catch { return false; }
  }

  async function copy(fullName) {
    let source = fetchUrlFor(fullName);
    let wanted = null;
    if (mirror !== null) {
      const held = await refresh();
      if (held?.repository !== fullName || !/^[0-9a-f]{40}$/u.test(held.head ?? '')) throw new Error('mirror holds another repository');
      source = mirror;
      wanted = held.head;
    }
    if (await existingCopyMatches(fullName, wanted)) return;
    const temporary = path.join(path.dirname(checkout), `.notes-${Date.now().toString(36)}`);
    await rm(checkout, { recursive: true, force: true });
    try {
      await git(path.dirname(checkout), [...local, 'clone', '--quiet', '--no-local', '--no-tags', '--origin', 'origin', '--', source, temporary]);
      // The node's checkout always names the canonical remote, whatever it was copied from.
      await git(temporary, ['remote', 'set-url', 'origin', githubRemoteUrl(fullName)]);
      // Commits the node makes (approved changes) carry the owner's GitHub identity.
      const owner = fullName.split('/')[0];
      await git(temporary, ['config', 'user.name', owner]);
      await git(temporary, ['config', 'user.email', `${owner}@users.noreply.github.com`]);
      await rename(temporary, checkout);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async function run(fullName) {
    try {
      await phase({ phase: 'cloning', message: null });
      await copy(fullName);
      const count = await countNotes(checkout);
      const branch = await git(checkout, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null);
      const inspected = inspectPublishYml(await readSmall(path.join(checkout, 'publish.yml'), 256 * 1024));
      const detected = await detectWebsite(checkout, fullName);
      const folders = await topFolders(checkout);
      const siteUrl = declaredSiteUrl(await readSmall(path.join(checkout, '.cyberbaser', 'site.yml'), 64 * 1024));
      await phase({ phase: 'building', count, branch, ...inspected, folders, detected, siteUrl });
      let site = 'unavailable';
      if (typeof buildSite === 'function') {
        try { site = (await buildSite({ checkout, repository: fullName }))?.state ?? 'unavailable'; } catch { site = 'failed'; }
      }
      await phase({ phase: 'ready', site: ['built', 'unavailable', 'failed'].includes(site) ? site : 'failed' });
    } catch {
      await phase({ phase: 'failed', message: 'Cyberbaser could not copy your notes from GitHub. Check that this machine is online, then try again.' }).catch(() => {});
    }
  }

  return Object.freeze({
    checkout,
    start(fullName) {
      if (!validFullName(fullName)) throw new TypeError('repository must be owner/name');
      running ??= run(fullName).finally(() => { running = null; });
      return running;
    },
    get busy() { return running !== null; },
    folderExists: (name) => state.read().notes.folders.includes(name),
  });
}

function gitWithInput(cwd, args, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: { ...cleanGitEnv(), ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`git ${args[0]} failed`))));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

/**
 * The one change setup publishes: a commit adding publish.yml on top of the
 * checkout's head, built without touching the working tree. Setup only
 * prepares it. Every push needs the owner's signature, so the node offers it
 * to the owner's signing device once one is set up (core/job-approvals.js);
 * the publisher checks that signature and the commit, then pushes it.
 */
export function createStarterPublisher({ checkout, git = defaultSetupGit, gitInput = gitWithInput }) {
  return Object.freeze({
    async prepare({ repository, folders }) {
      const text = starterPublishYml(folders);
      const head = await git(checkout, ['rev-parse', 'HEAD']);
      if (!/^[0-9a-f]{40}$/u.test(head)) fail('starter-refused', 'the notes copy has no commit');
      if (await git(checkout, ['status', '--porcelain=v1', '--untracked-files=all']) !== '') fail('starter-refused', 'the notes copy has local changes');
      const present = await git(checkout, ['ls-tree', '--name-only', head, '--', STARTER_PATH]);
      if (present !== '') fail('starter-refused', 'the repository already has a publish.yml');
      const blob = await gitInput(checkout, ['hash-object', '-w', '--stdin'], text);
      const listing = await gitInput(checkout, ['ls-tree', '-z', head], '');
      const tree = await gitInput(checkout, ['mktree', '-z'], `${listing}100644 blob ${blob}\t${STARTER_PATH}\0`);
      const owner = repository.split('/')[0];
      const who = { GIT_AUTHOR_NAME: owner, GIT_AUTHOR_EMAIL: `${owner}@users.noreply.github.com`,
        GIT_COMMITTER_NAME: owner, GIT_COMMITTER_EMAIL: `${owner}@users.noreply.github.com` };
      const commit = await gitInput(checkout, ['commit-tree', tree, '-p', head, '-F', '-'], `${STARTER_COMMIT_MESSAGE}\n`, who);
      return { commit, text };
    },
  });
}

export { starterPublishYml } from './starter-publish.js';

// ---------------------------------------------------------------- forge relay

/** The publishing-access relay for setup: the same routes as the owner app, no config file yet. */
export function createSetupForgeRelay({ socketPath, provider = 'github-app', state, request = forgeRequest }) {
  return Object.freeze({
    provider,
    get configuredRepository() { return state.read().repository ?? ''; },
    restartFor: null,
    ask(op, repository) { return request({ socketPath, op, repository }); },
    // The GitHub App manifest flow: { origin } or { code, state }, never a secret.
    askWith(op, fields) { return request({ socketPath, op, ...fields }); },
    // Unsigned: accepted only by a publisher without owner services (tests and
    // older installs). The installed publisher needs the signed owner request.
    publishStarter(commit) { return request({ socketPath, op: 'publish-starter', commit }); },
    async pick(fullName) {
      const bound = await this.ask('select', fullName);
      const chosen = bound.repository.fullName;
      if (chosen !== fullName) fail('forge-failed', 'publisher bound a different repository');
      await state.update((current) => {
        const changed = current.repository !== chosen;
        return { ...current, repository: chosen, ...(changed ? { notes: initialSetupState().notes, website: initialSetupState().website } : {}) };
      });
      return { repository: chosen, restartNeeded: false };
    },
  });
}

// ------------------------------------------------------------ owner config

/**
 * The node's configuration from a finished setup. The layout (sockets,
 * directories, listen address) belongs to the installer; the repository,
 * branch and workflow come from what setup found.
 */
export function ownerConfigFromSetup(setup, layout) {
  if (!setup.repository) fail('setup-incomplete', 'no repository was picked');
  if (!(setup.forgeApp?.clientId ?? layout.clientId)) fail('setup-incomplete', 'no GitHub App client ID');
  const [owner, name] = setup.repository.split('/');
  const pagesHost = `${owner.toLowerCase()}.github.io`;
  const branch = setup.notes.branch || 'main';
  const detected = setup.notes.detected?.workflow ?? null;
  // Private only: no public website and no deployment to watch. The node
  // builds and serves the site itself; "Live" is its own private site.
  const privateSite = setup.website?.source === 'private';
  const pagesUrl = `https://${pagesHost}${name.toLowerCase() === pagesHost ? '/' : `/${name}/`}`;
  const config = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    listen: layout.listen,
    proposalReview: { enabled: true, socketPath: layout.reviewSocket, requestTimeoutMs: 5000, maxListEntries: 100 },
    suggestions: { form: { enabled: false }, forge: { enabled: false } },
    repository: { checkout: layout.checkout, remote: { name: 'origin', url: githubRemoteUrl(setup.repository) }, branch },
    owner: { identity: owner, allowedTrustRoutes: ['auto-merge', 'quick-review'] },
    live: { baseUrl: privateSite ? (setup.notes.siteUrl ?? pagesUrl) : pagesUrl },
    workflow: privateSite ? { provider: 'private-site', branch } : {
      provider: 'github-actions', repository: setup.repository,
      name: detected?.name ?? 'Publish site',
      path: detected?.path?.endsWith('.yml') ? detected.path : '.github/workflows/publish-site.yml',
      event: 'push', branch, jobs: detected?.jobs?.length ? detected.jobs : ['build', 'deploy'], environment: 'github-pages',
    },
    workspace: { root: '.workspace/owner-alpha', store: '.workspace/owner-alpha/store', site: '.workspace/owner-alpha/site', cache: '.workspace/owner-alpha/cache' },
    paths: { include: ['**/*.md'], exclude: ['.git/**', '.workspace/**'] },
    limits: { maxSourceBytes: 2097152, maxReplacementBytes: 65536, maxChangedBytes: 65536, maxChangedLines: 60, maxArtifactBytes: 8388608,
      requestTimeoutMs: 30000, networkTimeoutMs: 900000 },
    checks: { allowedOfmVerdicts: ['clean'], requirePublishedSource: true, requireProjectionVerification: true,
      requireNoNewBrokenLinks: true, requireRenderedWitness: true },
    git: { autoCommit: true, autoPush: true, useHooks: true, commitMessagePrefix: 'cyberbaser:' },
    publisher: { socketPath: layout.publisherSocket, ...(layout.mirror ? { mirror: layout.mirror } : {}) },
    iroh: { enabled: true, stateDirectory: layout.irohStateDirectory, ...(layout.relay ? { relay: layout.relay } : {}) },
    // The app setup created from a manifest, else the one the installer was given.
    forgeAccess: { provider: 'github-app', clientId: setup.forgeApp?.clientId ?? layout.clientId, stateDirectory: layout.forgeStateDirectory },
    // The site's own renderer, installed by the installer (--renderer).
    ...(layout.renderer ? { renderer: layout.renderer } : {}),
  };
  return { config: validateOwnerAlphaConfig(config), workflowDetected: privateSite || detected !== null, privateSite };
}

// -------------------------------------------------------------------- pages

const ICON_TICK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CHECK = '<svg class="setup-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 10.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function progressHtml(step) {
  const index = SETUP_STEPS.indexOf(step);
  return `<ol class="setup-progress" aria-label="Setup progress">${SETUP_STEPS.map((name, position) => `<li class="${position < index ? 'is-done' : position === index ? 'is-current' : ''}"${position === index ? ' aria-current="step"' : ''}><span class="visually-hidden">${STEP_TITLES[name]}${position < index ? ', done' : ''}</span></li>`).join('')}</ol>`;
}

function actionButton(e, action, label, kind = '', extra = '') {
  return `<button type="button" data-action="${e(action)}"${kind ? ` class="${e(kind)}"` : ''}${extra}>${e(label)}</button>`;
}

function notesLines(e, state) {
  const { notes } = state;
  const line = (done, text) => `<li class="${done ? 'is-done' : 'is-active'}">${done ? ICON_CHECK : '<span class="setup-pulse" aria-hidden="true"></span>'}<span>${text}</span></li>`;
  if (notes.phase === 'failed') {
    return `<p class="setup-problem" role="alert">${e(notes.message ?? 'Copying your notes did not work.')}</p>
<div class="setup-actions">${actionButton(e, 'retry', 'Try again')}</div>`;
  }
  const copied = notes.count !== null;
  const items = [
    copied ? line(true, `Copied ${e(notes.count.toLocaleString('en-US'))} ${notes.count === 1 ? 'note' : 'notes'} from <strong>${e(state.repository)}</strong>`)
      : line(false, `Copying your notes from <strong>${e(state.repository)}</strong>…`),
  ];
  if (copied) {
    items.push(notes.phase === 'ready'
      ? notes.site === 'built' ? line(true, 'Built a private preview of your site')
        : `<li class="is-note"><span class="setup-dot" aria-hidden="true"></span><span>${notes.site === 'failed'
          ? 'The private preview did not build. Proposals still show, in a simpler view.'
          : 'This machine cannot build the private preview, so proposals show in a simpler view. Everything else works.'}</span></li>`
      : line(false, 'Building a private preview of your site…'));
  }
  return `<ul class="setup-lines" role="status">${items.join('')}</ul>`;
}

function publishYmlBlock(e, state) {
  const { notes } = state;
  if (notes.phase !== 'ready') return '';
  if (notes.publishYml === 'present') {
    const added = notes.choice === 'starter' ? ' You added it just now.' : '';
    return `<p class="setup-note">Your <code>publish.yml</code> decides what goes on your website. It lists ${e(notes.allowCount)} ${notes.allowCount === 1 ? 'entry' : 'entries'}; everything else stays private.${added}</p>`;
  }
  if (notes.publishYml === 'awaiting-approval') {
    return `<div class="setup-decided">${ICON_CHECK}<p>Your <code>publish.yml</code> is ready. It lists ${e(notes.allowCount)} ${notes.allowCount === 1 ? 'entry' : 'entries'}; everything else stays private. It goes to GitHub when you approve it on your phone, which setup sets up next.</p></div>`;
  }
  if (notes.publishYml === 'invalid') {
    return '<p class="setup-note">Your <code>publish.yml</code> cannot be read, so nothing will be published until it is fixed. You can continue and fix it later.</p>';
  }
  if (notes.choice === 'nothing-yet') {
    return `<div class="setup-decided">${ICON_CHECK}<p>Nothing will be published for now. Add a <code>publish.yml</code> whenever you are ready.</p>${actionButton(e, 'reopen-publish', 'Change', 'quiet')}</div>`;
  }
  const folders = notes.folders.map((folder) => `<li><label class="setup-folder"><input type="checkbox" name="folder" value="${e(folder)}"><span class="setup-check" aria-hidden="true">${ICON_TICK}</span><span class="setup-folder-name">${e(folder)}/</span></label></li>`).join('');
  return `<section class="setup-decision" aria-labelledby="publish-heading">
<h2 id="publish-heading">Nothing is marked public yet</h2>
<p>Your repository has no <code>publish.yml</code>, the file that lists which notes may go on your website. Without it Cyberbaser publishes nothing.</p>
<div class="setup-actions">${actionButton(e, 'nothing-yet', 'Publish nothing yet')}${actionButton(e, 'open-starter', 'Choose public folders', 'quiet')}</div>
<div class="setup-starter" id="setup-starter" hidden>
${folders ? `<fieldset class="setup-pick"><legend>Folders that may be public</legend><p class="setup-aside" id="setup-pick-hint">Choose any number. Nothing is chosen for you.</p>
<ul class="setup-folders" id="setup-folders" aria-describedby="setup-pick-hint">${folders}</ul></fieldset>` : '<p class="setup-note">Your notes have no folders, so the file would list nothing. You can add entries later.</p>'}
<p class="setup-change" id="setup-change" aria-live="polite">This adds one file, <code>publish.yml</code>, to <strong>${e(state.repository)}</strong>. No folder is public yet.</p>
<details class="setup-show-file"><summary>Show the file</summary><pre class="setup-file" id="setup-file" aria-label="publish.yml as it will be published">${e(starterPublishYml([]))}</pre></details>
<div class="setup-actions">${actionButton(e, 'starter', 'Publish this file')}</div>
</div>
</section>`;
}

function deviceList(e, dev, kind) {
  if (!dev) return '';
  const rows = dev.store.list().filter((device) => device.kind === kind && !device.revoked);
  if (rows.length === 0) return '';
  return `<ul class="setup-paired">${rows.map((device) => `<li>${ICON_CHECK}<span><strong>${e(device.label)}</strong> is paired</span></li>`).join('')}</ul>`;
}

// The first signing device enrols with a code only the publisher shows. The
// page embeds the publisher's own loopback page in a frame: this app can place
// it but cannot read it (the publisher refuses fetches and sends no CORS), so
// even a compromised app cannot enrol its own key.
function enrolBlock(e, enrolPort, state) {
  const starter = state.notes.publishYml === 'awaiting-approval'
    ? ' Your <code>publish.yml</code> then waits on the phone under <strong>Cyberbaser: Approvals waiting</strong>.' : '';
  return `<section class="setup-decision setup-enrol" aria-labelledby="enrol-heading">
<h2 id="enrol-heading">Let this phone approve publishing</h2>
<p>Nothing reaches your website unless you approve it on your phone. In Obsidian, scan this code with the phone you just paired, then check that both screens show the same four groups.${starter}</p>
<iframe class="setup-enrol-frame" src="http://127.0.0.1:${e(enrolPort)}/enroll" title="Publishing setup code from the publisher" sandbox="" referrerpolicy="no-referrer" loading="eager"></iframe>
<p class="setup-aside">This code comes from the publisher, not from this page. You can also do this later; nothing is published until you do.</p>
</section>`;
}

function stepBody({ e, state, csrfToken, relay, dev, pairCommand, enrolPort = null, privateDefault = false, readerAddress = null }) {
  const showPublic = state.website?.source === 'show-public';
  const step = state.step;
  if (step === 'welcome') {
    return `<h1>Set up Cyberbaser</h1>
<p class="setup-lede">Cyberbaser keeps a private copy of your notes on this machine. Your phone, your agents and your visitors can suggest changes, and nothing reaches your website until you approve it.</p>
<p class="setup-aside">About five minutes. Nothing is published while you set up.</p>
<div class="setup-actions">${actionButton(e, 'start', 'Start')}</div>`;
  }
  if (step === 'github') {
    const forge = relay === null
      ? '<p class="setup-problem" role="alert">GitHub cannot be reached from here because the publisher is not running. Restart Cyberbaser, then open a new setup link.</p>'
      : `<div id="forge" class="setup-forge" data-mode="setup" data-csrf="${e(csrfToken)}" data-provider="${e(relay.provider)}" data-configured="${e(state.repository ?? '')}"><div id="forge-panel" class="forge-panel" aria-live="polite"><p class="devices-empty">Checking GitHub access…</p></div></div>`;
    return `<h1>Connect GitHub</h1>
<p class="setup-lede">Your notes live in a GitHub repository. Sign in once and pick it. Cyberbaser can update files in that one repository and nothing else.</p>
${forge}
<div class="setup-actions setup-continue"${state.repository ? '' : ' hidden'}>${actionButton(e, 'continue', 'Continue', '', state.repository ? '' : ' disabled')}</div>`;
  }
  if (step === 'notes') {
    const ready = state.notes.phase === 'ready'
      && (['present', 'invalid', 'awaiting-approval'].includes(state.notes.publishYml) || state.notes.choice !== null);
    return `<h1>Your notes</h1>
<p class="setup-lede">Cyberbaser is making a private copy of your notes on this machine. It reads from GitHub and changes nothing there.</p>
${notesLines(e, state)}
${publishYmlBlock(e, state)}
<div class="setup-actions setup-continue"${ready ? '' : ' hidden'}>${actionButton(e, 'continue', 'Continue', '', ready ? '' : ' disabled')}</div>`;
  }
  if (step === 'website' && privateDefault && !showPublic) {
    return `<h1>Your website</h1>
<p class="setup-lede">Keep your site private. Cyberbaser builds it on this machine and shows it only here, at <span class="setup-url">${e(readerAddress ?? 'this machine')}</span>. Nothing goes on the web.</p>
<p class="setup-aside">After you approve a change on your phone, it is saved to GitHub and shows as Live on your private site once this machine has rebuilt it.</p>
<div class="setup-actions">${actionButton(e, 'private', 'Keep it private')}${actionButton(e, 'show-public', 'Use a public website instead', 'quiet')}</div>`;
  }
  if (step === 'website') {
    const detected = state.notes.detected;
    const field = `<form class="setup-field" id="website-form" novalidate${detected ? ' hidden' : ''}>
<label for="website-url">Site address</label>
<input id="website-url" name="url" type="url" inputmode="url" autocomplete="url" spellcheck="false" placeholder="https://notes.example.com/" value="${e(state.website.url ?? '')}">
<p class="setup-field-error" id="website-error" role="alert"></p>
<div class="setup-actions">${actionButton(e, 'save-url', 'Save')}${actionButton(e, 'skip', 'Skip for now', 'quiet')}</div>
</form>`;
    if (detected) {
      return `<h1>Your website</h1>
<p class="setup-lede">Cyberbaser checks your website after each change you publish, to confirm it went live.</p>
<div class="setup-found" id="website-found"><p>Your notes look published at</p><p class="setup-url">${e(detected.url)}</p><p class="setup-aside">Found in <code>${e(detected.foundIn)}</code> in your repository.</p>
<div class="setup-actions">${actionButton(e, 'confirm-detected', "That's right")}${actionButton(e, 'edit-url', 'Use a different address', 'quiet')}</div></div>
${field}`;
    }
    return `<h1>Your website</h1>
<p class="setup-lede">Where do people read your notes? Cyberbaser checks there after each change you publish, to confirm it went live.</p>
${field}`;
  }
  if (step === 'phone' || step === 'agent') {
    const kind = step === 'phone' ? 'owner-device' : 'agent';
    const paired = deviceList(e, dev, kind);
    const reachable = dev !== null && dev.pairing.available();
    // The phone paired here is the one that approves publishing, which only
    // full access allows; the owner can still choose less.
    const intro = step === 'phone'
      ? '<h1>Pair your phone</h1>\n<p class="setup-lede">Review and approve suggestions from anywhere. Scan the code with the phone, then check that both screens show the same four words.</p>'
      : '<h1>Pair an agent</h1>\n<p class="setup-lede">This is optional. An agent can only suggest changes, and you review each one. Run the line Cyberbaser shows where the agent works, then compare four words.</p>';
    const form = reachable
      ? `<div id="devices" class="setup-devices" data-csrf="${e(csrfToken)}" data-pair-command="${e(pairCommand)}">${pairFormHtml({ kind, label: step === 'phone' ? 'My phone' : 'My agent', ...(step === 'phone' ? { access: 'full' } : {}) })}</div>`
      : '<p class="setup-note">Pairing needs Cyberbaser\'s connection, which is not running yet. You can pair later from Devices.</p>';
    const skip = step === 'phone' ? 'Pair later' : 'Skip';
    const approve = step === 'phone' && paired && enrolPort !== null ? enrolBlock(e, enrolPort, state) : '';
    return `${intro}
${paired}
${approve}
${paired && reachable ? '<details class="setup-more"><summary>Pair another</summary>' : ''}${form}${paired && reachable ? '</details>' : ''}
<div class="setup-actions setup-continue">${paired ? actionButton(e, 'continue', 'Continue') : actionButton(e, 'skip', skip, 'quiet')}</div>`;
  }
  const summary = [
    ['Notes', state.repository],
    ['Website', state.website.source === 'private' ? 'Private, on this machine only' : state.website.url ?? 'Not set yet'],
    ['Phone', state.phone === 'paired' ? 'Paired' : 'Not paired yet'],
    ['Agent', state.agent === 'paired' ? 'Paired' : 'None yet'],
    ...(state.notes.publishYml === 'awaiting-approval' ? [['publish.yml', 'Waiting for your approval on your phone']] : []),
  ];
  return `<h1>Cyberbaser is ready</h1>
<p class="setup-lede">Changes your agents and visitors suggest will appear in Proposals. Nothing is published until you approve it.</p>
<dl class="setup-summary">${summary.map(([term, value]) => `<div><dt>${e(term)}</dt><dd>${e(value)}</dd></div>`).join('')}</dl>
<p class="setup-aside" id="setup-starting" role="status">Starting Cyberbaser…</p>
<div class="setup-actions"><a class="setup-link-button" href="/owner/review">Open Proposals</a><a class="setup-link-button quiet" href="/owner/devices">Devices</a></div>`;
}

export function setupPage({ state, csrfToken, relay = null, dev = null, pairCommand = 'cyberbaser pair', tools, enrolPort = null,
  privateDefault = false, readerAddress = null }) {
  const e = tools.escapeHtml;
  const index = SETUP_STEPS.indexOf(state.step);
  const back = index > 0 && state.step !== 'done';
  const scripts = ['/owner/assets/setup.js'];
  if (state.step === 'github' && relay !== null) scripts.push('/owner/assets/github.js');
  if ((state.step === 'phone' || state.step === 'agent') && dev?.pairing.available()) scripts.push('/owner/assets/devices.js');
  return tools.pageShell({
    title: `${STEP_TITLES[state.step]} · Cyberbaser setup`,
    script: scripts,
    bodyClass: 'devices-page forge-page setup-page',
    body: `<main class="setup-shell" id="setup" data-csrf="${e(csrfToken)}" data-step="${e(state.step)}" data-notes-phase="${e(state.notes.phase)}">
<header class="setup-top">${back ? actionButton(e, 'back', 'Back', 'setup-back') : '<span class="setup-mark">Cyberbaser</span>'}${progressHtml(state.step)}</header>
<section class="setup-step" aria-live="polite">
${stepBody({ e, state, csrfToken, relay, dev, pairCommand, enrolPort, privateDefault, readerAddress })}
<p class="setup-status" id="setup-status" role="status"></p>
</section>
</main>`,
  });
}

function noticePage(tools, title, text, back = false) {
  const e = tools.escapeHtml;
  const link = back ? '<div class="setup-actions"><a class="setup-link-button" href="/setup">Back to setup</a></div>' : '';
  return tools.pageShell({ title, bodyClass: 'devices-page setup-page',
    body: `<main class="setup-shell"><header class="setup-top"><span class="setup-mark">Cyberbaser</span></header><section class="setup-step"><h1>${e(title)}</h1><p class="setup-lede">${e(text)}</p>${link}</section></main>` });
}

// The page that posts the manifest to GitHub's new-app page. Its script only
// submits the form; the button works without it.
function createAppPage(tools, { action, manifest }) {
  const e = tools.escapeHtml;
  return tools.pageShell({ title: 'Create Cyberbaser\'s GitHub App', script: '/owner/assets/github-create.js', bodyClass: 'devices-page setup-page',
    body: `<main class="setup-shell"><header class="setup-top"><span class="setup-mark">Cyberbaser</span></header><section class="setup-step">
<h1>Opening GitHub…</h1>
<p class="setup-lede">GitHub shows Cyberbaser's app with everything filled in. Click <strong>Create GitHub App</strong> there; you come back here by yourself.</p>
<form id="github-create" method="post" action="${e(action)}"><input type="hidden" name="manifest" value="${e(manifest)}">
<div class="setup-actions"><button type="submit">Continue to GitHub</button></div></form>
</section></main>` });
}

function githubOrigin(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : null;
}

// ------------------------------------------------------------------ handler

const MESSAGE_NO_PUBLISHER = 'GitHub cannot be reached from here because the publisher is not running. Restart Cyberbaser, then open a new setup link.';

function forgeMessage(error) {
  return FORGE_PROBLEMS[error?.code] ?? (error?.code === 'publisher-unavailable' ? MESSAGE_NO_PUBLISHER : 'Something went wrong talking to GitHub. Try again.');
}

const PREVIOUS = Object.freeze({ github: 'welcome', notes: 'github', website: 'notes', phone: 'website', agent: 'phone' });

function validWebsiteUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || !url.hostname.includes('.')) return null;
  if (!url.pathname.endsWith('/') && !/\.[a-z0-9]+$/iu.test(url.pathname)) url.pathname = `${url.pathname}/`;
  return url.toString();
}

function isLoopback(address) {
  return typeof address === 'string' && (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1');
}

/**
 * The setup server's request handler. `reach(ownerId)` opens the device store
 * and pairing for the picked repository's owner, or returns null.
 */
export function createFirstRunHandler({
  listen, state, links, relay = null, notes, starter = null, reach = async () => null, pairCommand = 'cyberbaser pair',
  publicRoot = fileURLToPath(new URL('../public/', import.meta.url)), onComplete = () => {}, onStaleLink = null, createToken,
  // The publisher's own enrolment page (publisher/owner-control.js), or null.
  enrolPort = null,
  // 'private-site': the website step offers the private site first (installer --site private).
  publication = null,
  // Where the private site is served (http://HOST:READERPORT/), shown on the website step.
  readerAddress = null,
}) {
  const tools = ownerHttpTools();
  const { html, json, errorResponse, response, readBoundedJson, sameSecret, exactToken, requestCookie, cookieHeader, staticResponse } = tools;
  const make = createToken ?? tools.token;
  if (listen?.host !== '127.0.0.1' || !Number.isInteger(listen?.port)) throw new TypeError('setup listens on 127.0.0.1 only');
  const expectedHost = `${listen.host}:${listen.port}`;
  const expectedOrigin = `http://${expectedHost}`;
  const sessions = new Map();
  let device = null;

  async function devices() {
    const owner = state.read().repository?.split('/')[0];
    if (!owner) return null;
    if (device?.owner !== owner) {
      try { device = { owner, value: await reach(owner) }; } catch { device = { owner, value: null }; }
    }
    return device.value;
  }

  function session(request) {
    const value = requestCookie(request);
    if (!exactToken(value)) return null;
    let found = null;
    for (const [sessionToken, record] of sessions) if (sameSecret(value, sessionToken)) found = { sessionToken, ...record };
    return found;
  }

  async function act(current, body, owner) {
    const { action, value } = body;
    const go = (step, extra = {}) => state.update((now) => ({ ...now, ...extra, step }));
    if (action === 'back') {
      if (!PREVIOUS[current.step]) return 'invalid';
      await go(PREVIOUS[current.step]);
      return 'ok';
    }
    switch (`${current.step}:${action}`) {
      case 'welcome:start': await go('github'); return 'ok';
      case 'github:continue': {
        if (relay === null || !current.repository) return 'not-ready';
        let status;
        try { status = await relay.ask('status'); } catch { return 'not-ready'; }
        if (status.state !== 'connected' || status.repository !== current.repository) return 'not-ready';
        // The app's public client ID goes into the node config (ownerConfigFromSetup).
        await go('notes', typeof status.app?.clientId === 'string' ? { forgeApp: { clientId: status.app.clientId, slug: status.app.slug ?? null } } : {});
        if (current.notes.phase !== 'ready') notes.start(current.repository);
        return 'ok';
      }
      case 'notes:retry':
        if (current.notes.phase !== 'failed') return 'invalid';
        notes.start(current.repository);
        return 'ok';
      case 'notes:nothing-yet':
        if (current.notes.phase !== 'ready' || current.notes.publishYml !== 'missing') return 'invalid';
        await state.update((now) => ({ ...now, notes: { ...now.notes, choice: 'nothing-yet' } }));
        return 'ok';
      case 'notes:starter': {
        // The owner chose exactly this file on screen. It is prepared as one
        // commit here and goes to GitHub only after the owner signs it on their
        // phone (after setup); the publisher checks that signature itself.
        if (current.notes.phase !== 'ready' || current.notes.publishYml !== 'missing') return 'invalid';
        const folders = Array.isArray(value) ? value : null;
        if (folders === null || folders.length > MAX_FOLDERS || new Set(folders).size !== folders.length
          || folders.some((folder) => typeof folder !== 'string' || !current.notes.folders.includes(folder))) return 'invalid';
        if (starter === null) return 'not-ready';
        const sorted = [...folders].sort((a, b) => a.localeCompare(b));
        let prepared;
        try { prepared = await starter.prepare({ repository: current.repository, folders: sorted }); }
        catch (error) { return error?.code === 'starter-refused' ? 'starter-refused' : 'starter-failed'; }
        await state.update((now) => ({ ...now, notes: { ...now.notes, choice: 'starter', publishYml: 'awaiting-approval',
          allowCount: sorted.length, starterCommit: prepared.commit } }));
        return 'ok';
      }
      case 'notes:reopen-publish':
        if (current.notes.choice !== 'nothing-yet') return 'invalid';
        await state.update((now) => ({ ...now, notes: { ...now.notes, choice: null } }));
        return 'ok';
      case 'notes:continue':
        if (current.notes.phase !== 'ready' || (current.notes.publishYml === 'missing' && current.notes.choice === null)) return 'not-ready';
        await go('website');
        return 'ok';
      case 'website:confirm-detected':
        if (!current.notes.detected) return 'invalid';
        await go('phone', { website: { url: current.notes.detected.url, source: 'detected' } });
        return 'ok';
      case 'website:save-url': {
        const url = validWebsiteUrl(value);
        if (url === null) return 'invalid-url';
        await go('phone', { website: { url, source: 'entered' } });
        return 'ok';
      }
      case 'website:skip': await go('phone', { website: { url: null, source: 'skipped' } }); return 'ok';
      case 'website:private': await go('phone', { website: { url: null, source: 'private' } }); return 'ok';
      case 'website:show-public':
        await state.update((now) => ({ ...now, website: { url: null, source: 'show-public' } }));
        return 'ok';
      case 'phone:skip': await go('agent', { phone: 'later' }); return 'ok';
      case 'agent:skip':
      case 'agent:continue':
      case 'phone:continue': {
        const kind = current.step === 'phone' ? 'owner-device' : 'agent';
        const paired = (owner?.store.list() ?? []).some((entry) => entry.kind === kind && !entry.revoked);
        if (action === 'continue' && !paired) return 'not-ready';
        if (current.step === 'phone') { await go('agent', { phone: 'paired' }); return 'ok'; }
        await go('done', { agent: paired ? 'paired' : 'skipped', completedAt: new Date().toISOString() });
        return 'complete';
      }
      default: return 'invalid';
    }
  }

  // Back to /setup from a page GitHub sent the browser to.
  function backToSetup(title, text) {
    return html(noticePage(tools, title, text, true), 200, { Refresh: '0; url=/setup' });
  }

  async function githubReturn(request, url) {
    if (!['GET', 'HEAD'].includes(request.method)) return response(null, 405, { Allow: 'GET, HEAD' });
    if (state.read().completedAt !== null) return html(noticePage(tools, 'Setup is finished', 'Cyberbaser is already set up.'), 410);
    if (relay === null) return html(noticePage(tools, 'GitHub cannot be reached', MESSAGE_NO_PUBLISHER, true), 503);
    const keys = [...url.searchParams.keys()];
    const refused = (code = 'app-state-invalid', status = 403) => html(noticePage(tools, 'GitHub needs attention',
      FORGE_PROBLEMS[code] ?? FORGE_PROBLEMS['app-state-invalid'], true), status);
    if (new Set(keys).size !== keys.length) return refused('app-state-invalid', 400);
    const value = (name) => url.searchParams.get(name);
    try {
      if (url.pathname === CALLBACK_PATHS.installed) {
        // GitHub adds installation_id and setup_action (and may return our
        // state). None is trusted: the publisher's open install window decides,
        // and the installation is checked with the owner's own token later.
        if (keys.some((key) => !['installation_id', 'setup_action', 'state'].includes(key))) return refused();
        const next = githubOrigin((await relay.askWith('app-installed', { origin: expectedOrigin }))?.url);
        if (next === null) return refused('github-unreachable', 502);
        return response(null, 303, { Location: next.toString() });
      }
      if (url.pathname === CALLBACK_PATHS.authorized && keys.includes('error')) {
        return html(noticePage(tools, 'Sign-in was cancelled', FORGE_PROBLEMS.denied, true), 200);
      }
      if (keys.length !== 2 || !validCode(value('code')) || !validFlowState(value('state'))) return refused();
      if (url.pathname === CALLBACK_PATHS.created) {
        const created = await relay.askWith('app-created', { code: value('code'), state: value('state') });
        if (typeof created?.app?.clientId === 'string') {
          await state.update((now) => ({ ...now, forgeApp: { clientId: created.app.clientId, slug: created.app.slug ?? null } }));
        }
        return backToSetup('Cyberbaser\'s GitHub App is ready', 'Next, install it on the repository with your notes.');
      }
      await relay.askWith('app-authorized', { code: value('code'), state: value('state') });
      // One repository the app may publish to: pick it, so the owner only continues.
      if (!state.read().repository) {
        try {
          const listing = await relay.ask('repositories');
          const usable = listing.repositories.filter((row) => row.problem === null);
          if (usable.length === 1) await relay.pick(usable[0].fullName);
        } catch { /* the picker shows the reason */ }
      }
      return backToSetup('GitHub is connected', 'Taking you back to setup.');
    } catch (error) {
      return html(noticePage(tools, 'GitHub needs attention', forgeMessage(error), true), 409);
    }
  }

  const handler = async function firstRunFetch(request, server) {
    if (!(request instanceof Request)) return errorResponse(400, 'invalid-request');
    if (request.headers.get('host') !== expectedHost) return errorResponse(421, 'invalid-host');
    const remote = server?.requestIP?.(request)?.address;
    if (remote !== undefined && !isLoopback(remote)) return errorResponse(403, 'loopback-only');
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) return response(null, 405, { Allow: 'GET, HEAD, POST' });
    let url;
    try { url = new URL(request.url); } catch { return errorResponse(400, 'invalid-url'); }
    if (url.origin !== expectedOrigin) return errorResponse(421, 'invalid-host');

    if (url.pathname === '/owner/assets/owner.css') {
      if (url.search !== '') return errorResponse(400, 'unexpected-query');
      return staticResponse(publicRoot, 'owner.css', request, { directoryIndex: false });
    }

    if (url.pathname === '/setup/start') {
      if (!['GET', 'HEAD'].includes(request.method)) return response(null, 405, { Allow: 'GET, HEAD' });
      if (state.read().completedAt !== null) {
        return html(noticePage(tools, 'Setup is finished', 'Cyberbaser is already set up. Use the sign-in link it prints to open it.'), 410);
      }
      const keys = [...url.searchParams.keys()];
      const consumed = keys.length === 1 && keys[0] === 'token' && links.consume(url.searchParams.get('token'));
      if (!consumed) {
        onStaleLink?.();
        return html(noticePage(tools, 'This setup link has expired', 'Each setup link works once, for an hour. A fresh one has just been written to Cyberbaser\'s log ("cyberbaser status" shows it).'), 403);
      }
      if (sessions.size >= MAX_SETUP_SESSIONS) sessions.delete(sessions.keys().next().value);
      const sessionToken = make();
      const csrfToken = make();
      if (!exactToken(sessionToken) || !exactToken(csrfToken) || sessionToken === csrfToken) throw new TypeError('token factory');
      sessions.set(sessionToken, { csrfToken });
      return response(null, 303, { Location: '/setup', 'Set-Cookie': cookieHeader(sessionToken) });
    }

    // GitHub's returns from the app flow. The owner's session cookie is
    // SameSite=Strict, so it is not sent on these cross-site arrivals: each is
    // authorized by the publisher's one-use state instead, and ends on a page
    // whose own navigation back to /setup carries the cookie again.
    if (Object.values(CALLBACK_PATHS).includes(url.pathname)) return githubReturn(request, url);

    const owner = session(request);
    if (owner === null) {
      if (url.pathname === '/setup' && request.method === 'GET') {
        onStaleLink?.();
        return html(noticePage(tools, 'Open your setup link', 'Setup opens from a one-time link. A fresh one has just been written to Cyberbaser\'s log ("cyberbaser status" shows it).'), 403);
      }
      return errorResponse(403, 'invalid-session');
    }
    const { csrfToken } = owner;
    if (request.method === 'POST' && request.headers.get('origin') !== expectedOrigin) return errorResponse(403, 'invalid-origin');

    const asset = { '/owner/assets/setup.js': 'setup.js', '/owner/assets/github.js': 'github.js', '/owner/assets/devices.js': 'devices.js',
      '/owner/assets/github-create.js': 'github-create.js' }[url.pathname];
    if (asset) {
      if (!['GET', 'HEAD'].includes(request.method)) return response(null, 405, { Allow: 'GET, HEAD' });
      if (url.search !== '') return errorResponse(400, 'unexpected-query');
      return staticResponse(publicRoot, asset, request, { directoryIndex: false });
    }

    if (url.pathname === '/setup') {
      if (!['GET', 'HEAD'].includes(request.method)) return response(null, 405, { Allow: 'GET, HEAD' });
      if (url.search !== '') return errorResponse(400, 'unexpected-query');
      const current = state.read();
      const dev = ['phone', 'agent'].includes(current.step) ? await devices() : null;
      const frame = enrolPort !== null && current.step === 'phone'
        ? { 'Content-Security-Policy': `${tools.ownerCsp}; frame-src http://127.0.0.1:${enrolPort}` } : {};
      return html(request.method === 'HEAD' ? null : setupPage({ state: current, csrfToken, relay, dev, pairCommand, tools, enrolPort,
        privateDefault: publication === 'private-site', readerAddress }), 200, frame);
    }
    if (['/setup/github/create', '/setup/github/install', '/setup/github/sign-in'].includes(url.pathname)) {
      if (request.method !== 'GET') return response(null, 405, { Allow: 'GET' });
      if (url.search !== '') return errorResponse(400, 'unexpected-query');
      if (state.read().step !== 'github') return response(null, 303, { Location: '/setup' });
      if (relay === null) return html(noticePage(tools, 'GitHub cannot be reached', MESSAGE_NO_PUBLISHER, true), 503);
      const op = { '/setup/github/create': 'new-app', '/setup/github/install': 'install-app', '/setup/github/sign-in': 'web-sign-in' }[url.pathname];
      let result;
      try { result = await relay.askWith(op, { origin: expectedOrigin }); }
      catch (error) { return html(noticePage(tools, 'GitHub needs attention', forgeMessage(error), true), 409); }
      if (op === 'new-app') {
        const action = githubOrigin(result?.action);
        if (action === null || typeof result.manifest !== 'string' || result.manifest.length > 8192) {
          return html(noticePage(tools, 'GitHub needs attention', FORGE_PROBLEMS['app-conversion-failed'], true), 502);
        }
        const csp = tools.ownerCsp.replace("form-action 'self'", `form-action 'self' ${action.origin}`);
        return html(createAppPage(tools, { action: action.toString(), manifest: result.manifest }), 200, { 'Content-Security-Policy': csp });
      }
      const target = githubOrigin(result?.url);
      if (target === null) return html(noticePage(tools, 'GitHub needs attention', FORGE_PROBLEMS['github-unreachable'], true), 502);
      return response(null, 303, { Location: target.toString() });
    }
    if (url.pathname === '/setup/state') {
      if (request.method !== 'GET') return response(null, 405, { Allow: 'GET' });
      const { step, notes: progress } = state.read();
      return json({ step, notes: { phase: progress.phase, count: progress.count, site: progress.site } });
    }
    if (url.pathname === '/setup/step') {
      if (request.method !== 'POST') return response(null, 405, { Allow: 'POST' });
      if (url.search !== '') return errorResponse(400, 'unexpected-query');
      let body;
      try {
        body = await readBoundedJson(request, 16 * 1024, (text) => {
          const value = JSON.parse(text);
          if (!plainObject(value) || Object.keys(value).sort().join(',') !== 'action,csrf,step,value'
            || typeof value.action !== 'string' || typeof value.step !== 'string') throw new Error('fields');
          return value;
        });
      } catch (error) { return errorResponse(error?.status ?? 400, 'invalid-setup-body'); }
      if (!sameSecret(body.csrf, csrfToken)) return errorResponse(403, 'invalid-csrf');
      const current = state.read();
      // The page names the step it was showing; a stale or replayed click does nothing.
      if (body.step !== current.step) return json({ ok: false, code: 'step-changed' }, 409);
      if (current.step === 'done') return json({ ok: false, code: 'setup-complete' }, 409);
      const outcome = await act(current, body, ['phone', 'agent'].includes(current.step) ? await devices() : null);
      if (outcome === 'complete') {
        const finished = state.read();
        queueMicrotask(() => onComplete({ state: finished, session: { sessionToken: owner.sessionToken, csrfToken } }));
        return json({ ok: true, step: 'done' });
      }
      if (outcome !== 'ok') return json({ ok: false, code: outcome }, outcome === 'invalid-url' ? 400 : outcome === 'starter-failed' ? 502 : 409);
      return json({ ok: true, step: state.read().step });
    }

    if (state.read().completedAt !== null) return errorResponse(404, 'not-found');
    const forge = await handleForgeSetup({ request, url, csrfToken, setup: relay, tools });
    if (forge !== null) return forge;
    if (url.pathname.startsWith('/owner/devices/')) {
      const dev = await devices();
      return await handleDeviceRoutes({ request, url, csrfToken, devices: dev, page: false });
    }
    return errorResponse(404, 'not-found');
  };
  return handler;
}

/**
 * Runs first-run setup on 127.0.0.1. Resolves `completed` with the finished
 * state and the owner's browser session once the owner reaches Done, so an
 * installer running the node in this same process can adopt that session.
 */
export async function runFirstRun({
  stateDirectory, port, publisherSocket = null, provider = 'github-app', reach, git, fetchUrlFor, buildSite = null,
  pairCommand, serve = Bun.serve, createToken, clock, checkout = undefined, mirror = null,
  // The publisher's enrolment page port (port + 2 in the installed layout), or null.
  enrolPort = null,
  publication = null, readerAddress = null,
  // Where a fresh setup link is written when an expired or missing one is used
  // (the same place as the first one: the service log). At most one per 30 s.
  announceLink = null,
}) {
  const state = await openSetupState(stateDirectory);
  const tools = ownerHttpTools();
  const links = createSetupLinks({ createToken: createToken ?? tools.token, sameSecret: tools.sameSecret, clock,
    isComplete: () => state.read().completedAt !== null });
  const relay = publisherSocket === null ? null : createSetupForgeRelay({ socketPath: publisherSocket, provider, state });
  const viaMirror = mirror !== null && relay !== null;
  const notes = createNotesPreparer({ state, directory: stateDirectory, git, fetchUrlFor, buildSite,
    ...(checkout === undefined ? {} : { checkout }),
    ...(viaMirror ? { mirror, refresh: () => relay.ask('fetch') } : {}) });
  const starter = viaMirror ? createStarterPublisher({ checkout: notes.checkout, ...(git ? { git } : {}) }) : null;
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  const handler = createFirstRunHandler({ listen: { host: '127.0.0.1', port }, state, links, relay, notes, starter, reach, pairCommand,
    createToken, onComplete: (result) => finish(result), enrolPort, publication, readerAddress,
    onStaleLink: announceLink === null ? null : () => {
      const now = (clock ?? Date.now)();
      if (now - lastAnnounced < 30_000 || state.read().completedAt !== null) return;
      lastAnnounced = now;
      try { announceLink(`${origin}/setup/start?token=${links.issue()}`); } catch { /* setup finished */ }
    } });
  let lastAnnounced = -Infinity;
  // A restart while the notes were being copied picks the copy up again.
  const resumed = state.read();
  if (resumed.repository && ['cloning', 'building'].includes(resumed.notes.phase)) notes.start(resumed.repository);
  const server = serve({ hostname: '127.0.0.1', port, fetch: handler });
  const origin = `http://127.0.0.1:${server.port ?? port}`;
  return Object.freeze({
    origin,
    state,
    completed,
    notes,
    setupLink: () => `${origin}/setup/start?token=${links.issue()}`,
    stop: (force) => server.stop?.(force),
  });
}
