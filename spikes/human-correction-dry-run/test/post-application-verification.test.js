import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyCorrection, prepareCorrection } from '@cyberbaser/correction';
import { caseId, stableStringify } from '../src/case.js';
import { convertPilotSubmission } from '../src/pilot-input.js';
import {
  attemptPaths,
  initializeAttempt,
  initializeOwnerDogfoodSeries,
} from '../src/pilot-workspace.js';
import {
  readOnlyGitEnvironment,
  verifyPostApplicationLive,
} from '../src/post-application-verification.js';

const PROJECT_ROOT = path.resolve(import.meta.dir, '../../..');
const PACKAGE_ROOT = path.join(PROJECT_ROOT, 'spikes', 'human-correction-dry-run');
const SOURCE_PATH = 'docs/guide.md';
const PUBLIC_URL = 'https://cybersader.github.io/cyberbase/guide/';
const QUOTE = 'Owner-selected sentence.';
const REPLACEMENT = 'Owner-selected sentence corrected.';
const RUN_ID = '30642646520';
const cleanup = [];

async function command(args, cwd) {
  const child = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${args.join(' ')} failed: ${stderr || stdout}`);
  return stdout.trim();
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function dogfoodSeries() {
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
  };
}

function submission() {
  return {
    schemaVersion: 1,
    instrumentVersion: 'reader-form-v2',
    attemptId: 'OD-01',
    openedAt: '2026-07-31T00:00:00.000Z',
    submittedAt: '2026-07-31T00:01:00.000Z',
    elapsedMs: 60_000,
    pageUrl: PUBLIC_URL,
    exactQuote: QUOTE,
    replacement: REPLACEMENT,
    rationale: 'Correct the sentence.',
    factualSource: 'not applicable',
    publicCreditName: '',
    creditConsent: 'no',
  };
}

function response({ status = 200, url = '', json, body = '', headers = {} } = {}) {
  const isJson = json !== undefined;
  const payload = isJson ? JSON.stringify(json) : body;
  const responseHeaders = new Headers({
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    ...headers,
  });
  return {
    status,
    url,
    headers: responseHeaders,
    get body() { return new Response(payload).body; },
  };
}

function runJson(commit, overrides = {}) {
  return {
    id: Number(RUN_ID),
    name: 'Publish vault site',
    path: '.github/workflows/publish-site.yml',
    head_branch: 'main',
    head_sha: commit,
    event: 'push',
    workflow_id: 320496062,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    html_url: `https://github.com/cybersader/cyberbase/actions/runs/${RUN_ID}`,
    ...overrides,
  };
}

