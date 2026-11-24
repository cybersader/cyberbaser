// The publisher's mirror: a bare Git repository that holds a plain copy of the
// one bound repository, written only by the publisher and readable by the node.
//
// The publisher alone holds the forge credential, so it alone fetches. The
// node copies its working checkout from this mirror and later fetches updates
// from it, with no credential anywhere on its side: the mirror's config names
// no remote, no URL and no helper, and the credential reaches only the one Git
// transport child that fetches or pushes, through its environment.
//
// The mirror also lets the node start offline: it reads the last known remote
// branch here instead of asking the forge.
//
// During first-run setup the publisher may push exactly one kind of change: a
// commit that adds a starter publish.yml (byte for byte what setup writes for
// the folders the owner picked) on top of the current remote head, when the
// repository has none. Anything else is refused.
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OwnerAlphaError, fail } from '../errors.js';
import { STARTER_COMMIT_MESSAGE, STARTER_PATH, parseStarterPublishYml } from '../starter-publish.js';
import { validFullName } from './forge-access.js';
import { makeRunner, snapshotObjects } from './repository.js';

const OID = /^[0-9a-f]{40}$/u;
const BRANCH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const ALLOWED_CONFIG = new Set(['core.repositoryformatversion', 'core.filemode', 'core.bare', 'cyberbaser.repository']);
const MIRROR_KEY = 'cyberbaser.repository';

function unsafeMirror() {
  fail('publisher-unsafe-mirror', 'the publisher mirror must be its own plain bare repository');
}

export function starterRefused() {
  return new OwnerAlphaError('starter-refused', 'that change is not exactly a starter publish.yml on the current head');
}

function serial() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}

function validBranch(value) {
  return typeof value === 'string' && BRANCH.test(value) && !value.includes('..') && !value.endsWith('.lock')
    && !value.split('/').some((part) => part.startsWith('.'));
}

/**
 * createMirror({ directory, uid, forgeAccess })
 *   refresh()                    -> { repository, branch, head }   fetch the bound repository
 *   head()                       -> { repository, branch, head } | null   no network
 *   adoptPack({ commit, branch, pack })   after a confirmed push
 *   publishStarter({ checkout, commit })  -> { repository, branch, commit }
 */
