// The owner's renderer slot: one renderer per vault. With no `renderer` in the
// config the bundled `renderers/quartz-cyberbase` is used exactly as before.
// With one, the owner names a renderer directory that follows the renderer
// contract (`<directory>/build <contentDir> <outDir>`, see RENDERER.md in the
// renderer) on the same pinned Quartz commit. The directory is checked before
// every fingerprint and every build: one real directory, no symlink aliases,
// owned by this user and not writable by anyone else. Builds run with no
// network (a fresh network namespace) and one at a time per directory.
import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fail } from './errors.js';
import { validatePrivateNetworkHttpOrigin } from './network.js';
import {
  PINNED_QUARTZ_COMMIT,
  PINNED_QUARTZ_REF,
  PINNED_QUARTZ_REPOSITORY,
  PROVENANCE_REPORT_FILE,
  readProvenanceReport,
} from './quartz-renderer.js';

const execFileAsync = promisify(execFile);

export const BUNDLED_RENDERER_NAME = 'quartz-cyberbase';
export const RENDERER_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
export const RENDERER_BUILD_FILE = 'build';
export const MAX_RENDERER_FINGERPRINT_ENTRIES = 64;
// The network namespace tool, at a fixed path: never looked up on PATH.
export const OFFLINE_LAUNCHER = '/usr/bin/unshare';
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * The renderer identity the owner site manifest must record, from validated
 * config. `directory` is present only for a configured renderer, so manifests
 * of the bundled renderer are unchanged.
 */
export function rendererIdentity(config) {
  const configured = config?.renderer;
  if (configured === undefined || configured === null) {
    return Object.freeze({ name: BUNDLED_RENDERER_NAME, revision: PINNED_QUARTZ_COMMIT, tag: PINNED_QUARTZ_REF,
      repository: PINNED_QUARTZ_REPOSITORY, directory: undefined });
  }
  return Object.freeze({ name: configured.name, revision: configured.quartzCommit, tag: PINNED_QUARTZ_REF,
    repository: PINNED_QUARTZ_REPOSITORY, directory: configured.directory });
}

function ownedByThisUser(metadata) {
  return typeof process.getuid !== 'function' || metadata.uid === process.getuid();
}

/**
 * One real renderer directory and its build entry, or a refusal. Returns the
 * directory. Never follows a symlink.
 */
export async function assertRendererDirectory(renderer) {
  const directory = renderer?.directory;
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.normalize(directory) !== directory
    || directory === path.parse(directory).root || directory.endsWith('/')) {
    fail('renderer-directory-invalid', 'the renderer directory must be one normalized absolute path');
  }
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    fail('renderer-directory-unavailable', 'the renderer directory could not be inspected', { cause: error?.code ?? 'unknown' });
  }
  if (metadata.isSymbolicLink()) fail('renderer-symlink-rejected', 'the renderer directory must not be a symlink');
  if (!metadata.isDirectory()) fail('renderer-directory-invalid', 'the renderer directory must be a directory');
  if (await realpath(directory) !== directory) {
    fail('renderer-symlink-rejected', 'the renderer directory must be its own real path, with no symlink on the way');
  }
  if (!ownedByThisUser(metadata)) fail('renderer-owner-mismatch', 'the renderer directory must be owned by this user');
  if ((metadata.mode & 0o022) !== 0) fail('renderer-permissions-too-open', 'the renderer directory must not be writable by group or others');
  const build = path.join(directory, RENDERER_BUILD_FILE);
  let entry;
  try {
    entry = await lstat(build);
  } catch (error) {
    fail('renderer-build-missing', 'the renderer has no build entry', { cause: error?.code ?? 'unknown' });
  }
  if (entry.isSymbolicLink()) fail('renderer-symlink-rejected', 'the renderer build entry must not be a symlink');
  if (!entry.isFile() || entry.nlink !== 1) fail('renderer-build-missing', 'the renderer build entry must be one regular file');
  if (!ownedByThisUser(entry)) fail('renderer-owner-mismatch', 'the renderer build entry must be owned by this user');
  if ((entry.mode & 0o022) !== 0) fail('renderer-permissions-too-open', 'the renderer build entry must not be writable by group or others');
  if ((entry.mode & 0o100) === 0) fail('renderer-build-missing', 'the renderer build entry must be executable');
  return directory;
}