function injectedRemote({
  commit,
  github = [],
  workflow = [],
  jobs = [],
  deployments = [],
  statuses = [],
  pages = [],
  start = Date.parse('2026-07-31T12:00:00.000Z'),
  retryIntervalMs = 1_000,
} = {}) {
  let now = start;
  const calls = { github: [], public: [], sleeps: [] };
  const workflowId = 320496062;
  const buildJobUrl = `https://github.com/cybersader/cyberbase/actions/runs/${RUN_ID}/job/1`;
  const deployJobUrl = `https://github.com/cybersader/cyberbase/actions/runs/${RUN_ID}/job/2`;
  const successfulRun = response({ json: runJson(commit, { workflow_id: workflowId }) });
  const successfulWorkflow = response({
    json: {
      id: workflowId,
      name: 'Publish vault site',
      path: '.github/workflows/publish-site.yml',
      state: 'active',
    },
  });
  const successfulJobs = response({
    json: {
      total_count: 2,
      jobs: [
        {
          id: 1,
          run_id: Number(RUN_ID),
          run_attempt: 1,
          workflow_name: 'Publish vault site',
          head_branch: 'main',
          head_sha: commit,
          html_url: buildJobUrl,
          name: 'build',
          status: 'completed',
          conclusion: 'success',
        },
        {
          id: 2,
          run_id: Number(RUN_ID),
          run_attempt: 1,
          workflow_name: 'Publish vault site',
          head_branch: 'main',
          head_sha: commit,
          html_url: deployJobUrl,
          name: 'deploy',
          status: 'completed',
          conclusion: 'success',
        },
      ],
    },
  });
  const successfulDeployments = response({
    json: [{
      id: 10,
      task: 'deploy',
      original_environment: 'github-pages',
      environment: 'github-pages',
      sha: commit,
      ref: 'main',
      performed_via_github_app: { slug: 'github-actions' },
    }],
  });
  const successfulStatuses = response({
    json: [{
      state: 'success',
      environment: 'github-pages',
      target_url: deployJobUrl,
      log_url: deployJobUrl,
      environment_url: 'https://cybersader.github.io/cyberbase/',
    }],
  });
  const successfulPage = response({
    url: PUBLIC_URL,
    body: `<!doctype html><html><body><p>${REPLACEMENT}</p></body></html>`,
  });
  const githubQueue = [...github];
  const workflowQueue = [...workflow];
  const jobsQueue = [...jobs];
  const deploymentQueue = [...deployments];
  const statusQueue = [...statuses];
  const pageQueue = [...pages];
  return {
    calls,
    dependencies: {
      retryIntervalMs,
      clock: () => now,
      async sleep(milliseconds) {
        calls.sleeps.push(milliseconds);
        now += milliseconds;
      },
      async githubFetch(url, options) {
        calls.github.push({ url, options });
        if (url.includes('/jobs?')) {
          return jobsQueue.length > 0 ? jobsQueue.shift() : successfulJobs;
        }
        if (url.includes('/actions/workflows/')) {
          return workflowQueue.length > 0 ? workflowQueue.shift() : successfulWorkflow;
        }
        if (url.includes('/deployments?')) {
          return deploymentQueue.length > 0 ? deploymentQueue.shift() : successfulDeployments;
        }
        if (url.includes('/deployments/') && url.includes('/statuses?')) {
          return statusQueue.length > 0 ? statusQueue.shift() : successfulStatuses;
        }
        return githubQueue.length > 0 ? githubQueue.shift() : successfulRun;
      },
      async publicFetch(url, options) {
        calls.public.push({ url, options });
        return pageQueue.length > 0 ? pageQueue.shift() : successfulPage;
      },
    },
  };
}

async function createCheckout() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'post-application-git-'));
  cleanup.push(root);
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, SOURCE_PATH), `# Guide\n\n${QUOTE}\n`, 'utf8');
  await writeFile(path.join(root, 'publish.yml'), 'allow:\n  - "docs/**"\n', 'utf8');
  for (const args of [
    ['git', 'init', '-q'],
    ['git', 'config', 'user.email', 'test@example.org'],
    ['git', 'config', 'user.name', 'Test User'],
    ['git', 'add', '.'],
    ['git', 'commit', '-q', '-m', 'baseline'],
    ['git', 'remote', 'add', 'origin', 'https://github.com/cybersader/cyberbase.git'],
  ]) await command(args, root);
  return root;
}

