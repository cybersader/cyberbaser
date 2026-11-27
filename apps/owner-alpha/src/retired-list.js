import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fail } from './errors.js';
import { isPlainObject } from './json.js';
import { foldWorkspaceText } from './owner-publication.js';

const MAX_BYTES = 4 * 1024 * 1024;
const FIELDS = ['version', 'pathPrefixes', 'paths', 'contentDigests'];
const hexDigest = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const EMPTY_DIGEST = hexDigest('');
const invalid = () => { throw new Error('invalid retired list'); };

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function pathRules(values, prefix = false) {
  if (!Array.isArray(values)) invalid();
  const rules = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !value.isWellFormed() || /[\\\u0000]/u.test(value)) invalid();
    const rule = prefix ? value.replace(/\/$/u, '') : value;
    if (rule.split('/').some((part) => part === '' || part === '.' || part === '..')) invalid();
    rules.add(rule.normalize('NFC'));
  }
  return rules;
}

function digestRules(values) {
  if (!Array.isArray(values)) invalid();
  const rules = new Set();
  for (const value of values) {
    if (typeof value !== 'string') invalid();
    let hex;
    if (/^[a-f0-9]{64}$/u.test(value)) hex = value;
    else if (/^sha-256=:[A-Za-z0-9+/]{43}=:$/u.test(value)) {
      const base64 = value.slice(9, -1);
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.toString('base64') !== base64) invalid();
      hex = bytes.toString('hex');
    } else invalid();
    if (hex !== EMPTY_DIGEST) rules.add(hex);
  }
  return rules;
}

async function readRules(file, checkout, context) {
  const parent = path.dirname(file);
  if (await realpath(parent) !== parent) invalid();
  for (const root of [checkout, context.workspaceRoot, context.storeRoot]) {
    if (isWithin(root, file) || isWithin(await realpath(root).catch((error) => {
      if (error?.code === 'ENOENT') return root;
      throw error;
    }), file)) invalid();
  }
  // A different worktree or repository is not an acceptable hiding place either.
  for (let dir = parent; ; dir = path.dirname(dir)) {
    const git = await lstat(path.join(dir, '.git')).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (git !== null) invalid();
    if (path.dirname(dir) === dir) break;
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (stat.mode & 0o400) === 0
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      || stat.size < 1 || stat.size > MAX_BYTES) invalid();
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await lstat(file);
    if (length !== stat.size || after.ino !== stat.ino || after.dev !== stat.dev
      || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) invalid();
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)));
    if (!isPlainObject(input) || Object.keys(input).length !== FIELDS.length
      || FIELDS.some((key) => !Object.hasOwn(input, key)) || input.version !== 1) invalid();
    return { prefixes: pathRules(input.pathPrefixes, true), paths: pathRules(input.paths), digests: digestRules(input.contentDigests) };
  } finally {
    await handle.close();
  }
}

/** Rule data remains entirely in this function's local scope. Never project it. */
export async function assertWorkspaceNotRetired({ config, context, mapping, text }) {
  const file = config.ownerPublication.retiredList?.file;
  if (mapping.source.kind !== 'workspace' || file === undefined) return;
  let rules;
  try {
    rules = await readRules(file, config.repository.checkout, context);
  } catch {
    fail('retired-list-unavailable', 'private retirement policy is unavailable');
  }
  const retiredPath = (value) => {
    const normalized = value.normalize('NFC');
    if (rules.paths.has(normalized)) return true;
    for (let current = normalized; current !== '.'; current = path.posix.dirname(current)) {
      if (rules.prefixes.has(current)) return true;
    }
    return false;
  };
  if (retiredPath(mapping.source.path) || retiredPath(mapping.relativePath)
    || [text, text.replaceAll('\r\n', '\n'), foldWorkspaceText(text)].some((form) => rules.digests.has(hexDigest(form)))) {
    fail('retired-material', 'workspace publication contains retired material');
  }
}
