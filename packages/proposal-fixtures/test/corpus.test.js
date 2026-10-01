import { expect, test } from 'bun:test';
import { applyProposal, parseProposal, prepareProposal, PROPOSAL_MAX_BYTES, PROPOSAL_MAX_SPAN_BYTES } from '@cyberbaser/proposal';
import {
  allFixtures, buildResearchCandidate, corpusReport, materializeExecutableV1Fixture,
  negativeAdversarialFixtures, primaryFixtures, validateFixture, validateResearchChangeSet,
} from '../src/index.js';

const effectKeys = ['recordsDecision', 'changesQueueLifecycle', 'appliesSource', 'writesSource', 'commits', 'pushes', 'rebuilds', 'deploys', 'publishes'];

function expectFixtureFailure(fixture, code) {
  try {
    validateFixture(fixture);
    throw new Error(`fixture unexpectedly passed instead of ${code}`);
  } catch (error) {
    expect(error.code).toBe(code);
  }
}

test('validates exactly 21 primary fixtures plus all adversarial variants without claim inflation', () => {
  expect(primaryFixtures).toHaveLength(21);
  expect(negativeAdversarialFixtures.length).toBeGreaterThanOrEqual(13);
  expect(allFixtures).toHaveLength(corpusReport.totalCount);
  expect(corpusReport.primaryCount).toBe(21);
  expect(Object.keys(corpusReport.bySupportLevel).sort()).toEqual(['authority-model-only', 'blocked-synthetic', 'conceptual-later', 'executable-v1', 'target-v2-research'].sort());
  expect(corpusReport.bySupportLevel['executable-v1']).toBe(7);
  expect(corpusReport.bySupportLevel['target-v2-research']).toBe(2);
  for (const fixture of allFixtures) {
    expect(validateFixture(fixture)).toEqual(fixture);
    expect(['synthetic-mechanical', 'static-design-only']).toContain(fixture.evidenceClass);
    expect(fixture.claimCeiling.prohibitedClaims).toEqual(expect.arrayContaining(['maintainer-comprehension', 'independent-human', 'live-effect']));
    for (const key of effectKeys) expect(fixture.expectedAuthorityEffects[key]).toBe(false);
    for (const lane of ['laneA', 'laneB']) {
      expect(fixture.laneSupport[lane].installed).toBe(false);
      expect(fixture.laneSupport[lane].offered).toBe(false);
      expect(fixture.laneSupport[lane].publiclyExposed).toBe(false);
      expect(fixture.laneSupport[lane].deployed).toBe(false);
    }
    if (['target-v2-research', 'conceptual-later', 'authority-model-only'].includes(fixture.supportLevel)) {
      for (const lane of ['laneA', 'laneB', 'sameHostOwnerReview']) expect(fixture.laneSupport[lane].representable).toBe(false);
    }
  }
});

test('all seven executable v1 fixtures use the real canonical proposal path and preserve undeclared bytes', () => {
  const fixtures = primaryFixtures.filter((fixture) => fixture.supportLevel === 'executable-v1');
  expect(fixtures).toHaveLength(7);
  for (const fixture of fixtures) {
    const materialized = materializeExecutableV1Fixture(fixture.fixtureId);
    if (fixture.fixtureId === 'v1-retention-paragraph') {
      expect(materialized.proposal.operation.end - materialized.proposal.operation.start).toBeGreaterThan(500);
      expect(fixture.exactChange.operations[0].oldText.trim().split(/\s+/u).length).toBeGreaterThanOrEqual(80);
      expect(fixture.exactChange.operations[0].replacementText.trim().split(/\s+/u).length).toBeGreaterThanOrEqual(80);
    }
    expect(materialized.fixture.exactChange.canonicalArtifact).toBe(materialized.canonicalArtifact);
    expect(parseProposal(materialized.canonicalArtifact)).toEqual(materialized.proposal);
    expect(materialized.fixture.exactChange.proposalDigest).toBe(materialized.digest);
    expect(materialized.candidate.toString('utf8')).toBe(materialized.fixture.sourceFiles[0].candidateText);
    const op = materialized.proposal.operation;
    const replacement = Buffer.from(op.replacementBytesBase64, 'base64');
    expect(materialized.candidate.subarray(0, op.start)).toEqual(materialized.base.subarray(0, op.start));
    expect(materialized.candidate.subarray(op.start + replacement.length)).toEqual(materialized.base.subarray(op.end));
    expect(op.end - op.start).toBeLessThanOrEqual(PROPOSAL_MAX_SPAN_BYTES);
    expect(replacement.length).toBeLessThanOrEqual(PROPOSAL_MAX_SPAN_BYTES);
    expect(Buffer.byteLength(materialized.canonicalArtifact)).toBeLessThanOrEqual(PROPOSAL_MAX_BYTES);
  }
});