async function createFixture({
  decision = 'accept',
  decisionOverrides = {},
  evaluationOverrides = {},
  application = 'exact',
} = {}) {
  const workspaceRoot = await mkdtemp(path.join(PROJECT_ROOT, '.workspace', 'post-application-test-'));
  cleanup.push(workspaceRoot);
  const checkoutDir = await createCheckout();
  const baseCommit = await command(['git', 'rev-parse', 'HEAD'], checkoutDir);
  await initializeOwnerDogfoodSeries({
    charter: dogfoodSeries(),
    projectRoot: PROJECT_ROOT,
    workspaceRoot,
  });
  await initializeAttempt({
    attemptId: 'OD-01',
    profile: 'owner-self-dogfood',
    checkoutDir,
    sourcePath: SOURCE_PATH,
    publicUrl: PUBLIC_URL,
    sourceAuthorization: 'yes',
    projectRoot: PROJECT_ROOT,
    workspaceRoot,
  });
  const paths = attemptPaths('OD-01', { projectRoot: PROJECT_ROOT, workspaceRoot });
  const input = submission();
  await writeFile(paths.submission, stableStringify(input), 'utf8');
  const operator = JSON.parse(await readFile(paths.operator, 'utf8'));
  const caseData = convertPilotSubmission(input, operator);
  const mechanicalCaseId = caseId(caseData);
  const baselineBytes = await readFile(path.join(checkoutDir, SOURCE_PATH));
  const prepared = prepareCorrection(baselineBytes, {
    selector: { quote: QUOTE },
    replacement: REPLACEMENT,
  });
  const exactCandidate = applyCorrection(baselineBytes, prepared);
  const runDir = path.join(paths.runs, mechanicalCaseId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'evaluation.json'), stableStringify({
    artifactType: 'private-no-write-correction-evaluation',
    schemaVersion: 1,
    caseId: mechanicalCaseId,
    base: { digest: prepared.baseDigest },
    candidate: { digest: prepared.candidateDigest },
    source: {
      baseCommit,
      repositoryRelativePath: SOURCE_PATH,
    },
    noWrite: {
      candidateExistsInMemoryOnly: true,
      sourceBytesUnchangedAfterEvaluation: true,
      sourceWritePerformed: false,
    },
    ...evaluationOverrides,
  }), 'utf8');
  const validatedDecision = {
    artifactType: 'private-validated-owner-self-dogfood-decision',
    schemaVersion: 2,
    attemptId: 'OD-01',
    mechanicalCaseId,
    candidateDigest: prepared.candidateDigest,
    decision,
    reason: decision === 'accept' ? 'Accept the bounded correction.' : 'Reject the bounded correction.',
    reviewSeconds: 30,
    decidedAt: '2026-07-31T00:02:00.000Z',
    countsTowardPilot: false,
    evidenceClass: 'owner-self-dogfood',
    countsTowardHumanPilot: false,
    independentOwnerEvidence: false,
    claimBoundary: 'maintainer operational and mechanical evidence only',
    ownerDecisionEligibleAtValidation: true,
    sourceWritePerformed: false,
    publicDeploymentPerformed: false,
    ...decisionOverrides,
  };
  await writeFile(
    path.join(runDir, 'validated-owner-decision.json'),
    stableStringify(validatedDecision),
    'utf8',
  );

  let applicationCommit;
  if (application === 'merge') {
    const originalBranch = await command(['git', 'branch', '--show-current'], checkoutDir);
    await command(['git', 'checkout', '-q', '-b', 'side'], checkoutDir);
    await writeFile(path.join(checkoutDir, 'side.txt'), 'side branch\n', 'utf8');
    await command(['git', 'add', 'side.txt'], checkoutDir);
    await command(['git', 'commit', '-q', '-m', 'side'], checkoutDir);
    await command(['git', 'checkout', '-q', originalBranch], checkoutDir);
    await writeFile(path.join(checkoutDir, SOURCE_PATH), exactCandidate);
    await command(['git', 'add', SOURCE_PATH], checkoutDir);
    await command(['git', 'commit', '-q', '-m', 'apply correction'], checkoutDir);
    await command(['git', 'merge', '-q', '--no-ff', 'side', '-m', 'merge side'], checkoutDir);
    applicationCommit = await command(['git', 'rev-parse', 'HEAD'], checkoutDir);
  } else {
    if (application === 'advanced-parent') {
      await writeFile(path.join(checkoutDir, 'revision.txt'), 'intermediate revision\n', 'utf8');
      await command(['git', 'add', 'revision.txt'], checkoutDir);
      await command(['git', 'commit', '-q', '-m', 'intermediate'], checkoutDir);
    }
    const applicationBytes = application === 'tampered'
      ? Buffer.concat([exactCandidate, Buffer.from('\nUndeclared change.\n')])
      : exactCandidate;
    await writeFile(path.join(checkoutDir, SOURCE_PATH), applicationBytes);
    if (application === 'extra-path') {
      await writeFile(path.join(checkoutDir, 'extra.txt'), 'extra change\n', 'utf8');
    }
    await command(['git', 'add', '-A'], checkoutDir);
    await command(['git', 'commit', '-q', '-m', 'apply correction'], checkoutDir);
    applicationCommit = await command(['git', 'rev-parse', 'HEAD'], checkoutDir);
  }

  return {
    workspaceRoot,
    checkoutDir,
    baseCommit,
    applicationCommit,
    paths,
    runDir,
    artifactPath: path.join(runDir, 'post-application-live-verification.json'),
    validatedDecisionPath: path.join(runDir, 'validated-owner-decision.json'),
    validatedDecision,
    prepared,
  };
}

