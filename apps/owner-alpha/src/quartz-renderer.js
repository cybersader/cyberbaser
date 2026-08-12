import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fail } from './errors.js';
import { validatePrivateNetworkHttpOrigin } from './network.js';

const execFileAsync = promisify(execFile);

export const PINNED_QUARTZ_REF = 'v4.5.2';
export const PINNED_QUARTZ_COMMIT = '4923affa7722dfc751f1074348e6dad214fe0c08';
export const PINNED_QUARTZ_REPOSITORY = 'https://github.com/jackyzha0/quartz.git';
export const PINNED_QUARTZ_LOCK_SHA256 = '9ea5873a2bb495054f23b16f96d1d41f44348863e655f4c6d86b107f372b09b9';
export const PINNED_QUARTZ_INSTALL_SHA256 = '38bc51071b55a4444abdea3e0620747882e2be3a8610da5715a9c0b40b320850';
export const PINNED_QUARTZ_SEED_DIR = '/opt/cyberbaser/vendor/quartz';
export const PINNED_QUARTZ_RENDERER_DIR = fileURLToPath(
  new URL('../../../renderers/quartz-cyberbase/', import.meta.url),
);

const SETUP_SCRIPT = path.join(PINNED_QUARTZ_RENDERER_DIR, 'setup.sh');
const BUILD_SCRIPT = path.join(PINNED_QUARTZ_RENDERER_DIR, 'build.sh');
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024;

function absoluteDirectory(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) {
    fail('invalid-render-path', `${name} must be one normalized absolute path`);
  }
  return value;
}

function commandEnvironment(overrides = {}) {
  const allowed = {};
  for (const name of ['HOME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME', 'LANG', 'LC_ALL']) {
    if (typeof process.env[name] === 'string') allowed[name] = process.env[name];
  }
  return {
    ...allowed,
    GIT_TERMINAL_PROMPT: '0',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_FUND: 'false',
    ...overrides,
  };
}

async function offlineSeedEnvironment() {
  try {
    const metadata = await lstat(PINNED_QUARTZ_SEED_DIR);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      fail('quartz-seed-invalid', 'fixed Quartz seed must be one real directory');
    }
    if (await realpath(PINNED_QUARTZ_SEED_DIR) !== PINNED_QUARTZ_SEED_DIR) {
      fail('quartz-seed-invalid', 'fixed Quartz seed must not use symlink aliases');
    }
    return {
      QUARTZ_OFFLINE: '1',
      QUARTZ_SEED_DIR: PINNED_QUARTZ_SEED_DIR,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      if (typeof process.env.OWNER_ALPHA_STATE_PROFILE === 'string') {
        fail('quartz-seed-missing', 'container rendering requires the fixed verified offline Quartz seed');
      }
      return { QUARTZ_OFFLINE: '0' };
    }
    throw error;
  }
}

async function runFixed(command, args, options, code) {
  try {
    const result = await execFileAsync(command, args, {
      encoding: 'utf8',
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      ...options,
    });
    return {
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
    };
  } catch (error) {
    fail(code, `${path.basename(args[0] ?? command)} failed`, {
      exitCode: Number.isSafeInteger(error?.code) ? error.code : null,
      stdout: String(error?.stdout ?? '').slice(-4_000),
      stderr: String(error?.stderr ?? '').slice(-4_000),
    });
  }
}

/**
 * Render one already-projected lane through Cyberbaser's fixed Quartz wrapper.
 * The executable and script paths are constants; callers supply directories only.
 */
export async function renderPinnedQuartz({ contentDir, outputDir, workspaceDir, ownerOrigin }) {
  const content = absoluteDirectory(contentDir, 'contentDir');
  const output = absoluteDirectory(outputDir, 'outputDir');
  const workspace = absoluteDirectory(workspaceDir, 'workspaceDir');
  validatePrivateNetworkHttpOrigin(ownerOrigin, 'ownerOrigin');
  const quartzDir = path.join(workspace, 'quartz');
  const seedEnvironment = await offlineSeedEnvironment();

  await mkdir(workspace, { recursive: true });
  const setup = await runFixed(
    'bash',
    [SETUP_SCRIPT, quartzDir],
    {
      env: commandEnvironment({
        QUARTZ_REPO: PINNED_QUARTZ_REPOSITORY,
        QUARTZ_REF: PINNED_QUARTZ_REF,
        QUARTZ_COMMIT: PINNED_QUARTZ_COMMIT,
        QUARTZ_LOCK_SHA256: PINNED_QUARTZ_LOCK_SHA256,
        QUARTZ_INSTALL_SHA256: PINNED_QUARTZ_INSTALL_SHA256,
        ...seedEnvironment,
      }),
    },
    'quartz-setup-failed',
  );
  const build = await runFixed(
    'bash',
    [BUILD_SCRIPT, content, quartzDir],
    {
      env: commandEnvironment({
        COPY_CONTENT: '1',
        OUTPUT_DIR: output,
        CYBERBASER_EDIT_LINK_MODE: 'owner',
        CYBERBASER_OWNER_ORIGIN: ownerOrigin,
      }),
    },
    'quartz-build-failed',
  );

  return {
    renderer: 'quartz-cyberbase',
    revision: PINNED_QUARTZ_COMMIT,
    tag: PINNED_QUARTZ_REF,
    outputDir: output,
    commands: {
      setup: ['bash', SETUP_SCRIPT, quartzDir],
      build: ['bash', BUILD_SCRIPT, content, quartzDir],
    },
    logs: {
      setupStdoutTail: setup.stdout.slice(-4_000),
      setupStderrTail: setup.stderr.slice(-4_000),
      buildStdoutTail: build.stdout.slice(-4_000),
      buildStderrTail: build.stderr.slice(-4_000),
    },
  };
}
