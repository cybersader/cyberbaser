import { corpusReport, getFixtureList } from '@cyberbaser/proposal-fixtures';
import { documentProjection, exposeInvisibleText } from '@cyberbaser/review-projection';

export { exposeInvisibleText };

export const SUPPORT_LABELS = Object.freeze({
  'executable-v1': { label: 'Executable v1', detail: 'Real canonical one-file, one-splice proposal mechanics.' },
  'target-v2-research': { label: 'Target capability', detail: 'Single-existing-file multi-operation research; no canonical v2 artifact.' },
  'conceptual-later': { label: 'Conceptual later', detail: 'Broader source scope shown only to expose unresolved authority and transaction questions.' },
  'blocked-synthetic': { label: 'Negative synthetic', detail: 'Failure or blocker evidence; no owner rejection is implied.' },
  'authority-model-only': { label: 'Future operational design', detail: 'Static authority-axis illustration; no effect is caused.' },
});
export const EVIDENCE_LABELS = Object.freeze({
  'synthetic-mechanical': { label: 'Synthetic mechanical', detail: 'Deterministic package or safety evidence only.' },
  'static-design-only': { label: 'Static design only', detail: 'Presentation research only; no comprehension result.' },
});
export const EVIDENCE_LEGEND = Object.freeze([
  { key: 'executable-v1', label: 'Executable v1', claim: 'Current proposal-v1 mechanics only.' },
  { key: 'target-v2-research', label: 'Target research', claim: 'Research candidate, not executable product evidence.' },
  { key: 'conceptual-later', label: 'Conceptual later', claim: 'No artifact, queue evidence, decision, or application authority.' },
  { key: 'blocked-synthetic', label: 'Negative synthetic', claim: 'Fail-closed boundary evidence; not an owner rejection.' },
  { key: 'authority-model-only', label: 'Future operational design', claim: 'Static model of separate authority and evidence axes.' },
  { key: 'maintainer-comprehension', label: 'Maintainer comprehension', claim: 'Requires a focused unaided human checkpoint; not claimed here.' },
  { key: 'independent-human', label: 'Independent human', claim: 'Requires unfamiliar-reader or independent-owner evidence; not claimed here.' },
  { key: 'live-effect', label: 'Live effect', claim: 'Requires separately authorized source, Git, deployment, and publication evidence; not claimed here.' },
]);

const SYSTEM_FRAMES = Object.freeze([
  { number: 1, title: 'Docs and contributor surface', owner: 'Knowledge owner and external contributor', runs: 'Canonical docs origin plus replaceable external surface', authority: 'Explains and proposes only; no privileged authority', evidence: 'Static design only', status: 'Docs launch this separate mockup. Portagenty is development coordination, not deployment.' },
  { number: 2, title: 'Lane-specific intake and adapter', owner: 'External lane operator', runs: 'Replaceable lane process', authority: 'Derives a bounded proposal; no source write', evidence: 'Synthetic mechanical at package layer', status: 'Lane A is not installed or offered. Lane B is disabled, local-only, unexposed, and unoffered.' },
  { number: 3, title: 'Finite private queue', owner: 'Knowledge owner', runs: 'Account-free intake process on the owner host', authority: 'Sole queue writer; lifecycle is pending-review or expired only', evidence: 'Mechanically tested locally', status: 'The queue retains evidence, not owner decisions.' },
  { number: 4, title: 'Private owner review', owner: 'Knowledge owner', runs: 'Same-host owner-alpha process over a bounded read-only Unix socket', authority: 'Independent evidence validation and decision presentation', evidence: 'Implemented and mechanically accepted in the working tree', status: 'Shared-socket OCI review is unimplemented.' },
  { number: 5, title: 'Immutable decision receipt', owner: 'Knowledge owner', runs: 'Private owner origin and ignored owner-controlled store', authority: 'Decision-only Approve or Reject intent', evidence: 'Implemented and mechanically accepted locally', status: 'Approval changes no queue lifecycle and starts no application.' },
  { number: 6, title: 'Application-authority gate', owner: 'Knowledge owner', runs: 'Not yet selected or built', authority: 'Would separately authorize fresh exact application', evidence: 'Missing future boundary', status: 'Approval alone cannot cross this gate.' },
  { number: 7, title: 'Canonical Markdown and Git', owner: 'Knowledge owner', runs: 'Owner-controlled source checkout and version history', authority: 'Canonical content and current dogfood version-history authority', evidence: 'Existing owner-controlled infrastructure', status: 'Only a separately authorized exact application may change declared bytes.' },
  { number: 8, title: 'Renderer, deployment, and live witness', owner: 'Knowledge owner with replaceable providers', runs: 'Disposable renderer/deployment spokes plus read-only witness', authority: 'Rendering and observation only; never source authority', evidence: 'Separate observational axes', status: 'Deployment success and live publication witness must remain distinct.' },
]);

