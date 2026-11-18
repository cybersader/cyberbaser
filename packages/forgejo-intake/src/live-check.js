// One live read of one Forgejo pull request through the Lane A adapter.
//
// This is a validation instrument, not a product surface. It performs the
// adapter's four read-only API requests against a real Forgejo instance and
// reads Git objects from a local clone whose remote is that instance, then
// reports whether the pull request reconstructs as one exact proposal. It
// writes nothing: no queue entry, no decision, no source, no ref left behind.
// The product shape that would make this a UI-only flow (pull requests
// appearing in the owner's inbox) is a separate decision.

import { readFile } from 'node:fs/promises';
import { lstat } from 'node:fs/promises';
import {
  readForgejoPullRequestProposal,
} from './adapter.js';
import { createForgejoApi } from './api.js';
import { validateForgejoIntakeConfig } from './config.js';
import {
  deepFreeze,
  fail,
  ForgejoIntakeError,
  isPlainObject,
  requirePositiveInteger,
} from './contract.js';
import { createForgejoGitReader } from './git.js';

export const LIVE_CHECK_SCHEMA_VERSION = 1;
export const LIVE_CHECK_MAX_CONFIG_BYTES = 64 * 1024;
export const LIVE_CHECK_MAX_TOKEN_BYTES = 4096;

/** Read one token file per request; never cached, never echoed. */
export function createTokenFileReader(file) {
  if (typeof file !== 'string' || file.length === 0) fail('invalid-token-file', 'token file path must be a non-empty string');
  return async function getToken() {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail('invalid-token-file', 'token file must be one regular file');
    if ((metadata.mode & 0o077) !== 0) fail('token-file-too-open', 'token file must not be readable by group or others');
    if (metadata.size === 0 || metadata.size > LIVE_CHECK_MAX_TOKEN_BYTES) fail('invalid-token-file', 'token file size is out of range');
    const token = (await readFile(file, 'utf8')).trim();
    if (token.length === 0 || /\s/u.test(token)) fail('invalid-token-file', 'token file must hold one token');
    return token;
  };
}

/** Load and validate one Lane A config file. */
export async function loadForgejoIntakeConfig(file) {
  if (typeof file !== 'string' || file.length === 0) fail('invalid-config-file', 'config file path must be a non-empty string');
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail('invalid-config-file', 'config must be one regular file');
  if (metadata.size > LIVE_CHECK_MAX_CONFIG_BYTES) fail('invalid-config-file', 'config file is too large');
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    fail('invalid-config-file', 'config file is not strict JSON');
  }
  return validateForgejoIntakeConfig(parsed);
}

