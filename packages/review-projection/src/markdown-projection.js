import { exposeInvisibleText } from './invisible-text.js';

const FENCE = /^(?:```|~~~)/u;
const HEADING = /^(#{1,6})\s+(.*)$/u;
const RULE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/u;
const QUOTE = /^>\s?/u;
const BULLET = /^(\s{0,3})([-*+])\s+(.*)$/u;
const ORDERED = /^(\s{0,3})(\d{1,9})[.)]\s+(.*)$/u;
// These run over every block slice. Line anchors use horizontal whitespace
// only: `\s` matches newlines, which made a run of blank lines quadratic.
const UNINTERPRETED = Object.freeze([
  [/!\[\[/u, 'note or image embed'],
  [/!\[[^\]\n]{0,1024}\]\(/u, 'image'],
  [/^[ \t]*>[ \t]*\[!/mu, 'callout'],
  [/^[ \t]*\|.*\|[ \t]*$/mu, 'table'],
  // A GFM delimiter row without outer pipes still makes the block a table.
  [/^[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+$/mu, 'table'],
  [/\$\$|(?<!\\)\$[^$\n]{1,1024}\$/u, 'math'],
  [/^(?:```|~~~)[ \t]*(?:mermaid|dataview|dataviewjs)/imu, 'renderer-executed block'],
  [/^[ \t]*[-*+][ \t]+\[[ xX]\]/mu, 'task list'],
  [/\[\^[^\]\s]{1,256}\]/u, 'footnote'],
  [/<\/?[a-zA-Z][^>]{0,1024}>|<!--/u, 'inline HTML'],
  [/%%/u, 'Obsidian comment'],
  [/\^[A-Za-z0-9-]{3,}[ \t]*$/mu, 'block reference'],
]);
const FRONTMATTER_ENTRY = /^[A-Za-z0-9_.-]+:(?:[ \t]|$)/u;
const SETEXT_UNDERLINE = /^ {0,3}-+[ \t]*\r?\n?$/u;
const SETEXT_EQUALS = /^ {0,3}=+[ \t]*\r?\n?$/u;
const INDENTED = /^(?: {4,}|\t)\S/mu;

// Line text is used only to classify structure; offsets always cover the raw
// bytes, so a CRLF file keeps its exact spans while its headings, lists, rules,
// and frontmatter are still recognised.
function lineText(text, start, end) {
  const raw = text.slice(start, end);
  return raw.endsWith('\r') ? raw.slice(0, -1) : raw;
}

function lines(text) {
  const result = [];
  let start = 0;
  while (start <= text.length) {
    const index = text.indexOf('\n', start);
    if (index === -1) {
      if (start < text.length) result.push({ start, end: text.length, text: lineText(text, start, text.length) });
      break;
    }
    result.push({ start, end: index + 1, text: lineText(text, start, index) });
    start = index + 1;
  }
  return result;
}

function token(type, text, extra = {}) {
  return Object.freeze({ type, text: exposeInvisibleText(text), ...extra });
}

const WORD_CHARACTER = /[A-Za-z0-9]/u;

/**
 * Inline scanner for rung R1: code spans, wikilinks, links, strong, and
 * emphasis. It walks the text once and finds closers with cached `indexOf`
 * lookups, so a line of unmatched openers costs linear time instead of the
 * quadratic backtracking a regex alternation showed on adversarial input.
 * Underscore emphasis is not intraword, so snake_case_names keep their
 * underscores.
 */
