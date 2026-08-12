import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  OwnerAlphaError,
  assertIgnoredPath,
  createJsonArtifactOnce,
  defineStoreContext,
  prepareStore,
  readJsonArtifact,
  replaceJsonArtifactAtomic,
  resolveStorePath,
} from '../src/index.js';

const cleanup = [];

async function run(args, cwd) {
  const child = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${args.join(' ')} failed: ${stderr || stdout}`);
  return stdout.trim();
}

async function fixture({ ignored = true } = {}) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'owner-alpha-store-'));
  cleanup.push(projectRoot);
  await run(['git', 'init', '-q'], projectRoot);
  await writeFile(path.join(projectRoot, '.gitignore'), ignored ? '.private/\n' : '', 'utf8');
  const workspaceRoot = path.join(projectRoot, '.private', 'owner-alpha');
  const storeRoot = path.join(workspaceRoot, 'store');
  return {
    projectRoot,
    workspaceRoot,
    storeRoot,
    context: defineStoreContext({ projectRoot, workspaceRoot, storeRoot }),
  };
}

function expectCode(action, code) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerAlphaError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected OwnerAlphaError(${code})`);
}

async function expectCodeAsync(action, code) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerAlphaError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected OwnerAlphaError(${code})`);
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('ignored contained store', () => {
  test('creates only an ignored workspace and strictly contained store', async () => {
    const fixtureData = await fixture();
    const { context, workspaceRoot, storeRoot } = fixtureData;
    expect(await prepareStore(context)).toBe(context);
    expect((await lstat(workspaceRoot)).isDirectory()).toBe(true);
    expect((await lstat(storeRoot)).isDirectory()).toBe(true);
    expect(await assertIgnoredPath(context, workspaceRoot)).toBe(workspaceRoot);
    expect(await assertIgnoredPath(context, storeRoot)).toBe(storeRoot);
  });

  test('rejects workspace/store escape and traversal before filesystem access', async () => {
    const data = await fixture();
    expectCode(
      () => defineStoreContext({
        projectRoot: data.projectRoot,
        workspaceRoot: path.join(data.projectRoot, '..', 'outside'),
        storeRoot: path.join(data.projectRoot, '..', 'outside', 'store'),
      }),
      'workspace-outside-project',
    );
    expectCode(
      () => defineStoreContext({
        projectRoot: data.projectRoot,
        workspaceRoot: data.workspaceRoot,
        storeRoot: path.join(data.projectRoot, '.private', 'other'),
      }),
      'store-outside-workspace',
    );
    expectCode(() => resolveStorePath(data.context, '../escape.json'), 'invalid-store-path');
    expectCode(() => resolveStorePath(data.context, '/absolute.json'), 'invalid-store-path');
    expectCode(() => resolveStorePath(data.context, 'jobs\\escape.json'), 'invalid-store-path');
  });

  test('fails closed when the workspace is not ignored', async () => {
    const { context } = await fixture({ ignored: false });
    await expectCodeAsync(() => prepareStore(context), 'store-not-ignored');
  });

  test('rejects symlink components even when the lexical destination is contained', async () => {
    const data = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'owner-alpha-outside-'));
    cleanup.push(outside);
    await mkdir(path.dirname(data.workspaceRoot), { recursive: true });
    await symlink(outside, data.workspaceRoot);
    await expectCodeAsync(() => prepareStore(data.context), 'store-symlink-rejected');
  });
});

describe('create-once and atomic JSON artifacts', () => {
  test('creates a private immutable artifact once with no temporary residue', async () => {
    const { context, storeRoot } = await fixture();
    const relative = 'jobs/JOB-01/evidence.json';
    const file = await createJsonArtifactOnce(context, relative, { value: 1 });
    expect(file).toBe(path.join(storeRoot, 'jobs', 'JOB-01', 'evidence.json'));
    expect(await readJsonArtifact(context, relative)).toEqual({ value: 1 });
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect((await lstat(file)).nlink).toBe(1);
    expect((await readdir(path.dirname(file))).filter((name) => name.includes('.tmp-'))).toEqual([]);

    await expectCodeAsync(
      () => createJsonArtifactOnce(context, relative, { value: 2 }),
      'artifact-already-exists',
    );
    expect(await readJsonArtifact(context, relative)).toEqual({ value: 1 });
  });

  test('allows exactly one winner under concurrent create-once races', async () => {
    const { context } = await fixture();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) => (
        createJsonArtifactOnce(context, 'races/result.json', { winner: index })
      )),
    );
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(rejected).toHaveLength(19);
    expect(rejected.every((outcome) => outcome.reason.code === 'artifact-already-exists')).toBe(true);
    expect((await readJsonArtifact(context, 'races/result.json')).winner).toBeInteger();
  });

  test('atomically replaces an existing artifact and never creates a missing one', async () => {
    const { context } = await fixture();
    await createJsonArtifactOnce(context, 'jobs/JOB-02/state.json', { revision: 0 });
    await replaceJsonArtifactAtomic(context, 'jobs/JOB-02/state.json', { revision: 1 });
    expect(await readJsonArtifact(context, 'jobs/JOB-02/state.json')).toEqual({ revision: 1 });
    await expectCodeAsync(
      () => replaceJsonArtifactAtomic(context, 'jobs/JOB-03/state.json', { revision: 1 }),
      'artifact-not-found',
    );
  });

  test('rejects credentials and enforces write/read size limits', async () => {
    const { context } = await fixture();
    await expectCodeAsync(
      () => createJsonArtifactOnce(context, 'bad/credential.json', { apiToken: 'value' }),
      'credentials-forbidden',
    );
    await expectCodeAsync(
      () => createJsonArtifactOnce(context, 'bad/large.json', { value: 'x'.repeat(200) }, { maxBytes: 50 }),
      'artifact-too-large',
    );
    await createJsonArtifactOnce(context, 'good/large.json', { value: 'x'.repeat(200) }, { maxBytes: 1000 });
    await expectCodeAsync(
      () => readJsonArtifact(context, 'good/large.json', { maxBytes: 50 }),
      'artifact-too-large',
    );
  });

  test('rejects symlink and extra-hard-link artifacts', async () => {
    const { context, storeRoot } = await fixture();
    await prepareStore(context);
    const outside = path.join(path.dirname(storeRoot), 'outside.json');
    await writeFile(outside, '{"outside":true}\n', 'utf8');
    const linked = resolveStorePath(context, 'unsafe/symlink.json');
    await mkdir(path.dirname(linked), { recursive: true });
    await symlink(outside, linked);
    await expectCodeAsync(() => readJsonArtifact(context, 'unsafe/symlink.json'), 'store-symlink-rejected');
    await expectCodeAsync(
      () => replaceJsonArtifactAtomic(context, 'unsafe/symlink.json', { value: 1 }),
      'store-symlink-rejected',
    );

    await createJsonArtifactOnce(context, 'unsafe/hard.json', { value: 1 });
    const hard = resolveStorePath(context, 'unsafe/hard.json');
    const alias = resolveStorePath(context, 'unsafe/hard-alias.json');
    await Bun.write(alias, await readFile(hard));
    await chmod(alias, 0o600);
    // Recreate alias as a hard link through the platform command to exercise nlink defense.
    await rm(alias);
    await run(['ln', hard, alias], dataRoot(context));
    await expectCodeAsync(() => readJsonArtifact(context, 'unsafe/hard.json'), 'unsafe-artifact');
  });
});

function dataRoot(context) {
  return context.projectRoot;
}
