import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateOwnerAlphaConfig } from '../src/config.js';
import { createOwnerCommands, executeSigned } from '../src/core/commands.js';
import { createLiveDeviceKeyRegistry } from '../src/core/device-keys.js';
import { createDevicePrincipalAdapter } from '../src/core/principal.js';
import { signedInputDigest, signedRequestBytes } from '../src/core/signed-request.js';
import { openNoteLinks } from '../src/note-links.js';
import { countDifferentLines, createNoteStatus } from '../src/note-status.js';
import { PIPELINE_SCHEMA_VERSION, pipelineArtifactPaths } from '../src/pipeline.js';

// Status for every note the site publishes, from the vault's own rules at the
// branch head plus the node's verified deployment evidence; and the owner's
// linking step. Synthetic vaults only.

const example = await Bun.file(new URL('../owner-alpha.example.json', import.meta.url)).json();
const cleanup = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

const MAPPING = { id: 'garden', source: { identity: 'phone-workspace', path: 'Notes/Garden.md', kind: 'workspace' },
  relativePath: 'notes/garden.md', slug: 'garden' };

async function tempDir() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cb-status-')));
  await chmod(dir, 0o700);
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'commit.gpgSign=false', ...args], { encoding: 'utf8' }).trim();

async function commit(checkout, files, message) {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(checkout, name)), { recursive: true });
    await writeFile(path.join(checkout, name), text);
  }
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-q', '-m', message);
  return git(checkout, 'rev-parse', 'HEAD');
}

async function vault() {
  const root = await tempDir();
  const checkout = path.join(root, 'vault');
  await mkdir(checkout);
  git(checkout, 'init', '-q', '--initial-branch=main');
  git(checkout, 'config', 'user.name', 'T'); git(checkout, 'config', 'user.email', 't@example.invalid');
  const deployed = await commit(checkout, {
    'publish.yml': 'allow:\n  - notes/**\n',
    'notes/garden.md': '# Garden\r\n\r\nWater daily.\r\n',
    'notes/kitchen.md': '# Kitchen\n\nSalt.\n',
    'notes/draft.md': '---\ncb-publish: false\n---\n# Draft\n',
    'private/diary.md': '# Diary\n\nSecret.\n',
  }, 'base');
  return { root, checkout, deployed };
}

function configFor(checkout, { publication = true } = {}) {
  return validateOwnerAlphaConfig({ ...example,
    repository: { ...example.repository, checkout },
    proposalReview: { ...example.proposalReview, enabled: true, socketPath: '/run/cb/review.sock' },
    ...(publication ? { ownerPublication: { enabled: true, mappings: [MAPPING] } } : {}) });
}

// A fake job store holding one verified deployment of `commit`.
function evidenceFor(commit, at = '2026-11-23T10:00:00.000Z', { broken = false } = {}) {
  const jobId = 'OA-11111111-1111-4111-8111-111111111111';
  const files = pipelineArtifactPaths(jobId);
  const record = (artifactType, result) => ({ schemaVersion: PIPELINE_SCHEMA_VERSION, artifactType, jobId, result });
  const records = {
    [files.committed]: record('owner-alpha-committed-effect', { commit }),
    [files.runBound]: record('owner-alpha-run-bound-effect', { binding: { provider: 'github-actions', headSha: commit, runId: '7', runAttempt: 1 } }),
    [files.deployment]: record('owner-alpha-deployment-result', { provider: 'github-actions',
      run: { headSha: broken ? 'f'.repeat(40) : commit, runId: '7', runAttempt: 1, status: 'completed', conclusion: 'success' },
      environment: { state: 'success' } }),
  };
  let listed = 0;
  return {
    listJobs: async () => { listed += 1; return [{ jobId, history: [{ to: 'accepted', at: '2026-11-23T09:00:00.000Z' }, { to: 'live-confirmed', at }] }]; },
    readArtifact: async (_context, file) => records[file] ?? null,
    get listed() { return listed; },
  };
}

const digest = (text) => `sha-256=:${createHash('sha256').update(text.replace(/\r\n?/gu, '\n')).digest('base64')}:`;

