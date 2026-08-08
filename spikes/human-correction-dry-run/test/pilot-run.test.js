import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { caseId, stableStringify } from '../src/case.js';
import { recordWizardOwnerDecision } from '../src/dogfood-wizard.js';
import { convertPilotSubmission, ownerDecisionTemplate } from '../src/pilot-input.js';
import {
  preparePilotAttempt,
  repinOwnerDogfoodAttempt,
  renderPilotAttempt,
  validatePilotOwnerDecision,
} from '../src/pilot-run.js';
import {
  attemptPaths,
  initializeAttempt,
  initializeOwnerDogfoodSeries,
  loadAttemptOperator,
} from '../src/pilot-workspace.js';

const PROJECT_ROOT = path.resolve(import.meta.dir, '../../..');
const cleanup = [];

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

async function createCheckout({
  repository = 'https://example.org/owner/kb',
  sourcePath = 'docs/guide.md',
  source,
  publishConfig = repository === 'https://github.com/cybersader/cyberbase',
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pilot-checkout-'));
  cleanup.push(root);
  await mkdir(path.dirname(path.join(root, sourcePath)), { recursive: true });
  await writeFile(path.join(root, sourcePath), source, 'utf8');
  if (publishConfig) {
    await writeFile(path.join(root, 'publish.yml'), 'allow:\n  - "docs/**"\n', 'utf8');
  }
  await command(['git', 'init', '-q'], root);
  await command(['git', 'config', 'user.email', 'test@example.org'], root);
  await command(['git', 'config', 'user.name', 'Test User'], root);
  await command(['git', 'add', '.'], root);
  await command(['git', 'commit', '-q', '-m', 'fixture'], root);
  await command(['git', 'remote', 'add', 'origin', `${repository}.git`], root);
  return {
    root,
    repository,
    sourcePath,
    commit: await command(['git', 'rev-parse', 'HEAD'], root),
  };
}

async function createWorkspace() {
  const root = await mkdtemp(path.join(PROJECT_ROOT, '.workspace', 'pilot-run-test-'));
  cleanup.push(root);
  return root;
}

function submission({
  attemptId = 'HC-01',
  quote,
  replacement,
  publicCreditName = 'Private Reader',
  pageUrl = 'https://example.org/kb/guide',
}) {
  return {
    schemaVersion: 1,
    instrumentVersion: 'reader-form-v2',
    attemptId,
    openedAt: '2026-07-28T12:00:00.000Z',
    submittedAt: '2026-07-28T12:00:04.000Z',
    elapsedMs: 4000,
    pageUrl,
    exactQuote: quote,
    replacement,
    rationale: '  Reader rationale with exact spacing.\nSecond line.  ',
    factualSource: 'not applicable',
    publicCreditName,
    creditConsent: 'no',
  };
}

function operator({ attemptId = 'HC-01', checkout, correctionKind = 'typo', overrides = {} }) {
  return {
    schemaVersion: 1,
    attemptId,
    profile: 'independent-counted',
    repository: checkout.repository,
    checkoutDir: checkout.root,
    baseCommit: checkout.commit,
    sourcePath: checkout.sourcePath,
    publicUrl: 'https://example.org/kb/guide',
    sourceAuthorizedForLocalProcessing: true,
    independentOwnerAttested: true,
    readerUnaided: true,
    accessInterruption: false,
    correctionKind,
    selectorContext: {},
    ownerPolicyRevision: 'independent-owner-policy-v1',
    ownerPolicy: {
      trusted: [], agents: [],
      caps: { lines: 10, files: 1, proseWords: 25, typoLines: 4, typoWords: 4 },
      allowedNewFolders: [], frontmatterAllowlist: [],
    },
    publicationBoundary: 'not-applicable',
    renderer: {
      profile: 'owner-static-output',
      basePath: 'kb',
      buildCommand: 'owner-build baseline; owner-build candidate',
    },
    ...overrides,
  };
}

function ownerDogfoodOperator({ attemptId = 'OD-01', checkout, pageUrl }) {
  return operator({
    attemptId,
    checkout,
    correctionKind: 'wording',
    overrides: {
      profile: 'owner-self-dogfood',
      publicUrl: pageUrl,
      independentOwnerAttested: false,
      publicationBoundary: 'cyberbaser',
      renderer: {
        profile: 'cyberbase-quartz-v4.5.2',
        basePath: 'cyberbase',
        buildCommand: 'renderers/quartz-cyberbase/build.sh <content-dir> <quartz-dir>',
      },
    },
  });
}

async function writeAttempt({ workspace, attemptId = 'HC-01', submissionData, operatorData }) {
  if (operatorData.profile === 'owner-self-dogfood') {
    await initializeOwnerDogfoodSeries({
      charter: {
        schemaVersion: 1,
        artifactType: 'private-owner-self-dogfood-series-charter',
        profile: 'owner-self-dogfood',
        attemptIds: [attemptId, 'OD-98', 'OD-99'],
        obligationAssignments: {
          'normal-correction': 'OD-99',
          'signed-out-mobile-handoff': attemptId,
          'stale-source': 'OD-98',
          'ambiguous-quote': 'OD-98',
          'owner-rejection': attemptId,
        },
        plannedSignedOutMobile: {
          attemptId,
          device: 'Synthetic phone',
          operatingSystem: 'Synthetic mobile OS',
          browser: 'Synthetic browser',
          signedIn: false,
        },
        evidenceClassification: {
          evidenceClass: 'owner-self-dogfood',
          countsTowardHumanPilot: false,
          independentOwnerEvidence: false,
          claimBoundary: 'maintainer operational and mechanical evidence only',
        },
      },
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspace,
    });
  }
  await initializeAttempt({
    attemptId,
    profile: operatorData.profile,
    projectRoot: PROJECT_ROOT,
    workspaceRoot: workspace,
  });
  const paths = attemptPaths(attemptId, { projectRoot: PROJECT_ROOT, workspaceRoot: workspace });
  await writeFile(paths.submission, `${JSON.stringify(submissionData, null, 2)}\n`, 'utf8');
  await writeFile(paths.operator, `${JSON.stringify(operatorData, null, 2)}\n`, 'utf8');
  return paths;
}

async function pathExists(target) {
  try { await stat(target); return true; } catch { return false; }
}

async function completeRenderAttestation({ paths, mechanicalCaseId, baselineSite, candidateSite }) {
  const file = path.join(paths.runs, mechanicalCaseId, 'render-attestation.json');
  const attestation = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, `${JSON.stringify({
    ...attestation,
    baselineSiteDir: baselineSite,
    candidateSiteDir: candidateSite,
    builtFromPreparedSnapshots: true,
    builtInIsolatedWorkspaces: true,
    ownerConfirmedAt: '2026-07-28T12:01:00.000Z',
  }, null, 2)}\n`, 'utf8');
}

