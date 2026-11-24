// A new note from the site model's form. Pure, no Obsidian: main.js shows the
// form and hands the answers here; this works out the path, the properties
// and every file to create, and applyPlan writes them through a small I/O
// object (Obsidian's vault in the plugin, a Map in tests).
//
// Properties are written in the model's field order. Strings that could be
// read as anything else are double-quoted, so a title like
// `Risk: a primer` or one with a line break or `---` cannot add properties
// or end the block. The written block is parsed back and compared before
// anything is created.
import yaml from 'js-yaml';
import { addressFor } from '../../../../packages/publish/src/addresses.js';
import { DEFAULT_UNSAFE, fillLocation, matchLocation, namePlaceholder, patternSegments, typeNamed } from './site-model.js';

export const IMAGE_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const TAG_GROUP_VALUE = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)+$/u;
const TAG_ANY = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/u;
const PLAIN = /^[A-Za-z][A-Za-z0-9 _.,'()&!/+-]*$/u;
const RESERVED = /^(?:true|false|yes|no|on|off|null|y|n)$/iu;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

const dirname = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const join = (...parts) => parts.filter((part) => part && part !== '.').join('/');
const oneLine = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();

/**
 * File or folder name from a title (the site model's rule): lower-case, words
 * joined by hyphens, punctuation dropped, "&" read as "and". Words are split
 * by spaces, hyphens, dashes, slashes and underscores; any other punctuation
 * is dropped, so "Don't panic" is dont-panic and "Risk & governance" is
 * risk-and-governance.
 */
export function fileSlug(title) {
  return oneLine(title).normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase()
    .replace(/&/gu, ' and ').replace(/[\s\p{Pd}/\\_]+/gu, ' ').replace(/[^a-z0-9 ]+/gu, '')
    .trim().replace(/ +/gu, '-').slice(0, 80).replace(/-+$/u, '');
}

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

/**
 * Readable file or folder name (site model version 2, `names:`): the title as
 * typed, minus characters unsafe in file names on Windows, macOS or Linux
 * (the model's unsafe_characters, default : / \ ? * " < > |) and control
 * characters (each replaced by a space), spaces collapsed, then trimmed as the model says (leading and
 * trailing spaces, trailing dots). Leading dots are dropped too, so a name
 * never makes a hidden file. "Risk & governance" stays "Risk & governance".
 */
export function readableName(title, names = null) {
  const unsafe = new Set([...(names?.unsafe ?? DEFAULT_UNSAFE)]);
  const trim = names?.trim ?? ['trailing-dot', 'trailing-space', 'leading-space'];
  // Each unsafe character becomes a space (then spaces collapse), so "Before/after" reads "Before after".
  let name = [...String(title ?? '').replace(/\s+/gu, ' ')].map((ch) => (unsafe.has(ch) || /\p{Cc}/u.test(ch) ? ' ' : ch)).join('')
    .replace(/ {2,}/gu, ' ');
  if (trim.includes('leading-space')) name = name.replace(/^ +/u, '');
  for (let again = true; again;) {
    const before = name;
    if (trim.includes('trailing-space')) name = name.replace(/ +$/u, '');
    if (trim.includes('trailing-dot')) name = name.replace(/\.+$/u, '');
    again = name !== before;
  }
  name = name.replace(/^\.+/u, '').trim();
  if ([...name].length > 120) name = [...name].slice(0, 120).join('').replace(/[ .]+$/u, '');
  return name;
}

/** The name a title gives under this model: readable (version 2 `names:`) or the older slug. */
export function nameFromTitle(model, title) {
  return model?.names ? readableName(title, model.names) : fileSlug(title);
}

/** The name a note or folder gets: the author's own (cleaned) when given, else from the title. */
function chosenName(model, values) {
  const own = oneLine(values?.name);
  return nameFromTitle(model, own === '' ? values?.title : own);
}

/** Why this name cannot be a file or folder name, or null. */
function nameProblem(name, what) {
  if (WINDOWS_RESERVED.test(name)) return `"${name}" is a name Windows keeps for itself. Change the ${what}.`;
  return null;
}

export function todayString(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A link to a note as the vault writes it in properties: "[[authors/the-chief]]". */
export function wikilink(path) {
  return `[[${String(path).replace(/\.md$/u, '')}]]`;
}

function scalar(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  const text = String(value);
  if (PLAIN.test(text) && !text.endsWith(' ') && !RESERVED.test(text)) return text;
  return JSON.stringify(text);
}

/**
 * entries: [[key, value, kind]] in order. kind 'date' writes YYYY-MM-DD bare,
 * as the vault does; lists become block lists. Returns the whole --- block.
 */
export function frontmatterText(entries) {
  const lines = ['---'];
  const expected = {};
  for (const [key, value, kind] of entries) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${scalar(item)}`);
      expected[key] = value.map(String);
    } else if (kind === 'date' && value === null) {
      // Filled in later (default: first-publish): an empty value, read as null.
      lines.push(`${key}:`);
      expected[key] = null;
    } else if (kind === 'date') {
      if (!DATE.test(value)) throw new Error(`date "${value}" is not YYYY-MM-DD`);
      lines.push(`${key}: ${value}`);
      expected[key] = value;
    } else {
      lines.push(`${key}: ${scalar(value)}`);
      expected[key] = typeof value === 'boolean' || typeof value === 'number' ? value : String(value);
    }
  }
  lines.push('---');
  const text = `${lines.join('\n')}\n`;
  // Read it back the way a YAML reader would; anything else is a bug here.
  const parsed = yaml.load(text.slice(4, -4), { schema: yaml.CORE_SCHEMA }) ?? {};
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) throw new Error('the properties did not read back as written');
  return text;
}

/**
 * A tag as the author typed it, cleaned; { tag } or { error }. With shape
 * group/value, plain tags (one word, like strategy) are accepted only when the
 * model allows them (taxonomy.tags.allow_plain).
 */
export function normalizeTag(input, shape = null, { allowPlain = false } = {}) {
  const tag = oneLine(input).replace(/^#/u, '').toLowerCase().replace(/\s+/gu, '-');
  if (tag === '') return { error: 'Type a tag first.' };
  if (shape === 'group/value' && !allowPlain) {
    if (!TAG_GROUP_VALUE.test(tag)) return { error: 'Tags here are a group and a value, like audience/executives.' };
  } else if (!TAG_ANY.test(tag)) {
    return { error: shape === 'group/value' ? 'Use a word like strategy, or a group and a value like audience/executives.' : 'Use letters, digits and hyphens in tags.' };
  }
  return { tag };
}

/** The tag rules of a model, as normalizeTag's second and third arguments. */
export function tagRules(model) {
  return [model?.taxonomy?.tagShape ?? null, { allowPlain: model?.taxonomy?.allowPlainTags === true }];
}

/** Tags to suggest: the model's suggested ones plus those already in the vault, in the model's shape. */
export function tagSuggestions(model, existing = []) {
  const rules = tagRules(model);
  const out = new Set(model.taxonomy?.suggestedTags ?? []);
  for (const tags of existing) {
    for (const raw of Array.isArray(tags) ? tags : [tags]) {
      const result = normalizeTag(String(raw ?? ''), ...rules);
      if (result.tag) out.add(result.tag);
    }
  }
  return [...out].sort();
}

/**
 * The folders a choice-from-folder field offers: those under its root, at
 * most max_depth deep, whose folder note is a note of the field's of_type.
 * paths: every file path in the vault. titleOf(path) -> title or null.
 * Returns [{ value, path, label, depth }]; value is relative to the root.
 */
export function folderOptions(model, field, paths, titleOf = () => null) {
  const options = folderChoices(model, field, paths, titleOf);
  // allow_root: the picker's own folder comes first, as "Knowledge base (top level)".
  return field.allowRoot ? [{ value: '', path: field.root, depth: 0, label: rootLabel(model, field, titleOf) }, ...options] : options;
}

/** "Knowledge base (top level)": the root folder note's title, else its name. */
export function rootLabel(model, field, titleOf = () => null) {
  if (field.root === '.') return 'Top level';
  const title = oneLine(titleOf(`${field.root}/${model.taxonomy?.folderNote ?? 'index.md'}`));
  return `${title || field.root} (top level)`;
}

function folderChoices(model, field, paths, titleOf) {
  const folderType = typeNamed(model, field.ofType);
  const note = model.taxonomy?.folderNote ?? 'index.md';
  const root = field.root === '.' ? '' : field.root;
  const options = [];
  for (const path of paths) {
    if (!path.endsWith(`/${note}`)) continue;
    const folder = dirname(path);
    if (root && !folder.startsWith(`${root}/`)) continue;
    const value = root ? folder.slice(root.length + 1) : folder;
    const depth = value.split('/').length;
    if (depth > field.maxDepth || !matchLocation(folderType?.location, path)) continue;
    options.push({ value, path: folder, depth });
  }
  options.sort((a, b) => a.path.localeCompare(b.path));
  const label = (folder) => oneLine(titleOf(`${folder}/${note}`)) || folder.split('/').at(-1);
  for (const option of options) {
    const parts = option.value.split('/');
    option.label = parts.map((_, i) => label(join(root, parts.slice(0, i + 1).join('/')))).join(' › ');
  }
  return options;
}

/** Where a new sub-folder may go: the root and folders that leave room for one more level. */
export function newFolderParents(field, options, model = null, titleOf = () => null) {
  const parents = options.filter((option) => option.depth > 0 && option.depth < field.maxDepth).map(({ value, label }) => ({ value, label }));
  const root = options.find((option) => option.depth === 0)?.label
    ?? (model ? rootLabel(model, field, titleOf) : field.root === '.' ? 'Top level' : `${field.root} (top level)`);
  return [{ value: '', label: root }, ...parents];
}

function propertyEntries(type, values, context, errors, prefix = '') {
  const entries = [];
  for (const field of type.fields) {
    if (field.hidden || field.type === 'choice-from-folder') continue;
    const key = `${prefix}${field.name}`;
    const value = values[field.name];
    const missing = () => { if (field.required) errors[key] = `Add a ${field.label.toLowerCase()}.`; };
    switch (field.type) {
      case 'text':
      case 'long-text': {
        const text = oneLine(value);
        if (text === '') missing(); else entries.push([field.name, text]);
        break;
      }
      case 'number': {
        const text = oneLine(value);
        if (text === '') { missing(); break; }
        if (!/^-?\d{1,9}$/u.test(text)) { errors[key] = `${field.label} is a whole number.`; break; }
        entries.push([field.name, Number(text)]);
        break;
      }
      case 'url': {
        const text = oneLine(value);
        if (text === '') { missing(); break; }
        let ok = false;
        try { ok = ['http:', 'https:'].includes(new URL(text).protocol); } catch { ok = false; }
        if (!ok) { errors[key] = `${field.label} should be a web address starting with https://.`; break; }
        entries.push([field.name, text]);
        break;
      }
      case 'choice': {
        const text = oneLine(value ?? field.default);
        if (text === '') { missing(); break; }
        if (!field.options.includes(text)) { errors[key] = `Pick one of the listed ${field.label.toLowerCase()} options.`; break; }
        entries.push([field.name, text]);
        break;
      }
      case 'checkbox':
        entries.push([field.name, typeof value === 'boolean' ? value : field.default === true]);
        break;
      case 'date': {
        const text = oneLine(value);
        if (text !== '' && !DATE.test(text)) { errors[key] = `${field.label} is a date like 2026-11-24.`; break; }
        // default: first-publish leaves it empty; Publish fills it in the change you approve.
        entries.push([field.name, text || (field.default === 'first-publish' ? null : context.today), 'date']);
        break;
      }
      case 'tags': {
        const tags = [];
        for (const raw of Array.isArray(value) ? value : []) {
          const result = normalizeTag(raw, ...tagRules(context.model));
          if (result.error) { errors[key] = `"${raw}": ${result.error}`; break; }
          if (!tags.includes(result.tag)) tags.push(result.tag);
        }
        if (tags.length === 0) missing(); else entries.push([field.name, tags]);
        break;
      }
      case 'author-reference': {
        const author = [context.authorNote, context.model.site.defaultAuthor].find((path) => path && context.exists(path));
        if (author) entries.push([field.name, wikilink(author)]);
        else missing();
        break;
      }
      case 'image': {
        if (!value) { missing(); break; }
        const name = String(value.name ?? '');
        const extension = name.includes('.') ? name.split('.').at(-1).toLowerCase() : '';
        if (!IMAGE_EXTENSIONS.includes(extension)) { errors[key] = 'Pick a PNG, JPEG, WebP or GIF image.'; break; }
        // Beside the note: "<name> cover.jpg" (readable names) or "<slug>-cover.jpg".
        const target = join(context.folder, `${context.slug}${context.model.names ? ' ' : '-'}${field.name}.${extension === 'jpeg' ? 'jpg' : extension}`);
        if (context.exists(target)) { errors[key] = `There is already a file named ${target.split('/').at(-1)} there.`; break; }
        context.images.push({ path: target, source: value.source });
        entries.push([field.name, target]);
        break;
      }
      default:
        throw new Error(`no writer for field type ${field.type}`);
    }
  }
  return entries;
}

