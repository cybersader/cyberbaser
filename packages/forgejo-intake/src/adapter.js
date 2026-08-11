import { deriveContiguousCorrection } from '@cyberbaser/correction';
import {
  applyProposal,
  classifyProposal,
  prepareProposal,
  proposalDigest,
  serializeProposal,
} from '@cyberbaser/proposal';
import {
  deepFreeze,
  decodeUtf8,
  fail,
  FORGEJO_INTAKE_MAX_BLOB_BYTES,
  normalizeUtcSecond,
  requireDecimalId,
  requirePositiveInteger,
  requireSha,
  requireString,
} from './contract.js';
import { validateForgejoIntakeConfig } from './config.js';

const MAX_SPAN_BYTES = 64 * 1024;

function requireApi(api) {
  if (!api || typeof api.readPullRequest !== 'function') {
    fail('invalid-forgejo-api', 'api must provide readPullRequest()');
  }
  return api;
}

function requireGit(git) {
  if (!git || typeof git.readPullRequest !== 'function') {
    fail('invalid-forgejo-git-reader', 'git must provide readPullRequest()');
  }
  return git;
}

function normalizeRationale(titleValue, bodyValue) {
  const title = requireString(titleValue, 'pull_request.title', {
    maxBytes: 8 * 1024,
    rejectControls: false,
  }).replace(/\r\n/gu, '\n');
  const body = requireString(bodyValue ?? '', 'pull_request.body', {
    nonEmpty: false,
    maxBytes: 32 * 1024,
    rejectControls: false,
  }).replace(/\r\n/gu, '\n');
  if (title.includes('\r') || body.includes('\r')) {
    fail('invalid-rationale', 'Forgejo title and body must not contain lone carriage returns');
  }
  if (title.trim().length === 0) fail('invalid-rationale', 'Forgejo pull request title must not be blank');
  return body.trim().length === 0 ? title : `${title}\n\n${body}`;
}

function normalizeSnapshot(value, config, pullRequestNumber) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid-forgejo-snapshot', 'Forgejo snapshot must be an object');
  }
  const repositoryId = requireDecimalId(value.repository?.id, 'snapshot.repository.id');
  if (value.repository?.fullName !== config.repository.fullName) {
    fail('forgejo-repository-mismatch', 'snapshot repository does not match owner configuration');
  }
  if (value.pullRequest?.number !== pullRequestNumber) {
    fail('pull-request-number-mismatch', 'snapshot pull request number does not match invocation');
  }
  const authorId = requireDecimalId(value.pullRequest?.author?.id, 'snapshot.pullRequest.author.id');
  return {
    instanceVersion: requireString(value.instanceVersion, 'snapshot.instanceVersion', { maxBytes: 128 }),
    repositoryId,
    pullRequest: {
      number: pullRequestNumber,
      url: requireString(value.pullRequest.url, 'snapshot.pullRequest.url', { maxBytes: 2048 }),
      title: value.pullRequest.title,
      body: value.pullRequest.body,
      createdAt: value.pullRequest.createdAt,
      baseSha: requireSha(value.pullRequest.baseSha, 'snapshot.pullRequest.baseSha'),
      headSha: requireSha(value.pullRequest.headSha, 'snapshot.pullRequest.headSha'),
      author: {
        id: authorId,
        login: requireString(value.pullRequest.author.login, 'snapshot.pullRequest.author.login', {
          maxBytes: 100,
        }),
      },
    },
  };
}

function normalizeGitEvidence(value, snapshot) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid-git-evidence', 'Git evidence must be an object');
  }
  if (value.baseSha !== snapshot.pullRequest.baseSha || value.headSha !== snapshot.pullRequest.headSha) {
    fail('git-evidence-sha-mismatch', 'Git evidence does not match Forgejo base and head SHAs');
  }
  if (!Buffer.isBuffer(value.baseBytes) || !Buffer.isBuffer(value.headBytes)) {
    fail('invalid-git-evidence', 'Git evidence must contain exact base and head bytes');
  }
  if (value.policy === null || typeof value.policy !== 'object' || Array.isArray(value.policy)) {
    fail('invalid-git-evidence', 'Git evidence must contain base-bound trust policy status');
  }
  if (!new Set(['valid', 'missing', 'malformed']).has(value.policy.status)) {
    fail('invalid-policy-status', 'Git evidence has an invalid trust policy status');
  }
  if (
    value.policy.status === 'valid'
      ? (typeof value.policy.digest !== 'string' || value.policy.config === null)
      : (value.policy.digest !== null || value.policy.config !== null)
  ) {
    fail('invalid-policy-evidence', 'Git trust policy evidence is inconsistent');
  }
  return {
    baseSha: value.baseSha,
    headSha: value.headSha,
    path: requireString(value.path, 'gitEvidence.path', { maxBytes: 4096 }),
    baseBytes: Buffer.from(value.baseBytes),
    headBytes: Buffer.from(value.headBytes),
    policy: value.policy,
  };
}

