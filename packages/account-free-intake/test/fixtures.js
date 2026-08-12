import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  ACCOUNT_FREE_INTENT_ARTIFACT_TYPE,
  prepareSourceBindingManifest,
} from '../src/index.js';
import { sha256Digest } from '../src/contract.js';

const exec = promisify(execFile);

export const REPOSITORY = 'https://forge.example:8443/owner/wiki.git';
export const SOURCE_PATH = 'docs/notes.md';
export const RENDERER_REVISION = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const POLICY_TEXT = 'trusted: []\nagents: []\n';

export async function git(cwd, args, options = {}) {
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return typeof stdout === 'string' ? stdout.trim() : stdout;
}

export async function createBareFixture({
  baseText = '# Notes\r\n\r\nTabs\tand trailing spaces stay.  \r\n\r\nCorrect teh typo. 🙂 é\r\n',
  nextText = '# Notes\r\n\r\nTabs\tand trailing spaces stay.  \r\n\r\nCorrect the typo. 🙂 é\r\n',
  policyText = POLICY_TEXT,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cyberbaser-account-free-'));
  const bare = join(root, 'objects.git');
  const checkout = join(root, 'checkout');
  await mkdir(bare);
  await mkdir(checkout);
  await git(bare, ['init', '--bare', '--initial-branch=main']);
  await git(checkout, ['init', '--initial-branch=main']);
  await git(checkout, ['config', 'user.name', 'Account Free Test']);
  await git(checkout, ['config', 'user.email', 'account-free@example.invalid']);
  await git(checkout, ['remote', 'add', 'origin', bare]);
  const sourceFile = join(checkout, SOURCE_PATH);
  await mkdir(dirname(sourceFile), { recursive: true });
  await writeFile(sourceFile, baseText);
  await mkdir(join(checkout, '.cyberbaser'), { recursive: true });
  if (policyText !== null) await writeFile(join(checkout, '.cyberbaser', 'trust.yml'), policyText);
  await git(checkout, ['add', '--all']);
  await git(checkout, ['commit', '-m', 'Published revision']);
  const baseRevision = await git(checkout, ['rev-parse', 'HEAD']);
  await git(checkout, ['push', 'origin', 'HEAD:refs/heads/main']);
  await writeFile(sourceFile, nextText);
  await git(checkout, ['add', '--all']);
  await git(checkout, ['commit', '-m', 'Later revision']);
  const nextRevision = await git(checkout, ['rev-parse', 'HEAD']);
  await git(checkout, ['push', 'origin', 'HEAD:refs/heads/main']);
  const baseBytes = Buffer.from(baseText, 'utf8');
  const manifest = prepareSourceBindingManifest({
    source: { repository: REPOSITORY, revision: baseRevision },
    publication: {
      publishPolicyDigest: sha256Digest(Buffer.from('publish-policy-v1\n')),
      selectedTreeDigest: sha256Digest(Buffer.from(`${SOURCE_PATH}\0${baseBytes.length}\0${sha256Digest(baseBytes)}\n`)),
    },
    renderer: { name: 'quartz-cyberbase', revision: RENDERER_REVISION },
    trustPolicy: policyText === null
      ? { status: 'missing', digest: null }
      : { status: 'valid', digest: sha256Digest(Buffer.from(policyText, 'utf8')) },
    pages: [{
      path: SOURCE_PATH,
      byteLength: baseBytes.length,
      digest: sha256Digest(baseBytes),
    }],
  });
  return {
    root,
    bare,
    checkout,
    sourceFile,
    baseBytes,
    nextBytes: Buffer.from(nextText, 'utf8'),
    baseRevision,
    nextRevision,
    manifest,
    page: manifest.pages[0],
    async bareGit(args) {
      return git(bare, args);
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function makeIntent({
  bindingDigest,
  pageId,
  quote = 'teh',
  prefix = 'Correct ',
  suffix = ' typo.',
  replacement = 'the',
  rationale = 'Correct the misspelling without changing meaning.',
  evidence = ['https://example.invalid/reference'],
  idempotencyKey = null,
  overrides = {},
} = {}) {
  return {
    schemaVersion: 1,
    artifactType: ACCOUNT_FREE_INTENT_ARTIFACT_TYPE,
    bindingDigest,
    pageId,
    selection: { quote, prefix, suffix },
    replacement,
    rationale,
    evidence,
    idempotencyKey,
    ...overrides,
  };
}
