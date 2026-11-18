import {
  applyProposal,
  classifyProposal,
  parseProposal,
  prepareProposal,
  proposalDigest,
  serializeProposal,
  createChangeSetProposal, validateChangeSetProposal, serializeChangeSetProposal,
  changeSetProposalDigest, classifyChangeSetProposal,
} from '@cyberbaser/proposal';
import {
  asBuffer,
  deepFreeze,
  fail,
  normalizeUtcSecond,
} from './contract.js';
import { validateVersionedIntent } from './suggestion-intent.js';

function requireResolver(value, label) {
  if (!value || typeof value.resolve !== 'function') {
    fail('invalid-resolver', `${label} must provide resolve()`);
  }
  return value;
}

function exactSelector(selection) {
  return {
    quote: selection.quote,
    ...(selection.prefix === null ? {} : { prefix: selection.prefix }),
    ...(selection.suffix === null ? {} : { suffix: selection.suffix }),
  };
}

function normalizeGitEvidence(value, binding) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid-git-evidence', 'git resolver must return exact source and policy evidence');
  }
  const baseBytes = asBuffer(value.baseBytes, 'resolved base bytes');
  const policy = value.policy;
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    fail('invalid-policy-evidence', 'git resolver must return base trust policy evidence');
  }
  if (!['valid', 'missing', 'malformed'].includes(policy.status)) {
    fail('invalid-policy-evidence', 'git resolver returned an invalid trust policy status');
  }
  if (
    policy.status !== binding.manifest.trustPolicy.status
    || policy.digest !== binding.manifest.trustPolicy.digest
  ) {
    fail('trust-policy-binding-mismatch', 'resolved trust policy contradicts the publication binding');
  }
  if (policy.status === 'valid' && (policy.config === null || typeof policy.config !== 'object')) {
    fail('invalid-policy-evidence', 'valid trust policy evidence must contain parsed configuration');
  }
  if (policy.status !== 'valid' && policy.config !== null) {
    fail('invalid-policy-evidence', 'missing or malformed policy evidence must not contain configuration');
  }
  return { baseBytes, policy };
}

function sanitizedBinding(binding) {
  return {
    bindingDigest: binding.bindingDigest,
    pageId: binding.page.pageId,
    source: {
      repository: binding.manifest.source.repository,
      revision: binding.manifest.source.revision,
      path: binding.page.path,
      byteLength: binding.page.byteLength,
      digest: binding.page.digest,
    },
    publication: { ...binding.manifest.publication },
    renderer: { ...binding.manifest.renderer },
    trustPolicy: { ...binding.manifest.trustPolicy },
  };
}

export async function deriveAccountFreeProposal({
  intent: inputIntent,
  bindings: inputBindings,
  git: inputGit,
  proposalId,
  submittedAt,
} = {}) {
  const intent = validateVersionedIntent(inputIntent);
  const bindings = requireResolver(inputBindings, 'bindings');
  const git = requireResolver(inputGit, 'git');
  const timestamp = normalizeUtcSecond(submittedAt, 'submittedAt');
  const binding = await bindings.resolve(intent.bindingDigest, intent.pageId);
  if (
    binding === null
    || typeof binding !== 'object'
    || binding.bindingDigest !== intent.bindingDigest
    || binding.page?.pageId !== intent.pageId
  ) {
    fail('unresolvable-binding', 'publication binding could not be resolved');
  }
  const evidence = normalizeGitEvidence(await git.resolve(binding), binding);
  const source = {
    repository: binding.manifest.source.repository,
    revision: binding.manifest.source.revision,
    path: binding.page.path,
  };
  const submission = {
    submittedAt: timestamp, rationale: intent.rationale ?? 'Suggested edits.',
    evidence: [...intent.evidence], identityClaim: null,
  };
  const isV2 = intent.schemaVersion === 2;
  const proposal = isV2 ? createChangeSetProposal(evidence.baseBytes, {
    proposalId, source, operations: intent.operations, submission,
  }) : prepareProposal(evidence.baseBytes, {
    proposalId,
    source,
    operation: {
      type: 'quote',
      selector: exactSelector(intent.selection),
      replacement: intent.replacement,
    },
    submission,
  });
  const proposalText = isV2 ? serializeChangeSetProposal(proposal) : serializeProposal(proposal);
  const reparsed = isV2 ? validateChangeSetProposal(JSON.parse(proposalText), evidence.baseBytes) : parseProposal(proposalText);
  if (!isV2) applyProposal(evidence.baseBytes, reparsed);
  const classification = (isV2 ? classifyChangeSetProposal : classifyProposal)(
    evidence.baseBytes,
    reparsed,
    evidence.policy.status === 'valid' ? evidence.policy.config : null,
  );
  if (
    reparsed.submission.identityClaim !== null
    || classification.route !== 'full-review'
    || (evidence.policy.status === 'valid' && classification.tier !== 'anonymous')
  ) {
    fail('anonymous-route-invariant', 'account-free proposals must remain at the anonymous full-review floor');
  }
  return deepFreeze({
    proposal: reparsed,
    proposalText,
    proposalDigest: isV2 ? changeSetProposalDigest(reparsed) : proposalDigest(reparsed),
    verifiedSubject: null,
    basePolicy: {
      status: evidence.policy.status,
      digest: evidence.policy.digest,
    },
    classification,
    binding: sanitizedBinding(binding),
    idempotencyKey: intent.idempotencyKey,
  });
}
