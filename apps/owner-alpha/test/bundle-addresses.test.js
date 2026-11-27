// Web addresses for new pages follow the vault's address style
// (.cyberbaser/site.yml `addresses:`), the same function the device and the
// review page use; the configured renderer's build must have the page there.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parsePageBundle } from '../../../packages/proposal/src/page-bundle.js';
import { createBundlePreview } from '../src/bundle-preview.js';
import { validateOwnerAlphaConfig } from '../src/config.js';
import { openBundleDesk } from '../src/core/bundle-desk.js';
import { createJobApprovals } from '../src/core/job-approvals.js';
import { bundleGit, checkPageBundle } from '../src/core/page-bundle.js';
import { PINNED_QUARTZ_COMMIT, PINNED_QUARTZ_REF } from '../src/quartz-renderer.js';
import { sitePageSlug } from '../src/site-review-page.js';
import { bundleOf, bundleVault, gitSync, readerFor, REMOTE_URL } from './bundle-fixture.js';

const READABLE = Object.freeze({
  'publish.yml': 'allow:\n  - "Leadership & strategy/**"\n  - "Knowledge base/**"\n',
  '.cyberbaser/site.yml': 'site:\n  title: Cyberchief\n  addresses: lowercase-hyphen\n',
  'Leadership & strategy/index.md': '---\ntitle: Security leadership & strategy\n---\n',
  'Leadership & strategy/Writing a one-page security strategy.md': '# Strategy\n',
  'Knowledge base/index.md': '# Knowledge base\n',
});

let vault; let quartzVault; let unknownVault; let projectRoot;
beforeAll(async () => {
  vault = await bundleVault(READABLE);
  quartzVault = await bundleVault(Object.fromEntries(Object.entries(READABLE).filter(([name]) => name !== '.cyberbaser/site.yml')));
  unknownVault = await bundleVault({ ...READABLE, '.cyberbaser/site.yml': 'site:\n  addresses: kebab\n' });
  projectRoot = await mkdtemp(path.join(os.tmpdir(), 'oa-bundle-addresses-'));
});
afterAll(async () => {
  for (const root of [vault.root, quartzVault.root, unknownVault.root, projectRoot]) await rm(root, { recursive: true, force: true });
});

const check = (target, bundle) => checkPageBundle({ bundle, git: target.git, head: target.head, readAsset: readerFor([]), maxSourceBytes: 1 << 20 });
const codeOf = async (promise) => { try { await promise; return 'ok'; } catch (error) { return error.code; } };

test('the node names the address by the vault style: lowercase-hyphen, stock Quartz without one, refused when unknown', async () => {
  const creates = [{ path: 'Leadership & strategy/Questions to ask a new CISO.md', text: '# Q\n' }];
  expect((await check(vault, bundleOf(vault.head, { creates }))).publicAdditions)
    .toEqual([{ path: creates[0].path, address: '/leadership-and-strategy/questions-to-ask-a-new-ciso' }]);
  expect((await check(quartzVault, bundleOf(quartzVault.head, { creates }))).publicAdditions[0].address)
    .toBe('/Leadership--and--strategy/Questions-to-ask-a-new-CISO');
  expect(await codeOf(check(unknownVault, bundleOf(unknownVault.head, { creates })))).toBe('address-style-unknown');
  // Two names, one address: refused.
  expect(await codeOf(check(vault, bundleOf(vault.head, { creates: [{ path: 'Leadership & strategy/Writing a one page security strategy!.md', text: '# x\n' }] }))))
    .toBe('create-address-collision');
  // A name with no letters or digits has no address.
  expect(await codeOf(check(vault, bundleOf(vault.head, { creates: [{ path: 'Leadership & strategy/🔥🚀.md', text: '# x\n' }] }))))
    .toBe('create-path-refused');
  // The review page looks the built page up by the same rule.
  expect(sitePageSlug('Leadership & strategy/Questions to ask a new CISO.md', '# Q\n', 'lowercase-hyphen')).toBe('leadership-and-strategy/questions-to-ask-a-new-ciso');
  expect(sitePageSlug('Leadership & strategy/Q.md', '---\nslug: Short Name\n---\n', 'lowercase-hyphen')).toBe('short-name');
});

