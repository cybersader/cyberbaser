import { buildLedgerEntry, normalizeUtcSecond } from '../ledger.js';
import {
  CAPTURE_ARTIFACT_MAX_BYTES,
  CAPTURE_HINT_SCHEMA_VERSION,
  LedgerGithubError,
  bindCaptureHint,
  parseCaptureArtifactEntries,
  parseCaptureArtifactName,
  selectCaptureArtifact,
  validateCaptureArtifactBinding,
  validateCaptureRunBinding,
} from './contract.js';
import { reconstructGitEvidence } from './git.js';

const REPOSITORY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_UNSIGNED_64 = 18_446_744_073_709_551_615n;

function fail(code, message, details = {}) {
  throw new LedgerGithubError(code, message, details);
}

function requireRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid-record', `${label} must be an object`);
  }
  return value;
}

function requireString(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length === 0) fail('invalid-string', `${label} must be a non-empty string`);
  return value;
}

function metadataId(value, label) {
  if (typeof value === 'string') {
    if (!/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > MAX_UNSIGNED_64) {
      fail('invalid-id', `${label} must be a canonical positive unsigned 64-bit decimal string`);
    }
    return value;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('unsafe-metadata-id', `${label} must be a positive safe integer or canonical decimal string`);
  }
  return String(value);
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('invalid-positive-integer', `${label} must be a positive safe integer`);
  }
  return value;
}

function requireSha(value, label) {
  if (typeof value !== 'string' || !SHA_RE.test(value)) {
    fail('invalid-git-sha', `${label} must be a lowercase 40-character Git object ID`);
  }
  return value;
}

function validateExpectedRepository(value) {
  const repository = requireRecord(value, 'expectedRepository');
  const keys = Object.keys(repository);
  if (keys.length !== 2 || !keys.includes('repositoryId') || !keys.includes('repository')) {
    fail('invalid-expected-repository', 'expectedRepository must contain exactly repositoryId and repository');
  }
  const repositoryId = metadataId(repository.repositoryId, 'expectedRepository.repositoryId');
  const name = repository.repository;
  if (typeof name !== 'string' || !REPOSITORY_RE.test(name)) {
    fail('invalid-repository', 'expectedRepository.repository must be an exact GitHub owner/repository name');
  }
  const [, repoName] = name.split('/');
  if (repoName === '.' || repoName === '..') {
    fail('invalid-repository', 'expectedRepository.repository must be an exact GitHub owner/repository name');
  }
  return { repositoryId, repository: name };
}

function requireApi(api) {
  const value = requireRecord(api, 'api');
  for (const method of ['getBytes', 'getJson', 'paginate']) {
    if (typeof value[method] !== 'function') fail('invalid-github-api', `api.${method} must be a function`);
  }
  return value;
}

function repositoryEndpoint(repository) {
  return repository.split('/').map(encodeURIComponent).join('/');
}

function validatePullRequest(value, hint, expectedRepository) {
  const pullRequest = requireRecord(value, 'pull request');
  if (pullRequest.number !== hint.prNumber) {
    fail('pull-request-number-mismatch', 'GitHub pull request number does not match the capture hint');
  }
  if (pullRequest.state !== 'closed') fail('pull-request-not-closed', 'GitHub pull request must be closed');
  if (typeof pullRequest.merged !== 'boolean') {
    fail('invalid-merged-flag', 'GitHub pull request merged must be boolean');
  }
  requireString(pullRequest.created_at, 'pull_request.created_at');
  requireString(pullRequest.closed_at, 'pull_request.closed_at');
  requireSha(pullRequest.base?.sha, 'pull_request.base.sha');
  requireSha(pullRequest.head?.sha, 'pull_request.head.sha');
  if (pullRequest.base.sha === pullRequest.head.sha) {
    fail('invalid-sha-relationship', 'pull request base and head SHAs must differ');
  }
  const baseRepository = requireRecord(pullRequest.base?.repo, 'pull_request.base.repo');
  const baseRepositoryId = metadataId(baseRepository.id, 'pull_request.base.repo.id');
  const baseRepositoryName = requireString(baseRepository.full_name, 'pull_request.base.repo.full_name');
  if (
    baseRepositoryId !== expectedRepository.repositoryId
    || baseRepositoryName !== expectedRepository.repository
  ) {
    fail('pull-request-repository-mismatch', 'pull request base repository does not match the recorder repository');
  }
  if (pullRequest.merged) {
    requireSha(pullRequest.merge_commit_sha, 'pull_request.merge_commit_sha');
    requireString(pullRequest.merged_by?.login, 'pull_request.merged_by.login');
  }
  return pullRequest;
}

