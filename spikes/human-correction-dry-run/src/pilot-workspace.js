import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { stableStringify } from './case.js';
import { inspectCheckout } from './live-run.js';
import {
  OWNER_DOGFOOD_OBLIGATIONS,
  evidenceClassification,
  isSupersededOwnerDogfoodAttempt,
  operatorDefaults,
  ownerDecisionTemplate,
  validateAttemptId,
  validateOperator,
  validateOperatorRepin,
  validateOwnerDogfoodSeriesCharter,
  validateProfile,
  validateSourcePath,
} from './pilot-input.js';

const execFileAsync = promisify(execFile);
export const DEFAULT_PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const DEFAULT_WORKSPACE_ROOT = path.join(DEFAULT_PROJECT_ROOT, '.workspace', 'human-correction-pilot');
const TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url));
const READER_FORM_TEMPLATES = Object.freeze({
  'reader-form-v1': 'reader-form-v1.html',
  'reader-form-v2': 'reader-form.html',
});

export class PilotWorkspaceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PilotWorkspaceError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new PilotWorkspaceError(code, message, details);
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function assertContained(root, target, code = 'workspace-path-outside-root') {
  const rootResolved = path.resolve(root);
  const targetResolved = path.resolve(target);
  const relative = path.relative(rootResolved, targetResolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(code, 'pilot path must remain below the ignored pilot workspace');
  }
  return targetResolved;
}

async function assertNoSymlinkComponents(projectRoot, target) {
  const project = path.resolve(projectRoot);
  const destination = path.resolve(target);
  assertContained(project, destination, 'workspace-path-outside-project');
  const relative = path.relative(project, destination);
  let current = project;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        fail('workspace-symlink-rejected', 'pilot workspace components must not be symbolic links', {
          path: path.relative(project, current).split(path.sep).join('/'),
        });
      }
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      if (error instanceof PilotWorkspaceError) throw error;
      throw error;
    }
  }
}

