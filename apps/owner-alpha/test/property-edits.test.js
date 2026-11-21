import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deriveContiguousCorrection } from '@cyberbaser/correction';
import { createChangeSetProposal } from '@cyberbaser/proposal';
import { reviewProposalDigest } from '@cyberbaser/proposal-review';
import { parseFrontmatter } from '@cyberbaser/publish';
import { findFrontmatterInText } from '../../../packages/correction/src/frontmatter.js';
import { runPreApplyChecks } from '../src/checks.js';
import { computePolicyRevision, validateOwnerAlphaConfig } from '../src/config.js';
import { applyEditorOperation, deriveEditorOperation } from '../src/operation.js';
import { deriveOwnerDirect } from '../src/owner-direct.js';
import { foldedWorkspaceDigest, prepareOwnerPublication } from '../src/owner-publication.js';
import { deriveProposalApplication } from '../src/proposal-application.js';
import { createEditSession } from '../src/source.js';
import { cleanup, publicationFixture } from './publication-fixture.js';

const base = [
  '---', 'cb-publish: true', 'slug: Notes/page', 'title: Old heading', 'tags: [original, steady]',
  'date: 2024-01-02', 'plugin-field:    "old setting" # keep exact spacing', '# old comment',
  'untouched:    ["odd",   spacing]    # untouched á', '---', '', 'Stable body text.', '',
].join('\n');
const fixtures = [
  ['list item', 'original', 'new-tag', 'text'],
  ['title', 'Old heading', 'New heading', 'text'],
  ['date', '2024-01-02', '2025-02-03', 'text'],
  ['unknown property', 'old setting', 'new setting', 'no-visible-change'],
  ['comment', '# old comment', '# new comment', 'no-visible-change'],
  ['key order', 'title: Old heading\ntags: [original, steady]', 'tags: [original, steady]\ntitle: Old heading', 'no-visible-change'],
  ['quoting', '"old setting"', "'old setting'", 'no-visible-change'],
];
const stamp = '2026-11-21T10:00:00Z';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
afterEach(async () => { await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function setup(options = {}) {
  return publicationFixture({ base, workspace: true, allowProperties: true, publishConfig: 'allow: []\n', ...options });
}

function span(before, from, to) {
  const start = Buffer.byteLength(before.slice(0, before.indexOf(from)));
  return { operationId: `splice:${start}`, start, end: start + Buffer.byteLength(from), expected: from, replacement: to };
}

async function derive(f, route, editedText, operations = []) {
  const workspacePublication = route === 'workspace';
  const renderer = { relativePath: f.mapping.relativePath, slug: f.mapping.slug };
  const session = await createEditSession({ config: f.config, git: f.git, renderer, workspacePublication });
  const source = Buffer.from(session.source.bytesBase64, 'base64');
  if (workspacePublication) {
    f.setSource(editedText);
    const prepared = await prepareOwnerPublication({ config: f.config, mappingId: f.mapping.id, readNote: f.readNote, session,
      workspaceBaseline: { foldedTextDigest: foldedWorkspaceDigest(source) } });
    return { session: { ...session, origin: { type: 'owner-publication', reference: prepared.reference } },
      operation: prepared.operation, candidate: Buffer.from(prepared.candidate.bytesBase64, 'base64'), source };
  }
  if (route === 'direct') {
    const { operation } = deriveOwnerDirect({ config: f.config, session, submittedAt: stamp,
      handoff: { revision: session.baseCommit, source: { path: session.relativePath, byteLength: source.length, sha256: sha(source) }, operations } });
    const owned = { ...session, origin: { type: 'owner-direct' } };
    return { session: owned, operation, candidate: applyEditorOperation(owned, operation, { allowProperties: true }), source };
  }
  const operation = deriveEditorOperation({ session, editedText, config: f.config });
  return { session, operation, candidate: applyEditorOperation(session, operation, { allowProperties: true }), source };
}

// Synthetic rendering deliberately formats the three visible values instead of
// echoing exact YAML bytes, and deliberately hides other properties and comments.
async function render({ contentDir, outputDir, targetPage }) {
  const text = await readFile(path.join(contentDir, 'Notes/Page.md'), 'utf8');
  const { data } = parseFrontmatter(text);
  const end = findFrontmatterInText(text).textRange?.end ?? 0;
  const body = text.slice(end).replace(/<!--[^]*?-->/gu, '').trim();
  const date = data.date instanceof Date ? data.date.toISOString().slice(0, 10).split('-').reverse().join('/') : data.date;
  const file = path.join(outputDir, targetPage);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `<html><body><h1>${data.title}</h1><p>${data.tags?.map((tag) => tag.toUpperCase()).join(' ')}</p><p>${date}</p><p>${body}</p></body></html>`);
}

function check(f, { session, operation, source, candidate }) {
  return runPreApplyChecks({ config: f.config, session, operation, baseBytes: source, candidateBytes: candidate, renderer: render });
}

async function expectUnchanged(f, text = base) {
  expect(await readFile(path.join(f.root, f.mapping.relativePath))).toEqual(Buffer.from(text));
}

for (const route of ['raw', 'direct', 'workspace']) {
  test(`${route}: property opt-in off keeps the existing refusal`, async () => {
    const f = await setup({ allowProperties: false });
    const operation = span(base, 'old setting', 'new setting');
    await expect(derive(f, route, base.replace(operation.expected, operation.replacement), [operation])).rejects.toHaveProperty('code', 'frontmatter-edit-rejected');
    await expectUnchanged(f);
  });

  test(`${route}: seven opted-in property changes stay exact and pass real effect checks`, async () => {
    const f = await setup();
    for (const [name, from, to, kind] of fixtures) {
      const edited = base.replace(from, to);
      const { source, candidate, operation, session } = await derive(f, route, edited, [span(base, from, to)]);
      expect(candidate.toString('utf8'), name).toBe(edited);
      const applied = operation.operationType === 'change-set' ? operation.proposal.changeSet.files[0].operations[0] : operation;
      const replacementLength = applied.replacement === undefined
        ? Buffer.from(applied.replacementBytesBase64, 'base64').length : Buffer.byteLength(applied.replacement);
      expect(candidate.subarray(0, applied.start), name).toEqual(source.subarray(0, applied.start));
      expect(candidate.subarray(applied.start + replacementLength), name).toEqual(source.subarray(applied.end));
      const checks = await check(f, { session, operation, source, candidate });
      expect(checks.publication).toMatchObject({ selectedSetUnchanged: true, addressMapUnchanged: true });
      expect(checks.rendered.witnesses.kind ?? 'text', name).toBe(kind);
      if (kind === 'text') expect(checks.rendered.witnesses).toHaveProperty('new');
      else expect(checks.rendered.witnesses).toMatchObject({ stable: expect.stringContaining('Stable body text.'), digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) });
    }
    await expectUnchanged(f);
  });
}

