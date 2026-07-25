import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { select, selectFiles, RULES } from '../src/select.js';
import { extractRefs } from '../src/links.js';

const fm = (obj, body = 'body\n') => `---\n${Object.entries(obj).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\n${body}`;

const CONFIG = { allow: ['cyber/**', 'tools/**'] };

/** The mini-vault used by most cases. Assets map to null: the selector never reads their bytes. */
function vault(extra = {}) {
  return {
    'cyber/index.md': fm({ title: 'Cyber' }, 'See [[deep-note]] and ![[shared/diagram.png]].\n'),
    'cyber/deep-note.md': fm({ title: 'Deep Note' }),
    'tools/one.md': fm({ title: 'One' }),
    'journal/2024-05.md': fm({ title: 'May' }),
    'shared/diagram.png': null,
    'shared/bank-statement.png': null,
    ...extra,
  };
}

const run = (files, config = CONFIG, opts) => selectFiles(files, config, opts);
const deniedRule = (report, p) => report.denied.find((d) => d.path === p)?.rule;

// ---------------------------------------------------------------- precedence

test('rule 3: an allowlisted folder publishes its markdown', () => {
  const { published } = run(vault());
  expect(published).toContain('cyber/index.md');
  expect(published).toContain('tools/one.md');
});

test('rule 4: anything outside the allowlist is denied by default', () => {
  const { published, report } = run(vault());
  expect(published).not.toContain('journal/2024-05.md');
  expect(deniedRule(report, 'journal/2024-05.md')).toBe(RULES.DEFAULT_DENY);
});

test('rule 1 beats rule 3: publish:false wins inside an allowlisted folder', () => {
  const files = vault({ 'cyber/incident-notes/client-acme.md': fm({ 'cb-publish': false, title: 'Acme' }) });
  const { published, report } = run(files);
  expect(published).not.toContain('cyber/incident-notes/client-acme.md');
  expect(deniedRule(report, 'cyber/incident-notes/client-acme.md')).toBe(RULES.DENY_FLAG);
});

test('rule 2: publish:true outside the allowlist with an explicit slug publishes', () => {
  const files = vault({ 'journal/one-shareable-entry.md': fm({ 'cb-publish': true, slug: 'notes/one-shareable-entry' }) });
  const { published, errors, report } = run(files);
  expect(published).toContain('journal/one-shareable-entry.md');
  expect(errors).toHaveLength(0);
  expect(report.slugs['journal/one-shareable-entry.md']).toBe('notes/one-shareable-entry');
});

test('rule 2: publish:true outside the allowlist without a slug is an error and does not publish', () => {
  const files = vault({ 'journal/leaky.md': fm({ 'cb-publish': true, title: 'Leaky' }) });
  const { published, errors, report } = run(files);
  expect(published).not.toContain('journal/leaky.md');
  expect(errors.map((e) => e.code)).toContain(RULES.MISSING_SLUG);
  expect(errors.find((e) => e.code === RULES.MISSING_SLUG).path).toBe('journal/leaky.md');
  expect(deniedRule(report, 'journal/leaky.md')).toBe(RULES.MISSING_SLUG);
});

test('rule 2: publish:true inside the allowlist needs no slug', () => {
  const files = vault({ 'cyber/extra.md': fm({ 'cb-publish': true }) });
  const { published, errors } = run(files);
  expect(published).toContain('cyber/extra.md');
  expect(errors).toHaveLength(0);
});

test('the "mostly private" shape: empty allow list plus publish:true and slug', () => {
  const files = { 'journal/a.md': fm({ title: 'A' }), 'journal/b.md': fm({ 'cb-publish': true, slug: 'b' }) };
  const { published, errors } = run(files, { allow: [] });
  expect(published).toEqual(['journal/b.md']);
  expect(errors).toHaveLength(0);
});

