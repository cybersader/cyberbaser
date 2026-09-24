import { exposeInvisibleText } from './invisible-text.js';

const FENCE = /^(?:```|~~~)/u;
const HEADING = /^(#{1,6})\s+(.*)$/u;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/u;
const QUOTE = /^>\s?/u;
const BULLET = /^(\s{0,3})([-*+])\s+(.*)$/u;
const ORDERED = /^(\s{0,3})(\d{1,9})[.)]\s+(.*)$/u;
const UNINTERPRETED = Object.freeze([
  [/!\[\[/u, 'note or image embed'],
  [/^\s*>\s*\[!/mu, 'callout'],
  [/^\s*\|.*\|\s*$/mu, 'table'],
  [/\$\$|(?<!\\)\$[^$\n]+\$/u, 'math'],
  [/^(?:```|~~~)\s*(?:mermaid|dataview|dataviewjs)/imu, 'renderer-executed block'],
  [/^\s*[-*+]\s+\[[ xX]\]/mu, 'task list'],
  [/\[\^[^\]\s]+\]/u, 'footnote'],
  [/<\/?[a-zA-Z][^>]*>/u, 'inline HTML'],
  [/%%/u, 'Obsidian comment'],
  [/\^[A-Za-z0-9-]{3,}\s*$/mu, 'block reference'],
]);
const INLINE = /(`[^`\n]+`)|(\[\[[^\]\n]+\]\])|(\[[^\]\n]*\]\([^)\s]*\))|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)/u;

function lines(text) {
  const result = [];
  let start = 0;
  while (start <= text.length) {
    const index = text.indexOf('\n', start);
    if (index === -1) {
      if (start < text.length) result.push({ start, end: text.length, text: text.slice(start) });
      break;
    }
    result.push({ start, end: index + 1, text: text.slice(start, index) });
    start = index + 1;
  }
  return result;
}

function token(type, text, extra = {}) {
  return Object.freeze({ type, text: exposeInvisibleText(text), ...extra });
}

export function inlineTokens(value) {
  const tokens = [];
  let rest = value;
  while (rest.length > 0) {
    const match = INLINE.exec(rest);
    if (match === null || match.index === undefined) { tokens.push(token('text', rest)); break; }
    if (match.index > 0) tokens.push(token('text', rest.slice(0, match.index)));
    const [found] = match;
    if (found.startsWith('`')) tokens.push(token('code', found.slice(1, -1)));
    else if (found.startsWith('[[')) {
      const inner = found.slice(2, -2);
      const [target, alias] = inner.split('|');
      tokens.push(token('wikilink', alias ?? target, { target: exposeInvisibleText(target) }));
    } else if (found.startsWith('[')) {
      const split = found.indexOf('](');
      tokens.push(token('link', found.slice(1, split), { target: exposeInvisibleText(found.slice(split + 2, -1)) }));
    } else if (found.startsWith('**')) tokens.push(token('strong', found.slice(2, -2)));
    else tokens.push(token('emphasis', found.slice(1, -1)));
    rest = rest.slice(match.index + found.length);
  }
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
  return Object.freeze(blocks.map((item) => {
    if (item.kind === 'gap') return Object.freeze({ ...item, uninterpreted: Object.freeze([]) });
    const slice = text.slice(item.start, item.end);
    const found = UNINTERPRETED.filter(([pattern]) => pattern.test(slice)).map(([, label]) => label);
    return Object.freeze({ ...item, uninterpreted: Object.freeze(found) });
  }));
}
