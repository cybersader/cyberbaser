// Site model version 2 (Cyberchief, 2026-11-24): readable names. Files and
// folders are named like their titles; web addresses come from the path by
// the vault's address style (.cyberbaser/site.yml), never stored.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { applyPlan, folderOptions, nameFromTitle, planNewNote, readableName } from '../src/core/new-note.js';
import { notePublicStatus } from '../src/core/new-page.js';
import { creatableTypes, firstPublishFields, namePlaceholder, parseSiteModel, typeNamed } from '../src/core/site-model.js';

const parsed = parseSiteModel(readFileSync(new URL('./fixtures/cyberchief-model-v2.yml', import.meta.url), 'utf8'));
const { model } = parsed;
const LH = 'lowercase-hyphen';
const SITE_YML = 'site:\n  title: Cyberchief\n  addresses: lowercase-hyphen\nappearance:\n  colorScheme: dark\n';
const PUBLISH_YML = 'allow:\n  - "Leadership & strategy/**"\n  - "Threats & response/**"\n  - "Knowledge base/**"\n  - "Authors/**"\n';
const PATHS = [
  'index.md', 'About.md', 'publish.yml', 'Authors/The Chief.md', 'Authors/The Chief/avatar.png',
  'Leadership & strategy/index.md', 'Leadership & strategy/Writing a one-page security strategy.md',
  'Threats & response/index.md', 'From the field/index.md',
  'Knowledge base/index.md', 'Knowledge base/Glossary.md', 'Knowledge base/Risk & governance/index.md',
  'Knowledge base/Risk & governance/Frameworks/index.md', 'Knowledge base/Risk & governance/Frameworks/NIST CSF 2.0 at a glance.md',
  'inbox/IMG_2041.jpg',
];
const TITLES = { 'Leadership & strategy/index.md': 'Security leadership & strategy', 'Knowledge base/index.md': 'Knowledge base',
  'Knowledge base/Risk & governance/index.md': 'Risk & governance', 'Threats & response/index.md': 'Threats & incident response' };
const titleOf = (path) => TITLES[path] ?? null;

function memoryVault() {
  const files = new Map(PATHS.map((path) => [path, /\.(png|jpg)$/u.test(path) ? new Uint8Array([7, 7, 7]) : '']));
  const folders = new Set();
  return { files, folders, io: {
    createFolder: async (path) => { folders.add(path); },
    writeText: async (path, text) => { if (files.has(path)) throw new Error('exists'); files.set(path, text); },
    copyImage: async (source, path) => { files.set(path, source.bytes ?? files.get(source.vaultPath)); },
  } };
}

test('the version 2 model parses: names block, <name> locations, Knowledge base root', () => {
  expect(parsed.errors).toBeUndefined();
  expect(model.version).toBe(2);
  expect(model.names).toMatchObject({ rule: 'title-minus-unsafe', unsafe: ':/\\?*"<>|', address: LH });
  expect(model.site.defaultAuthor).toBe('Authors/The Chief.md');
  expect(creatableTypes(model).map((type) => type.name)).toEqual(['post', 'topic', 'kb-page', 'author']);
  expect(namePlaceholder(typeNamed(model, 'post'))).toBe('name');
  expect(typeNamed(model, 'kb-page').fields.find((field) => field.name === 'folder')).toMatchObject({ root: 'Knowledge base', allowRoot: true });
  expect(firstPublishFields(model, 'Threats & response/Anything.md')).toEqual(['date']);
  expect(firstPublishFields(model, 'Knowledge base/Anything.md')).toEqual([]);
});

