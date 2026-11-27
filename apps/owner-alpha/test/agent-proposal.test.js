import { afterEach, expect, test } from 'bun:test';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareSourceBindingManifest, retainedManifestFilename, serializeSourceBindingManifest, sourceBindingDigest } from '@cyberbaser/account-free-intake';
import { createChangeSetProposal, serializeChangeSetProposal } from '@cyberbaser/proposal';
import { digestBytes } from '@cyberbaser/proposal-queue';
import { startIntakeRuntime, validateConfig as validateIntakeConfig } from '../../account-free-intake/src/index.js';
import { BASE_TEXT, configInput, createFixture, FORM_ORIGIN, REPOSITORY, request, SOURCE_PATH } from '../../account-free-intake/test/helpers.js';
import { computePolicyRevision, validateOwnerAlphaConfig } from '../src/config.js';
import { createOwnerCommands, executeSigned } from '../src/core/commands.js';
import { createDeviceKeyRegistry } from '../src/core/device-keys.js';
import { OWNER_GRANTS } from '../src/core/grants.js';
import { createBootstrapPrincipalAdapter, createDevicePrincipalAdapter } from '../src/core/principal.js';
import { PROPOSAL_BUDGET } from '../src/core/proposal-submission.js';
import { signedInputDigest, signedRequestBytes } from '../src/core/signed-request.js';
import { createOwnerProposalReviewSource } from '../src/proposal-review.js';
import { createProposalReviewClient } from '../src/proposal-review-client.js';
import { createOwnerProposalReviewService } from '../src/proposal-review-service.js';
import { createOwnerAlphaHandler } from '../src/server.js';
import { OWNER_SITE_ARTIFACT_TYPE, OWNER_SITE_MANIFEST_FILENAME } from '../src/site.js';
import { storeContextFromConfig, prepareStore } from '../src/store.js';

const example = JSON.parse(await readFile(new URL('../owner-alpha.example.json', import.meta.url), 'utf8'));
const START = Date.parse('2026-11-21T10:00:00Z');
const AT = new Date(START).toISOString().replace('.000Z', 'Z');
const AUDIENCE = 'synthetic-owner-proposal';
const PRIVATE_PATH = 'docs/unpublished.md';
const OWNER_ORIGIN = 'http://127.0.0.1:4317';
const cleanup = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

function key(keyId, { kind = 'agent', grants = ['propose'], id = `actor-${keyId}`, label = `Test ${keyId}` } = {}) {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  return { privateKey: pair.privateKey, entry: { keyId, publicKey, actor: { kind, id, label }, grants,
    notBefore: START - 10_000, notAfter: START + 600_000, revoked: false } };
}

function proposer(config, keys, now, proposalReview) {
  const registry = createDeviceKeyRegistry({ ownerId: config.owner.identity, entries: keys.map(({ entry }) => entry) });
  const principalAdapter = createBootstrapPrincipalAdapter();
  const device = createDevicePrincipalAdapter({ registry, audience: AUDIENCE, now });
  const commands = createOwnerCommands({ config, principalAdapter, devicePrincipalAdapter: device,
    proposalReview, proposalClock: now });
  const owner = principalAdapter.fromSession({ id: config.owner.identity, sessionId: 'synthetic-owner', authenticatedAt: START });
  return { commands, owner, issue(key, command, input) {
    const claims = { audience: AUDIENCE, keyId: key.entry.keyId, command, inputDigest: signedInputDigest(input),
      nonce: randomBytes(16).toString('base64'), issuedAt: now() };
    const signature = sign(null, signedRequestBytes(claims), key.privateKey).toString('base64');
    return executeSigned(commands, device, { ...claims, input, signature });
  } };
}

async function git(cwd, args) {
  const proc = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`fixture Git failed: ${err}`);
  return out.trim();
}

function proposal(revision, options = {}) {
  const { id = 'agent-proposal-1', sourcePath = SOURCE_PATH, base = BASE_TEXT, rationale = 'Correct the typo.',
    operations = [{ operationId: 'typo', start: BASE_TEXT.indexOf('teh'), end: BASE_TEXT.indexOf('teh') + 3,
      expected: 'teh', replacement: 'the' }], identityClaim = null } = options;
  return createChangeSetProposal(Buffer.from(base), { proposalId: id,
    source: { repository: REPOSITORY, revision, path: sourcePath }, operations,
    submission: { submittedAt: AT, rationale, evidence: [], identityClaim } });
}

