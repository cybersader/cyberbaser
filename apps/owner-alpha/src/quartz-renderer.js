import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fail } from './errors.js';
import { validatePrivateNetworkHttpOrigin } from './network.js';
import { containerRendererIsolation, rendererLauncher, withIsolatedRenderer } from './renderer-isolation.js';
import { readSiteFile } from './site-files.js';

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

export async function offlineSeedEnvironment(seed = PINNED_QUARTZ_SEED_DIR) {
  try {
    const metadata = await lstat(seed);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      fail('quartz-seed-invalid', 'fixed Quartz seed must be one real directory');
    }
    if (await realpath(seed) !== seed) {
      fail('quartz-seed-invalid', 'fixed Quartz seed must not use symlink aliases');
    }
    return {
      QUARTZ_OFFLINE: '1',
      QUARTZ_SEED_DIR: seed,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      if (PINNED_QUARTZ_RENDERER_DIR.startsWith('/opt/cyberbaser/renderers/')
        || containerRendererIsolation() || typeof process.env.OWNER_ALPHA_STATE_PROFILE === 'string') {
        fail('quartz-seed-missing', 'installed rendering requires the fixed verified offline Quartz seed');
      }
      return { QUARTZ_OFFLINE: '0' };
    }
    throw error;
  }
}