test('a non-boolean cb-publish value fails closed', () => {
  const files = vault({ 'journal/weird.md': `---\ncb-publish: maybe\n---\n\nbody\n` });
  const { published, errors } = run(files);
  expect(published).not.toContain('journal/weird.md');
  expect(errors.map((e) => e.code)).toContain('invalid-publish-value');
});

// R15: the real vault has 587 stale legacy `publish: true` flags (incl. daily
// notes and journals) from an earlier publishing era. Grants come only from
// the namespaced key; legacy flags act only in the deny direction.
test('R15: legacy publish:true outside the allowlist is inert noise, not a grant and not an error', () => {
  const files = vault({ 'journal/stale.md': `---\npublish: true\n---\n\nan old daily note\n` });
  const { published, errors } = run(files);
  expect(published).not.toContain('journal/stale.md');
  expect(errors).toHaveLength(0);
});

test('R15: legacy publish:false still denies an allowlisted file', () => {
  const files = vault({ 'cyber/legacy-private.md': `---\npublish: false\n---\n\nbody\n` });
  const { published, report } = run(files);
  expect(published).not.toContain('cyber/legacy-private.md');
  expect(report.denied.find((d) => d.path === 'cyber/legacy-private.md').rule).toBe('rule-1-publish-false');
});

test('R15: legacy publish:maybe garbage is ignored entirely', () => {
  const files = vault({ 'journal/garbage.md': `---\npublish: maybe\n---\n\nbody\n` });
  const { published, errors } = run(files);
  expect(published).not.toContain('journal/garbage.md');
  expect(errors).toHaveLength(0);
});

// ---------------------------------------------------------- asset reachability

test('rule 5: an asset publishes only when a published page references it', () => {
  const { published, report } = run(vault());
  expect(published).toContain('shared/diagram.png');
  expect(published).not.toContain('shared/bank-statement.png');
  expect(deniedRule(report, 'shared/bank-statement.png')).toBe(RULES.ASSET_UNREACHABLE);
  const emitted = report.assets.find((a) => a.path === 'shared/diagram.png');
  expect(emitted.referencedBy[0]).toMatchObject({ source: 'cyber/index.md', kind: 'embed' });
  expect(emitted.referencedBy[0].line).toBe(5);
});

test('rule 5: a shared-folder asset referenced by both a published and an unpublished page publishes', () => {
  const files = vault({
    'journal/2024-05.md': fm({ title: 'May' }, 'Private context around ![[shared/diagram.png]].\n'),
  });
  const { published, report } = run(files);
  expect(published).not.toContain('journal/2024-05.md');
  expect(published).toContain('shared/diagram.png');
  expect(report.assets.find((a) => a.path === 'shared/diagram.png').referencedBy.map((r) => r.source)).toEqual(['cyber/index.md']);
});

test('rule 5: an asset referenced only by an unpublished page stays private', () => {
  const files = vault({
    'cyber/index.md': fm({ title: 'Cyber' }, 'No asset refs here.\n'),
    'journal/2024-05.md': fm({ title: 'May' }, 'Only I see ![[shared/bank-statement.png]].\n'),
  });
  const { published } = run(files);
  expect(published).not.toContain('shared/bank-statement.png');
  expect(published).not.toContain('shared/diagram.png');
});

test('rule 5: markdown image and plain markdown link both reach an asset', () => {
  const files = vault({
    'cyber/index.md': fm({ title: 'Cyber' }, 'Chart ![chart](../shared/diagram.png) and [the deck](/shared/bank-statement.png).\n'),
  });
  const { published } = run(files);
  expect(published).toContain('shared/diagram.png');
  expect(published).toContain('shared/bank-statement.png');
});

test('rule 5: an allowlisted path does not publish an asset by itself', () => {
  const files = { 'cyber/note.md': fm({ title: 'N' }, 'no refs\n'), 'cyber/attached.png': null };
  const { published, report } = run(files);
  expect(published).toEqual(['cyber/note.md']);
  expect(deniedRule(report, 'cyber/attached.png')).toBe(RULES.ASSET_UNREACHABLE);
});

