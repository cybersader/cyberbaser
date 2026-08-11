import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { CONFIG } from './fixtures.js';

const exec = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function createGitFixture({
  baseText = '# Notes\n\nA paragraph about teh process.\n',
  headText = '# Notes\n\nA paragraph about the process.\n',
  sourcePath = 'docs/notes.md',
  policyText = 'trusted:\n  - "forgejo:https://forge.example:8443#user=123"\n',
  mutateBase = null,
  mutateHead = null,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cyberbaser-forgejo-intake-'));
  const bare = join(root, 'remote.git');
  const checkout = join(root, 'checkout');
  await mkdir(bare);
  await mkdir(checkout);
  await git(bare, ['init', '--bare', '--initial-branch=main']);
  await git(checkout, ['init', '--initial-branch=main']);
  await git(checkout, ['config', 'user.name', 'Forgejo Intake Test']);
  await git(checkout, ['config', 'user.email', 'forgejo-intake@example.invalid']);
  await git(checkout, ['remote', 'add', 'origin', `file://${bare}`]);

  const sourceFile = join(checkout, sourcePath);
  await mkdir(dirname(sourceFile), { recursive: true });
  await writeFile(sourceFile, baseText);
  if (policyText !== null) {
    await mkdir(join(checkout, '.cyberbaser'), { recursive: true });
    await writeFile(join(checkout, '.cyberbaser', 'trust.yml'), policyText);
  }
  if (mutateBase) await mutateBase({ root, bare, checkout, git, writeFile, mkdir, chmod });
  await git(checkout, ['add', '--all']);
  await git(checkout, ['commit', '-m', 'Base']);
  const baseSha = await git(checkout, ['rev-parse', 'HEAD']);
  await git(checkout, ['push', 'origin', 'HEAD:refs/heads/main']);

  await writeFile(sourceFile, headText);
  if (mutateHead) await mutateHead({ root, bare, checkout, git, writeFile, mkdir, chmod });
  await git(checkout, ['add', '--all']);
  await git(checkout, ['commit', '-m', 'Pull request head']);
  const headSha = await git(checkout, ['rev-parse', 'HEAD']);
  await git(checkout, ['push', 'origin', 'HEAD:refs/pull/42/head']);
  await git(checkout, ['remote', 'set-url', 'origin', CONFIG.repository.url]);

  return {
    root,
    bare,
    checkout,
    baseSha,
    headSha,
    async git(args) {
      return git(checkout, args);
    },
    async bareGit(args) {
      return git(bare, args);
    },
    async execute({ command, args, maxBytes }) {
      const rewritten = [...args];
      if (rewritten[2] === 'fetch') {
        const remoteIndex = rewritten.indexOf('origin', 3);
        if (remoteIndex !== -1) rewritten[remoteIndex] = `file://${bare}`;
      }
      try {
        const { stdout } = await exec(command, rewritten, {
          encoding: 'buffer',
          maxBuffer: maxBytes,
        });
        return { stdout, exitCode: 0 };
      } catch (error) {
        return {
          stdout: error.stdout ?? Buffer.alloc(0),
          exitCode: Number.isSafeInteger(error.code) ? error.code : 1,
        };
      }
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