export function deriveForgejoPullRequestProposal({
  config: inputConfig,
  pullRequestNumber,
  snapshot: inputSnapshot,
  gitEvidence: inputGitEvidence,
} = {}) {
  const config = validateForgejoIntakeConfig(inputConfig);
  const number = requirePositiveInteger(pullRequestNumber, 'pullRequestNumber');
  const snapshot = normalizeSnapshot(inputSnapshot, config, number);
  const gitEvidence = normalizeGitEvidence(inputGitEvidence, snapshot);
  const editedText = decodeUtf8(gitEvidence.headBytes, 'head Markdown bytes');
  const correction = deriveContiguousCorrection(
    gitEvidence.baseBytes,
    editedText,
    {
      maxBaseBytes: FORGEJO_INTAKE_MAX_BLOB_BYTES,
      maxEditedBytes: FORGEJO_INTAKE_MAX_BLOB_BYTES,
      maxOldBytes: MAX_SPAN_BYTES,
      maxReplacementBytes: MAX_SPAN_BYTES,
      maxChangedBytes: MAX_SPAN_BYTES,
    },
  );
  const origin = new URL(config.repository.url).origin;
  const verifiedSubject = {
    author: `forgejo:${origin}#user=${snapshot.pullRequest.author.id}`,
    authorType: 'human',
  };
  const proposal = prepareProposal(gitEvidence.baseBytes, {
    proposalId: `forgejo-pr:${snapshot.repositoryId}:${number}:${snapshot.pullRequest.headSha}`,
    source: {
      repository: config.repository.url,
      revision: snapshot.pullRequest.baseSha,
      path: gitEvidence.path,
    },
    operation: {
      type: 'offset',
      start: correction.start,
      end: correction.end,
      replacement: decodeUtf8(correction.replacementBytes, 'derived replacement bytes'),
    },
    submission: {
      submittedAt: normalizeUtcSecond(snapshot.pullRequest.createdAt, 'pull_request.created_at'),
      rationale: normalizeRationale(snapshot.pullRequest.title, snapshot.pullRequest.body),
      evidence: [],
      identityClaim: {
        type: 'human',
        issuer: `${origin}/`,
        subject: `user:${snapshot.pullRequest.author.id}`,
      },
    },
  });
  const candidate = applyProposal(gitEvidence.baseBytes, proposal);
  if (!candidate.equals(gitEvidence.headBytes)) {
    fail('proposal-candidate-mismatch', 'canonical proposal does not reproduce the exact PR head blob');
  }
  const proposalText = serializeProposal(proposal);
  const digest = proposalDigest(proposal);
  const policyConfig = gitEvidence.policy.status === 'valid'
    ? gitEvidence.policy.config
    : null;
  const classification = classifyProposal(
    gitEvidence.baseBytes,
    proposal,
    policyConfig,
    verifiedSubject,
  );

  return deepFreeze({
    proposal,
    proposalText,
    proposalDigest: digest,
    verifiedSubject,
    trust: {
      policyStatus: gitEvidence.policy.status,
      policyDigest: gitEvidence.policy.digest,
      classification,
    },
    carrier: {
      provider: 'forgejo',
      instanceVersion: snapshot.instanceVersion,
      repositoryId: snapshot.repositoryId,
      repository: config.repository.fullName,
      pullRequestNumber: number,
      pullRequestUrl: snapshot.pullRequest.url,
      baseSha: snapshot.pullRequest.baseSha,
      headSha: snapshot.pullRequest.headSha,
      author: {
        id: snapshot.pullRequest.author.id,
        login: snapshot.pullRequest.author.login,
      },
    },
  });
}

export async function readForgejoPullRequestProposal({
  config,
  pullRequestNumber,
  api: inputApi,
  git: inputGit,
  remote = 'origin',
  signal,
} = {}) {
  const normalizedConfig = validateForgejoIntakeConfig(config);
  const canonicalConfig = deepFreeze({
    schemaVersion: normalizedConfig.schemaVersion,
    forgejo: {
      apiBaseUrl: normalizedConfig.forgejo.apiBaseUrl,
    },
    repository: {
      url: normalizedConfig.repository.url,
      owner: normalizedConfig.repository.owner,
      name: normalizedConfig.repository.name,
      baseBranch: normalizedConfig.repository.baseBranch,
    },
  });
  const number = requirePositiveInteger(pullRequestNumber, 'pullRequestNumber');
  const api = requireApi(inputApi);
  const git = requireGit(inputGit);
  const snapshot = await api.readPullRequest({
    config: canonicalConfig,
    pullRequestNumber: number,
    signal,
  });
  const gitEvidence = await git.readPullRequest({
    config: canonicalConfig,
    pullRequestNumber: number,
    baseSha: snapshot.pullRequest.baseSha,
    headSha: snapshot.pullRequest.headSha,
    remote,
  });
  return deriveForgejoPullRequestProposal({
    config: canonicalConfig,
    pullRequestNumber: number,
    snapshot,
    gitEvidence,
  });
}
