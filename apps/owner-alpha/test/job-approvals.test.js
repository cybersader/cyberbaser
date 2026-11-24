// The node relays setup's starter publish.yml to the signing device and,
// once signed, to the publisher's publish-starter check. Synthetic Git only.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomBytes, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkCommit, ED25519_APPROVAL_DOMAIN, ed25519FromSeed, intentDigest } from '../../../packages/signed-intent/src/index.js';
import { createStubPublisher } from '../../obsidian-cyberbaser/test/harness/stub-publisher.js';
import { validateOwnerAlphaConfig } from '../src/config.js';
import { createApprovalRelay } from '../src/core/approvals.js';
import { createJobApprovals, pendingStarterFile } from '../src/core/job-approvals.js';
import { createStarterPublisher } from '../src/first-run.js';
import { gitIn } from '../src/signed-publish.js';

const cleanup = [];
afterEach(async () => { for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true }); });

test('the starter publish.yml waits for the phone, then goes through publish-starter with the signature, then the copy moves', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oa-job-approvals-'));
  cleanup.push(root);
  const checkout = path.join(root, 'vault');
  const git = (...args) => execFileSync('git', ['-C', checkout, '-c', 'commit.gpgSign=false', ...args]).toString().trim();
  execFileSync('git', ['init', '-q', '--initial-branch=main', checkout]);
  git('config', 'user.name', 'Owner'); git('config', 'user.email', 'owner@example.invalid');
  await writeFile(path.join(checkout, 'Garden.md'), '# Garden\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const setupGit = async (cwd, args) => execFileSync('git', ['-C', cwd, ...args]).toString().trim();
  const { commit } = await createStarterPublisher({ checkout, git: setupGit }).prepare({ repository: 'owner/vault', folders: ['Garden'] });
  expect(git('rev-parse', 'HEAD')).toBe(base);

  const example = JSON.parse(await readFile(new URL('../owner-alpha.example.json', import.meta.url), 'utf8'));
  const config = validateOwnerAlphaConfig({ ...example, repository: { ...example.repository, checkout } });
  const starter = pendingStarterFile(root);
  await starter.save(commit);
  const publisher = createStubPublisher();
  const pushed = [];
  const rebuilt = [];
  const jobs = createJobApprovals({ config, context: null, pipeline: { resumeJob: async () => {} }, listJobs: async () => [],
    // The vault published nothing before the starter: the node rebuilds its preview once it lands.
    afterStarter: async () => { rebuilt.push(git('rev-parse', 'HEAD')); },
    git: gitIn(checkout), starter, publishStarter: async ({ commit: given, record }) => {
      expect(publisher.verifyPublish(record)).toEqual({ ok: true });
      expect((await checkCommit(gitIn(checkout), record.intent, given)).ok).toBe(true);
      pushed.push(given);
      return { commit: given };
    } });
  const relay = createApprovalRelay({ publisher, refresh: () => jobs.refresh(relay) });

  const waiting = await relay.list();
  expect(waiting).toHaveLength(1);
  expect(await relay.list()).toHaveLength(1);
  const request = relay.read({ requestId: waiting[0].requestId });
  expect(request.intent.changes.map((change) => [change.path, change.before])).toEqual([['publish.yml', null]]);
  expect(Buffer.from(request.files[0].after, 'base64').toString()).toContain('Garden');

  // A device key the stand-in publisher knows, signing exactly this intent.
  const seed = randomBytes(32);
  const device = ed25519FromSeed(seed);
  publisher.keys.set('device-1', { keyId: 'device-1', type: 'ed25519', publicKey: Buffer.from(device.publicKey).toString('base64url'), label: 'Phone' });
  const intent = { ...request.intent, keyId: 'device-1' };
  const signature = sign(null, Buffer.concat([Buffer.from(ED25519_APPROVAL_DOMAIN), intentDigest(intent)]), device.privateKey).toString('base64url');
  relay.submit({ requestId: waiting[0].requestId, intent, approval: { type: 'ed25519', signature } });
  for (let i = 0; i < 100 && git('rev-parse', 'HEAD') !== commit; i += 1) await Bun.sleep(20);
  expect(pushed).toEqual([commit]);
  expect(git('rev-parse', 'HEAD')).toBe(commit);
  for (let i = 0; i < 100 && rebuilt.length === 0; i += 1) await Bun.sleep(20);
  expect(await starter.read()).toBe(null);
  expect(rebuilt).toEqual([commit]);
  expect(await relay.list()).toEqual([]);
});

test('"Not now" on the starter keeps it waiting, quietly, and a restart offers it again', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oa-job-approvals-'));
  cleanup.push(root);
  const checkout = path.join(root, 'vault');
  const git = (...args) => execFileSync('git', ['-C', checkout, '-c', 'commit.gpgSign=false', ...args]).toString().trim();
  execFileSync('git', ['init', '-q', '--initial-branch=main', checkout]);
  git('config', 'user.name', 'Owner'); git('config', 'user.email', 'owner@example.invalid');
  await writeFile(path.join(checkout, 'Garden.md'), '# Garden\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const setupGit = async (cwd, args) => execFileSync('git', ['-C', cwd, ...args]).toString().trim();
  const { commit } = await createStarterPublisher({ checkout, git: setupGit }).prepare({ repository: 'owner/vault', folders: [] });
  const example = JSON.parse(await readFile(new URL('../owner-alpha.example.json', import.meta.url), 'utf8'));
  const config = validateOwnerAlphaConfig({ ...example, repository: { ...example.repository, checkout } });
  const starter = pendingStarterFile(root);
  await starter.save(commit);
  const make = () => {
    const jobs = createJobApprovals({ config, context: null, pipeline: { resumeJob: async () => {} }, listJobs: async () => [],
      git: gitIn(checkout), starter, publishStarter: async () => { throw new Error('not approved'); } });
    const relay = createApprovalRelay({ publisher: createStubPublisher(), refresh: () => jobs.refresh(relay) });
    return relay;
  };
  const relay = make();
  const [first] = await relay.list();
  relay.decline({ requestId: first.requestId });
  await Bun.sleep(0);
  expect(await relay.list()).toEqual([]);
  expect(await starter.read()).toBe(commit);
  // A node restart (new relay) offers it again.
  expect(await make().list()).toHaveLength(1);
});
