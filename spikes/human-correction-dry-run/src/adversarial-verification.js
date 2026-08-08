import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  applyCorrection,
  CorrectionError,
  prepareCorrection,
} from '@cyberbaser/correction';
import { caseId, stableStringify } from './case.js';
import { evaluateCorrection } from './evaluate.js';
import { inspectCheckout } from './live-run.js';
import { validateEligibleOwnerDecisionBinding } from './pilot-run.js';
import { SYNTHETIC_OWNER_POLICY } from './verification.js';

const execFileAsync = promisify(execFile);
const REPOSITORY = 'https://example.org/synthetic-adversarial-kb';
const SOURCE_PATH = 'docs/guide.md';
const POLICY_REVISION = 'synthetic-adversarial-policy-v1';

const EVIDENCE_CLASSIFICATION = Object.freeze({
  evidenceClass: 'synthetic-mechanical-adversarial',
  synthetic: true,
  mechanical: true,
  createsHumanOwnerDecision: false,
  countsTowardOwnerSelfDogfood: false,
  countsTowardHumanPilot: false,
  independentOwnerEvidence: false,
  claimBoundary: 'deterministic harness safety coverage only',
});

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    },
  });
  return stdout.trim();
}

async function createRepository(root, source) {
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, SOURCE_PATH), source, 'utf8');
  await writeFile(path.join(root, 'publish.yml'), 'allow:\n  - "docs/**"\n', 'utf8');
  await git(root, ['init', '-q']);
  await git(root, ['config', 'user.email', 'synthetic@example.invalid']);
  await git(root, ['config', 'user.name', 'Synthetic Verification']);
  await git(root, ['remote', 'add', 'origin', REPOSITORY]);
  await git(root, ['add', '.']);
  await git(root, ['commit', '-q', '-m', 'fixture base']);
  return git(root, ['rev-parse', 'HEAD']);
}

function codeFor(error) {
  return error instanceof CorrectionError
    ? error.code
    : error?.code ?? error?.name ?? 'unknown-error';
}

function selector(caseData) {
  return {
    quote: caseData.quote,
    ...(Object.hasOwn(caseData, 'prefix') ? { prefix: caseData.prefix } : {}),
    ...(Object.hasOwn(caseData, 'suffix') ? { suffix: caseData.suffix } : {}),
  };
}

function safety(overrides = {}) {
  return {
    candidateReturned: false,
    ownerDecisionEligible: false,
    sourceApplicationPerformed: false,
    deploymentPerformed: false,
    ...overrides,
  };
}

async function staleScenario(root) {
  const source = '# Guide\n\nUnique target sentence.\n\nFooter alpha.\n';
  const baseCommit = await createRepository(root, source);
  const caseData = {
    repository: REPOSITORY,
    baseCommit,
    sourcePath: SOURCE_PATH,
    publicUrl: 'https://example.org/guide',
    quote: 'Unique target sentence.',
    replacement: 'Updated target sentence.',
    rationale: 'Synthetic stale-source verification.',
    evidence: ['Synthetic fixture.'],
    kind: 'wording',
  };
  const baseBytes = await readFile(path.join(root, SOURCE_PATH));
  const correction = prepareCorrection(baseBytes, {
    selector: selector(caseData),
    replacement: caseData.replacement,
  });
  const mutated = Buffer.from(source.replace('Footer alpha.', 'Footer bravo.'), 'utf8');
  await writeFile(path.join(root, SOURCE_PATH), mutated);
  await git(root, ['add', SOURCE_PATH]);
  await git(root, ['commit', '-q', '-m', 'advance source outside quote']);

  let terminalErrorCode = 'no-error';
  try {
    await inspectCheckout({
      checkoutDir: root,
      pinnedCommit: baseCommit,
      repository: REPOSITORY,
      sourcePath: SOURCE_PATH,
    });
  } catch (error) {
    terminalErrorCode = codeFor(error);
  }

  let representationErrorCode = 'no-error';
  try {
    applyCorrection(mutated, correction);
  } catch (error) {
    representationErrorCode = codeFor(error);
  }

  const quoteOccurrences = mutated.toString('utf8').split(caseData.quote).length - 1;
  return {
    pass: terminalErrorCode === 'checkout-commit-mismatch'
      && representationErrorCode === 'base-digest-mismatch'
      && mutated.length === baseBytes.length
      && quoteOccurrences === 1,
    expected: {
      terminalState: 'blocked',
      terminalErrorCode: 'checkout-commit-mismatch',
      representationErrorCode: 'base-digest-mismatch',
    },
    observed: {
      terminalState: 'blocked',
      terminalErrorCode,
      representationErrorCode,
    },
    mechanics: {
      sameByteLengthMutation: mutated.length === baseBytes.length,
      mutationOutsideSelectedQuote: true,
      quoteStillUnique: quoteOccurrences === 1,
    },
    safety: safety(),
  };
}