test('readable names: the title as typed, minus what file systems refuse', () => {
  const names = model.names;
  expect(readableName('Questions to ask a new CISO', names)).toBe('Questions to ask a new CISO');
  expect(readableName('Risk & governance', names)).toBe('Risk & governance');
  expect(readableName('NIST CSF 2.0 at a glance', names)).toBe('NIST CSF 2.0 at a glance');
  expect(readableName('Zero trust: a direction, not a product', names)).toBe('Zero trust a direction, not a product');
  expect(readableName('Who owns "risk"? (A short answer!)', names)).toBe('Who owns risk (A short answer!)');
  expect(readableName('Before/after \\ the 90-day plan', names)).toBe('Before after the 90-day plan');
  expect(readableName('  Leading and trailing...  ', names)).toBe('Leading and trailing');
  expect(readableName('...hidden', names)).toBe('hidden');
  expect(readableName('Line one\nline two\ttab', names)).toBe('Line one line two tab');
  expect(readableName('<>:"|?*', names)).toBe('');
  expect(readableName('Café résumé', names)).toBe('Café résumé');
  expect(nameFromTitle(model, 'R&D vs. Q&A.')).toBe('R&D vs. Q&A');
});

const POST = { title: 'Questions to ask a new CISO: the first 90 days', topic: { existing: 'Leadership & strategy' },
  description: 'What a board should ask.', tags: ['audience/executives', 'strategy'],
  cover: { name: 'IMG_2041.jpg', source: { vaultPath: 'inbox/IMG_2041.jpg' } } };

test('a post: readable file name, the web address, the cover written as a property and copied beside the note', async () => {
  const vault = memoryVault();
  const plan = planNewNote({ model, typeName: 'post', values: POST, paths: PATHS, today: '2026-11-24', titleOf, addressStyle: LH });
  expect(plan.ok).toBe(true);
  expect(plan.notePath).toBe('Leadership & strategy/Questions to ask a new CISO the first 90 days.md');
  expect(plan.address).toBe('/leadership-and-strategy/questions-to-ask-a-new-ciso-the-first-90-days');
  await applyPlan(plan, vault.io);
  const cover = 'Leadership & strategy/Questions to ask a new CISO the first 90 days cover.jpg';
  expect(vault.files.get(cover)).toEqual(new Uint8Array([7, 7, 7]));
  const text = vault.files.get(plan.notePath);
  expect(text).toBe(`---
title: "Questions to ask a new CISO: the first 90 days"
description: What a board should ask.
date:
tags:
  - audience/executives
  - strategy
cover: Leadership & strategy/Questions to ask a new CISO the first 90 days cover.jpg
featured: false
author: "[[Authors/The Chief]]"
draft: true
---

`);
  // The device works out the same address from the vault's own settings, once Draft is off.
  const status = notePublicStatus({ path: plan.notePath, text: text.replace('draft: true', 'draft: false'), publishYml: PUBLISH_YML, siteYml: SITE_YML });
  expect(status).toMatchObject({ published: true, address: plan.address });
  // Without the vault's site.yml the address follows stock Quartz; an unknown style publishes nothing here.
  expect(notePublicStatus({ path: plan.notePath, text: text.replace('draft: true', 'draft: false'), publishYml: PUBLISH_YML }).address)
    .toBe('/Leadership--and--strategy/Questions-to-ask-a-new-CISO-the-first-90-days');
  expect(notePublicStatus({ path: plan.notePath, text, publishYml: PUBLISH_YML, siteYml: 'addresses: kebab\n' }))
    .toMatchObject({ published: false, draft: true, rule: 'address-style-unknown' });
});

test('the cover is written whether picked from the vault or the device', () => {
  for (const source of [{ vaultPath: 'inbox/IMG_2041.jpg' }, { file: {} }]) {
    const plan = planNewNote({ model, typeName: 'post', values: { ...POST, cover: { name: 'site-photo.png', source } }, paths: PATHS, today: '2026-11-24', titleOf });
    expect(plan.ok).toBe(true);
    expect(plan.steps.find((step) => step.kind === 'image')).toMatchObject({ path: 'Leadership & strategy/Questions to ask a new CISO the first 90 days cover.png', source });
    expect(plan.steps.at(-1).text).toContain('\ncover: Leadership & strategy/Questions to ask a new CISO the first 90 days cover.png\n');
  }
});