function scope(fixture) {
  const pages = `${fixture.fileCount} ${fixture.fileCount === 1 ? 'page' : 'pages'}`;
  const changes = `${fixture.operationCount} exact ${fixture.operationCount === 1 ? 'change' : 'changes'}`;
  if (fixture.supportLevel === 'target-v2-research') return `${changes} in ${fixture.fileCount} existing ${fixture.fileCount === 1 ? 'page' : 'pages'} · one atomic decision · partial approval unavailable`;
  return `${changes} in ${pages}`;
}
function operationView(operation, index) {
  const insertion = operation.oldText === '';
  const deletion = operation.replacementText === '';
  return {
    number: index + 1,
    label: exposeInvisibleText(operation.label),
    path: exposeInvisibleText(operation.path),
    range: `${operation.start}–${operation.end}`,
    contextBefore: exposeInvisibleText(operation.contextBefore),
    contextAfter: exposeInvisibleText(operation.contextAfter),
    currentText: insertion ? 'No current text at this location' : exposeInvisibleText(operation.oldText),
    proposedText: deletion ? 'Notice removed here' : exposeInvisibleText(operation.replacementText),
    oldText: exposeInvisibleText(operation.oldText),
    replacementText: exposeInvisibleText(operation.replacementText),
    currentSemanticLabel: insertion ? 'No current text' : 'Removed',
    proposedSemanticLabel: deletion ? 'Absent in proposed result · Not yet approved' : 'Added · Not yet approved',
    insertion,
    deletion,
  };
}

export function fixtureView(fixture) {
  const support = SUPPORT_LABELS[fixture.supportLevel];
  const evidence = EVIDENCE_LABELS[fixture.evidenceClass];
  return Object.freeze({
    id: fixture.fixtureId,
    supportLevel: fixture.supportLevel,
    supportLabel: support.label,
    supportDetail: support.detail,
    evidenceClass: fixture.evidenceClass,
    evidenceLabel: evidence.label,
    evidenceDetail: evidence.detail,
    group: fixture.expectedPresentation.group,
    title: exposeInvisibleText(fixture.reviewProjection.title),
    titleProvenance: exposeInvisibleText(fixture.reviewProjection.titleProvenance),
    fallbackTitle: exposeInvisibleText(fixture.reviewProjection.fallbackTitle),
    identityDisclosure: exposeInvisibleText(fixture.reviewProjection.identityDisclosure),
    summary: exposeInvisibleText(fixture.reviewProjection.summary),
    rationale: exposeInvisibleText(fixture.intent.rationale),
    category: exposeInvisibleText(fixture.intent.categoryClaims.join(', ')),
    declaredScope: exposeInvisibleText(fixture.intent.declaredScope),
    actualScope: scope(fixture),
    attentionLabel: exposeInvisibleText(fixture.attentionState.label),
    attentionKind: fixture.attentionState.kind,
    blocker: exposeInvisibleText(fixture.attentionState.blocker),
    boundary: exposeInvisibleText(fixture.attentionState.boundary),
    references: fixture.intent.references.map((reference) => ({ ...reference, url: exposeInvisibleText(reference.url), label: exposeInvisibleText(reference.label) })),
    paths: fixture.sourceFiles.map((file) => ({ path: exposeInvisibleText(file.path), exists: file.exists })),
    operations: fixture.exactChange.operations.map(operationView),
    document: documentProjection({ files: fixture.sourceFiles, operations: fixture.exactChange.operations }),
    decisionControls: fixture.expectedPresentation.decisionControls,
    presentationNotes: fixture.expectedPresentation.notes.map(exposeInvisibleText),
    effects: fixture.expectedAuthorityEffects,
    operatingEvidence: Object.fromEntries(Object.entries(fixture.operatingEvidence).map(([axis, entry]) => [axis, { state: exposeInvisibleText(entry.state), explanation: exposeInvisibleText(entry.explanation) }])),
    technical: {
      proposalDigest: exposeInvisibleText(fixture.exactChange.proposalDigest),
      queueId: exposeInvisibleText(fixture.exactChange.queueId),
      reviewEvidenceDigest: exposeInvisibleText(fixture.exactChange.reviewEvidenceDigest),
      decisionId: exposeInvisibleText(fixture.exactChange.decisionId),
      canonicalArtifact: exposeInvisibleText(fixture.exactChange.canonicalArtifact),
      executionBlockReason: exposeInvisibleText(fixture.exactChange.executionBlockReason),
    },
  });
}