function textPreview(bytesBase64, maximum = 160) {
  const text = Buffer.from(bytesBase64, 'base64').toString('utf8').replace(/\s+/gu, ' ').trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

/**
 * The bounded report the maintainer reads. It never contains the token and
 * never contains raw untrusted bytes beyond two short previews.
 */
export function liveCheckReport({ config, pullRequestNumber, result }) {
  const { proposal, carrier, trust, verifiedSubject } = result;
  const oldBytes = Buffer.from(proposal.operation.expectedOldBytesBase64, 'base64');
  const replacementBytes = Buffer.from(proposal.operation.replacementBytesBase64, 'base64');
  return deepFreeze({
    schemaVersion: LIVE_CHECK_SCHEMA_VERSION,
    outcome: 'reconstructed',
    forge: { origin: config.forgejo.origin, version: carrier.instanceVersion },
    repository: { fullName: config.repository.fullName, id: carrier.repositoryId, baseBranch: config.repository.baseBranch },
    pullRequest: { number: pullRequestNumber, url: carrier.pullRequestUrl, baseSha: proposal.source.revision },
    author: { subject: verifiedSubject.author, type: verifiedSubject.authorType },
    change: {
      path: proposal.source.path,
      start: proposal.operation.start,
      end: proposal.operation.end,
      oldBytes: oldBytes.length,
      replacementBytes: replacementBytes.length,
      oldPreview: textPreview(proposal.operation.expectedOldBytesBase64),
      replacementPreview: textPreview(proposal.operation.replacementBytesBase64),
    },
    proposal: { proposalId: proposal.proposalId, digest: result.proposalDigest },
    trust: {
      policyStatus: trust.policyStatus,
      tier: trust.classification.tier,
      route: trust.classification.route,
      reasons: trust.classification.reasons ?? [],
    },
    boundary: 'Read-only. Nothing was queued, decided, written, pushed, or published.',
  });
}

/**
 * Run the live check. `fetch` and `execute` default to the real ones; tests
 * inject fakes. Returns `{ ok, report, error }` and throws only on programmer
 * error, so callers can print refusals as data.
 */
// The validator adds derived fields (origin, fullName) and refuses them on the
// way back in, so a normalized config is reduced to its canonical shape first.
function canonicalConfigInput(value) {
  if (!isPlainObject(value) || !isPlainObject(value.forgejo) || !isPlainObject(value.repository)) return value;
  return {
    schemaVersion: value.schemaVersion,
    forgejo: { apiBaseUrl: value.forgejo.apiBaseUrl },
    repository: {
      url: value.repository.url,
      owner: value.repository.owner,
      name: value.repository.name,
      baseBranch: value.repository.baseBranch,
    },
  };
}

export async function runForgejoLiveCheck({
  config: configInput,
  checkout,
  pullRequestNumber,
  fetch: fetchImpl = globalThis.fetch,
  getToken = null,
  execute = null,
  remote = 'origin',
} = {}) {
  const canonical = canonicalConfigInput(configInput);
  const config = validateForgejoIntakeConfig(canonical);
  const number = requirePositiveInteger(pullRequestNumber, 'pullRequestNumber');
  if (typeof checkout !== 'string' || checkout.length === 0) fail('invalid-checkout', 'checkout must be a local clone whose remote is the Forgejo repository');
  const api = createForgejoApi({ fetch: fetchImpl, getToken });
  const git = createForgejoGitReader({ checkout, execute });
  try {
    const result = await readForgejoPullRequestProposal({ config: canonical, pullRequestNumber: number, api, git, remote });
    return deepFreeze({ ok: true, report: liveCheckReport({ config, pullRequestNumber: number, result }), result, error: null });
  } catch (error) {
    if (!(error instanceof ForgejoIntakeError)) throw error;
    const details = isPlainObject(error.details) ? error.details : {};
    return deepFreeze({
      ok: false,
      report: deepFreeze({
        schemaVersion: LIVE_CHECK_SCHEMA_VERSION,
        outcome: 'refused',
        forge: { origin: config.forgejo.origin },
        repository: { fullName: config.repository.fullName, baseBranch: config.repository.baseBranch },
        pullRequest: { number },
        refusal: { code: error.code, message: error.message, details },
        boundary: 'Read-only. Nothing was queued, decided, written, pushed, or published.',
      }),
      result: null,
      error: { code: error.code, message: error.message },
    });
  }
}

/** Plain-words lines for a terminal or a log entry. */
export function formatLiveCheckReport(report) {
  if (report.outcome === 'refused') {
    return [
      `Forgejo ${report.forge.origin} · ${report.repository.fullName} · pull request #${report.pullRequest.number}`,
      `REFUSED: ${report.refusal.code}`,
      report.refusal.message,
      report.boundary,
    ].join('\n');
  }
  return [
    `Forgejo ${report.forge.version} at ${report.forge.origin} · ${report.repository.fullName} · pull request #${report.pullRequest.number}`,
    `RECONSTRUCTED as one exact proposal: ${report.proposal.proposalId}`,
    `Page: ${report.change.path} · bytes ${report.change.start}–${report.change.end} · ${report.change.oldBytes} old, ${report.change.replacementBytes} new`,
    `Before: “${report.change.oldPreview}”`,
    `After:  “${report.change.replacementPreview}”`,
    `Author: ${report.author.subject} · trust policy ${report.trust.policyStatus} · ${report.trust.tier} · route ${report.trust.route}`,
    report.boundary,
  ].join('\n');
}