test('names: edited before Create, refused when taken (any case), reserved, or without an address', () => {
  const plan = (extra) => planNewNote({ model, typeName: 'post', values: { ...POST, cover: null, ...extra }, paths: PATHS, today: '2026-11-24', titleOf, addressStyle: LH });
  expect(plan({ name: 'New CISO questions' })).toMatchObject({ ok: true, notePath: 'Leadership & strategy/New CISO questions.md',
    address: '/leadership-and-strategy/new-ciso-questions' });
  expect(plan({ name: 'writing a ONE-PAGE security strategy' }).errors.name).toContain('already a note with this file name');
  expect(plan({ name: 'CON' }).errors.name).toContain('Windows keeps');
  expect(plan({ name: '🔥🚀' }).errors.name).toBe('This name has no web address. Use some letters or digits.');
  expect(plan({ name: '<>|' }).errors.name).toBe('Use some letters or digits in the file name.');
  // While answers are missing, the path and address are still worked out for the preview.
  const partial = planNewNote({ model, typeName: 'post', values: { title: 'Draft idea', topic: { existing: 'Threats & response' } }, paths: PATHS, titleOf, addressStyle: LH });
  expect(partial).toMatchObject({ ok: false, notePath: 'Threats & response/Draft idea.md', address: '/threats-and-response/draft-idea' });
});

test('knowledge base: the top level first, readable folder names, and new folders', async () => {
  const field = typeNamed(model, 'kb-page').fields.find((candidate) => candidate.name === 'folder');
  const options = folderOptions(model, field, PATHS, titleOf);
  expect(options.map((option) => [option.value, option.label])).toEqual([
    ['', 'Knowledge base (top level)'], ['Risk & governance', 'Risk & governance'], ['Risk & governance/Frameworks', 'Risk & governance › Frameworks']]);
  const top = planNewNote({ model, typeName: 'kb-page', values: { title: 'Incident glossary', description: 'Words.', folder: { existing: '' } },
    paths: PATHS, titleOf, addressStyle: LH });
  expect(top).toMatchObject({ ok: true, notePath: 'Knowledge base/Incident glossary.md', address: '/knowledge-base/incident-glossary' });
  const vault = memoryVault();
  const nested = planNewNote({ model, typeName: 'kb-page', paths: PATHS, titleOf, addressStyle: LH,
    values: { title: 'Tabletop basics', description: 'd', folder: { new: { parent: 'Risk & governance', values: { title: 'Exercises & drills', description: 'd' } } } } });
  expect(nested.steps.map((step) => step.path)).toEqual(['Knowledge base/Risk & governance/Exercises & drills',
    'Knowledge base/Risk & governance/Exercises & drills/index.md', 'Knowledge base/Risk & governance/Exercises & drills/Tabletop basics.md']);
  expect(nested.address).toBe('/knowledge-base/risk-and-governance/exercises-and-drills/tabletop-basics');
  await applyPlan(nested, vault.io);
  expect(vault.files.get('Knowledge base/Risk & governance/Exercises & drills/index.md')).toBe('---\ntitle: Exercises & drills\ndescription: d\n---\n');
  // Another case of an existing folder is the same folder.
  const again = planNewNote({ model, typeName: 'kb-page', paths: PATHS, titleOf, addressStyle: LH,
    values: { title: 'X', description: 'd', folder: { new: { parent: 'Risk & governance', values: { title: 'frameworks', description: 'd' } } } } });
  expect(again.errors['folder.new.title']).toContain('already there');
  // Topics: the folder is named by the topic's title; Knowledge base and Authors are not topics.
  expect(planNewNote({ model, typeName: 'topic', values: { title: 'Policy & law', description: 'Rules.' }, paths: PATHS, titleOf, addressStyle: LH }))
    .toMatchObject({ ok: true, notePath: 'Policy & law/index.md', address: '/policy-and-law' });
  expect(planNewNote({ model, typeName: 'topic', values: { title: 'Knowledge base', description: 'x' }, paths: PATHS, titleOf }).ok).toBe(false);
});
