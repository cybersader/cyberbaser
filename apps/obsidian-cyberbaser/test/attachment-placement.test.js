// A cover picked in the New post form goes where Obsidian itself puts a new
// attachment for that note (Settings, Files and links, "Default location for
// new attachments"), through fileManager.getAvailablePathForAttachment. The
// stub below follows Obsidian's own code (1.9, FileManager and Vault): the
// source note must exist, otherwise relative settings fall back to the vault
// root; a missing attachment folder is created; a taken name gets " 1", " 2".
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { applyPlan, planNewNote } from '../src/core/new-note.js';
import { parseSiteModel } from '../src/core/site-model.js';

const { model } = parseSiteModel(readFileSync(new URL('./fixtures/cyberchief-model-v2.yml', import.meta.url), 'utf8'));
const PATHS = ['Authors/The Chief.md', 'Leadership & strategy/index.md', 'inbox/IMG_2041.jpg', 'Attachments/old.png'];
const POST = { title: 'Questions to ask a new CISO: the first 90 days', topic: { existing: 'Leadership & strategy' },
  description: 'What a board should ask.', tags: ['strategy'], cover: { name: 'IMG_2041.jpg', source: { vaultPath: 'inbox/IMG_2041.jpg' } } };
const NOTE = 'Leadership & strategy/Questions to ask a new CISO the first 90 days.md';
const NAME = 'Questions to ask a new CISO the first 90 days cover';