test('executable v1 fixtures cannot fabricate file, operation, digest, source, or candidate evidence', () => {
  const fixture = primaryFixtures.find((item) => item.supportLevel === 'executable-v1');

  const twoFiles = structuredClone(fixture);
  twoFiles.fileCount = 2;
  twoFiles.sourceFiles.push({ ...structuredClone(twoFiles.sourceFiles[0]), path: 'handbook/unrelated.md' });
  expectFixtureFailure(twoFiles, 'invalid-executable-scope');

  const twoOperations = structuredClone(fixture);
  twoOperations.operationCount = 2;
  twoOperations.exactChange.operations.push({
    ...structuredClone(twoOperations.exactChange.operations[0]),
    operationId: 'fabricated-change-2',
  });
  expectFixtureFailure(twoOperations, 'invalid-executable-scope');

  const wrongDigest = structuredClone(fixture);
  wrongDigest.exactChange.proposalDigest = 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:';
  expectFixtureFailure(wrongDigest, 'executable-digest-mismatch');

  const wrongPath = structuredClone(fixture);
  wrongPath.sourceFiles[0].path = 'handbook/unrelated.md';
  wrongPath.exactChange.operations[0].path = 'handbook/unrelated.md';
  expectFixtureFailure(wrongPath, 'executable-path-mismatch');

  const wrongOperation = structuredClone(fixture);
  wrongOperation.exactChange.operations[0].replacementText += ' fabricated';
  expectFixtureFailure(wrongOperation, 'executable-operation-mismatch');

  const wrongBase = structuredClone(fixture);
  wrongBase.sourceFiles[0].baseText += '\nFabricated base mutation.\n';
  expectFixtureFailure(wrongBase, 'invalid-executable-artifact');

  const wrongCandidate = structuredClone(fixture);
  wrongCandidate.sourceFiles[0].candidateText += '\nFabricated candidate mutation.\n';
  expectFixtureFailure(wrongCandidate, 'executable-candidate-mismatch');
});

test('the specifically named materializer rejects every non-executable support level', () => {
  for (const support of ['target-v2-research', 'conceptual-later', 'blocked-synthetic', 'authority-model-only']) {
    const fixture = primaryFixtures.find((candidate) => candidate.supportLevel === support);
    expect(() => materializeExecutableV1Fixture(fixture.fixtureId)).toThrow(TypeError);
  }
});

test('target-v2 research validates canonical base-relative operations and builds one left-to-right candidate', () => {
  const targets = primaryFixtures.filter((fixture) => fixture.supportLevel === 'target-v2-research');
  for (const fixture of targets) {
    const base = Buffer.from(fixture.sourceFiles[0].baseText);
    const input = fixture.exactChange.operations.map((op) => ({ operationId: op.operationId, label: op.label, start: op.start, end: op.end, replacement: op.replacementText }));
    const validated = validateResearchChangeSet(base, input);
    const result = buildResearchCandidate(base, input);
    expect(validated.operations).toHaveLength(fixture.operationCount);
    expect(result.candidate.toString()).toBe(fixture.sourceFiles[0].candidateText);
    expect(fixture.exactChange.canonicalArtifact).toBeNull();
    expect(fixture.exactChange.executable).toBe(false);
    expect(fixture.exactChange.executionBlockReason.length).toBeGreaterThan(0);
    expect(() => parseProposal(`${JSON.stringify({ fixtureId: fixture.fixtureId, operations: input })}\n`)).toThrow();
  }
  const misordered = [
    { operationId: 'later', label: 'later', start: 4, end: 5, replacement: 'x' },
    { operationId: 'earlier', label: 'earlier', start: 1, end: 2, replacement: 'y' },
  ];
  try {
    validateResearchChangeSet(Buffer.from('abcdef'), misordered);
    throw new Error('misordered operations unexpectedly validated');
  } catch (error) {
    expect(error.code).toBe('noncanonical-order');
  }
  const base = Buffer.from('a🧭bcdef');
  expect(() => validateResearchChangeSet(base, [
    { operationId: 'a', label: 'a', start: 2, end: 2, replacement: 'x' },
    { operationId: 'b', label: 'b', start: 6, end: 7, replacement: 'y' },
  ])).toThrow();
  expect(() => validateResearchChangeSet(Buffer.from('abcdef'), [
    { operationId: 'a', label: 'a', start: 1, end: 4, replacement: 'x' },
    { operationId: 'b', label: 'b', start: 3, end: 5, replacement: 'y' },
  ])).toThrow();
  expect(() => validateResearchChangeSet(Buffer.from('abcdef'), [
    { operationId: 'a', label: 'a', start: 2, end: 2, replacement: 'x' },
    { operationId: 'b', label: 'b', start: 2, end: 2, replacement: 'y' },
  ])).toThrow();
  expect(() => validateResearchChangeSet(Buffer.from('abcdef'), [
    { operationId: 'a', label: 'a', start: 0, end: 1, replacement: 'a' },
    { operationId: 'b', label: 'b', start: 2, end: 3, replacement: 'z' },
  ])).toThrow();
});