export function buildViewModel() {
  const fixtures = getFixtureList({ includeAdversarial: true }).map(fixtureView);
  return Object.freeze({
    generatedFor: 'static proposal-review research',
    staticFrame: 'Static concept — controls do nothing. No decision is recorded.',
    corpusReport,
    fixtures,
    groups: {
      needs: fixtures.filter((fixture) => fixture.group === 'needs'),
      blocked: fixtures.filter((fixture) => fixture.group === 'blocked'),
      decided: fixtures.filter((fixture) => fixture.group === 'decided'),
    },
    evidenceGroups: {
      conceptual: fixtures.filter((fixture) => fixture.group === 'conceptual'),
      preAdmission: fixtures.filter((fixture) => fixture.group === 'pre-admission'),
      adversarial: fixtures.filter((fixture) => fixture.group === 'adversarial'),
    },
    supportLabels: SUPPORT_LABELS,
    evidenceLabels: EVIDENCE_LABELS,
    evidenceLegend: EVIDENCE_LEGEND,
    systemFrames: SYSTEM_FRAMES,
    checkpointQuestions: [
      'What is this surface for?',
      'Which proof is Current and which is Proposed?',
      'How many pages and exact changes are in the proposal?',
      'What action is required from the owner?',
      'What does approval record, and what does it not start?',
      'How is blocked evidence different from an owner rejection?',
      'What support level and evidence class are shown?',
      'Where do intake, queue, private review, decision, application authority, Git, rendering, deployment, and publication witness live?',
    ],
  });
}

export function createReceiptPreview(fixture, action, note, decidedAt = 'Preview time · not recorded') {
  if (!fixture.decisionControls) throw new TypeError('fixture has no decision controls');
  if (!['approve', 'reject'].includes(action)) throw new TypeError('action must be approve or reject');
  if (typeof note !== 'string' || note.trim() !== note || note.length === 0) throw new TypeError('note must be nonblank and trimmed');
  return Object.freeze({
    kind: 'Private proposal decision receipt',
    result: action === 'approve' ? 'Approval recorded' : 'Proposal rejected',
    action,
    note,
    decidedAt,
    title: fixture.title,
    actualScope: fixture.actualScope,
    atomicity: fixture.operations.length > 1 ? 'One atomic decision · partial approval unavailable' : 'One exact change',
    paths: fixture.paths,
    operations: fixture.operations.map(({ number, label, path }) => ({ number, label, path })),
    supportLabel: fixture.supportLabel,
    evidenceLabel: fixture.evidenceLabel,
    sourceState: 'Source unchanged',
    noEffect: 'No application requested or started. No source write, commit, push, rebuild, deployment, or publication began. Queue lifecycle was not changed.',
    previewOnly: 'In-memory static receipt preview. Reloading removes it.',
  });
}