test('a reference inside a fenced code block is not a reference', () => {
  const files = {
    'cyber/note.md': fm({ title: 'N' }, 'Example:\n\n```md\n![[shared/diagram.png]]\n[[secret/plans]]\n```\n\nDone.\n'),
    'shared/diagram.png': null,
    'secret/plans.md': fm({ title: 'Plans' }),
  };
  const { published, report } = run(files);
  expect(published).toEqual(['cyber/note.md']);
  expect(report.strippedLinks).toHaveLength(0);
});

// ------------------------------------------------------------ boundary report

test('cross-boundary wikilinks are reported with source, target and line', () => {
  const files = vault({
    'cyber/index.md': fm({ title: 'Cyber' }, 'Line one.\nSee [[journal/2024-05|the internal write-up]] here.\n'),
  });
  const { report } = run(files);
  expect(report.strippedLinks).toHaveLength(1);
  expect(report.strippedLinks[0]).toMatchObject({
    source: 'cyber/index.md',
    target: 'journal/2024-05.md',
    line: 6,
    targetKind: 'page',
  });
});

test('a cross-boundary embed of an unpublished page is an error', () => {
  const files = vault({
    'cyber/index.md': fm({ title: 'Cyber' }, 'Inlined: ![[journal/2024-05]]\n'),
  });
  const { errors, report } = run(files);
  expect(errors.map((e) => e.code)).toContain('cross-boundary-embed');
  expect(report.crossBoundaryEmbeds[0]).toMatchObject({ source: 'cyber/index.md', target: 'journal/2024-05.md' });
});

test('the report carries counts, the resolved allowlist and every denial', () => {
  const { report } = run(vault());
  expect(report.audience).toBe('public');
  expect(report.config.allow).toEqual(['cyber/**', 'tools/**']);
  expect(report.counts.pages).toBe(3);
  expect(report.counts.assets).toBe(1);
  expect(report.denied.map((d) => d.path)).toEqual(['journal/2024-05.md', 'shared/bank-statement.png']);
  expect(report.granted).toEqual({
    'cyber/deep-note.md': RULES.ALLOWLIST,
    'cyber/index.md': RULES.ALLOWLIST,
    'tools/one.md': RULES.ALLOWLIST,
    'shared/diagram.png': RULES.ASSET_REACHABLE,
  });
  expect(JSON.parse(JSON.stringify(report))).toEqual(report); // publish-report.json is serializable
});

test('the audiences map is parsed and unions with the top-level allowlist', () => {
  const config = { allow: ['cyber/**'], audiences: { public: { allow: ['tools/**'] }, team: ['journal/**'] } };
  const { published } = run(vault(), config);
  expect(published).toContain('cyber/index.md');
  expect(published).toContain('tools/one.md');
  expect(published).not.toContain('journal/2024-05.md');
});

// ---------------------------------------------------------------- fail closed

test('a config that is not a mapping fails closed with an error', () => {
  for (const bad of [null, undefined, [], 'cyber/**', 7]) {
    const { published, errors } = selectFiles(vault(), bad, { audience: 'public' });
    expect(published).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('config-empty');
  }
});

test('an empty publish.yml fails closed even when files ask to be published', () => {
  const dir = tempVault({
    'publish.yml': '# nothing granted yet\n',
    'cyber/index.md': fm({ 'cb-publish': true, slug: 'index' }),
  });
  const { published, errors } = select(dir);
  expect(published).toEqual([]);
  expect(errors[0].code).toBe('config-empty');
});

test('a missing publish.yml fails closed', () => {
  const dir = tempVault({ 'cyber/index.md': fm({ 'cb-publish': true, slug: 'index' }) });
  const { published, errors, report } = select(dir);
  expect(published).toEqual([]);
  expect(errors[0].code).toBe('config-missing');
  expect(report.counts.errors).toBe(1);
});

