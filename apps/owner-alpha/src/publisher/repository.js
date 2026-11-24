import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fail } from '../errors.js';
import { pushExactCommitFromBare } from '../git-publish.js';

const exec = promisify(execFile);
const OID = /^[0-9a-f]{40}$/u;
const PACK = /^pack-[0-9a-f]{40}\.pack$/u;
const MAX_SOURCE_BYTES = 1024 * 1024 * 1024;
const MAX_SOURCE_FILES = 100_000;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY;
const BARE_CONFIG = /^\[core\]\n\trepositoryformatversion = 0\n\tfilemode = (?:true|false)\n\tbare = true\n$/u;
export const SETTINGS = [
  'core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.attributesFile=/dev/null',
  'protocol.allow=never', 'protocol.https.allow=always', 'protocol.file.allow=never', 'protocol.ext.allow=never',
  'fetch.fsckObjects=true', 'transfer.fsckObjects=true', 'credential.helper=',
  'submodule.recurse=false', 'fetch.recurseSubmodules=false', 'push.followTags=false',
  'http.followRedirects=false', 'gc.auto=0',
];

const FORGE_CREDENTIAL_HELPER = `!f() { test "$1" = get || exit 0; printf 'username=%s\\npassword=%s\\n' "$CYBERBASER_PUSH_USERNAME" "$CYBERBASER_PUSH_PASSWORD"; }; f`;

function unsafeRepository() {
  fail('publisher-unsafe-repository', 'publisher needs its own protected, template-free bare repository');
}

function invalidObjectSource() {
  fail('publisher-failed', 'publisher could not import the exact commit from the source object store');
}

function normalizedAbsolute(value) {
  return typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value
    && value !== '/' && !value.endsWith('/') && !/[\p{Cc}]/u.test(value);
}

function nested(parent, child) {
  return child === parent || child.startsWith(`${parent}/`);
}

export function makeRunner(repository, environment) {
  // Do not inherit config injection, git-dir/object overrides, aliases, tracing,
  // transport settings, etc. The optional helper belongs to this process only.
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith('GIT_')));
  const credentialHelper = env.OWNER_ALPHA_PUBLISHER_CREDENTIAL_HELPER;
  delete env.OWNER_ALPHA_PUBLISHER_CREDENTIAL_HELPER;
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
  });
  return async function run(args, { encoding = 'buffer', objects, input, credential = null } = {}) {
    const transport = args[0] === 'ls-remote' || args[0] === 'push' || args[0] === 'fetch';
    // A ForgeAccess credential reaches only this one transport child, through
    // its environment, never its arguments; the inline helper answers "get" only.
    const forge = transport && credential !== null;
    const helper = forge ? FORGE_CREDENTIAL_HELPER : credentialHelper;
    const childEnv = { ...env, ...(objects === undefined ? {} : { GIT_OBJECT_DIRECTORY: objects }),
      ...(forge ? { CYBERBASER_PUSH_USERNAME: credential.username, CYBERBASER_PUSH_PASSWORD: credential.password } : {}) };
    const invocation = exec('git', [
      '--git-dir', repository, '--no-pager', ...SETTINGS.flatMap((setting) => ['-c', setting]),
      ...(transport && helper ? ['-c', `credential.helper=${helper}`] : []), ...args,
    ], {
      cwd: repository, encoding, maxBuffer: 64 * 1024 * 1024, env: childEnv,
    });
    invocation.child.stdin.on('error', () => {}); // report the Git failure, not an EPIPE
    invocation.child.stdin.end(input);
    const { stdout } = await invocation;
    return encoding === 'buffer' ? Buffer.from(stdout) : String(stdout).trim();
  };
}

async function metadata(target, allowAbsent = false) {
  try { return await lstat(target); }
  catch (error) { if (allowAbsent && error?.code === 'ENOENT') return null; throw error; }
}

