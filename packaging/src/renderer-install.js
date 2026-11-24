// The site's own renderer, installed beside the node (install --renderer).
//
// The owner points the installer at an assembled renderer directory (one that
// follows the renderer contract: `<dir>/build <contentDir> <outDir>`, offline,
// on the pinned Quartz commit, with its npm dependencies already installed).
// The installer checks it, copies it whole into the node's own state
// (/var/lib/cyberbaser/renderers/<name>), hands it to the node account, and
// takes every group/other write bit away. The node's renderer slot re-checks
// the copy before every build (apps/owner-alpha/src/renderer-slot.js). The
// original is never changed and never used again.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';

export const RENDERER_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const MAX_FINGERPRINT = 64;
// Never copied: build caches the renderer recreates.
const SKIP = new Set(['.quartz-cache']);

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.error?.message || '').trim().slice(-300)}`);
  }
  return result.stdout.trim();
}

/** "a,b,c" or "@file" (one entry per line, # comments) into a clean list. */
export function parseFingerprint(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('--renderer-fingerprint needs a list or @file');
  const text = value.startsWith('@') ? readFileSync(path.resolve(value.slice(1)), 'utf8') : value.replaceAll(',', '\n');
  const entries = text.split('\n').map((line) => line.replace(/#.*$/u, '').trim().replace(/\/+$/u, '')).filter(Boolean);
  if (entries.length === 0 || entries.length > MAX_FINGERPRINT) throw new Error(`the fingerprint must list 1 to ${MAX_FINGERPRINT} entries`);
  for (const entry of entries) {
    if (path.isAbsolute(entry) || path.normalize(entry) !== entry || entry.split('/').includes('..') || /[\\\p{Cc}]/u.test(entry)) {
      throw new Error(`fingerprint entry is not a plain relative path: ${entry}`);
    }
  }
  if (new Set(entries).size !== entries.length) throw new Error('fingerprint entries must be unique');
  if (!entries.includes('build')) throw new Error('the fingerprint must include build');
  if (entries.some((entry) => entries.some((other) => other.startsWith(`${entry}/`)))) {
    throw new Error('fingerprint entries must not contain one another');
  }
  return [...entries].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Refuse a source that is not one real directory with an executable build,
 * holds anything but files, directories and links that stay inside it, or
 * lacks a fingerprinted entry. Returns the number of entries seen.
 */
export function inspectRendererSource(source, { fingerprint, quartzCommit } = {}) {
  if (!path.isAbsolute(source)) throw new Error('the renderer directory must be an absolute path');
  let top;
  try { top = lstatSync(source); } catch { throw new Error(`no renderer directory at ${source}`); }
  if (top.isSymbolicLink() || !top.isDirectory()) throw new Error('the renderer must be a real directory, not a link');
  if (realpathSync(source) !== path.resolve(source)) throw new Error('the renderer path must not pass through a link');
  const build = lstatSync(path.join(source, 'build'), { throwIfNoEntry: false });
  if (!build?.isFile() || (build.mode & 0o100) === 0) throw new Error('the renderer has no executable build file');
  let count = 0;
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (directory === source && SKIP.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      count += 1;
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(full);
        const resolved = path.resolve(directory, target);
        if (path.isAbsolute(target) || (resolved !== source && !resolved.startsWith(`${source}/`))) {
          throw new Error(`the renderer has a link that leaves it: ${path.relative(source, full)}`);
        }
      } else if (entry.isDirectory()) {
        walk(full);
      } else if (!entry.isFile()) {
        throw new Error(`the renderer holds something that is not a file: ${path.relative(source, full)}`);
      }
    }
  };
  walk(source);
  for (const entry of fingerprint ?? []) {
    const found = lstatSync(path.join(source, entry), { throwIfNoEntry: false });
    if (!found || found.isSymbolicLink()) throw new Error(`fingerprinted entry missing or a link: ${entry}`);
  }
  // A renderer kept as a Quartz checkout must be on the pinned commit.
  if (quartzCommit && lstatSync(path.join(source, '.git'), { throwIfNoEntry: false })) {
    const head = spawnSync('git', ['-c', `safe.directory=${source}`, '-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (head.status === 0 && head.stdout.trim() !== quartzCommit) throw new Error('the renderer checkout is not on the pinned Quartz commit');
  }
  return count;
}

/**
 * Copy the renderer into `<parent>/<name>` for the node account. The copy is
 * built beside the old one and swapped in whole. Returns the renderer section
 * the node config takes.
 */
export async function installRenderer({ source, name, quartzCommit, fingerprint, parent, owner, group }) {
  if (!RENDERER_NAME_RE.test(name ?? '') || name === 'quartz-cyberbase') throw new Error('the renderer needs a name (--renderer-name), not quartz-cyberbase');
  inspectRendererSource(source, { fingerprint, quartzCommit });
  const target = path.join(parent, name);
  const stage = path.join(parent, `.${name}.new-${randomBytes(4).toString('hex')}`);
  const previous = path.join(parent, `.${name}.old-${randomBytes(4).toString('hex')}`);
  try {
    // Contents, modes and links as links; no owners, ACLs or labels carried
    // over, and never a group or other write bit.
    run('rsync', ['-rlpt', '--no-owner', '--no-group', '--chmod=go-w', '--exclude=/.quartz-cache', `${source}/`, `${stage}/`]);
    run('chown', ['-R', '-h', `${owner}:${group}`, stage]);
    run('chmod', ['go-w', stage]);
    const after = inspectRendererSource(stage, { fingerprint });
    if (after < 1) throw new Error('the renderer copy is empty');
    if (lstatSync(target, { throwIfNoEntry: false })) await rename(target, previous);
    await rename(stage, target);
    await rm(previous, { recursive: true, force: true });
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze({ name, directory: target, quartzCommit, fingerprint });
}
