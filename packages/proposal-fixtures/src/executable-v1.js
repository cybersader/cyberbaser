import {
  applyProposal, parseProposal, prepareProposal, proposalDigest, serializeProposal,
} from '@cyberbaser/proposal';
import { validateFixture } from './contract.js';
import { baseFixture, operation } from './scenarios/helpers.js';

export function buildExecutableV1Fixture(descriptor) {
  const base = Buffer.from(descriptor.baseText, 'utf8');
  const proposal = prepareProposal(base, descriptor.proposalInput);
  const canonicalArtifact = serializeProposal(proposal);
  const parsed = parseProposal(canonicalArtifact);
  const digest = proposalDigest(parsed);
  const candidate = applyProposal(base, parsed);
  if (candidate.toString('utf8') !== descriptor.candidateText) throw new Error(`${descriptor.fixtureId} declared candidate mismatch`);
  const oldBytes = Buffer.from(parsed.operation.expectedOldBytesBase64, 'base64');
  const replacementBytes = Buffer.from(parsed.operation.replacementBytesBase64, 'base64');
  if (!candidate.subarray(0, parsed.operation.start).equals(base.subarray(0, parsed.operation.start))) throw new Error(`${descriptor.fixtureId} changed its prefix`);
  if (!candidate.subarray(parsed.operation.start + replacementBytes.length).equals(base.subarray(parsed.operation.end))) throw new Error(`${descriptor.fixtureId} changed its suffix`);
  const fixture = baseFixture({
    fixtureId: descriptor.fixtureId,
    supportLevel: 'executable-v1',
    evidenceClass: 'synthetic-mechanical',
    laneSupport: descriptor.laneSupport,
    operatingEvidence: descriptor.operatingEvidence,
    intent: descriptor.intent,
    sourceFiles: [{ path: proposal.source.path, exists: true, baseText: descriptor.baseText, candidateText: descriptor.candidateText }],
    exactChange: {
      executable: true,
      canonicalArtifact,
      proposalDigest: digest,
      queueId: null,
      reviewEvidenceDigest: null,
      decisionId: null,
      executionBlockReason: null,
      operations: [operation({
        operationId: 'change-1',
        label: descriptor.operationLabel,
        path: proposal.source.path,
        start: parsed.operation.start,
        end: parsed.operation.end,
        oldText: oldBytes.toString('utf8'),
        replacementText: replacementBytes.toString('utf8'),
        contextBefore: descriptor.contextBefore,
        contextAfter: descriptor.contextAfter,
      })],
    },
    reviewProjection: descriptor.reviewProjection,
    notes: descriptor.presentationNotes ?? [],
  });
  return Object.freeze({ fixture: validateFixture(fixture), proposal: parsed, canonicalArtifact, digest, base, candidate });
}