function cyberbaseLiveEvidence({ evaluation, quote, replacement, candidateOnly = 0 }) {
  const candidateOnlyFindings = candidateOnly === 0 ? [] : [{
    page: 'guide.html', href: '/cyberbase/new-missing', decodedTarget: 'new-missing', class: 'missing-page',
  }];
  return {
    schemaVersion: 1,
    artifactType: 'private-local-rendered-correction-run',
    case: evaluation.case,
    evaluation,
    projection: {
      baseline: { mode: 'cyberbaser-select-project-verify', selection: { sourcePublished: true }, projection: { ok: true, verification: { ok: true } } },
      candidate: { mode: 'cyberbaser-select-project-verify', selection: { sourcePublished: true }, projection: { ok: true, verification: { ok: true } } },
    },
    renderer: {
      baseline: { renderer: 'quartz-cyberbase', pin: 'v4.5.2' },
      candidate: { renderer: 'quartz-cyberbase', pin: 'v4.5.2' },
      isolatedWorkspaces: true,
      publicDeploymentPerformed: false,
    },
    siteChecks: {
      baseline: { total: 100, ok: 99, occurrences: 120, pages: 1, broken: 1 },
      candidate: { total: 100 + candidateOnly, ok: 99, occurrences: 120, pages: 1, broken: 1 + candidateOnly },
      linkDelta: {
        tuple: ['page', 'href', 'decoded', 'class'],
        candidateOnly: candidateOnlyFindings,
        baselineOnly: [],
        unchanged: 1,
        counts: {
          baseline: 1,
          candidate: 1 + candidateOnly,
          candidateOnly,
          baselineOnly: 0,
          unchanged: 1,
        },
      },
    },
    renderedTarget: {
      basePath: 'cyberbase',
      baseline: {
        page: 'guide.html', byteLength: 100, sha256: 'baseline-output',
        quoteOccurrences: 1, replacementOccurrences: 0, observedExactText: quote,
      },
      candidate: {
        page: 'guide.html', byteLength: 100, sha256: 'candidate-output',
        quoteOccurrences: 0, replacementOccurrences: 1, observedExactText: replacement,
      },
      comparable: {
        sameRenderedPage: true,
        baselineOldTextPresent: true,
        baselineReplacementTextAbsent: true,
        candidateOldTextAbsent: true,
        candidateReplacementSatisfied: true,
      },
    },
    sourceCheckout: {
      repository: 'https://github.com/cybersader/cyberbase',
      baseCommit: evaluation.source.baseCommit,
      repositoryMatches: true,
      cleanBefore: true,
      publishConfigPresent: true,
      sourceBytesBeforeSha256: 'source-before',
      cleanAfter: true,
      sourceBytesUnchangedAfter: true,
    },
    temporaryCopies: {
      separateBaselineAndCandidate: true,
      baselineSourceUnchanged: true,
      candidateSourceChangedOnlyInTemporaryCopy: true,
      candidateSha256: 'candidate-copy',
    },
    cleanup: { completed: true, temporaryWorkspacesRetained: false },
    noWrite: {
      suppliedCheckoutWritePerformed: false,
      automaticSourceApplicationPerformed: false,
      candidateAppliedOnlyToTemporaryCandidateCopy: true,
    },
  };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('pilot preparation', () => {
  test('policy-free Cyberbaser preparation fails before creating a run', async () => {
    const attemptId = 'OD-01';
    const quote = 'Old policy-free sentence.';
    const replacement = 'New policy-free sentence.';
    const pageUrl = 'https://example.org/cyberbase/guide';
    const checkout = await createCheckout({
      repository: 'https://github.com/cybersader/cyberbase',
      source: `# Guide\n\n${quote}\n`,
      publishConfig: false,
    });
    const workspace = await createWorkspace();
    const paths = await writeAttempt({
      workspace,
      attemptId,
      submissionData: submission({ attemptId, quote, replacement, pageUrl }),
      operatorData: ownerDogfoodOperator({ attemptId, checkout, pageUrl }),
    });
    const sourceBefore = await readFile(path.join(checkout.root, checkout.sourcePath));

    await expect(preparePilotAttempt({
      attemptId,
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspace,
    })).rejects.toMatchObject({ code: 'publication-boundary-policy-missing' });

    expect(await readdir(paths.runs)).toEqual([]);
    expect((await readFile(path.join(checkout.root, checkout.sourcePath))).equals(sourceBefore)).toBe(true);
    expect(await command(['git', 'status', '--porcelain=v1', '--untracked-files=all'], checkout.root)).toBe('');
  });

  test('rejects a submission version forged away from the issued reader form', async () => {
    const quote = 'The routre forwards the packet.';
    const checkout = await createCheckout({ source: `# Guide\n\n${quote}\n` });
    const workspace = await createWorkspace();
    const paths = await writeAttempt({
      workspace,
      submissionData: {
        ...submission({ quote, replacement: 'The router forwards the packet.' }),
        instrumentVersion: 'reader-form-v1',
      },
      operatorData: operator({ checkout }),
    });

    await expect(preparePilotAttempt({
      attemptId: 'HC-01', projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    })).rejects.toMatchObject({ code: 'submission-instrument-version-mismatch' });

    expect(await readdir(paths.runs)).toEqual([]);
  });

  test('creates deterministic no-write evidence but remains ineligible without rendering', async () => {
    const quote = 'The routre forwards the packet.';
    const replacement = 'The router forwards the packet.';
    const checkout = await createCheckout({ source: `# Guide\n\n${quote}\n` });
    const sourceFile = path.join(checkout.root, checkout.sourcePath);
    const sourceBefore = await readFile(sourceFile);
    const firstWorkspace = await createWorkspace();
    const firstPaths = await writeAttempt({
      workspace: firstWorkspace,
      submissionData: submission({ quote, replacement }),
      operatorData: operator({ checkout }),
    });

    const result = await preparePilotAttempt({
      attemptId: 'HC-01', projectRoot: PROJECT_ROOT, workspaceRoot: firstWorkspace,
    });
    expect(result.countsTowardPilot).toBe(false);
    expect(result.ownerDecisionEligible).toBe(false);
    expect(result.blockingReasons).toContain('render-evidence-required');
    expect((await readFile(sourceFile)).equals(sourceBefore)).toBe(true);

    const runDir = path.join(firstPaths.runs, result.mechanicalCaseId);
    const status = JSON.parse(await readFile(path.join(runDir, 'status.json'), 'utf8'));
    const evaluation = JSON.parse(await readFile(path.join(runDir, 'evaluation.json'), 'utf8'));
    const mechanical = await readFile(path.join(runDir, 'mechanical-review.json'), 'utf8');
    const ownerCard = await readFile(path.join(runDir, 'owner-review.html'), 'utf8');
    expect(status.gates.rendering).toBe(false);
    expect(status.ownerDecisionEligible).toBe(false);
    expect(evaluation.trust.authorType).toBe('anonymous');
    expect(mechanical).not.toContain(checkout.root);
    expect(mechanical).not.toContain(checkout.sourcePath);
    expect(mechanical).not.toContain('Private Reader');
    expect(ownerCard).toContain(checkout.root);
    expect(ownerCard).toContain(checkout.sourcePath);
    expect(ownerCard).toContain('Private Reader (no public consent)');
    expect(ownerCard).toContain('pending human owner');

    const secondWorkspace = await createWorkspace();
    const secondPaths = await writeAttempt({
      workspace: secondWorkspace,
      submissionData: submission({ quote, replacement }),
      operatorData: operator({ checkout }),
    });
    const second = await preparePilotAttempt({
      attemptId: 'HC-01', projectRoot: PROJECT_ROOT, workspaceRoot: secondWorkspace,
    });
    const secondRun = path.join(secondPaths.runs, second.mechanicalCaseId);
    for (const name of [
      'case.json', 'evaluation.json', 'baseline-source.md', 'candidate-source.md',
      'render-attestation.json', 'owner-decision-template.json', 'mechanical-review.json',
      'owner-review.html', 'status.json',
    ]) {
      expect(await readFile(path.join(secondRun, name))).toEqual(await readFile(path.join(runDir, name)));
    }
  });

  test('OFM damage stops before an owner card while suspect produces a visibly blocked card', async () => {
    const damageQuote = '[[Some Page|the alias]]';
    const damageCheckout = await createCheckout({ source: `# Guide\n\nSee ${damageQuote}.\n` });
    const damageWorkspace = await createWorkspace();
    const damagePaths = await writeAttempt({
      workspace: damageWorkspace,
      submissionData: submission({ quote: damageQuote, replacement: '[Some Page](Some%20Page)' }),
      operatorData: operator({ checkout: damageCheckout, correctionKind: 'link' }),
    });
    const damaged = await preparePilotAttempt({
      attemptId: 'HC-01', projectRoot: PROJECT_ROOT, workspaceRoot: damageWorkspace,
    });
    const damageRun = path.join(damagePaths.runs, damaged.mechanicalCaseId);
    expect(damaged.ownerCardCreated).toBe(false);
    expect(damaged.blockingReasons).toContain('ofm-damage-stops-attempt');
    expect(await pathExists(path.join(damageRun, 'owner-review.html'))).toBe(false);

    const suspectQuote = 'Plain sentence.';
    const suspectReplacement = 'Plain sentence. \\[a\\] \\*b\\* \\_c\\_ \\#tag';
    const suspectCheckout = await createCheckout({ source: `# Guide\n\n${suspectQuote}\n` });
    const suspectWorkspace = await createWorkspace();
    const suspectPaths = await writeAttempt({
      workspace: suspectWorkspace,
      submissionData: submission({ quote: suspectQuote, replacement: suspectReplacement }),
      operatorData: operator({ checkout: suspectCheckout, correctionKind: 'formatting' }),
    });
    const suspected = await preparePilotAttempt({
      attemptId: 'HC-01', projectRoot: PROJECT_ROOT, workspaceRoot: suspectWorkspace,
    });
    const suspectRun = path.join(suspectPaths.runs, suspected.mechanicalCaseId);
    expect(suspected.ownerCardCreated).toBe(true);
    expect(suspected.blockingReasons).toContain('ofm-suspect-blocks-owner-decision');
    expect(await readFile(path.join(suspectRun, 'owner-review.html'), 'utf8')).toContain('ofm-suspect-blocks-owner-decision');
  });

  test('rejects an ignored owner-mapped source even when Git status is empty', async () => {
    const quote = 'Ignored source sentence.';
    const checkout = await createCheckout({ source: `# Guide\n\n${quote}\n` });
    await rm(path.join(checkout.root, checkout.sourcePath));
    await writeFile(path.join(checkout.root, '.gitignore'), `${checkout.sourcePath}\n`, 'utf8');
    await command(['git', 'add', '-A'], checkout.root);
    await command(['git', 'commit', '-q', '-m', 'ignore source'], checkout.root);
    await writeFile(path.join(checkout.root, checkout.sourcePath), `# Guide\n\n${quote}\n`, 'utf8');
    checkout.commit = await command(['git', 'rev-parse', 'HEAD'], checkout.root);
    expect(await command(['git', 'status', '--porcelain=v1', '--untracked-files=all'], checkout.root)).toBe('');
    const workspace = await createWorkspace();
    await writeAttempt({
      workspace,
      submissionData: submission({ quote, replacement: 'Tracked source sentence.' }),
      operatorData: operator({ checkout }),
    });
    await expect(preparePilotAttempt({
      attemptId: 'HC-01', projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    })).rejects.toMatchObject({ code: 'source-not-version-controlled' });
  });

  test('existing exact-anchor errors pass through and leave source bytes unchanged', async () => {
    const quote = 'Repeated quote.';
    const checkout = await createCheckout({ source: `# Guide\n\n${quote}\n${quote}\n` });
    const sourceFile = path.join(checkout.root, checkout.sourcePath);
    const before = await readFile(sourceFile);
    const workspace = await createWorkspace();
    await writeAttempt({
      workspace,
      submissionData: submission({ quote, replacement: 'Replacement.' }),
      operatorData: operator({ checkout }),
    });
    await expect(preparePilotAttempt({
      attemptId: 'HC-01', projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    })).rejects.toMatchObject({ code: 'quote-ambiguous' });
    expect((await readFile(sourceFile)).equals(before)).toBe(true);
  });
});

describe('owner self-dogfood operator repin', () => {
  test('preserves the original binding and run while deriving a new preparable case', async () => {
    const attemptId = 'OD-01';
    const quote = 'Old dogfood sentence.';
    const replacement = 'New dogfood sentence.';
    const pageUrl = 'https://example.org/cyberbase/guide';
    const checkout = await createCheckout({
      repository: 'https://github.com/cybersader/cyberbase',
      source: `# Guide\n\n${quote}\n`,
      publishConfig: false,
    });
    const originalCommit = checkout.commit;
    const workspace = await createWorkspace();
    const paths = await writeAttempt({
      workspace,
      attemptId,
      submissionData: submission({ attemptId, quote, replacement, pageUrl }),
      operatorData: ownerDogfoodOperator({ attemptId, checkout, pageUrl }),
    });
    const originalOperatorBytes = await readFile(paths.operator);
    const oldRun = path.join(paths.runs, 'DRY-111111111111');
    await mkdir(oldRun);
    await writeFile(path.join(oldRun, 'historical-failure.json'), '{"preserved":true}\n', 'utf8');

    await writeFile(path.join(checkout.root, 'publish.yml'), 'allow:\n  - "docs/**"\n', 'utf8');
    await command(['git', 'add', 'publish.yml'], checkout.root);
    await command(['git', 'commit', '-q', '-m', 'add publication policy'], checkout.root);
    const replacementCommit = await command(['git', 'rev-parse', 'HEAD'], checkout.root);
    const sourceBefore = await readFile(path.join(checkout.root, checkout.sourcePath));

    const repinned = await repinOwnerDogfoodAttempt({
      attemptId,
      checkoutDir: checkout.root,
      sourceAuthorization: 'yes',
      reason: 'The original source pin predates the publication policy.',
      repinnedAt: '2026-07-31T13:00:00.000Z',
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspace,
    });

    expect(repinned.previousBaseCommit).toBe(originalCommit);
    expect(repinned.baseCommit).toBe(replacementCommit);
    expect(repinned.replacementCaseId).not.toBe(repinned.originalCaseId);
    expect(await readFile(paths.operator)).toEqual(originalOperatorBytes);
    expect(JSON.parse(await readFile(paths.operatorRepin, 'utf8'))).toMatchObject({
      artifactType: 'private-owner-self-dogfood-operator-repin',
      previousBaseCommit: originalCommit,
      publishConfigPresent: true,
      replacementOperator: { baseCommit: replacementCommit },
    });
    expect((await loadAttemptOperator(paths)).baseCommit).toBe(replacementCommit);
    expect(await pathExists(path.join(oldRun, 'historical-failure.json'))).toBe(true);

    const prepared = await preparePilotAttempt({
      attemptId,
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspace,
    });
    expect(prepared.mechanicalCaseId).toBe(repinned.replacementCaseId);
    expect(await pathExists(path.join(paths.runs, repinned.replacementCaseId, 'status.json'))).toBe(true);
    expect((await readFile(path.join(checkout.root, checkout.sourcePath))).equals(sourceBefore)).toBe(true);
    expect(await command(['git', 'status', '--porcelain=v1', '--untracked-files=all'], checkout.root)).toBe('');

    await expect(repinOwnerDogfoodAttempt({
      attemptId,
      checkoutDir: checkout.root,
      sourceAuthorization: 'yes',
      reason: 'A second repin must not replace immutable evidence.',
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspace,
    })).rejects.toMatchObject({ code: 'operator-repin-already-exists' });
  });

  test('allows either repin or owner decision to win, never both', async () => {
    const attemptId = 'OD-01';
    const quote = 'Concurrent old sentence.';
    const replacement = 'Concurrent new sentence.';
    const pageUrl = 'https://example.org/cyberbase/guide';
    const checkout = await createCheckout({
      repository: 'https://github.com/cybersader/cyberbase',
      source: `# Guide\n\n${quote}\n`,
      publishConfig: false,
    });
    const workspace = await createWorkspace();
    const submissionData = submission({ attemptId, quote, replacement, pageUrl });
    const operatorData = ownerDogfoodOperator({ attemptId, checkout, pageUrl });
    const paths = await writeAttempt({
      workspace,
      attemptId,
      submissionData,
      operatorData,
    });
    const mechanicalCaseId = caseId(convertPilotSubmission(submissionData, operatorData));
    const runDir = path.join(paths.runs, mechanicalCaseId);
    await mkdir(runDir);
    const template = ownerDecisionTemplate(attemptId, {
      mechanicalCaseId,
      candidateDigest: 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:',
    });
    await writeFile(path.join(runDir, 'owner-decision-template.json'), stableStringify(template), 'utf8');
    await writeFile(paths.ownerDecision, stableStringify(template), 'utf8');
    const attempt = {
      attemptId,
      stage: 'awaiting-decision',
      paths,
      runDir,
      mechanicalCaseId,
      template,
    };

    await writeFile(path.join(checkout.root, 'publish.yml'), 'allow:\n  - "docs/**"\n', 'utf8');
    await command(['git', 'add', 'publish.yml'], checkout.root);
    await command(['git', 'commit', '-q', '-m', 'add policy for concurrent repin'], checkout.root);

    const outcomes = await Promise.allSettled([
      repinOwnerDogfoodAttempt({
        attemptId,
        checkoutDir: checkout.root,
        sourceAuthorization: 'yes',
        reason: 'Concurrent recovery attempt.',
        projectRoot: PROJECT_ROOT,
        workspaceRoot: workspace,
      }),
      recordWizardOwnerDecision({
        attempt,
        decision: 'reject',
        reason: 'Concurrent owner decision.',
        reviewSeconds: 1,
        decidedAt: '2026-07-31T13:15:00.000Z',
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const repinExists = await pathExists(paths.operatorRepin);
    const decisionExists = await pathExists(path.join(runDir, 'wizard-owner-decision.json'));
    expect([repinExists, decisionExists].filter(Boolean)).toHaveLength(1);
  });

  test('fails closed on missing policy, unnecessary recovery, dirty checkout, or stale quote', async () => {
    const attemptId = 'OD-01';
    const quote = 'Exact legacy sentence.';
    const replacement = 'Exact replacement sentence.';
    const pageUrl = 'https://example.org/cyberbase/guide';

    async function legacyAttempt(checkout) {
      const workspace = await createWorkspace();
      const paths = await writeAttempt({
        workspace,
        attemptId,
        submissionData: submission({ attemptId, quote, replacement, pageUrl }),
        operatorData: ownerDogfoodOperator({ attemptId, checkout, pageUrl }),
      });
      return { workspace, paths };
    }

    const policyFree = await createCheckout({
      repository: 'https://github.com/cybersader/cyberbase',
      source: `# Guide\n\n${quote}\n`,
      publishConfig: false,
    });
    const missingPolicy = await legacyAttempt(policyFree);
    await writeFile(path.join(policyFree.root, 'revision.txt'), 'new base without policy\n', 'utf8');
    await command(['git', 'add', 'revision.txt'], policyFree.root);
    await command(['git', 'commit', '-q', '-m', 'advance without policy'], policyFree.root);
    await expect(repinOwnerDogfoodAttempt({
      attemptId,
      checkoutDir: policyFree.root,
      sourceAuthorization: 'yes',
      reason: 'Missing policy must fail.',
      projectRoot: PROJECT_ROOT,
      workspaceRoot: missingPolicy.workspace,
    })).rejects.toMatchObject({ code: 'publication-boundary-policy-missing' });
    expect(await pathExists(missingPolicy.paths.operatorRepin)).toBe(false);

    const policyBearingOriginal = await createCheckout({
      repository: 'https://github.com/cybersader/cyberbase',
      source: `# Guide\n\n${quote}\n`,
      publishConfig: true,
    });
    const unnecessaryAttempt = await legacyAttempt(policyBearingOriginal);
    await expect(repinOwnerDogfoodAttempt({
      attemptId,
      checkoutDir: policyBearingOriginal.root,
      sourceAuthorization: 'yes',
      reason: 'A policy-bearing original pin must not be repinned.',
      projectRoot: PROJECT_ROOT,
      workspaceRoot: unnecessaryAttempt.workspace,
    })).rejects.toMatchObject({ code: 'operator-repin-not-required' });
    expect(await pathExists(unnecessaryAttempt.paths.operatorRepin)).toBe(false);

    const dirty = await createCheckout({
      repository: 'https://github.com/cybersader/cyberbase',
      source: `# Guide\n\n${quote}\n`,
      publishConfig: false,
    });
    const dirtyAttempt = await legacyAttempt(dirty);
    await writeFile(path.join(dirty.root, 'publish.yml'), 'allow:\n  - "docs/**"\n', 'utf8');
    await writeFile(path.join(dirty.root, 'revision.txt'), 'new clean base\n', 'utf8');
    await command(['git', 'add', 'publish.yml', 'revision.txt'], dirty.root);
    await command(['git', 'commit', '-q', '-m', 'advance policy-bearing base'], dirty.root);
    await writeFile(path.join(dirty.root, 'dirty.txt'), 'uncommitted\n', 'utf8');
    await expect(repinOwnerDogfoodAttempt({
      attemptId,
      checkoutDir: dirty.root,
      sourceAuthorization: 'yes',
      reason: 'A dirty checkout must fail.',
      projectRoot: PROJECT_ROOT,
      workspaceRoot: dirtyAttempt.workspace,
    })).rejects.toMatchObject({ code: 'checkout-not-clean' });
    expect(await pathExists(dirtyAttempt.paths.operatorRepin)).toBe(false);

    const stale = await createCheckout({
      repository: 'https://github.com/cybersader/cyberbase',
      source: `# Guide\n\n${quote}\n`,
      publishConfig: false,
    });
    const staleAttempt = await legacyAttempt(stale);
    await writeFile(path.join(stale.root, stale.sourcePath), '# Guide\n\nDifferent source text.\n', 'utf8');
    await writeFile(path.join(stale.root, 'publish.yml'), 'allow:\n  - "docs/**"\n', 'utf8');
    await command(['git', 'add', '.'], stale.root);
    await command(['git', 'commit', '-q', '-m', 'advance beyond exact quote'], stale.root);
    await expect(repinOwnerDogfoodAttempt({
      attemptId,
      checkoutDir: stale.root,
      sourceAuthorization: 'yes',
      reason: 'A stale quote must fail.',
      projectRoot: PROJECT_ROOT,
      workspaceRoot: staleAttempt.workspace,
    })).rejects.toMatchObject({ code: 'quote-not-found' });
    expect(await pathExists(staleAttempt.paths.operatorRepin)).toBe(false);

    const originalForWrongOrigin = await createCheckout({
      repository: 'https://github.com/cybersader/cyberbase',
      source: `# Guide\n\n${quote}\n`,
      publishConfig: false,
    });
    const wrongOriginAttempt = await legacyAttempt(originalForWrongOrigin);
    const wrongOrigin = await createCheckout({
      repository: 'https://example.org/not-cyberbase',
      source: `# Guide\n\n${quote}\n`,
      publishConfig: true,
    });
    await expect(repinOwnerDogfoodAttempt({
      attemptId,
      checkoutDir: wrongOrigin.root,
      sourceAuthorization: 'yes',
      reason: 'A different repository must fail.',
      projectRoot: PROJECT_ROOT,
      workspaceRoot: wrongOriginAttempt.workspace,
    })).rejects.toMatchObject({ code: 'checkout-repository-mismatch' });
    expect(await pathExists(wrongOriginAttempt.paths.operatorRepin)).toBe(false);

    const canonicalRecorded = await createCheckout({
      repository: 'https://github.com/cybersader/cyberbase',
      source: `# Guide\n\n${quote}\n`,
      publishConfig: false,
    });
    const canonicalRecordedAttempt = await legacyAttempt(canonicalRecorded);
    const decision = JSON.parse(await readFile(canonicalRecordedAttempt.paths.ownerDecision, 'utf8'));
    await writeFile(canonicalRecordedAttempt.paths.ownerDecision, `${JSON.stringify({
      ...decision,
      decision: 'reject',
      reason: 'The owner already recorded a decision.',
      reviewSeconds: 3,
      decidedAt: '2026-07-31T13:05:00.000Z',
    }, null, 2)}\n`, 'utf8');
    await expect(repinOwnerDogfoodAttempt({
      attemptId,
      checkoutDir: canonicalRecorded.root,
      sourceAuthorization: 'yes',
      reason: 'A recorded canonical decision must freeze the binding.',
      projectRoot: PROJECT_ROOT,
      workspaceRoot: canonicalRecordedAttempt.workspace,
    })).rejects.toMatchObject({ code: 'operator-repin-after-decision' });

    const wizardRecorded = await createCheckout({
      repository: 'https://github.com/cybersader/cyberbase',
      source: `# Guide\n\n${quote}\n`,
      publishConfig: false,
    });
    const wizardRecordedAttempt = await legacyAttempt(wizardRecorded);
    const wizardRun = path.join(wizardRecordedAttempt.paths.runs, 'DRY-333333333333');
    await mkdir(wizardRun);
    await writeFile(path.join(wizardRun, 'wizard-owner-decision.json'), '{}\n', 'utf8');
    await expect(repinOwnerDogfoodAttempt({
      attemptId,
      checkoutDir: wizardRecorded.root,
      sourceAuthorization: 'yes',
      reason: 'A recorded wizard decision must freeze the binding.',
      projectRoot: PROJECT_ROOT,
      workspaceRoot: wizardRecordedAttempt.workspace,
    })).rejects.toMatchObject({ code: 'operator-repin-after-decision' });

    const completed = await createCheckout({
      repository: 'https://github.com/cybersader/cyberbase',
      source: `# Guide\n\n${quote}\n`,
      publishConfig: false,
    });
    const completedAttempt = await legacyAttempt(completed);
    const completedRun = path.join(completedAttempt.paths.runs, 'DRY-222222222222');
    await mkdir(completedRun);
    await writeFile(path.join(completedRun, 'validated-owner-decision.json'), '{}\n', 'utf8');
    await expect(repinOwnerDogfoodAttempt({
      attemptId,
      checkoutDir: completed.root,
      sourceAuthorization: 'yes',
      reason: 'A completed decision must freeze the binding.',
      projectRoot: PROJECT_ROOT,
      workspaceRoot: completedAttempt.workspace,
    })).rejects.toMatchObject({ code: 'operator-repin-after-decision' });
    expect(await pathExists(completedAttempt.paths.operatorRepin)).toBe(false);
  }, 60_000);
});

describe('independent static-output rendering', () => {
  test('checks existing outputs without executing owner commands and permits inherited baseline debt', async () => {
    const quote = 'Old exact sentence.';
    const replacement = 'New exact sentence.';
    const checkout = await createCheckout({ source: `# Guide\n\n${quote}\n` });
    const workspace = await createWorkspace();
    const paths = await writeAttempt({
      workspace,
      submissionData: submission({ quote, replacement }),
      operatorData: operator({ checkout, correctionKind: 'wording' }),
    });
    const prepared = await preparePilotAttempt({
      attemptId: 'HC-01', projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    });
    const legacyStatusFile = path.join(paths.runs, prepared.mechanicalCaseId, 'status.json');
    const legacyStatus = JSON.parse(await readFile(legacyStatusFile, 'utf8'));
    delete legacyStatus.evidenceClass;
    delete legacyStatus.countsTowardHumanPilot;
    delete legacyStatus.independentOwnerEvidence;
    delete legacyStatus.claimBoundary;
    legacyStatus.schemaVersion = 1;
    await writeFile(legacyStatusFile, `${JSON.stringify(legacyStatus, null, 2)}\n`, 'utf8');
    const baseline = await mkdtemp(path.join(os.tmpdir(), 'pilot-baseline-site-'));
    const candidate = await mkdtemp(path.join(os.tmpdir(), 'pilot-candidate-site-'));
    cleanup.push(baseline, candidate);
    await writeFile(path.join(baseline, 'guide.html'), `<p>${quote}</p><a href="/kb/inherited">missing</a>`, 'utf8');
    await writeFile(path.join(candidate, 'guide.html'), `<p>${replacement}</p><a href="/kb/inherited">missing</a>`, 'utf8');
    await completeRenderAttestation({
      paths,
      mechanicalCaseId: prepared.mechanicalCaseId,
      baselineSite: baseline,
      candidateSite: candidate,
    });

    const rendered = await renderPilotAttempt({
      attemptId: 'HC-01', baselineSite: baseline, candidateSite: candidate,
      projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    });
    expect(rendered.ownerDecisionEligible).toBe(true);
    expect(rendered.arbitraryOwnerCommandExecuted).toBe(false);
    const runDir = path.join(paths.runs, prepared.mechanicalCaseId);
    const status = JSON.parse(await readFile(path.join(runDir, 'status.json'), 'utf8'));
    const evidence = JSON.parse(await readFile(path.join(runDir, 'render-evidence.json'), 'utf8'));
    expect(status.schemaVersion).toBe(2);
    expect(status.gates.rendering).toBe(true);
    expect(status.ownerDecisionEligible).toBe(true);
    expect(evidence.arbitraryOwnerCommandExecuted).toBe(false);
    expect(evidence.siteChecks.linkDelta.counts.baseline).toBe(1);
    expect(evidence.siteChecks.linkDelta.counts.candidateOnly).toBe(0);
    expect(evidence.preparedSourceBinding).toEqual({
      baselineDigest: JSON.parse(await readFile(path.join(runDir, 'evaluation.json'), 'utf8')).base.digest,
      candidateDigest: JSON.parse(await readFile(path.join(runDir, 'evaluation.json'), 'utf8')).candidate.digest,
      snapshotsRevalidated: true,
      currentPinnedSourceRevalidated: true,
    });
    const renderedCard = await readFile(path.join(runDir, 'owner-rendered-review.html'), 'utf8');
    expect(renderedCard).toContain('Review-card contract complete');
    expect(renderedCard).toContain('Baseline observed passage');
    expect(renderedCard).toContain('OFM churn');
    expect(renderedCard).toContain('Trust reasons');
    expect(renderedCard).toContain('not applicable; independent owner did not adopt Cyberbaser projection');

    const decision = JSON.parse(await readFile(paths.ownerDecision, 'utf8'));
    await writeFile(paths.ownerDecision, `${JSON.stringify({
      ...decision,
      decision: 'accept',
      reason: 'The exact candidate and complete evidence are acceptable.',
      reviewSeconds: 42,
      decidedAt: '2026-07-28T12:02:00.000Z',
    }, null, 2)}\n`, 'utf8');
    const validatedDecision = await validatePilotOwnerDecision({
      attemptId: 'HC-01', projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    });
    expect(validatedDecision.mechanicalCaseId).toBe(prepared.mechanicalCaseId);
    expect(validatedDecision.candidateDigest).toBe(evidence.preparedSourceBinding.candidateDigest);
    expect(validatedDecision.countsTowardPilot).toBe(false);

    await writeFile(paths.ownerDecision, `${JSON.stringify({
      ...decision,
      candidateDigest: evidence.preparedSourceBinding.baselineDigest,
      decision: 'reject',
      reason: 'Binding test.',
      reviewSeconds: 1,
      decidedAt: '2026-07-28T12:03:00.000Z',
    }, null, 2)}\n`, 'utf8');
    await expect(validatePilotOwnerDecision({
      attemptId: 'HC-01', projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    })).rejects.toMatchObject({ code: 'owner-decision-binding-mismatch' });
  });

  test('fails closed on missing render attestation and altered prepared evidence', async () => {
    const quote = 'Old exact sentence.';
    const replacement = 'New exact sentence.';
    const checkout = await createCheckout({ source: `# Guide\n\n${quote}\n` });
    const workspace = await createWorkspace();
    const paths = await writeAttempt({
      workspace,
      submissionData: submission({ quote, replacement }),
      operatorData: operator({ checkout, correctionKind: 'wording' }),
    });
    const prepared = await preparePilotAttempt({
      attemptId: 'HC-01', projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    });
    const baseline = await mkdtemp(path.join(os.tmpdir(), 'pilot-baseline-site-'));
    const candidate = await mkdtemp(path.join(os.tmpdir(), 'pilot-candidate-site-'));
    cleanup.push(baseline, candidate);
    await writeFile(path.join(baseline, 'guide.html'), `<p>${quote}</p>`, 'utf8');
    await writeFile(path.join(candidate, 'guide.html'), `<p>${replacement}</p>`, 'utf8');

    await expect(renderPilotAttempt({
      attemptId: 'HC-01', baselineSite: baseline, candidateSite: candidate,
      projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    })).rejects.toMatchObject({ code: 'render-attestation-required' });

    await completeRenderAttestation({
      paths,
      mechanicalCaseId: prepared.mechanicalCaseId,
      baselineSite: baseline,
      candidateSite: candidate,
    });
    const evaluationFile = path.join(paths.runs, prepared.mechanicalCaseId, 'evaluation.json');
    const evaluation = JSON.parse(await readFile(evaluationFile, 'utf8'));
    await writeFile(evaluationFile, `${JSON.stringify({
      ...evaluation,
      candidate: { ...evaluation.candidate, digest: evaluation.base.digest },
      case: { ...evaluation.case, quote: 'Forged old text.' },
    }, null, 2)}\n`, 'utf8');
    await expect(renderPilotAttempt({
      attemptId: 'HC-01', baselineSite: baseline, candidateSite: candidate,
      projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    })).rejects.toMatchObject({ code: 'prepared-evaluation-mismatch' });
  });

  test('revalidates current pinned source bytes before accepting static render evidence', async () => {
    const quote = 'Old exact sentence.';
    const replacement = 'New exact sentence.';
    const checkout = await createCheckout({ source: `# Guide\n\n${quote}\n` });
    const workspace = await createWorkspace();
    const paths = await writeAttempt({
      workspace,
      submissionData: submission({ quote, replacement }),
      operatorData: operator({ checkout, correctionKind: 'wording' }),
    });
    const prepared = await preparePilotAttempt({
      attemptId: 'HC-01', projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    });
    const baseline = await mkdtemp(path.join(os.tmpdir(), 'pilot-baseline-site-'));
    const candidate = await mkdtemp(path.join(os.tmpdir(), 'pilot-candidate-site-'));
    cleanup.push(baseline, candidate);
    await writeFile(path.join(baseline, 'guide.html'), `<p>${quote}</p>`, 'utf8');
    await writeFile(path.join(candidate, 'guide.html'), `<p>${replacement}</p>`, 'utf8');
    await completeRenderAttestation({
      paths,
      mechanicalCaseId: prepared.mechanicalCaseId,
      baselineSite: baseline,
      candidateSite: candidate,
    });
    await writeFile(path.join(checkout.root, checkout.sourcePath), `# Guide\n\nChanged after preparation.\n`, 'utf8');

    await expect(renderPilotAttempt({
      attemptId: 'HC-01', baselineSite: baseline, candidateSite: candidate,
      projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    })).rejects.toMatchObject({ code: 'checkout-not-clean' });
  });

  test('Cyberbase decision reruns the live lane and tolerates only excluded build nondeterminism', async () => {
    const quote = 'Old Cyberbase sentence.';
    const replacement = 'New Cyberbase sentence.';
    const repository = 'https://github.com/cybersader/cyberbase';
    const pageUrl = 'https://example.org/cyberbase/guide';
    const checkout = await createCheckout({ repository, source: `# Guide\n\n${quote}\n` });
    const workspace = await createWorkspace();
    const operatorData = operator({
      checkout,
      correctionKind: 'wording',
      overrides: {
        profile: 'cyberbase-rehearsal',
        publicUrl: pageUrl,
        independentOwnerAttested: false,
        publicationBoundary: 'cyberbaser',
        renderer: {
          profile: 'cyberbase-quartz-v4.5.2',
          basePath: 'cyberbase',
          buildCommand: 'renderers/quartz-cyberbase/build.sh <content-dir> <quartz-dir>',
        },
      },
    });
    const paths = await writeAttempt({
      workspace,
      submissionData: submission({ quote, replacement, pageUrl }),
      operatorData,
    });
    const prepared = await preparePilotAttempt({
      attemptId: 'HC-01', projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    });
    expect(prepared.countsTowardPilot).toBe(false);
    const runDir = path.join(paths.runs, prepared.mechanicalCaseId);
    const evaluation = JSON.parse(await readFile(path.join(runDir, 'evaluation.json'), 'utf8'));
    let receivedOptions = null;
    let liveRunCalls = 0;
    const liveEvidence = cyberbaseLiveEvidence({ evaluation, quote, replacement });
    const freshLiveEvidence = structuredClone(liveEvidence);
    freshLiveEvidence.siteChecks.baseline.total = 103;
    freshLiveEvidence.siteChecks.baseline.ok = 102;
    freshLiveEvidence.siteChecks.baseline.occurrences = 130;
    freshLiveEvidence.siteChecks.candidate.total = 104;
    freshLiveEvidence.siteChecks.candidate.ok = 103;
    freshLiveEvidence.siteChecks.candidate.occurrences = 131;
    freshLiveEvidence.renderedTarget.baseline.byteLength = 101;
    freshLiveEvidence.renderedTarget.baseline.sha256 = 'fresh-baseline-output';
    freshLiveEvidence.renderedTarget.baseline.quoteOccurrences = 3;
    freshLiveEvidence.renderedTarget.candidate.byteLength = 102;
    freshLiveEvidence.renderedTarget.candidate.sha256 = 'fresh-candidate-output';
    freshLiveEvidence.renderedTarget.candidate.replacementOccurrences = 3;
    const fakeLiveRun = async (options) => {
      liveRunCalls += 1;
      receivedOptions = options;
      return liveRunCalls === 1 ? liveEvidence : freshLiveEvidence;
    };
    const rendered = await renderPilotAttempt({
      attemptId: 'HC-01', projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    }, { runLiveCorrection: fakeLiveRun });
    expect(receivedOptions.trustSubject).toEqual({ authorType: 'anonymous', author: '' });
    expect(receivedOptions.pinnedCommit).toBe(checkout.commit);
    expect(rendered.countsTowardPilot).toBe(false);
    expect(rendered.ownerDecisionEligible).toBe(true);
    expect(JSON.parse(await readFile(path.join(runDir, 'render-evidence.json'), 'utf8')).cleanup.completed).toBe(true);
    expect(liveRunCalls).toBe(1);

    const decision = JSON.parse(await readFile(paths.ownerDecision, 'utf8'));
    await writeFile(paths.ownerDecision, `${JSON.stringify({
      ...decision,
      decision: 'accept',
      reason: 'Fresh live verification matches the reviewed Cyberbase evidence.',
      reviewSeconds: 42,
      decidedAt: '2026-07-28T12:02:00.000Z',
    }, null, 2)}\n`, 'utf8');
    const validated = await validatePilotOwnerDecision({
      attemptId: 'HC-01', projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    }, { runLiveCorrection: fakeLiveRun });
    expect(validated.candidateDigest).toBe(evaluation.candidate.digest);
    expect(validated.ownerDecisionEligibleAtValidation).toBe(true);
    expect(liveRunCalls).toBe(2);
  });

  test('validates a bound owner self-dogfood rejection without writing or deploying', async () => {
    const attemptId = 'OD-01';
    const quote = 'Old dogfood sentence.';
    const replacement = 'New dogfood sentence.';
    const repository = 'https://github.com/cybersader/cyberbase';
    const pageUrl = 'https://example.org/cyberbase/guide';
    const checkout = await createCheckout({ repository, source: `# Guide\n\n${quote}\n` });
    const workspace = await createWorkspace();
    const paths = await writeAttempt({
      workspace,
      attemptId,
      submissionData: submission({ attemptId, quote, replacement, pageUrl }),
      operatorData: operator({
        attemptId,
        checkout,
        correctionKind: 'wording',
        overrides: {
          profile: 'owner-self-dogfood',
          publicUrl: pageUrl,
          independentOwnerAttested: false,
          publicationBoundary: 'cyberbaser',
          renderer: {
            profile: 'cyberbase-quartz-v4.5.2',
            basePath: 'cyberbase',
            buildCommand: 'renderers/quartz-cyberbase/build.sh <content-dir> <quartz-dir>',
          },
        },
      }),
    });
    const prepared = await preparePilotAttempt({
      attemptId, projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    });
    expect(prepared.evidenceClass).toBe('owner-self-dogfood');
    expect(prepared.countsTowardHumanPilot).toBe(false);
    const runDir = path.join(paths.runs, prepared.mechanicalCaseId);
    const evaluation = JSON.parse(await readFile(path.join(runDir, 'evaluation.json'), 'utf8'));
    const liveEvidence = cyberbaseLiveEvidence({ evaluation, quote, replacement });
    const fakeLiveRun = async () => liveEvidence;
    const rendered = await renderPilotAttempt({
      attemptId, projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    }, { runLiveCorrection: fakeLiveRun });
    expect(rendered.ownerDecisionEligible).toBe(true);

    const decision = JSON.parse(await readFile(paths.ownerDecision, 'utf8'));
    await writeFile(paths.ownerDecision, `${JSON.stringify({
      ...decision,
      decision: 'accept',
      reason: 'The precommitted rejection attempt must not accept.',
      reviewSeconds: 7,
      decidedAt: '2026-07-30T11:59:00.000Z',
    }, null, 2)}\n`, 'utf8');
    await expect(validatePilotOwnerDecision({
      attemptId, projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    }, { runLiveCorrection: fakeLiveRun })).rejects.toMatchObject({
      code: 'dogfood-owner-rejection-required',
    });
    await writeFile(paths.ownerDecision, `${JSON.stringify(decision, null, 2)}\n`, 'utf8');
    await writeFile(path.join(runDir, 'wizard-owner-decision.json'), `${JSON.stringify({
      ...decision,
      decision: 'reject',
      reason: 'The owner does not want this otherwise valid change.',
      reviewSeconds: 8,
      decidedAt: '2026-07-30T12:00:00.000Z',
    }, null, 2)}\n`, 'utf8');
    const observation = JSON.parse(await readFile(paths.dogfoodObservation, 'utf8'));
    expect(observation.precommittedObligations).toEqual([
      'signed-out-mobile-handoff',
      'owner-rejection',
    ]);
    await writeFile(paths.dogfoodObservation, `${JSON.stringify({
      ...observation,
      precommittedObligations: ['signed-out-mobile-handoff'],
    }, null, 2)}\n`, 'utf8');
    await expect(validatePilotOwnerDecision({
      attemptId, projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    }, { runLiveCorrection: fakeLiveRun })).rejects.toMatchObject({
      code: 'dogfood-observation-obligation-mismatch',
    });
    await writeFile(paths.dogfoodObservation, `${JSON.stringify({
      ...observation,
      readerContext: { ...observation.readerContext, device: 'Different phone' },
    }, null, 2)}\n`, 'utf8');
    await expect(validatePilotOwnerDecision({
      attemptId, projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    }, { runLiveCorrection: fakeLiveRun })).rejects.toMatchObject({
      code: 'dogfood-observation-mobile-context-mismatch',
    });
    await writeFile(paths.dogfoodObservation, `${JSON.stringify({
      ...observation,
      sourceWritePerformed: true,
    }, null, 2)}\n`, 'utf8');
    await expect(validatePilotOwnerDecision({
      attemptId, projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    }, { runLiveCorrection: fakeLiveRun })).rejects.toMatchObject({
      code: 'dogfood-observation-conflicts-with-decision-validation',
    });
    await writeFile(paths.dogfoodObservation, `${JSON.stringify({
      ...observation,
      sourceWritePerformed: false,
    }, null, 2)}\n`, 'utf8');
    const validated = await validatePilotOwnerDecision({
      attemptId, projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    }, { runLiveCorrection: fakeLiveRun });

    expect(validated).toMatchObject({
      schemaVersion: 2,
      artifactType: 'private-validated-owner-self-dogfood-decision',
      decision: 'reject',
      evidenceClass: 'owner-self-dogfood',
      countsTowardHumanPilot: false,
      independentOwnerEvidence: false,
      sourceWritePerformed: false,
      publicDeploymentPerformed: false,
      countsTowardPilot: false,
      dogfoodObservationAtValidation: {
        attemptId,
        sourceWritePerformed: false,
        publicDeploymentPerformed: false,
        liveVerificationPerformed: false,
      },
    });
    await expect(validatePilotOwnerDecision({
      attemptId, projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    }, { runLiveCorrection: fakeLiveRun })).rejects.toMatchObject({
      code: 'artifact-already-exists',
    });
    const retained = JSON.parse(await readFile(
      path.join(runDir, 'validated-owner-decision.json'),
      'utf8',
    ));
    expect(retained.decision).toBe('reject');
    expect(await command(['git', 'status', '--porcelain=v1', '--untracked-files=all'], checkout.root)).toBe('');
  }, 60_000);

  test('rejects a Cyberbase decision after blocked render evidence and status are tampered eligible', async () => {
    const quote = 'Old blocked Cyberbase sentence.';
    const replacement = 'New blocked Cyberbase sentence.';
    const repository = 'https://github.com/cybersader/cyberbase';
    const pageUrl = 'https://example.org/cyberbase/guide';
    const checkout = await createCheckout({ repository, source: `# Guide\n\n${quote}\n` });
    const workspace = await createWorkspace();
    const paths = await writeAttempt({
      workspace,
      submissionData: submission({ quote, replacement, pageUrl }),
      operatorData: operator({
        checkout,
        correctionKind: 'wording',
        overrides: {
          profile: 'cyberbase-rehearsal',
          publicUrl: pageUrl,
          independentOwnerAttested: false,
          publicationBoundary: 'cyberbaser',
          renderer: {
            profile: 'cyberbase-quartz-v4.5.2',
            basePath: 'cyberbase',
            buildCommand: 'renderers/quartz-cyberbase/build.sh <content-dir> <quartz-dir>',
          },
        },
      }),
    });
    const prepared = await preparePilotAttempt({
      attemptId: 'HC-01', projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    });
    const runDir = path.join(paths.runs, prepared.mechanicalCaseId);
    const evaluation = JSON.parse(await readFile(path.join(runDir, 'evaluation.json'), 'utf8'));
    const blockedEvidence = cyberbaseLiveEvidence({ evaluation, quote, replacement, candidateOnly: 1 });
    let liveRunCalls = 0;
    const fakeLiveRun = async () => {
      liveRunCalls += 1;
      return blockedEvidence;
    };
    const rendered = await renderPilotAttempt({
      attemptId: 'HC-01', projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    }, { runLiveCorrection: fakeLiveRun });
    expect(rendered.ownerDecisionEligible).toBe(false);
    expect(rendered.blockingReasons).toContain('candidate-only-broken-links');

    const renderEvidenceFile = path.join(runDir, 'render-evidence.json');
    const tamperedEvidence = JSON.parse(await readFile(renderEvidenceFile, 'utf8'));
    tamperedEvidence.siteChecks.linkDelta.counts.candidateOnly = 0;
    await writeFile(renderEvidenceFile, `${JSON.stringify(tamperedEvidence, null, 2)}\n`, 'utf8');

    const statusFile = path.join(runDir, 'status.json');
    const tamperedStatus = JSON.parse(await readFile(statusFile, 'utf8'));
    tamperedStatus.gates.rendering = true;
    tamperedStatus.ownerDecisionEligible = true;
    tamperedStatus.blockingReasons = [];
    await writeFile(statusFile, `${JSON.stringify(tamperedStatus, null, 2)}\n`, 'utf8');

    const decision = JSON.parse(await readFile(paths.ownerDecision, 'utf8'));
    await writeFile(paths.ownerDecision, `${JSON.stringify({
      ...decision,
      decision: 'accept',
      reason: 'This forged eligible state must not validate.',
      reviewSeconds: 1,
      decidedAt: '2026-07-28T12:03:00.000Z',
    }, null, 2)}\n`, 'utf8');

    await expect(validatePilotOwnerDecision({
      attemptId: 'HC-01', projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    }, { runLiveCorrection: fakeLiveRun })).rejects.toMatchObject({ code: 'render-evidence-mismatch' });
    expect(liveRunCalls).toBe(2);
    expect(await pathExists(path.join(runDir, 'validated-owner-decision.json'))).toBe(false);
  });

  test('rejects changed Cyberbase link tuples and rendered-target safety booleans', async () => {
    const quote = 'Old safety-bound Cyberbase sentence.';
    const replacement = 'New safety-bound Cyberbase sentence.';
    const repository = 'https://github.com/cybersader/cyberbase';
    const pageUrl = 'https://example.org/cyberbase/guide';
    const checkout = await createCheckout({ repository, source: `# Guide\n\n${quote}\n` });
    const workspace = await createWorkspace();
    const paths = await writeAttempt({
      workspace,
      submissionData: submission({ quote, replacement, pageUrl }),
      operatorData: operator({
        checkout,
        correctionKind: 'wording',
        overrides: {
          profile: 'cyberbase-rehearsal',
          publicUrl: pageUrl,
          independentOwnerAttested: false,
          publicationBoundary: 'cyberbaser',
          renderer: {
            profile: 'cyberbase-quartz-v4.5.2',
            basePath: 'cyberbase',
            buildCommand: 'renderers/quartz-cyberbase/build.sh <content-dir> <quartz-dir>',
          },
        },
      }),
    });
    const prepared = await preparePilotAttempt({
      attemptId: 'HC-01', projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    });
    const runDir = path.join(paths.runs, prepared.mechanicalCaseId);
    const evaluation = JSON.parse(await readFile(path.join(runDir, 'evaluation.json'), 'utf8'));
    const liveEvidence = cyberbaseLiveEvidence({ evaluation, quote, replacement });
    let liveRunCalls = 0;
    const fakeLiveRun = async () => {
      liveRunCalls += 1;
      return liveEvidence;
    };
    const rendered = await renderPilotAttempt({
      attemptId: 'HC-01', projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    }, { runLiveCorrection: fakeLiveRun });
    expect(rendered.ownerDecisionEligible).toBe(true);

    const decision = JSON.parse(await readFile(paths.ownerDecision, 'utf8'));
    await writeFile(paths.ownerDecision, `${JSON.stringify({
      ...decision,
      decision: 'accept',
      reason: 'Safety projection mismatch tests.',
      reviewSeconds: 2,
      decidedAt: '2026-07-28T12:04:00.000Z',
    }, null, 2)}\n`, 'utf8');

    const renderEvidenceFile = path.join(runDir, 'render-evidence.json');
    const storedEvidence = JSON.parse(await readFile(renderEvidenceFile, 'utf8'));
    const changedTuple = structuredClone(storedEvidence);
    changedTuple.siteChecks.linkDelta.candidateOnly = [{
      page: 'guide.html', href: '/cyberbase/forged', decoded: '/cyberbase/forged', class: 'missing-page',
    }];
    await writeFile(renderEvidenceFile, `${JSON.stringify(changedTuple, null, 2)}\n`, 'utf8');
    await expect(validatePilotOwnerDecision({
      attemptId: 'HC-01', projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    }, { runLiveCorrection: fakeLiveRun })).rejects.toMatchObject({ code: 'render-evidence-mismatch' });

    const changedTargetSafety = structuredClone(storedEvidence);
    changedTargetSafety.renderedTarget.comparable.candidateOldTextAbsent = false;
    await writeFile(renderEvidenceFile, `${JSON.stringify(changedTargetSafety, null, 2)}\n`, 'utf8');
    await expect(validatePilotOwnerDecision({
      attemptId: 'HC-01', projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    }, { runLiveCorrection: fakeLiveRun })).rejects.toMatchObject({ code: 'render-evidence-mismatch' });
    expect(liveRunCalls).toBe(3);
    expect(await pathExists(path.join(runDir, 'validated-owner-decision.json'))).toBe(false);
  });

  test('candidate-only link findings block owner-decision eligibility', async () => {
    const quote = 'Old exact sentence.';
    const replacement = 'New exact sentence.';
    const checkout = await createCheckout({ source: `# Guide\n\n${quote}\n` });
    const workspace = await createWorkspace();
    const paths = await writeAttempt({
      workspace,
      submissionData: submission({ quote, replacement }),
      operatorData: operator({ checkout, correctionKind: 'wording' }),
    });
    const prepared = await preparePilotAttempt({
      attemptId: 'HC-01', projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    });
    const baseline = await mkdtemp(path.join(os.tmpdir(), 'pilot-baseline-site-'));
    const candidate = await mkdtemp(path.join(os.tmpdir(), 'pilot-candidate-site-'));
    cleanup.push(baseline, candidate);
    await writeFile(path.join(baseline, 'guide.html'), `<p>${quote}</p>`, 'utf8');
    await writeFile(path.join(candidate, 'guide.html'), `<p>${replacement}</p><a href="/kb/new-missing">new</a>`, 'utf8');
    await completeRenderAttestation({
      paths,
      mechanicalCaseId: prepared.mechanicalCaseId,
      baselineSite: baseline,
      candidateSite: candidate,
    });

    const rendered = await renderPilotAttempt({
      attemptId: 'HC-01', baselineSite: baseline, candidateSite: candidate,
      projectRoot: PROJECT_ROOT, workspaceRoot: workspace,
    });
    expect(rendered.ownerDecisionEligible).toBe(false);
    expect(rendered.blockingReasons).toContain('candidate-only-broken-links');
  });
});
