const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'prNumber',
  'author',
  'authorType',
  'trustRoute',
  'ofmVerdict',
  'checks',
  'maintainerDecision',
  'mergeCommitSha',
  'baseSha',
  'headSha',
  'timestamps',
];
const CHECK_KEYS = ['name', 'appSlug', 'status', 'conclusion'];
const TIMESTAMP_KEYS = ['openedAt', 'closedAt', 'recordedAt'];
const AUTHOR_TYPES = new Set(['agent', 'human', 'anonymous']);
const TRUST_ROUTES = ['auto-merge', 'quick-review', 'full-review', 'reject'];
const TRUST_ROUTE_SET = new Set(TRUST_ROUTES);
const OFM_VERDICTS = new Set(['clean', 'suspect', 'damage', 'not-applicable']);
const CHECK_STATUSES = new Set(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending']);
const DECISIONS = new Set(['merged', 'closed-unmerged']);
const SHA_RE = /^[0-9a-f]{40}$/;
const UTC_SECOND_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export class LedgerError extends Error {
  constructor(code, message, details = {}, exitCode = 2) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

function fail(code, message, details = {}, exitCode = 2) {
  throw new LedgerError(code, message, details, exitCode);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value, label) {
  if (!isRecord(value)) fail('invalid-record', `${label} must be an object`);
  return value;
}

function requireExactKeys(value, keys, label) {
  requireRecord(value, label);
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0) {
    fail('unknown-field', `${label} contains unknown field ${unknown[0]}`, { field: unknown[0] });
  }
  if (missing.length > 0) {
    fail('missing-field', `${label} is missing required field ${missing[0]}`, { field: missing[0] });
  }
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function requireString(value, label, { nullable = false, nonEmpty = true } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') fail('invalid-string', `${label} must be a string${nullable ? ' or null' : ''}`);
  if (nonEmpty && value.length === 0) fail('empty-string', `${label} must not be empty`);
  if (hasUnpairedSurrogate(value)) fail('invalid-unicode', `${label} contains an unpaired surrogate`);
  return value;
}

function requireEnum(value, allowed, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!allowed.has(value)) fail('invalid-enum', `${label} has unsupported value ${JSON.stringify(value)}`);
  return value;
}

function requireSha(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !SHA_RE.test(value)) {
    fail('invalid-sha', `${label} must be a lowercase 40-character Git object ID`);
  }
  return value;
}

