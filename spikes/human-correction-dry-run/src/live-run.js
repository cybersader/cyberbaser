import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  access,
  cp,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { applyCorrection, prepareCorrection } from '@cyberbaser/correction';
import { checkSite } from '@cyberbaser/linkcheck';
import { project, verifyProjection } from '@cyberbaser/projection';
import { select } from '@cyberbaser/publish';
import { deepFreeze, publicSafeCase, validateCase } from './case.js';
import { evaluateCorrection } from './evaluate.js';

const execFileAsync = promisify(execFile);
const DEFAULT_RENDERER_DIR = fileURLToPath(
  new URL('../../../renderers/quartz-cyberbase/', import.meta.url),
);
const COPY_IGNORES = new Set(['.git', '.obsidian', '.trash', 'node_modules']);
const COMMIT_RE = /^[0-9a-f]{40}$/u;

export class LiveRunError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LiveRunError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new LiveRunError(code, message, details);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function assertNoSymlinks(root) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (COPY_IGNORES.has(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        fail('checkout-symlink-rejected', 'the supplied checkout contains a symbolic link', {
          path: path.relative(root, target).split(path.sep).join('/'),
        });
      }
      if (entry.isDirectory()) pending.push(target);
    }
  }
}

function normalizeRepositoryIdentity(value) {
  let text = String(value ?? '').trim();
  const scp = text.match(/^git@([^:]+):(.+)$/u);
  if (scp) text = `https://${scp[1]}/${scp[2]}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    return text.replace(/\.git$/u, '').replace(/\/+$/u, '').toLowerCase();
  }
  return `${url.hostname.toLowerCase()}${url.pathname}`
    .replace(/\.git$/u, '')
    .replace(/\/+$/u, '')
    .toLowerCase();
}

async function git(checkoutDir, args) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', checkoutDir, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    fail('git-inspection-failed', `git ${args[0]} failed for the supplied checkout`, {
      stderr: String(error?.stderr ?? '').trim().slice(0, 2_000),
    });
  }
}

async function gitBytes(checkoutDir, args, code) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', checkoutDir, ...args], {
      encoding: 'buffer',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      maxBuffer: 64 * 1024 * 1024,
    });
    return Buffer.from(stdout);
  } catch (error) {
    fail(code, `git ${args[0]} failed for the owner-mapped source`, {
      stderr: String(error?.stderr ?? '').trim().slice(0, 2_000),
    });
  }
}

export async function inspectCheckout({ checkoutDir, pinnedCommit, repository, sourcePath }) {
  if (typeof checkoutDir !== 'string' || !path.isAbsolute(checkoutDir)) {
    fail('invalid-checkout-dir', 'checkoutDir must be an explicit absolute path');
  }
  if (typeof pinnedCommit !== 'string' || !COMMIT_RE.test(pinnedCommit)) {
    fail('invalid-pinned-commit', 'pinnedCommit must be a lowercase 40-character Git object ID');
  }

  let checkoutReal;
  try {
    checkoutReal = await realpath(checkoutDir);
    if (!(await stat(checkoutReal)).isDirectory()) fail('checkout-not-directory', 'checkoutDir is not a directory');
  } catch (error) {
    if (error instanceof LiveRunError) throw error;
    fail('checkout-unavailable', 'the supplied checkout could not be resolved', { cause: error?.code });
  }

  const root = await realpath(await git(checkoutReal, ['rev-parse', '--show-toplevel']));
  if (root !== checkoutReal) {
    fail('checkout-not-repository-root', 'checkoutDir must identify the Git worktree root');
  }
  await assertNoSymlinks(checkoutReal);

  const head = await git(checkoutReal, ['rev-parse', 'HEAD']);
  if (head !== pinnedCommit) {
    fail('checkout-commit-mismatch', `checkout HEAD ${head} does not match pinned commit ${pinnedCommit}`);
  }

  const status = await git(checkoutReal, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status !== '') {
    fail('checkout-not-clean', 'the supplied checkout must be clean before and after the live run', {
      status: status.split('\n').slice(0, 20),
    });
  }

  const origin = await git(checkoutReal, ['remote', 'get-url', 'origin']);
  const repositoryMatches = normalizeRepositoryIdentity(origin) === normalizeRepositoryIdentity(repository);
  if (!repositoryMatches) {
    fail('checkout-repository-mismatch', 'checkout origin does not match case.repository', { origin, repository });
  }

  let sourceBinding = null;
  if (sourcePath !== undefined) {
    const relativeSourcePath = String(sourcePath);
    const sourceFile = mappedFile(checkoutReal, relativeSourcePath);
    await gitBytes(checkoutReal, ['ls-files', '--error-unmatch', '--', relativeSourcePath], 'source-not-version-controlled');
    const [workingBytes, committedBytes] = await Promise.all([
      readFile(sourceFile),
      gitBytes(checkoutReal, ['show', `${pinnedCommit}:${relativeSourcePath}`], 'source-not-at-pinned-commit'),
    ]);
    if (!workingBytes.equals(committedBytes)) {
      fail('source-bytes-not-at-pinned-commit', 'owner-mapped source bytes must exactly match the pinned Git revision');
    }
    sourceBinding = {
      path: relativeSourcePath,
      tracked: true,
      matchesPinnedCommit: true,
      sha256: sha256(workingBytes),
    };
  }

  return deepFreeze({
    root: checkoutReal,
    head,
    clean: true,
    origin,
    repositoryMatches,
    sourceBinding,
    publishConfigPresent: await exists(path.join(checkoutReal, 'publish.yml')),
  });
}

function selectorFromCase(value) {
  return {
    quote: value.quote,
    ...(Object.hasOwn(value, 'prefix') ? { prefix: value.prefix } : {}),
    ...(Object.hasOwn(value, 'suffix') ? { suffix: value.suffix } : {}),
  };
}

async function copyVault(sourceDir, destinationDir) {
  const sourceRoot = await realpath(sourceDir);
  await assertNoSymlinks(sourceRoot);
  await cp(sourceRoot, destinationDir, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    filter(source) {
      const relative = path.relative(sourceRoot, source);
      if (relative === '') return true;
      return !relative.split(path.sep).some((segment) => COPY_IGNORES.has(segment));
    },
  });
}

function mappedFile(root, repositoryRelativePath) {
  const resolved = path.resolve(root, ...repositoryRelativePath.split('/'));
  const rootResolved = path.resolve(root);
  if (!resolved.startsWith(`${rootResolved}${path.sep}`)) {
    fail('unsafe-mapped-copy-path', 'repository-relative source mapping escaped a temporary vault copy');
  }
  return resolved;
}

function summarizeSelection(selection, sourcePath) {
  return {
    counts: clonePlain(selection.report.counts),
    errorCount: selection.errors.length,
    sourcePublished: selection.published.includes(sourcePath),
  };
}

function summarizeProjection(projectionResult, verification) {
  return {
    ok: projectionResult.ok,
    counts: clonePlain(projectionResult.counts),
    failureCount: projectionResult.failures.length,
    warningCount: projectionResult.warnings.length,
    verification: {
      ok: verification.ok,
      checked: clonePlain(verification.checked),
      unexpected: verification.unexpected.length,
      missing: verification.missing.length,
      deniedPresent: verification.deniedPresent.length,
      titleMatchCount: verification.titleMatchCount,
    },
  };
}

export async function buildProjection({
  vaultDir,
  outputDir,
  repositoryRelativePath,
  copyVaultTree = copyVault,
}) {
  const publishConfigPresent = await exists(path.join(vaultDir, 'publish.yml'));
  if (!publishConfigPresent) {
    await copyVaultTree(vaultDir, outputDir);
    return {
      mode: 'verbatim-without-publish-config',
      selection: null,
      projection: {
        ok: true,
        counts: null,
        failureCount: 0,
        warningCount: 0,
        verification: null,
      },
    };
  }

  const selection = select(vaultDir, { audience: 'public' });
  if (!selection.published.includes(repositoryRelativePath)) {
    fail('candidate-not-published', 'the selected source file is outside the current public projection');
  }

  const projectionResult = project(vaultDir, outputDir, {
    audience: 'public',
    selectResult: selection,
    lowercase: false,
    verify: true,
    writeReport: false,
  });
  if (!projectionResult.ok) {
    fail('projection-failed', 'the current Cyberbaser projection failed', {
      failures: projectionResult.failures.slice(0, 20),
    });
  }

  const verification = verifyProjection(vaultDir, outputDir, selection, { lowercase: false });
  if (!verification.ok) {
    fail('projection-verification-failed', 'the explicit projection boundary verification failed', {
      unexpected: verification.unexpected.slice(0, 20),
      missing: verification.missing.slice(0, 20),
      deniedPresent: verification.deniedPresent.slice(0, 20),
    });
  }

  return {
    mode: 'cyberbaser-select-project-verify',
    selection: summarizeSelection(selection, repositoryRelativePath),
    projection: summarizeProjection(projectionResult, verification),
  };
}

async function runCommand(file, args, options, code) {
  try {
    const result = await execFileAsync(file, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    fail(code, `${path.basename(file)} failed`, {
      exitCode: error?.code,
      stdout: String(error?.stdout ?? '').slice(-4_000),
      stderr: String(error?.stderr ?? '').slice(-4_000),
    });
  }
}

export async function setupQuartzWorkspace({ rendererDir, quartzDir, quartzRepository }) {
  const env = { ...process.env };
  if (quartzRepository) env.QUARTZ_REPO = quartzRepository;
  await runCommand('bash', [path.join(rendererDir, 'setup.sh'), quartzDir], { env }, 'quartz-setup-failed');
  return { renderer: 'quartz-cyberbase', pin: 'v4.5.2' };
}

export async function renderQuartzSite({ rendererDir, contentDir, quartzDir, outputDir }) {
  await runCommand(
    'bash',
    [path.join(rendererDir, 'build.sh'), contentDir, quartzDir],
    {
      env: {
        ...process.env,
        COPY_CONTENT: '1',
        OUTPUT_DIR: outputDir,
      },
    },
    'quartz-build-failed',
  );
  return { outputDir };
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareBroken(a, b) {
  return compareText(a.page, b.page)
    || compareText(a.href, b.href)
    || compareText(a.decoded, b.decoded)
    || compareText(a.class, b.class);
}

function brokenKey(item) {
  return JSON.stringify([item.page, item.href, item.decoded, item.class]);
}

export function candidateOnlyLinkDelta(baselineCheck, candidateCheck) {
  const baseline = [...baselineCheck.broken].sort(compareBroken);
  const candidate = [...candidateCheck.broken].sort(compareBroken);
  const baselineKeys = new Set(baseline.map(brokenKey));
  const candidateKeys = new Set(candidate.map(brokenKey));
  const candidateOnly = candidate.filter((item) => !baselineKeys.has(brokenKey(item)));
  const baselineOnly = baseline.filter((item) => !candidateKeys.has(brokenKey(item)));
  const unchanged = candidate.filter((item) => baselineKeys.has(brokenKey(item))).length;
  return deepFreeze({
    tuple: ['page', 'href', 'decoded', 'class'],
    candidateOnly,
    baselineOnly,
    unchanged,
    counts: {
      baseline: baseline.length,
      candidate: candidate.length,
      candidateOnly: candidateOnly.length,
      baselineOnly: baselineOnly.length,
      unchanged,
    },
  });
}

function siteSummary(check) {
  return {
    total: check.total,
    ok: check.ok,
    occurrences: check.occurrences,
    pages: check.pages,
    broken: check.broken.length,
    byClass: clonePlain(check.byClass),
  };
}

function normalizedBasePath(basePath) {
  return String(basePath ?? '').replace(/^\/+|\/+$/gu, '');
}

function deriveBasePath(publicUrl) {
  const pathname = new URL(publicUrl).pathname;
  return decodeURIComponent(pathname).split('/').filter(Boolean)[0] ?? '';
}

function renderedTargetCandidates(siteDir, publicUrl, basePath) {
  const url = new URL(publicUrl);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    pathname = url.pathname;
  }
  let relative = pathname.replace(/^\/+|\/+$/gu, '');
  const prefix = normalizedBasePath(basePath);
  if (prefix && (relative === prefix || relative.startsWith(`${prefix}/`))) {
    relative = relative.slice(prefix.length).replace(/^\/+/, '');
  }
  const base = path.resolve(siteDir, ...relative.split('/').filter(Boolean));
  const candidates = relative === ''
    ? [path.join(siteDir, 'index.html')]
    : [base, `${base}.html`, path.join(base, 'index.html')];
  return [...new Set(candidates)];
}

function htmlText(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}

async function captureOneTarget({ siteDir, publicUrl, basePath, quote, replacement }) {
  let targetFile = null;
  for (const candidate of renderedTargetCandidates(siteDir, publicUrl, basePath)) {
    try {
      if ((await stat(candidate)).isFile()) {
        targetFile = candidate;
        break;
      }
    } catch {
      // Try the next renderer-compatible output shape.
    }
  }
  if (!targetFile) fail('rendered-target-missing', 'the public URL did not map to a rendered local target page');

  const bytes = await readFile(targetFile);
  const html = bytes.toString('utf8');
  const quoteOccurrences = countOccurrences(html, htmlText(quote));
  const replacementOccurrences = countOccurrences(html, htmlText(replacement));
  return {
    page: path.relative(siteDir, targetFile).split(path.sep).join('/'),
    byteLength: bytes.length,
    sha256: sha256(bytes),
    quoteOccurrences,
    replacementOccurrences,
    observedExactText: quoteOccurrences >= 1 && replacementOccurrences === 0
      ? quote
      : quoteOccurrences === 0 && (replacement.length === 0 || replacementOccurrences >= 1)
        ? replacement
        : null,
  };
}

export async function captureRenderedTargetEvidence({
  baselineSiteDir,
  candidateSiteDir,
  caseData,
  basePath,
}) {
  const value = validateCase(caseData);
  const effectiveBasePath = basePath ?? deriveBasePath(value.publicUrl);
  const [baseline, candidate] = await Promise.all([
    captureOneTarget({
      siteDir: baselineSiteDir,
      publicUrl: value.publicUrl,
      basePath: effectiveBasePath,
      quote: value.quote,
      replacement: value.replacement,
    }),
    captureOneTarget({
      siteDir: candidateSiteDir,
      publicUrl: value.publicUrl,
      basePath: effectiveBasePath,
      quote: value.quote,
      replacement: value.replacement,
    }),
  ]);

  const comparable = {
    sameRenderedPage: baseline.page === candidate.page,
    baselineOldTextPresent: baseline.quoteOccurrences >= 1,
    baselineReplacementTextAbsent: baseline.replacementOccurrences === 0,
    candidateOldTextAbsent: candidate.quoteOccurrences === 0,
    candidateReplacementSatisfied: value.replacement.length === 0
      ? candidate.replacementOccurrences === 0
      : candidate.replacementOccurrences >= 1,
  };
  if (!Object.values(comparable).every(Boolean)) {
    fail('rendered-target-mismatch', 'rendered target evidence did not show the exact baseline-to-candidate replacement', {
      baseline,
      candidate,
      comparable,
    });
  }

  return deepFreeze({ basePath: normalizedBasePath(effectiveBasePath), baseline, candidate, comparable });
}

function correctionFor(baseBytes, value) {
  return prepareCorrection(baseBytes, {
    selector: selectorFromCase(value),
    replacement: value.replacement,
  });
}

function assertPinnedCommit(pinnedCommit, value) {
  if (pinnedCommit !== value.baseCommit) {
    fail('case-commit-mismatch', 'the explicit pinned commit must exactly match case.baseCommit');
  }
}

function mergeDependencies(overrides = {}) {
  return {
    inspectCheckout,
    createTemporaryRoot: () => mkdtemp(path.join(os.tmpdir(), 'cyberbaser-correction-live-')),
    cleanupTemporaryRoot: (root) => rm(root, { recursive: true, force: true }),
    copyVault,
    buildProjection,
    setupRenderer: setupQuartzWorkspace,
    renderSite: renderQuartzSite,
    checkSite,
    captureTargetEvidence: captureRenderedTargetEvidence,
    ...overrides,
  };
}

export async function runLiveCorrection({
  caseData,
  checkoutDir,
  pinnedCommit,
  ownerPolicy,
  policyRevision,
  trustSubject,
  basePath,
  rendererDir = DEFAULT_RENDERER_DIR,
  quartzRepository,
}, dependencyOverrides = {}) {
  const value = validateCase(caseData);
  assertPinnedCommit(pinnedCommit, value);
  const deps = mergeDependencies(dependencyOverrides);

  let initialCheckout = null;
  let finalCheckout = null;
  let sourceFile = null;
  let sourceSnapshot = null;
  let temporaryRoot = null;
  let payload = null;
  let primaryError = null;
  let finalStateError = null;
  let cleanupError = null;

  try {
    initialCheckout = await deps.inspectCheckout({
      checkoutDir,
      pinnedCommit,
      repository: value.repository,
      sourcePath: value.sourcePath,
    });

    const evaluation = await evaluateCorrection({
      caseData: value,
      checkoutDir: initialCheckout.root,
      ownerPolicy,
      policyRevision,
      trustSubject,
    });
    sourceFile = mappedFile(initialCheckout.root, evaluation.source.repositoryRelativePath);
    sourceSnapshot = await readFile(sourceFile);

    temporaryRoot = await deps.createTemporaryRoot();
    const baselineVault = path.join(temporaryRoot, 'baseline', 'vault');
    const candidateVault = path.join(temporaryRoot, 'candidate', 'vault');
    const baselineProjection = path.join(temporaryRoot, 'baseline', 'projection');
    const candidateProjection = path.join(temporaryRoot, 'candidate', 'projection');
    const baselineQuartz = path.join(temporaryRoot, 'baseline', 'quartz');
    const candidateQuartz = path.join(temporaryRoot, 'candidate', 'quartz');
    const baselineSite = path.join(temporaryRoot, 'baseline', 'site');
    const candidateSite = path.join(temporaryRoot, 'candidate', 'site');

    await deps.copyVault(initialCheckout.root, baselineVault);
    await deps.copyVault(initialCheckout.root, candidateVault);

    const baselineCopyFile = mappedFile(baselineVault, evaluation.source.repositoryRelativePath);
    const candidateCopyFile = mappedFile(candidateVault, evaluation.source.repositoryRelativePath);
    const baselineCopyBytes = await readFile(baselineCopyFile);
    const candidateCopyBaseBytes = await readFile(candidateCopyFile);
    if (!baselineCopyBytes.equals(sourceSnapshot) || !candidateCopyBaseBytes.equals(sourceSnapshot)) {
      fail('temporary-copy-mismatch', 'baseline and candidate copies must begin byte-identical to the supplied checkout');
    }

    const prepared = correctionFor(candidateCopyBaseBytes, value);
    const candidateBytes = applyCorrection(candidateCopyBaseBytes, prepared);
    if (sha256(candidateBytes) === sha256(candidateCopyBaseBytes)) {
      fail('candidate-copy-no-op', 'candidate temporary copy did not change');
    }
    await writeFile(candidateCopyFile, candidateBytes);
    if (!(await readFile(baselineCopyFile)).equals(sourceSnapshot)) {
      fail('baseline-copy-changed', 'the baseline temporary copy changed while preparing the candidate lane');
    }

    const baselineProjectionResult = await deps.buildProjection({
      lane: 'baseline',
      vaultDir: baselineVault,
      outputDir: baselineProjection,
      repositoryRelativePath: evaluation.source.repositoryRelativePath,
      copyVaultTree: deps.copyVault,
    });
    const candidateProjectionResult = await deps.buildProjection({
      lane: 'candidate',
      vaultDir: candidateVault,
      outputDir: candidateProjection,
      repositoryRelativePath: evaluation.source.repositoryRelativePath,
      copyVaultTree: deps.copyVault,
    });

    const baselineRenderer = await deps.setupRenderer({
      lane: 'baseline',
      rendererDir,
      quartzDir: baselineQuartz,
      quartzRepository,
    });
    await deps.renderSite({
      lane: 'baseline',
      rendererDir,
      contentDir: baselineProjection,
      quartzDir: baselineQuartz,
      outputDir: baselineSite,
      caseData: value,
      repositoryRelativePath: evaluation.source.repositoryRelativePath,
    });

    const candidateRenderer = await deps.setupRenderer({
      lane: 'candidate',
      rendererDir,
      quartzDir: candidateQuartz,
      quartzRepository,
    });
    await deps.renderSite({
      lane: 'candidate',
      rendererDir,
      contentDir: candidateProjection,
      quartzDir: candidateQuartz,
      outputDir: candidateSite,
      caseData: value,
      repositoryRelativePath: evaluation.source.repositoryRelativePath,
    });

    const baselineCheck = await deps.checkSite(baselineSite, { basePath: basePath ?? deriveBasePath(value.publicUrl) });
    const candidateCheck = await deps.checkSite(candidateSite, { basePath: basePath ?? deriveBasePath(value.publicUrl) });
    const linkDelta = candidateOnlyLinkDelta(baselineCheck, candidateCheck);
    const renderedTarget = await deps.captureTargetEvidence({
      baselineSiteDir: baselineSite,
      candidateSiteDir: candidateSite,
      caseData: value,
      basePath,
    });

    payload = {
      schemaVersion: 1,
      artifactType: 'private-local-rendered-correction-run',
      case: publicSafeCase(value),
      evaluation,
      sourceCheckout: {
        repository: value.repository,
        baseCommit: pinnedCommit,
        repositoryMatches: initialCheckout.repositoryMatches,
        cleanBefore: initialCheckout.clean,
        publishConfigPresent: initialCheckout.publishConfigPresent,
        sourceBytesBeforeSha256: sha256(sourceSnapshot),
      },
      temporaryCopies: {
        separateBaselineAndCandidate: true,
        baselineSourceUnchanged: true,
        candidateSourceChangedOnlyInTemporaryCopy: true,
        candidateSha256: sha256(candidateBytes),
      },
      projection: {
        baseline: clonePlain(baselineProjectionResult),
        candidate: clonePlain(candidateProjectionResult),
      },
      renderer: {
        baseline: clonePlain(baselineRenderer),
        candidate: clonePlain(candidateRenderer),
        isolatedWorkspaces: true,
        publicDeploymentPerformed: false,
      },
      siteChecks: {
        baseline: siteSummary(baselineCheck),
        candidate: siteSummary(candidateCheck),
        linkDelta,
      },
      renderedTarget,
      noWrite: {
        suppliedCheckoutWritePerformed: false,
        automaticSourceApplicationPerformed: false,
        candidateAppliedOnlyToTemporaryCandidateCopy: true,
      },
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (initialCheckout) {
      try {
        finalCheckout = await deps.inspectCheckout({
          checkoutDir,
          pinnedCommit,
          repository: value.repository,
        });
        if (sourceFile && sourceSnapshot && !(await readFile(sourceFile)).equals(sourceSnapshot)) {
          fail('source-checkout-changed', 'the supplied source bytes changed during the live run');
        }
      } catch (error) {
        finalStateError = error;
      }
    }
    if (temporaryRoot) {
      try {
        await deps.cleanupTemporaryRoot(temporaryRoot);
      } catch (error) {
        cleanupError = new LiveRunError('temporary-cleanup-failed', 'temporary live-run workspaces could not be removed', {
          cause: error?.message,
        });
      }
    }
  }

  if (finalStateError) throw finalStateError;
  if (cleanupError) throw cleanupError;
  if (primaryError) throw primaryError;

  payload.sourceCheckout.cleanAfter = finalCheckout.clean;
  payload.sourceCheckout.sourceBytesUnchangedAfter = true;
  payload.cleanup = {
    completed: true,
    temporaryWorkspacesRetained: false,
  };
  return deepFreeze(payload);
}