test('an unparseable publish.yml fails closed', () => {
  const dir = tempVault({ 'publish.yml': 'allow:\n  - cyber/**\n : : :\n', 'cyber/a.md': fm({ title: 'A' }) });
  const { published, errors } = select(dir);
  expect(published).toEqual([]);
  expect(errors[0].code).toBe('config-unparseable');
});

// --------------------------------------------------------------- on-disk pass

function tempVault(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-publish-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

test('select() reads a vault from disk and honours the same precedence', () => {
  const dir = tempVault({
    'publish.yml': 'allow:\n  - cyber/**\n',
    'cyber/index.md': fm({ title: 'Cyber' }, 'See ![[diagram.png]].\n'),
    'cyber/private.md': fm({ 'cb-publish': false }),
    'shared/diagram.png': 'PNGBYTES',
    'shared/unused.png': 'PNGBYTES',
    'journal/2024-05.md': fm({ title: 'May' }),
    '.git/config': 'ignored',
  });
  const { published, errors } = select(dir);
  expect(errors).toHaveLength(0);
  expect(published).toEqual(['cyber/index.md', 'shared/diagram.png']);
});

test('publishing is byte-identical and the vault is never written', () => {
  const weird = Buffer.from('---\r\ntitle: CRLF\r\n---\r\n\r\nTrailing space  \r\nno newline at eof, embed ![[a b.png]]', 'utf8');
  const dir = tempVault({ 'publish.yml': 'allow: [cyber/**]\n', 'cyber/weird.md': weird, 'cyber/a b.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]) });

  const before = new Map();
  for (const rel of ['publish.yml', 'cyber/weird.md', 'cyber/a b.png']) before.set(rel, fs.readFileSync(path.join(dir, rel)));

  const { published } = select(dir);
  expect(published).toEqual(['cyber/a b.png', 'cyber/weird.md']);

  for (const [rel, bytes] of before) expect(fs.readFileSync(path.join(dir, rel)).equals(bytes)).toBe(true);
  // Every published path still resolves to its source bytes: nothing was rewritten in flight.
  for (const rel of published) expect(fs.readFileSync(path.join(dir, rel)).equals(before.get(rel))).toBe(true);
  expect(fs.readFileSync(path.join(dir, 'cyber/weird.md')).equals(weird)).toBe(true);
});

test('publish.yml itself never publishes', () => {
  const dir = tempVault({ 'publish.yml': 'allow: ["**"]\n', 'a.md': fm({ title: 'A' }) });
  const { published } = select(dir);
  expect(published).toEqual(['a.md']);
});

// ----------------------------------------------------------------- extractRefs

test('extractRefs handles aliases, headings, embed sizes and markdown forms', () => {
  const src = [
    'Alias [[target|alias]] and heading [[target#heading]] and block [[t#^abc]].',
    'Embed ![[asset.png]] sized ![[asset.png|200x100]].',
    'Link [text](path/one.md) image ![alt](img/two.png "t").',
    '',
    '```',
    'not a ref [[nope]] ![[nope.png]]',
    '```',
    'inline `[[also-nope]]` done.',
  ].join('\n');
  const r = extractRefs(src);
  expect(r.wikilinks.map((w) => w.target)).toEqual(['target', 'target', 't']);
  expect(r.wikilinks[0].alias).toBe('alias');
  expect(r.wikilinks[1].heading).toBe('heading');
  expect(r.wikilinks[2].block).toBe('abc');
  expect(r.embeds.map((e) => e.target)).toEqual(['asset.png', 'asset.png']);
  expect(r.embeds[1].params).toEqual(['200x100']);
  expect(r.mdLinks.map((l) => l.target)).toEqual(['path/one.md']);
  expect(r.mdImages.map((i) => i.target)).toEqual(['img/two.png']);
  expect(r.embeds[0].line).toBe(2);
});