function parseUtcSecond(value, label) {
  if (typeof value !== 'string' || !UTC_SECOND_RE.test(value)) {
    fail('invalid-timestamp', `${label} must be an RFC 3339 UTC timestamp with second precision`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().replace('.000Z', 'Z') !== value) {
    fail('invalid-timestamp', `${label} is not a real UTC timestamp`);
  }
  return milliseconds;
}

export function normalizeUtcSecond(value, label = 'timestamp') {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) fail('invalid-timestamp', `${label} must be a valid date`);
    return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  if (typeof value !== 'string') fail('invalid-timestamp', `${label} must be a string or Date`);
  const match = value.match(RFC3339_RE);
  if (!match) fail('invalid-timestamp', `${label} must be an RFC 3339 date-time`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year
    || calendar.getUTCMonth() !== month - 1
    || calendar.getUTCDate() !== day
    || hour > 23
    || minute > 59
    || second > 59
  ) {
    fail('invalid-timestamp', `${label} must be a real RFC 3339 date-time`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail('invalid-timestamp', `${label} must be a valid date-time`);
  return new Date(Math.floor(milliseconds / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareChecks(left, right) {
  return compareText(left.appSlug, right.appSlug) || compareText(left.name, right.name);
}

function validateCheck(check, index) {
  const label = `checks[${index}]`;
  requireExactKeys(check, CHECK_KEYS, label);
  const normalized = {
    name: requireString(check.name, `${label}.name`),
    appSlug: requireString(check.appSlug, `${label}.appSlug`),
    status: requireEnum(check.status, CHECK_STATUSES, `${label}.status`),
    conclusion: requireString(check.conclusion, `${label}.conclusion`, { nullable: true }),
  };
  if (normalized.status === 'completed' && normalized.conclusion === null) {
    fail('invalid-check-conclusion', `${label}.conclusion must be a string when status is completed`);
  }
  if (normalized.status !== 'completed' && normalized.conclusion !== null) {
    fail('invalid-check-conclusion', `${label}.conclusion must be null while the check is incomplete`);
  }
  return normalized;
}

function validateChecks(checks) {
  if (!Array.isArray(checks)) fail('invalid-checks', 'checks must be an array');
  const normalized = checks.map(validateCheck);
  for (let index = 1; index < normalized.length; index += 1) {
    const comparison = compareChecks(normalized[index - 1], normalized[index]);
    if (comparison === 0) {
      fail('duplicate-check', 'checks must contain one run per (appSlug, name) pair');
    }
    if (comparison > 0) {
      fail('unsorted-checks', 'checks must be sorted by appSlug, then name');
    }
  }
  return normalized;
}

export function validateLedgerEntry(value) {
  requireExactKeys(value, TOP_LEVEL_KEYS, 'entry');
  if (value.schemaVersion !== 1) {
    fail('unsupported-schema', `unsupported schemaVersion ${JSON.stringify(value.schemaVersion)}`, {}, 3);
  }
  if (!Number.isSafeInteger(value.prNumber) || value.prNumber <= 0) {
    fail('invalid-pr-number', 'prNumber must be a positive safe integer');
  }

  const author = requireString(value.author, 'author', { nullable: true });
  const authorType = requireEnum(value.authorType, AUTHOR_TYPES, 'authorType');
  if ((author === null) !== (authorType === 'anonymous')) {
    fail('invalid-author-relationship', 'author must be null exactly when authorType is anonymous');
  }

  const trustRoute = requireEnum(value.trustRoute, TRUST_ROUTE_SET, 'trustRoute', { nullable: true });
  const ofmVerdict = requireEnum(value.ofmVerdict, OFM_VERDICTS, 'ofmVerdict');
  const checks = validateChecks(value.checks);
  const maintainerDecision = requireEnum(value.maintainerDecision, DECISIONS, 'maintainerDecision');
  const mergeCommitSha = requireSha(value.mergeCommitSha, 'mergeCommitSha', { nullable: true });
  if ((maintainerDecision === 'merged') !== (mergeCommitSha !== null)) {
    fail('invalid-merge-relationship', 'mergeCommitSha must be present exactly when maintainerDecision is merged');
  }

  const baseSha = requireSha(value.baseSha, 'baseSha');
  const headSha = requireSha(value.headSha, 'headSha');
  if (baseSha === headSha) fail('invalid-sha-relationship', 'baseSha and headSha must differ');

  requireExactKeys(value.timestamps, TIMESTAMP_KEYS, 'timestamps');
  const openedAt = normalizeUtcSecond(value.timestamps.openedAt, 'timestamps.openedAt');
  const closedAt = normalizeUtcSecond(value.timestamps.closedAt, 'timestamps.closedAt');
  const recordedAt = normalizeUtcSecond(value.timestamps.recordedAt, 'timestamps.recordedAt');
  const openedMs = parseUtcSecond(openedAt, 'timestamps.openedAt');
  const closedMs = parseUtcSecond(closedAt, 'timestamps.closedAt');
  const recordedMs = parseUtcSecond(recordedAt, 'timestamps.recordedAt');
  if (openedMs > closedMs || closedMs > recordedMs) {
    fail('invalid-timestamp-relationship', 'timestamps must satisfy openedAt <= closedAt <= recordedAt');
  }

  return {
    schemaVersion: 1,
    prNumber: value.prNumber,
    author,
    authorType,
    trustRoute,
    ofmVerdict,
    checks,
    maintainerDecision,
    mergeCommitSha,
    baseSha,
    headSha,
    timestamps: { openedAt, closedAt, recordedAt },
  };
}

export function serializeLedgerEntry(value) {
  return `${JSON.stringify(validateLedgerEntry(value))}\n`;
}

function parseLine(line, lineNumber) {
  let value;
  try {
    value = JSON.parse(line);
  } catch (error) {
    fail('malformed-json', `line ${lineNumber} is not valid JSON: ${error.message}`, { line: lineNumber });
  }
  let entry;
  try {
    entry = validateLedgerEntry(value);
  } catch (error) {
    if (error instanceof LedgerError) {
      error.details = { line: lineNumber, ...error.details };
      error.message = `line ${lineNumber}: ${error.message}`;
    }
    throw error;
  }
  const canonical = JSON.stringify(entry);
  if (line !== canonical) {
    fail('noncanonical-line', `line ${lineNumber} is not in canonical compact form`, { line: lineNumber });
  }
  return entry;
}

export function parseLedgerText(text) {
  if (typeof text !== 'string') fail('invalid-ledger-text', 'ledger content must be a string');
  if (text.startsWith('﻿')) fail('utf8-bom', 'ledger must not begin with a UTF-8 BOM', { line: 1 });
  if (text === '') return [];
  if (!text.endsWith('\n')) fail('partial-final-line', 'ledger must end with LF');
  const lines = text.slice(0, -1).split('\n');
  const entries = [];
  const seen = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    if (line.length === 0) fail('blank-line', `line ${lineNumber} is blank`, { line: lineNumber });
    if (line.endsWith('\r')) fail('noncanonical-line-ending', `line ${lineNumber} uses CRLF instead of LF`, { line: lineNumber });
    const entry = parseLine(line, lineNumber);
    if (seen.has(entry.prNumber)) {
      fail(
        'duplicate-pr-number',
        `line ${lineNumber} duplicates prNumber ${entry.prNumber} from line ${seen.get(entry.prNumber)}`,
        { line: lineNumber, firstLine: seen.get(entry.prNumber), prNumber: entry.prNumber },
        3,
      );
    }
    seen.set(entry.prNumber, lineNumber);
    entries.push(entry);
  }
  return entries;
}

function trustRouteFromLabels(labels) {
  if (!Array.isArray(labels)) fail('invalid-labels', 'pull_request.labels must be an array');
  const recognized = [];
  for (const [index, label] of labels.entries()) {
    const name = typeof label === 'string' ? label : label?.name;
    if (typeof name !== 'string') fail('invalid-label', `pull_request.labels[${index}] must have a string name`);
    if (!name.startsWith('trust:')) continue;
    const route = name.slice('trust:'.length);
    if (!TRUST_ROUTE_SET.has(route)) {
      fail('unknown-trust-label', `unknown trust label ${name}`);
    }
    recognized.push(route);
  }
  if (recognized.length > 1) {
    fail('contradictory-trust-labels', 'closed event contains more than one recognized trust label');
  }
  return recognized[0] ?? null;
}

function authorFromPullRequest(pullRequest) {
  const login = pullRequest.user?.login;
  const author = typeof login === 'string' && login.length > 0 ? requireString(login, 'pull_request.user.login') : null;
  if (author === null) return { author: null, authorType: 'anonymous' };
  return { author, authorType: null };
}

function checkRunRecency(run, index) {
  if (Number.isSafeInteger(run?.id)) return [2, run.id, index];
  for (const field of ['completed_at', 'started_at', 'created_at']) {
    const time = Date.parse(run?.[field]);
    if (Number.isFinite(time)) return [1, time, index];
  }
  return [0, 0, index];
}

function newerThan(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

export function normalizeCheckRuns(checkRuns, { exclude = [] } = {}) {
  if (!Array.isArray(checkRuns)) fail('invalid-checks', 'checkRuns must be an array');
  if (!Array.isArray(exclude)) fail('invalid-check-exclusions', 'exclude must be an array');
  const exclusions = new Set(exclude.map((item) => {
    requireRecord(item, 'check exclusion');
    return `${requireString(item.appSlug, 'check exclusion.appSlug')}\0${requireString(item.name, 'check exclusion.name')}`;
  }));
  const newest = new Map();
  checkRuns.forEach((run, index) => {
    requireRecord(run, `checkRuns[${index}]`);
    const appSlug = run.appSlug ?? run.app?.slug;
    const name = run.name;
    const status = run.status;
    const conclusion = run.conclusion ?? null;
    const check = validateCheck({ name, appSlug, status, conclusion }, index);
    const key = `${check.appSlug}\0${check.name}`;
    if (exclusions.has(key)) return;
    const recency = checkRunRecency(run, index);
    const previous = newest.get(key);
    if (!previous || newerThan(recency, previous.recency)) newest.set(key, { check, recency });
  });
  return [...newest.values()].map(({ check }) => check).sort(compareChecks);
}

function requireBuilderKeys(input) {
  const keys = ['event', 'agents', 'ofmVerdict', 'checkRuns', 'recordedAt', 'decisionActorPermission', 'excludedChecks'];
  requireRecord(input, 'input');
  for (const key of Object.keys(input)) {
    if (!keys.includes(key)) fail('unknown-field', `input contains unknown field ${key}`, { field: key });
  }
  for (const key of ['event', 'ofmVerdict', 'checkRuns', 'decisionActorPermission']) {
    if (!Object.hasOwn(input, key)) fail('missing-field', `input is missing required field ${key}`, { field: key });
  }
}

export function buildLedgerEntry(input) {
  requireBuilderKeys(input);
  const event = requireRecord(input.event, 'event');
  const pullRequest = requireRecord(event.pull_request, 'event.pull_request');
  const { author, authorType: initialAuthorType } = authorFromPullRequest(pullRequest);
  const agents = input.agents === undefined ? [] : input.agents;
  if (!Array.isArray(agents) || agents.some((agent) => typeof agent !== 'string')) {
    fail('invalid-agents', 'agents must be an array of strings');
  }
  const lowerAuthor = author?.toLowerCase() ?? null;
  const agentSet = new Set(agents.map((agent) => agent.toLowerCase()));
  const authorType = initialAuthorType ?? (
    agentSet.has(lowerAuthor)
    || pullRequest.user?.type === 'Bot'
    || lowerAuthor.endsWith('[bot]')
      ? 'agent'
      : 'human'
  );

  const merged = pullRequest.merged;
  if (typeof merged !== 'boolean') fail('invalid-merged-flag', 'pull_request.merged must be boolean');
  const actor = merged ? pullRequest.merged_by?.login : event.sender?.login;
  requireString(actor, merged ? 'pull_request.merged_by.login' : 'sender.login');
  if (!new Set(['maintain', 'admin']).has(input.decisionActorPermission)) {
    fail('decision-actor-not-maintainer', 'decision actor must currently have maintain or admin permission');
  }

  const entry = {
    schemaVersion: 1,
    prNumber: pullRequest.number,
    author,
    authorType,
    trustRoute: trustRouteFromLabels(pullRequest.labels ?? []),
    ofmVerdict: input.ofmVerdict,
    checks: normalizeCheckRuns(input.checkRuns, { exclude: input.excludedChecks ?? [] }),
    maintainerDecision: merged ? 'merged' : 'closed-unmerged',
    mergeCommitSha: merged ? pullRequest.merge_commit_sha : null,
    baseSha: pullRequest.base?.sha,
    headSha: pullRequest.head?.sha,
    timestamps: {
      openedAt: pullRequest.created_at,
      closedAt: pullRequest.closed_at,
      recordedAt: input.recordedAt ?? new Date(),
    },
  };
  return validateLedgerEntry(entry);
}

export function dedupeLedgerEntry(entries, candidate) {
  if (!Array.isArray(entries)) fail('invalid-entries', 'entries must be an array');
  const normalizedCandidate = validateLedgerEntry(candidate);
  const foundIndex = entries.findIndex((entry) => entry?.prNumber === normalizedCandidate.prNumber);
  if (foundIndex === -1) {
    return { status: 'append', entry: normalizedCandidate, line: entries.length + 1 };
  }
  const existing = validateLedgerEntry(entries[foundIndex]);
  return {
    status: existing.timestamps.closedAt === normalizedCandidate.timestamps.closedAt
      ? 'already-recorded'
      : 'already-recorded-reclosed',
    entry: existing,
    line: foundIndex + 1,
  };
}

function emptyRouteCounts() {
  return { total: 0, merged: 0, 'closed-unmerged': 0 };
}

export function calculateLedgerStats(entries, { target = 20 } = {}) {
  if (!Array.isArray(entries)) fail('invalid-entries', 'entries must be an array');
  if (!Number.isSafeInteger(target) || target <= 0) fail('invalid-target', 'target must be a positive safe integer');
  const normalized = entries.map(validateLedgerEntry);
  const routes = {
    'auto-merge': emptyRouteCounts(),
    'quick-review': emptyRouteCounts(),
    'full-review': emptyRouteCounts(),
    reject: emptyRouteCounts(),
    unclassified: emptyRouteCounts(),
  };
  let agreeing = 0;
  let outcomeBearing = 0;
  let autoMergeDisagreements = 0;
  let observed = 0;

  for (const entry of normalized) {
    const routeKey = entry.trustRoute ?? 'unclassified';
    routes[routeKey].total += 1;
    routes[routeKey][entry.maintainerDecision] += 1;
    if (entry.trustRoute !== null) observed += 1;
    if (entry.trustRoute === 'auto-merge') {
      outcomeBearing += 1;
      if (entry.maintainerDecision === 'merged') agreeing += 1;
      else autoMergeDisagreements += 1;
    } else if (entry.trustRoute === 'reject') {
      outcomeBearing += 1;
      if (entry.maintainerDecision === 'closed-unmerged') agreeing += 1;
    }
  }

  const zeroAutoMergeDisagreements = autoMergeDisagreements === 0;
  return {
    entries: normalized.length,
    routes,
    agreement: {
      agreeing,
      outcomeBearing,
      agreementRate: outcomeBearing === 0 ? null : agreeing / outcomeBearing,
      autoMergeDisagreements,
    },
    progress: {
      target,
      observed,
      remaining: Math.max(0, target - observed),
      thresholdMet: observed >= target,
      autoMergeDisagreements,
      zeroAutoMergeDisagreements,
      preconditionMet: observed >= target && zeroAutoMergeDisagreements,
    },
  };
}

export const LEDGER_SCHEMA_VERSION = 1;
export const LEDGER_TRUST_ROUTES = Object.freeze([...TRUST_ROUTES]);
