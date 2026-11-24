// The vault's site model (.cyberbaser/model.yml): what kinds of notes the
// site has, their fields, and which folders hold them. Pure, no Obsidian.
//
// The format is the vault's own (versions 0 to 2, written by the site
// builder). This reads it as written and does not add to it. Version 2 adds
// readable names (`names:`): a new note's file and a new folder are named
// like their title, and the location placeholder is <name> (<slug> before). Errors are plain
// sentences that name the type and field, because the person reading them is
// the site builder fixing one file. The model never decides what is public:
// publish.yml does.
import yaml from 'js-yaml';

export const MODEL_PATH = '.cyberbaser/model.yml';
export const SUPPORTED_VERSIONS = Object.freeze([0, 1, 2]);
// The placeholder a new note's own name fills: <name> (readable, version 2) or <slug> (versions 0 and 1).
export const NAME_PLACEHOLDERS = Object.freeze(['name', 'slug']);
export const DEFAULT_UNSAFE = ':/\\?*"<>|';
const TRIMS = Object.freeze(['trailing-dot', 'trailing-space', 'leading-space']);
// Date defaults (version 1): the creation date, or the date of the first publish.
export const DATE_DEFAULTS = Object.freeze(['today', 'first-publish']);
export const FIELD_TYPES = Object.freeze(['text', 'long-text', 'date', 'checkbox', 'url', 'image', 'choice',
  'choice-from-folder', 'tags', 'author-reference', 'number']);

const COMMON_KEYS = ['type', 'label', 'required', 'default', 'hint', 'hidden'];
const EXTRA_KEYS = Object.freeze({ choice: ['options'], 'choice-from-folder': ['root', 'of_type', 'allow_root', 'allow_new', 'max_depth'] });
const TYPE_KEYS = ['label', 'layout', 'location', 'fields'];
const TOP_KEYS = ['version', 'site', 'names', 'types', 'taxonomy'];
const PLACEHOLDER = /^<([a-z][a-z0-9_-]*)(\.\.\.)?>$/u;
const NAME = /^[a-z][a-z0-9_-]*$/u;

const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const list = (words) => words.join(', ');

// `[<folder...>/]` in a pattern is a folder part that may be left out
// (version 1: `kb/[<folder...>/]<slug>.md` also allows kb/<slug>.md).
const OPTIONAL = /\[(<[a-z][a-z0-9_-]*(?:\.\.\.)?>)\/\]/gu;
const OPTIONAL_MARK = '\u0000?';

/** Split a location pattern into segments: { literal } or { name, many, md, optional }. */
export function patternSegments(pattern) {
  return String(pattern).replace(OPTIONAL, `${OPTIONAL_MARK}$1/`).split('/').map((raw) => {
    const optional = raw.startsWith(OPTIONAL_MARK);
    const part = optional ? raw.slice(OPTIONAL_MARK.length) : raw;
    const stem = part.endsWith('.md') ? part.slice(0, -3) : part;
    const match = PLACEHOLDER.exec(stem);
    if (!match) return { literal: part };
    return { name: match[1], many: match[2] === '...', md: part.endsWith('.md'), optional };
  });
}

/** Does a vault path fit a location pattern? Returns the placeholder values, or null. */
export function matchLocation(location, path) {
  if (!location) return null;
  if (Array.isArray(location.paths)) return location.paths.includes(path) ? {} : null;
  const segments = patternSegments(location.pattern);
  let source = '';
  const names = [];
  for (const [index, segment] of segments.entries()) {
    let piece;
    if (segment.literal !== undefined) piece = segment.literal.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    else {
      names.push(segment.name);
      piece = `${segment.many ? '([^/]+(?:/[^/]+)*)' : '([^/]+)'}${segment.md ? '\\.md' : ''}`;
    }
    const last = index === segments.length - 1;
    source += segment.optional ? `(?:${piece}/)?` : `${piece}${last ? '' : '/'}`;
  }
  const match = new RegExp(`^${source}$`, 'u').exec(path);
  if (!match) return null;
  const values = Object.fromEntries(names.map((name, i) => [name, match[i + 1] ?? '']));
  const excludes = location.excludes ?? [];
  if (Object.values(values).some((value) => value.split('/').some((part) => excludes.includes(part)))) return null;
  return values;
}

/** Build a vault path from a location pattern and placeholder values. */
export function fillLocation(location, values) {
  return patternSegments(location.pattern).map((segment) => {
    if (segment.literal !== undefined) return segment.literal;
    const value = values[segment.name];
    return segment.md ? `${value}.md` : value;
  }).filter((part) => part !== '' && part !== '.').join('/');
}

