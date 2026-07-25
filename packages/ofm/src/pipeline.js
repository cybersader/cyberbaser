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

/**
 * Diagnostic round-trip: mask -> parse -> stringify -> unmask.
 * Returns { out, maskLeak }. Byte-inequality of `out` vs the input is EXPECTED
 * on most real files (measured 4.6% identity over 1430 vault files, R12) —
 * that is why this is a diagnostic, not a gate.
 */
export function roundtrip(src, pipeline = defaultPipeline) {
  const { text, store } = mask(src);
  const rendered = pipeline.processSync(text).toString();
  const out = unmask(rendered, store);
  return { out, maskLeak: hasMaskLeak(out) };
}

/** Trailing-whitespace-insensitive comparison (the spike's `norm`). */
export function normEqual(a, b) {
  const n = (s) => s.replace(/\s+$/gm, '').replace(/\n+$/, '');
  return n(a) === n(b);
}