async function runFixed(args, options, code, isolation = null) {
  try {
    const execOptions = { encoding: 'utf8', maxBuffer: MAX_COMMAND_OUTPUT_BYTES, ...options };
    const result = isolation
      ? await withIsolatedRenderer({ ...isolation, env: options.env }, (policy, env) =>
        execFileAsync(isolation.launcher, [...policy, '/usr/bin/bash', ...args], { ...execOptions, env }))
      // Source-checkout dependency bootstrap only (no vault or output input).
      : await execFileAsync('/usr/bin/bash', args, { ...execOptions, timeout: 600_000 });
    return {
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
    };
  } catch (error) {
    fail(code, `${path.basename(args[0])} failed`, {
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
const DIGEST_RE = /^sha-256=:[A-Za-z0-9+/]{43}=:$/u;
const COMMIT_RE = /^[0-9a-f]{40}$/u;

// Public suggestion-form build inputs only. Secret paths and server verification
// policy stay outside this description; the renderer validates its own registry.
export function suggestionEnvironment(suggestions) {
  if (suggestions === null || suggestions === undefined) return {};
  if (typeof suggestions !== 'object' || Array.isArray(suggestions)) {
    fail('invalid-render-suggestions', 'suggestions must be null or one binding description');
  }
  validatePrivateNetworkHttpOrigin(suggestions.intakeOrigin, 'suggestions.intakeOrigin');
  if (typeof suggestions.bindingDigest !== 'string' || !DIGEST_RE.test(suggestions.bindingDigest)) {
    fail('invalid-render-suggestions', 'suggestions.bindingDigest must be one RFC 9530 SHA-256 digest');
  }
  if (typeof suggestions.sourceRepository !== 'string' || !suggestions.sourceRepository.startsWith('https://')) {
    fail('invalid-render-suggestions', 'suggestions.sourceRepository must be one HTTPS repository URL');
  }
  if (typeof suggestions.sourceRevision !== 'string' || !COMMIT_RE.test(suggestions.sourceRevision)) {
    fail('invalid-render-suggestions', 'suggestions.sourceRevision must be one commit ID');
  }
  if (suggestions.editEntry !== undefined && !['auto', 'floating', 'inline'].includes(suggestions.editEntry)) fail('invalid-render-suggestions', 'suggestions.editEntry must be auto, floating, or inline');
  return {
    CYBERBASER_EDIT_ENTRY: suggestions.editEntry ?? 'auto',
    CYBERBASER_ACCOUNT_FREE_INTAKE: 'enabled',
    // Suggesting mode maps rendered text to exact source bytes; the renderer
    // emits that provenance only when asked (off = byte-identical output).
    CYBERBASER_SOURCE_PROVENANCE: 'enabled',
    CYBERBASER_ACCOUNT_FREE_INTAKE_ORIGIN: suggestions.intakeOrigin,
    CYBERBASER_ACCOUNT_FREE_BINDING_DIGEST: suggestions.bindingDigest,
    CYBERBASER_ACCOUNT_FREE_SOURCE_REPOSITORY: suggestions.sourceRepository,
    CYBERBASER_ACCOUNT_FREE_SOURCE_REVISION: suggestions.sourceRevision,
    ...(suggestions.challenge ? {
      CYBERBASER_SUGGESTION_CHALLENGE_PROVIDER: suggestions.challenge.provider,
      CYBERBASER_SUGGESTION_CHALLENGE_SITE_KEY: suggestions.challenge.siteKey,
    } : {}),
  };
}

// Notes the private build emitted without source provenance. The renderer
// writes this report (paths only) beside, never inside, the published output.
export const PROVENANCE_REPORT_FILE = 'provenance-skipped.json';

export async function provenanceReportEnvironment(workspaceDir, formEnvironment) {
  if (!formEnvironment.CYBERBASER_SOURCE_PROVENANCE) return {};
  const file = path.join(workspaceDir, PROVENANCE_REPORT_FILE);
  await rm(file, { force: true });
  return { CYBERBASER_PROVENANCE_REPORT: file };
}

export async function readProvenanceReport(environment) {
  const file = environment.CYBERBASER_PROVENANCE_REPORT;
  if (!file) return null;
  try {
    const report = JSON.parse((await readSiteFile(path.dirname(file), [path.basename(file)], 1024 * 1024)).toString('utf8'));
    const notes = Array.isArray(report?.notes) ? report.notes.map(({ path: notePath, step }) => ({ path: notePath, step })) : [];
    return { count: notes.length, notes, file };
  } catch (error) {
    if (error?.code === 'ENOENT') return { count: 0, notes: [], file };
    throw error;
  }
}

export async function renderPinnedQuartz({ contentDir, outputDir, workspaceDir, ownerOrigin, suggestions = null, siteConfigPath = null, sourceCheckout = null }) {
  // The vault's own site settings (.cyberbaser/site.yml), when it has one.
  if (sourceCheckout !== null && (typeof sourceCheckout !== 'string' || !path.isAbsolute(sourceCheckout) || path.normalize(sourceCheckout) !== sourceCheckout)) {
    fail('invalid-render-path', 'sourceCheckout must be null or one normalized absolute path');
  }
  if (siteConfigPath !== null && (typeof siteConfigPath !== 'string' || !path.isAbsolute(siteConfigPath) || path.normalize(siteConfigPath) !== siteConfigPath)) {
    fail('invalid-render-path', 'siteConfigPath must be null or one normalized absolute path');
  }
  const content = absoluteDirectory(contentDir, 'contentDir');
  const output = absoluteDirectory(outputDir, 'outputDir');
  const workspace = absoluteDirectory(workspaceDir, 'workspaceDir');
  validatePrivateNetworkHttpOrigin(ownerOrigin, 'ownerOrigin');
  const formEnvironment = suggestionEnvironment(suggestions);
  const launcher = await rendererLauncher();
  const seedEnvironment = await offlineSeedEnvironment();
  await mkdir(workspace, { recursive: true });
  // The invocation parent and bootstrap seed are never writable by the
  // renderer. In particular no trusted Git/npm command ever runs in a tree
  // that a previous renderer could have populated.
  const invocation = await mkdtemp(path.join(workspace, 'quartz-build-'));
  try {
    const buildWorkspace = path.join(invocation, 'build');
    const quartzDir = path.join(buildWorkspace, 'quartz');
    const setupEnvironment = commandEnvironment({
      QUARTZ_REPO: PINNED_QUARTZ_REPOSITORY,
      QUARTZ_REF: PINNED_QUARTZ_REF,
      QUARTZ_COMMIT: PINNED_QUARTZ_COMMIT,
      QUARTZ_LOCK_SHA256: PINNED_QUARTZ_LOCK_SHA256,
      QUARTZ_INSTALL_SHA256: PINNED_QUARTZ_INSTALL_SHA256,
      ...seedEnvironment,
    });
    if (setupEnvironment.QUARTZ_OFFLINE === '0') {
      const seed = path.join(invocation, 'seed');
      await runFixed([SETUP_SCRIPT, seed], {
        cwd: invocation, env: { ...setupEnvironment, QUARTZ_BOOTSTRAP_ONLY: '1' },
      }, 'quartz-setup-failed');
      setupEnvironment.QUARTZ_SEED_DIR = seed;
      setupEnvironment.QUARTZ_OFFLINE = '1';
    }
    await mkdir(buildWorkspace, { mode: 0o700 });
    const reportEnvironment = await provenanceReportEnvironment(buildWorkspace, formEnvironment);
    const setup = await runFixed([SETUP_SCRIPT, quartzDir], {
      cwd: buildWorkspace,
      env: { ...setupEnvironment,
        CYBERBASER_SOURCE_PROVENANCE: formEnvironment.CYBERBASER_SOURCE_PROVENANCE ?? 'disabled',
      },
    }, 'quartz-setup-failed', { launcher, workspace: buildWorkspace, output });
    const build = await runFixed(
      [BUILD_SCRIPT, content, quartzDir],
      {
        cwd: buildWorkspace,
        env: commandEnvironment({
          COPY_CONTENT: '1',
          OUTPUT_DIR: output,
          CYBERBASER_EDIT_LINK_MODE: 'owner',
          CYBERBASER_OWNER_ORIGIN: ownerOrigin,
          ...(siteConfigPath ? { CYBERBASER_SITE_CONFIG: siteConfigPath } : {}),
          // Read-only: dates for notes without frontmatter dates come from its git history.
          ...(sourceCheckout ? { CYBERBASER_SOURCE_CHECKOUT: sourceCheckout } : {}),
          ...formEnvironment,
          ...reportEnvironment,
        }),
      },
      'quartz-build-failed', { launcher, workspace: buildWorkspace, output },
    );
    const provenanceSkipped = await readProvenanceReport(reportEnvironment);

    return {
      renderer: 'quartz-cyberbase',
      revision: PINNED_QUARTZ_COMMIT,
      tag: PINNED_QUARTZ_REF,
      outputDir: output,
      suggestionForm: formEnvironment.CYBERBASER_ACCOUNT_FREE_INTAKE === 'enabled',
      provenanceSkipped,
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
  } finally {
    await rm(invocation, { recursive: true, force: true });
  }
}
