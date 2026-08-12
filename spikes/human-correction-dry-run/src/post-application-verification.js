import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { applyCorrection, prepareCorrection } from '@cyberbaser/correction';
import { caseId, stableStringify } from './case.js';
import {
  convertPilotSubmission,
  validateOwnerDecision,
  validateSubmission,
} from './pilot-input.js';
import {
  atomicCreateArtifact,
  attemptPaths,
  loadAttemptJson,
  loadAttemptOperator,
  matchReaderFormInstrumentVersion,
  verifyAttemptWorkspace,
} from './pilot-workspace.js';

const execFileAsync = promisify(execFile);
const COMMIT_RE = /^[0-9a-f]{40}$/u;
const RUN_ID_RE = /^[1-9][0-9]*$/u;
const WAIT_RE = /^[1-9][0-9]*$/u;
const MAX_WAIT_SECONDS = 900;
const DEFAULT_RETRY_INTERVAL_MS = 5_000;
const GITHUB_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const PUBLIC_HTML_MAX_BYTES = 4 * 1024 * 1024;
const VERIFICATION_FILE = 'post-application-live-verification.json';
const OWNER_DOGFOOD_PUBLICATION = Object.freeze({
  workflowName: 'Publish vault site',
  workflowPath: '.github/workflows/publish-site.yml',
  event: 'push',
  branch: 'main',
  jobNames: Object.freeze(['build', 'deploy']),
  deploymentJobName: 'deploy',
  deploymentEnvironment: 'github-pages',
  deploymentTask: 'deploy',
  deploymentAppSlug: 'github-actions',
});

export class PostApplicationVerificationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PostApplicationVerificationError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new PostApplicationVerificationError(code, message, details);
}

function selectorFromCase(value) {
  return {
    quote: value.quote,
    ...(Object.hasOwn(value, 'prefix') ? { prefix: value.prefix } : {}),
    ...(Object.hasOwn(value, 'suffix') ? { suffix: value.suffix } : {}),
  };
}

function exactCommit(value) {
  if (typeof value !== 'string' || !COMMIT_RE.test(value)) {
    fail('invalid-application-commit', 'applicationCommit must be a lowercase 40-character Git object ID');
  }
  return value;
}

function exactRunId(value) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !RUN_ID_RE.test(text)) {
    fail('invalid-deployment-run-id', 'deploymentRunId must be an explicit positive decimal GitHub Actions run ID');
  }
  return text;
}

function exactWaitSeconds(value) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !WAIT_RE.test(text)) {
    fail('invalid-wait-seconds', 'waitSeconds must be an explicit positive integer');
  }
  const seconds = Number(text);
  if (!Number.isSafeInteger(seconds) || seconds > MAX_WAIT_SECONDS) {
    fail('invalid-wait-seconds', `waitSeconds must be between 0 and ${MAX_WAIT_SECONDS}`);
  }
  return seconds;
}