async function ambiguousScenario(root) {
  const source = '# Guide\n\nteh response owner.\n\nEscalate teh response owner.\n';
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, SOURCE_PATH), source, 'utf8');
  const before = await readFile(path.join(root, SOURCE_PATH));
  const caseData = {
    repository: REPOSITORY,
    baseCommit: '2222222222222222222222222222222222222222',
    sourcePath: SOURCE_PATH,
    publicUrl: 'https://example.org/ambiguous',
    quote: 'teh',
    replacement: 'the',
    rationale: 'Synthetic ambiguity verification.',
    evidence: ['Synthetic fixture contains the quote twice.'],
    kind: 'typo',
  };
  let errorCode = 'no-error';
  let evaluationReturned = false;
  try {
    await evaluateCorrection({
      caseData,
      checkoutDir: root,
      ownerPolicy: SYNTHETIC_OWNER_POLICY,
      policyRevision: POLICY_REVISION,
    });
    evaluationReturned = true;
  } catch (error) {
    errorCode = codeFor(error);
  }
  const after = await readFile(path.join(root, SOURCE_PATH));
  return {
    pass: errorCode === 'quote-ambiguous'
      && evaluationReturned === false
      && before.equals(after),
    expected: { terminalState: 'blocked', errorCode: 'quote-ambiguous' },
    observed: { terminalState: 'blocked', errorCode },
    mechanics: {
      exactQuoteOccurrences: 2,
      evaluationReturned,
      sourceBytesUnchanged: before.equals(after),
      runArtifactsCreated: false,
    },
    safety: safety(),
  };
}

async function rejectionBindingScenario(root) {
  const source = '# Guide\n\nSynthetic target sentence.\n';
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, SOURCE_PATH), source, 'utf8');
  const caseData = {
    repository: REPOSITORY,
    baseCommit: '3333333333333333333333333333333333333333',
    sourcePath: SOURCE_PATH,
    publicUrl: 'https://example.org/rejection',
    quote: 'Synthetic target sentence.',
    replacement: 'Synthetic revised sentence.',
    rationale: 'Synthetic rejection-binding verification.',
    evidence: ['Synthetic fixture.'],
    kind: 'wording',
  };
  const evaluation = await evaluateCorrection({
    caseData,
    checkoutDir: root,
    ownerPolicy: SYNTHETIC_OWNER_POLICY,
    policyRevision: POLICY_REVISION,
  });
  const decisionInput = {
    schemaVersion: 1,
    attemptId: 'HC-99',
    mechanicalCaseId: caseId(caseData),
    candidateDigest: evaluation.candidate.digest,
    decision: 'reject',
    reason: 'Synthetic rejection fixture for decision-binding mechanics.',
    reviewSeconds: 0,
    decidedAt: '2000-01-01T00:00:00.000Z',
  };
  const decision = validateEligibleOwnerDecisionBinding(decisionInput, {
    attemptId: 'HC-99',
    mechanicalCaseId: evaluation.caseId,
    candidateDigest: evaluation.candidate.digest,
    ownerDecisionEligible: true,
    requiredDecision: 'reject',
  });
  const bound = decision.attemptId === 'HC-99'
    && decision.mechanicalCaseId === evaluation.caseId
    && decision.candidateDigest === evaluation.candidate.digest
    && decision.decision === 'reject';
  return {
    pass: bound,
    expected: { terminalState: 'rejected', decision: 'reject' },
    observed: { terminalState: 'rejected', decision: decision.decision },
    mechanics: {
      mechanicallyEligibleFixture: true,
      attemptCaseAndDigestBound: bound,
      syntheticDecisionFixture: true,
      createsHumanOwnerDecision: false,
      validatedHumanOwnerDecisionArtifactCreated: false,
    },
    safety: safety({ candidateReturned: true, ownerDecisionEligible: true }),
  };
}

async function runScenario(id, obligation, action) {
  const root = await mkdtemp(path.join(os.tmpdir(), `cb-${id.toLowerCase()}-`));
  try {
    const result = await action(root);
    return {
      id,
      obligation,
      status: result.pass ? 'PASS' : 'FAIL',
      expected: result.expected,
      observed: result.observed,
      mechanics: result.mechanics,
      safety: result.safety,
    };
  } catch (error) {
    return {
      id,
      obligation,
      status: 'FAIL',
      expected: { terminalState: 'known-safe-outcome' },
      observed: { terminalState: 'runner-error', errorCode: codeFor(error) },
      mechanics: {},
      safety: safety(),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runAdversarialVerification() {
  const scenarios = [
    await runScenario('ADV-STALE-01', 'stale-source', staleScenario),
    await runScenario('ADV-AMBIGUOUS-01', 'ambiguous-quote', ambiguousScenario),
    await runScenario(
      'ADV-REJECTION-BINDING-01',
      'rejection-path-binding',
      rejectionBindingScenario,
    ),
  ].sort((left, right) => left.id.localeCompare(right.id));
  return {
    schemaVersion: 1,
    artifactType: 'synthetic-mechanical-adversarial-verification',
    runner: 'human-correction-dry-run/adversarial-v1',
    evidenceClassification: { ...EVIDENCE_CLASSIFICATION },
    complete: scenarios.every((scenario) => scenario.status === 'PASS'),
    scenarios,
  };
}

export async function adversarialVerificationJson() {
  return stableStringify(await runAdversarialVerification());
}