export async function createMirror({ directory, uid = process.getuid(), forgeAccess, environment = process.env, scratchRoot = os.tmpdir() }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.normalize(directory) !== directory
    || path.dirname(directory) === '/' || process.platform !== 'linux') unsafeMirror();
  const run = makeRunner(directory, environment);
  const exclusive = serial();

  async function prepare() {
    const parent = await lstat(path.dirname(directory)).catch(() => null);
    if (parent === null || !parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o022) !== 0) unsafeMirror();
    let entry = await lstat(directory).catch(() => null);
    if (entry === null) {
      await mkdir(directory, { mode: 0o750 });
      entry = await lstat(directory);
    }
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== uid) unsafeMirror();
    // Readable by the node through the share group; never writable by it.
    await chmod(directory, 0o750);
    if ((await readdir(directory)).length === 0) {
      await run(['-c', 'init.defaultBranch=main', 'init', '--quiet', '--bare', '--template=', '--object-format=sha1']);
      await run(['config', 'gc.auto', '0']).catch(() => {});
    }
    for (const name of await readdir(directory)) {
      if (!['config', 'HEAD', 'objects', 'refs', 'packed-refs'].includes(name)) unsafeMirror();
    }
    const listed = await run(['config', '--file', path.join(directory, 'config'), '--list', '--name-only'], { encoding: 'utf8' });
    for (const key of listed.split('\n').filter(Boolean)) if (!ALLOWED_CONFIG.has(key) && key !== 'gc.auto') unsafeMirror();
  }

  async function holding() {
    return run(['config', '--file', path.join(directory, 'config'), '--get', MIRROR_KEY], { encoding: 'utf8' }).catch(() => '');
  }

  // A different repository than the one held: start the mirror over.
  async function reset() {
    await rm(directory, { recursive: true, force: true });
    await prepare();
  }

  async function currentBranch() {
    const ref = await run(['symbolic-ref', '--quiet', 'HEAD'], { encoding: 'utf8' }).catch(() => '');
    return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
  }

  async function branchHead(branch) {
    const value = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], { encoding: 'utf8' }).catch(() => '');
    return OID.test(value) ? value : null;
  }

  async function credential() {
    const bound = await forgeAccess.boundCredential();
    if (!validFullName(bound?.repository) || bound.remoteUrl !== `https://github.com/${bound.repository}.git`) unsafeMirror();
    return bound;
  }

  async function fetchBound() {
    await prepare();
    const bound = await credential();
    try {
      if (await holding() !== bound.repository) {
        await reset();
        await run(['config', MIRROR_KEY, bound.repository]);
      }
      const listed = await run(['ls-remote', '--symref', '--', bound.remoteUrl, 'HEAD'], { encoding: 'utf8', credential: bound });
      const match = /^ref: refs\/heads\/(\S+)\tHEAD$/mu.exec(listed);
      const branch = match && validBranch(match[1]) ? match[1] : null;
      await run(['fetch', '--quiet', '--no-tags', '--prune', '--no-write-fetch-head', '--', bound.remoteUrl,
        '+refs/heads/*:refs/heads/*'], { credential: bound });
      if (branch !== null && await branchHead(branch) !== null) await run(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
      const chosen = await currentBranch();
      const head = chosen === null ? null : await branchHead(chosen);
      return { repository: bound.repository, remoteUrl: bound.remoteUrl, branch: chosen, head };
    } catch (error) {
      if (error instanceof OwnerAlphaError) throw error;
      throw new OwnerAlphaError('github-unreachable', 'the repository could not be fetched');
    } finally {
      bound.password = null;
    }
  }

  async function adopt({ commit, branch, pack }) {
    if (!OID.test(commit) || !validBranch(branch) || typeof pack !== 'string' || !pack.endsWith('.pack')) return;
    await prepare();
    const target = path.join(directory, 'objects', 'pack');
    await mkdir(target, { recursive: true, mode: 0o750 });
    const name = `pack-adopt-${randomBytes(8).toString('hex')}`;
    // The index first: Git only looks at a pack once its index exists.
    await copyFile(pack, path.join(target, `${name}.pack`), constants.COPYFILE_EXCL);
    await copyFile(`${pack.slice(0, -'.pack'.length)}.idx`, path.join(target, `${name}.idx`), constants.COPYFILE_EXCL);
    await run(['cat-file', '-e', `${commit}^{commit}`]);
    await run(['update-ref', `refs/heads/${branch}`, commit]);
    if (await currentBranch() === null) await run(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  }

  // authorize({ remote, branch }) (signed publish): admits the owner's signed
  // approval for this target and returns { verifyCommit(git, commit) }. When
  // given, the starter commit must also be exactly what the device approved.
  async function publishStarter({ checkout, commit, authorize = null }) {
    if (typeof checkout !== 'string' || !path.isAbsolute(checkout) || !OID.test(commit ?? '')) throw starterRefused();
    const fetched = await fetchBound();
    if (fetched.branch === null || fetched.head === null) throw starterRefused();
    const authorization = authorize === null ? null : await authorize({ remote: fetched.remoteUrl, branch: fetched.branch });
    const scratch = await mkdtemp(path.join(scratchRoot, 'cyberbaser-starter-'));
    try {
      const source = path.join(scratch, 'source');
      const checked = path.join(scratch, 'checked');
      const packDir = path.join(checked, 'pack');
      await mkdir(source, { mode: 0o700 });
      await mkdir(packDir, { recursive: true, mode: 0o700 });
      let packs;
      try { packs = await snapshotObjects(checkout, source); } catch { throw starterRefused(); }
      for (const pack of packs) await run(['index-pack', '--fsck-objects', pack], { objects: source });
      const prefix = path.join(packDir, 'pack');
      const packId = await run(['pack-objects', '--quiet', '--revs', '--window=0', '--no-reuse-delta', '--no-reuse-object', prefix],
        { objects: source, input: `${commit}\n`, encoding: 'utf8' }).catch(() => '');
      if (!OID.test(packId)) throw starterRefused();
      await run(['index-pack', '--strict', `${prefix}-${packId}.pack`], { objects: checked });
      const inChecked = (args, options = {}) => run(args, { encoding: 'utf8', ...options, objects: checked });
      // One commit, one parent (the current remote head), the exact message.
      const raw = await inChecked(['cat-file', 'commit', commit]);
      const [header, ...body] = raw.split('\n\n');
      const parents = header.split('\n').filter((line) => line.startsWith('parent '));
      if (parents.length !== 1 || parents[0] !== `parent ${fetched.head}` || body.join('\n\n').trim() !== STARTER_COMMIT_MESSAGE) throw starterRefused();
      // Exactly one added file, publish.yml at the root, where there was none.
      const diff = await inChecked(['diff-tree', '-r', '-z', '--no-renames', '--no-commit-id', fetched.head, commit]);
      const fields = diff.split('\0').filter((part) => part !== '');
      const entry = /^:000000 100644 0{40} ([0-9a-f]{40}) A$/u.exec(fields[0] ?? '');
      if (fields.length !== 2 || entry === null || fields[1] !== STARTER_PATH) throw starterRefused();
      const bytes = await run(['cat-file', 'blob', entry[1]], { objects: checked, encoding: 'buffer' });
      if (parseStarterPublishYml(bytes) === null) throw starterRefused();
      if (authorization !== null) await authorization.verifyCommit((args) => run(args, { objects: checked }), commit);
      const bound = await credential();
      try {
        // Not forced: if the remote moved since the fetch, GitHub refuses it.
        await run(['push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', '--no-verify', '--', bound.remoteUrl,
          `${commit}:refs/heads/${fetched.branch}`], { objects: checked, credential: bound, encoding: 'utf8' });
      } catch {
        throw new OwnerAlphaError('github-unreachable', 'the starter publish.yml was not pushed');
      } finally {
        bound.password = null;
      }
      await adopt({ commit, branch: fetched.branch, pack: `${prefix}-${packId}.pack` });
      const receipt = authorization?.receipt({ status: 'pushed', commit, remoteRef: commit }) ?? null;
      return { repository: fetched.repository, branch: fetched.branch, commit, ...(receipt === null ? {} : { receipt }) };
    } catch (error) {
      if (error instanceof OwnerAlphaError) throw error;
      throw starterRefused();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  await prepare();
  return Object.freeze({
    directory,
    refresh: () => exclusive(fetchBound),
    head: () => exclusive(async () => {
      await prepare();
      const repository = await holding();
      const branch = await currentBranch();
      const head = branch === null ? null : await branchHead(branch);
      return repository && head ? { repository, branch, head } : null;
    }),
    adoptPack: (input) => exclusive(() => adopt(input)),
    publishStarter: (input) => exclusive(() => publishStarter(input)),
  });
}