/**
 * Work out everything a new note needs. values: { [field]: answer } where a
 * folder field answer is { existing: '<folder under root>' } or
 * { new: { parent: '<folder under root or "">', values: { title, … } } } and
 * an image answer is { name, source } (source is passed through to I/O).
 * values.name (and a new folder's values.name): the author's own edit of the
 * file or folder name; empty means "from the title".
 * paths: every file path in the vault. authorNote: this device's author note.
 * addressStyle: the vault's address style (null: no address worked out).
 * Returns { ok: false, errors: { field: sentence }, notePath, address } or
 * { ok: true, notePath, address, steps: [{ kind: folder|note|image, path, … }] };
 * notePath and address may be null while answers are missing.
 */
export function planNewNote({ model, typeName, values = {}, paths = [], today, authorNote = null, titleOf = () => null, addressStyle = null }) {
  const type = typeNamed(model, typeName);
  if (!type) return { ok: false, errors: { type: 'Pick what you are writing.' } };
  const lower = new Set(paths.map((path) => path.toLowerCase()));
  const folderPrefixes = new Set(paths.flatMap((path) => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/').toLowerCase())));
  const exists = (path) => lower.has(path.toLowerCase()) || folderPrefixes.has(path.toLowerCase());
  const errors = {};
  const steps = [];
  const slug = chosenName(model, values);
  const ownSlug = oneLine(values.name) !== '';
  // Problems with the name go to the field that made it.
  const nameKey = ownSlug ? 'name' : 'title';
  if (ownSlug && slug === '') errors.name = 'Use some letters or digits in the file name.';
  else if (oneLine(values.title) !== '' && slug === '') errors.title = 'Use some letters or digits in the title.';
  else if (slug !== '' && nameProblem(slug, ownSlug ? 'file name' : 'title')) errors[nameKey] = nameProblem(slug, ownSlug ? 'file name' : 'title');

  // Where the note lives.
  const placeholders = { [namePlaceholder(type) ?? 'slug']: slug };
  const folderField = type.location.field ? type.fields.find((field) => field.name === type.location.field) : null;
  if (folderField) {
    const answer = values[folderField.name];
    const root = folderField.root === '.' ? '' : folderField.root;
    const options = folderOptions(model, folderField, paths, titleOf);
    if (answer?.new) {
      if (!folderField.allowNew) errors[folderField.name] = `Pick an existing ${folderField.label.toLowerCase()}.`;
      const folderType = typeNamed(model, folderField.ofType);
      const parent = String(answer.new.parent ?? '');
      const name = chosenName(model, answer.new.values);
      const folderNameKey = oneLine(answer.new.values?.name) !== '' ? 'name' : 'title';
      const folderErrors = {};
      if (parent !== '' && !newFolderParents(folderField, options, model, titleOf).some((option) => option.value === parent)) {
        folderErrors.parent = 'Pick where the new folder goes.';
      }
      const value = join(parent, name);
      const folderPath = join(root, value);
      const notePath = join(folderPath, model.taxonomy?.folderNote ?? 'index.md');
      if (name === '' && (folderNameKey === 'name' || oneLine(answer.new.values?.title) !== '')) folderErrors[folderNameKey] = 'Use some letters or digits in the folder name.';
      else if (name !== '' && nameProblem(name, 'folder name')) folderErrors[folderNameKey] = nameProblem(name, 'folder name');
      else if (name !== '' && addressStyle !== null && addressFor(`${join(root, name)}/index.md`, null, addressStyle) === null) {
        folderErrors[folderNameKey] = 'This folder name has no web address. Use some letters or digits.';
      }
      else if (name !== '' && exists(folderPath)) folderErrors[folderNameKey] = 'A folder with this name is already there. Pick it from the list instead.';
      const entries = propertyEntries(folderType, answer.new.values ?? {}, { model, today, authorNote, exists, images: [], folder: folderPath, slug: name }, folderErrors);
      if (name !== '' && !folderErrors[folderNameKey] && !matchLocation(folderType.location, notePath)) folderErrors.parent = `A ${folderType.label.toLowerCase()} cannot go there.`;
      for (const [key, message] of Object.entries(folderErrors)) errors[`${folderField.name}.new.${key}`] = message;
      if (Object.keys(folderErrors).length === 0) {
        steps.push({ kind: 'folder', path: folderPath });
        steps.push({ kind: 'note', path: notePath, text: frontmatterText(entries) });
      }
      placeholders[folderField.name] = value;
    } else if (typeof answer?.existing === 'string' && options.some((option) => option.value === answer.existing)) {
      placeholders[folderField.name] = answer.existing;
    } else {
      errors[folderField.name] = `Pick a ${folderField.label.toLowerCase()}.`;
    }
  }

  // An optional folder part ([<folder...>/]) may be empty: the note goes in the root.
  const optional = new Set(patternSegments(type.location.pattern).filter((segment) => segment.optional).map((segment) => segment.name));
  const filled = Object.entries(placeholders).every(([name, value]) => (typeof value === 'string' && value !== '') || (value === '' && optional.has(name)));
  const notePath = slug && filled && !errors[nameKey] ? fillLocation(type.location, placeholders) : null;
  // The web address the site will give it (the vault's address style, .cyberbaser/site.yml).
  const address = notePath && addressStyle !== null ? addressFor(notePath, null, addressStyle) : null;
  if (notePath && !matchLocation(type.location, notePath)) errors[nameKey] = `A ${type.label.toLowerCase()} cannot be called that.`;
  else if (notePath && addressStyle !== null && address === null) errors[nameKey] = 'This name has no web address. Use some letters or digits.';
  else if (notePath && exists(notePath)) {
    errors[nameKey] = ownSlug ? 'There is already a note with this file name there. Change it.' : 'There is already a note with this title there. Change the title.';
  }
  const images = [];
  const entries = propertyEntries(type, values, { model, today, authorNote, exists, images, folder: notePath ? dirname(notePath) : '', slug }, errors);
  if (Object.keys(errors).length > 0) return { ok: false, errors, notePath, address };
  for (const image of images) steps.push({ kind: 'image', path: image.path, source: image.source });
  steps.push({ kind: 'note', path: notePath, text: `${frontmatterText(entries)}\n` });
  return { ok: true, notePath, address, steps };
}

/**
 * Carry out a plan in order: folder, folder note, images, then the note last,
 * so a failure never leaves a note pointing at a missing photo.
 * io: { createFolder(path), writeText(path, text), copyImage(source, path) }.
 */
export async function applyPlan(plan, io) {
  if (!plan?.ok) throw new Error('plan has errors');
  for (const step of plan.steps) {
    if (step.kind === 'folder') await io.createFolder(step.path);
    else if (step.kind === 'image') await io.copyImage(step.source, step.path);
    else await io.writeText(step.path, step.text);
  }
  return plan.notePath;
}
