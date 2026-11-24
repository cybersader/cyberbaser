// The publishing experience around the signed core (2026-11-24): the phone's
// approval sheet for new pages, the New post form's title-driven file name,
// and what happens after Publish (checklist, status bar, marks, offline queue).
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { jpeg } from '../../../packages/media-check/test/fixtures.js';
import { parseFrontmatter } from '../../../packages/publish/src/page-rules.js';
import { canonicalJson } from '../../../packages/signed-intent/src/intent.js';
import { renderPages, approvalHeading, showsPages } from '../src/core/approval-sheet.js';
import { NodeError } from '../src/core/client.js';
import { createController } from '../src/core/controller.js';
import { memoryBackend } from '../src/core/device-store.js';
import { planNewNote, readableName } from '../src/core/new-note.js';
import { notePublicStatus, withDraftOff, withDraftOn } from '../src/core/new-page.js';
import { createPublishTracker, markFor, statusBarState, viewSteps } from '../src/core/progress.js';
import * as signing from '../src/core/signing.js';
import { parseSiteModel } from '../src/core/site-model.js';
import { publishIntent, sha256Hex } from './harness/stub-publisher.js';

const SITE_YML = 'site:\n  title: Cyberchief\n  addresses: lowercase-hyphen\n';
const PUBLISH_YML = 'allow:\n  - "Threats & response/**"\n';
const NOTE = 'Threats & response/Run a tabletop exercise in one hour.md';
const COVER = 'Threats & response/Run a tabletop exercise in one hour cover.jpg';
const publisher = 'a'.repeat(64);
const pinned = { keyId: 'device-1', publisher };

// A bundle request as the node relays it: the note inline, the cover in chunks.
function bundleRequest(text, coverBytes = jpeg()) {
  const note = Buffer.from(text);
  const intent = publishIntent({ publisher, nonce: 'A'.repeat(43), path: NOTE, before: Buffer.alloc(0), after: note, now: 1_800_000_000_000 });
  intent.changes = [
    { path: COVER, before: null, after: { mode: '100644', sha256: sha256Hex(coverBytes) } },
    { path: NOTE, before: null, after: { mode: '100644', sha256: sha256Hex(note) } },
  ];
  const status = notePublicStatus({ path: NOTE, text, publishYml: PUBLISH_YML, siteYml: SITE_YML });
  return {
    coverBytes, note,
    request: { requestId: 'r'.repeat(22), intent,
      files: [{ path: COVER, before: null, after: 'chunked' }, { path: NOTE, before: null, after: note.toString('base64') }],
      publicAdditions: [{ path: NOTE, address: status.address }] },
  };
}

const TEXT = '---\ntitle: Run a tabletop exercise in one hour\ndescription: "One hour, one scenario: enough to find the gaps."\n'
  + `cover: ${COVER}\ndraft: false\n---\n\nYou do not need a full day.\n`;

async function prepare(text, coverBytes) {
  const built = bundleRequest(text, coverBytes);
  const reads = [];
  const prepared = await signing.prepareApproval({ request: built.request, signing: pinned, now: 1_800_000_000_001,
    publishYml: PUBLISH_YML, siteYml: SITE_YML,
    readChunk: async (path) => { reads.push(path); return new Uint8Array(built.coverBytes); } });
  return { ...built, prepared, reads };
}

// ---- The approval sheet for new pages ----

test('sheet: site name, "1 new page with 1 photo", and each page read from the exact signed bytes', async () => {
  const { prepared, request, note } = await prepare(TEXT);
  const { summary } = prepared;
  expect(approvalHeading(summary)).toBe('Publish to Cyberchief');
  expect(summary.counts).toBe('1 new page with 1 photo');
  expect(showsPages(summary)).toBe(true);
  // Nothing about the repository or branch is in what the sheet draws.
  expect(JSON.stringify({ heading: approvalHeading(summary), counts: summary.counts })).not.toMatch(/github|main|example\/vault/u);
  const [page] = summary.pages;
  // The summary equals a parse of the signed bytes: the text is the bytes whose hash the intent fixes.
  expect(sha256Hex(Buffer.from(page.text))).toBe(request.intent.changes.find((c) => c.path === NOTE).after.sha256);
  expect(Buffer.from(page.text).equals(note)).toBe(true);
  const fm = parseFrontmatter(page.text).data;
  expect(page).toMatchObject({ path: NOTE, address: '/threats-and-response/run-a-tabletop-exercise-in-one-hour',
    title: fm.title, description: fm.description });
  // The thumbnail is drawn from the cover's signed bytes.
  expect(page.cover.path).toBe(COVER);
  expect(page.cover.mediaType).toBe('image/jpeg');
  expect(sha256Hex(page.cover.bytes)).toBe(request.intent.changes.find((c) => c.path === COVER).after.sha256);
  // Signing is unchanged: the template is the relayed intent with this device's key id.
  expect(canonicalJson(prepared.template)).toBe(canonicalJson({ ...request.intent, keyId: 'device-1' }));
});

