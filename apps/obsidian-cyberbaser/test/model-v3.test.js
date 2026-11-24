// Site model version 3 (Cyberchief, 2026-11-24): folder notes. Every note
// lives in a folder of its own name ("<topic>/<name>/<name>.md"), folders
// have a same-name note instead of index.md, and images go in the note's own
// folder, written in the property by their bare file name. The fixture is the
// Cyberchief model as written (content/.cyberbaser/model.yml), copied as is.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { propertyImages } from '../../../packages/publish/src/property-refs.js';
import { renderSlugs } from '../../../packages/publish/src/addresses.js';
import { applyPlan, folderOptions, newFolderParents, planNewNote, rootLabel } from '../src/core/new-note.js';
import { firstPublishFields, folderNotePath, matchLocation, parseSiteModel, typeNamed } from '../src/core/site-model.js';

const parsed = parseSiteModel(readFileSync(new URL('./fixtures/cyberchief-model-v3.yml', import.meta.url), 'utf8'));
const { model } = parsed;
const LH = 'lowercase-hyphen';
const PATHS = [
  'index.md', 'About.md', 'publish.yml', 'Authors/The Chief/The Chief.md', 'Authors/The Chief/avatar.png',
  'Leadership & strategy/Leadership & strategy.md',
  'Leadership & strategy/Writing a strategy/Writing a strategy.md',
  'Leadership & strategy/Writing a strategy/Writing a strategy cover.jpg',
  'Threats & response/index.md', 'Empty topic/Empty topic.md',
  'Knowledge base/Knowledge base.md', 'Knowledge base/Glossary/Glossary.md',
  'Knowledge base/Risk & governance/Risk & governance.md',
  'Knowledge base/Risk & governance/Frameworks/Frameworks.md',
  'Knowledge base/Risk & governance/Frameworks/NIST CSF 2.0 at a glance/NIST CSF 2.0 at a glance.md',
  'Knowledge base/Risk & governance/Board pack/Board pack.md',
  'inbox/IMG_2041.jpg',
];
const TITLES = { 'Knowledge base/Knowledge base.md': 'Knowledge base', 'Leadership & strategy/Leadership & strategy.md': 'Security leadership & strategy' };
const titleOf = (path) => TITLES[path] ?? null;
const POST = { title: 'Questions to ask a new CISO', topic: { existing: 'Leadership & strategy' }, description: 'What to ask.',
  cover: { name: 'IMG_2041.jpg', source: { vaultPath: 'inbox/IMG_2041.jpg' } } };

test('the version 3 model parses, with folder notes and note-folder images', () => {
  expect(parsed.errors).toBeUndefined();
  expect(model.version).toBe(3);
  expect(model.names).toMatchObject({ address: LH, folderNotes: 'same-name', images: 'note-folder' });
  expect(model.taxonomy.folderNote).toBe('<folder>/<folder>.md');
  expect(typeNamed(model, 'topic').location).toMatchObject({ pattern: '<name>/<name>.md', alsoAccepted: '<name>/index.md' });
  // Values Cyberbaser does not implement fail closed.
  const other = readFileSync(new URL('./fixtures/cyberchief-model-v3.yml', import.meta.url), 'utf8').replace('images: note-folder', 'images: vault-root');
  expect(parseSiteModel(other).errors.join(' ')).toContain('"names.images" should be note-folder');
});

test('locations: the note is named like its folder; topics also as index.md', () => {
  const post = typeNamed(model, 'post').location;
  expect(matchLocation(post, 'Leadership & strategy/Writing a strategy/Writing a strategy.md')).toEqual({ topic: 'Leadership & strategy', name: 'Writing a strategy' });
  // Named like its folder as addresses: case and & vs and do not matter.
  expect(matchLocation(post, 'Topic/Risk & law/risk and law.md')).not.toBeNull();
  expect(matchLocation(post, 'Topic/Writing a strategy/Checklist.md')).toBeNull();
  expect(firstPublishFields(model, 'Knowledge base/Glossary/Glossary.md')).toEqual([]);
  const kbFolder = typeNamed(model, 'kb-folder').location;
  expect(matchLocation(kbFolder, 'Knowledge base/Risk & governance/Risk & governance.md')).toEqual({ folder: 'Risk & governance' });
  expect(matchLocation(kbFolder, 'Knowledge base/Risk & governance/Frameworks/Frameworks.md')).toEqual({ folder: 'Risk & governance/Frameworks' });
  expect(matchLocation(kbFolder, 'Knowledge base/Risk & governance/index.md')).toEqual({ folder: 'Risk & governance' });
  expect(matchLocation(kbFolder, 'Knowledge base/Knowledge base.md')).toBeNull();
  expect(folderNotePath(model, 'Knowledge base/Risk & governance')).toBe('Knowledge base/Risk & governance/Risk & governance.md');
  expect(firstPublishFields(model, 'Leadership & strategy/Writing a strategy/Writing a strategy.md')).toEqual(['date']);
  expect(firstPublishFields(model, 'Leadership & strategy/Writing a strategy.md')).toEqual([]);
});