test('status: live, older, not yet confirmed, excluded and unknown, from the vault rules and verified evidence', async () => {
  const { checkout, deployed } = await vault();
  const config = configFor(checkout);
  const evidence = evidenceFor(deployed);
  const status = createNoteStatus({ config, context: null, ...evidence });
  // After the deployment: kitchen changed, a new note added.
  await commit(checkout, { 'notes/kitchen.md': '# Kitchen\n\nSalt and pepper.\n', 'notes/new.md': '# New\n' }, 'later');

  // Published and live: the verified deployment's text, folded.
  expect(await status.status('notes/garden.md')).toEqual({ selected: true,
    live: { digest: digest('# Garden\n\nWater daily.\n'), folded: true, at: '2026-11-23T10:00:00.000Z', commit: deployed } });
  // Published, but the vault moved on: live is the older text.
  expect((await status.status('notes/kitchen.md')).live.digest).toBe(digest('# Kitchen\n\nSalt.\n'));
  // Selected now, not in the verified deployment: public, not confirmed yet.
  expect(await status.status('notes/new.md')).toEqual({ selected: true, live: null });
  // The selector excludes these; an unknown path looks the same.
  for (const vaultPath of ['notes/draft.md', 'private/diary.md', 'nowhere.md', '../x.md', null]) {
    expect(await status.status(vaultPath)).toEqual({ selected: false, live: null });
  }
  expect(await status.publishedPaths()).toEqual(['notes/garden.md', 'notes/kitchen.md', 'notes/new.md']);
  // Evidence is cached briefly, not re-read per call.
  expect(evidence.listed).toBe(1);
});

test('status: no verified deployment, or evidence that does not agree, means not confirmed', async () => {
  const { checkout, deployed } = await vault();
  const config = configFor(checkout);
  const none = createNoteStatus({ config, context: null, listJobs: async () => [] });
  expect(await none.status('notes/garden.md')).toEqual({ selected: true, live: null });
  const broken = createNoteStatus({ config, context: null, ...evidenceFor(deployed, undefined, { broken: true }) });
  expect(await broken.status('notes/garden.md')).toEqual({ selected: true, live: null });
});

test('status: the selection follows the branch head; a missing publish.yml publishes nothing', async () => {
  const { checkout } = await vault();
  const status = createNoteStatus({ config: configFor(checkout), context: null, listJobs: async () => [] });
  expect((await status.status('private/diary.md')).selected).toBe(false);
  await commit(checkout, { 'publish.yml': 'allow:\n  - notes/**\n  - private/**\n' }, 'open diary');
  expect((await status.status('private/diary.md')).selected).toBe(true);
  git(checkout, 'rm', '-q', 'publish.yml'); git(checkout, 'commit', '-q', '-m', 'no rules');
  expect((await status.status('notes/garden.md')).selected).toBe(false);
});

// ---- Through the signed command: tiers and privacy ----