test('sheet: a cover the note names but the change does not carry is not shown; photos that are not covers are', async () => {
  const other = TEXT.replace(`cover: ${COVER}`, 'cover: Threats & response/elsewhere.jpg');
  const { prepared } = await prepare(other);
  expect(prepared.summary.pages[0].cover).toBeNull();
  expect(prepared.summary.photos.map((photo) => photo.path)).toEqual([COVER]);
  // Without a site name, the sheet says "your site".
  expect(approvalHeading({ ...prepared.summary, site: null })).toBe('Publish to your site');
  expect(signing.siteName('site:\n  title: "  Two   words "\n')).toBe('Two words');
  expect(signing.siteName('title: [1, 2]\n')).toBeNull();
  expect(signing.bundleCountLine(2, 0)).toBe('2 new pages');
  expect(signing.bundleCountLine(1, 3)).toBe('1 new page with 3 photos');
});

// A stand-in for Obsidian's element helpers that records how everything was made.
function fakeElement(tag = 'div', options = {}) {
  const el = { tag, options, children: [] };
  el.createEl = (childTag, childOptions = {}) => { const child = fakeElement(childTag, childOptions); el.children.push(child); return child; };
  el.createDiv = (childOptions = {}) => el.createEl('div', childOptions);
  el.createSpan = (childOptions = {}) => el.createEl('span', childOptions);
  return el;
}
const walk = (el, out = []) => { out.push(el); for (const child of el.children) walk(child, out); return out; };

test('sheet: hostile titles and summaries are drawn as text, and the picture only from the signed bytes', async () => {
  const hostileTitle = '<img src=x onerror="alert(1)"> & </div><script>steal()</script>';
  const hostileSummary = '<a href="javascript:alert(2)">click</a> {{7*7}} ${x}';
  const text = `---\ntitle: ${JSON.stringify(hostileTitle)}\ndescription: ${JSON.stringify(hostileSummary)}\ncover: ${COVER}\n---\n\n<iframe src="https://evil.example"></iframe>\n`;
  const { prepared } = await prepare(text);
  const page = prepared.summary.pages[0];
  expect(page.title).toBe(hostileTitle);
  expect(page.description).toBe(hostileSummary);
  const urls = [];
  const root = fakeElement();
  renderPages(root, prepared.summary, { imageUrl: (bytes, type) => { urls.push({ bytes, type }); return 'blob:signed-1'; } });
  const nodes = walk(root);
  // Every hostile string is only ever an element's text, never markup or an attribute.
  expect(nodes.some((n) => n.options.text === hostileTitle)).toBe(true);
  expect(nodes.some((n) => n.options.text === hostileSummary)).toBe(true);
  expect(nodes.filter((n) => n.options.text === text).length).toBe(1);
  for (const n of nodes) {
    expect(Object.keys(n.options).every((key) => ['cls', 'text', 'attr'].includes(key))).toBe(true);
    for (const value of Object.values(n.options.attr ?? {})) expect(String(value)).not.toMatch(/<|javascript:|onerror/u);
  }
  // The only picture comes from imageUrl, handed exactly the signed cover bytes.
  const images = nodes.filter((n) => n.tag === 'img');
  expect(images.map((n) => n.options.attr.src)).toEqual(['blob:signed-1']);
  expect(urls).toHaveLength(1);
  expect(urls[0].bytes).toBe(page.cover.bytes);
  expect(urls[0].type).toBe('image/jpeg');
  // "Show exact text" is a closed fold.
  const fold = nodes.find((n) => n.tag === 'details');
  expect(fold.options.attr?.open).toBeUndefined();
  expect(fold.children[0].options.text).toBe('Show exact text');
});

// ---- New post form: the file name follows the title ----

