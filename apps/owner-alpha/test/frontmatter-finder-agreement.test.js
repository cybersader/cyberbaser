import { expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { selectFiles } from '../../../packages/publish/src/select.js';
import { classify } from '../../../packages/trust/src/classify.js';
import { runPreApplyChecks } from '../src/checks.js';
import { applyEditorOperation, deriveEditorOperation } from '../src/operation.js';
import { createEditSession, detectYamlFrontmatterRange } from '../src/source.js';

const relativePath = 'Fixture.md';
const slug = 'fixture';
const renderer = { relativePath, slug };
const publishConfig = { allow: [] };
const owner = 'example';
const trustPolicy = { trusted: [owner] };
const head = 'a'.repeat(40);
const configTemplate = new URL('../owner-alpha.example.json', import.meta.url);

function fixtureText(opener, eol = '\n') {
  const before = opener + [`cb-publish: true`, `slug: ${slug}`, '---', '', 'Synthetic note.', ''].join(eol);
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
      [`ls-files --stage -z -- ${relativePath}`, `100644 ${'b'.repeat(40)} 0\t${relativePath}\0`],
    ]);
    const git = async (_checkout, args) => {
      const key = args.join(' ');
      if (!gitOutputs.has(key)) throw new Error(`Unexpected fixture Git command: ${key}`);
      return gitOutputs.get(key);
    };
    const writeSource = (text) => writeFile(path.join(checkout, relativePath), text);
    await writeFile(path.join(checkout, 'publish.yml'), 'allow: []\n');
    await writeSource(before);
    await run({ config, writeSource, sessionFor: (options = {}) => createEditSession({ config, renderer, git, ...options }) });
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
}

function expectFinders({ before, after }, { select, browser, workspace, trust }) {
  for (const [text, selected] of [[before, select], [after, false]]) {
    const result = selectFiles({ [relativePath]: text }, publishConfig);
    expect(result.errors).toEqual([]);
    expect(result.published).toEqual(selected ? [relativePath] : []);
    if (selected) expect(result.report.slugs[relativePath]).toBe(slug);
    expect(detectYamlFrontmatterRange(Buffer.from(text)) !== null).toBe(browser);
    expect(detectYamlFrontmatterRange(Buffer.from(text), { workspacePublication: true }) !== null).toBe(workspace);
  }
  const result = classify({ author: owner, authorType: 'human', files: [{ path: relativePath, before, after }] }, trustPolicy);
  expect(result.checks.frontmatter.changed).toEqual(trust ? ['cb-publish'] : []);
}

function expectDeriveRefusal(input, code) {
  let actual;
  try { deriveEditorOperation(input); } catch (error) { actual = error; }
  expect(actual).toMatchObject({ code });
}

test('plain LF note: selector honors cb-publish and the owner-edit guard refuses changing it', async () => {
  const note = fixtureText('---\n');
  expectFinders(note, { select: true, browser: true, workspace: true, trust: true });
  await withFixture(note.before, async ({ config, sessionFor }) => {
    expectDeriveRefusal({ session: await sessionFor(), editedText: note.after, config }, 'frontmatter-edit-rejected');
  });
});

test('BOM-prefixed note: selector honors cb-publish; browser edit fails exact-byte binding, workspace edit refuses frontmatter', async () => {
  const note = fixtureText(String.fromCodePoint(0xfeff) + '---\n');
  // KNOWN GAP: the browser finder misses the block, but the real session cannot pass exact-byte binding.
  expectFinders(note, { select: true, browser: false, workspace: true, trust: false });
  await withFixture(note.before, async ({ config, sessionFor }) => {
    const session = await sessionFor();
    expect(session.source.text).toBe(note.before.slice(1));
    expect(Buffer.from(session.source.bytesBase64, 'base64')).toEqual(Buffer.from(note.before));
    expectDeriveRefusal({ session, editedText: note.after.slice(1), config }, 'edit-session-source-mismatch');
    const workspacePublication = true;
    expectDeriveRefusal({ session: await sessionFor({ workspacePublication }), editedText: note.after, config, workspacePublication }, 'frontmatter-edit-rejected');
  });
});

for (const [label, suffix] of [['trailing space', ' '], ['trailing tab', '\t']]) {
  test(`${label} after opening fence: selector honors cb-publish, owner edit accepts changing it, publication checks refuse the flip`, async () => {
    const note = fixtureText(`---${suffix}\n`);
    // KNOWN GAP: neither owner frontmatter finder nor trust sees the selector's properties block.
    expectFinders(note, { select: true, browser: false, workspace: false, trust: false });
    await withFixture(note.before, async ({ config, writeSource, sessionFor }) => {
      for (const [base, editedText] of [[note.before, note.after], [note.after, note.before]]) {
        await writeSource(base);
        const session = await sessionFor();
        const operation = deriveEditorOperation({ session, editedText, config });
        const candidateBytes = applyEditorOperation(session, operation);
        expect(candidateBytes).toEqual(Buffer.from(editedText));
        await expect(runPreApplyChecks({
          session, operation, candidateBytes, config, trustPolicy,
          renderer: () => { throw new Error('Publication flip should be refused before rendering'); },
        })).rejects.toMatchObject({ code: 'source-not-published' });
      }
      const workspacePublication = true;
      const session = await sessionFor({ workspacePublication });
      const operation = deriveEditorOperation({ session, editedText: note.before, config, workspacePublication });
      expect(applyEditorOperation(session, operation, { workspacePublication })).toEqual(Buffer.from(note.before));
    });
  });
}

test('CRLF note: selector honors cb-publish; browser refuses the source and workspace edit refuses frontmatter', async () => {
  const note = fixtureText('---\r\n', '\r\n');
  // KNOWN GAP: the browser finder misses CRLF on raw bytes; browser session creation refuses earlier.
  expectFinders(note, { select: true, browser: false, workspace: true, trust: true });
  await withFixture(note.before, async ({ config, sessionFor }) => {
    await expect(sessionFor()).rejects.toMatchObject({ code: 'source-not-lf-only' });
    const workspacePublication = true;
    expectDeriveRefusal({ session: await sessionFor({ workspacePublication }), editedText: note.after, config, workspacePublication }, 'frontmatter-edit-rejected');
  });
});

test('leading blank line: no finder recognizes frontmatter and cb-publish does not affect selection', async () => {
  const note = fixtureText('\n---\n');
  expectFinders(note, { select: false, browser: false, workspace: false, trust: false });
  await withFixture(note.before, async ({ config, sessionFor }) => {
    const session = await sessionFor();
    const operation = deriveEditorOperation({ session, editedText: note.after, config });
    expect(applyEditorOperation(session, operation)).toEqual(Buffer.from(note.after));
  });
});