async function setup(base = BASE_TEXT) {
  const f = await createFixture({ pages: [{ path: SOURCE_PATH, text: base }, { path: PRIVATE_PATH, text: BASE_TEXT }] });
  cleanup.push(() => f.cleanup());
  await git(f.checkout, ['remote', 'set-url', 'origin', REPOSITORY]);
  const { source, publication, renderer, trustPolicy, pages } = f.manifest;
  const selected = pages.filter((page) => page.path === SOURCE_PATH).map(({ path, byteLength, digest }) => ({ path, byteLength, digest }));
  const manifest = prepareSourceBindingManifest({ source, renderer, trustPolicy, pages: selected,
    publication: { ...publication, selectedTreeDigest: digestBytes(Buffer.from(JSON.stringify(selected))) } });
  const bindingDigest = sourceBindingDigest(manifest);
  await writeFile(path.join(f.config.bindingsRoot, retainedManifestFilename(bindingDigest)), serializeSourceBindingManifest(manifest), { mode: 0o600 });
  const socketRoot = path.join(f.root, 'ipc');
  await mkdir(socketRoot, { mode: 0o700 });
  const socketPath = path.join(socketRoot, 'review.sock');
  const proposalReviewConfig = { enabled: true, socketPath, requestTimeoutMs: 5000, maxListEntries: 100 };
  const intakeConfig = validateIntakeConfig(configInput(f.root, {
    reviewIpc: { ...proposalReviewConfig, maxConcurrentRequests: 4 },
  }));
  const config = validateOwnerAlphaConfig({ ...example, owner: { ...example.owner, identity: 'owner' },
    proposalReview: proposalReviewConfig, repository: { checkout: f.checkout, remote: { name: 'origin', url: REPOSITORY }, branch: 'main' },
    workflow: { provider: 'forgejo-actions', apiBaseUrl: 'https://forge.example:8443/api/v1', repository: 'owner/wiki',
      path: '.forgejo/workflows/publish-site.yml', event: 'push', branch: 'main', jobs: ['build', 'deploy'], deploymentJob: 'deploy' } });
  const projectRoot = path.join(f.root, 'owner');
  await mkdir(projectRoot);
  await git(projectRoot, ['init', '-q', '--initial-branch=main']);
  await writeFile(path.join(projectRoot, '.gitignore'), '.workspace/\n');
  const context = storeContextFromConfig(config, projectRoot);
  await prepareStore(context);
  const siteRoot = path.join(projectRoot, config.workspace.site);
  await mkdir(siteRoot, { recursive: true });
  async function setSiteHead(head) {
    await writeFile(path.join(siteRoot, OWNER_SITE_MANIFEST_FILENAME), JSON.stringify({ schemaVersion: 1,
      artifactType: OWNER_SITE_ARTIFACT_TYPE, policyRevision: computePolicyRevision(config),
      source: { head, branch: 'main', remote: config.repository.remote }, suggestions: { form: true, bindingDigest } }));
  }
  await setSiteHead(f.revision);
  let time = START;
  const now = () => time;
  const clock = () => new Date(now());
  const runtime = await startIntakeRuntime({ config: intakeConfig, serviceOptions: { clock },
    startPublic: () => ({ stop() {} }) }); // Unix socket is real; public fetch stays in process.
  cleanup.push(() => runtime.close());
  const client = createProposalReviewClient({ socketPath });
  const reviewSource = createOwnerProposalReviewSource({ config, client, clock });
  let saves = 0;
  const saveEdit = async () => { saves += 1; throw new Error('only separate Apply may start Save'); };
  const service = createOwnerProposalReviewService({ config, context, source: reviewSource, decisionClock: clock,
    application: { saveEdit, createJobId: () => 'OA-not-started', resolveSlug: () => 'docs/notes' } });
  return { ...f, config, projectRoot, service, intake: runtime.service, setSiteHead, now,
    advance: (ms) => { time += ms; }, saves: () => saves,
    clientFor: (...keys) => proposer(config, keys, now, service),
    handler: () => createOwnerAlphaHandler({ config, projectRoot, proposalReview: service, saveEdit, lookupJob: async () => null }),
  };
}

function ownerRequest(pathname, cookie) {
  return new Request(`${OWNER_ORIGIN}${pathname}`, { headers: { Host: '127.0.0.1:4317', ...(cookie ? { Cookie: cookie } : {}) } });
}