function readField(typeName, fieldName, raw, errors, version) {
  const where = `Field "${fieldName}" in type "${typeName}"`;
  if (!NAME.test(fieldName)) errors.push(`${where}: field names use lower-case letters, digits, - and _.`);
  if (!isMap(raw)) { errors.push(`${where} should be a set of settings, for example { type: text, label: Title }.`); return null; }
  if (!isText(raw.type)) { errors.push(`${where} has no type. Use one of: ${list(FIELD_TYPES)}.`); return null; }
  if (!FIELD_TYPES.includes(raw.type)) {
    errors.push(`${where} has type "${raw.type}", which Cyberbaser does not know. Use one of: ${list(FIELD_TYPES)}.`);
    return null;
  }
  const allowed = [...COMMON_KEYS, ...(EXTRA_KEYS[raw.type] ?? [])];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) errors.push(`${where} has a setting "${key}" that a ${raw.type} field does not use. It can have: ${list(allowed)}.`);
  }
  if (!isText(raw.label)) errors.push(`${where} needs a label, the words the author sees.`);
  for (const key of ['required', 'hidden']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') errors.push(`${where}: "${key}" should be true or false.`);
  }
  if (raw.hint !== undefined && typeof raw.hint !== 'string') errors.push(`${where}: "hint" should be text.`);
  if (raw.type === 'checkbox' && raw.default !== undefined && typeof raw.default !== 'boolean') {
    errors.push(`${where}: a checkbox default should be true or false.`);
  }
  if (version >= 1 && raw.type === 'date' && raw.default !== undefined && !DATE_DEFAULTS.includes(raw.default)) {
    errors.push(`${where}: a date default should be today (when the note is made) or first-publish (when it is first published).`);
  }
  if (raw.type === 'choice') {
    if (!Array.isArray(raw.options) || raw.options.length === 0 || !raw.options.every((option) => isText(String(option ?? '')))) {
      errors.push(`${where} is a choice, so it needs "options", a list like [one, two].`);
    } else if (raw.default !== undefined && !raw.options.map(String).includes(String(raw.default))) {
      errors.push(`${where}: its default "${raw.default}" is not one of its options.`);
    }
  }
  if (raw.type === 'choice-from-folder') {
    if (!isText(raw.root)) errors.push(`${where} picks a folder, so it needs "root", the folder to pick inside ("." for the vault itself).`);
    if (!isText(raw.of_type)) errors.push(`${where} picks a folder, so it needs "of_type", the type of that folder's index note.`);
    for (const key of ['allow_new', 'allow_root']) {
      if (raw[key] !== undefined && typeof raw[key] !== 'boolean') errors.push(`${where}: "${key}" should be true or false.`);
    }
    if (raw.max_depth !== undefined && !(Number.isSafeInteger(raw.max_depth) && raw.max_depth >= 1)) {
      errors.push(`${where}: "max_depth" should be a whole number, 1 or more.`);
    }
  }
  return Object.freeze({
    name: fieldName, type: raw.type, label: String(raw.label ?? fieldName), required: raw.required === true,
    hidden: raw.hidden === true, ...(raw.default !== undefined ? { default: raw.default } : {}),
    ...(typeof raw.hint === 'string' ? { hint: raw.hint } : {}),
    ...(raw.type === 'choice' && Array.isArray(raw.options) ? { options: Object.freeze(raw.options.map(String)) } : {}),
    ...(raw.type === 'choice-from-folder' ? {
      root: String(raw.root ?? '.').replace(/^\.\/|\/+$/gu, '') || '.', ofType: String(raw.of_type ?? ''),
      allowNew: raw.allow_new === true, allowRoot: raw.allow_root === true, maxDepth: Number.isSafeInteger(raw.max_depth) ? raw.max_depth : 1,
    } : {}),
  });
}

