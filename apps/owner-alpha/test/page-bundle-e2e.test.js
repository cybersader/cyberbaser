// End to end, synthetic: a new post with a cover photo taken somewhere, from
// the Obsidian plugin's own core through the node's bundle desk, the signing
// relay, the plugin's device-side checks and signature, to the publisher's
// checks and a push to a throwaway repository.
//
// The photo carries GPS; the device strips it before sending, so the owner
// signs the cleaned bytes and the remote ends up with exactly those bytes.
// Propose-only devices can only propose: their bundle waits for review and is
// never offered for signature on its own.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { exifTiff, jpeg } from '../../../packages/media-check/test/fixtures.js';
import { checkAsset, hasLocation } from '../../../packages/media-check/src/index.js';
import { createController } from '../../obsidian-cyberbaser/src/core/controller.js';
import { memoryBackend } from '../../obsidian-cyberbaser/src/core/device-store.js';
import { notePublicStatus, prepareImages } from '../../obsidian-cyberbaser/src/core/new-page.js';
import * as signing from '../../obsidian-cyberbaser/src/core/signing.js';
import { createTapGate } from '../../obsidian-cyberbaser/src/core/tap.js';
import { createApprovalRelay } from '../src/core/approvals.js';
import { openBundleDesk } from '../src/core/bundle-desk.js';
import { createJobApprovals } from '../src/core/job-approvals.js';
import { bundleGit } from '../src/core/page-bundle.js';
import { createApprovalGate } from '../src/publisher/approval-gate.js';
import { verifyBundleForPush } from '../src/publisher/bundle-publish.js';
import { createOwnerKeys } from '../src/publisher/owner-keys.js';
import { gitIn } from '../src/signed-publish.js';
import { bundleVault, gitSync, REMOTE_URL, VAULT } from './bundle-fixture.js';

const fingerTaps = new WeakSet();
const finger = () => { const tap = { finger: true }; fingerTaps.add(tap); return tap; };

let world;

// A JPEG cover taken somewhere, over 256 KiB so it travels in several chunks.
function coverPhoto() {
  const base = jpeg({ exif: exifTiff() });
  const comments = [];
  for (let i = 0; i < 6; i += 1) {
    const body = new Uint8Array(60_000).fill(0x41 + i);
    comments.push(0xff, 0xfe, ((body.length + 2) >> 8) & 255, (body.length + 2) & 255, ...body);
  }
  return Uint8Array.from([...base.subarray(0, 2), ...comments, ...base.subarray(2)]);
}

