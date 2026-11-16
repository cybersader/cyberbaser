// The reference remark pipeline (spike "config D" without the wiki-link plugin,
// because masking removes the need for it). Used by the round-trip DIAGNOSTIC
// only — per R12, nothing in any write path may re-serialize a whole file.
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMath from 'remark-math';
import { mask, unmask, hasMaskLeak } from './mask.js';

export function makePipeline(stringifyOptions = {}) {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkMath)
    .use(remarkStringify, stringifyOptions);
}

const defaultPipeline = makePipeline();

export class RoundtripContentLossError extends Error {
  constructor(message) {
    super(`checker error: round-trip lost non-whitespace content (${message})`);
    this.name = 'RoundtripContentLossError';
  }
}

// Compare parsed content, not Markdown delimiters: a serializer may legitimately
// change emphasis, entities or list punctuation, but must not drop text, code,
// math, frontmatter, link destinations, image labels or other content payloads.
function contentText(tree) {
  const chunks = [];
  function visit(node) {
    for (const key of ['value', 'url', 'title', 'alt', 'lang', 'meta', 'label']) {
      if (typeof node[key] === 'string') chunks.push(node[key].replace(/\s/gu, ''));
    }
    for (const child of node.children ?? []) visit(child);
  }
  visit(tree);
  return chunks.join('');
}

function assertContentRetained(original, rendered) {
  const before = [...contentText(original)], after = contentText(defaultPipeline.parse(rendered));
  let retained = 0;
  for (const ch of after) if (ch === before[retained]) retained++;
  if (retained !== before.length) {
    throw new RoundtripContentLossError('content no longer retained in source order');
  }
}

function sourceBullet(tree, src) {
  if (tree.type === 'list' && !tree.ordered) {
    const offset = tree.children[0]?.position.start.offset;
    if (offset !== undefined) return src[offset];
  }
  for (const child of tree.children ?? []) {
    const marker = sourceBullet(child, src);
    if (marker) return marker;
  }
}

/**
 * Diagnostic round-trip: mask -> parse -> stringify -> unmask.
 * Returns { out, maskLeak }. Byte-inequality is EXPECTED on most real files.
 * The default serializer adopts the source's first unordered-list marker;
 * an explicitly supplied pipeline retains its own stringify options.
 * Lost content (including completely missing mask tokens) throws a checker
 * error instead of passing a broken diagnostic. This is never a write path.
 */
export function roundtrip(src, pipeline) {
  const { text, store } = mask(src);
  const original = defaultPipeline.parse(text);
  const bullet = sourceBullet(original, text);
  const activePipeline = pipeline ?? (bullet ? makePipeline({ bullet }) : defaultPipeline);
  const rendered = activePipeline.processSync(text).toString();
  assertContentRetained(original, rendered);
  // A missing token is not a "leak": there would be no sentinel left to see.
  for (let i = 0; i < store.length; i++) {
    if (!rendered.includes(`${i}`)) throw new RoundtripContentLossError(`missing mask token ${i}`);
  }
  const out = unmask(rendered, store);
  return { out, maskLeak: hasMaskLeak(out) };
}

/** Trailing-whitespace-insensitive comparison (the spike's `norm`). */
export function normEqual(a, b) {
  const n = (s) => s.replace(/\s+$/gm, '').replace(/\n+$/, '');
  return n(a) === n(b);
}