function readLocation(typeName, raw, errors) {
  const where = `The location of type "${typeName}"`;
  if (!isMap(raw)) { errors.push(`Type "${typeName}" needs a location: a "pattern" like "folder/<slug>.md", or a list of "paths".`); return null; }
  for (const key of Object.keys(raw)) {
    if (!['pattern', 'field', 'excludes', 'paths'].includes(key)) errors.push(`${where} has a setting "${key}" it does not use. It can have: pattern, field, excludes, paths.`);
  }
  if (raw.paths !== undefined) {
    if (raw.pattern !== undefined) errors.push(`${where} has both "pattern" and "paths". Use one.`);
    if (!Array.isArray(raw.paths) || !raw.paths.every((path) => isText(path) && path.endsWith('.md'))) {
      errors.push(`${where}: "paths" should be a list of note paths ending in .md.`);
      return null;
    }
    return Object.freeze({ paths: Object.freeze([...raw.paths]) });
  }
  if (!isText(raw.pattern) || !raw.pattern.endsWith('.md')) {
    errors.push(`${where} needs a "pattern" ending in .md, for example "<topic>/<slug>.md".`);
    return null;
  }
  const segments = patternSegments(raw.pattern);
  if (segments.some((segment) => segment.literal !== undefined && /[<>]/u.test(segment.literal))) {
    errors.push(`${where}: "${raw.pattern}" has a part in < > that is not a name like <slug> or <folder...>.`);
  }
  if (segments.some((segment) => segment.literal !== undefined && /[[\]]/u.test(segment.literal))) {
    errors.push(`${where}: "${raw.pattern}" has a part in [ ] that is not an optional folder like [<folder...>/].`);
  }
  if (segments.some((segment) => segment.optional && segment.md)) {
    errors.push(`${where}: only a folder part can be optional, not the note's file name.`);
  }
  if (raw.excludes !== undefined && !(Array.isArray(raw.excludes) && raw.excludes.every(isText))) {
    errors.push(`${where}: "excludes" should be a list of folder names.`);
  }
  if (raw.field !== undefined && !isText(raw.field)) errors.push(`${where}: "field" should name one of its fields.`);
  return Object.freeze({ pattern: raw.pattern, ...(isText(raw.field) ? { field: raw.field } : {}),
    excludes: Object.freeze([...(Array.isArray(raw.excludes) ? raw.excludes : [])]) });
}

/** Is every part of this type's location filled by the form (its slug or its folder field)? */
export function isCreatable(type) {
  if (!type.location?.pattern) return false;
  return patternSegments(type.location.pattern).every((segment) => segment.literal !== undefined
    || NAME_PLACEHOLDERS.includes(segment.name) || segment.name === type.location.field);
}

function checkType(type, types, errors) {
  const where = `Type "${type.name}"`;
  const location = type.location;
  if (!location?.pattern) return;
  const segments = patternSegments(location.pattern);
  const names = segments.filter((segment) => segment.name).map((segment) => segment.name);
  const last = segments.at(-1);
  if (!(last.literal?.endsWith('.md') || last.md)) errors.push(`${where}: its pattern should end with the note's file name.`);
  if (location.field !== undefined) {
    const field = type.fields.find((candidate) => candidate.name === location.field);
    if (!field) errors.push(`${where}: its location uses the field "${location.field}", but the type has no such field.`);
    else if (field.type !== 'choice-from-folder') errors.push(`${where}: its location field "${location.field}" should be a choice-from-folder field.`);
    if (!names.includes(location.field)) errors.push(`${where}: its pattern "${location.pattern}" should contain <${location.field}> or <${location.field}...>.`);
    if (field?.type === 'choice-from-folder' && names.includes(location.field)) {
      const index = segments.findIndex((segment) => segment.name === location.field);
      const prefix = segments.slice(0, index).map((segment) => segment.literal).join('/');
      if ((prefix || '.') !== field.root) {
        errors.push(`${where}: the field "${field.name}" picks inside "${field.root}", but the pattern puts it inside "${prefix || '.'}". Make them the same.`);
      }
      const many = segments[index].many;
      if (many !== (field.maxDepth > 1)) {
        errors.push(`${where}: <${field.name}${many ? '...' : ''}> and max_depth ${field.maxDepth} disagree. Use <${field.name}...> for folders more than one level deep, <${field.name}> for one level.`);
      }
      if (segments[index].optional !== field.allowRoot) {
        errors.push(field.allowRoot
          ? `${where}: the field "${field.name}" allows the top level (allow_root), so its pattern should write it as [<${field.name}${many ? '...' : ''}>/].`
          : `${where}: [<${field.name}${many ? '...' : ''}>/] means the folder may be left out; add allow_root: true to the field "${field.name}", or drop the [ ].`);
      }
    }
  }
  if (isCreatable(type)) {
    const title = type.fields.find((field) => field.name === 'title');
    if (names.some((name) => NAME_PLACEHOLDERS.includes(name)) && (!title || !['text'].includes(title.type))) {
      errors.push(`${where}: new notes get their file name from the title, so the type needs a text field named "title".`);
    }
  }
  for (const field of type.fields) {
    if (field.type !== 'choice-from-folder') continue;
    const folderType = types.find((candidate) => candidate.name === field.ofType);
    if (!folderType) errors.push(`Field "${field.name}" in type "${type.name}": of_type "${field.ofType}" is not a type in this model.`);
    else if (!folderType.location?.pattern) errors.push(`Field "${field.name}" in type "${type.name}": the type "${field.ofType}" needs a location pattern for its folder notes.`);
  }
}