export function inlineTokens(value) {
  const tokens = [];
  const length = value.length;
  const cache = new Map();
  const find = (needle, from) => {
    const hit = cache.get(needle);
    if (hit && from >= hit.from && (hit.at === -1 || from <= hit.at)) return hit.at;
    const at = value.indexOf(needle, from);
    cache.set(needle, { from, at });
    return at;
  };
  const plain = (text, forbidden) => text.length > 0 && !forbidden.test(text);
  let textStart = 0;
  let index = 0;
  const flush = (end) => {
    if (end > textStart) tokens.push(token('text', value.slice(textStart, end)));
  };
  while (index < length) {
    const character = value[index];
    let matched = null;
    if (character === '`') {
      const close = find('`', index + 1);
      if (close !== -1 && plain(value.slice(index + 1, close), /\n/u)) {
        matched = { end: close + 1, type: 'code', text: value.slice(index + 1, close) };
      }
    } else if (character === '[') {
      if (value[index + 1] === '[') {
        const close = find(']]', index + 2);
        if (close !== -1 && plain(value.slice(index + 2, close), /[\]\n]/u)) {
          const inner = value.slice(index + 2, close);
          const pipe = inner.indexOf('|');
          const target = pipe === -1 ? inner : inner.slice(0, pipe);
          const alias = pipe === -1 ? target : inner.slice(pipe + 1);
          matched = { end: close + 2, type: 'wikilink', text: alias, extra: { target: exposeInvisibleText(target) } };
        }
      }
      if (matched === null) {
        const close = find(']', index + 1);
        if (close !== -1 && value[close + 1] === '(' && !value.slice(index + 1, close).includes('\n')) {
          const paren = find(')', close + 2);
          if (paren !== -1 && !/\s/u.test(value.slice(close + 2, paren))) {
            matched = {
              end: paren + 1,
              type: 'link',
              text: value.slice(index + 1, close),
              extra: { target: exposeInvisibleText(value.slice(close + 2, paren)) },
            };
          }
        }
      }
    } else if (character === '*') {
      if (value[index + 1] === '*') {
        const close = find('**', index + 2);
        if (close !== -1 && plain(value.slice(index + 2, close), /[*\n]/u)) {
          matched = { end: close + 2, type: 'strong', text: value.slice(index + 2, close) };
        }
      }
      if (matched === null) {
        const close = find('*', index + 1);
        if (close !== -1 && plain(value.slice(index + 1, close), /[*\n]/u)) {
          matched = { end: close + 1, type: 'emphasis', text: value.slice(index + 1, close) };
        }
      }
    } else if (character === '_' && !(index > 0 && WORD_CHARACTER.test(value[index - 1]))) {
      const close = find('_', index + 1);
      if (close !== -1
        && plain(value.slice(index + 1, close), /[_\n]/u)
        && !(close + 1 < length && WORD_CHARACTER.test(value[close + 1]))) {
        matched = { end: close + 1, type: 'emphasis', text: value.slice(index + 1, close) };
      }
    }
    if (matched === null) {
      index += 1;
      continue;
    }
    flush(index);
    tokens.push(token(matched.type, matched.text, matched.extra ?? {}));
    index = matched.end;
    textStart = index;
  }
  flush(length);
  return tokens.length > 0 ? tokens : [token('text', '')];
}

const block = (kind, start, end, extra = {}) => Object.freeze({ kind, start, end, ...extra });

function frontmatterBlock(all, index) {
  if (index !== 0 || all[0]?.text !== '---') return null;
  for (let cursor = 1; cursor < all.length; cursor += 1) {
    if (all[cursor].text === '---') {
      const entries = all.slice(1, cursor)
        .map((line) => {
          const split = line.text.indexOf(':');
          return split === -1
            ? { name: exposeInvisibleText(line.text), value: '' }
            : { name: exposeInvisibleText(line.text.slice(0, split)), value: exposeInvisibleText(line.text.slice(split + 1).trim()) };
        })
        .filter((entry) => entry.name.trim().length > 0);
      return { block: block('frontmatter', all[0].start, all[cursor].end, { entries: Object.freeze(entries) }), next: cursor + 1 };
    }
  }
  return null;
}

function fencedBlock(all, index) {
  if (!FENCE.test(all[index].text)) return null;
  const marker = all[index].text.slice(0, 3);
  for (let cursor = index + 1; cursor < all.length; cursor += 1) {
    if (all[cursor].text.startsWith(marker)) {
      const body = all.slice(index + 1, cursor).map((line) => line.text).join('\n');
      return { block: block('code', all[index].start, all[cursor].end, { text: exposeInvisibleText(body) }), next: cursor + 1 };
    }
  }
  const body = all.slice(index + 1).map((line) => line.text).join('\n');
  return { block: block('code', all[index].start, all.at(-1).end, { text: exposeInvisibleText(body) }), next: all.length };
}

function listBlock(all, index) {
  const items = [];
  let cursor = index;
  let ordered = null;
  while (cursor < all.length) {
    const bullet = BULLET.exec(all[cursor].text);
    const numbered = ORDERED.exec(all[cursor].text);
    if (bullet === null && numbered === null) break;
    const isOrdered = numbered !== null;
    if (ordered === null) ordered = isOrdered;
    else if (ordered !== isOrdered) break;
    const [, indent, , content] = isOrdered ? numbered : bullet;
    items.push(Object.freeze({ depth: Math.min(1, Math.floor(indent.length / 2)), tokens: inlineTokens(content) }));
    cursor += 1;
  }
  if (items.length === 0) return null;
  return { block: block(ordered ? 'ordered-list' : 'list', all[index].start, all[cursor - 1].end, { items: Object.freeze(items) }), next: cursor };
}

