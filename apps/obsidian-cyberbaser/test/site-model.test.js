import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { creatableTypes, FIELD_TYPES, fillLocation, firstPublishFields, matchLocation, parseSiteModel, typeNamed } from '../src/core/site-model.js';

const CYBERCHIEF = readFileSync(new URL('./fixtures/cyberchief-model.yml', import.meta.url), 'utf8');

const minimal = (fields, extra = '') => `version: 0
types:
  note:
    label: Note
    location:
      pattern: "notes/<slug>.md"
    fields:
      title: { type: text, label: Title, required: true }
${fields}
${extra}`;

const errorsOf = (text) => {
  const result = parseSiteModel(text);
  expect(result.ok).toBe(false);
  return result.errors.join('\n');
};

test('the Cyberchief model parses as written, in its own order', () => {
  const result = parseSiteModel(CYBERCHIEF);
  expect(result.errors).toBeUndefined();
  const { model } = result;
  expect(model.types.map((type) => type.name)).toEqual(['post', 'topic', 'kb-page', 'kb-folder', 'author', 'page']);
  const post = typeNamed(model, 'post');
  expect(post.fields.map((field) => field.name)).toEqual(['title', 'topic', 'description', 'date', 'tags', 'cover', 'youtube',
    'featured', 'author', 'draft', 'sample']);
  expect(post.fields.find((field) => field.name === 'topic')).toMatchObject({ type: 'choice-from-folder', root: '.', ofType: 'topic', maxDepth: 1 });
  expect(typeNamed(model, 'kb-page').fields.find((field) => field.name === 'folder')).toMatchObject({ root: 'kb', allowNew: true, allowRoot: true, maxDepth: 2 });
  expect(model.version).toBe(1);
  expect(post.fields.find((field) => field.name === 'date').default).toBe('first-publish');
  expect(model.taxonomy.allowPlainTags).toBe(true);
  expect(post.fields.find((field) => field.name === 'draft').default).toBe(true);
  expect(post.fields.find((field) => field.name === 'sample').hidden).toBe(true);
  expect(model.site.defaultAuthor).toBe('authors/the-chief.md');
  expect(model.taxonomy.folderNote).toBe('index.md');
  expect(model.taxonomy.tagShape).toBe('group/value');
  expect(model.taxonomy.suggestedTags).toContain('audience/executives');
  // Fixed pages and folder notes made through another type are not offered on their own.
  expect(creatableTypes(model).map((type) => type.name)).toEqual(['post', 'topic', 'kb-page', 'author']);
});

test('locations: match and fill the vault patterns', () => {
  const { model } = parseSiteModel(CYBERCHIEF);
  const kbFolder = typeNamed(model, 'kb-folder');
  const topic = typeNamed(model, 'topic');
  expect(matchLocation(kbFolder.location, 'kb/risk-and-governance/frameworks/index.md')).toEqual({ folder: 'risk-and-governance/frameworks' });
  expect(matchLocation(kbFolder.location, 'kb/index.md')).toBeNull();
  expect(matchLocation(topic.location, 'leadership-and-strategy/index.md')).toEqual({ slug: 'leadership-and-strategy' });
  expect(matchLocation(topic.location, 'kb/index.md')).toBeNull(); // excluded
  expect(matchLocation(topic.location, 'authors/index.md')).toBeNull();
  expect(fillLocation(typeNamed(model, 'post').location, { topic: 'from-the-field', slug: 'a-b' })).toBe('from-the-field/a-b.md');
  expect(fillLocation(typeNamed(model, 'kb-page').location, { folder: 'x/y', slug: 'z' })).toBe('kb/x/y/z.md');
  // kb/[<folder...>/]<slug>.md: the folder may be left out.
  const kbPage = typeNamed(model, 'kb-page');
  expect(fillLocation(kbPage.location, { folder: '', slug: 'z' })).toBe('kb/z.md');
  expect(matchLocation(kbPage.location, 'kb/z.md')).toEqual({ folder: '', slug: 'z' });
  expect(matchLocation(kbPage.location, 'kb/a/b/z.md')).toEqual({ folder: 'a/b', slug: 'z' });
  expect(matchLocation(kbPage.location, 'z.md')).toBeNull();
  expect(matchLocation(kbPage.location, 'kb/.md')).toBeNull();
});