/**
 * Parse and check model.yml text. Returns { ok: true, model } or
 * { ok: false, errors: [sentence, …] } listing every problem found.
 */
export function parseSiteModel(text) {
  let raw;
  try {
    raw = yaml.load(String(text ?? ''), { schema: yaml.CORE_SCHEMA });
  } catch (error) {
    const line = Number.isSafeInteger(error?.mark?.line) ? ` near line ${error.mark.line + 1}` : '';
    return { ok: false, errors: [`${MODEL_PATH} is not valid YAML${line}: ${String(error?.reason ?? error?.message ?? error)}.`] };
  }
  if (!isMap(raw)) return { ok: false, errors: [`${MODEL_PATH} should start with "version: 0" and a "types:" section.`] };
  const errors = [];
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.includes(key)) errors.push(`${MODEL_PATH} has a section "${key}" that Cyberbaser does not read. It can have: ${list(TOP_KEYS)}.`);
  }
  if (!SUPPORTED_VERSIONS.includes(raw.version)) {
    errors.push(`${MODEL_PATH} says version ${JSON.stringify(raw.version ?? null)}; this plugin reads version ${list(SUPPORTED_VERSIONS)}.`);
  }
  const site = raw.site === undefined ? {} : raw.site;
  if (!isMap(site)) errors.push('"site" should be a set of settings, for example { title: My site }.');
  else if (site.default_author !== undefined && !(isText(site.default_author) && site.default_author.endsWith('.md'))) {
    errors.push('"site.default_author" should be the path of an author note, ending in .md.');
  }
  if (!isMap(raw.types) || Object.keys(raw.types).length === 0) {
    errors.push(`${MODEL_PATH} needs a "types:" section with at least one type.`);
    return { ok: false, errors };
  }
  const types = [];
  for (const [name, value] of Object.entries(raw.types)) {
    if (!NAME.test(name)) errors.push(`Type "${name}": type names use lower-case letters, digits, - and _.`);
    if (!isMap(value)) { errors.push(`Type "${name}" should be a set of settings with a label, location and fields.`); continue; }
    for (const key of Object.keys(value)) {
      if (!TYPE_KEYS.includes(key)) errors.push(`Type "${name}" has a setting "${key}" that Cyberbaser does not read. It can have: ${list(TYPE_KEYS)}.`);
    }
    if (!isText(value.label)) errors.push(`Type "${name}" needs a label, the name the author sees.`);
    if (value.layout !== undefined && !isText(value.layout)) errors.push(`Type "${name}": "layout" should name one of the renderer's layouts.`);
    if (!isMap(value.fields)) { errors.push(`Type "${name}" needs "fields".`); continue; }
    const fields = Object.entries(value.fields).map(([fieldName, field]) => readField(name, fieldName, field, errors, raw.version)).filter(Boolean);
    types.push({ name, label: String(value.label ?? name), ...(isText(value.layout) ? { layout: value.layout } : {}),
      location: readLocation(name, value.location, errors), fields: Object.freeze(fields) });
  }
  for (const type of types) checkType(type, types, errors);
  const taxonomy = readTaxonomy(raw.taxonomy, errors);
  const names = readNames(raw.names, errors);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    model: Object.freeze({
      version: raw.version,
      site: Object.freeze({ title: isText(site.title) ? site.title : null, home: isText(site.home) ? site.home : null,
        defaultAuthor: isText(site.default_author) ? site.default_author : null }),
      types: Object.freeze(types.map((type) => Object.freeze(type))),
      taxonomy,
      names,
    }),
  };
}

