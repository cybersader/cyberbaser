// A throwaway vault repository for page-bundle tests: publish.yml allows
// topic/, one published note, one draft, a private image, a home page.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPageBundle } from '../../../packages/proposal/src/page-bundle.js';
import { bundleGit } from '../src/core/page-bundle.js';

export const REMOTE_URL = 'https://github.com/example/vault.git';
export const SUBMISSION = Object.freeze({ submittedAt: '2026-11-24T12:00:00Z', rationale: 'Bundle test.', evidence: [], identityClaim: null });

export function gitSync(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

export const VAULT = Object.freeze({
  'publish.yml': 'allow:\n  - "topic/**"\n',
  'topic/existing.md': '---\ntitle: Existing\n---\n# Existing\n\nHello. ![[shared/shown.png]]\n',
  'shared/shown.png': null,
  'topic/a-b.md': '# A B\n',
  'topic/draft.md': '---\ndraft: true\n---\nNot yet.\n',
  'shared/private.png': null,
  'index.md': '# Home\n',
});

/** { root, repo, git, head } with every VAULT file committed on main. */
export async function bundleVault(files = VAULT, privatePng) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oa-bundle-'));
  const repo = path.join(root, 'vault');
  await mkdir(repo, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await writeFile(path.join(repo, name), text ?? privatePng ?? Buffer.from('not used'));
  }
  gitSync(root, 'init', '-q', '--initial-branch=main', repo);
  gitSync(repo, 'config', 'user.name', 'Fixture');
  gitSync(repo, 'config', 'user.email', 'fixture@example.invalid');
  gitSync(repo, 'add', '-A');
  gitSync(repo, 'commit', '-q', '-m', 'vault');
  return { root, repo, git: bundleGit(repo), head: gitSync(repo, 'rev-parse', 'main') };
}

let counter = 0;
/** A bundle against `head`: creates [{path,text}], assets [{path, bytes, mediaType?}], modify or null. */
export function bundleOf(head, { creates = [], assets = [], modify = null } = {}) {
  counter += 1;
  const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
  return createPageBundle({ bundleId: `test-${counter}`, source: { repository: REMOTE_URL, revision: head }, submission: SUBMISSION,
    modify, creates, assets: assets.map((asset) => ({ path: asset.path, bytes: asset.bytes,
      mediaType: asset.mediaType ?? types[asset.path.slice(asset.path.lastIndexOf('.') + 1).toLowerCase()] })) });
}

export const readerFor = (assets = []) => {
  const byPath = new Map(assets.map((asset) => [asset.path, asset.bytes]));
  return async (p) => byPath.get(p);
};