async function verify(fixture, dependencies, overrides = {}) {
  return verifyPostApplicationLive({
    attemptId: 'OD-01',
    checkoutDir: fixture.checkoutDir,
    applicationCommit: fixture.applicationCommit,
    deploymentRunId: RUN_ID,
    waitSeconds: '5',
    projectRoot: PROJECT_ROOT,
    workspaceRoot: fixture.workspaceRoot,
    ...overrides,
  }, dependencies);
}

async function expectFailure(fixture, dependencies, code, overrides = {}) {
  await expect(verify(fixture, dependencies, overrides)).rejects.toMatchObject({ code });
  expect(await exists(fixture.artifactPath)).toBe(false);
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('read-only post-application and live verification', () => {
  test('reconstructs the exact Git splice, waits for deployment and publication, then creates one private artifact', async () => {
    const fixture = await createFixture();
    const observationBefore = await readFile(fixture.paths.dogfoodObservation);
    const sourceBefore = await readFile(path.join(fixture.checkoutDir, SOURCE_PATH));
    const statusBefore = await command(['git', 'status', '--porcelain=v1', '--untracked-files=all'], fixture.checkoutDir);
    const remote = injectedRemote({
      commit: fixture.applicationCommit,
      github: [response({
        json: runJson(fixture.applicationCommit, {
          status: 'in_progress',
          conclusion: null,
        }),
      })],
      pages: [response({ url: PUBLIC_URL, body: `<!doctype html><p>${QUOTE}</p>` })],
    });

    const result = await verify(fixture, remote.dependencies);

    expect(result.application).toMatchObject({
      commit: fixture.applicationCommit,
      parentCommit: fixture.baseCommit,
      singleParent: true,
      changedSourcePaths: [SOURCE_PATH],
      parentBaselineDigest: fixture.prepared.baseDigest,
      acceptedCandidateDigest: fixture.prepared.candidateDigest,
      committedCandidateDigest: fixture.prepared.candidateDigest,
      exactSplice: {
        prefixIdentical: true,
        suffixIdentical: true,
        committedBytesEqualReconstruction: true,
      },
    });
    expect(result.deployment).toMatchObject({
      runId: RUN_ID,
      headSha: fixture.applicationCommit,
      status: 'completed',
      conclusion: 'success',
      attempts: 2,
      workflow: {
        id: '320496062',
        name: 'Publish vault site',
        path: '.github/workflows/publish-site.yml',
        state: 'active',
      },
      jobs: {
        totalCount: 2,
        allSuccessful: true,
      },
      environment: {
        environment: 'github-pages',
        task: 'deploy',
        state: 'success',
        runId: RUN_ID,
      },
    });
    expect(result.live).toMatchObject({
      publicUrl: PUBLIC_URL,
      expectedOrigin: 'https://cybersader.github.io',
      status: 200,
      oldTextAbsent: true,
      replacementPresent: true,
      attempts: 2,
    });
    expect(result.noMutation).toEqual({
      gitMutationPerformed: false,
      sourceWritePerformed: false,
      remoteMutationPerformed: false,
      deploymentTriggered: false,
      observationEdited: false,
      onlyArtifactCreated: 'post-application-live-verification.json',
    });
    expect(remote.calls.sleeps).toEqual([1_000, 1_000]);
    expect(remote.calls.github[0].url).toBe(
      `https://api.github.com/repos/cybersader/cyberbase/actions/runs/${RUN_ID}`,
    );
    expect(remote.calls.public.every((call) => call.url === PUBLIC_URL)).toBe(true);
    expect(remote.calls.public.every(
      (call) => call.options.headers['Cache-Control'] === 'no-cache, no-store, max-age=0',
    )).toBe(true);
    expect(await exists(fixture.artifactPath)).toBe(true);
    const stored = JSON.parse(await readFile(fixture.artifactPath, 'utf8'));
    expect(stored.artifactType).toBe('private-post-application-live-verification');
    expect(stored.application.commit).toBe(fixture.applicationCommit);
    expect((await readFile(path.join(fixture.checkoutDir, SOURCE_PATH))).equals(sourceBefore)).toBe(true);
    expect(await readFile(fixture.paths.dogfoodObservation)).toEqual(observationBefore);
    expect(await command(['git', 'status', '--porcelain=v1', '--untracked-files=all'], fixture.checkoutDir)).toBe(statusBefore);
  });

  test('preserves the first successful artifact and rejects a second creation', async () => {
    const fixture = await createFixture();
    const firstRemote = injectedRemote({ commit: fixture.applicationCommit });
    await verify(fixture, firstRemote.dependencies);
    const firstBytes = await readFile(fixture.artifactPath);
    const secondRemote = injectedRemote({ commit: fixture.applicationCommit });
    await expect(verify(fixture, secondRemote.dependencies)).rejects.toMatchObject({
      code: 'artifact-already-exists',
    });
    expect((await readFile(fixture.artifactPath)).equals(firstBytes)).toBe(true);
  });

  test('rejects a submission version that does not match the issued form bytes', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.paths.submission, stableStringify({
      ...submission(),
      instrumentVersion: 'reader-form-v1',
    }), 'utf8');
    const remote = injectedRemote({ commit: fixture.applicationCommit });
    await expectFailure(
      fixture,
      remote.dependencies,
      'submission-instrument-version-mismatch',
    );
    expect(remote.calls.github).toHaveLength(0);
  });

  test('requires a validated accept before any GitHub or public fetch', async () => {
    const fixture = await createFixture({ decision: 'reject' });
    const remote = injectedRemote({ commit: fixture.applicationCommit });
    await expectFailure(fixture, remote.dependencies, 'validated-accept-required');
    expect(remote.calls.github).toHaveLength(0);
    expect(remote.calls.public).toHaveLength(0);
  });

  test('rejects a validated decision whose pre-application boundary was altered', async () => {
    const fixture = await createFixture({ decisionOverrides: { sourceWritePerformed: true } });
    const remote = injectedRemote({ commit: fixture.applicationCommit });
    await expectFailure(fixture, remote.dependencies, 'validated-accept-required');
    expect(remote.calls.github).toHaveLength(0);
  });

  test('rejects a merge application commit', async () => {
    const fixture = await createFixture({ application: 'merge' });
    const remote = injectedRemote({ commit: fixture.applicationCommit });
    await expectFailure(fixture, remote.dependencies, 'application-commit-not-single-parent');
  });

  test('rejects an application commit that changes another path', async () => {
    const fixture = await createFixture({ application: 'extra-path' });
    const remote = injectedRemote({ commit: fixture.applicationCommit });
    await expectFailure(fixture, remote.dependencies, 'application-changed-path-mismatch');
  });

  test('requires the application parent to be the validated base commit', async () => {
    const fixture = await createFixture({ application: 'advanced-parent' });
    const remote = injectedRemote({ commit: fixture.applicationCommit });
    await expectFailure(fixture, remote.dependencies, 'application-parent-base-mismatch');
  });

  test('rejects source bytes containing any undeclared change outside the accepted splice', async () => {
    const fixture = await createFixture({ application: 'tampered' });
    const remote = injectedRemote({ commit: fixture.applicationCommit });
    await expectFailure(fixture, remote.dependencies, 'application-candidate-bytes-mismatch');
  });

  test('binds the application parent digest to the reviewed no-write baseline', async () => {
    const fixture = await createFixture({
      evaluationOverrides: {
        base: { digest: 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:' },
      },
    });
    const remote = injectedRemote({ commit: fixture.applicationCommit });
    await expectFailure(
      fixture,
      remote.dependencies,
      'application-parent-baseline-digest-mismatch',
    );
  });

  test('binds the reconstructed candidate digest to the validated decision', async () => {
    const fixture = await createFixture({
      decisionOverrides: {
        candidateDigest: 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:',
      },
    });
    const remote = injectedRemote({ commit: fixture.applicationCommit });
    await expectFailure(fixture, remote.dependencies, 'validated-evaluation-candidate-mismatch');
  });

  test('requires the explicit GitHub Actions run head SHA to equal the application commit', async () => {
    const fixture = await createFixture();
    const remote = injectedRemote({
      commit: fixture.applicationCommit,
      github: [response({
        json: runJson('f'.repeat(40)),
      })],
    });
    await expectFailure(fixture, remote.dependencies, 'deployment-run-head-mismatch');
    expect(remote.calls.public).toHaveLength(0);
  });

  test('binds the run to the exact publication workflow, push event, and main branch', async () => {
    const fixture = await createFixture();
    const remote = injectedRemote({
      commit: fixture.applicationCommit,
      github: [response({
        json: runJson(fixture.applicationCommit, {
          path: '.github/workflows/unrelated.yml',
        }),
      })],
    });
    await expectFailure(fixture, remote.dependencies, 'deployment-run-identity-mismatch');
  });

  test('binds the run workflow ID to the active publication workflow metadata', async () => {
    const fixture = await createFixture();
    const remote = injectedRemote({
      commit: fixture.applicationCommit,
      workflow: [response({
        json: {
          id: 320496062,
          name: 'Unrelated workflow',
          path: '.github/workflows/publish-site.yml',
          state: 'active',
        },
      })],
    });
    await expectFailure(fixture, remote.dependencies, 'deployment-workflow-identity-mismatch');
  });

  test('rejects a completed deployment run without a success conclusion', async () => {
    const fixture = await createFixture();
    const remote = injectedRemote({
      commit: fixture.applicationCommit,
      github: [response({
        json: runJson(fixture.applicationCommit, { conclusion: 'failure' }),
      })],
    });
    await expectFailure(fixture, remote.dependencies, 'deployment-run-not-successful');
  });

  test('requires every job in the successful deployment run to succeed', async () => {
    const fixture = await createFixture();
    const remote = injectedRemote({
      commit: fixture.applicationCommit,
      jobs: [response({
        json: {
          total_count: 2,
          jobs: [
            {
              id: 1,
              run_id: Number(RUN_ID),
              run_attempt: 1,
              workflow_name: 'Publish vault site',
              head_branch: 'main',
              head_sha: fixture.applicationCommit,
              html_url: `https://github.com/cybersader/cyberbase/actions/runs/${RUN_ID}/job/1`,
              name: 'build',
              status: 'completed',
              conclusion: 'success',
            },
            {
              id: 2,
              run_id: Number(RUN_ID),
              run_attempt: 1,
              workflow_name: 'Publish vault site',
              head_branch: 'main',
              head_sha: fixture.applicationCommit,
              html_url: `https://github.com/cybersader/cyberbase/actions/runs/${RUN_ID}/job/2`,
              name: 'deploy',
              status: 'completed',
              conclusion: 'failure',
            },
          ],
        },
      })],
    });
    await expectFailure(fixture, remote.dependencies, 'deployment-job-not-successful');
    expect(remote.calls.public).toHaveLength(0);
  });

  test('requires exactly the expected build and deploy jobs', async () => {
    const fixture = await createFixture();
    const remote = injectedRemote({
      commit: fixture.applicationCommit,
      jobs: [response({
        json: {
          total_count: 1,
          jobs: [{
            id: 1,
            run_id: Number(RUN_ID),
            run_attempt: 1,
            workflow_name: 'Publish vault site',
            head_branch: 'main',
            head_sha: fixture.applicationCommit,
            html_url: `https://github.com/cybersader/cyberbase/actions/runs/${RUN_ID}/job/1`,
            name: 'build',
            status: 'completed',
            conclusion: 'success',
          }],
        },
      })],
    });
    await expectFailure(fixture, remote.dependencies, 'deployment-jobs-identity-mismatch');
  });

  test('binds a successful github-pages deployment to the deploy job and public origin', async () => {
    const fixture = await createFixture();
    const wrongStatus = response({
      json: [{
        state: 'success',
        environment: 'github-pages',
        target_url: `https://github.com/cybersader/cyberbase/actions/runs/${RUN_ID}/job/999`,
        log_url: `https://github.com/cybersader/cyberbase/actions/runs/${RUN_ID}/job/999`,
        environment_url: 'https://cybersader.github.io/cyberbase/',
      }],
    });
    const remote = injectedRemote({
      commit: fixture.applicationCommit,
      statuses: [wrongStatus, wrongStatus, wrongStatus],
      retryIntervalMs: 1_000,
    });
    await expectFailure(
      fixture,
      remote.dependencies,
      'deployment-environment-timeout',
      { waitSeconds: '2' },
    );
    expect(remote.calls.public).toHaveLength(0);
  });

  test('rejects a public-page redirect to a different origin', async () => {
    const fixture = await createFixture();
    const remote = injectedRemote({
      commit: fixture.applicationCommit,
      pages: [response({
        url: 'https://example.invalid/cyberbase/guide/',
        body: REPLACEMENT,
      })],
    });
    await expectFailure(fixture, remote.dependencies, 'public-page-origin-mismatch');
  });

  test('rejects a same-origin redirect to another page path', async () => {
    const fixture = await createFixture();
    const remote = injectedRemote({
      commit: fixture.applicationCommit,
      pages: [response({
        url: 'https://cybersader.github.io/cyberbase/another-page/',
        body: `<!doctype html><p>${REPLACEMENT}</p>`,
      })],
    });
    await expectFailure(fixture, remote.dependencies, 'public-page-location-mismatch');
  });

  test('requires an HTML content type from the exact public page', async () => {
    const fixture = await createFixture();
    const remote = injectedRemote({
      commit: fixture.applicationCommit,
      pages: [response({
        url: PUBLIC_URL,
        body: JSON.stringify({ message: REPLACEMENT }),
        headers: { 'Content-Type': 'application/json' },
      })],
    });
    await expectFailure(fixture, remote.dependencies, 'public-page-content-type-mismatch');
  });

  test('checks rendered page text rather than script or markup bytes', async () => {
    const fixture = await createFixture();
    const hiddenOnly = response({
      url: PUBLIC_URL,
      body: `<!doctype html><html><head><title>${REPLACEMENT}</title></head><body><script>${REPLACEMENT}</script><p hidden>${REPLACEMENT}</p><p>Unrelated text.</p></body></html>`,
    });
    const remote = injectedRemote({
      commit: fixture.applicationCommit,
      pages: [hiddenOnly, hiddenOnly],
      retryIntervalMs: 1_000,
    });
    await expectFailure(
      fixture,
      remote.dependencies,
      'public-page-timeout',
      { waitSeconds: '1' },
    );
  });

  test('rejects an oversized public HTML response before scanning it', async () => {
    const fixture = await createFixture();
    const remote = injectedRemote({
      commit: fixture.applicationCommit,
      pages: [response({
        url: PUBLIC_URL,
        body: `<!doctype html><p>${'x'.repeat(4 * 1024 * 1024)}</p>`,
      })],
    });
    await expectFailure(fixture, remote.dependencies, 'public-page-response-too-large');
  });

  test('bounds a stalled public response with an abort signal', async () => {
    const fixture = await createFixture();
    const remote = injectedRemote({ commit: fixture.applicationCommit });
    remote.dependencies.publicFetch = async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted by deadline')), { once: true });
    });
    await expectFailure(
      fixture,
      remote.dependencies,
      'public-page-timeout',
      { waitSeconds: '1' },
    );
  }, 5_000);

  test('bounds retries when the public page keeps the old text or omits the replacement', async () => {
    const fixture = await createFixture();
    const stale = response({
      url: PUBLIC_URL,
      body: `<!doctype html><p>${QUOTE}</p>`,
    });
    const remote = injectedRemote({
      commit: fixture.applicationCommit,
      pages: [stale, stale, stale, stale],
      retryIntervalMs: 1_000,
    });
    await expectFailure(fixture, remote.dependencies, 'public-page-timeout', { waitSeconds: '2' });
    expect(remote.calls.public).toHaveLength(2);
    expect(remote.calls.sleeps).toEqual([1_000, 1_000]);
  });

  test('bounds retries when GitHub keeps reporting an in-progress run', async () => {
    const fixture = await createFixture();
    const pending = () => response({
      json: runJson(fixture.applicationCommit, {
        status: 'in_progress',
        conclusion: null,
      }),
    });
    const remote = injectedRemote({
      commit: fixture.applicationCommit,
      github: [pending(), pending(), pending(), pending()],
      retryIntervalMs: 1_000,
    });
    await expectFailure(fixture, remote.dependencies, 'deployment-run-timeout', { waitSeconds: '2' });
    expect(remote.calls.github).toHaveLength(2);
    expect(remote.calls.public).toHaveLength(0);
  });

  test('rejects an oversized GitHub response before parsing it', async () => {
    const fixture = await createFixture();
    const remote = injectedRemote({
      commit: fixture.applicationCommit,
      github: [response({
        body: 'x'.repeat(2 * 1024 * 1024 + 1),
        headers: { 'Content-Type': 'application/json' },
      })],
    });
    await expectFailure(fixture, remote.dependencies, 'deployment-run-response-too-large');
  });

  test('disables optional locks and lazy promisor-object fetching for Git inspection', () => {
    expect(readOnlyGitEnvironment({ SENTINEL: 'preserved' })).toEqual({
      SENTINEL: 'preserved',
      GIT_NO_LAZY_FETCH: '1',
      GIT_OPTIONAL_LOCKS: '0',
    });
  });

  test('accepts a different checkout of the validated repository when it contains the bound objects', async () => {
    const fixture = await createFixture();
    const cloneParent = await mkdtemp(path.join(os.tmpdir(), 'post-application-clone-'));
    cleanup.push(cloneParent);
    const clone = path.join(cloneParent, 'checkout');
    await command(['git', 'clone', '-q', fixture.checkoutDir, clone], cloneParent);
    await command(['git', 'remote', 'set-url', 'origin', 'https://github.com/cybersader/cyberbase.git'], clone);
    const remote = injectedRemote({ commit: fixture.applicationCommit });
    const result = await verify(fixture, remote.dependencies, { checkoutDir: clone });
    expect(result.application.commit).toBe(fixture.applicationCommit);
    expect(result.sourceCheckout.checkoutDir).toBe(await realpath(clone));
  });

  test('rejects an explicit checkout from another repository', async () => {
    const fixture = await createFixture();
    const remote = injectedRemote({ commit: fixture.applicationCommit });
    await expectFailure(fixture, remote.dependencies, 'checkout-repository-mismatch', {
      checkoutDir: PROJECT_ROOT,
    });
  });

  test('rejects noncanonical explicit commit, run, and wait inputs', async () => {
    const fixture = await createFixture();
    const remote = injectedRemote({ commit: fixture.applicationCommit });
    await expectFailure(fixture, remote.dependencies, 'invalid-application-commit', {
      applicationCommit: fixture.applicationCommit.toUpperCase(),
    });
    await expectFailure(fixture, remote.dependencies, 'invalid-deployment-run-id', {
      deploymentRunId: 'run-1',
    });
    await expectFailure(fixture, remote.dependencies, 'invalid-wait-seconds', {
      waitSeconds: '0',
    });
    await expectFailure(fixture, remote.dependencies, 'invalid-wait-seconds', {
      waitSeconds: '901',
    });
  });

  test('CLI fails closed when any strict explicit input is missing', async () => {
    const child = Bun.spawn([
      'bun',
      'run',
      path.join(PACKAGE_ROOT, 'bin', 'dogfood-verify-live.js'),
      '--attempt',
      'OD-01',
    ], { cwd: PACKAGE_ROOT, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(JSON.parse(stderr)).toMatchObject({ code: 'missing-checkout' });
  });
});