async function view(handler, cookie, pathname) {
  const response = await handler(ownerRequest(pathname, cookie));
  expect(response.status).toBe(200);
  return response.text();
}

const refused = { code: 'proposal-submission-refused', message: 'proposal submission was refused', details: {} };
const unauthorized = { code: 'invalid-session', message: 'a verified owner session is required', details: {} };

test('signed agent enters the same inbox with escaped identity; only the owner can approve and no source changes', async () => {
  const f = await setup();
  const agent = key('agent-key-0123456789', { id: 'agent-"<verified>', label: '<b>Draft agent</b>' });
  const { commands, owner, issue } = f.clientFor(agent);
  const artifact = proposal(f.revision);
  await expect(commands.submitProposal(artifact, owner)).rejects.toMatchObject(unauthorized);
  const receipt = await issue(agent, 'submitProposal', artifact);
  expect(receipt).toEqual({ queueId: expect.stringMatching(/^Q-/u), acceptedAt: AT, baseBound: true });
  const submitter = { ...agent.entry.actor, keyId: agent.entry.keyId };
  const list = await commands.listProposals({}, owner);
  expect(list.actionable).toHaveLength(1);
  expect(list.actionable[0].summary).toMatchObject({ schemaVersion: 2, lane: 'lane-signed', submitter,
    tier: 'unregistered-agent', route: 'full-review', queueId: receipt.queueId });
  const { entry } = await commands.readProposal({ queueId: receipt.queueId }, owner);
  expect(entry.evidence.carrier.metadata.submitter).toEqual(submitter);
  expect(entry.evidence.classification.verifiedSubject).toEqual({ author: submitter.id, authorType: 'agent' });
  expect(await readFile(path.join(f.checkout, SOURCE_PATH), 'utf8')).toBe(BASE_TEXT);

  const visitor = await f.intake.fetch(request('/v1/corrections', { method: 'POST', origin: FORM_ORIGIN,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f.intent()) }));
  expect(visitor.status).toBe(202);
  const oldId = (await visitor.json()).receipt.queueId;
  const old = await commands.readProposal({ queueId: oldId }, owner);
  expect(old.entry.summary).toMatchObject({ schemaVersion: 1, lane: 'lane-b' });
  expect(old.entry.summary).not.toHaveProperty('submitter');
  const handler = f.handler();
  const login = await handler(ownerRequest(`/owner/bootstrap?token=${handler.bootstrapToken}`));
  expect(login.status).toBe(303);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  for (const pathname of ['/owner/review', `/owner/review/${receipt.queueId}`]) {
    const html = await view(handler, cookie, pathname);
    expect(html).toMatch(/From (<b>)?&lt;b&gt;Draft agent&lt;\/b&gt;(<\/b>)?, one of your agents/u);
    expect(html).not.toContain('<b>Draft agent</b>');
    if (pathname === '/owner/review') expect(html).not.toContain(submitter.keyId);
    else expect(html).toContain('<dt>Submitter ID</dt><dd>agent-&quot;&lt;verified&gt;</dd>');
  }
  const oldHtml = await view(handler, cookie, `/owner/review/${oldId}`);
  expect(oldHtml).toContain('From <b>a visitor</b>, not signed in.');
  expect(oldHtml).not.toContain('<dt>Submitter key ID</dt>');
  expect(oldHtml).toContain('Correct the misspelling.');

  const approved = await commands.recordDecision({ queueId: receipt.queueId,
    reviewEvidenceDigest: entry.summary.reviewEvidenceDigest, action: 'approve', reason: 'Exact wording is good.' }, owner);
  expect(approved).toMatchObject({ action: 'approve', replayed: false, summary: { lane: 'lane-signed' } });
  const decision = await commands.readDecision({ queueId: receipt.queueId }, owner);
  expect(decision.decision).toMatchObject({ schemaVersion: 2, authorityScope: 'decision-only', action: 'approve',
    effectBoundary: { appliesSource: false, writesSource: false, publishes: false },
    reviewEvidence: { carrier: { metadata: { submitter } } } });
  expect(decision.application).toMatchObject({ state: 'eligible', attempts: [] });
  for (const pathname of ['/owner/review', `/owner/decisions/${receipt.queueId}`]) {
    expect(await view(handler, cookie, pathname)).toMatch(/From (<b>)?&lt;b&gt;Draft agent&lt;\/b&gt;(<\/b>)?, one of your agents/u);
  }
  expect(await issue(agent, 'submitProposal', artifact)).toEqual(receipt); // No decision status on replay either.
  expect(await readFile(path.join(f.checkout, SOURCE_PATH), 'utf8')).toBe(BASE_TEXT);
  expect(await git(f.checkout, ['rev-parse', 'HEAD'])).toBe(f.revision);
  expect(f.saves()).toBe(0);
}, 20_000);

