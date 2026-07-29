import { createHash } from 'node:crypto';
import path from 'node:path';

const CASE_KEYS = new Set([
  'repository',
  'baseCommit',
  'sourcePath',
  'publicUrl',
  'quote',
  'prefix',
  'suffix',
  'replacement',
  'rationale',
  'evidence',
  'kind',
]);

const KINDS = new Set(['typo', 'factual', 'link', 'wording', 'formatting']);
const COMMIT_RE = /^[0-9a-f]{40}$/;
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;


export class DryRunCaseError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DryRunCaseError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new DryRunCaseError(code, message, details);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactString(value, label, { nonEmpty = false, allowNewlines = true } = {}) {
  if (typeof value !== 'string') fail('invalid-string', `${label} must be a string`);
  if (nonEmpty && value.length === 0) fail('empty-string', `${label} must not be empty`);
  if (CONTROL_RE.test(value)) fail('control-character', `${label} contains a forbidden control character`);
  if (!allowNewlines && /[\r\n]/u.test(value)) fail('newline-not-allowed', `${label} must be one line`);
  if (Buffer.from(value, 'utf8').toString('utf8') !== value) {
    fail('invalid-unicode', `${label} must round-trip as exact UTF-8`);
  }
  return value;
}

function exactHttpsUrl(value, label) {
  const text = exactString(value, label, { nonEmpty: true, allowNewlines: false });
  let url;
  try {
    url = new URL(text);
  } catch {
    fail('invalid-url', `${label} must be an absolute URL`);
  }
  if (url.protocol !== 'https:') fail('insecure-url', `${label} must use https`);
  if (url.username || url.password) fail('credentialed-url', `${label} must not contain credentials`);
  return url.href;
}

function exactSourcePath(value) {
  const sourcePath = exactString(value, 'sourcePath', { nonEmpty: true, allowNewlines: false });
  if (sourcePath.includes('\\') || /^[A-Za-z]:/u.test(sourcePath)) {
    fail('invalid-source-path', 'sourcePath must use POSIX forward-slash syntax');
  }
  const absolute = path.posix.isAbsolute(sourcePath);
  const segments = sourcePath.split('/').filter(Boolean);
  if (path.posix.normalize(sourcePath) !== sourcePath || segments.some((part) => part === '.' || part === '..')) {
    fail('unsafe-source-path', 'sourcePath must not contain dot or parent segments');
  }
  if (!absolute && sourcePath.split('/').some((part) => part === '')) {
    fail('unsafe-source-path', 'repository-relative sourcePath must not contain empty segments');
  }
  if (!sourcePath.toLowerCase().endsWith('.md')) {
    fail('non-markdown-source', 'sourcePath must identify one Markdown file');
  }
  return sourcePath;
}

export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function stableStringify(value, space = 2) {
  return `${JSON.stringify(stableValue(value), null, space)}\n`;
}

export function validateCase(input) {
  if (!isPlainRecord(input)) fail('invalid-case', 'case must be a plain object');
  const unknown = Object.keys(input).filter((key) => !CASE_KEYS.has(key));
  if (unknown.length > 0) fail('unknown-case-field', `case contains unknown field: ${unknown.sort()[0]}`);

  for (const required of ['repository', 'baseCommit', 'sourcePath', 'publicUrl', 'quote', 'replacement', 'rationale', 'evidence', 'kind']) {
    if (!Object.hasOwn(input, required)) fail('missing-case-field', `case.${required} is required`);
  }

  const baseCommit = exactString(input.baseCommit, 'baseCommit', { nonEmpty: true, allowNewlines: false });
  if (!COMMIT_RE.test(baseCommit)) fail('invalid-base-commit', 'baseCommit must be a lowercase 40-character Git object ID');

  const quote = exactString(input.quote, 'quote', { nonEmpty: true });
  const replacement = exactString(input.replacement, 'replacement');
  if (quote === replacement) fail('no-op-replacement', 'replacement must differ exactly from quote');

  if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
    fail('invalid-evidence', 'evidence must be a non-empty array');
  }
  const evidence = input.evidence.map((item, index) =>
    exactString(item, `evidence[${index}]`, { nonEmpty: true }),
  );

  const kind = exactString(input.kind, 'kind', { nonEmpty: true, allowNewlines: false });
  if (!KINDS.has(kind)) fail('invalid-kind', `kind must be one of: ${[...KINDS].join(', ')}`);

  const normalized = {
    repository: exactHttpsUrl(input.repository, 'repository'),
    baseCommit,
    sourcePath: exactSourcePath(input.sourcePath),
    publicUrl: exactHttpsUrl(input.publicUrl, 'publicUrl'),
    quote,
    ...(Object.hasOwn(input, 'prefix') ? { prefix: exactString(input.prefix, 'prefix') } : {}),
    ...(Object.hasOwn(input, 'suffix') ? { suffix: exactString(input.suffix, 'suffix') } : {}),
    replacement,
    rationale: exactString(input.rationale, 'rationale', { nonEmpty: true }),
    evidence,
    kind,
  };

  return deepFreeze(normalized);
}

export function publicSafeCase(input) {
  const value = validateCase(input);
  return deepFreeze({
    repository: value.repository,
    baseCommit: value.baseCommit,
    publicUrl: value.publicUrl,
    quote: value.quote,
    ...(Object.hasOwn(value, 'prefix') ? { prefix: value.prefix } : {}),
    ...(Object.hasOwn(value, 'suffix') ? { suffix: value.suffix } : {}),
    replacement: value.replacement,
    rationale: value.rationale,
    evidenceItems: value.evidence.length,
    kind: value.kind,
    sourceMapping: 'owner-supplied; path redacted',
  });
}

export function caseId(input) {
  const digest = createHash('sha256')
    .update(stableStringify(validateCase(input), 0))
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
  return `DRY-${digest}`;
}
