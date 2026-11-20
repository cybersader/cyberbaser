import MarkdownIt from 'markdown-it';
import yaml from 'js-yaml';
import { headingKey, noteRoute, noteStem } from './routes.js';
import { posix as path } from 'node:path';

const md = new MarkdownIt({ html: false, linkify: true });

// Inline rule rather than a source rewrite: backticks, fenced blocks, escapes and
// other Markdown structures keep their normal meaning.
md.inline.ruler.before('link', 'wiki_reference', (state, silent) => {
  if (state.linkLevel > 0) return false;
  const embed = state.src.startsWith('![[', state.pos);
  if (!embed && !state.src.startsWith('[[', state.pos)) return false;
  const start = state.pos + (embed ? 3 : 2);
  const end = state.src.indexOf(']]', start);
  if (end < 0 || end + 2 > state.posMax) return false;
  const contents = state.src.slice(start, end);
  if (/[\r\n[\]]/u.test(contents)) return false;
  const pipe = contents.indexOf('|');
  const target = (pipe === -1 ? contents : contents.slice(0, pipe)).trim();
  if (!target) return false;
  const label = pipe === -1 ? target : contents.slice(pipe + 1).trim() || target;
  if (!silent) {
    const token = state.push('wiki_reference', '', 0);
    token.content = label;
    token.meta = { target, embed };
  }
  state.pos = end + 2;
  return true;
});

const escape = md.utils.escapeHtml;
const missingLink = (content) => `<span class="unresolved-reference">${content}</span>`;
const image = (url, alt) => `<img src="${escape(url)}" alt="${escape(alt)}" loading="lazy" decoding="async">`;

md.renderer.rules.wiki_reference = (tokens, i, _options, env) => {
  const { content, meta: { target, embed } } = tokens[i];
  const found = env.resolve(target, embed ? 'wiki-image' : 'wiki');
  if (found?.image) return image(found.url, content);
  if (found) return `<a href="${escape(found.url)}">${escape(content)}</a>`;
  return missingLink(escape(content));
};

md.renderer.rules.image = (tokens, i, options, env, renderer) => {
  const token = tokens[i];
  const alt = renderer.renderInlineAsText(token.children, options, env);
  const found = env.resolve(token.attrGet('src'), 'image');
  return found?.image ? image(found.url, alt) : missingLink(escape(alt || 'Image not available'));
};

// These rules always balance one open/close pair, even for an unresolved link.
md.renderer.rules.link_open = (tokens, i, _options, env) => {
  const token = tokens[i];
  const found = env.resolve(token.attrGet('href'), 'link');
  env.linkTags.push(found ? 'a' : 'span');
  if (!found) return '<span class="unresolved-reference">';
  const title = token.attrGet('title');
  return `<a href="${escape(found.url)}"${title ? ` title="${escape(title)}"` : ''}${found.external ? ' rel="noreferrer"' : ''}>`;
};
md.renderer.rules.link_close = (_tokens, _i, _options, env) => `</${env.linkTags.pop()}>`;

// Markdown-it uses inline styles for table alignment; emit fixed classes so the
// stylesheet can handle them without enabling inline styles in the page policy.
for (const tag of ['th', 'td']) {
  md.renderer.rules[`${tag}_open`] = (tokens, i) => {
    const alignment = /^text-align:(left|center|right)$/.exec(tokens[i].attrGet('style'))?.[1];
    return `<${tag}${alignment ? ` class="align-${alignment}"` : ''}>`;
  };
}

const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const EMPTY_FRONTMATTER = /^﻿?---[ \t]*\r?\n---[ \t]*(?:\r?\n|$)/;

function metadata(source, text) {
  const match = text.match(EMPTY_FRONTMATTER) ?? text.match(FRONTMATTER);
  if (!match) return { body: text, data: {} };
  try {
    const data = yaml.load(match[1] ?? '') ?? {};
    if (typeof data !== 'object' || Array.isArray(data)) throw new Error('expected a mapping');
    return { body: text.slice(match[0].length), data };
  } catch {
    throw new Error(`invalid YAML frontmatter in ${JSON.stringify(source)}`);
  }
}