export async function assertIgnoredPath(target, projectRoot = DEFAULT_PROJECT_ROOT) {
  const absolute = path.resolve(target);
  try {
    await execFileAsync('git', ['-C', projectRoot, 'check-ignore', '--no-index', '-q', '--', absolute], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
  } catch (error) {
    if (error?.code === 1) fail('workspace-not-ignored', 'pilot destination is not ignored by Git');
    fail('git-ignore-check-failed', 'git check-ignore could not verify the pilot destination');
  }
  return absolute;
}

export function attemptPaths(attemptIdInput, {
  projectRoot = DEFAULT_PROJECT_ROOT,
  workspaceRoot = DEFAULT_WORKSPACE_ROOT,
} = {}) {
  const attemptId = validateAttemptId(attemptIdInput);
  const root = assertContained(workspaceRoot, path.join(workspaceRoot, 'attempts', attemptId));
  return Object.freeze({
    projectRoot: path.resolve(projectRoot),
    workspaceRoot: path.resolve(workspaceRoot),
    attemptId,
    root,
    readerForm: path.join(root, 'reader-form.html'),
    submission: path.join(root, 'submission.json'),
    operator: path.join(root, 'operator.json'),
    operatorRepin: path.join(root, 'operator-repin.json'),
    bindingLock: path.join(root, '.binding-transition.lock'),
    dogfoodObservation: path.join(root, 'dogfood-observation.json'),
    ownerDecision: path.join(root, 'owner-decision.json'),
    runs: path.join(root, 'runs'),
    logs: path.join(root, 'logs'),
  });
}

export function ownerDogfoodSeriesPaths({
  projectRoot = DEFAULT_PROJECT_ROOT,
  workspaceRoot = DEFAULT_WORKSPACE_ROOT,
} = {}) {
  const resolvedWorkspace = path.resolve(workspaceRoot);
  return Object.freeze({
    projectRoot: path.resolve(projectRoot),
    workspaceRoot: resolvedWorkspace,
    manifest: assertContained(
      resolvedWorkspace,
      path.join(resolvedWorkspace, 'owner-self-dogfood-series.json'),
    ),
  });
}

export async function initializeOwnerDogfoodSeries({
  charter,
  projectRoot = DEFAULT_PROJECT_ROOT,
  workspaceRoot = DEFAULT_WORKSPACE_ROOT,
} = {}) {
  const normalized = validateOwnerDogfoodSeriesCharter(charter);
  const paths = ownerDogfoodSeriesPaths({ projectRoot, workspaceRoot });
  await assertNoSymlinkComponents(paths.projectRoot, paths.workspaceRoot);
  await mkdir(paths.workspaceRoot, { recursive: true });
  await assertNoSymlinkComponents(paths.projectRoot, paths.workspaceRoot);
  await assertIgnoredPath(paths.manifest, paths.projectRoot);
  await atomicCreateArtifact(paths.manifest, stableStringify(normalized), paths);
  return Object.freeze({
    manifest: paths.manifest,
    attemptIds: [...normalized.attemptIds],
    obligationAssignments: { ...normalized.obligationAssignments },
    evidenceClassification: { ...normalized.evidenceClassification },
  });
}

export async function loadOwnerDogfoodSeries({
  projectRoot = DEFAULT_PROJECT_ROOT,
  workspaceRoot = DEFAULT_WORKSPACE_ROOT,
} = {}) {
  const paths = ownerDogfoodSeriesPaths({ projectRoot, workspaceRoot });
  await assertNoSymlinkComponents(paths.projectRoot, paths.manifest);
  await assertIgnoredPath(paths.manifest, paths.projectRoot);
  if (!(await exists(paths.manifest))) {
    fail(
      'dogfood-series-required',
      'initialize the owner self-dogfood series before creating an OD attempt',
    );
  }
  let handle;
  let value;
  try {
    handle = await open(
      paths.manifest,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      fail('dogfood-series-invalid', 'owner self-dogfood series must be a regular JSON file');
    }
    value = JSON.parse(await handle.readFile('utf8'));
  } catch (error) {
    if (error instanceof PilotWorkspaceError) throw error;
    if (error?.code === 'ELOOP') {
      fail('workspace-symlink-rejected', 'pilot workspace components must not be symbolic links');
    }
    fail('dogfood-series-invalid', 'owner self-dogfood series must be readable JSON');
  } finally {
    await handle?.close();
  }
  return validateOwnerDogfoodSeriesCharter(value);
}

async function verifiedWrite(file, contents, context) {
  assertContained(context.workspaceRoot, file);
  await assertNoSymlinkComponents(context.projectRoot, path.dirname(file));
  await assertIgnoredPath(file, context.projectRoot);
  await writeFile(file, contents, { encoding: 'utf8', flag: 'wx' });
}

export function renderReaderForm(template, attemptId, profile) {
  const profileNotice = profile === 'cyberbase-rehearsal'
    ? '<p class="rehearsal"><strong>Cyberbase rehearsal:</strong> this attempt supplies zero counted independent-owner evidence.</p>'
    : profile === 'owner-self-dogfood'
      ? '<p class="rehearsal"><strong>Owner self-dogfood:</strong> one maintainer is switching roles. This is operational evidence, not independent reader or owner validation.</p>'
      : '';
  return template
    .replaceAll('__ATTEMPT_ID__', attemptId)
    .replaceAll('__PROFILE__', profile)
    .replaceAll('__PROFILE_NOTICE__', profileNotice);
}

export async function renderExpectedReaderForm(
  attemptId,
  profile,
  instrumentVersion = 'reader-form-v2',
) {
  const templateName = READER_FORM_TEMPLATES[instrumentVersion];
  if (!templateName) {
    fail(
      'invalid-instrument-version',
      'reader form instrument version must be reader-form-v1 or reader-form-v2',
    );
  }
  const template = await readFile(path.join(TEMPLATES_DIR, templateName), 'utf8');
  return renderReaderForm(template, attemptId, profile);
}

export async function matchReaderFormInstrumentVersion(bytes, attemptId, profile) {
  const snapshot = Buffer.from(bytes);
  for (const instrumentVersion of Object.keys(READER_FORM_TEMPLATES)) {
    const expected = Buffer.from(
      await renderExpectedReaderForm(attemptId, profile, instrumentVersion),
      'utf8',
    );
    if (snapshot.equals(expected)) return instrumentVersion;
  }
  fail(
    'reader-form-integrity-mismatch',
    'reader form bytes no longer match a canonical generated instrument',
  );
}

function dogfoodObservationTemplate(attemptId, series) {
  const precommittedObligations = OWNER_DOGFOOD_OBLIGATIONS.filter(
    (obligation) => series.obligationAssignments[obligation] === attemptId,
  );
  const mobilePlanned = precommittedObligations.includes('signed-out-mobile-handoff');
  return {
    schemaVersion: 1,
    attemptId,
    evidenceClass: 'owner-self-dogfood',
    precommittedObligations,
    scenario: '',
    readerContext: mobilePlanned
      ? {
          device: series.plannedSignedOutMobile.device,
          operatingSystem: series.plannedSignedOutMobile.operatingSystem,
          browser: series.plannedSignedOutMobile.browser,
          signedIn: false,
        }
      : {
          device: '',
          operatingSystem: '',
          browser: '',
          signedIn: null,
        },
    ownerContext: {
      device: '',
      operatingSystem: '',
      browser: '',
      signedIn: null,
    },
    roleSeparation: 'same maintainer, separate reader and owner contexts',
    startedAt: '',
    completedAt: '',
    manualInterventions: [],
    sourceWritePerformed: false,
    publicDeploymentPerformed: false,
    liveVerificationPerformed: false,
    notes: '',
  };
}

const CYBERBASE_REPOSITORY = 'https://github.com/cybersader/cyberbase';

function cyberbasePrefillOptions({ checkoutDir, sourcePath, publicUrl, sourceAuthorization }) {
  const values = { checkoutDir, sourcePath, publicUrl, sourceAuthorization };
  const supplied = Object.values(values).filter((value) => value !== undefined).length;
  if (supplied === 0) return null;
  if (supplied !== Object.keys(values).length) {
    fail(
      'incomplete-cyberbase-prefill',
      'Cyberbase prefill requires checkout, source, url, and authorize-source together',
    );
  }
  return values;
}

export async function deriveCheckoutHead(checkoutDir) {
  if (typeof checkoutDir !== 'string' || !path.isAbsolute(checkoutDir)) {
    fail('invalid-checkout-dir', 'Cyberbase prefill checkout must be an absolute Git worktree root');
  }
  try {
    const { stdout } = await execFileAsync('git', ['-C', checkoutDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return stdout.trim();
  } catch (error) {
    fail('checkout-head-unavailable', 'Cyberbase prefill could not derive checkout HEAD', {
      stderr: String(error?.stderr ?? '').trim().slice(0, 2_000),
    });
  }
}

async function prefilledCyberbaseOperator({ attemptId, profile, prefill }) {
  if (profile !== 'cyberbase-rehearsal' && profile !== 'owner-self-dogfood') {
    fail(
      'cyberbase-prefill-profile-mismatch',
      'Cyberbase prefill is allowed only with profile cyberbase-rehearsal or owner-self-dogfood',
    );
  }
  if (prefill.sourceAuthorization !== 'yes') {
    fail('source-authorization-required', 'authorize-source must be exactly yes');
  }
  const sourcePath = validateSourcePath(prefill.sourcePath);
  const head = await deriveCheckoutHead(prefill.checkoutDir);
  const checkout = await inspectCheckout({
    checkoutDir: prefill.checkoutDir,
    pinnedCommit: head,
    repository: CYBERBASE_REPOSITORY,
    sourcePath,
  });
  if (checkout.publishConfigPresent !== true) {
    fail(
      'publication-boundary-policy-missing',
      'Cyberbase initialization requires publish.yml at the pinned source revision',
    );
  }
  return validateOperator({
    ...operatorDefaults(attemptId, profile),
    checkoutDir: checkout.root,
    baseCommit: checkout.head,
    sourcePath,
    publicUrl: prefill.publicUrl,
    sourceAuthorizedForLocalProcessing: true,
  });
}

export async function initializeAttempt({
  attemptId: attemptIdInput,
  profile: profileInput,
  checkoutDir,
  sourcePath,
  publicUrl,
  sourceAuthorization,
  projectRoot = DEFAULT_PROJECT_ROOT,
  workspaceRoot = DEFAULT_WORKSPACE_ROOT,
} = {}) {
  const attemptId = validateAttemptId(attemptIdInput);
  const profile = validateProfile(profileInput);
  const paths = attemptPaths(attemptId, { projectRoot, workspaceRoot });
  let dogfoodSeries = null;
  if (profile === 'owner-self-dogfood') {
    dogfoodSeries = await loadOwnerDogfoodSeries({ projectRoot, workspaceRoot });
    if (!dogfoodSeries.attemptIds.includes(attemptId)) {
      fail(
        'dogfood-attempt-not-declared',
        `${attemptId} is not declared in the owner self-dogfood series`,
      );
    }
    if (isSupersededOwnerDogfoodAttempt(attemptId)) {
      fail(
        'dogfood-attempt-superseded',
        `${attemptId} is Not run — superseded and must not be initialized`,
      );
    }
  }
  await assertNoSymlinkComponents(paths.projectRoot, paths.workspaceRoot);
  await assertIgnoredPath(paths.root, paths.projectRoot);
  if (await exists(paths.root)) fail('attempt-already-exists', `${attemptId} already exists`);
  const prefill = cyberbasePrefillOptions({ checkoutDir, sourcePath, publicUrl, sourceAuthorization });
  const operator = prefill
    ? await prefilledCyberbaseOperator({ attemptId, profile, prefill })
    : operatorDefaults(attemptId, profile);

  const attemptsRoot = path.dirname(paths.root);
  await mkdir(attemptsRoot, { recursive: true });
  await assertNoSymlinkComponents(paths.projectRoot, attemptsRoot);
  const staging = await mkdtemp(path.join(attemptsRoot, `.${attemptId}-init-`));
  const stagingContext = { projectRoot: paths.projectRoot, workspaceRoot: paths.workspaceRoot };

  try {
    await assertIgnoredPath(staging, paths.projectRoot);
    await mkdir(path.join(staging, 'runs'));
    await mkdir(path.join(staging, 'logs'));
    await verifiedWrite(
      path.join(staging, 'reader-form.html'),
      await renderExpectedReaderForm(attemptId, profile),
      stagingContext,
    );
    await verifiedWrite(
      path.join(staging, 'operator.json'),
      stableStringify(operator),
      stagingContext,
    );
    if (profile === 'owner-self-dogfood') {
      await verifiedWrite(
        path.join(staging, 'dogfood-observation.json'),
        stableStringify(dogfoodObservationTemplate(attemptId, dogfoodSeries)),
        stagingContext,
      );
    }
    await verifiedWrite(
      path.join(staging, 'owner-decision.json'),
      stableStringify(ownerDecisionTemplate(attemptId)),
      stagingContext,
    );
    await rename(staging, paths.root);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  await assertNoSymlinkComponents(paths.projectRoot, paths.root);
  const classification = evidenceClassification(profile);
  return Object.freeze({
    attemptId,
    profile,
    countsTowardPilot: false,
    ...classification,
    operatorPrefilled: Boolean(prefill),
    root: paths.root,
    readerForm: paths.readerForm,
    submission: paths.submission,
    operator: paths.operator,
    dogfoodObservation: profile === 'owner-self-dogfood' ? paths.dogfoodObservation : null,
    notice: classification.claimBoundary,
  });
}

export async function loadAttemptJson(file, label, paths) {
  assertContained(paths.workspaceRoot, file);
  await assertNoSymlinkComponents(paths.projectRoot, file);
  await assertIgnoredPath(file, paths.projectRoot);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    fail(`invalid-${label}`, `${label} must identify readable JSON`);
  }
}

export async function loadAttemptOperator(paths) {
  const original = validateOperator(await loadAttemptJson(paths.operator, 'operator', paths));
  if (!(await exists(paths.operatorRepin))) return original;
  const repin = validateOperatorRepin(
    await loadAttemptJson(paths.operatorRepin, 'operator-repin', paths),
    original,
  );
  return repin.replacementOperator;
}

export async function createRunStaging(paths, mechanicalCaseId) {
  const runsRoot = paths.runs;
  await mkdir(runsRoot, { recursive: true });
  await assertNoSymlinkComponents(paths.projectRoot, runsRoot);
  await assertIgnoredPath(runsRoot, paths.projectRoot);
  const staging = await mkdtemp(path.join(paths.root, `.${mechanicalCaseId}-prepare-`));
  await assertIgnoredPath(staging, paths.projectRoot);
  return staging;
}

export async function commitRunStaging(paths, mechanicalCaseId, staging) {
  const destination = assertContained(paths.workspaceRoot, path.join(paths.runs, mechanicalCaseId));
  await assertIgnoredPath(destination, paths.projectRoot);
  if (await exists(destination)) {
    await rm(staging, { recursive: true, force: true });
    fail('run-already-exists', `${mechanicalCaseId} already exists; changed bytes require a new base-bound run`);
  }
  await rename(staging, destination);
  return destination;
}

export async function writeStagedArtifact(staging, name, contents, paths) {
  const file = path.join(staging, name);
  await verifiedWrite(file, contents, paths);
  return file;
}

export async function atomicWriteArtifact(file, contents, paths) {
  assertContained(paths.workspaceRoot, file);
  await assertNoSymlinkComponents(paths.projectRoot, path.dirname(file));
  await assertIgnoredPath(file, paths.projectRoot);
  const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await assertIgnoredPath(temporary, paths.projectRoot);
  await writeFile(temporary, contents, 'utf8');
  try {
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function prepareBindingLockFile(file) {
  let handle;
  try {
    handle = await open(
      file,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) {
      fail('attempt-binding-lock-invalid', 'attempt binding lock must be one safe regular file');
    }
  } catch (error) {
    if (error?.code === 'ELOOP') {
      fail('workspace-symlink-rejected', 'pilot workspace components must not be symbolic links');
    }
    if (error instanceof PilotWorkspaceError) throw error;
    fail('attempt-binding-lock-unavailable', 'attempt binding lock file could not be prepared');
  } finally {
    await handle?.close();
  }
}

async function acquireBindingLock(file) {
  const token = `binding-lock-ready-${process.pid}-${Math.random().toString(16).slice(2)}\n`;
  const child = spawn('flock', [
    '--exclusive',
    '--nonblock',
    '--conflict-exit-code',
    '75',
    file,
    'cat',
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.stdin.on('error', () => {
    // The exit handler reports lock conflicts and startup failures.
  });
  await new Promise((resolve, reject) => {
    let settled = false;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.once('error', (error) => {
      rejectOnce(new PilotWorkspaceError(
        'attempt-binding-lock-unavailable',
        'kernel binding lock process could not start',
        { cause: error?.code ?? 'spawn-failed' },
      ));
    });
    child.once('exit', (code) => {
      if (settled) return;
      if (code === 75) {
        rejectOnce(new PilotWorkspaceError(
          'attempt-binding-busy',
          'another binding or decision transition is already in progress',
        ));
        return;
      }
      rejectOnce(new PilotWorkspaceError(
        'attempt-binding-lock-unavailable',
        'kernel binding lock process exited before acquiring the lock',
        { exitCode: code, stderr: stderr.trim().slice(0, 2_000) },
      ));
    });
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      output += chunk.toString();
      if (output.includes(token)) {
        settled = true;
        resolve();
      }
    });
    child.stdin.write(token);
  });
  return child;
}

async function releaseBindingLock(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.stdin.end();
  await exited;
}

export async function withAttemptBindingLock(paths, action) {
  const file = paths.bindingLock;
  assertContained(paths.workspaceRoot, file);
  await assertNoSymlinkComponents(paths.projectRoot, path.dirname(file));
  await assertIgnoredPath(file, paths.projectRoot);
  await prepareBindingLockFile(file);
  const lock = await acquireBindingLock(file);
  try {
    return await action();
  } finally {
    await releaseBindingLock(lock);
  }
}

export async function atomicCreateArtifact(file, contents, paths) {
  assertContained(paths.workspaceRoot, file);
  await assertNoSymlinkComponents(paths.projectRoot, path.dirname(file));
  await assertIgnoredPath(file, paths.projectRoot);
  const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await assertIgnoredPath(temporary, paths.projectRoot);
  await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' });
  try {
    await link(temporary, file);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      fail(
        'artifact-already-exists',
        `${path.basename(file)} already exists; completed evidence is immutable`,
      );
    }
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function verifyAttemptWorkspace(paths) {
  await assertNoSymlinkComponents(paths.projectRoot, paths.root);
  await assertIgnoredPath(paths.root, paths.projectRoot);
  const resolvedWorkspace = await realpath(paths.workspaceRoot);
  const resolvedAttempt = await realpath(paths.root);
  assertContained(resolvedWorkspace, resolvedAttempt);
  return true;
}

export async function recordPilotError({
  attemptId = 'unknown',
  error,
  attemptScoped = true,
  projectRoot = DEFAULT_PROJECT_ROOT,
  workspaceRoot = DEFAULT_WORKSPACE_ROOT,
}) {
  const safeAttemptId = (() => {
    try { return validateAttemptId(attemptId); } catch { return 'unknown'; }
  })();
  const logRoot = safeAttemptId === 'unknown' || !attemptScoped
    ? path.join(workspaceRoot, 'logs')
    : path.join(workspaceRoot, 'attempts', safeAttemptId, 'logs');
  let logLocation = 'not-written';
  try {
    await assertNoSymlinkComponents(projectRoot, logRoot);
    await assertIgnoredPath(logRoot, projectRoot);
    await mkdir(logRoot, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const file = path.join(logRoot, `${stamp}-${error?.code ?? 'pilot-failed'}.json`);
    await assertIgnoredPath(file, projectRoot);
    await writeFile(file, stableStringify({
      recordedAt: new Date().toISOString(),
      attemptId: safeAttemptId,
      error: {
        code: error?.code ?? 'pilot-failed',
        message: error?.message ?? 'pilot command failed',
        details: error?.details ?? {},
      },
    }), 'utf8');
    logLocation = file;
  } catch {
    // A workspace safety failure must not be bypassed merely to write its log.
  }
  return {
    code: error?.code ?? 'pilot-failed',
    message: error?.message ?? 'pilot command failed',
    attemptId: safeAttemptId,
    log: logLocation,
  };
}
