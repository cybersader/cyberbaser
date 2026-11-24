import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { findFrontmatterInText } from '../../../packages/correction/src/frontmatter.js';
import { applyPlan, fileSlug, folderOptions, frontmatterText, newFolderParents, normalizeTag, planNewNote, tagSuggestions } from '../src/core/new-note.js';
import { parseSiteModel, typeNamed } from '../src/core/site-model.js';
import { notePublicStatus } from '../src/core/new-page.js';

const { model } = parseSiteModel(readFileSync(new URL('./fixtures/cyberchief-model.yml', import.meta.url), 'utf8'));
const PATHS = [
  'index.md', 'about.md', 'publish.yml', 'authors/the-chief.md', 'authors/the-chief/avatar.png',
  'leadership-and-strategy/index.md', 'leadership-and-strategy/a-security-strategy-that-fits-on-one-page.md',
  'risk-and-governance/index.md', 'from-the-field/index.md',
  'kb/index.md', 'kb/glossary.md', 'kb/risk-and-governance/index.md', 'kb/risk-and-governance/frameworks/index.md',
  'kb/risk-and-governance/frameworks/nist-csf-2-at-a-glance.md', 'kb/threats-and-response/index.md',
];
const TITLES = { 'leadership-and-strategy/index.md': 'Leadership & strategy', 'kb/risk-and-governance/index.md': 'Risk & governance',
  'kb/risk-and-governance/frameworks/index.md': 'Frameworks' };
const titleOf = (path) => TITLES[path] ?? null;
const PUBLISH_YML = 'allow:\n  - "leadership-and-strategy/**"\n  - "kb/**"\n  - "authors/**"\n';
const field = (type, name) => typeNamed(model, type).fields.find((candidate) => candidate.name === name);

function memoryVault(paths = PATHS) {
  const files = new Map(paths.map((path) => [path, path.endsWith('.png') ? new Uint8Array([1]) : '']));
  const folders = new Set();
  return {
    files, folders,
    io: {
      createFolder: async (path) => { folders.add(path); },
      writeText: async (path, text) => { if (files.has(path)) throw new Error('exists'); files.set(path, text); },
      copyImage: async (source, path) => { files.set(path, source.bytes ?? files.get(source.vaultPath)); },
    },
  };
}

test('file names come from the title, like the vault\'s own', () => {
  expect(fileSlug('Questions to ask a new CISO')).toBe('questions-to-ask-a-new-ciso');
  expect(fileSlug('Risk & governance: a primer')).toBe('risk-and-governance-a-primer');
  expect(fileSlug('Café  déjà vu ---\nnext')).toBe('cafe-deja-vu-next');
  expect(fileSlug('../../etc/passwd')).toBe('etc-passwd');
  expect(fileSlug('!!!')).toBe('');
});

test('properties: model order, quoting where needed, nothing can be injected', () => {
  const nasty = ['Risk: a primer', 'line one\nline two', '---', 'a\n---\ndraft: false', 'true', 'null', '#tag', '[[x]]', '2026-11-24',
    '"quoted"', "it's fine", 'ends with colon:', '- dash', '{a: 1}', '*alias', 'a #comment', '@at', 'tab\there', 'yes'];
  for (const title of nasty) {
    const text = frontmatterText([['title', title.replace(/\s+/gu, ' ').trim()], ['draft', true]]);
    const block = findFrontmatterInText(`${text}\nbody\n`);
    const parsed = yaml.load(text.slice(4, -4), { schema: yaml.CORE_SCHEMA });
    expect(Object.keys(parsed)).toEqual(['title', 'draft']);
    expect(parsed.title).toBe(title.replace(/\s+/gu, ' ').trim());
    expect(parsed.draft).toBe(true);
    expect(block.error).toBeUndefined();
    expect(text.split('\n').filter((line) => line === '---')).toHaveLength(2);
  }
  expect(frontmatterText([['title', 'Plain words, simply']])).toBe('---\ntitle: Plain words, simply\n---\n');
  expect(frontmatterText([['author', '[[authors/the-chief]]']])).toBe('---\nauthor: "[[authors/the-chief]]"\n---\n');
  expect(frontmatterText([['date', '2026-11-24', 'date'], ['tags', ['audience/board', 'level/primer']]]))
    .toBe('---\ndate: 2026-11-24\ntags:\n  - audience/board\n  - level/primer\n---\n');
  expect(() => frontmatterText([['date', '2026-11-24\nx: 1', 'date']])).toThrow();
});