function normalizedRepositoryIdentity(value) {
  let text = String(value ?? '').trim();
  const scp = text.match(/^git@([^:]+):(.+)$/u);
  if (scp) text = `https://${scp[1]}/${scp[2]}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    return text.replace(/\.git$/u, '').replace(/\/+$/u, '').toLowerCase();
  }
  return `${url.hostname.toLowerCase()}${url.pathname}`
    .replace(/\.git$/u, '')
    .replace(/\/+$/u, '')
    .toLowerCase();
}

function githubRepository(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('github-repository-required', 'the validated operator repository must be a GitHub HTTPS repository');
  }
  const segments = url.pathname.replace(/\.git$/u, '').split('/').filter(Boolean);
  if (url.protocol !== 'https:'
    || url.hostname.toLowerCase() !== 'github.com'
    || url.username
    || url.password
    || url.search
    || url.hash
    || segments.length !== 2) {
    fail('github-repository-required', 'the validated operator repository must be a GitHub HTTPS repository');
  }
  return Object.freeze({ owner: segments[0], repository: segments[1], slug: `${segments[0]}/${segments[1]}` });
}

export function readOnlyGitEnvironment(environment = process.env) {
  return {
    ...environment,
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

async function defaultGit(checkoutDir, args, { encoding = 'utf8' } = {}) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', checkoutDir, ...args], {
      encoding,
      env: readOnlyGitEnvironment(),
      maxBuffer: 64 * 1024 * 1024,
    });
    return encoding === 'buffer' ? Buffer.from(stdout) : String(stdout).trim();
  } catch (error) {
    fail('git-object-inspection-failed', `git ${args[0]} failed during read-only application inspection`, {
      stderr: String(error?.stderr ?? '').trim().slice(0, 2_000),
    });
  }
}

function parseNulPaths(bytes) {
  const parts = bytes.toString('utf8').split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

function parseTreeEntry(bytes, expectedPath, revision) {
  const records = parseNulPaths(bytes);
  if (records.length !== 1) {
    fail('source-blob-unavailable', `sourcePath must identify exactly one blob at ${revision}`);
  }
  const match = records[0].match(/^([0-7]{6}) (blob) ([0-9a-f]{40})\t([\s\S]+)$/u);
  if (!match || match[4] !== expectedPath) {
    fail('source-blob-unavailable', `sourcePath must identify exactly one blob at ${revision}`);
  }
  return Object.freeze({ mode: match[1], type: match[2], objectId: match[3], path: match[4] });
}

async function resolveCheckout(checkoutDir, operator, git) {
  if (typeof checkoutDir !== 'string' || !path.isAbsolute(checkoutDir)) {
    fail('invalid-checkout-dir', 'checkoutDir must be an explicit absolute Git worktree root');
  }
  let checkoutReal;
  try {
    checkoutReal = await realpath(checkoutDir);
    if (!(await stat(checkoutReal)).isDirectory()) fail('checkout-not-directory', 'checkoutDir is not a directory');
  } catch (error) {
    if (error instanceof PostApplicationVerificationError) throw error;
    fail('checkout-unavailable', 'the explicit checkout could not be resolved', {
      cause: error?.code,
    });
  }
  const root = await realpath(await git(checkoutReal, ['rev-parse', '--show-toplevel']));
  if (root !== checkoutReal) {
    fail('checkout-not-repository-root', 'checkoutDir must identify the Git worktree root');
  }
  const origin = await git(checkoutReal, ['remote', 'get-url', 'origin']);
  if (normalizedRepositoryIdentity(origin) !== normalizedRepositoryIdentity(operator.repository)) {
    fail('checkout-repository-mismatch', 'checkout origin does not match the validated attempt repository', {
      origin,
      repository: operator.repository,
    });
  }
  return Object.freeze({ root: checkoutReal, origin });
}

function validatedEvaluation(value, {
  mechanicalCaseId,
  operator,
  acceptedDecision,
}) {
  if (value?.artifactType !== 'private-no-write-correction-evaluation'
    || value?.schemaVersion !== 1
    || value?.caseId !== mechanicalCaseId
    || value?.source?.baseCommit !== operator.baseCommit
    || value?.source?.repositoryRelativePath !== operator.sourcePath
    || value?.noWrite?.candidateExistsInMemoryOnly !== true
    || value?.noWrite?.sourceBytesUnchangedAfterEvaluation !== true
    || value?.noWrite?.sourceWritePerformed !== false
    || typeof value?.base?.digest !== 'string'
    || typeof value?.candidate?.digest !== 'string') {
    fail('validated-evaluation-required', 'post-application verification requires the immutable no-write evaluation bound to the accepted run');
  }
  if (value.candidate.digest !== acceptedDecision.candidateDigest) {
    fail('validated-evaluation-candidate-mismatch', 'reviewed evaluation candidate digest must equal the validated accept digest');
  }
  return value;
}

function validatedAccept(value, { attemptId, mechanicalCaseId }) {
  if (value?.artifactType !== 'private-validated-owner-self-dogfood-decision'
    || value?.schemaVersion !== 2
    || value?.evidenceClass !== 'owner-self-dogfood'
    || value?.countsTowardHumanPilot !== false
    || value?.independentOwnerEvidence !== false
    || value?.ownerDecisionEligibleAtValidation !== true
    || value?.sourceWritePerformed !== false
    || value?.publicDeploymentPerformed !== false) {
    fail('validated-accept-required', 'post-application verification requires an unmodified validated owner self-dogfood decision boundary');
  }
  const decision = validateOwnerDecision({
    schemaVersion: 1,
    attemptId: value.attemptId,
    mechanicalCaseId: value.mechanicalCaseId,
    candidateDigest: value.candidateDigest,
    decision: value.decision,
    reason: value.reason,
    reviewSeconds: value.reviewSeconds,
    decidedAt: value.decidedAt,
  });
  if (decision.attemptId !== attemptId || decision.mechanicalCaseId !== mechanicalCaseId) {
    fail('validated-decision-binding-mismatch', 'validated owner decision does not match the explicit attempt and mechanical case');
  }
  if (decision.decision !== 'accept') {
    fail('validated-accept-required', 'post-application verification requires a validated accept decision');
  }
  return decision;
}

async function inspectApplicationCommit({
  checkout,
  applicationCommit,
  operator,
  caseData,
  acceptedDecision,
  reviewedEvaluation,
  git,
}) {
  await git(checkout.root, ['cat-file', '-e', `${applicationCommit}^{commit}`]);
  const ancestry = (await git(checkout.root, ['rev-list', '--parents', '-n', '1', applicationCommit]))
    .split(/\s+/u);
  if (ancestry.length !== 2 || ancestry[0] !== applicationCommit) {
    fail('application-commit-not-single-parent', 'applicationCommit must be one exact single-parent commit');
  }
  const parentCommit = ancestry[1];
  if (parentCommit !== operator.baseCommit) {
    fail('application-parent-base-mismatch', 'applicationCommit parent must exactly equal the validated operator base commit', {
      parentCommit,
      expectedBaseCommit: operator.baseCommit,
    });
  }

  const changedPaths = parseNulPaths(await git(checkout.root, [
    'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames',
    parentCommit, applicationCommit, '--',
  ], { encoding: 'buffer' }));
  if (changedPaths.length !== 1 || changedPaths[0] !== operator.sourcePath) {
    fail('application-changed-path-mismatch', 'applicationCommit must change exactly the validated sourcePath and no other path', {
      changedPaths,
      expectedSourcePath: operator.sourcePath,
    });
  }

  const [parentTree, candidateTree] = await Promise.all([
    git(checkout.root, ['ls-tree', '-z', '--full-tree', parentCommit, '--', operator.sourcePath], { encoding: 'buffer' }),
    git(checkout.root, ['ls-tree', '-z', '--full-tree', applicationCommit, '--', operator.sourcePath], { encoding: 'buffer' }),
  ]);
  const parentEntry = parseTreeEntry(parentTree, operator.sourcePath, parentCommit);
  const candidateEntry = parseTreeEntry(candidateTree, operator.sourcePath, applicationCommit);
  if (parentEntry.mode !== candidateEntry.mode) {
    fail('application-source-mode-changed', 'applicationCommit must not change source file mode or type');
  }

  const [parentBytes, committedCandidateBytes] = await Promise.all([
    git(checkout.root, ['cat-file', 'blob', parentEntry.objectId], { encoding: 'buffer' }),
    git(checkout.root, ['cat-file', 'blob', candidateEntry.objectId], { encoding: 'buffer' }),
  ]);
  const prepared = prepareCorrection(parentBytes, {
    selector: selectorFromCase(caseData),
    replacement: caseData.replacement,
  });
  if (prepared.baseDigest !== reviewedEvaluation.base.digest) {
    fail('application-parent-baseline-digest-mismatch', 'application parent source digest does not match the reviewed no-write baseline');
  }
  if (prepared.candidateDigest !== reviewedEvaluation.candidate.digest
    || prepared.candidateDigest !== acceptedDecision.candidateDigest) {
    fail('accepted-candidate-digest-mismatch', 'reviewed and validated candidate digests do not match the exact correction reconstructed from the application parent');
  }
  const reconstructedCandidate = applyCorrection(parentBytes, prepared);
  if (!committedCandidateBytes.equals(reconstructedCandidate)) {
    fail('application-candidate-bytes-mismatch', 'applicationCommit source bytes are not the exact accepted single splice');
  }
  const committedPrefix = committedCandidateBytes.subarray(0, prepared.start);
  const committedSuffix = committedCandidateBytes.subarray(prepared.start + prepared.replacementBytes.length);
  const prefixIdentical = committedPrefix.equals(parentBytes.subarray(0, prepared.start));
  const suffixIdentical = committedSuffix.equals(parentBytes.subarray(prepared.end));
  if (!prefixIdentical || !suffixIdentical) {
    fail('application-outside-splice-mismatch', 'applicationCommit changed bytes outside the reconstructed exact splice');
  }

  return Object.freeze({
    commit: applicationCommit,
    parentCommit,
    singleParent: true,
    changedSourcePaths: [...changedPaths],
    sourcePath: operator.sourcePath,
    sourceMode: parentEntry.mode,
    parentBlob: parentEntry.objectId,
    candidateBlob: candidateEntry.objectId,
    parentBaselineDigest: prepared.baseDigest,
    acceptedCandidateDigest: acceptedDecision.candidateDigest,
    committedCandidateDigest: prepared.candidateDigest,
    exactSplice: {
      start: prepared.start,
      end: prepared.end,
      oldByteLength: prepared.expectedOldBytes.length,
      replacementByteLength: prepared.replacementBytes.length,
      prefixIdentical,
      suffixIdentical,
      committedBytesEqualReconstruction: true,
    },
  });
}

function responseStatus(response) {
  return Number.isSafeInteger(response?.status) ? response.status : 0;
}

function responseHeader(response, name) {
  const value = response?.headers?.get?.(name);
  return typeof value === 'string' ? value : '';
}

function retryState(waitSeconds, intervalMs, clock) {
  const startedAtMs = clock();
  if (!Number.isFinite(startedAtMs)) fail('invalid-clock', 'injected clock must return finite epoch milliseconds');
  const waitMs = waitSeconds * 1_000;
  return {
    startedAtMs,
    deadlineMs: startedAtMs + waitMs,
    intervalMs,
    maximumSleeps: Math.ceil(waitMs / intervalMs),
    sleeps: 0,
  };
}

function remainingDeadlineMs(state, clock) {
  const now = clock();
  if (!Number.isFinite(now)) fail('invalid-clock', 'injected clock must return finite epoch milliseconds');
  return Math.max(0, state.deadlineMs - now);
}

async function retryPause(state, { clock, sleep }) {
  const remaining = remainingDeadlineMs(state, clock);
  if (remaining <= 0 || state.sleeps >= state.maximumSleeps) return false;
  const delay = Math.min(state.intervalMs, remaining);
  if (delay <= 0) return false;
  state.sleeps += 1;
  await sleep(delay);
  return true;
}

async function readBoundedResponseBody(response, maxBytes, tooLargeCode) {
  if (!response?.body || typeof response.body.getReader !== 'function') {
    fail('remote-response-body-unavailable', 'remote verification response must expose a readable body stream');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        fail(tooLargeCode, 'remote verification response exceeded its byte limit', {
          maxBytes,
        });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function fetchBoundedResponse(fetcher, url, options, {
  retry,
  dependencies,
  maxBytes,
  timeoutCode,
  tooLargeCode,
}) {
  const remaining = remainingDeadlineMs(retry, dependencies.clock);
  if (remaining <= 0) {
    fail(timeoutCode, 'the explicit network verification deadline expired before the next request');
  }
  const controller = new AbortController();
  const timer = dependencies.setTimer(() => controller.abort(), remaining);
  try {
    const response = await fetcher(url, { ...options, signal: controller.signal });
    const bytes = await readBoundedResponseBody(response, maxBytes, tooLargeCode);
    return Object.freeze({ response, bytes });
  } finally {
    dependencies.clearTimer(timer);
  }
}

function parseJsonBytes(bytes, code) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(code, 'remote verification response was not valid JSON');
  }
}

function decodeHtmlEntities(value) {
  const named = new Map([
    ['amp', '&'],
    ['apos', "'"],
    ['gt', '>'],
    ['lt', '<'],
    ['nbsp', ' '],
    ['quot', '"'],
  ]);
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu, (entity, decimal, hexadecimal, name) => {
    if (decimal !== undefined) {
      const point = Number(decimal);
      return Number.isSafeInteger(point) && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    if (hexadecimal !== undefined) {
      const point = Number.parseInt(hexadecimal, 16);
      return Number.isSafeInteger(point) && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    return named.get(name.toLowerCase()) ?? entity;
  });
}

async function visiblePageText(bytes, contentType) {
  let sanitized;
  try {
    sanitized = await new HTMLRewriter()
      .on('head, script, style, template, noscript, [hidden], [aria-hidden="true"]', {
        element(element) { element.remove(); },
      })
      .transform(new Response(bytes, { headers: { 'Content-Type': contentType } }))
      .text();
  } catch {
    fail('public-page-invalid-html', 'public URL did not return parseable HTML');
  }
  return decodeHtmlEntities(
    sanitized
      .replace(/<!--[\s\S]*?-->/gu, ' ')
      .replace(/<[^>]*>/gu, ' '),
  ).replace(/\s+/gu, ' ').trim();
}

function normalizedPageText(value) {
  return value.replace(/\s+/gu, ' ').trim();
}

async function verifyDeploymentJobs({
  repository,
  runId,
  runAttempt,
  applicationCommit,
  retry,
  dependencies,
}) {
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/actions/runs/${runId}/jobs?per_page=100`;
  let attempts = 0;
  let lastObservation = null;
  while (true) {
    attempts += 1;
    let fetched;
    try {
      fetched = await fetchBoundedResponse(dependencies.githubFetch, endpoint, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cyberbaser-owner-dogfood-live-verifier',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'error',
      }, {
        retry,
        dependencies,
        maxBytes: GITHUB_RESPONSE_MAX_BYTES,
        timeoutCode: 'deployment-jobs-timeout',
        tooLargeCode: 'deployment-jobs-response-too-large',
      });
    } catch (error) {
      if (error instanceof PostApplicationVerificationError
        && error.code !== 'deployment-jobs-timeout') throw error;
      lastObservation = { fetchError: error?.message ?? 'GitHub jobs fetch failed' };
      if (await retryPause(retry, dependencies)) continue;
      fail('deployment-jobs-timeout', 'GitHub Actions jobs could not be verified before the explicit wait bound', { attempts, lastObservation });
    }
    const status = responseStatus(fetched.response);
    if (status !== 200) {
      lastObservation = { httpStatus: status };
      if (await retryPause(retry, dependencies)) continue;
      fail('deployment-jobs-timeout', 'GitHub Actions jobs could not be verified before the explicit wait bound', { attempts, lastObservation });
    }
    const value = parseJsonBytes(fetched.bytes, 'deployment-jobs-invalid-response');
    if (!Number.isSafeInteger(value.total_count)
      || value.total_count !== OWNER_DOGFOOD_PUBLICATION.jobNames.length
      || !Array.isArray(value.jobs)
      || value.jobs.length !== value.total_count) {
      fail('deployment-jobs-identity-mismatch', 'GitHub Actions run must contain exactly the expected publication jobs');
    }
    const jobs = value.jobs.map((job) => ({
      id: String(job?.id ?? ''),
      name: typeof job?.name === 'string' ? job.name : '',
      workflowName: typeof job?.workflow_name === 'string' ? job.workflow_name : '',
      headBranch: typeof job?.head_branch === 'string' ? job.head_branch : '',
      headSha: typeof job?.head_sha === 'string' ? job.head_sha : '',
      runId: String(job?.run_id ?? ''),
      runAttempt: job?.run_attempt,
      htmlUrl: typeof job?.html_url === 'string' ? job.html_url : '',
      status: job?.status,
      conclusion: job?.conclusion ?? null,
    }));
    const names = jobs.map((job) => job.name).sort();
    const expectedNames = [...OWNER_DOGFOOD_PUBLICATION.jobNames].sort();
    if (names.length !== expectedNames.length
      || names.some((name, index) => name !== expectedNames[index])
      || jobs.some((job) => job.workflowName !== OWNER_DOGFOOD_PUBLICATION.workflowName
        || job.headBranch !== OWNER_DOGFOOD_PUBLICATION.branch
        || job.headSha !== applicationCommit
        || job.runId !== runId
        || job.runAttempt !== runAttempt
        || !RUN_ID_RE.test(job.id)
        || !job.htmlUrl)) {
      fail('deployment-jobs-identity-mismatch', 'GitHub Actions jobs must belong to the exact expected publication workflow run');
    }
    const failed = jobs.find((job) => job.status === 'completed' && job.conclusion !== 'success');
    if (failed) {
      fail('deployment-job-not-successful', 'a GitHub Actions deployment job completed without success', { job: failed });
    }
    if (jobs.every((job) => job.status === 'completed' && job.conclusion === 'success')) {
      const deploymentJob = jobs.find((job) => job.name === OWNER_DOGFOOD_PUBLICATION.deploymentJobName);
      return Object.freeze({
        endpoint,
        totalCount: jobs.length,
        allSuccessful: true,
        attempts,
        jobs,
        deploymentJob,
      });
    }
    lastObservation = { jobs };
    if (await retryPause(retry, dependencies)) continue;
    fail('deployment-jobs-timeout', 'GitHub Actions jobs did not all complete successfully before the explicit wait bound', { attempts, lastObservation });
  }
}

