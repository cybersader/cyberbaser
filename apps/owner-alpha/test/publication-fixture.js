import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { applyAcceptedOperation } from '../src/apply.js';
import { commitAppliedCandidate, pushExactCommit, verifyExactCommit } from '../src/git-publish.js';
import os from 'node:os';
import path from 'node:path';
import { validateOwnerAlphaConfig } from '../src/config.js';
import { createEditSession, assertCheckoutReady, defaultGitRunner } from '../src/source.js';
import { defineStoreContext, prepareStore } from '../src/store.js';
import { createSaveHandler } from '../src/pipeline.js';
import { createOwnerPublicationRuntime, createPublicationSourceGuard } from '../src/owner-publication-runtime.js';

export const BASE = '# Synthetic page\n\nThe old value.\n';
export const EDITED = BASE.replace('old', 'new');
export const PRIVATE_ID = 'private-source-sentinel';
export const PRIVATE_PATH = 'Private-sentinel/Authoring.md';
export const MAPPING = { id: 'one-page', source: { identity: PRIVATE_ID, path: PRIVATE_PATH }, relativePath: 'Notes/Page.md', slug: 'Notes/page' };
export const cleanup = [];
export function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
export async function command(root, args) {
  const proc = Bun.spawn(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (status) throw new Error(`synthetic Git command failed: ${stderr}`);
  return stdout.trim();
}
function localGitRunner(tempRoot, checkout, remote) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file',
    GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', HOME: tempRoot, XDG_CONFIG_HOME: tempRoot,
    TMPDIR: tempRoot, TEMP: tempRoot, TMP: tempRoot });
  const exec = async (cwd, args) => {
    const proc = Bun.spawn(['git', '-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false',
      '-c', 'commit.gpgSign=false', ...args], { env, stdout: 'pipe', stderr: 'ignore' });
    const [bytes, status] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
    if (status) throw new Error(`synthetic local Git ${args[0]} failed`);
    return Buffer.from(bytes);
  };
  return async (cwd, args, { encoding = 'buffer', maxBytes = 8 * 1024 * 1024 } = {}) => {
    if (![tempRoot, checkout, remote].includes(cwd) || await realpath(cwd) !== cwd) throw new Error('synthetic Git cwd refused');
    if (['push', 'ls-remote'].includes(args[0])) {
      // The only transport calls use the owned checkout and one known named
      // remote. Check expanded fetch and push URLs including secondary URLs.
      if (cwd !== checkout || await realpath(remote) !== remote
        || !(await exec(cwd, ['remote'])).equals(Buffer.from('origin\n'))
        || !(await exec(cwd, ['remote', 'get-url', '--all', 'origin'])).equals(Buffer.from(`${remote}\n`))
        || !(await exec(cwd, ['remote', 'get-url', '--push', '--all', 'origin'])).equals(Buffer.from(`${remote}\n`))) {
        throw new Error('synthetic local Git remote refused');
      }
      const destination = args[0] === 'ls-remote' ? args[2] : args.at(-2);
      if (destination !== 'origin') throw new Error('synthetic local Git destination refused');
    }
    const bytes = await exec(cwd, args);
    if (bytes.length > maxBytes) throw new Error('synthetic Git output exceeded the fixture limit');
    return encoding === 'buffer' ? bytes : bytes.toString('utf8').trim();
  };
}

function localGitEffects(remote, git) {
  const gitDeps = { git, mutateGit: git };
  return {
    applyAcceptedOperation: (input) => applyAcceptedOperation(input, { git }),
    commitAppliedCandidate: (input) => commitAppliedCandidate(input, gitDeps),
    verifyExactCommit: (input) => verifyExactCommit(input, gitDeps),
    pushExactCommit: (input) => pushExactCommit({ ...input, remoteUrl: remote }, gitDeps),
    getHead: (cwd) => git(cwd, ['rev-parse', 'HEAD'], { encoding: 'utf8' }),
    discoverDeploymentRun: async ({ applicationSha }) => ({ synthetic: true,
      binding: { provider: 'github-actions', runId: 'synthetic-local-only', headSha: applicationSha, runAttempt: 1 } }),
    monitorDeploymentRun: async ({ applicationSha, boundRun }) => ({ synthetic: true,
      provider: 'github-actions', run: { ...boundRun, headSha: applicationSha }, environment: { state: 'success' } }),
    confirmLivePage: async () => ({ synthetic: true, oldWitnessAbsent: true, newWitnessUnique: true }),
    rebuildLocal: async ({ commit }) => ({ synthetic: true, status: 'local-rebuilt', commit }),
  };
}

