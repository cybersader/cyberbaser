import { expect, test } from 'bun:test';
import { selectFiles, RULES } from '../src/select.js';
import { caseKey } from '../src/paths.js';
import { classifyPage, publicAddress, resolveConfig, resolveConfigText } from '../src/page-rules.js';

const fm = (obj, body = 'body\n') => `---\n${Object.entries(obj).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\n${body}`;
const CONFIG = { allow: ['cyber/**'] };

test('a draft or sample marker beats the allowlist and cb-publish: true', () => {
  const { published, report } = selectFiles({
    'cyber/live.md': fm({ title: 'Live' }),
    'cyber/draft.md': fm({ draft: true }),
    'cyber/sample.md': fm({ sample: 'yes' }),
    'cyber/not-draft.md': fm({ draft: false }),
    'journal/forced.md': fm({ 'cb-publish': true, slug: 'forced', draft: true }),
  }, CONFIG);
  expect(published).toEqual(['cyber/live.md', 'cyber/not-draft.md']);
  expect(report.denied.find((d) => d.path === 'cyber/draft.md').rule).toBe(RULES.EXCLUDED_MARKER);
  expect(report.denied.find((d) => d.path === 'journal/forced.md').rule).toBe(RULES.EXCLUDED_MARKER);
});

test('publish: false still ranks first, and an unreadable marker fails closed', () => {
  const resolved = resolveConfig(CONFIG);
  expect(classifyPage('cyber/a.md', fm({ publish: false, draft: true }), resolved).rule).toBe(RULES.DENY_FLAG);
  expect(classifyPage('cyber/a.md', fm({ draft: 'maybe' }), resolved).published).toBe(false);
  expect(classifyPage('cyber/a.md', '---\ndraft:\n---\n', resolved).published).toBe(true);
});

test('exclude_when is vault-owned: a custom list replaces the default, a bad one fails closed', () => {
  const custom = resolveConfig({ allow: ['cyber/**'], exclude_when: ['wip'] });
  expect(classifyPage('cyber/a.md', fm({ wip: true }), custom).published).toBe(false);
  expect(classifyPage('cyber/a.md', fm({ draft: true }), custom).published).toBe(true);
  expect(resolveConfig({ allow: [], exclude_when: 'draft' }).ok).toBe(false);
  expect(resolveConfigText('allow: [cyber]\n').excludeWhen).toEqual(['draft', 'sample']);
  expect(resolveConfigText(null).ok).toBe(false);
});

test('the public address a device shows for a new page', () => {
  expect(publicAddress('topic/sub/New Note.md')).toBe('/topic/sub/New-Note');
  expect(publicAddress('topic/sub/index.md')).toBe('/topic/sub/');
  expect(publicAddress('index.md')).toBe('/');
  expect(publicAddress('journal/x.md', 'about/me')).toBe('/about/me');
  expect(publicAddress('a/b.md', 'index')).toBe('/');
});

test('case key folds case so Note.md collides with note.md', () => {
  expect(caseKey('Topic/Note.md')).toBe(caseKey('topic/note.md'));
  expect(caseKey('topic/note.md')).not.toBe(caseKey('topic/note2.md'));
});