async function settle(check, what) {
  for (let i = 0; i < 200; i += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  const vault = await bundleVault();
  const remote = path.join(vault.root, 'remote.git');
  gitSync(vault.root, 'clone', '-q', '--bare', vault.repo, remote);
  const checkout = vault.repo;
  const head = vault.head;

  // The publisher: its own key list, the approval gate, a one-hour setup code.
  await mkdir(path.join(vault.root, 'publisher'), { mode: 0o700 });
  const ownerKeys = await createOwnerKeys({ directory: path.join(vault.root, 'publisher', 'owners') });
  const gate = createApprovalGate({ ownerKeys });
  const window = await ownerKeys.ensureEnrollment();

  // The phone enrols with that code, with the plugin's own WebCrypto key.
  const created = await signing.createSigningKey();
  const key = { keyId: 'device-phone', type: 'ed25519', publicKey: created.publicKey, label: 'Phone' };
  const challenge = await ownerKeys.challenge();
  const enrol = await signing.enrolIntent({ publisher: challenge.publisher, secret: signing.parseCode(window.code), key,
    nonce: challenge.nonce, now: challenge.issuedAt, expiresAt: challenge.expiresAt });
  await ownerKeys.enroll({ intent: enrol, approval: await signing.approvalFor(created.privateKey, await signing.intentDigest(enrol)) });
  const signingStore = signing.createSigningStore(memoryBackend(), 'vault:e2e');
  await signingStore.save({ version: 1, keyId: key.keyId, label: 'Phone', publicKey: created.publicKey, privateKey: created.privateKey,
    publisher: challenge.publisher, fingerprint: await signing.keyFingerprint(key), enrolledAt: 1 });

  // The node: the bundle desk on its checkout, the relay, the offer loop.
  const git = bundleGit(checkout);
  const config = { limits: { maxSourceBytes: 1024 * 1024, maxArtifactBytes: 1024 * 1024 },
    repository: { remote: { url: REMOTE_URL }, branch: 'main', checkout } };
  const desk = await openBundleDesk({ config, git, directory: path.join(vault.root, 'node', 'bundles'),
    branchHead: async () => gitSync(checkout, 'rev-parse', 'main'), author: { name: 'Owner', email: 'owner@example.invalid' } });
  const pushed = [];
  const refusals = [];
  let tamper = null;
  // The publisher's publish-bundle op, against the throwaway remote.
  const publishBundle = async ({ commit, record }) => {
    const target = tamper === null ? commit : await tamper(commit);
    const authorization = await gate.authorize(record, { remote: REMOTE_URL, branch: 'main' });
    const remoteHead = gitSync(remote, 'rev-parse', 'main');
    try {
      await verifyBundleForPush({ git: bundleGit(checkout), head: remoteHead, commit: target, admitted: authorization.admitted });
    } catch (error) {
      refusals.push(error.details?.reason ?? error.code);
      throw error;
    }
    gitSync(checkout, 'push', '-q', remote, `${target}:refs/heads/main`);
    pushed.push(target);
    return { commit: target, receipt: authorization.receipt({ status: 'pushed', commit: target, remoteRef: target }) };
  };
  const relay = createApprovalRelay({ publisher: { challenge: () => ownerKeys.challenge() } });
  const offers = createJobApprovals({ config, context: null, pipeline: null, listJobs: async () => [], git: gitIn(checkout),
    bundles: desk, publishBundle, log: () => {} });

  // The plugin's controller, its node requests answered by the node's own code.
  const ownerPrincipal = { keyId: 'pair-phone', actor: { kind: 'owner-device', id: 'owner', label: 'Phone' } };
  const client = { request: async (_pairing, command, input) => {
    switch (command) {
      case 'stageAsset': return desk.staging.stage({ keyId: ownerPrincipal.keyId, ...input });
      case 'submitPageBundle': return desk.submit(input, ownerPrincipal, 'owner');
      case 'readApproval': return relay.read(input);
      case 'readApprovalChunk': return relay.readChunk(input);
      case 'submitApproval': return relay.submit(input);
      default: throw new Error(`unexpected ${command}`);
    }
  } };
  const controller = createController({ client, store: { load: async () => ({ keyId: 'pair-phone', grants: ['publish', 'propose'] }) },
    signingStore, tapGate: createTapGate((event) => fingerTaps.has(event)) });
  world = { vault, remote, checkout, head, desk, relay, offers, controller, pushed, refusals, setTamper: (fn) => { tamper = fn; } };
});

afterAll(async () => { await rm(world.vault.root, { recursive: true, force: true }); });

const PUBLISH_YML = VAULT['publish.yml'];

async function waitingRequest() {
  await world.offers.refresh(world.relay);
  return settle(async () => (await world.relay.list())[0]?.requestId, 'an approval request');
}