async function verifyWorkflowIdentity({ repository, workflowId, retry, dependencies }) {
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/actions/workflows/${workflowId}`;
  let fetched;
  try {
    fetched = await fetchBoundedResponse(dependencies.githubFetch, endpoint, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'cyberbaser-owner-dogfood-live-verifier',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
    }, {
      retry,
      dependencies,
      maxBytes: GITHUB_RESPONSE_MAX_BYTES,
      timeoutCode: 'deployment-workflow-timeout',
      tooLargeCode: 'deployment-workflow-response-too-large',
    });
  } catch (error) {
    if (error instanceof PostApplicationVerificationError) throw error;
    fail('deployment-workflow-timeout', 'GitHub Actions workflow identity could not be verified before the explicit wait bound');
  }
  if (responseStatus(fetched.response) !== 200) {
    fail('deployment-workflow-unavailable', 'GitHub Actions workflow identity endpoint did not return HTTP 200');
  }
  const workflow = parseJsonBytes(fetched.bytes, 'deployment-workflow-invalid-response');
  if (String(workflow.id ?? '') !== workflowId
    || workflow.name !== OWNER_DOGFOOD_PUBLICATION.workflowName
    || workflow.path !== OWNER_DOGFOOD_PUBLICATION.workflowPath
    || workflow.state !== 'active') {
    fail('deployment-workflow-identity-mismatch', 'deployment run must use the exact active Cyberbase publication workflow');
  }
  return Object.freeze({
    id: workflowId,
    name: workflow.name,
    path: workflow.path,
    state: workflow.state,
    apiUrl: endpoint,
  });
}

function normalizedUrlBoundary(value, code) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(code, 'deployment environment URL must be an absolute URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    fail(code, 'verification URLs must use HTTPS without credentials or fragments');
  }
  return url;
}

async function verifyDeploymentEnvironment({
  repository,
  runId,
  applicationCommit,
  publicUrl,
  deploymentJob,
  retry,
  dependencies,
}) {
  const query = new URLSearchParams({
    sha: applicationCommit,
    environment: OWNER_DOGFOOD_PUBLICATION.deploymentEnvironment,
    per_page: '100',
  });
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/deployments?${query}`;
  let attempts = 0;
  let lastObservation = null;
  while (true) {
    attempts += 1;
    let fetched;
    try {
      fetched = await fetchBoundedResponse(dependencies.githubFetch, endpoint, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cyberbaser-owner-dogfood-live-verifier',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'error',
      }, {
        retry,
        dependencies,
        maxBytes: GITHUB_RESPONSE_MAX_BYTES,
        timeoutCode: 'deployment-environment-timeout',
        tooLargeCode: 'deployment-environment-response-too-large',
      });
    } catch (error) {
      if (error instanceof PostApplicationVerificationError
        && error.code !== 'deployment-environment-timeout') throw error;
      lastObservation = { fetchError: error?.message ?? 'GitHub deployments fetch failed' };
      if (await retryPause(retry, dependencies)) continue;
      fail('deployment-environment-timeout', 'GitHub Pages deployment could not be verified before the explicit wait bound', { attempts, lastObservation });
    }
    if (responseStatus(fetched.response) !== 200) {
      lastObservation = { httpStatus: responseStatus(fetched.response) };
      if (await retryPause(retry, dependencies)) continue;
      fail('deployment-environment-timeout', 'GitHub Pages deployment could not be verified before the explicit wait bound', { attempts, lastObservation });
    }
    const deployments = parseJsonBytes(fetched.bytes, 'deployment-environment-invalid-response');
    if (!Array.isArray(deployments) || deployments.length > 100) {
      fail('deployment-environment-invalid-response', 'GitHub deployments response must be one bounded array');
    }
    const candidates = deployments.filter((deployment) => deployment?.sha === applicationCommit
      && deployment?.ref === OWNER_DOGFOOD_PUBLICATION.branch
      && deployment?.task === OWNER_DOGFOOD_PUBLICATION.deploymentTask
      && deployment?.environment === OWNER_DOGFOOD_PUBLICATION.deploymentEnvironment
      && deployment?.original_environment === OWNER_DOGFOOD_PUBLICATION.deploymentEnvironment
      && deployment?.performed_via_github_app?.slug === OWNER_DOGFOOD_PUBLICATION.deploymentAppSlug
      && RUN_ID_RE.test(String(deployment?.id ?? '')));
    const matches = [];
    for (const deployment of candidates) {
      const statusesEndpoint = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/deployments/${deployment.id}/statuses?per_page=100`;
      let statusesFetched;
      try {
        statusesFetched = await fetchBoundedResponse(dependencies.githubFetch, statusesEndpoint, {
          method: 'GET',
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'cyberbaser-owner-dogfood-live-verifier',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          redirect: 'error',
        }, {
          retry,
          dependencies,
          maxBytes: GITHUB_RESPONSE_MAX_BYTES,
          timeoutCode: 'deployment-environment-timeout',
          tooLargeCode: 'deployment-status-response-too-large',
        });
      } catch (error) {
        if (error instanceof PostApplicationVerificationError
          && error.code !== 'deployment-environment-timeout') throw error;
        continue;
      }
      if (responseStatus(statusesFetched.response) !== 200) continue;
      const statuses = parseJsonBytes(statusesFetched.bytes, 'deployment-status-invalid-response');
      if (!Array.isArray(statuses) || statuses.length < 1 || statuses.length > 100) continue;
      const latest = statuses[0];
      const jobUrl = deploymentJob.htmlUrl;
      if (latest?.state !== 'success'
        || latest?.environment !== OWNER_DOGFOOD_PUBLICATION.deploymentEnvironment
        || latest?.target_url !== jobUrl
        || latest?.log_url !== jobUrl
        || typeof latest?.environment_url !== 'string'
        || latest.environment_url.length === 0) continue;
      const environmentUrl = normalizedUrlBoundary(
        latest.environment_url,
        'deployment-environment-url-invalid',
      );
      const expectedPublicUrl = normalizedUrlBoundary(publicUrl, 'public-page-invalid-url');
      const environmentPath = environmentUrl.pathname.endsWith('/')
        ? environmentUrl.pathname
        : `${environmentUrl.pathname}/`;
      if (environmentUrl.origin === expectedPublicUrl.origin
        && expectedPublicUrl.pathname.startsWith(environmentPath)) {
        matches.push({ deployment, latest, statusesEndpoint, environmentUrl: environmentUrl.href });
      }
    }
    if (matches.length === 1) {
      const match = matches[0];
      return Object.freeze({
        deploymentId: String(match.deployment.id),
        environment: match.deployment.environment,
        task: match.deployment.task,
        ref: match.deployment.ref,
        sha: match.deployment.sha,
        state: match.latest.state,
        environmentUrl: match.environmentUrl,
        deploymentJobId: deploymentJob.id,
        deploymentJobUrl: deploymentJob.htmlUrl,
        runId,
        apiUrl: endpoint,
        statusesApiUrl: match.statusesEndpoint,
        attempts,
      });
    }
    if (matches.length > 1) {
      fail('deployment-environment-ambiguous', 'more than one GitHub Pages deployment matched the explicit workflow run and application commit');
    }
    lastObservation = { candidateCount: candidates.length };
    if (await retryPause(retry, dependencies)) continue;
    fail('deployment-environment-timeout', 'GitHub Pages deployment did not bind to the explicit workflow run before the wait bound', { attempts, lastObservation });
  }
}

async function verifyDeploymentRun({
  repository,
  runId,
  applicationCommit,
  publicUrl,
  retry,
  dependencies,
}) {
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/actions/runs/${runId}`;
  let attempts = 0;
  let lastObservation = null;
  while (true) {
    attempts += 1;
    let fetched;
    try {
      fetched = await fetchBoundedResponse(dependencies.githubFetch, endpoint, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cyberbaser-owner-dogfood-live-verifier',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'error',
      }, {
        retry,
        dependencies,
        maxBytes: GITHUB_RESPONSE_MAX_BYTES,
        timeoutCode: 'deployment-run-timeout',
        tooLargeCode: 'deployment-run-response-too-large',
      });
    } catch (error) {
      if (error instanceof PostApplicationVerificationError
        && error.code !== 'deployment-run-timeout') throw error;
      lastObservation = { fetchError: error?.message ?? 'GitHub fetch failed' };
      if (await retryPause(retry, dependencies)) continue;
      fail('deployment-run-timeout', 'GitHub Actions run could not be verified before the explicit wait bound', { attempts, lastObservation });
    }
    const status = responseStatus(fetched.response);
    if (status !== 200) {
      lastObservation = { httpStatus: status };
      if (await retryPause(retry, dependencies)) continue;
      fail('deployment-run-timeout', 'GitHub Actions run could not be verified before the explicit wait bound', { attempts, lastObservation });
    }
    const run = parseJsonBytes(fetched.bytes, 'deployment-run-invalid-response');
    if (String(run.id) !== runId) {
      fail('deployment-run-id-mismatch', 'GitHub Actions response did not match the explicit deployment run ID');
    }
    if (run.head_sha !== applicationCommit) {
      fail('deployment-run-head-mismatch', 'GitHub Actions run head_sha must exactly equal applicationCommit', {
        headSha: run.head_sha,
        applicationCommit,
      });
    }
    if (!RUN_ID_RE.test(String(run.workflow_id ?? ''))
      || run.name !== OWNER_DOGFOOD_PUBLICATION.workflowName
      || run.path !== OWNER_DOGFOOD_PUBLICATION.workflowPath
      || run.event !== OWNER_DOGFOOD_PUBLICATION.event
      || run.head_branch !== OWNER_DOGFOOD_PUBLICATION.branch
      || !Number.isSafeInteger(run.run_attempt)
      || run.run_attempt < 1) {
      fail('deployment-run-identity-mismatch', 'GitHub Actions run must match the exact Cyberbase publication workflow, event, and branch');
    }
    if (run.status === 'completed') {
      if (run.conclusion !== 'success') {
        fail('deployment-run-not-successful', 'GitHub Actions deployment run completed without success', {
          conclusion: run.conclusion,
        });
      }
      const workflow = await verifyWorkflowIdentity({
        repository,
        workflowId: String(run.workflow_id),
        retry,
        dependencies,
      });
      const jobVerification = await verifyDeploymentJobs({
        repository,
        runId,
        runAttempt: run.run_attempt,
        applicationCommit,
        retry,
        dependencies,
      });
      const environment = await verifyDeploymentEnvironment({
        repository,
        runId,
        applicationCommit,
        publicUrl,
        deploymentJob: jobVerification.deploymentJob,
        retry,
        dependencies,
      });
      return Object.freeze({
        provider: 'github-actions',
        repository: repository.slug,
        runId,
        apiUrl: endpoint,
        htmlUrl: typeof run.html_url === 'string' ? run.html_url : '',
        headSha: run.head_sha,
        headBranch: run.head_branch,
        event: run.event,
        status: run.status,
        conclusion: run.conclusion,
        attempts,
        workflow,
        jobs: jobVerification,
        environment,
      });
    }
    if (!['queued', 'in_progress', 'pending', 'waiting', 'requested'].includes(run.status)) {
      fail('deployment-run-invalid-status', 'GitHub Actions deployment run returned an unsupported status', {
        status: run.status,
      });
    }
    lastObservation = { status: run.status, conclusion: run.conclusion ?? null };
    if (await retryPause(retry, dependencies)) continue;
    fail('deployment-run-timeout', 'GitHub Actions run did not complete successfully before the explicit wait bound', { attempts, lastObservation });
  }
}