async function protectedDirectory(directory, uid, endpoint) {
  const entry = await metadata(directory, endpoint);
  if (entry === null) return null;
  if (!entry.isDirectory() || (endpoint ? entry.uid !== uid : ![0, uid].includes(entry.uid))
    || ((entry.mode & 0o022) !== 0 && (endpoint || (entry.mode & 0o1000) === 0))) unsafeRepository();
  return entry;
}

async function protectedEntry(target, uid, directory) {
  const entry = await metadata(target);
  if (entry.uid !== uid || (entry.mode & 0o022) !== 0 || (directory ? !entry.isDirectory()
    : !entry.isFile() || entry.nlink !== 1)) unsafeRepository();
}

async function prepareRepository(repository, uid, run) {
  // Refuse any ancestor the app could replace. Sticky directories such as
  // /tmp are fine only because the immediate child must be root/publisher owned.
  let current = '/';
  for (const segment of repository.slice(1).split('/')) {
    current = path.join(current, segment);
    if (await protectedDirectory(current, uid, current === repository) === null) {
      await mkdir(current, { mode: 0o700 });
      await protectedDirectory(current, uid, true);
    }
  }
  const entries = await readdir(repository);
  if (entries.length === 0) await run(['-c', 'init.defaultBranch=main', 'init', '--bare', '--template=', '--object-format=sha1']);
  // This is a dedicated repository, not a configurable mirror. Only init's
  // minimal metadata may affect Git. Per-job object directories are private
  // scratch paths, never part of default object discovery.
  for (const name of await readdir(repository)) {
    if (!['config', 'HEAD', 'objects', 'refs'].includes(name) && !/^\.import-[A-Za-z0-9]{6}$/u.test(name)) unsafeRepository();
  }
  for (const name of ['config', 'HEAD']) await protectedEntry(path.join(repository, name), uid, false);
  const config = await readFile(path.join(repository, 'config'));
  if (!BARE_CONFIG.test(config.toString('latin1'))
    || !/^ref: refs\/heads\/[A-Za-z0-9._-]+\n$/u.test(await readFile(path.join(repository, 'HEAD'), 'latin1'))) unsafeRepository();
  for (const [name, children] of [['objects', ['info', 'pack']], ['refs', ['heads', 'tags']]]) {
    const directory = path.join(repository, name);
    await protectedEntry(directory, uid, true);
    if ((await readdir(directory)).some((entry) => !children.includes(entry))) unsafeRepository();
    for (const child of children) {
      const target = path.join(directory, child);
      await protectedEntry(target, uid, true);
      if ((await readdir(target)).length !== 0) unsafeRepository();
    }
  }
}

function within(handle, name = '') {
  return `/proc/self/fd/${handle.fd}${name ? `/${name}` : ''}`;
}