// names: how new files and folders are named (version 2). null: the older
// slug rule (lower-case words joined by hyphens).
function readNames(raw, errors) {
  if (raw === undefined) return null;
  if (!isMap(raw)) { errors.push('"names" should be a set of settings, for example { rule: title-minus-unsafe }.'); return null; }
  for (const key of Object.keys(raw)) {
    if (!['rule', 'unsafe_characters', 'trim', 'address'].includes(key)) errors.push(`"names" has a setting "${key}" Cyberbaser does not read. It can have: rule, unsafe_characters, trim, address.`);
  }
  if (raw.rule !== 'title-minus-unsafe') errors.push('"names.rule" should be title-minus-unsafe: names are the title minus characters unsafe in file names.');
  if (raw.unsafe_characters !== undefined && typeof raw.unsafe_characters !== 'string') errors.push('"names.unsafe_characters" should be text, like ":/\\?*\"<>|".');
  if (raw.trim !== undefined && !(Array.isArray(raw.trim) && raw.trim.every((value) => TRIMS.includes(value)))) {
    errors.push(`"names.trim" should be a list of: ${list(TRIMS)}.`);
  }
  if (raw.address !== undefined && typeof raw.address !== 'string') errors.push('"names.address" should name the address style, like lowercase-hyphen.');
  return Object.freeze({ rule: 'title-minus-unsafe',
    unsafe: typeof raw.unsafe_characters === 'string' ? raw.unsafe_characters : DEFAULT_UNSAFE,
    trim: Object.freeze(Array.isArray(raw.trim) ? raw.trim.filter((value) => TRIMS.includes(value)) : [...TRIMS]),
    // The address style the model expects; .cyberbaser/site.yml is the one that decides.
    address: typeof raw.address === 'string' ? raw.address : null });
}

function readTaxonomy(raw, errors) {
  if (raw === undefined) return Object.freeze({ folderNote: 'index.md', tagShape: null, allowPlainTags: false, suggestedTags: Object.freeze([]), tagLabels: Object.freeze({}) });
  if (!isMap(raw)) { errors.push('"taxonomy" should be a set of settings.'); return null; }
  const folders = raw.folders ?? {};
  const tags = raw.tags ?? {};
  const folderNote = isMap(folders) && folders.folder_note !== undefined ? folders.folder_note : 'index.md';
  if (!(isText(folderNote) && folderNote.endsWith('.md') && !folderNote.includes('/'))) {
    errors.push('"taxonomy.folders.folder_note" should be a note file name like index.md.');
  }
  const suggested = [];
  if (isMap(tags) && tags.suggested !== undefined) {
    if (!isMap(tags.suggested)) errors.push('"taxonomy.tags.suggested" should list tag values per group, for example audience: [executives, board].');
    else {
      for (const [group, values] of Object.entries(tags.suggested)) {
        if (!Array.isArray(values) || !values.every((value) => isText(String(value ?? '')))) {
          errors.push(`"taxonomy.tags.suggested.${group}" should be a list of values.`);
        } else suggested.push(...values.map((value) => `${group}/${value}`));
      }
    }
  }
  const shape = isMap(tags) && isText(tags.shape) ? tags.shape : null;
  if (isMap(tags) && tags.allow_plain !== undefined && typeof tags.allow_plain !== 'boolean') {
    errors.push('"taxonomy.tags.allow_plain" should be true or false.');
  }
  return Object.freeze({ folderNote: isText(folderNote) ? folderNote : 'index.md', tagShape: shape,
    allowPlainTags: isMap(tags) && tags.allow_plain === true, suggestedTags: Object.freeze(suggested),
    tagLabels: Object.freeze(isMap(tags) && isMap(tags.labels) ? { ...tags.labels } : {}) });
}

export function typeNamed(model, name) {
  return model.types.find((type) => type.name === name) ?? null;
}

/**
 * The date fields to fill on first publish for a note at this path: those
 * with `default: first-publish` in every type whose location fits the path.
 * Returns field names, in model order, without repeats.
 */
export function firstPublishFields(model, path) {
  const names = [];
  for (const type of model?.types ?? []) {
    const values = matchLocation(type.location, path);
    if (!values) continue;
    // The folder it sits in must be a folder of the right type (kb/x.md is not a post in a topic "kb").
    const folderField = type.location.field ? type.fields.find((field) => field.name === type.location.field) : null;
    const folder = folderField ? values[folderField.name] : '';
    if (folderField && folder !== '') {
      const folderType = typeNamed(model, folderField.ofType);
      const note = [folderField.root, folder, model.taxonomy?.folderNote ?? 'index.md'].filter((part) => part && part !== '.').join('/');
      if (!matchLocation(folderType?.location, note)) continue;
    }
    for (const field of type.fields) {
      if (field.type === 'date' && field.default === 'first-publish' && !names.includes(field.name)) names.push(field.name);
    }
  }
  return names;
}

/** The placeholder this type's own name fills (name or slug), or null. */
export function namePlaceholder(type) {
  if (!type?.location?.pattern) return null;
  return patternSegments(type.location.pattern).map((segment) => segment.name).find((name) => NAME_PLACEHOLDERS.includes(name)) ?? null;
}

/** The types an author can start from the form, in model order. */
export function creatableTypes(model) {
  return model.types.filter(isCreatable);
}