test('signed intake does not override the separate owner Apply frontmatter guard', async () => {
  const base = `---\ntitle: Fixture\n---\n\n${BASE_TEXT}`;
  const f = await setup(base);
  const agent = key('frontmatter-agent');
  const { commands, owner, issue } = f.clientFor(agent);
  const start = base.indexOf('Fixture');
  const { queueId } = await issue(agent, 'submitProposal', proposal(f.revision, { base, operations: [
    { operationId: 'retitle', start, end: start + 'Fixture'.length, expected: 'Fixture', replacement: 'Changed' },
  ] }));
  const { entry } = await commands.readProposal({ queueId }, owner);
  await commands.recordDecision({ queueId, reviewEvidenceDigest: entry.summary.reviewEvidenceDigest,
    action: 'approve', reason: 'Approve records the decision only.' }, owner);
  const result = await commands.readDecision({ queueId }, owner);
  expect(result.application).toMatchObject({ state: 'unapplicable', reason: 'frontmatter-change', attempts: [] });
  expect(f.saves()).toBe(0);
  expect(await readFile(path.join(f.checkout, SOURCE_PATH), 'utf8')).toBe(base);
}, 20_000);

test('proposal grants do not reveal queue, own decisions or publication and cannot spoof attribution', async () => {
  const f = await setup();
  const agent = key('agent');
  const noGrant = key('no-grant', { grants: [] });
  const device = key('phone', { kind: 'owner-device' });
  const { issue } = f.clientFor(agent, noGrant, device);
  const artifact = proposal(f.revision);
  const { queueId } = await issue(agent, 'submitProposal', artifact);
  for (const actor of [agent, device]) {
    for (const command of ['listProposals', 'readProposal', 'recordDecision', 'readDecision', 'applyProposal',
      'readPublicationStatus', 'readPublicationReceipt', 'readPublicationCurrent', 'readPublicationReview', 'preparePublication', 'publish',
      'readPageSource', 'readJob', 'openRawEdit', 'saveRawEdit', 'stageOwnerDirect', 'inspectOwnerDirect', 'saveOwnerDirect', 'requireGrant']) {
      await expect(issue(actor, command, { queueId })).rejects.toMatchObject(unauthorized);
    }
  }
  await expect(issue(noGrant, 'submitProposal', artifact)).rejects.toMatchObject(unauthorized);
  await expect(issue(agent, 'submitProposal', proposal(f.revision, { identityClaim: {
    type: 'agent', issuer: 'https://issuer.example/', subject: 'another-agent',
  } }))).rejects.toMatchObject(refused);
  const matching = proposal(f.revision, { id: 'owner-device-proposal', identityClaim: {
    type: 'human', issuer: 'https://issuer.example/', subject: device.entry.actor.id,
  } });
  expect((await issue(device, 'submitProposal', matching)).queueId).not.toBe(queueId);
  expect(f.intake.stats().pendingEntries).toBe(2);
}, 20_000);

test('no other grant can be added to an enrolled agent’s proposal key', () => {
  for (const grant of OWNER_GRANTS.filter((value) => value !== 'propose')) {
    const { entry } = key('agent', { grants: ['propose', grant] });
    expect(() => createDeviceKeyRegistry({ ownerId: 'owner', entries: [entry] })).toThrow('invalid device key enrollment');
  }
});