test('a new post with a cover photo: cleaned on the device, signed, checked by the publisher, pushed', async () => {
  const { controller, desk, remote } = world;
  const notePath = 'topic/posts/first-post.md';
  const text = '---\ntitle: First post\n---\n# First post\n\n![[cover.jpg]]\n\nHello from the phone.\n';
  const original = coverPhoto();
  expect(hasLocation(original)).toBe(true);

  // On the device: work out the address, clean the photo, list what goes.
  const status = notePublicStatus({ path: notePath, text, publishYml: PUBLISH_YML });
  expect(status).toMatchObject({ published: true, address: '/topic/posts/first-post', draft: false });
  const images = prepareImages([{ path: 'topic/posts/cover.jpg', bytes: original }]);
  expect(images[0]).toMatchObject({ cleaned: true, refused: null, type: 'image/jpeg' });
  expect(images[0].size).toBeGreaterThan(256 * 1024);
  const sent = await controller.publishNewPage({ path: notePath }, text, { status, images, remote: [] });
  expect(sent).toMatchObject({ kind: 'publishing', address: '/topic/posts/first-post' });

  // Waiting for approval on the device until the site has it.
  const record = await desk.load(sent.bundleId);
  expect(record.state).toBe('signing');

  // The device reads the request (the photo in chunks), recomputes the public
  // page from its own publish.yml, and shows the separate line.
  const requestId = await waitingRequest();
  const prepared = await controller.readApproval(requestId, { publishYml: PUBLISH_YML });
  expect(prepared.summary.newPages).toEqual([{ path: notePath, address: '/topic/posts/first-post' }]);
  expect(prepared.summary.newImages).toBe(1);
  expect(prepared.summary.files.map((file) => [file.path, file.kind, file.image ?? false])).toEqual([
    ['topic/posts/cover.jpg', 'added', true], [notePath, 'added', false]]);

  await controller.approve(prepared, finger());
  await settle(async () => (await desk.load(sent.bundleId)).state === 'published', 'the bundle to publish');

  // The remote has exactly the signed, cleaned bytes; the node's copy moved.
  const remoteHead = gitSync(remote, 'rev-parse', 'main');
  expect(remoteHead).toBe(record.commit);
  expect(gitSync(remote, 'rev-parse', `${remoteHead}^`)).toBe(world.head);
  const cover = Buffer.from(await bundleGit(remote)(['cat-file', 'blob', `${remoteHead}:topic/posts/cover.jpg`]));
  expect(cover.equals(Buffer.from(images[0].bytes))).toBe(true);
  expect(checkAsset('topic/posts/cover.jpg', new Uint8Array(cover))).toMatchObject({ ok: true });
  expect(gitSync(remote, 'show', `${remoteHead}:${notePath}`)).toBe(text.trimEnd());
  expect(gitSync(world.checkout, 'rev-parse', 'main')).toBe(remoteHead);
});

test('the device refuses when the node lies about what goes public', async () => {
  const { controller, desk } = world;
  const head = gitSync(world.checkout, 'rev-parse', 'main');
  const text = '# Second\n';
  const status = notePublicStatus({ path: 'topic/second.md', text, publishYml: PUBLISH_YML });
  const sent = await controller.publishNewPage({ path: 'topic/second.md' }, text, { status, images: [], remote: [] });
  const requestId = await waitingRequest();
  const real = world.relay.read({ requestId });
  const signingRecord = { keyId: 'device-phone', publisher: real.intent.publisher };
  const prepare = (request, publishYml = PUBLISH_YML) => signing.prepareApproval({ request, signing: signingRecord, now: Date.now(), publishYml });
  await expect(prepare({ ...real, publicAdditions: [{ path: 'topic/second.md', address: '/elsewhere' }] })).rejects.toMatchObject({ reason: 'approval-public-mismatch' });
  await expect(prepare({ ...real, publicAdditions: [] })).rejects.toMatchObject({ reason: 'approval-public-mismatch' });
  // This device's publish.yml keeps topic/ private: it will not sign a public note there.
  await expect(prepare(real, 'allow:\n  - "other/**"\n')).rejects.toMatchObject({ reason: 'approval-private-note' });
  await expect(prepare(real, null)).rejects.toMatchObject({ reason: 'approval-public-unknown' });
  // The honest request passes.
  expect((await prepare(real)).summary.newPages).toEqual([{ path: 'topic/second.md', address: '/topic/second' }]);
  await controller.decline(requestId).catch(() => world.relay.decline({ requestId }));
  await desk.decline(sent.bundleId);
  expect(gitSync(world.checkout, 'rev-parse', 'main')).toBe(head);
});

