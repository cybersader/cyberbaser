import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  ACCOUNT_FREE_INTENT_ARTIFACT_TYPE,
  prepareSourceBindingManifest,
  retainedManifestFilename,
  serializeSourceBindingManifest,
  sourceBindingDigest,
} from '@cyberbaser/account-free-intake';
import { validateConfig } from '../src/config.js';

const exec = promisify(execFile);
export const REPOSITORY = 'https://forge.example:8443/owner/wiki.git';
export const PUBLIC_ORIGIN = 'https://intake.example';
export const FORM_ORIGIN = 'https://wiki.example';
export const SOURCE_PATH = 'docs/notes.md';
export const BASE_TEXT = '# Notes\n\nCorrect teh typo.\n';
export const POLICY_TEXT = 'trusted: []\nagents: []\n';

function digest(bytes) {
  return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
}

async function git(cwd, args) {
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

export function configInput(root, overrides = {}) {
  return {
    schemaVersion: 1,
    enabled: true,
    publicOrigin: PUBLIC_ORIGIN,
    listen: { host: '0.0.0.0', port: 8080 },
    allowedFormOrigins: [FORM_ORIGIN],
    repository: REPOSITORY,
    bindingsRoot: path.join(root, 'bindings'),
    gitDir: path.join(root, 'objects.git'),
    queue: {
      root: path.join(root, 'queue'),
      maxPendingEntries: 1000,
      maxRetainedBytes: 268_435_456,
      maxPendingPerSource: 25,
      pendingRetentionMs: 2_592_000_000,
      expiredGraceMs: 604_800_000,
    },
    limits: {
      maxBodyBytes: 98_304,
      requestTimeoutMs: 5_000,
      maxConcurrentRequests: 4,
      tokenBucketCapacity: 20,
      tokenBucketRefillPerSecond: 1,
    },
    ...overrides,
  };
}

export async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'cyberbaser-intake-app-'));
  const checkout = path.join(root, 'checkout');
  const bare = path.join(root, 'objects.git');
  const bindingsRoot = path.join(root, 'bindings');
  await mkdir(checkout);
  await mkdir(bare);
  await mkdir(bindingsRoot);
  await git(checkout, ['init', '--initial-branch=main']);
  await git(checkout, ['config', 'user.name', 'Intake Test']);
  await git(checkout, ['config', 'user.email', 'intake@example.invalid']);
  await mkdir(path.join(checkout, 'docs'), { recursive: true });
  await mkdir(path.join(checkout, '.cyberbaser'), { recursive: true });
  await writeFile(path.join(checkout, SOURCE_PATH), BASE_TEXT);
  await writeFile(path.join(checkout, '.cyberbaser', 'trust.yml'), POLICY_TEXT);
  await git(checkout, ['add', '--all']);
  await git(checkout, ['commit', '-m', 'Published source']);
  const revision = await git(checkout, ['rev-parse', 'HEAD']);
  await git(bare, ['init', '--bare', '--initial-branch=main']);
  await git(checkout, ['remote', 'add', 'origin', bare]);
  await git(checkout, ['push', 'origin', 'HEAD:refs/heads/main']);

  const baseBytes = Buffer.from(BASE_TEXT, 'utf8');
  const manifest = prepareSourceBindingManifest({
    source: { repository: REPOSITORY, revision },
    publication: {
      publishPolicyDigest: digest(Buffer.from('publish-policy-v1\n')),
      selectedTreeDigest: digest(Buffer.from(`${SOURCE_PATH}\0${baseBytes.length}\0${digest(baseBytes)}\n`)),
    },
    renderer: { name: 'quartz-cyberbase', revision: 'a'.repeat(40) },
    trustPolicy: { status: 'valid', digest: digest(Buffer.from(POLICY_TEXT)) },
    pages: [{ path: SOURCE_PATH, byteLength: baseBytes.length, digest: digest(baseBytes) }],
  });
  const bindingDigest = sourceBindingDigest(manifest);
  await writeFile(
    path.join(bindingsRoot, retainedManifestFilename(bindingDigest)),
    serializeSourceBindingManifest(manifest),
    { mode: 0o600 },
  );

  const config = validateConfig(configInput(root));
  return {
    root,
    config,
    manifest,
    bindingDigest,
    pageId: manifest.pages[0].pageId,
    intent(overrides = {}) {
      return {
        schemaVersion: 1,
        artifactType: ACCOUNT_FREE_INTENT_ARTIFACT_TYPE,
        bindingDigest,
        pageId: manifest.pages[0].pageId,
        selection: { quote: 'teh', prefix: 'Correct ', suffix: ' typo.' },
        replacement: 'the',
        rationale: 'Correct the misspelling.',
        evidence: ['https://example.invalid/reference'],
        idempotencyKey: null,
        ...overrides,
      };
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function request(pathname, {
  method = 'GET',
  host = 'intake.example',
  origin = null,
  headers = {},
  body = undefined,
} = {}) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set('Host', host);
  if (origin !== null) requestHeaders.set('Origin', origin);
  return new Request(`http://127.0.0.1${pathname}`, { method, headers: requestHeaders, body });
}