async function openSourceDirectory(checkout) {
  if (!normalizedAbsolute(checkout) || process.platform !== 'linux') invalidObjectSource();
  let handle = await open('/', DIRECTORY_FLAGS);
  try {
    for (const segment of [...checkout.slice(1).split('/'), '.git', 'objects']) {
      const next = await open(within(handle, segment), DIRECTORY_FLAGS);
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function copyObject(source, target, budget) {
  // Check the opened inode, not a pathname that can be swapped after lstat.
  // No symlinks, devices, pipes, or hardlinks are admitted as object bytes.
  const from = await open(source, FILE_FLAGS);
  try {
    const entry = await from.stat();
    if (!entry.isFile() || entry.nlink !== 1 || ++budget.files > MAX_SOURCE_FILES
      || entry.size > MAX_SOURCE_BYTES - budget.bytes) invalidObjectSource();
    const to = await open(target, 'wx', 0o600);
    try {
      for (let remaining = entry.size; remaining > 0;) {
        const { bytesRead } = await from.read(budget.buffer, 0, Math.min(remaining, budget.buffer.length), null);
        if (bytesRead === 0) invalidObjectSource();
        remaining -= bytesRead;
        for (let offset = 0; offset < bytesRead;) {
          const { bytesWritten } = await to.write(budget.buffer, offset, bytesRead - offset, null);
          if (bytesWritten === 0) invalidObjectSource();
          offset += bytesWritten;
        }
      }
    } finally { await to.close(); }
    budget.bytes += entry.size;
  } finally { await from.close(); }
}

export async function snapshotObjects(checkout, output) {
  const budget = { buffer: Buffer.allocUnsafe(128 * 1024), files: 0, bytes: 0 };
  const packs = [];
  const source = await openSourceDirectory(checkout);
  try {
    for (const name of await readdir(within(source))) {
      if (name !== 'pack' && !/^[0-9a-f]{2}$/u.test(name)) continue;
      const directory = await open(within(source, name), DIRECTORY_FLAGS);
      const target = path.join(output, name);
      try {
        await mkdir(target, { mode: 0o700 });
        for (const entry of await readdir(within(directory))) {
          if (!(name === 'pack' ? PACK.test(entry) : /^[0-9a-f]{38}$/u.test(entry))) continue;
          const destination = path.join(target, entry);
          await copyObject(within(directory, entry), destination, budget);
          if (name === 'pack') packs.push(destination);
        }
      } finally { await directory.close(); }
    }
  } finally { await source.close(); }
  return packs;
}

// onPushed({ commit, branch, pack }) runs after a confirmed push, while the
// validated pack still exists, so the publisher's mirror can adopt the commit
// without another network round trip.
export async function createIsolatedPush({ repository, checkout, uid, environment = process.env, forgeAccess = null, onPushed = null }) {
  if (!normalizedAbsolute(repository) || !normalizedAbsolute(checkout)
    || nested(checkout, repository) || nested(repository, checkout) || process.platform !== 'linux') unsafeRepository();
  const run = makeRunner(repository, environment);
  try { await prepareRepository(repository, uid, run); }
  catch { unsafeRepository(); }
  return async (request) => {
    if (request.checkout !== checkout || typeof request.commit !== 'string' || !OID.test(request.commit)
      || typeof request.expectedMessage !== 'string') invalidObjectSource();
    const scratch = await mkdtemp(path.join(repository, '.import-'));
    try {
      const source = path.join(scratch, 'source');
      const checked = path.join(scratch, 'checked');
      const packDir = path.join(checked, 'pack');
      await mkdir(source, { mode: 0o700 });
      await mkdir(packDir, { recursive: true, mode: 0o700 });
      const packs = await snapshotObjects(checkout, source);
      // No checkout-side git-config, upload-pack, loose refs, alternates,
      // shallow state, pack index, or promisor metadata ever reaches Git.
      for (const pack of packs) await run(['index-pack', '--fsck-objects', pack], { objects: source });
      const prefix = path.join(packDir, 'pack');
      const packId = await run(['pack-objects', '--quiet', '--revs', '--window=0', '--no-reuse-delta', '--no-reuse-object', prefix], {
        objects: source, input: `${request.commit}\n`, encoding: 'utf8',
      });
      if (!OID.test(packId)) invalidObjectSource();
      // Validate the exact pack with no other object stores available. This
      // hashes objects and checks links and structure before verification/push.
      await run(['index-pack', '--strict', `${prefix}-${packId}.pack`], { objects: checked });
      // Signed publish: the commit must be exactly what the owner's device
      // approved, read from this validated pack and nothing else.
      if (typeof request.verifyCommit === 'function') {
        await request.verifyCommit((args) => run(args, { objects: checked }), request.commit);
      }
      // A short-lived credential for exactly this push, fetched after the commit
      // is proven and dropped when this function returns.
      const credential = forgeAccess === null ? null : await forgeAccess.pushCredential(request.remoteUrl);
      const git = (_repository, args, options) => run(args, { ...options, objects: checked, credential });
      const result = await pushExactCommitFromBare({ ...request, checkout: repository }, { git, mutateGit: git });
      if (typeof onPushed === 'function') {
        await onPushed({ commit: request.commit, branch: request.branch, pack: `${prefix}-${packId}.pack` }).catch(() => {});
      }
      return result;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
}