// One build at a time per renderer directory: the contract lets a build write
// in its own directory (cache, patch state).
const queues = new Map();
async function exclusive(key, task) {
  const previous = queues.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const chained = previous.then(() => current);
  queues.set(key, chained);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (queues.get(key) === chained) queues.delete(key);
  }
}

function absolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) {
    fail('invalid-render-path', `${name} must be one normalized absolute path`);
  }
  return value;
}

function buildEnvironment(overrides) {
  const allowed = {};
  for (const name of ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (typeof process.env[name] === 'string') allowed[name] = process.env[name];
  }
  // No proxies, no CI marker, no credentials: only what the contract names.
  return { ...allowed, npm_config_offline: 'true', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', ...overrides };
}

/**
 * The render function for a configured renderer, with the same call shape as
 * renderPinnedQuartz. The owner-private build always carries source
 * provenance (the review places changes with it) and owner edit links.
 * `launcher` is injectable for tests only; it must still run the build with
 * no network.
 */
export function createConfiguredRenderer(renderer, { launcher = OFFLINE_LAUNCHER } = {}) {
  if (renderer === undefined || renderer === null) fail('renderer-not-configured', 'no renderer is configured');
  const identity = rendererIdentity({ renderer });
  return async function renderConfigured({ contentDir, outputDir, workspaceDir, ownerOrigin, suggestions = null }) {
    const content = absolute(contentDir, 'contentDir');
    const output = absolute(outputDir, 'outputDir');
    const workspace = absolute(workspaceDir, 'workspaceDir');
    validatePrivateNetworkHttpOrigin(ownerOrigin, 'ownerOrigin');
    if (suggestions !== null) {
      fail('renderer-form-unsupported', 'the suggestion form needs the bundled renderer');
    }
    return exclusive(identity.directory, async () => {
      const directory = await assertRendererDirectory(renderer);
      for (const target of [content, output, workspace]) {
        const relative = path.relative(directory, target);
        if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
          fail('renderer-path-overlap', 'build paths must be outside the renderer directory');
        }
      }
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      const report = path.join(workspace, PROVENANCE_REPORT_FILE);
      await rm(report, { force: true });
      const reportEnvironment = { CYBERBASER_PROVENANCE_REPORT: report };
      const build = path.join(directory, RENDERER_BUILD_FILE);
      const args = ['--user', '--map-root-user', '--net', '--', build, content, output];
      let result;
      try {
        result = await execFileAsync(launcher, args, {
          cwd: workspace,
          encoding: 'utf8',
          maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
          env: buildEnvironment({
            CYBERBASER_SOURCE_PROVENANCE: 'enabled',
            CYBERBASER_EDIT_LINK_MODE: 'owner',
            CYBERBASER_OWNER_ORIGIN: ownerOrigin,
            ...reportEnvironment,
          }),
        });
      } catch (error) {
        fail('renderer-build-failed', `${identity.name} build failed`, {
          exitCode: Number.isSafeInteger(error?.code) ? error.code : null,
          stdout: String(error?.stdout ?? '').slice(-4_000),
          stderr: String(error?.stderr ?? '').slice(-4_000),
        });
      }
      return {
        renderer: identity.name,
        revision: identity.revision,
        tag: identity.tag,
        outputDir: output,
        suggestionForm: false,
        provenanceSkipped: await readProvenanceReport(reportEnvironment),
        commands: { build: [launcher, ...args] },
        logs: {
          buildStdoutTail: String(result.stdout ?? '').slice(-4_000),
          buildStderrTail: String(result.stderr ?? '').slice(-4_000),
        },
      };
    });
  };
}