// A contract renderer that writes each note at a slug of its choosing.
function renderer(slugOf) {
  return async ({ contentDir, outputDir }) => {
    const note = 'Leadership & strategy/Questions to ask a new CISO.md';
    const text = await readFile(path.join(contentDir, note), 'utf8');
    const target = path.join(outputDir, `${slugOf(note)}.html`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `<!doctype html><html><head></head><body><article><h1>Q</h1><p>${text.length}</p></article></body></html>`);
    return { renderer: 'cyberchief', revision: PINNED_QUARTZ_COMMIT, tag: PINNED_QUARTZ_REF, outputDir };
  };
}

test('the preview build must have the page at the address shown, or the bundle is refused and never offered', async () => {
  const raw = JSON.parse(await readFile(path.join(import.meta.dir, '..', 'owner-alpha.example.json'), 'utf8'));
  raw.proposalReview.enabled = true;
  raw.proposalReview.socketPath = '/run/user/1000/cyberbaser/review.sock';
  const config = validateOwnerAlphaConfig({ ...raw, renderer: { name: 'cyberchief', directory: projectRoot, quartzCommit: PINNED_QUARTZ_COMMIT, fingerprint: ['build'] } });
  const desk = await openBundleDesk({ config: { limits: { maxSourceBytes: 1 << 20 }, repository: { remote: { url: REMOTE_URL } } },
    git: bundleGit(vault.repo), directory: path.join(vault.root, 'bundles'), branchHead: async () => gitSync(vault.repo, 'rev-parse', 'main') });
  const owner = { keyId: 'phone', actor: { kind: 'owner-device', id: 'phone', label: 'Phone' } };
  const submitted = await desk.submit({ main: { path: 'Leadership & strategy/Questions to ask a new CISO.md', text: '# Q\n' }, assets: [] }, owner, 'owner');
  expect(submitted).toMatchObject({ state: 'signing', publicAdditions: [{ address: '/leadership-and-strategy/questions-to-ask-a-new-ciso' }] });
  const record = await desk.load(submitted.bundleId);
  const input = { bundleId: submitted.bundleId, index: 0, bundle: parsePageBundle(record.bundleText), record, colorScheme: 'light',
    readImage: async () => null };
  const checkout = { assertCheckoutReady: async () => ({ root: vault.repo, head: gitSync(vault.repo, 'rev-parse', 'main') }) };
  // The renderer agrees: the page is shown.
  const agreeing = createBundlePreview({ config, projectRoot, render: renderer(() => 'leadership-and-strategy/questions-to-ask-a-new-ciso'), dependencies: checkout });
  expect(typeof await agreeing(input)).toBe('string');
  // Stock Quartz addressing (case kept, "&" as -and-): not where everyone was told.
  const stock = createBundlePreview({ config, projectRoot, render: renderer(() => 'Leadership--and--strategy/Questions-to-ask-a-new-CISO'), dependencies: checkout });
  expect(await stock(input)).toEqual({ refused: 'address-mismatch' });

  // Before a bundle is offered for signature, the check runs once; a mismatch is refused, never offered.
  const offered = [];
  const relay = { challenge: async () => { offered.push('challenge'); throw new Error('not reached'); }, request: () => { offered.push('request'); } };
  const approvals = createJobApprovals({ config: { repository: { remote: { url: REMOTE_URL }, branch: 'main', checkout: vault.repo }, limits: { maxArtifactBytes: 1 << 20 } },
    context: null, pipeline: null, listJobs: async () => [], bundles: desk, publishBundle: async () => {},
    checkBundle: async (bundleRecord) => ((await stock({ ...input, record: bundleRecord }))?.refused ?? 'ok') });
  await approvals.refresh(relay);
  for (let i = 0; i < 50 && (await desk.load(submitted.bundleId)).state === 'signing'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await approvals.refresh(relay);
  }
  expect(await desk.load(submitted.bundleId)).toMatchObject({ state: 'stale', reason: 'address-mismatch' });
  expect(offered).toEqual([]);
});