test('conceptual and pre-admission fixtures cannot acquire executable, queue, or decision evidence', () => {
  for (const fixture of primaryFixtures.filter((item) => item.supportLevel === 'conceptual-later')) {
    expect(fixture.exactChange).toMatchObject({ executable: false, canonicalArtifact: null, proposalDigest: null, queueId: null, reviewEvidenceDigest: null, decisionId: null });
    expect(fixture.exactChange.executionBlockReason.length).toBeGreaterThan(0);
    expect(fixture.expectedPresentation.decisionControls).toBe(false);
    expect(fixture.attentionState.label).toBe('Conceptual later · no decision available');
    expect(fixture.attentionState.label).not.toContain('Needs your decision');
  }
  const preAdmissionIds = ['blocked-ambiguous-selection', 'blocked-overlapping-v2-operations', 'blocked-duplicate-start-insertions', 'credential-like-text', 'no-op-operation', 'whole-file-replacement', 'whole-file-deletion', 'invalid-utf8-boundary'];
  for (const id of preAdmissionIds) {
    const fixture = allFixtures.find((item) => item.fixtureId === id);
    expect(fixture.expectedPresentation.group).toBe('pre-admission');
    expect(fixture.operatingEvidence.queueLifecycle.state).toBe('not-admitted');
    expect(fixture.expectedPresentation.decisionControls).toBe(false);
  }
  const contradictory = structuredClone(primaryFixtures.find((item) => item.supportLevel === 'conceptual-later'));
  contradictory.attentionState.label = 'Needs your decision';
  expect(() => validateFixture(contradictory)).toThrow();
  const inflatedTarget = structuredClone(primaryFixtures.find((item) => item.supportLevel === 'target-v2-research'));
  inflatedTarget.laneSupport.sameHostOwnerReview.representable = true;
  expect(() => validateFixture(inflatedTarget)).toThrow();
});

test('identity and references stay inert, and authority models keep axes separate', () => {
  const referenceFixtures = allFixtures.filter((fixture) => fixture.intent.references.length > 0);
  for (const fixture of referenceFixtures) for (const reference of fixture.intent.references) expect(reference.verification).toBe('unverified');
  const identity = allFixtures.find((fixture) => fixture.fixtureId === 'identity-claim-no-trust');
  expect(identity.operatingEvidence.trustRoute.state).toBe('advisory');
  const approved = primaryFixtures.find((fixture) => fixture.fixtureId === 'authority-approved-not-authorized');
  expect(approved.operatingEvidence.ownerDecision.state).toBe('approved');
  expect(approved.operatingEvidence.applicationAuthority.state).toBe('absent');
  const failed = primaryFixtures.find((fixture) => fixture.fixtureId === 'authority-applied-deployment-failed');
  expect(failed.operatingEvidence.deploymentObservation.state).toBe('failed');
  expect(failed.operatingEvidence.publicationWitness.state).toBe('unconfirmed');
  for (const key of effectKeys) expect(failed.expectedAuthorityEffects[key]).toBe(false);
});

test('adversarial fixtures are backed by fail-closed current-v1 and fixture-envelope checks', () => {
  const input = (operation) => ({
    proposalId: 'fixture:negative-check',
    source: { repository: 'https://forge.example/owner/wiki.git', revision: 'fixture-revision', path: 'example.md' },
    operation,
    submission: { submittedAt: '2026-08-21T12:00:00Z', rationale: 'Negative fixture check.', evidence: [], identityClaim: null },
  });
  expect(() => prepareProposal(Buffer.from('alpha'), input({ type: 'offset', start: 1, end: 3, replacement: 'lp' }))).toThrow();
  expect(() => prepareProposal(Buffer.from('alpha'), input({ type: 'offset', start: 0, end: 5, replacement: 'omega' }))).toThrow();
  expect(() => prepareProposal(Buffer.from('a🧭b'), input({ type: 'offset', start: 2, end: 3, replacement: 'x' }))).toThrow();

  const stale = allFixtures.find((fixture) => fixture.fixtureId === 'blocked-stale-base');
  expect(stale.exactChange.canonicalArtifact).not.toBeNull();
  const historical = parseProposal(stale.exactChange.canonicalArtifact);
  expect(() => applyProposal(Buffer.from(stale.sourceFiles[0].baseText), historical)).toThrow();

  const credentialLike = structuredClone(primaryFixtures[0]);
  credentialLike.intent.rationale = 'A credential-shaped locator such as https://user:pass@example.com must fail.';
  expect(() => validateFixture(credentialLike)).toThrow();
});