async function verifyPublicPage({ publicUrl, quote, replacement, retry, dependencies }) {
  const expected = normalizedUrlBoundary(publicUrl, 'public-page-invalid-url');
  const expectedQuote = normalizedPageText(quote);
  const expectedReplacement = normalizedPageText(replacement);
  let attempts = 0;
  let lastObservation = null;
  while (true) {
    attempts += 1;
    let fetched;
    try {
      fetched = await fetchBoundedResponse(dependencies.publicFetch, publicUrl, {
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Cache-Control': 'no-cache, no-store, max-age=0',
          Pragma: 'no-cache',
        },
        redirect: 'follow',
      }, {
        retry,
        dependencies,
        maxBytes: PUBLIC_HTML_MAX_BYTES,
        timeoutCode: 'public-page-timeout',
        tooLargeCode: 'public-page-response-too-large',
      });
    } catch (error) {
      if (error instanceof PostApplicationVerificationError
        && error.code !== 'public-page-timeout') throw error;
      lastObservation = { fetchError: error?.message ?? 'public URL fetch failed' };
      if (await retryPause(retry, dependencies)) continue;
      fail('public-page-timeout', 'public URL could not be verified before the explicit wait bound', { attempts, lastObservation });
    }
    const response = fetched.response;
    const status = responseStatus(response);
    const finalUrl = typeof response.url === 'string' && response.url.length > 0 ? response.url : publicUrl;
    const final = normalizedUrlBoundary(finalUrl, 'public-page-invalid-final-url');
    if (final.origin !== expected.origin) {
      fail('public-page-origin-mismatch', 'public URL must remain on the exact validated origin', {
        expectedOrigin: expected.origin,
        finalOrigin: final.origin,
      });
    }
    if (final.pathname !== expected.pathname
      || final.search !== expected.search
      || final.hash !== expected.hash) {
      fail('public-page-location-mismatch', 'public URL response must remain on the exact normalized path and query', {
        expected: `${expected.pathname}${expected.search}${expected.hash}`,
        final: `${final.pathname}${final.search}${final.hash}`,
      });
    }
    if (status !== 200) {
      lastObservation = { status, finalUrl };
      if (await retryPause(retry, dependencies)) continue;
      fail('public-page-timeout', 'public URL did not return HTTP 200 before the explicit wait bound', { attempts, lastObservation });
    }
    const contentType = responseHeader(response, 'content-type');
    if (!/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/iu.test(contentType)) {
      fail('public-page-content-type-mismatch', 'public URL must return an HTML content type');
    }
    const pageText = await visiblePageText(fetched.bytes, contentType);
    const oldTextAbsent = expectedQuote.length === 0 || !pageText.includes(expectedQuote);
    const replacementPresent = expectedReplacement.length === 0
      ? oldTextAbsent
      : pageText.includes(expectedReplacement);
    if (oldTextAbsent && replacementPresent) {
      return Object.freeze({
        publicUrl,
        expectedOrigin: expected.origin,
        expectedLocation: `${expected.pathname}${expected.search}${expected.hash}`,
        finalUrl: final.href,
        finalOrigin: final.origin,
        finalLocation: `${final.pathname}${final.search}${final.hash}`,
        contentType,
        responseBytes: fetched.bytes.byteLength,
        textCharacters: pageText.length,
        status,
        oldTextAbsent,
        replacementPresent,
        attempts,
      });
    }
    lastObservation = { status, finalUrl, oldTextAbsent, replacementPresent };
    if (await retryPause(retry, dependencies)) continue;
    fail('public-page-timeout', 'public URL did not show the exact accepted replacement before the explicit wait bound', { attempts, lastObservation });
  }
}