function stubVault(attachmentFolderPath, extra = []) {
  const files = new Map([...PATHS, ...extra].map((path) => [path, /\.(png|jpg)$/u.test(path) ? new Uint8Array([7]) : '']));
  const folders = new Set([...files.keys()].flatMap((path) => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
  const has = (path) => [...files.keys(), ...folders].some((known) => known.toLowerCase() === path.toLowerCase());
  const calls = [];
  const fileManager = {
    async getAvailablePathForAttachment(filename, sourcePath) {
      calls.push({ filename, sourcePath, existed: files.has(sourcePath) });
      const dot = filename.lastIndexOf('.');
      const [base, ext] = [filename.slice(0, dot), filename.slice(dot + 1)];
      const source = files.has(sourcePath) ? sourcePath : null;
      const parent = source && source.includes('/') ? source.slice(0, source.lastIndexOf('/')) : '';
      let folder = attachmentFolderPath;
      const sameFolder = folder === '.' || folder === './';
      const sub = folder.startsWith('./') ? folder.slice(2) : null;
      if (sameFolder) folder = source ? parent : '';
      else if (sub) folder = (source && parent ? `${parent}/` : '') + sub;
      folder = folder.replace(/^\/+|\/+$/gu, '');
      if (folder !== '' && !has(folder)) folders.add(folder);
      const prefix = folder === '' ? '' : `${folder}/`;
      let path = `${prefix}${base}.${ext}`;
      for (let n = 1; has(path); n += 1) path = `${prefix}${base} ${n}.${ext}`;
      return path;
    },
  };
  const io = {
    createFolder: async (path) => { folders.add(path); },
    writeText: async (path, text) => { if (files.has(path)) throw new Error('exists'); files.set(path, text); },
    replaceText: async (path, text) => { if (!files.has(path)) throw new Error('missing'); files.set(path, text); },
    remove: async (path) => { files.delete(path); },
    copyImage: async (source, path) => { if (files.has(path)) throw new Error('exists'); files.set(path, files.get(source.vaultPath)); },
    attachmentPath: (filename, notePath) => fileManager.getAvailablePathForAttachment(filename, notePath),
  };
  return { files, folders, calls, io };
}

async function create(setting, extra) {
  const vault = stubVault(setting, extra);
  const plan = planNewNote({ model, typeName: 'post', values: POST, paths: [...vault.files.keys()], today: '2026-11-24', titleOf: () => null });
  expect(plan.ok).toBe(true);
  await applyPlan(plan, vault.io);
  const cover = vault.files.get(NOTE).match(/\ncover: (.*)\n/u)[1];
  return { vault, cover };
}

test('vault folder (Obsidian default, attachmentFolderPath "/"): the cover goes to the vault root', async () => {
  const { vault, cover } = await create('/');
  expect(cover).toBe(`${NAME}.jpg`);
  expect(vault.files.get(cover)).toEqual(new Uint8Array([7]));
});

test('same folder as the note ("./"): the cover sits beside the note, worked out from the note itself', async () => {
  const { vault, cover } = await create('./');
  expect(cover).toBe(`Leadership & strategy/${NAME}.jpg`);
  expect(vault.files.has(cover)).toBe(true);
  // Obsidian reads the folder from the note, so the note exists when it is asked.
  expect(vault.calls).toEqual([{ filename: `${NAME}.jpg`, sourcePath: NOTE, existed: true }]);
});

test('subfolder under the note\'s folder ("./Attachments"): Topic/Attachments/…, the folder made on the way', async () => {
  const { vault, cover } = await create('./Attachments');
  expect(cover).toBe(`Leadership & strategy/Attachments/${NAME}.jpg`);
  expect(vault.folders.has('Leadership & strategy/Attachments')).toBe(true);
  expect(vault.files.has(cover)).toBe(true);
});

test('a specified folder ("Attachments"): the cover goes there, the property an exact path from the vault root', async () => {
  const { vault, cover } = await create('Attachments');
  expect(cover).toBe(`Attachments/${NAME}.jpg`);
  expect(vault.files.has(cover)).toBe(true);
  expect(vault.files.get(NOTE)).toContain(`\ncover: Attachments/${NAME}.jpg\n`);
});

test('a taken name gets Obsidian\'s next free name, and the property follows it', async () => {
  const taken = [`Leadership & strategy/Attachments/${NAME}.jpg`, `Leadership & strategy/Attachments/${NAME} 1.jpg`];
  const { vault, cover } = await create('./Attachments', taken);
  expect(cover).toBe(`Leadership & strategy/Attachments/${NAME} 2.jpg`);
  expect(vault.files.get(taken[0])).toEqual(new Uint8Array([7]));
  expect(vault.files.has(cover)).toBe(true);
});

test('a new topic (a folder note): its folder is made with the note, then the cover placed under it', async () => {
  const vault = stubVault('./Attachments');
  const values = { title: 'Threats & response', description: 'd', cover: POST.cover };
  const plan = planNewNote({ model, typeName: 'topic', values, paths: [...vault.files.keys()], today: '2026-11-24', titleOf: () => null });
  expect(plan.ok).toBe(true);
  await applyPlan(plan, vault.io);
  expect(plan.notePath).toBe('Threats & response/index.md');
  expect(vault.files.get(plan.notePath)).toContain('\ncover: Threats & response/Attachments/Threats & response cover.jpg\n');
  expect(vault.files.has('Threats & response/Attachments/Threats & response cover.jpg')).toBe(true);
});

test('a photo that cannot be copied leaves no half-made note behind', async () => {
  const vault = stubVault('./');
  vault.io.copyImage = async () => { throw new Error('disk full'); };
  const plan = planNewNote({ model, typeName: 'post', values: POST, paths: [...vault.files.keys()], today: '2026-11-24', titleOf: () => null });
  await expect(applyPlan(plan, vault.io)).rejects.toThrow('disk full');
  expect(vault.files.has(NOTE)).toBe(false);
});

test('without the attachment API (Obsidian before 1.5.7), beside the note with a free name', async () => {
  const vault = stubVault('./', [`Leadership & strategy/${NAME}.jpg`]);
  delete vault.io.attachmentPath;
  const plan = planNewNote({ model, typeName: 'post', values: POST, paths: [...vault.files.keys()], today: '2026-11-24', titleOf: () => null });
  expect(plan.ok).toBe(true);
  await applyPlan(plan, vault.io);
  expect(vault.files.get(NOTE)).toContain(`\ncover: Leadership & strategy/${NAME} 1.jpg\n`);
});