test('title -> file name: one Title field names the file; a short name only when the author sets one', () => {
  const { model } = parseSiteModel(readFileSync(new URL('./fixtures/cyberchief-model-v2.yml', import.meta.url), 'utf8'));
  const paths = ['Threats & response/index.md', 'Knowledge base/index.md'];
  const titleOf = (p) => ({ 'Threats & response/index.md': 'Threats & incident response', 'Knowledge base/index.md': 'Knowledge base' })[p] ?? null;
  const base = { topic: { existing: 'Threats & response' }, description: 'Words.', tags: ['level/primer'] };
  const plan = (values, typeName = 'post') => planNewNote({ model, typeName, values, paths, today: '2026-11-24', titleOf, addressStyle: 'lowercase-hyphen' });
  const title = 'Who owns "risk"? A 1/2 day plan: part <1>';
  expect(readableName(title, model.names)).toBe('Who owns risk A 1 2 day plan part 1');
  const fromTitle = plan({ ...base, title });
  expect(fromTitle.notePath).toBe('Threats & response/Who owns risk A 1 2 day plan part 1.md');
  expect(fromTitle.address).toBe('/threats-and-response/who-owns-risk-a-1-2-day-plan-part-1');
  // Advanced: a separate short name.
  const short = plan({ ...base, title, name: 'Risk owners' });
  expect(short.notePath).toBe('Threats & response/Risk owners.md');
  expect(short.address).toBe('/threats-and-response/risk-owners');
  // The same for knowledge base pages and new folders.
  const kb = plan({ title: 'Incident glossary: A to Z', description: 'Words.', folder: { new: { parent: '', values: { title: 'Response / recovery', description: 'Getting back.' } } } }, 'kb-page');
  expect(kb.notePath).toBe('Knowledge base/Response recovery/Incident glossary A to Z.md');
  expect(kb.errors).toBeUndefined();
});

// ---- After Publish ----

test('progress: node states map to the checklist steps', () => {
  const states = (step, extra = {}) => viewSteps({ step, ...extra }, { site: 'Cyberchief' }).map((s) => s.state);
  expect(states('checking')).toEqual(['current', 'todo', 'todo', 'todo']);
  expect(states('waiting')).toEqual(['done', 'current', 'todo', 'todo']);
  expect(states('review')).toEqual(['done', 'current', 'todo', 'todo']);
  expect(states('publishing')).toEqual(['done', 'done', 'current', 'todo']);
  expect(states('live')).toEqual(['done', 'done', 'done', 'done']);
  expect(states('queued')).toEqual(['queued', 'todo', 'todo', 'todo']);
  expect(states('failed', { lastStep: 'publishing' })).toEqual(['done', 'done', 'failed', 'todo']);
  expect(states('failed', { lastStep: 'checking' })).toEqual(['failed', 'todo', 'todo', 'todo']);
  const waiting = viewSteps({ step: 'waiting' }, { site: 'Cyberchief' });
  expect(waiting.map((s) => s.label)).toEqual(['Checking your post', 'Waiting for your approval', 'Publishing', 'Live on Cyberchief']);
  expect(waiting[1].detail).toBe('Open Cyberbaser on your phone to approve');
  expect(viewSteps({ step: 'waiting' }, { canSign: true })[1].detail).toBe('Approve it on this device');
  expect(viewSteps({ step: 'publishing' })[2].detail).toBe('Usually under a minute');
  expect(viewSteps({ step: 'queued' })[0].detail).toBe("Will send when you're back online");
  // No repository, branch or commit language anywhere in the checklist.
  const words = ['checking', 'waiting', 'publishing', 'live', 'queued'].flatMap((step) => viewSteps({ step }).flatMap((s) => [s.label, s.detail]));
  expect(words.join(' ')).not.toMatch(/repo|branch|commit|push|git/iu);
});

test('status bar: nothing when idle; one line while a post is on its way; "Live ✓" for a few seconds only', () => {
  expect(statusBarState([], 0)).toBeNull();
  expect(statusBarState([{ step: 'withdrawn' }], 0)).toBeNull();
  expect(statusBarState([{ step: 'live', liveSince: 1000 }], 7000)).toBeNull();
  expect(statusBarState([{ step: 'live', liveSince: 1000 }], 3000)).toMatchObject({ text: 'Live ✓' });
  expect(statusBarState([{ step: 'waiting' }], 0)).toMatchObject({ text: 'Waiting for approval', spin: false });
  expect(statusBarState([{ step: 'publishing' }], 0)).toMatchObject({ text: 'Publishing…', spin: true });
  expect(statusBarState([{ step: 'publishing' }, { step: 'waiting' }], 0)).toMatchObject({ text: '2 publishing' });
  expect(statusBarState([{ step: 'failed' }], 0)).toMatchObject({ text: 'Needs attention' });
  expect(statusBarState([{ step: 'failed', dismissed: true }], 0)).toBeNull();
  // The note mark: nothing once live.
  expect(markFor([{ path: 'a.md', step: 'live' }], 'a.md')).toBeNull();
  expect(markFor([{ path: 'a.md', step: 'waiting' }], 'a.md')).toBe('waiting');
  expect(markFor([{ path: 'a.md', step: 'failed' }], 'a.md')).toBe('attention');
  expect(markFor([{ path: 'a.md', step: 'waiting' }], 'b.md')).toBeNull();
});