test('stale, wrong digest, unselected or unknown paths and invalid operations share one refusal', async () => {
  const f = await setup();
  const agent = key('agent');
  const { issue } = f.clientFor(agent);
  const good = proposal(f.revision);
  for (const artifact of [
    proposal('b'.repeat(40)),
    proposal(f.revision, { base: BASE_TEXT.replace('Notes', 'Other') }),
    proposal(f.revision, { sourcePath: PRIVATE_PATH }),
    proposal(f.revision, { sourcePath: 'docs/unknown.md' }),
    { ...good, submission: { ...good.submission, rationale: 'x'.repeat(16_385) } },
    { schemaVersion: 2, changeSet: 'not an exact operation' },
    { ...good, changeSet: { ...good.changeSet, files: [{ ...good.changeSet.files[0], operations: [{
      operationId: 'whole', start: 0, end: BASE_TEXT.length, expected: BASE_TEXT, replacement: '# Fully overwritten\n',
    }] }] } },
    { path: SOURCE_PATH, editedText: 'unbounded editing is not the command contract' },
  ]) {
    await expect(issue(agent, 'submitProposal', artifact)).rejects.toMatchObject(refused);
    expect(f.intake.stats().pendingEntries).toBe(0);
  }
}, 20_000);

test('same key and bytes replay create-once, another key or proposal is separate, and a stale site admits no new entry', async () => {
  const f = await setup();
  const alice = key('one');
  const bob = key('two');
  const { issue } = f.clientFor(alice, bob);
  const artifact = proposal(f.revision);
  const submit = (actor, value) => issue(actor, 'submitProposal', value);
  const first = await submit(alice, artifact);
  expect(await submit(alice, serializeChangeSetProposal(artifact))).toEqual(first);
  expect(f.intake.stats().pendingEntries).toBe(1);
  const second = await submit(alice, proposal(f.revision, { id: 'second', rationale: 'Different proposal.' }));
  expect(second.queueId).not.toBe(first.queueId);
  const otherKey = await submit(bob, artifact);
  expect(otherKey.queueId).not.toBe(first.queueId);
  await f.setSiteHead('a'.repeat(40));
  expect(await submit(alice, artifact)).toEqual(first);
  await expect(submit(alice, proposal(f.revision, { id: 'stale-site' }))).rejects.toMatchObject(refused);
  expect(f.intake.stats().pendingEntries).toBe(3);
}, 20_000);

test('per-key attempts charge refusals and replays, recover on the window boundary, and leave other keys independent', async () => {
  const f = await setup();
  const one = key('one');
  const two = key('two');
  const { issue } = f.clientFor(one, two);
  const artifact = proposal(f.revision);
  await expect(issue(one, 'submitProposal', {})).rejects.toMatchObject(refused);
  const receipt = await issue(one, 'submitProposal', artifact);
  for (let n = 2; n < PROPOSAL_BUDGET.attempts; n += 1) expect(await issue(one, 'submitProposal', artifact)).toEqual(receipt);
  await expect(issue(one, 'submitProposal', artifact)).rejects.toMatchObject({ code: 'proposal-budget-exhausted' });
  expect((await issue(two, 'submitProposal', artifact)).queueId).not.toBe(receipt.queueId);
  f.advance(PROPOSAL_BUDGET.windowMs);
  expect(await issue(one, 'submitProposal', artifact)).toEqual(receipt);
  expect(f.intake.stats().pendingEntries).toBe(2);
}, 20_000);

test('canonical bytes have a separate per-key window cap', async () => {
  const f = await setup();
  const actor = key('one');
  const receipt = { queueId: 'Q-00000000-0000-4000-8000-000000000001', acceptedAt: AT, baseBound: true };
  let handoffs = 0;
  const { issue } = proposer(f.config, [actor], f.now, { submitSigned: async () => { handoffs += 1; return receipt; } });
  const artifact = proposal(f.revision, { rationale: 'x'.repeat(16_384), operations: Array.from({ length: 4 }, (_, i) => ({
    operationId: `insert-${i}`, start: i + 1, end: i + 1, expected: '', replacement: 'y'.repeat(16_384),
  })) });
  const proposalsPerVolume = Math.floor(PROPOSAL_BUDGET.bytes / Buffer.byteLength(serializeChangeSetProposal(artifact)));
  expect(proposalsPerVolume).toBeLessThan(PROPOSAL_BUDGET.attempts);
  for (let i = 0; i < proposalsPerVolume; i++) expect(await issue(actor, 'submitProposal', artifact)).toEqual(receipt);
  await expect(issue(actor, 'submitProposal', artifact)).rejects.toMatchObject({ code: 'proposal-budget-exhausted' });
  expect(handoffs).toBe(proposalsPerVolume);
  f.advance(PROPOSAL_BUDGET.windowMs);
  expect(await issue(actor, 'submitProposal', artifact)).toEqual(receipt);
}, 20_000);
