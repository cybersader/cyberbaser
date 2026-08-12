import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fail, OwnerAlphaError } from './errors.js';
import { deepFreeze } from './json.js';

const execFileAsync = promisify(execFile);

function contained(root, target, { strict = false, code = 'path-outside-root' } = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  const outside = relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
    || (strict && relative === '');
  if (outside) fail(code, `${resolvedTarget} must remain ${strict ? 'strictly ' : ''}inside ${resolvedRoot}`);
  return resolvedTarget;
}

function safeRelativePath(relativePath, location = 'store path') {
  if (typeof relativePath !== 'string'
    || relativePath.length === 0
    || relativePath.trim() !== relativePath
    || relativePath.includes('\\')
    || relativePath.includes('\0')
    || path.posix.isAbsolute(relativePath)) {
    fail('invalid-store-path', `${location} must be a non-empty relative POSIX path`);
  }
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('invalid-store-path', `${location} must not contain empty, dot, or parent segments`);
  }
  return relativePath;
}

export function defineStoreContext({ projectRoot, workspaceRoot, storeRoot }) {
  if (!path.isAbsolute(projectRoot)) fail('invalid-project-root', 'projectRoot must be absolute');
  const project = path.resolve(projectRoot);
  const workspace = contained(project, workspaceRoot, {
    strict: true,
    code: 'workspace-outside-project',
  });
  const store = contained(workspace, storeRoot, {
    strict: true,
    code: 'store-outside-workspace',
  });
  return deepFreeze({ projectRoot: project, workspaceRoot: workspace, storeRoot: store });
}

export function storeContextFromConfig(config, projectRoot) {
  return defineStoreContext({
    projectRoot,
    workspaceRoot: path.resolve(projectRoot, config.workspace.root),
    storeRoot: path.resolve(projectRoot, config.workspace.store),
  });
}

export function resolveStorePath(context, relativePath) {
  const safe = safeRelativePath(relativePath);
  return contained(context.storeRoot, path.join(context.storeRoot, ...safe.split('/')), {
    strict: true,
    code: 'store-path-outside-root',
  });
}

export async function assertNoSymlinkComponents(context, target) {
  const destination = contained(context.projectRoot, target, { code: 'path-outside-project' });
  const relative = path.relative(context.projectRoot, destination);
  let current = context.projectRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        fail('store-symlink-rejected', 'workspace and store paths must not contain symbolic links', {
          path: path.relative(context.projectRoot, current).split(path.sep).join('/'),
        });
      }
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      if (error instanceof OwnerAlphaError) throw error;
      throw error;
    }
  }
  return destination;
}

export async function assertIgnoredPath(context, target) {
  const absolute = contained(context.projectRoot, target, { code: 'path-outside-project' });
  try {
    await execFileAsync(
      'git',
      ['-C', context.projectRoot, 'check-ignore', '--no-index', '-q', '--', absolute],
      { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
    );
  } catch (error) {
    if (error?.code === 1) fail('store-not-ignored', 'owner-alpha workspace and store must be ignored by Git');
    fail('git-ignore-check-failed', 'git check-ignore could not verify owner-alpha storage', {
      cause: error?.code ?? 'unknown',
    });
  }
  return absolute;
}

export async function prepareStore(context) {
  await assertNoSymlinkComponents(context, context.workspaceRoot);
  await assertIgnoredPath(context, context.workspaceRoot);
  await mkdir(context.storeRoot, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(context, context.storeRoot);
  await assertIgnoredPath(context, context.storeRoot);

  const [projectReal, workspaceReal, storeReal] = await Promise.all([
    realpath(context.projectRoot),
    realpath(context.workspaceRoot),
    realpath(context.storeRoot),
  ]);
  contained(projectReal, workspaceReal, { strict: true, code: 'workspace-outside-project' });
  contained(workspaceReal, storeReal, { strict: true, code: 'store-outside-workspace' });
  return context;
}

export async function assertSafeStoreTarget(context, target) {
  const absolute = contained(context.storeRoot, target, {
    strict: true,
    code: 'store-path-outside-root',
  });
  await assertNoSymlinkComponents(context, absolute);
  await assertIgnoredPath(context, absolute);
  return absolute;
}

export async function prepareStoreParent(context, target) {
  const absolute = await assertSafeStoreTarget(context, target);
  const parent = path.dirname(absolute);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(context, parent);
  await assertIgnoredPath(context, parent);
  return absolute;
}