export async function publicationFixture({ trust = 'trusted: [example]\n', overrides = {}, onRoot,
  workspace = false, retiredFile, sourcePath = PRIVATE_PATH, sourceIdentity = PRIVATE_ID,
  base = BASE, localGit = false, allowProperties, publishConfig } = {}) {
  const tempRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'publication-runtime-'));
  const root = localGit ? path.join(tempRoot, 'delivery') : tempRoot;
  cleanup.push(tempRoot);
  try { await onRoot?.(tempRoot); }
  catch (error) {
    // This root was just allocated here. Callback refusal must not orphan it;
    // existing afterEach still confirms/removes its registered cleanup entry.
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
  const remote = path.join(tempRoot, 'local-only.git');
  const actualGit = localGit ? localGitRunner(tempRoot, root, remote) : null;
  const run = actualGit ? (cwd, args) => actualGit(cwd, args, { encoding: 'utf8' }) : command;
  if (localGit) await mkdir(root, { mode: 0o700 });
  await run(root, ['init', '-q', '-b', 'main', ...(localGit ? ['--template='] : [])]);
  await run(root, ['config', 'user.name', 'Synthetic Owner']);
  await run(root, ['config', 'user.email', 'synthetic@example.invalid']);
  const raw = JSON.parse(await readFile(new URL('../owner-alpha.example.json', import.meta.url), 'utf8'));
  raw.repository.checkout = root;
  raw.repository.remote.url = 'https://github.com/example/fixture.git';
  raw.owner.identity = 'example'; raw.workflow.repository = 'example/fixture'; raw.live.baseUrl = 'https://example.github.io/fixture/';
  const mapping = { ...MAPPING, source: { identity: sourceIdentity, path: sourcePath, ...(workspace ? { kind: 'workspace' } : {}) } };
  if (allowProperties !== undefined) raw.owner.allowProperties = allowProperties;
  raw.ownerPublication = { enabled: true, mappings: [mapping], ...(retiredFile === undefined ? {} : { retiredList: { file: retiredFile } }) };
  const config = validateOwnerAlphaConfig(raw);
  if (localGit) await run(tempRoot, ['init', '--bare', '-q', '-b', 'main', '--template=', remote]);
  await run(root, ['remote', 'add', 'origin', localGit ? remote : config.repository.remote.url]);
  await mkdir(path.join(root, 'Notes'));
  await writeFile(path.join(root, 'Notes/Page.md'), base);
  if (publishConfig !== undefined) await writeFile(path.join(root, 'publish.yml'), publishConfig);
  await writeFile(path.join(root, '.gitignore'), '.workspace/\n');
  if (trust !== null) { await mkdir(path.join(root, '.cyberbaser')); await writeFile(path.join(root, '.cyberbaser/trust.yml'), trust); }
  await run(root, ['add', '.']);
  // Disposable repository created by this test, never the project or real content.
  await run(root, ['commit', '-q', '-m', 'synthetic fixture']);
  if (localGit) await run(root, ['push', '-q', '-u', 'origin', 'main']);
  const head = await run(root, ['rev-parse', 'HEAD']);
  const git = async (checkout, args, options = {}) => {
    if (!localGit) return args[0] === 'ls-remote'
      ? `${await command(checkout, ['rev-parse', 'HEAD'])}\trefs/heads/main` : defaultGitRunner(checkout, args, options);
    // A validated remote is presented as the policy identity only to source capture.
    if (['remote get-url origin', 'remote get-url --push origin'].includes(args.join(' '))) {
      if (await run(checkout, args) !== remote) throw new Error('synthetic remote changed');
      return config.repository.remote.url;
    }
    return actualGit(checkout, args, { encoding: 'utf8', ...options });
  };
  const context = defineStoreContext({ projectRoot: root, workspaceRoot: path.join(root, config.workspace.root), storeRoot: path.join(root, config.workspace.store) });
  await prepareStore(context);
  let text = EDITED; let version = 7; let unavailable = false; let reads = 0; let attribution; let readFailure;
  const readNote = async () => {
    reads += 1;
    if (readFailure !== undefined) throw readFailure;
    if (unavailable) throw new Error(`${PRIVATE_ID} ${PRIVATE_PATH}`);
    const bytes = Buffer.from(text);
    return { identity: mapping.source.identity, path: mapping.source.path,
      ...(version === undefined ? {} : { version }), ...(attribution === undefined ? {} : { attribution }), text, bytesBase64: bytes.toString('base64'), byteLength: bytes.length,
      digest: `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:` };
  };
  const renderGate = deferred(); const completions = []; let renderCalls = 0;
  const dependencies = { assertCheckoutReady: (value) => assertCheckoutReady(value, { git }),
    runPreApplyChecks: async () => { renderCalls += 1; return renderGate.promise; },
    revalidateSource: createPublicationSourceGuard({ config, context, readNote }),
    ...(localGit ? localGitEffects(remote, actualGit) : {}), ...overrides };
  const pipeline = createSaveHandler({ config, context, projectRoot: root, dependencies });
  let completion;
  const wrapped = { ...pipeline, startEdit(input) { const handle = pipeline.startEdit(input); completion = handle.completion; return handle; } };
  const runtime = createOwnerPublicationRuntime({ config, context, readNote, pipeline: wrapped,
    sourceSession: (input) => createEditSession({ ...input, git }),
    ...(localGit ? { git: actualGit } : {}),
    checkoutReady: dependencies.assertCheckoutReady,
    onCompletion: (outcome) => { completions.push(outcome); } });
  return { root, tempRoot, remote, actualGit, config, context, head, git, mapping, readNote, runtime, pipeline, dependencies, renderGate, completions,
    prepare: () => runtime.prepare({ mappingId: MAPPING.id }),
    setSource(value = EDITED, nextVersion = 8) { text = value; version = nextVersion; },
    omitVersion() { version = undefined; },
    setAttribution(value) { attribution = value; },
    setReaderFailure(value) { readFailure = value; },
    setUnavailable(value = true) { unavailable = value; },
    get reads() { return reads; }, get renderCalls() { return renderCalls; }, get completion() { return completion; } };
}