function mergeDependencies(overrides = {}) {
  return {
    git: defaultGit,
    githubFetch: globalThis.fetch,
    publicFetch: globalThis.fetch,
    clock: Date.now,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    retryIntervalMs: DEFAULT_RETRY_INTERVAL_MS,
    ...overrides,
  };
}

export async function verifyPostApplicationLive({
  attemptId,
  checkoutDir,
  applicationCommit,
  deploymentRunId,
  waitSeconds,
  projectRoot,
  workspaceRoot,
} = {}, dependencyOverrides = {}) {
  const commit = exactCommit(applicationCommit);
  const runId = exactRunId(deploymentRunId);
  const wait = exactWaitSeconds(waitSeconds);
  const dependencies = mergeDependencies(dependencyOverrides);
  if (typeof dependencies.githubFetch !== 'function'
    || typeof dependencies.publicFetch !== 'function'
    || typeof dependencies.clock !== 'function'
    || typeof dependencies.sleep !== 'function'
    || typeof dependencies.setTimer !== 'function'
    || typeof dependencies.clearTimer !== 'function'
    || typeof dependencies.git !== 'function'
    || !Number.isSafeInteger(dependencies.retryIntervalMs)
    || dependencies.retryIntervalMs <= 0) {
    fail('invalid-dependencies', 'verification dependencies must provide Git, fetch, clock, sleep, and a positive retry interval');
  }

  const paths = attemptPaths(attemptId, { projectRoot, workspaceRoot });
  await verifyAttemptWorkspace(paths);
  const [operator, submission] = await Promise.all([
    loadAttemptOperator(paths),
    loadAttemptJson(paths.submission, 'submission', paths).then(validateSubmission),
  ]);
  if (operator.attemptId !== paths.attemptId || submission.attemptId !== paths.attemptId) {
    fail('attempt-id-mismatch', 'attempt, operator, and submission IDs must match');
  }
  const issuedInstrumentVersion = await matchReaderFormInstrumentVersion(
    await readFile(paths.readerForm),
    paths.attemptId,
    operator.profile,
  );
  if (submission.instrumentVersion !== issuedInstrumentVersion) {
    fail(
      'submission-instrument-version-mismatch',
      'submission instrument version does not match the issued reader form',
    );
  }
  const caseData = convertPilotSubmission(submission, operator);
  const mechanicalCaseId = caseId(caseData);
  const runDir = path.join(paths.runs, mechanicalCaseId);
  const validatedDecision = await loadAttemptJson(
    path.join(runDir, 'validated-owner-decision.json'),
    'validated-owner-decision',
    paths,
  );
  const acceptedDecision = validatedAccept(validatedDecision, {
    attemptId: paths.attemptId,
    mechanicalCaseId,
  });
  const reviewedEvaluation = validatedEvaluation(
    await loadAttemptJson(path.join(runDir, 'evaluation.json'), 'evaluation', paths),
    { mechanicalCaseId, operator, acceptedDecision },
  );
  const checkout = await resolveCheckout(checkoutDir, operator, dependencies.git);
  const application = await inspectApplicationCommit({
    checkout,
    applicationCommit: commit,
    operator,
    caseData,
    acceptedDecision,
    reviewedEvaluation,
    git: dependencies.git,
  });

  const repository = githubRepository(operator.repository);
  const retry = retryState(wait, dependencies.retryIntervalMs, dependencies.clock);
  const deployment = await verifyDeploymentRun({
    repository,
    runId,
    applicationCommit: commit,
    publicUrl: operator.publicUrl,
    retry,
    dependencies,
  });
  const live = await verifyPublicPage({
    publicUrl: operator.publicUrl,
    quote: caseData.quote,
    replacement: caseData.replacement,
    retry,
    dependencies,
  });
  const completedAtMs = dependencies.clock();
  if (!Number.isFinite(completedAtMs)) fail('invalid-clock', 'injected clock must return finite epoch milliseconds');

  const artifact = Object.freeze({
    schemaVersion: 1,
    artifactType: 'private-post-application-live-verification',
    attemptId: paths.attemptId,
    mechanicalCaseId,
    verifiedAt: new Date(completedAtMs).toISOString(),
    validatedDecision: {
      decision: acceptedDecision.decision,
      candidateDigest: acceptedDecision.candidateDigest,
      ownerDecisionEligibleAtValidation: true,
    },
    sourceCheckout: {
      checkoutDir: checkout.root,
      repository: operator.repository,
      origin: checkout.origin,
      gitInspectionMode: 'read-only-object-inspection',
    },
    application,
    deployment,
    live,
    boundedRetry: {
      waitSeconds: wait,
      retryIntervalMs: dependencies.retryIntervalMs,
      elapsedMs: Math.max(0, completedAtMs - retry.startedAtMs),
      sleeps: retry.sleeps,
    },
    noMutation: {
      gitMutationPerformed: false,
      sourceWritePerformed: false,
      remoteMutationPerformed: false,
      deploymentTriggered: false,
      observationEdited: false,
      onlyArtifactCreated: VERIFICATION_FILE,
    },
  });
  const artifactPath = path.join(runDir, VERIFICATION_FILE);
  await atomicCreateArtifact(artifactPath, stableStringify(artifact), paths);
  return Object.freeze({ ...artifact, artifactPath });
}
