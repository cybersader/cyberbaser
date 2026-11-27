import { expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deriveContiguousCorrection } from '../../../packages/correction/src/index.js';
import { selectFiles } from '../../../packages/publish/src/select.js';
import { markdownBlocks } from '../../../packages/review-projection/src/markdown-projection.js';
import { classify } from '../../../packages/trust/src/classify.js';
import { applyEditorOperation, deriveEditorOperation } from '../src/operation.js';
import { assertFoldedWorkspaceNote } from '../src/owner-publication.js';
import { deriveProposalApplication } from '../src/proposal-application.js';
import { createEditSession, detectYamlFrontmatterRange } from '../src/source.js';

const relativePath = 'Fixture.md';
const slug = 'fixture';
const renderer = { relativePath, slug };
const publishConfig = { allow: [] };
const owner = 'example';
const trustPolicy = { trusted: [owner] };
const head = 'a'.repeat(40);
const objectId = 'b'.repeat(40);
const configTemplate = new URL('../owner-alpha.example.json', import.meta.url);

function fixtureText(opener, eol = '\n') {
  const before = opener + ['cb-publish: true', `slug: ${slug}`, '---', '', 'Synthetic note.', ''].join(eol);
  return { before, after: before.replace('cb-publish: true', 'cb-publish: false') };
}

