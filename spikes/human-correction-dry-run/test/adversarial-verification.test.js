import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  adversarialVerificationJson,
  runAdversarialVerification,
} from '../src/adversarial-verification.js';
import { validateEligibleOwnerDecisionBinding } from '../src/pilot-run.js';

const PROJECT_ROOT = path.resolve(import.meta.dir, '../../..');

function decision(overrides = {}) {
  return {
    schemaVersion: 1,
    attemptId: 'HC-99',
    mechanicalCaseId: 'DRY-111111111111',
    candidateDigest: 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:',
    decision: 'reject',
    reason: 'Synthetic decision binding fixture.',
    reviewSeconds: 0,
    decidedAt: '2000-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('synthetic mechanical adversarial verifier', () => {
  test('emits three passing non-human scenarios', async () => {
    const report = await runAdversarialVerification();
    expect(report).toMatchObject({
      schemaVersion: 1,
      artifactType: 'synthetic-mechanical-adversarial-verification',
      runner: 'human-correction-dry-run/adversarial-v1',
      complete: true,
      evidenceClassification: {
        evidenceClass: 'synthetic-mechanical-adversarial',
        synthetic: true,
        mechanical: true,
        createsHumanOwnerDecision: false,
        countsTowardOwnerSelfDogfood: false,
        countsTowardHumanPilot: false,
        independentOwnerEvidence: false,
      },
    });
    expect(report.scenarios.map((scenario) => scenario.id)).toEqual([
      'ADV-AMBIGUOUS-01',
      'ADV-REJECTION-BINDING-01',
      'ADV-STALE-01',
    ]);
    expect(report.scenarios.every((scenario) => scenario.status === 'PASS')).toBe(true);
    const rejection = report.scenarios.find(
      (scenario) => scenario.id === 'ADV-REJECTION-BINDING-01',
    );
    expect(rejection.mechanics).toMatchObject({
      syntheticDecisionFixture: true,
      createsHumanOwnerDecision: false,
      validatedHumanOwnerDecisionArtifactCreated: false,
    });
  }, 30_000);

  test('is byte-stable and contains no owner attempt or runtime data', async () => {
    const first = await adversarialVerificationJson();
    const second = await adversarialVerificationJson();
    expect(first).toBe(second);
    expect(first).not.toMatch(/OD-\d/u);
    expect(first).not.toMatch(/\/tmp\/|\\tmp\\|"pid"|"createdAt"|"verifiedAt"/u);
  }, 30_000);

  test('CLI emits only complete JSON', async () => {
    const child = Bun.spawn([
      'bun',
      'run',
      './spikes/human-correction-dry-run/bin/verify-adversarial.js',
    ], {
      cwd: PROJECT_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({ complete: true });
  }, 30_000);

  test('pure decision binding rejects ineligible, mismatched, and non-reject fixtures', () => {
    const binding = {
      attemptId: 'HC-99',
      mechanicalCaseId: 'DRY-111111111111',
      candidateDigest: 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:',
      ownerDecisionEligible: true,
      requiredDecision: 'reject',
    };
    expect(validateEligibleOwnerDecisionBinding(decision(), binding).decision).toBe('reject');
    expect(() => validateEligibleOwnerDecisionBinding(decision(), {
      ...binding,
      ownerDecisionEligible: false,
    })).toThrow(/eligible candidate/u);
    expect(() => validateEligibleOwnerDecisionBinding(decision({
      candidateDigest: 'sha-256=:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=:',
    }), binding)).toThrow(/does not match/u);
    expect(() => validateEligibleOwnerDecisionBinding(decision({ decision: 'accept' }), binding))
      .toThrow(/reject decision/u);
  });
});