function hideComments(body) {
  if (!body.includes('%%')) return body;
  const text = body.replace(/\r\n?/g, '\n');
  const offsets = [0];
  for (const line of text.matchAll(/\n/g)) offsets.push(line.index + 1);
  const tokens = [];
  md.block.parse(text, md, {}, tokens);
  const literalBlocks = new Map(tokens.filter((token) => token.type === 'fence' || token.type === 'code_block')
    .map((token) => [offsets[token.map[0]], offsets[token.map[1]] ?? text.length]));
  const inlineEnds = new Map();
  for (const token of tokens) {
    if (token.type !== 'inline' || !token.map) continue;
    const end = offsets[token.map[1]] ?? text.length;
    for (let line = token.map[0]; line < token.map[1]; line++) inlineEnds.set(line, end);
  }

  const kept = [];
  let start = 0;
  let line = 0;
  for (let i = 0; i < text.length;) {
    while (offsets[line + 1] <= i) line++;
    if (literalBlocks.has(i)) { i = literalBlocks.get(i); continue; }
    if (text[i] === '\\' && /[\\`%]/.test(text[i + 1] ?? '')) { i += 2; continue; }
    if (text[i] === '`') {
      const end = inlineEnds.get(line) ?? offsets[line + 1] ?? text.length;
      let j = i + 1;
      while (text[j] === '`') j++;
      const size = j - i;
      i = j;
      for (const run of text.slice(j, end).matchAll(/`+/g)) {
        if (run[0].length === size) { i = j + run.index + size; break; }
      }
      continue;
    }
    if (!text.startsWith('%%', i)) { i++; continue; }
    kept.push(text.slice(start, i));
    const close = text.indexOf('%%', i + 2);
    if (close === -1) return kept.join('');
    i = start = close + 2;
  }
  kept.push(text.slice(start));
  return kept.join('');
}

function textOf(inline) {
  return (inline.children ?? []).map((token) => {
    if (token.type === 'softbreak' || token.type === 'hardbreak') return ' ';
    if (token.type === 'image') return textOf(token);
    return token.type === 'text' || token.type === 'code_inline' || token.type === 'wiki_reference' ? token.content : '';
  }).join('');
}

function indexHeadings(tokens) {
  const anchors = new Map();
  const headings = [];
  const used = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== 'heading_open' || tokens[i + 1]?.type !== 'inline') continue;
    const label = textOf(tokens[i + 1]).trim();
    const key = headingKey(label);
    let id = key;
    for (let suffix = 1; id === 'reader-main' || used.has(id); suffix++) id = `${key}-${suffix}`;
    used.add(id);
    if (!anchors.has(label)) anchors.set(label, id);
    if (!anchors.has(key)) anchors.set(key, id);
    token.attrSet('id', id);
    if (label) headings.push({ id, label, level: Number(token.tag.slice(1)) });
  }
  // An explicit heading ID (including the suffix of a duplicate) wins.
  for (const id of used) anchors.set(id, id);
  return { anchors, headings };
}

export function parseNote(source, text) {
  const { body, data } = metadata(source, text);
  const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : path.basename(noteStem(source));
  const asList = (value) => (Array.isArray(value) ? value : [value])
    .filter((alias) => typeof alias === 'string' && alias.trim()).map((alias) => alias.trim());
  const env = {};
  const tokens = md.parse(hideComments(body), env);
  return {
    source, title, aliases: [...asList(data.aliases), ...asList(data.alias)],
    ...noteRoute(source, data.slug), ...indexHeadings(tokens), tokens, env,
  };
}

export function renderMarkdown(note, resolve) {
  return md.renderer.render(note.tokens, md.options, {
    ...note.env, resolve: (target, kind) => resolve(note, target, kind), linkTags: [],
  });
}