async function withFixture(before, run) {
  const checkout = await mkdtemp(path.join(await realpath(os.tmpdir()), 'frontmatter-agreement-'));
  try {
    const config = JSON.parse(await readFile(configTemplate, 'utf8'));
    config.repository.checkout = checkout;
    config.repository.remote.url = 'https://github.com/example/fixture.git';
    config.workflow.repository = 'example/fixture';
    config.live.baseUrl = 'https://example.github.io/fixture/';
    config.owner.identity = owner;
    config.ownerPublication = { enabled: true, mappings: [{
      id: 'fixture', source: { kind: 'workspace', identity: 'fixture', path: relativePath }, relativePath, slug,
    }] };
    // Only Git inspection responses are stubbed; the session reads a real local file.
    const gitOutputs = new Map([
      ['rev-parse --show-toplevel', checkout],
      ['remote get-url origin', config.repository.remote.url],
      ['remote get-url --push origin', config.repository.remote.url],
      ['symbolic-ref --quiet --short HEAD', 'main'],
      ['rev-parse HEAD', head],
      ['ls-remote --refs origin refs/heads/main', `${head}\trefs/heads/main`],
      ['status --porcelain=v1 --untracked-files=all', ''],
      [`ls-files --stage -z -- ${relativePath}`, `100644 ${objectId} 0\t${relativePath}\0`],
    ]);
    const git = async (_checkout, args) => {
      const key = args.join(' ');
      if (!gitOutputs.has(key)) throw new Error(`Unexpected fixture Git command: ${key}`);
      return gitOutputs.get(key);
    };
    await writeFile(path.join(checkout, relativePath), before);
    await run({ config, sessionFor: (options = {}) => createEditSession({ config, renderer, git, ...options }) });
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
}

function expectFinders({ before, after }, kind) {
  for (const [text, selected] of [[before, kind === 'frontmatter'], [after, false]]) {
    const result = selectFiles({ [relativePath]: text }, publishConfig);
    expect(result.errors).toEqual([]);
    expect(result.published).toEqual(selected ? [relativePath] : []);
    if (selected) expect(result.report.slugs[relativePath]).toBe(slug);
    const protectedRange = detectYamlFrontmatterRange(Buffer.from(text));
    expect(protectedRange !== null).toBe(kind !== 'none');
    const review = markdownBlocks(text).find((block) => ['frontmatter', 'fence-like'].includes(block.kind));
    expect(review?.kind ?? 'none').toBe(kind);
    if (kind !== 'none') expect(protectedRange.end).toBe(Buffer.byteLength(text.slice(0, review.end)));
    if (kind === 'fence-like') {
      expect(review.entries).toBeUndefined();
      expect(review.uninterpreted).toContain('fence-like text');
    }
  }
  const result = classify({ author: owner, authorType: 'human', files: [{ path: relativePath, before, after }] }, trustPolicy);
  expect(result.checks.frontmatter.changed).toEqual(kind === 'frontmatter' ? ['cb-publish'] : []);
  expect(result.checks.frontmatter.unparseable).toBe(kind === 'fence-like');
}

function expectPropertyRefusal(input, frontmatterKind = 'properties') {
  expect(() => deriveEditorOperation(input)).toThrow(expect.objectContaining({
    code: 'frontmatter-edit-rejected', details: { frontmatterKind },
  }));
}

function expectProposalRefusal(config, { before, after }, frontmatterKind) {
  const baseBytes = Buffer.from(before);
  const correction = deriveContiguousCorrection(baseBytes, after);
  const stamp = '2026-11-21T10:00:00Z';
  const digest = correction.baseDigest;
  const input = { schemaVersion: 1, artifactType: 'owner-alpha-approved-proposal-input',
    queueId: 'Q-00000000-0000-4000-8000-000000000001', preparedAt: stamp,
    decision: { digest, decidedAt: stamp, reviewEvidenceDigest: digest, authority: { type: 'owner-alpha-local', identity: owner } },
    proposal: { proposalId: 'synthetic', proposalDigest: digest, lane: 'B', tier: 'unknown', route: 'queue' },
    source: { repository: config.repository.remote.url, path: relativePath, revision: head, branch: 'main', branchTip: head,
      gitMode: '100644', gitObjectId: objectId, baseByteLength: baseBytes.length, baseDigest: digest },
    operation: { type: 'offset', start: correction.start, end: correction.end,
      expectedOldBytesBase64: correction.expectedOldBytes.toString('base64'), replacementBytesBase64: correction.replacementBytes.toString('base64') },
    candidate: { byteLength: correction.candidateByteLength, digest: correction.candidateDigest },
    trustPolicy: { status: 'missing', digest: null }, applicationGate: { state: 'not-authorized', event: null, note: 'Fixture' },
    effectBoundary: { appliesSource: false, writesSource: false, commits: false, pushes: false, deploys: false, publishes: false, rebuilds: false } };
  expect(deriveProposalApplication({ config, input, baseBytes, branchTip: head, slug })).toMatchObject({
    applicable: false, reason: 'frontmatter-change', details: { frontmatterKind },
  });
}

for (const [label, opener] of [['plain LF', '---\n'], ['trailing space', '--- \n'], ['trailing tab', '---\t\n']]) {
  test(`${label}: every reader sees properties; owner guards allow only by opt-in and proposal guards still refuse`, async () => {
    const note = fixtureText(opener);
    expectFinders(note, 'frontmatter');
    await withFixture(note.before, async ({ config, sessionFor }) => {
      for (const workspacePublication of [false, true]) {
        expectPropertyRefusal({ session: await sessionFor({ workspacePublication }), editedText: note.after, config, workspacePublication });
      }
      config.owner.allowProperties = true;
      for (const workspacePublication of [false, true]) {
        const session = await sessionFor({ workspacePublication });
        const operation = deriveEditorOperation({ session, editedText: note.after, config, workspacePublication });
        expect(applyEditorOperation(session, operation, { workspacePublication, allowProperties: true })).toEqual(Buffer.from(note.after));
      }
      expectProposalRefusal(config, note, 'properties');
    });
  });
}

test('BOM: every reader sees properties; browser exact-byte binding still refuses, workspace guards the properties', async () => {
  const note = fixtureText(String.fromCodePoint(0xfeff) + '---\n');
  expectFinders(note, 'frontmatter');
  await withFixture(note.before, async ({ config, sessionFor }) => {
    const session = await sessionFor();
    expect(session.source.text).toBe(note.before.slice(1));
    expect(Buffer.from(session.source.bytesBase64, 'base64')).toEqual(Buffer.from(note.before));
    expect(() => deriveEditorOperation({ session, editedText: note.after.slice(1), config }))
      .toThrow(expect.objectContaining({ code: 'edit-session-source-mismatch' }));
    const workspacePublication = true;
    expectPropertyRefusal({ session: await sessionFor({ workspacePublication }), editedText: note.after, config, workspacePublication });
  });
});

test('CRLF: every reader sees properties; browser still refuses the source, workspace guards the properties', async () => {
  const note = fixtureText('---\r\n', '\r\n');
  expectFinders(note, 'frontmatter');
  await withFixture(note.before, async ({ config, sessionFor }) => {
    await expect(sessionFor()).rejects.toMatchObject({ code: 'source-not-lf-only' });
    const workspacePublication = true;
    expectPropertyRefusal({ session: await sessionFor({ workspacePublication }), editedText: note.after, config, workspacePublication });
  });
});

test('leading blank line: no reader sees properties and owner edit allows changing body text', async () => {
  const note = fixtureText('\n---\n');
  expectFinders(note, 'none');
  await withFixture(note.before, async ({ config, sessionFor }) => {
    const session = await sessionFor();
    const operation = deriveEditorOperation({ session, editedText: note.after, config });
    expect(applyEditorOperation(session, operation)).toEqual(Buffer.from(note.after));
  });
});

for (const [label, before, after] of [
  ['immediately closed', '---\n---\nBody.\n', '---\n--- \nBody.\n'],
  ['alternate close', '---\ncb-publish: true\n...\nBody.\n', '---\ncb-publish: false\n...\nBody.\n'],
  ['unclosed', '---\ncb-publish: true\nBody.\n', '---\ncb-publish: false\nBody.\n'],
]) {
  test(`${label}: fence-like text is not parsed or selected, but every edit guard protects it`, async () => {
    const note = { before, after };
    expectFinders(note, 'fence-like');
    await withFixture(before, async ({ config, sessionFor }) => {
      for (const workspacePublication of [false, true]) {
        expectPropertyRefusal({ session: await sessionFor({ workspacePublication }), editedText: after, config, workspacePublication }, 'fence-like');
      }
      expectProposalRefusal(config, note, 'fence-like');
    });
    if (label === 'unclosed') expect(() => assertFoldedWorkspaceNote(before, after))
      .toThrow(expect.objectContaining({ code: 'workspace-properties-invalid' }));
  });
}

test('browser, workspace and proposal guards refuse replacing a leading unclosed fence with a thematic rule', async () => {
  const note = { before: '---\n', after: '***\n' };
  await withFixture(note.before, async ({ config, sessionFor }) => {
    for (const workspacePublication of [false, true]) {
      expectPropertyRefusal({ session: await sessionFor({ workspacePublication }), editedText: note.after, config, workspacePublication }, 'fence-like');
    }
    expectProposalRefusal(config, note, 'fence-like');
  });
});

test('a padded canonical closer does not narrow the old explicit owner protection range', async () => {
  const metadata = '---\ncb-publish: true\nslug: fixture\n--- \n';
  const before = metadata + 'Legacy guard interval.\n---\nBody.\n';
  expect(markdownBlocks(before)[0].end).toBe(metadata.length);
  await withFixture(before, async ({ config, sessionFor }) => {
    const session = await sessionFor();
    expectPropertyRefusal({ session, editedText: before.replace('Legacy', 'Old'), config });
    const editedText = before.replace('Body.', 'Body edit.');
    expect(applyEditorOperation(session, deriveEditorOperation({ session, editedText, config })).toString('utf8')).toBe(editedText);
  });
});