function deviceKey() {
  const pair = generateKeyPairSync('ed25519');
  return { privateKey: pair.privateKey, publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64') };
}

function device(config, { grants, kind = 'owner-device', noteStatus, noteLinks = null, publication = null, submitted = [] }) {
  const key = deviceKey();
  const { registry } = createLiveDeviceKeyRegistry({ ownerId: config.owner.identity, entries: [{ keyId: 'phone-1', publicKey: key.publicKey,
    actor: { kind, id: 'phone-1', label: 'Phone' }, grants, notBefore: Date.now() - 1000, notAfter: Date.now() + 600_000, revoked: false }] });
  const verifier = createDevicePrincipalAdapter({ registry, audience: 'local-test' });
  const commands = createOwnerCommands({ config, devicePrincipalAdapter: verifier, noteStatus, noteLinks, publication,
    proposalReview: { submitSigned: async (input) => { submitted.push(input); return { queueId: `Q-${randomUUID()}`, acceptedAt: '2026-11-23T10:00:00Z', baseBound: true }; } } });
  return (command, input) => {
    const claims = { audience: 'local-test', keyId: 'phone-1', command, inputDigest: signedInputDigest(input),
      nonce: randomBytes(16).toString('base64'), issuedAt: Date.now() };
    return executeSigned(commands, verifier, { ...claims, input, signature: sign(null, signedRequestBytes(claims), key.privateKey).toString('base64') });
  };
}

test('readNoteStatus: owner and propose-only tiers; only the asked path; never another note', async () => {
  const { checkout, deployed } = await vault();
  const config = configFor(checkout, { publication: false });
  const noteStatus = createNoteStatus({ config, context: null, ...evidenceFor(deployed) });
  const owner = device(config, { grants: ['publication', 'propose'], noteStatus });
  const phone = device(config, { grants: ['propose'], noteStatus });
  const agent = device(config, { grants: ['propose'], kind: 'agent', noteStatus });
  const live = { digest: digest('# Garden\n\nWater daily.\n'), folded: true, at: '2026-11-23T10:00:00.000Z' };
  // Publication is off on this node, so the owner device also gets the public tier.
  expect(await owner('readNoteStatus', { path: 'notes/garden.md' })).toEqual({ path: 'notes/garden.md', selected: true, live });
  for (const run of [phone, agent]) {
    const reply = await run('readNoteStatus', { path: 'notes/garden.md' });
    expect(reply).toEqual({ path: 'notes/garden.md', selected: true, live });
    const hidden = await run('readNoteStatus', { path: 'private/diary.md' });
    expect(hidden).toEqual({ path: 'private/diary.md', selected: false, live: null });
    // Nothing about other notes: no other path, no commit, no drafts.
    const text = JSON.stringify([reply, hidden]);
    for (const other of ['kitchen', 'draft', deployed, 'latest', 'mappingId', 'publishAvailable']) expect(text).not.toContain(other);
  }
  // With publication on, the owner tier adds publishing facts; propose-only never does.
  const on = configFor(checkout);
  const publication = { publishAvailable: true, readStatus: async () => ({ live: null, latest: null }) };
  const fullOwner = device(on, { grants: ['publication', 'propose'], noteStatus, publication });
  expect(await fullOwner('readNoteStatus', { path: 'notes/kitchen.md' })).toEqual({ path: 'notes/kitchen.md', selected: true,
    live: { digest: digest('# Kitchen\n\nSalt.\n'), folded: true, at: '2026-11-23T10:00:00.000Z' }, publishAvailable: false });
  expect(await fullOwner('readNoteStatus', { path: 'Notes/Garden.md' })).toMatchObject({ mappingId: 'garden', publishAvailable: true });
  const onPhone = device(on, { grants: ['propose'], noteStatus, publication });
  expect(await onPhone('readNoteStatus', { path: 'Notes/Garden.md' })).toEqual({ path: 'Notes/Garden.md', selected: true, live });
  // No grant that allows status: refused.
  const reader = device(config, { grants: ['read'], noteStatus });
  await expect(reader('readNoteStatus', { path: 'notes/garden.md' })).rejects.toHaveProperty('code', 'invalid-session');
});

// ---- Linking a note to the vault ----

async function linksFor(config, root, noteStatus, extra = {}) {
  const directory = path.join(root, 'state');
  await mkdir(directory, { mode: 0o700 });
  return { directory, links: await openNoteLinks({ directory, config, noteStatus, ...extra }) };
}

test('linking: a Send the node cannot place asks the owner; Confirm links only matching text', async () => {
  const { root, checkout } = await vault();
  const config = configFor(checkout, { publication: false });
  const noteStatus = createNoteStatus({ config, context: null, listJobs: async () => [] });
  const { directory, links } = await linksFor(config, root, noteStatus);
  const submitted = [];
  const phone = device(config, { grants: ['propose'], noteStatus, noteLinks: links, submitted });
  const agentLike = device(config, { grants: ['propose'], kind: 'agent', noteStatus, noteLinks: links });

  // The phone keeps the note in another folder: the node cannot place it.
  const text = '# Kitchen\r\n\r\nSalt.\r\n';
  await expect(phone('submitCapture', { path: 'Cooking/Kitchen.md', text })).rejects.toHaveProperty('code', 'note-needs-linking');
  // Agents never create link requests.
  await expect(agentLike('submitCapture', { path: 'Elsewhere/x.md', text })).rejects.toHaveProperty('code', 'capture-base-unavailable');
  const [request] = links.list();
  expect(links.list().length).toBe(1);
  expect(request).toMatchObject({ notePath: 'Cooking/Kitchen.md', suggestedVaultPath: 'Cooking/Kitchen.md', fixedVaultPath: false });
  expect(JSON.stringify(links.list())).not.toContain('Salt');

  // Refusals record nothing: a path that is not published, then different text.
  await expect(links.confirm({ requestId: request.requestId, vaultPath: 'private/diary.md' })).rejects.toHaveProperty('code', 'link-path-not-published');
  expect(await links.confirm({ requestId: request.requestId, vaultPath: 'notes/garden.md' })).toEqual({ linked: false, count: 4, many: false });
  await expect(stat(path.join(directory, 'note-links.json'))).rejects.toHaveProperty('code', 'ENOENT');
  await expect(links.confirm({ requestId: request.requestId, vaultPath: 'notes/kitchen.md' })).rejects.toHaveProperty('code', 'link-request-expired');

  // Send again, then link to the right file: the texts match after line-ending folding.
  await expect(phone('submitCapture', { path: 'Cooking/Kitchen.md', text })).rejects.toHaveProperty('code', 'note-needs-linking');
  const again = links.list()[0];
  expect(await links.confirm({ requestId: again.requestId, vaultPath: 'notes/kitchen.md' }))
    .toEqual({ linked: true, notePath: 'Cooking/Kitchen.md', vaultPath: 'notes/kitchen.md' });
  const file = path.join(directory, 'note-links.json');
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(file, 'utf8')).links['Cooking/Kitchen.md'].vaultPath).toBe('notes/kitchen.md');
  expect(links.resolve('Cooking/Kitchen.md')).toBe('notes/kitchen.md');

  // Now Send lands on the linked vault file, and status follows the link.
  const receipt = await phone('submitCapture', { path: 'Cooking/Kitchen.md', text: text.replace('Salt', 'Pepper') });
  expect(receipt.deliveryPath).toBe('notes/kitchen.md');
  expect(JSON.stringify(submitted[0])).toContain('notes/kitchen.md');
  expect((await phone('readNoteStatus', { path: 'Cooking/Kitchen.md' })).selected).toBe(true);

  // Linking the same again changes nothing (no rewrite).
  const before = await readFile(file, 'utf8');
  await expect(phone('submitCapture', { path: 'Cooking/Other.md', text })).rejects.toHaveProperty('code', 'note-needs-linking');
  links.request({ notePath: 'Cooking/Kitchen.md', text });
  const repeat = links.list().find((item) => item.notePath === 'Cooking/Kitchen.md');
  expect(await links.confirm({ requestId: repeat.requestId, vaultPath: 'notes/kitchen.md' })).toMatchObject({ linked: true, unchanged: true });
  expect(await readFile(file, 'utf8')).toBe(before);

  // A restarted node reads the same links back.
  const reopened = await openNoteLinks({ directory, config, noteStatus });
  expect(reopened.resolve('Cooking/Kitchen.md')).toBe('notes/kitchen.md');
});