test('computed checks reject public or private transitions and address changes, not the property guard', async () => {
  const f = await setup();
  const privateBase = base.replace('cb-publish: true', 'cb-publish: false');
  for (const [fixture, candidate, code] of [
    [f, privateBase, 'source-not-published'],
    [await setup({ base: privateBase }), base, 'source-not-published'],
    [f, base.replace('slug: Notes/page', 'slug: Notes/moved'), 'address-map-changed'],
  ]) {
    const derived = await derive(fixture, 'raw', candidate);
    await expect(check(fixture, derived)).rejects.toHaveProperty('code', code);
    await expectUnchanged(fixture, derived.source.toString('utf8'));
  }
});

test('malformed, missing, duplicated and fence-like property blocks are not applicable', async () => {
  const body = 'Stable body text.\n';
  const unclosed = base.replace('\n---\n\n', '\n\n');
  const fenceLike = base.replace('\n---\n\n', '\n...\n\n');
  const broken = base.replace('[original, steady]', '[original');
  const f = await setup();
  for (const edited of [body, unclosed, fenceLike, broken, base.replace('title: Old heading', 'title: Old heading\ntitle: Duplicate'),
    base.replace('\n\nStable body text.', '\n\n---\nextra: duplicate block\n---\n\nStable body text.'), '---\n[]\n---\nStable body text.\n']) {
    await expect(derive(f, 'raw', edited)).rejects.toHaveProperty('code', 'frontmatter-edit-rejected');
    await expectUnchanged(f);
  }
  for (const before of [body, fenceLike, broken]) {
    const other = await setup({ base: before });
    await expect(derive(other, 'raw', base)).rejects.toHaveProperty('code', 'frontmatter-edit-rejected');
    await expectUnchanged(other, before);
  }
});