test('offline: the post waits on the device, is sent through the same checks when back, and nothing is ever signed', async () => {
  let online = false;
  const seen = [];
  const client = { request: async (_pairing, command, input) => {
    seen.push(command);
    if (!online) throw new NodeError('unreachable');
    if (command === 'submitPageBundle') {
      return { bundleId: 'bundle-00000000-0000-4000-8000-000000000001', state: 'signing',
        publicAdditions: [{ path: input.main.path, address: '/threats-and-response/run-a-tabletop-exercise-in-one-hour' }] };
    }
    if (command === 'readPageBundle') return { step: 'waiting', pages: [] };
    throw new Error(`unexpected ${command}`);
  } };
  // This device can sign, and still nothing signs without a tap in the sheet.
  const key = await signing.createSigningKey();
  const signingStore = signing.createSigningStore(memoryBackend(), 'vault:offline');
  await signingStore.save({ version: 1, keyId: 'device-1', label: 'Phone', publicKey: key.publicKey, privateKey: key.privateKey,
    publisher, fingerprint: 'x', enrolledAt: 1 });
  const controller = createController({ client, store: { load: async () => ({ keyId: 'pair-1', grants: ['publish', 'propose', 'publication'] }) }, signingStore });
  const saved = [];
  const events = [];
  const send = async () => {
    const status = notePublicStatus({ path: NOTE, text: TEXT, publishYml: PUBLISH_YML, siteYml: SITE_YML });
    const outcome = await controller.publishNewPage({ path: NOTE }, TEXT, { status, images: [], remote: [] });
    return { bundleId: outcome.bundleId, step: 'waiting' };
  };
  const tracker = createPublishTracker({ readProgress: (id) => controller.bundleProgress(id), withdraw: (id) => controller.withdraw(id), send,
    isUnreachable: (error) => error instanceof NodeError && error.kind === 'unreachable',
    save: (queue) => saved.push(queue), onEvent: (event) => events.push(event.type) });
  const { item, done } = tracker.publish({ path: NOTE, title: 'Run a tabletop exercise in one hour' });
  await done;
  expect(item.step).toBe('queued');
  expect(saved.at(-1)).toEqual([{ path: NOTE, title: 'Run a tabletop exercise in one hour', queuedAt: expect.any(Number) }]);
  expect(statusBarState(tracker.items(), 0)).toMatchObject({ key: 'queued' });
  // Still offline: another round leaves it queued.
  await tracker.poll();
  expect(item.step).toBe('queued');
  // Back online: sent once, through the node's checks, and it waits for approval.
  online = true;
  const triedOffline = seen.filter((c) => c === 'submitPageBundle').length;
  await tracker.poll();
  expect(item.step).toBe('waiting');
  expect(events).toContain('needs-approval');
  expect(saved.at(-1)).toEqual([]);
  await tracker.poll();
  expect(seen.filter((c) => c === 'submitPageBundle')).toHaveLength(triedOffline + 1);
  expect(seen.some((c) => ['submitApproval', 'readApproval', 'listApprovals', 'readApprovalChunk'].includes(c))).toBe(false);
  // A restart keeps the queue: what was saved comes back queued.
  const restored = createPublishTracker({ readProgress: async () => null, withdraw: async () => {}, send: async () => { throw new NodeError('unreachable'); },
    load: () => [{ path: NOTE, title: 'T', queuedAt: 1 }] });
  expect(restored.items().map((i) => i.step)).toEqual(['queued']);
});

test('withdraw: asks the node to drop the bundle, and the note goes back to Draft', async () => {
  const calls = [];
  const tracker = createPublishTracker({ readProgress: async () => ({ step: 'waiting' }), withdraw: async (id) => { calls.push(id); },
    send: async () => ({ bundleId: 'bundle-x', step: 'waiting' }) });
  const { item, done } = tracker.publish({ path: NOTE, title: 'T' });
  await done;
  expect(await tracker.withdraw(item.id)).toMatchObject({ step: 'withdrawn' });
  expect(calls).toEqual(['bundle-x']);
  expect(statusBarState(tracker.items(), 0)).toBeNull();
  // Only before approval: a publishing post cannot be withdrawn.
  const second = tracker.publish({ path: 'b.md', title: 'B' });
  await second.done;
  second.item.step = 'publishing';
  expect(await tracker.withdraw(second.item.id)).toBeNull();
  // Draft back on, every other byte kept.
  const draft = '---\ntitle: T\ndate: 2026-11-24\ndraft: true # held\n---\n\nBody draft: false\n';
  expect(withDraftOn(withDraftOff(draft))).toBe(draft);
});