test('linking: the publication page binds through the existing baseline, only when its texts match', async () => {
  const { root, checkout } = await vault();
  const config = configFor(checkout);
  const noteStatus = createNoteStatus({ config, context: null, listJobs: async () => [] });
  let workspaceText = '# Garden\n\nWater weekly.\n';
  const bound = [];
  const publication = {
    publishAvailable: true,
    readStatus: async () => ({ live: null, latest: null }),
    prepare: async () => { const error = new (await import('../src/errors.js')).OwnerAlphaError('workspace-unbound', 'x'); throw error; },
    bindWorkspaceBaseline: async ({ mappingId }) => { bound.push(mappingId); return { mappingId }; },
  };
  const { links } = await linksFor(config, root, noteStatus, { publication, readMappingNote: async () => ({ text: workspaceText }) });
  const owner = device(config, { grants: ['publication', 'publish', 'propose'], noteStatus, noteLinks: links, publication });
  await expect(owner('preparePublication', { mappingId: 'garden', expectedDigest: digest('x') })).rejects.toHaveProperty('code', 'note-needs-linking');
  const [request] = links.list();
  expect(request).toMatchObject({ notePath: 'Notes/Garden.md', suggestedVaultPath: 'notes/garden.md', fixedVaultPath: true });
  await expect(links.confirm({ requestId: request.requestId, vaultPath: 'notes/kitchen.md' })).rejects.toHaveProperty('code', 'link-path-refused');
  expect(await links.confirm({ requestId: request.requestId, vaultPath: 'notes/garden.md' })).toEqual({ linked: false, count: 2, many: false });
  expect(bound).toEqual([]);
  workspaceText = '# Garden\n\nWater daily.\n';
  links.request({ notePath: 'Notes/Garden.md' });
  expect(await links.confirm({ requestId: links.list()[0].requestId, vaultPath: 'notes/garden.md' })).toMatchObject({ linked: true });
  expect(bound).toEqual(['garden']);
});

test('linking: line difference counts', () => {
  expect(countDifferentLines('a\nb\nc', 'a\nb\nc')).toEqual({ count: 0, many: false });
  expect(countDifferentLines('a\nb\nc', 'a\nB\nc')).toEqual({ count: 2, many: false });
  expect(countDifferentLines('a\nb', 'a\nb\nc\nd')).toEqual({ count: 2, many: false });
});
