// OFM construct inventory: extract every construct instance from a document.
// This is the vocabulary the change classifier compares across versions.

export const CONSTRUCT_RES = {
  embed: /!\[\[[^\]]+\]\]/g,
  wikilink: /(?<!!)\[\[[^\]]+\]\]/g,
  callout: /^[ \t]*>[ \t]*\[![A-Za-z][\w-]*\][+-]?/gm,
  math_block: /\$\$[\s\S]+?\$\$/g,
  code_fence: /^```[^\n]*$/gm,
  footnote_ref: /\[\^[^\]]+\]/g,
  comment: /%%[\s\S]*?%%/g,
  block_id: /\^[A-Za-z0-9-]+$/gm,
  tag: /(?<=^|\s)#[A-Za-z][\w/-]*/gm,
};

/** Multiset inventory: construct type -> Map(exact text -> count). */
export function inventory(src) {
  const inv = {};
  for (const [name, re] of Object.entries(CONSTRUCT_RES)) {
    const m = new Map();
    for (const hit of src.matchAll(re)) {
      const key = hit[0];
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    inv[name] = m;
  }
  return inv;
}

/** Diff two inventories -> { removed, added } per construct type (multiset semantics). */
export function diffInventories(before, after) {
  const delta = {};
  for (const name of Object.keys(CONSTRUCT_RES)) {
    const b = before[name], a = after[name];
    const removed = [], added = [];
    for (const [text, count] of b) {
      const d = count - (a.get(text) ?? 0);
      for (let i = 0; i < d; i++) removed.push(text);
    }
    for (const [text, count] of a) {
      const d = count - (b.get(text) ?? 0);
      for (let i = 0; i < d; i++) added.push(text);
    }
    if (removed.length || added.length) delta[name] = { removed, added };
  }
  return delta;
}