test('combined property/body change set uses a text witness; an invisible body edit is refused', async () => {
  const f = await setup();
  const property = span(base, 'old setting', 'new setting');
  const body = span(base, 'Stable body text.', 'New visible passage.');
  const edited = base.replace(property.expected, property.replacement).replace(body.expected, body.replacement);
  const combined = await derive(f, 'direct', edited, [property, body]);
  expect(combined.candidate.toString('utf8')).toBe(edited);
  expect((await check(f, combined)).rendered.witnesses).toMatchObject({ old: expect.any(String), new: expect.any(String) });
  const bodyOnly = await derive(f, 'raw', base.replace(body.expected, body.replacement));
  expect((await check(f, bodyOnly)).rendered.witnesses.kind ?? 'text').toBe('text');
  const hidden = base.replace('Stable body text.', 'Stable body text. <!-- old comment -->');
  const other = await setup({ base: hidden });
  await expect(check(other, await derive(other, 'raw', hidden.replace('<!-- old comment -->', '<!-- new comment -->'))))
    .rejects.toHaveProperty('code', 'rendered-operation-witness-missing');
  await expectUnchanged(f);
  await expectUnchanged(other, hidden);
});

test('visitor, Forgejo, and signed-submitter property proposals remain unapplicable', async () => {
  const f = await setup();
  const { session, source: baseBytes } = await derive(f, 'raw', base.replace('old setting', 'new setting'));
  const edited = base.replace('old setting', 'new setting');
  const correction = deriveContiguousCorrection(baseBytes, edited);
  const digest = correction.baseDigest;
  const source = { repository: f.config.repository.remote.url, path: session.relativePath, revision: session.baseCommit };
  const proposal = createChangeSetProposal(baseBytes, { proposalId: 'synthetic', source, operations: [span(base, 'old setting', 'new setting')],
    submission: { submittedAt: stamp, rationale: 'Synthetic proposal.', evidence: [], identityClaim: null } });
  for (const lane of ['lane-b', 'lane-a', 'lane-signed']) {
    const multi = lane === 'lane-signed';
    const input = { schemaVersion: multi ? 2 : 1, artifactType: 'owner-alpha-approved-proposal-input',
      queueId: 'Q-00000000-0000-4000-8000-000000000001', preparedAt: stamp,
      decision: { digest, decidedAt: stamp, reviewEvidenceDigest: digest, authority: { type: 'owner-alpha-local', identity: f.config.owner.identity } },
      proposal: { proposalId: 'synthetic', proposalDigest: multi ? reviewProposalDigest(proposal) : digest, lane, tier: 'unknown', route: 'queue' },
      source: { ...source, branch: 'main', branchTip: session.baseCommit, gitMode: session.source.gitMode, gitObjectId: session.source.gitObjectId,
        baseByteLength: baseBytes.length, baseDigest: digest },
      operation: multi ? { type: 'change-set', proposal } : { type: 'offset', start: correction.start, end: correction.end,
        expectedOldBytesBase64: correction.expectedOldBytes.toString('base64'), replacementBytesBase64: correction.replacementBytes.toString('base64') },
      candidate: { byteLength: correction.candidateByteLength, digest: correction.candidateDigest },
      trustPolicy: { status: 'missing', digest: null }, applicationGate: { state: 'not-authorized', event: null, note: 'Fixture' },
      effectBoundary: { appliesSource: false, writesSource: false, commits: false, pushes: false, deploys: false, publishes: false, rebuilds: false } };
    expect(deriveProposalApplication({ config: f.config, input, baseBytes, branchTip: session.baseCommit, slug: session.slug }))
      .toMatchObject({ applicable: false, reason: 'frontmatter-change' });
  }
});

test('property opt-in is strictly boolean and leaves the absent revision unchanged', async () => {
  const config = JSON.parse(await readFile(new URL('../owner-alpha.example.json', import.meta.url), 'utf8'));
  const previous = 'sha256:e740f0cf94abb24d230a56b7290a808ddad81d7836d8a5eefaa7aee3d83a2c22';
  expect(computePolicyRevision(config)).toBe(previous);
  config.owner.allowProperties = false;
  expect(computePolicyRevision(config)).toBe(previous);
  config.owner.allowProperties = true;
  expect(computePolicyRevision(config)).not.toBe(previous);
  config.owner.allowProperties = 'true';
  expect(() => validateOwnerAlphaConfig(config)).toThrow(expect.objectContaining({ code: 'invalid-config' }));
});

test('workspace property edit preserves CRLF on every line', async () => {
  const crlf = base.replaceAll('\n', '\r\n');
  const f = await setup({ base: crlf });
  const { candidate, session, operation } = await derive(f, 'workspace', base.replace('old setting', 'new setting'));
  expect(candidate.toString('utf8')).toBe(crlf.replace('old setting', 'new setting'));
  expect(applyEditorOperation(session, operation, { allowProperties: true })).toEqual(candidate);
  await expectUnchanged(f, crlf);
});