test('tags: group/value, suggested from the model and the vault, new ones accepted', () => {
  expect(normalizeTag('#Audience/Board ', 'group/value')).toEqual({ tag: 'audience/board' });
  expect(normalizeTag('strategy', 'group/value').error).toContain('group and a value');
  expect(normalizeTag('a/b: c', 'group/value').error).toBeDefined();
  const suggestions = tagSuggestions(model, [['audience/executives', 'strategy'], 'sector/space', ['kb/risk-and-governance']]);
  expect(suggestions).toContain('audience/board'); // from the model
  expect(suggestions).toContain('sector/space'); // from the vault
  expect(suggestions).toContain('kb/risk-and-governance'); // also filed
  expect(suggestions).not.toContain('strategy'); // not group/value
});

test('folder pickers list folders of the right type, labelled by their titles', () => {
  const topics = folderOptions(model, field('post', 'topic'), PATHS, titleOf);
  expect(topics.map((option) => option.value)).toEqual(['from-the-field', 'leadership-and-strategy', 'risk-and-governance']);
  expect(topics.find((option) => option.value === 'leadership-and-strategy').label).toBe('Leadership & strategy');
  const kb = folderOptions(model, field('kb-page', 'folder'), PATHS, titleOf);
  expect(kb.map((option) => [option.value, option.label])).toEqual([
    ['risk-and-governance', 'Risk & governance'], ['risk-and-governance/frameworks', 'Risk & governance › Frameworks'],
    ['threats-and-response', 'threats-and-response']]);
  expect(newFolderParents(field('kb-page', 'folder'), kb).map((option) => option.value)).toEqual(['', 'risk-and-governance', 'threats-and-response']);
});

const POST = { title: 'Questions to ask a new CISO: the first 90 days', topic: { existing: 'leadership-and-strategy' },
  description: 'What a board or CEO should ask\nin the first 90 days.', tags: ['audience/executives', 'level/primer'],
  cover: { name: 'IMG_0042.JPEG', source: { bytes: new Uint8Array([9, 9]) } }, youtube: '', featured: false };

test('a post end to end: form answers to a draft note, its photo beside it, and nothing public', async () => {
  const vault = memoryVault();
  const plan = planNewNote({ model, typeName: 'post', values: POST, paths: PATHS, today: '2026-11-24', authorNote: null, titleOf });
  expect(plan.ok).toBe(true);
  const path = await applyPlan(plan, vault.io);
  expect(path).toBe('leadership-and-strategy/questions-to-ask-a-new-ciso-the-first-90-days.md');
  expect(vault.files.get(path)).toBe(`---
title: "Questions to ask a new CISO: the first 90 days"
description: What a board or CEO should ask in the first 90 days.
date: 2026-11-24
tags:
  - audience/executives
  - level/primer
cover: leadership-and-strategy/questions-to-ask-a-new-ciso-the-first-90-days-cover.jpg
featured: false
author: "[[authors/the-chief]]"
draft: true
---

`);
  expect(vault.files.get('leadership-and-strategy/questions-to-ask-a-new-ciso-the-first-90-days-cover.jpg')).toEqual(new Uint8Array([9, 9]));
  // The publish rules read it as a draft: it stays off the site.
  expect(notePublicStatus({ path, text: vault.files.get(path), publishYml: PUBLISH_YML })).toMatchObject({ published: false, draft: true });
});

test('the device\'s own author note wins over the site default; a missing one falls back', () => {
  const paths = [...PATHS, 'authors/guest.md'];
  const text = (authorNote) => planNewNote({ model, typeName: 'post', values: { ...POST, cover: null }, paths, today: '2026-11-24', authorNote, titleOf })
    .steps.at(-1).text;
  expect(text('authors/guest.md')).toContain('author: "[[authors/guest]]"');
  expect(text('authors/gone.md')).toContain('author: "[[authors/the-chief]]"');
});