test('folder choices: topics and KB folders, never a note\'s own folder', () => {
  const topics = folderOptions(model, typeNamed(model, 'post').fields.find((f) => f.name === 'topic'), PATHS, titleOf);
  expect(topics.map((o) => o.value)).toEqual(['Empty topic', 'Leadership & strategy', 'Threats & response']);
  expect(topics.find((o) => o.value === 'Leadership & strategy').label).toBe('Security leadership & strategy');
  const field = typeNamed(model, 'kb-page').fields.find((f) => f.name === 'folder');
  const kb = folderOptions(model, field, PATHS, titleOf);
  // The Glossary, NIST and Board pack pages are folders with only their own note: not offered.
  expect(kb.map((o) => o.value)).toEqual(['', 'Risk & governance', 'Risk & governance/Frameworks']);
  expect(kb[0].label).toBe('Knowledge base (top level)');
  expect(rootLabel(model, field, titleOf)).toBe('Knowledge base (top level)');
  expect(newFolderParents(field, kb, model, titleOf).map((o) => o.value)).toEqual(['', 'Risk & governance']);
  // The same rule as the renderer: offered folders are drawn as folder pages, the others as pages.
  const slugs = renderSlugs(PATHS, LH);
  expect(slugs.get('Knowledge base/Risk & governance/Risk & governance.md')).toBe('knowledge-base/risk-and-governance/index');
  expect(slugs.get('Knowledge base/Risk & governance/Board pack/Board pack.md')).toBe('knowledge-base/risk-and-governance/board-pack');
});

function memoryVault() {
  const files = new Map(PATHS.map((path) => [path, /\.(png|jpg)$/u.test(path) ? new Uint8Array([7]) : '']));
  const folders = new Set();
  const has = (path) => files.has(path) || folders.has(path);
  return { files, folders, io: {
    createFolder: async (path) => { folders.add(path); },
    writeText: async (path, text) => { if (files.has(path)) throw new Error('exists'); files.set(path, text); },
    replaceText: async (path, text) => { files.set(path, text); },
    remove: async (path) => { files.delete(path); },
    copyImage: async (source, path) => { if (files.has(path)) throw new Error('exists'); files.set(path, files.get(source.vaultPath)); },
    // Obsidian with attachmentFolderPath "./": beside the note, " 1" when taken.
    attachmentPath: async (filename, notePath) => {
      const folder = notePath.slice(0, notePath.lastIndexOf('/'));
      const dot = filename.lastIndexOf('.');
      let path = `${folder}/${filename}`;
      for (let n = 1; has(path); n += 1) path = `${folder}/${filename.slice(0, dot)} ${n}${filename.slice(dot)}`;
      return path;
    },
    exists: (path) => has(path),
  } };
}

test('Create: <topic>/<name>/<name>.md, its cover beside it, named by its bare file name', async () => {
  const plan = planNewNote({ model, typeName: 'post', values: POST, paths: PATHS, today: '2026-11-24', titleOf, addressStyle: LH });
  expect(plan).toMatchObject({ ok: true, notePath: 'Leadership & strategy/Questions to ask a new CISO/Questions to ask a new CISO.md',
    address: '/leadership-and-strategy/questions-to-ask-a-new-ciso' });
  const vault = memoryVault();
  await applyPlan(plan, vault.io);
  const text = vault.files.get(plan.notePath);
  expect(text).toContain('\ncover: Questions to ask a new CISO cover.jpg\n');
  expect(vault.files.get('Leadership & strategy/Questions to ask a new CISO/Questions to ask a new CISO cover.jpg')).toEqual(new Uint8Array([7]));
  // Every layer finds that cover by the same rule: the note's own folder.
  expect(propertyImages(text, (p) => vault.files.has(p), plan.notePath))
    .toEqual(['Leadership & strategy/Questions to ask a new CISO/Questions to ask a new CISO cover.jpg']);
});

test('Create: a photo name that also exists at the vault root keeps its full path', async () => {
  const vault = memoryVault();
  vault.files.set('Questions to ask a new CISO cover.jpg', new Uint8Array([1]));
  const plan = planNewNote({ model, typeName: 'post', values: POST, paths: [...vault.files.keys()], today: '2026-11-24', titleOf, addressStyle: LH });
  await applyPlan(plan, vault.io);
  expect(vault.files.get(plan.notePath)).toContain('\ncover: Leadership & strategy/Questions to ask a new CISO/Questions to ask a new CISO cover.jpg\n');
});

test('Create: a KB page in a new sub-folder makes <folder>/<folder>.md, then <folder>/<name>/<name>.md', () => {
  const plan = planNewNote({ model, typeName: 'kb-page', paths: PATHS, today: '2026-11-24', titleOf, addressStyle: LH, values: {
    title: 'Vendor reviews', description: 'd', folder: { new: { parent: 'Risk & governance', values: { title: 'Third parties', description: 'd' } } } } });
  expect(plan.ok).toBe(true);
  expect(plan.steps.map((step) => [step.kind, step.path])).toEqual([
    ['folder', 'Knowledge base/Risk & governance/Third parties'],
    ['note', 'Knowledge base/Risk & governance/Third parties/Third parties.md'],
    ['note', 'Knowledge base/Risk & governance/Third parties/Vendor reviews/Vendor reviews.md'],
  ]);
  expect(plan.address).toBe('/knowledge-base/risk-and-governance/third-parties/vendor-reviews');
  // A page whose folder exists as a note's own folder: it is not offered, so it cannot be picked.
  const picked = planNewNote({ model, typeName: 'kb-page', paths: PATHS, today: '2026-11-24', titleOf, addressStyle: LH,
    values: { title: 'X', description: 'd', folder: { existing: 'Glossary' } } });
  expect(picked.errors.folder).toBe('Pick a folder.');
  // Topic and author.
  expect(planNewNote({ model, typeName: 'topic', paths: PATHS, titleOf, addressStyle: LH, values: { title: 'Policy & law', description: 'd' } }))
    .toMatchObject({ ok: true, notePath: 'Policy & law/Policy & law.md', address: '/policy-and-law' });
  expect(planNewNote({ model, typeName: 'author', paths: PATHS, titleOf, addressStyle: LH, values: { title: 'Ada Lovelace' } }))
    .toMatchObject({ ok: true, notePath: 'Authors/Ada Lovelace/Ada Lovelace.md', address: '/authors/ada-lovelace' });
});