test('the publisher refuses a commit that differs from what was signed', async () => {
  const { controller, desk, remote } = world;
  const before = gitSync(remote, 'rev-parse', 'main');
  // One byte of the image changed, or a file sneaked in: same parent, author and message.
  for (const [what, change] of [
    ['image byte', (bytes) => { const out = Buffer.from(bytes); out[out.length - 3] ^= 1; return out; }],
    ['extra file', null],
  ]) {
    world.setTamper(async (commit) => {
      const git = bundleGit(world.checkout);
      const env = { GIT_INDEX_FILE: path.join(world.vault.root, `tamper-${what.replace(/\s/gu, '')}`) };
      await git(['read-tree', commit], { env });
      if (change !== null) {
        const original = await git(['cat-file', 'blob', `${commit}:topic/third/pic.png`]);
        const oid = (await git(['hash-object', '-w', '--stdin'], { input: change(original) })).toString().trim();
        await git(['update-index', '--cacheinfo', `100644,${oid},topic/third/pic.png`], { env });
      } else {
        const oid = (await git(['hash-object', '-w', '--stdin'], { input: '# extra\n' })).toString().trim();
        await git(['update-index', '--add', '--cacheinfo', `100644,${oid},topic/extra.md`], { env });
      }
      const tree = (await git(['write-tree'], { env })).toString().trim();
      const raw = (await git(['cat-file', 'commit', commit])).toString('utf8');
      const swapped = raw.replace(/^tree [0-9a-f]{40}/u, `tree ${tree}`);
      return (await git(['hash-object', '-w', '-t', 'commit', '--stdin'], { input: swapped })).toString().trim();
    });
    const { png } = await import('../../../packages/media-check/test/fixtures.js');
    const text = '# Third\n\n![[pic.png]]\n';
    const notePath = `topic/third/${what.replace(/\s/gu, '-')}.md`;
    const status = notePublicStatus({ path: notePath, text, publishYml: PUBLISH_YML });
    const images = prepareImages([{ path: 'topic/third/pic.png', bytes: png() }]);
    const sent = await controller.publishNewPage({ path: notePath }, text, { status, images, remote: [] });
    const requestId = await waitingRequest();
    const prepared = await controller.readApproval(requestId, { publishYml: PUBLISH_YML });
    await controller.approve(prepared, finger());
    // The publish fails: the bundle is marked stale and the remote did not move.
    await settle(async () => (await desk.load(sent.bundleId)).state !== 'signing', 'the refusal');
    expect(await desk.load(sent.bundleId)).toMatchObject({ state: 'stale', reason: 'owner-approval-mismatch' });
    expect(gitSync(remote, 'rev-parse', 'main')).toBe(before);
  }
  world.setTamper(null);
  expect(world.refusals).toEqual(['content-mismatch', 'unsigned-path-changed']);
});

test('a propose-only device can only propose: its bundle waits for review and is never offered alone', async () => {
  const { desk, relay, offers } = world;
  const agent = { keyId: 'agent-key', actor: { kind: 'agent', id: 'agent-1', label: 'Research agent' } };
  const result = await desk.submit({ main: { path: 'topic/agent-note.md', text: '# From an agent\n' }, assets: [] }, agent, 'propose');
  expect(result).toMatchObject({ state: 'review', publicAdditions: [{ path: 'topic/agent-note.md', address: '/topic/agent-note' }] });
  await offers.refresh(relay);
  const waiting = await relay.list();
  expect(waiting).toEqual([]);
  // After the owner approves it on the node, it waits for the owner's signature like any other.
  await desk.approve(result.bundleId);
  expect((await desk.load(result.bundleId)).state).toBe('signing');
  await offers.refresh(relay);
  expect((await relay.list()).length).toBe(1);
});