function labelsFromApi(value) {
  if (!Array.isArray(value)) fail('invalid-labels-response', 'GitHub issue labels response must be an array');
  return value.map((label, index) => {
    const item = requireRecord(label, `labels[${index}]`);
    return { ...item, name: requireString(item.name, `labels[${index}].name`) };
  });
}

function checkRunsFromApi(value) {
  if (!Array.isArray(value)) fail('invalid-check-runs-response', 'GitHub check runs response must be an array');
  return value.map((run, index) => requireRecord(run, `checkRuns[${index}]`));
}

function sameLogin(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

export function reconstructClosedUnmergedActor(timeline, closedAt) {
  if (!Array.isArray(timeline)) fail('invalid-timeline-response', 'GitHub issue timeline response must be an array');
  const normalizedClosedAt = normalizeUtcSecond(closedAt, 'pull_request.closed_at');
  const matches = [];
  for (const [index, event] of timeline.entries()) {
    const item = requireRecord(event, `timeline[${index}]`);
    if (item.event !== 'closed') continue;
    const createdAt = normalizeUtcSecond(item.created_at, `timeline[${index}].created_at`);
    if (createdAt !== normalizedClosedAt) continue;
    matches.push(requireString(item.actor?.login, `timeline[${index}].actor.login`));
  }
  if (matches.length === 0) {
    fail('missing-close-actor', 'no authoritative timeline close event matches pull_request.closed_at');
  }
  if (matches.length !== 1) {
    fail('ambiguous-close-actor', 'more than one timeline close event matches pull_request.closed_at', {
      count: matches.length,
    });
  }
  return matches[0];
}

function validatePermission(value, actor) {
  const permission = requireRecord(value, 'collaborator permission');
  const permissionActor = requireString(permission.user?.login, 'collaborator permission.user.login');
  if (!sameLogin(permissionActor, actor)) {
    fail('permission-actor-mismatch', 'collaborator permission response does not identify the decision actor');
  }
  const legacyPermission = requireString(permission.permission, 'collaborator permission.permission');
  if (permission.role_name === undefined || permission.role_name === null) return legacyPermission;
  return requireString(permission.role_name, 'collaborator permission.role_name');
}

function artifactId(value) {
  return metadataId(requireRecord(value, 'artifact').id, 'artifact.id');
}

function verifySourceRunHeadBinding(workflowRun, sourceRun) {
  const eventHeadSha = requireSha(workflowRun.head_sha, 'workflowRun.head_sha');
  const fetchedHeadSha = requireSha(sourceRun.head_sha, 'sourceRun.head_sha');
  if (eventHeadSha !== fetchedHeadSha) {
    fail('source-run-head-sha-mismatch', 'workflow event and refetched source run head SHAs differ');
  }
}

async function readAndBindCapture({
  api,
  repoPath,
  workflowRun,
  expectedRepository,
  extractArtifactEntries,
}) {
  const contextRunId = metadataId(requireRecord(workflowRun, 'workflowRun').id, 'workflowRun.id');
  const sourceRun = await api.getJson(`/repos/${repoPath}/actions/runs/${contextRunId}`);
  const artifacts = await api.paginate(`/repos/${repoPath}/actions/runs/${contextRunId}/artifacts`, {
    itemsKey: 'artifacts',
    totalKey: 'total_count',
  });
  if (artifacts.length === 0) fail('missing-capture-artifact', 'source run has no capture artifact');
  if (artifacts.length !== 1) {
    fail('multiple-capture-artifacts', 'source run must have exactly one artifact', { count: artifacts.length });
  }
  const metadata = requireRecord(artifacts[0], 'artifact');
  const artifactName = parseCaptureArtifactName(metadata.name);
  if (artifactName.sourceRunId !== contextRunId) {
    fail('artifact-run-mismatch', 'artifact name does not match workflowRun.id');
  }
  const provisionalHint = {
    schemaVersion: CAPTURE_HINT_SCHEMA_VERSION,
    repositoryId: expectedRepository.repositoryId,
    repository: expectedRepository.repository,
    sourceRunId: contextRunId,
    sourceRunAttempt: requirePositiveInteger(workflowRun.run_attempt, 'workflowRun.run_attempt'),
    prNumber: artifactName.prNumber,
  };
  validateCaptureRunBinding(provisionalHint, workflowRun, expectedRepository);
  validateCaptureRunBinding(provisionalHint, sourceRun, expectedRepository);
  selectCaptureArtifact(artifacts, provisionalHint);
  validateCaptureArtifactBinding(provisionalHint, metadata);
  if (typeof extractArtifactEntries !== 'function') {
    fail('invalid-artifact-extractor', 'extractArtifactEntries must be an injected function');
  }
  const archive = await api.getBytes(`/repos/${repoPath}/actions/artifacts/${artifactId(metadata)}/zip`, {
    accept: 'application/octet-stream',
    maxBytes: CAPTURE_ARTIFACT_MAX_BYTES,
  });
  if (archive.length !== metadata.size_in_bytes) {
    fail('artifact-size-mismatch', 'downloaded artifact size does not match GitHub artifact metadata', {
      expected: metadata.size_in_bytes,
      actual: archive.length,
    });
  }
  let entries;
  try {
    entries = await extractArtifactEntries(archive, metadata);
  } catch (error) {
    if (error instanceof LedgerGithubError) throw error;
    fail('artifact-extraction-failed', 'capture artifact archive could not be extracted', {
      cause: error?.message ?? String(error),
    });
  }
  const hint = parseCaptureArtifactEntries(entries);
  selectCaptureArtifact(artifacts, hint);
  bindCaptureHint({ hint, sourceRun, artifact: metadata, expectedRepository });
  validateCaptureRunBinding(hint, workflowRun, expectedRepository);
  return { hint, sourceRun, artifact: metadata };
}

export async function reconstructLedgerInput({
  api: apiValue,
  expectedRepository: repositoryValue,
  workflowRun,
  extractArtifactEntries,
  git,
  remote = 'origin',
  recordedAt = new Date(),
  excludedChecks = [],
  parseConfigImpl,
  checkChangeImpl,
} = {}) {
  const api = requireApi(apiValue);
  const expectedRepository = validateExpectedRepository(repositoryValue);
  const repoPath = repositoryEndpoint(expectedRepository.repository);
  const { hint, sourceRun } = await readAndBindCapture({
    api,
    repoPath,
    workflowRun,
    expectedRepository,
    extractArtifactEntries,
  });

  const pullRequest = validatePullRequest(
    await api.getJson(`/repos/${repoPath}/pulls/${hint.prNumber}`),
    hint,
    expectedRepository,
  );
  verifySourceRunHeadBinding(workflowRun, sourceRun);
  const labels = labelsFromApi(await api.paginate(`/repos/${repoPath}/issues/${hint.prNumber}/labels`));
  const checkRuns = checkRunsFromApi(await api.paginate(
    `/repos/${repoPath}/commits/${pullRequest.head.sha}/check-runs`,
    { itemsKey: 'check_runs', totalKey: 'total_count' },
  ));

  let decisionActor;
  if (pullRequest.merged) {
    decisionActor = requireString(pullRequest.merged_by?.login, 'pull_request.merged_by.login');
  } else {
    const timeline = await api.paginate(`/repos/${repoPath}/issues/${hint.prNumber}/timeline`, {
      accept: 'application/vnd.github+json',
    });
    decisionActor = reconstructClosedUnmergedActor(timeline, pullRequest.closed_at);
  }
  const decisionActorPermission = validatePermission(
    await api.getJson(`/repos/${repoPath}/collaborators/${encodeURIComponent(decisionActor)}/permission`),
    decisionActor,
  );

  const gitEvidence = await reconstructGitEvidence({
    git,
    remote,
    sourceRunId: hint.sourceRunId,
    pullRequest,
    parseConfigImpl,
    checkChangeImpl,
  });

  return {
    event: {
      repository: {
        id: expectedRepository.repositoryId,
        full_name: expectedRepository.repository,
      },
      pull_request: { ...pullRequest, labels },
      sender: { login: decisionActor },
    },
    agents: [...gitEvidence.policy.agents],
    ofmVerdict: gitEvidence.ofmVerdict,
    checkRuns,
    recordedAt,
    decisionActorPermission,
    excludedChecks,
  };
}

export async function reconstructLedgerEntry(options = {}) {
  return buildLedgerEntry(await reconstructLedgerInput(options));
}
