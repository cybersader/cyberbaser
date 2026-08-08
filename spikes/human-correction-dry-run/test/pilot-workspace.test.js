import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stableStringify } from '../src/case.js';
import {
  assertIgnoredPath,
  attemptPaths,
  initializeAttempt,
  initializeOwnerDogfoodSeries,
  loadOwnerDogfoodSeries,
  ownerDogfoodSeriesPaths,
  recordPilotError,
  withAttemptBindingLock,
} from '../src/pilot-workspace.js';

const PROJECT_ROOT = path.resolve(import.meta.dir, '../../..');
const cleanup = [];

async function workspaceRoot() {
  const root = await mkdtemp(path.join(PROJECT_ROOT, '.workspace', 'pilot-workspace-test-'));
  cleanup.push(root);
  return root;
}

async function command(args, cwd) {
  const process = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${args.join(' ')} failed: ${stderr || stdout}`);
  return stdout.trim();
}

async function cyberbaseCheckout({ publishConfig = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pilot-init-cyberbase-'));
  cleanup.push(root);
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'guide.md'), '# Guide\n\nOwner-selected sentence.\n', 'utf8');
  if (publishConfig) {
    await writeFile(path.join(root, 'publish.yml'), 'allow:\n  - "docs/**"\n', 'utf8');
  }
  await command(['git', 'init', '-q'], root);
  await command(['git', 'config', 'user.email', 'test@example.org'], root);
  await command(['git', 'config', 'user.name', 'Test User'], root);
  await command(['git', 'add', '.'], root);
  await command(['git', 'commit', '-q', '-m', 'fixture'], root);
  await command(['git', 'remote', 'add', 'origin', 'https://github.com/cybersader/cyberbase.git'], root);
  return { root, head: await command(['git', 'rev-parse', 'HEAD'], root) };
}

function dogfoodSeries(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactType: 'private-owner-self-dogfood-series-charter',
    profile: 'owner-self-dogfood',
    attemptIds: ['OD-01', 'OD-02', 'OD-03'],
    obligationAssignments: {
      'normal-correction': 'OD-01',
      'signed-out-mobile-handoff': 'OD-01',
      'stale-source': 'OD-02',
      'ambiguous-quote': 'OD-02',
      'owner-rejection': 'OD-03',
    },
    plannedSignedOutMobile: {
      attemptId: 'OD-01',
      device: 'Owner phone',
      operatingSystem: 'Mobile OS',
      browser: 'Mobile browser',
      signedIn: false,
    },
    evidenceClassification: {
      evidenceClass: 'owner-self-dogfood',
      countsTowardHumanPilot: false,
      independentOwnerEvidence: false,
      claimBoundary: 'maintainer operational and mechanical evidence only',
    },
    ...overrides,
  };
}

async function initializeSeries(workspace, charter = dogfoodSeries()) {
  return initializeOwnerDogfoodSeries({
    charter,
    projectRoot: PROJECT_ROOT,
    workspaceRoot: workspace,
  });
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('ignored private pilot workspace', () => {
  test('initializes one private attempt with no counted evidence and no participant submission', async () => {
    const workspace = await workspaceRoot();
    const result = await initializeAttempt({
      attemptId: 'HC-01',
      profile: 'cyberbase-rehearsal',
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspace,
    });
    const paths = attemptPaths('HC-01', { projectRoot: PROJECT_ROOT, workspaceRoot: workspace });
    expect(result.countsTowardPilot).toBe(false);
    expect(result.notice).toContain('zero counted');
    expect(await assertIgnoredPath(paths.root, PROJECT_ROOT)).toBe(paths.root);
    expect((await lstat(paths.root)).isDirectory()).toBe(true);
    expect((await lstat(paths.readerForm)).isFile()).toBe(true);
    expect((await lstat(paths.operator)).isFile()).toBe(true);
    expect((await lstat(paths.ownerDecision)).isFile()).toBe(true);
    await expect(lstat(paths.submission)).rejects.toMatchObject({ code: 'ENOENT' });

    const form = await readFile(paths.readerForm, 'utf8');
    expect(form).toContain('Attempt HC-01');
    expect(form).toContain('profile cyberbase-rehearsal');
    expect(form).toContain('zero counted independent-owner evidence');
    const operator = JSON.parse(await readFile(paths.operator, 'utf8'));
    expect(operator.repository).toBe('https://github.com/cybersader/cyberbase');
    expect(operator.renderer.profile).toBe('cyberbase-quartz-v4.5.2');
    expect(operator.checkoutDir).toBe('');
    expect(operator.sourcePath).toBe('');
  });

  test('does not strand transitions when an unlocked binding-lock file remains', async () => {
    const workspace = await workspaceRoot();
    const paths = attemptPaths('HC-99', {
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspace,
    });
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.bindingLock, 'abandoned prior-process metadata\n', 'utf8');

    let runs = 0;
    await withAttemptBindingLock(paths, async () => {
      runs += 1;
    });
    await withAttemptBindingLock(paths, async () => {
      runs += 1;
    });

    expect(runs).toBe(2);
    expect((await lstat(paths.bindingLock)).isFile()).toBe(true);

    let active = 0;
    let maxActive = 0;
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => (
      withAttemptBindingLock(paths, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(300);
        active -= 1;
      })
    )));
    expect(maxActive).toBe(1);
    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
    expect(outcomes.some((outcome) => outcome.status === 'rejected')).toBe(true);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected').every(
      (outcome) => outcome.reason.code === 'attempt-binding-busy',
    )).toBe(true);
  });

  test('exposes the canonical series path and dogfood CLI wiring without creating it', async () => {
    const paths = ownerDogfoodSeriesPaths();
    const packageData = JSON.parse(await readFile(
      path.join(PROJECT_ROOT, 'spikes', 'human-correction-dry-run', 'package.json'),
      'utf8',
    ));
    expect(paths.manifest).toBe(path.join(
      PROJECT_ROOT,
      '.workspace',
      'human-correction-pilot',
      'owner-self-dogfood-series.json',
    ));
    expect(packageData.scripts['dogfood:series-init']).toBe(
      'bun run bin/dogfood-series-init.js',
    );
    expect(packageData.bin['cb-correction-dogfood-series-init']).toBe(
      'bin/dogfood-series-init.js',
    );
    expect(packageData.scripts.dogfood).toBe(
      'bun run bin/dogfood.js',
    );
    expect(packageData.bin['cb-correction-dogfood']).toBe(
      'bin/dogfood.js',
    );
    expect(packageData.scripts['dogfood:serve']).toBe(
      'bun run bin/dogfood-serve.js',
    );
    expect(packageData.bin['cb-correction-dogfood-serve']).toBe(
      'bin/dogfood-serve.js',
    );
    expect(packageData.scripts['dogfood:repin']).toBe(
      'bun run bin/dogfood-repin.js',
    );
    expect(packageData.bin['cb-correction-dogfood-repin']).toBe(
      'bin/dogfood-repin.js',
    );
    expect((await lstat(path.join(
      PROJECT_ROOT,
      'spikes',
      'human-correction-dry-run',
      'bin',
      'dogfood-series-init.js',
    ))).isFile()).toBe(true);
    expect((await lstat(path.join(
      PROJECT_ROOT,
      'spikes',
      'human-correction-dry-run',
      'bin',
      'dogfood-serve.js',
    ))).isFile()).toBe(true);
    expect((await lstat(path.join(
      PROJECT_ROOT,
      'spikes',
      'human-correction-dry-run',
      'bin',
      'dogfood-repin.js',
    ))).isFile()).toBe(true);
    expect((await lstat(path.join(
      PROJECT_ROOT,
      'spikes',
      'human-correction-dry-run',
      'bin',
      'dogfood.js',
    ))).isFile()).toBe(true);
  });

  test('creates one non-overwriting ignored owner dogfood series charter', async () => {
    const workspace = await workspaceRoot();
    const paths = ownerDogfoodSeriesPaths({
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspace,
    });
    const result = await initializeSeries(workspace);
    const firstBytes = await readFile(paths.manifest, 'utf8');

    expect(result.manifest).toBe(paths.manifest);
    expect(result.attemptIds).toEqual(['OD-01', 'OD-02', 'OD-03']);
    expect(firstBytes).toBe(stableStringify(dogfoodSeries()));
    expect(await assertIgnoredPath(paths.manifest, PROJECT_ROOT)).toBe(paths.manifest);

    await expect(initializeSeries(workspace, dogfoodSeries({
      plannedSignedOutMobile: {
        ...dogfoodSeries().plannedSignedOutMobile,
        device: 'Changed phone',
      },
    }))).rejects.toMatchObject({ code: 'artifact-already-exists' });
    expect(await readFile(paths.manifest, 'utf8')).toBe(firstBytes);
  });

  test('rejects a series manifest symlinked outside canonical storage', async () => {
    const workspace = await workspaceRoot();
    const paths = ownerDogfoodSeriesPaths({
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspace,
    });
    await initializeSeries(workspace);
    const outside = path.join(await mkdtemp(path.join(os.tmpdir(), 'pilot-series-outside-')), 'series.json');
    cleanup.push(path.dirname(outside));
    await writeFile(outside, stableStringify(dogfoodSeries()), 'utf8');
    await rm(paths.manifest);
    await symlink(outside, paths.manifest, 'file');

    await expect(initializeAttempt({
      attemptId: 'OD-01',
      profile: 'owner-self-dogfood',
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspace,
    })).rejects.toMatchObject({ code: 'workspace-symlink-rejected' });
  });

  test('rejects a non-regular series manifest', async () => {
    const workspace = await workspaceRoot();
    const paths = ownerDogfoodSeriesPaths({
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspace,
    });
    await mkdir(paths.manifest);

    await expect(loadOwnerDogfoodSeries({
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspace,
    })).rejects.toMatchObject({ code: 'dogfood-series-invalid' });
  });

  test('requires a declared OD attempt before checkout inspection or attempt creation', async () => {
    const missingWorkspace = await workspaceRoot();
    const missingPaths = attemptPaths('OD-01', {
      projectRoot: PROJECT_ROOT,
      workspaceRoot: missingWorkspace,
    });
    await expect(initializeAttempt({
      attemptId: 'OD-01',
      profile: 'owner-self-dogfood',
      checkoutDir: '/does/not/exist',
      projectRoot: PROJECT_ROOT,
      workspaceRoot: missingWorkspace,
    })).rejects.toMatchObject({ code: 'dogfood-series-required' });
    await expect(lstat(missingPaths.root)).rejects.toMatchObject({ code: 'ENOENT' });

    const undeclaredWorkspace = await workspaceRoot();
    await initializeSeries(undeclaredWorkspace);
    const undeclaredPaths = attemptPaths('OD-04', {
      projectRoot: PROJECT_ROOT,
      workspaceRoot: undeclaredWorkspace,
    });
    await expect(initializeAttempt({
      attemptId: 'OD-04',
      profile: 'owner-self-dogfood',
      checkoutDir: '/does/not/exist',
      projectRoot: PROJECT_ROOT,
      workspaceRoot: undeclaredWorkspace,
    })).rejects.toMatchObject({ code: 'dogfood-attempt-not-declared' });
    await expect(lstat(undeclaredPaths.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('rejects superseded owner attempts before checkout inspection or artifact creation', async () => {
    const workspace = await workspaceRoot();
    await initializeSeries(workspace);
    for (const attemptId of ['OD-02', 'OD-03']) {
      const paths = attemptPaths(attemptId, { projectRoot: PROJECT_ROOT, workspaceRoot: workspace });
      await expect(initializeAttempt({
        attemptId,
        profile: 'owner-self-dogfood',
        checkoutDir: '/does/not/exist',
        projectRoot: PROJECT_ROOT,
        workspaceRoot: workspace,
      })).rejects.toMatchObject({ code: 'dogfood-attempt-superseded' });
      await expect(lstat(paths.root)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  test('initializes a declared owner self-dogfood attempt and private observation scaffold', async () => {
    const workspace = await workspaceRoot();
    await initializeSeries(workspace);
    const checkout = await cyberbaseCheckout();
    const publicUrl = 'https://cybersader.github.io/cyberbase/guide/';
    const result = await initializeAttempt({
      attemptId: 'OD-01',
      profile: 'owner-self-dogfood',
      checkoutDir: checkout.root,
      sourcePath: 'docs/guide.md',
      publicUrl,
      sourceAuthorization: 'yes',
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspace,
    });
    const paths = attemptPaths('OD-01', { projectRoot: PROJECT_ROOT, workspaceRoot: workspace });
    const form = await readFile(paths.readerForm, 'utf8');
    const observation = JSON.parse(await readFile(paths.dogfoodObservation, 'utf8'));

    expect(result.evidenceClass).toBe('owner-self-dogfood');
    expect(result.countsTowardHumanPilot).toBe(false);
    expect(result.independentOwnerEvidence).toBe(false);
    expect(result.dogfoodObservation).toBe(paths.dogfoodObservation);
    expect(form).toContain('Owner self-dogfood');
    expect(form).toContain('not independent reader or owner validation');
    expect(observation).toMatchObject({
      attemptId: 'OD-01',
      evidenceClass: 'owner-self-dogfood',
      roleSeparation: 'same maintainer, separate reader and owner contexts',
      sourceWritePerformed: false,
      publicDeploymentPerformed: false,
      liveVerificationPerformed: false,
    });
    expect(observation.precommittedObligations).toEqual([
      'normal-correction',
      'signed-out-mobile-handoff',
    ]);
    expect(observation.readerContext).toEqual({
      device: 'Owner phone',
      operatingSystem: 'Mobile OS',
      browser: 'Mobile browser',
      signedIn: false,
    });
    expect(observation.ownerContext).toEqual({
      device: '',
      operatingSystem: '',
      browser: '',
      signedIn: null,
    });
  });

  test('rejects a policy-free Cyberbase prefill before creating the attempt', async () => {
    const workspace = await workspaceRoot();
    const checkout = await cyberbaseCheckout({ publishConfig: false });
    const paths = attemptPaths('HC-06', { projectRoot: PROJECT_ROOT, workspaceRoot: workspace });

    await expect(initializeAttempt({
      attemptId: 'HC-06',
      profile: 'cyberbase-rehearsal',
      checkoutDir: checkout.root,
      sourcePath: 'docs/guide.md',
      publicUrl: 'https://cybersader.github.io/cyberbase/guide/',
      sourceAuthorization: 'yes',
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspace,
    })).rejects.toMatchObject({ code: 'publication-boundary-policy-missing' });
    await expect(lstat(paths.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('prefills a verified Cyberbase rehearsal from one explicit owner mapping', async () => {
    const workspace = await workspaceRoot();
    const checkout = await cyberbaseCheckout();
    const publicUrl = 'https://cybersader.github.io/cyberbase/guide/';
    const result = await initializeAttempt({
      attemptId: 'HC-06',
      profile: 'cyberbase-rehearsal',
      checkoutDir: checkout.root,
      sourcePath: 'docs/guide.md',
      publicUrl,
      sourceAuthorization: 'yes',
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspace,
    });
    const paths = attemptPaths('HC-06', { projectRoot: PROJECT_ROOT, workspaceRoot: workspace });
    const operator = JSON.parse(await readFile(paths.operator, 'utf8'));

    expect(result.operatorPrefilled).toBe(true);
    expect(result.readerForm).toBe(paths.readerForm);
    expect(result.submission).toBe(paths.submission);
    expect(result.operator).toBe(paths.operator);
    expect(operator.repository).toBe('https://github.com/cybersader/cyberbase');
    expect(operator.checkoutDir).toBe(checkout.root);
    expect(operator.baseCommit).toBe(checkout.head);
    expect(operator.sourcePath).toBe('docs/guide.md');
    expect(operator.publicUrl).toBe(publicUrl);
    expect(operator.sourceAuthorizedForLocalProcessing).toBe(true);
    expect(operator.profile).toBe('cyberbase-rehearsal');
    expect(operator.renderer.profile).toBe('cyberbase-quartz-v4.5.2');
    await expect(lstat(paths.submission)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('fails closed on incomplete, unauthorized, non-rehearsal, or invalid Cyberbase prefills', async () => {
    const workspace = await workspaceRoot();
    const checkout = await cyberbaseCheckout();
    const common = {
      checkoutDir: checkout.root,
      sourcePath: 'docs/guide.md',
      publicUrl: 'https://cybersader.github.io/cyberbase/guide/',
      sourceAuthorization: 'yes',
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspace,
    };

    await expect(initializeAttempt({
      attemptId: 'HC-07', profile: 'cyberbase-rehearsal', checkoutDir: checkout.root,
      projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    })).rejects.toMatchObject({ code: 'incomplete-cyberbase-prefill' });
    await expect(initializeAttempt({
      attemptId: 'HC-07', profile: 'cyberbase-rehearsal', ...common, sourceAuthorization: 'true',
    })).rejects.toMatchObject({ code: 'source-authorization-required' });
    await expect(initializeAttempt({
      attemptId: 'HC-07', profile: 'independent-counted', ...common,
    })).rejects.toMatchObject({ code: 'cyberbase-prefill-profile-mismatch' });
    await expect(initializeAttempt({
      attemptId: 'HC-07', profile: 'cyberbase-rehearsal', ...common, sourcePath: 'docs/guide.txt',
    })).rejects.toMatchObject({ code: 'non-markdown-source' });
    await expect(initializeAttempt({
      attemptId: 'HC-07', profile: 'cyberbase-rehearsal', ...common, checkoutDir: path.join(checkout.root, 'docs'),
    })).rejects.toMatchObject({ code: 'checkout-not-repository-root' });

    const wrongOrigin = await cyberbaseCheckout();
    await command(['git', 'remote', 'set-url', 'origin', 'https://example.org/owner/not-cyberbase.git'], wrongOrigin.root);
    await expect(initializeAttempt({
      attemptId: 'HC-07', profile: 'cyberbase-rehearsal', ...common, checkoutDir: wrongOrigin.root,
    })).rejects.toMatchObject({ code: 'checkout-repository-mismatch' });

    const ignoredSource = await cyberbaseCheckout();
    await writeFile(path.join(ignoredSource.root, '.gitignore'), 'docs/untracked.md\n', 'utf8');
    await command(['git', 'add', '.gitignore'], ignoredSource.root);
    await command(['git', 'commit', '-q', '-m', 'ignore local source'], ignoredSource.root);
    await writeFile(path.join(ignoredSource.root, 'docs', 'untracked.md'), '# Ignored\n', 'utf8');
    await expect(initializeAttempt({
      attemptId: 'HC-07', profile: 'cyberbase-rehearsal', ...common,
      checkoutDir: ignoredSource.root, sourcePath: 'docs/untracked.md',
    })).rejects.toMatchObject({ code: 'source-not-version-controlled' });

    await writeFile(path.join(checkout.root, 'dirty.txt'), 'dirty\n', 'utf8');
    await expect(initializeAttempt({
      attemptId: 'HC-07', profile: 'cyberbase-rehearsal', ...common,
    })).rejects.toMatchObject({ code: 'checkout-not-clean' });

    const failedPaths = attemptPaths('HC-08', { projectRoot: PROJECT_ROOT, workspaceRoot: workspace });
    const recorded = await recordPilotError({
      attemptId: 'HC-08',
      error: { code: 'incomplete-cyberbase-prefill', message: 'test failure' },
      attemptScoped: false,
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspace,
    });
    expect(recorded.attemptId).toBe('HC-08');
    expect(recorded.log).toContain(path.join(workspace, 'logs'));
    await expect(lstat(failedPaths.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('independent initialization guesses no repository, checkout, mapping, pin, URL, or build command', async () => {
    const workspace = await workspaceRoot();
    await initializeAttempt({
      attemptId: 'HC-02',
      profile: 'independent-counted',
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspace,
    });
    const paths = attemptPaths('HC-02', { projectRoot: PROJECT_ROOT, workspaceRoot: workspace });
    const operator = JSON.parse(await readFile(paths.operator, 'utf8'));
    expect(operator.repository).toBe('');
    expect(operator.checkoutDir).toBe('');
    expect(operator.baseCommit).toBe('');
    expect(operator.sourcePath).toBe('');
    expect(operator.publicUrl).toBe('');
    expect(operator.renderer.profile).toBe('owner-static-output');
    expect(operator.renderer.buildCommand).toBe('');
  });

  test('rejects invalid IDs, existing attempts, destinations outside ignored storage, and symlinked components', async () => {
    const workspace = await workspaceRoot();
    await expect(initializeAttempt({
      attemptId: 'reader-1',
      profile: 'independent-counted',
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspace,
    })).rejects.toMatchObject({ code: 'invalid-attempt-id' });

    await initializeAttempt({
      attemptId: 'HC-03',
      profile: 'independent-counted',
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspace,
    });
    await expect(initializeAttempt({
      attemptId: 'HC-03',
      profile: 'independent-counted',
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspace,
    })).rejects.toMatchObject({ code: 'attempt-already-exists' });

    const outside = await mkdtemp(path.join(os.tmpdir(), 'pilot-outside-ignore-'));
    cleanup.push(outside);
    await expect(initializeAttempt({
      attemptId: 'HC-04',
      profile: 'independent-counted',
      projectRoot: PROJECT_ROOT,
      workspaceRoot: outside,
    })).rejects.toMatchObject({ code: 'workspace-path-outside-project' });
    await expect(initializeOwnerDogfoodSeries({
      charter: dogfoodSeries(),
      projectRoot: PROJECT_ROOT,
      workspaceRoot: outside,
    })).rejects.toMatchObject({ code: 'workspace-path-outside-project' });

    const symlinkTarget = await mkdtemp(path.join(os.tmpdir(), 'pilot-symlink-target-'));
    cleanup.push(symlinkTarget);
    const linkedWorkspace = path.join(PROJECT_ROOT, '.workspace', `pilot-linked-${Date.now()}`);
    await mkdir(path.dirname(linkedWorkspace), { recursive: true });
    await symlink(symlinkTarget, linkedWorkspace, 'dir');
    cleanup.push(linkedWorkspace);
    await expect(initializeAttempt({
      attemptId: 'HC-05',
      profile: 'independent-counted',
      projectRoot: PROJECT_ROOT,
      workspaceRoot: linkedWorkspace,
    })).rejects.toMatchObject({ code: 'workspace-symlink-rejected' });
    await expect(initializeOwnerDogfoodSeries({
      charter: dogfoodSeries(),
      projectRoot: PROJECT_ROOT,
      workspaceRoot: linkedWorkspace,
    })).rejects.toMatchObject({ code: 'workspace-symlink-rejected' });
  });
});
