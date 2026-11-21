// Owner-direct authority adapter. No intake, approval fiction, or second writer.
import { createHash, randomBytes } from 'node:crypto';
import { createChangeSetProposal } from '@cyberbaser/proposal';
import { createJsonArtifactOnce, readJsonArtifact } from './artifacts.js';
import { computePolicyRevision, validateOwnerAlphaConfig } from './config.js';
import { changeSetCorrection, changeSetStats } from './change-set-operation.js';
import { applyEditorOperation, validateEditSession } from './operation.js';
import { canonicalJson, deepFreeze } from './json.js';
import { validateJobId } from './job-state.js';
import { fail } from './errors.js';

const digest = value => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const recordPath = jobId => `owner-direct/${validateJobId(jobId)}.json`;

/** Bind the untrusted handoff to a freshly verified owner edit session. */
export function deriveOwnerDirect({ config: inputConfig, session, handoff, submittedAt = new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z') }) {
  const config = validateOwnerAlphaConfig(inputConfig);
  const { base, frontmatter } = validateEditSession(session);
  if (session.origin || computePolicyRevision(config) !== session.policyRevision
    || handoff.source.path !== session.relativePath || handoff.revision !== session.baseCommit
    || handoff.source.byteLength !== base.length
    || handoff.source.sha256 !== createHash('sha256').update(base).digest('hex')) {
    fail('owner-direct-stale-base', 'The rendered page no longer matches the owner source. Reload before editing.');
  }
  const proposal = createChangeSetProposal(base, {
    proposalId: 'owner-direct:edit',
    source: { repository: config.repository.remote.url, revision: session.baseCommit, path: session.relativePath },
    operations: handoff.operations,
    submission: { submittedAt, rationale: 'Owner direct edit.', evidence: [], identityClaim: null },
  });
  const stats = changeSetStats(proposal);
  if (base.length > config.limits.maxSourceBytes || proposal.changeSet.files[0].candidate.byteLength > config.limits.maxSourceBytes
    || stats.changedBytes > config.limits.maxChangedBytes || stats.changedLines > config.limits.maxChangedLines
    || stats.replacementBytes > config.limits.maxReplacementBytes) fail('owner-direct-limit', 'Owner edit exceeds the configured change limits.');
  const operation = deepFreeze({
    schemaVersion: 2, artifactType: 'owner-alpha-source-operation',
    source: { relativePath: session.relativePath, slug: session.slug, liveUrl: session.liveUrl, baseCommit: session.baseCommit, policyRevision: session.policyRevision },
    ...changeSetCorrection(proposal), changedBytes: stats.changedBytes, changedLines: stats.changedLines,
    frontmatter, outsideBytesUnchanged: true,
  });
  // Validation only; authorization is created separately after an authenticated Save.
  applyEditorOperation({ ...session, origin: { type: 'owner-direct' } }, operation, { allowProperties: config.owner.allowProperties });
  return deepFreeze({ session, operation });
}

function authorizationRecord(jobId, session, operation) {
  const { origin, ...sourceSession } = session;
  return {
    schemaVersion: 1, artifactType: 'owner-alpha-owner-direct-authorization', authority: 'owner-direct',
    jobId: validateJobId(jobId), source: operation.source,
    operationsDigest: digest(operation.proposal.changeSet.files[0].operations),
    sessionDigest: digest(sourceSession), operationDigest: digest(operation),
  };
}

/** Call only after owner session, exact Origin, CSRF and displayed-input binding. */
export async function authorizeOwnerDirect({ context, jobId, session, operation }) {
  if (session.origin) fail('owner-direct-origin', 'Only an ordinary owner edit session can authorize direct changes.');
  const record = authorizationRecord(jobId, session, operation);
  await createJsonArtifactOnce(context, recordPath(jobId), record);
  return deepFreeze({ ...session, origin: { type: 'owner-direct', jobId, authorizationDigest: digest(record) } });
}

/** The same immutable authority check runs before the first effect and on recovery. */
export async function guardOwnerDirect({ context, config, jobId, session, operation }) {
  const origin = session.origin;
  if (!origin || Object.keys(origin).sort().join(',') !== 'authorizationDigest,jobId,type'
    || origin.type !== 'owner-direct' || origin.jobId !== jobId
    || session.policyRevision !== computePolicyRevision(config)) fail('owner-direct-authority-mismatch', 'Owner-direct authority is missing or stale.');
  const record = await readJsonArtifact(context, recordPath(jobId));
  if (digest(record) !== origin.authorizationDigest || canonicalJson(record) !== canonicalJson(authorizationRecord(jobId, session, operation))) {
    fail('owner-direct-authority-mismatch', 'Complete owner-direct job differs from the immutable Save authorization.');
  }
  const { origin: ignored, ...originalSession } = session;
  const derived = deriveOwnerDirect({ config, session: originalSession, submittedAt: operation.proposal.submission.submittedAt, handoff: {
    source: { path: session.relativePath, byteLength: session.source.byteLength, sha256: createHash('sha256').update(Buffer.from(session.source.bytesBase64, 'base64')).digest('hex') },
    revision: session.baseCommit, operations: operation.proposal.changeSet.files[0].operations,
  } });
  if (canonicalJson(derived.operation) !== canonicalJson(operation)) fail('owner-direct-authority-mismatch', 'Owner operation no longer passes exact derivation.');
}

/** A bounded, expiring, memory-only inbox. Staging confers no authority. */
export function createOwnerHandoffStore({ now = Date.now, ttl = 10 * 60 * 1000, maximum = 64, createId = () => randomBytes(32).toString('base64url') } = {}) {
  const entries = new Map();
  const prune = () => { for (const [id, entry] of entries) if (entry.expires <= now()) entries.delete(id); };
  return {
    create(value) { prune(); if (entries.size >= maximum) fail('owner-handoff-capacity', 'Handoff inbox is full.'); const id = createId(); entries.set(id, { value, expires: now() + ttl }); return id; },
    get(id) { prune(); return entries.get(id)?.value ?? null; },
    delete(id) { entries.delete(id); },
  };
}

export function validateOwnerHandoff(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'operations,revision,slug,source'
    || !value.source || Object.keys(value.source).sort().join(',') !== 'byteLength,path,sha256'
    || typeof value.source.path !== 'string' || value.source.path.length > 4096
    || typeof value.slug !== 'string' || value.slug.length > 4096 || !value.slug || /[?#\\\p{Cc}]/u.test(value.slug)
    || value.slug.split('/').some(part => !part || part === '.' || part === '..')
    || !/^[a-f0-9]{40}$/u.test(value.revision) || !/^[a-f0-9]{64}$/u.test(value.source.sha256)
    || !Number.isSafeInteger(value.source.byteLength) || value.source.byteLength < 0 || value.source.byteLength > 4 * 1024 * 1024
    || !Array.isArray(value.operations) || value.operations.length < 1 || value.operations.length > 50
    || Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) fail('invalid-owner-handoff', 'Invalid bounded owner edit handoff.');
  // Detailed UTF-8/range/overlap/exact-byte validation uses the canonical v2 core,
  // against actual owner source, before anything is presented as saveable.
  return deepFreeze(value);
}