test('missing and wrong answers come back per field, and nothing is written', () => {
  const plan = planNewNote({ model, typeName: 'post', values: { title: '', topic: { existing: 'kb' }, youtube: 'javascript:alert(1)',
    tags: ['strategy'], cover: { name: 'logo.svg', source: {} } }, paths: PATHS, today: '2026-11-24', titleOf });
  expect(plan.ok).toBe(false);
  expect(plan.errors).toMatchObject({ title: 'Add a title.', topic: 'Pick a topic.', description: 'Add a summary.',
    youtube: 'YouTube link should be a web address starting with https://.', cover: 'Pick a PNG, JPEG, WebP or GIF image.' });
  expect(plan.errors.tags).toContain('group and a value');
  const taken = planNewNote({ model, typeName: 'post', values: { title: 'A security strategy that fits on one page', topic: { existing: 'leadership-and-strategy' },
    description: 'x' }, paths: PATHS, today: '2026-11-24', titleOf });
  expect(taken.errors.title).toContain('already a note with this title');
  expect(planNewNote({ model, typeName: 'page', values: {}, paths: PATHS }).ok).toBe(false);
});

test('a knowledge base page in a new sub-folder: the folder, its index note, then the page', async () => {
  const vault = memoryVault();
  const values = { title: 'Tabletop basics', description: 'How to run one.', tags: ['level/primer'],
    folder: { new: { parent: 'risk-and-governance', values: { title: 'Exercises', description: 'Practice before it counts.' } } } };
  const plan = planNewNote({ model, typeName: 'kb-page', values, paths: PATHS, today: '2026-11-24', titleOf });
  expect(plan.ok).toBe(true);
  expect(plan.steps.map((step) => [step.kind, step.path])).toEqual([
    ['folder', 'kb/risk-and-governance/exercises'],
    ['note', 'kb/risk-and-governance/exercises/index.md'],
    ['note', 'kb/risk-and-governance/exercises/tabletop-basics.md']]);
  await applyPlan(plan, vault.io);
  expect(vault.folders.has('kb/risk-and-governance/exercises')).toBe(true);
  expect(vault.files.get('kb/risk-and-governance/exercises/index.md')).toBe('---\ntitle: Exercises\ndescription: Practice before it counts.\n---\n');
  expect(vault.files.get('kb/risk-and-governance/exercises/tabletop-basics.md')).toContain('draft: true');
});

test('new sub-folders: required fields asked, depth and duplicates refused', () => {
  const plan = (folder) => planNewNote({ model, typeName: 'kb-page', values: { title: 'X', description: 'y', folder }, paths: PATHS, titleOf });
  expect(plan({ new: { parent: 'risk-and-governance', values: { title: 'Exercises' } } }).errors['folder.new.description']).toBe('Add a summary.');
  expect(plan({ new: { parent: 'risk-and-governance/frameworks', values: { title: 'Too deep', description: 'd' } } }).errors['folder.new.parent'])
    .toBe('Pick where the new folder goes.');
  expect(plan({ new: { parent: 'risk-and-governance', values: { title: 'Frameworks', description: 'd' } } }).errors['folder.new.title'])
    .toContain('already there');
  expect(plan({ new: { parent: '', values: { title: 'Cloud', description: 'd' } } }).ok).toBe(true);
  // A topic picker does not allow new folders.
  expect(planNewNote({ model, typeName: 'post', values: { title: 'X', description: 'y', topic: { new: { parent: '', values: { title: 'New', description: 'd' } } } },
    paths: PATHS, titleOf }).errors.topic).toBe('Pick an existing topic.');
});

test('a topic is its own folder note', () => {
  const plan = planNewNote({ model, typeName: 'topic', values: { title: 'Policy & law', description: 'Rules.', icon: 'scale', order: '7' }, paths: PATHS, titleOf });
  expect(plan.notePath).toBe('policy-and-law/index.md');
  expect(plan.steps.at(-1).text).toBe('---\ntitle: Policy & law\ndescription: Rules.\norder: 7\nicon: scale\n---\n\n');
  expect(planNewNote({ model, typeName: 'topic', values: { title: 'KB', description: 'x' }, paths: PATHS }).errors.title).toBeDefined();
});