test('version 1: date defaults, the optional folder part and allow_root must agree', () => {
  const v1 = (pattern, folder, date = '') => `version: 1
types:
  page:
    label: Page
    location: { field: folder, pattern: "${pattern}" }
    fields:
      title: { type: text, label: Title }
      folder: ${folder}
${date}
  folder:
    label: Folder
    location: { pattern: "kb/<folder...>/index.md" }
    fields:
      title: { type: text, label: Title }
`;
  const ok = '{ type: choice-from-folder, label: Folder, root: kb, of_type: folder, allow_root: true, max_depth: 2 }';
  expect(parseSiteModel(v1('kb/[<folder...>/]<slug>.md', ok)).ok).toBe(true);
  expect(parseSiteModel(v1('kb/[<folder...>/]<slug>.md', ok, '      date: { type: date, label: Date, default: today }')).ok).toBe(true);
  expect(errorsOf(v1('kb/[<folder...>/]<slug>.md', ok, '      date: { type: date, label: Date, default: "on first publish" }')))
    .toContain('a date default should be today');
  expect(errorsOf(v1('kb/<folder...>/<slug>.md', ok))).toContain('allows the top level (allow_root), so its pattern should write it as [<folder...>/]');
  expect(errorsOf(v1('kb/[<folder...>/]<slug>.md', ok.replace('allow_root: true, ', '')))).toContain('add allow_root: true');
  expect(errorsOf(v1('kb/[<folder...>/]<slug>.md', ok.replace('allow_root: true', 'allow_root: maybe')))).toContain('"allow_root" should be true or false');
  expect(errorsOf(v1('kb/[folder/]<slug>.md', ok))).toContain('has a part in [ ]');
  expect(errorsOf(v1('kb/[<folder...>/]<slug>.md', ok).replace('types:', 'taxonomy: { tags: { allow_plain: often } }\ntypes:')))
    .toContain('"taxonomy.tags.allow_plain" should be true or false');
  // Version 0 models keep reading as before (their date default is free text).
  expect(parseSiteModel(v1('kb/[<folder...>/]<slug>.md', ok, '      date: { type: date, label: Date, default: "on first publish" }').replace('version: 1', 'version: 0')).ok)
    .toBe(true);
});

test('first-publish fields: which dates Publish fills, by where the note is', () => {
  const { model } = parseSiteModel(CYBERCHIEF);
  expect(firstPublishFields(model, 'from-the-field/a-post.md')).toEqual(['date']);
  expect(firstPublishFields(model, 'kb/a.md')).toEqual([]);
  expect(firstPublishFields(model, 'authors/x.md')).toEqual([]);
  expect(firstPublishFields(null, 'from-the-field/a-post.md')).toEqual([]);
});

test('an unknown field type is an error that names the field', () => {
  const message = errorsOf(minimal('      clip: { type: video, label: Clip }'));
  expect(message).toContain('Field "clip" in type "note" has type "video"');
  for (const type of FIELD_TYPES) expect(message).toContain(type);
});

test('each mistake gets its own plain sentence', () => {
  expect(errorsOf('types: [')).toMatch(/not valid YAML near line \d: unexpected end/u);
  expect(errorsOf('- a\n- b\n')).toContain('should start with "version: 0"');
  expect(errorsOf(minimal('').replace('version: 0', 'version: 2'))).toContain('says version 2; this plugin reads version 0');
  expect(errorsOf('version: 0\n')).toContain('needs a "types:" section');
  expect(errorsOf(minimal('', 'pages: {}'))).toContain('has a section "pages"');
  expect(errorsOf(minimal('      x: { type: text, lable: X }'))).toContain('has a setting "lable" that a text field does not use');
  expect(errorsOf(minimal('      x: { type: text }'))).toContain('Field "x" in type "note" needs a label');
  expect(errorsOf(minimal('      x: { label: X }'))).toContain('Field "x" in type "note" has no type');
  expect(errorsOf(minimal('      x: { type: choice, label: X }'))).toContain('is a choice, so it needs "options"');
  expect(errorsOf(minimal('      x: { type: choice, label: X, options: [a, b], default: c }'))).toContain('default "c" is not one of its options');
  expect(errorsOf(minimal('      x: { type: checkbox, label: X, default: maybe }'))).toContain('checkbox default should be true or false');
  expect(errorsOf(minimal('      x: { type: text, label: X, required: yes please }'))).toContain('"required" should be true or false');
  expect(errorsOf(minimal('      x: { type: choice-from-folder, label: X }'))).toContain('needs "root"');
  expect(errorsOf(minimal('      x: { type: choice-from-folder, label: X, root: ".", of_type: nope }'))).toContain('of_type "nope" is not a type');
  expect(errorsOf(minimal('').replace('"notes/<slug>.md"', '"notes/<slug>"'))).toContain('needs a "pattern" ending in .md');
  expect(errorsOf(minimal('').replace('      title: { type: text, label: Title, required: true }\n', '      name: { type: text, label: Name }\n')))
    .toContain('needs a text field named "title"');
});

test('location fields must agree with their folder picker', () => {
  const model = (pattern, field) => `version: 0
types:
  post:
    label: Post
    location: { field: topic, pattern: "${pattern}" }
    fields:
      title: { type: text, label: Title }
      topic: ${field}
  topic:
    label: Topic
    location: { pattern: "<slug>/index.md" }
    fields:
      title: { type: text, label: Title }
`;
  expect(parseSiteModel(model('<topic>/<slug>.md', '{ type: choice-from-folder, label: Topic, root: ".", of_type: topic }')).ok).toBe(true);
  expect(errorsOf(model('<topic>/<slug>.md', '{ type: text, label: Topic }'))).toContain('should be a choice-from-folder field');
  expect(errorsOf(model('posts/<topic>/<slug>.md', '{ type: choice-from-folder, label: Topic, root: ".", of_type: topic }')))
    .toContain('picks inside ".", but the pattern puts it inside "posts"');
  expect(errorsOf(model('<topic>/<slug>.md', '{ type: choice-from-folder, label: Topic, root: ".", of_type: topic, max_depth: 2 }')))
    .toContain('<topic> and max_depth 2 disagree');
  expect(errorsOf(model('<slug>.md', '{ type: choice-from-folder, label: Topic, root: ".", of_type: topic }')))
    .toContain('should contain <topic> or <topic...>');
});