function quoteBlock(all, index) {
  let cursor = index;
  const collected = [];
  while (cursor < all.length && QUOTE.test(all[cursor].text)) {
    collected.push(all[cursor].text.replace(QUOTE, ''));
    cursor += 1;
  }
  if (collected.length === 0) return null;
  return { block: block('quote', all[index].start, all[cursor - 1].end, { tokens: inlineTokens(collected.join(' ')) }), next: cursor };
}

function paragraphBlock(all, index) {
  let cursor = index;
  const collected = [];
  while (cursor < all.length) {
    const line = all[cursor].text;
    if (line.trim().length === 0 || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || FENCE.test(line) || BULLET.test(line) || ORDERED.test(line)) break;
    collected.push(line);
    cursor += 1;
  }
  if (collected.length === 0) return null;
  return { block: block('paragraph', all[index].start, all[cursor - 1].end, { tokens: inlineTokens(collected.join(' ')) }), next: cursor };
}

function gapBlock(all, index) {
  let cursor = index;
  while (cursor < all.length && all[cursor].text.trim().length === 0) cursor += 1;
  if (cursor === index) return null;
  return { block: block('gap', all[index].start, all[cursor - 1].end), next: cursor };
}

export function markdownBlocks(text) {
  const all = lines(text);
  const blocks = [];
  let index = 0;
  while (index < all.length) {
    const produced = frontmatterBlock(all, index)
      ?? gapBlock(all, index)
      ?? fencedBlock(all, index)
      ?? (() => {
        const heading = HEADING.exec(all[index].text);
        if (heading === null) return null;
        return { block: block('heading', all[index].start, all[index].end, { level: heading[1].length, tokens: inlineTokens(heading[2]) }), next: index + 1 };
      })()
      ?? (RULE.test(all[index].text) ? { block: block('rule', all[index].start, all[index].end), next: index + 1 } : null)
      ?? quoteBlock(all, index)
      ?? listBlock(all, index)
      ?? paragraphBlock(all, index);
    if (produced === null) {
      blocks.push(block('paragraph', all[index].start, all[index].end, { tokens: inlineTokens(all[index].text) }));
      index += 1;
      continue;
    }
    blocks.push(produced.block);
    index = produced.next;
  }
  if (blocks.length === 0) return Object.freeze([]);
  const last = blocks.at(-1);
  if (last.end < text.length) blocks.push(block('gap', last.end, text.length));
  return Object.freeze(blocks.map((item, index) => {
    if (item.kind === 'gap') return Object.freeze({ ...item, uninterpreted: Object.freeze([]) });
    const slice = text.slice(item.start, item.end);
    const found = UNINTERPRETED.filter(([pattern]) => pattern.test(slice)).map(([, label]) => label);
    if (item.kind === 'paragraph') {
      // A paragraph directly followed by a dashes-only rule is a setext heading,
      // and a paragraph indented four or more spaces is an indented block. Both
      // sit outside the rung, so they degrade instead of reading as prose.
      const next = blocks[index + 1];
      const lastLineStart = slice.lastIndexOf('\n', slice.length - 2) + 1;
      if ((next?.kind === 'rule' && next.start === item.end && SETEXT_UNDERLINE.test(text.slice(next.start, next.end)))
        || (lastLineStart > 0 && SETEXT_EQUALS.test(slice.slice(lastLineStart)))) {
        found.push('setext heading');
      }
      if (INDENTED.test(slice)) found.push('indented block');
    }
    if (item.kind === 'frontmatter') {
      // Only flat `key: value` metadata is read; nested or list-valued YAML
      // would show as names with empty values, so it degrades instead.
      const body = slice.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
      body.shift();
      while (body.length > 0 && body.at(-1).trim().length === 0) body.pop();
      body.pop();
      if (body.some((line) => line.trim().length > 0 && !FRONTMATTER_ENTRY.test(line))) found.push('structured metadata');
    }
    return Object.freeze({ ...item, uninterpreted: Object.freeze(found) });
  }));
}
