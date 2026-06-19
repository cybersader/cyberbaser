// OFM round-trip fidelity spike.
// Tests parse -> stringify === original across escalating pipeline configs,
// to find empirically WHERE the off-the-shelf remark stack corrupts OFM,
// and to prototype the custom handlers that close the gaps.
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMath from 'remark-math';
import remarkWikiLink from 'remark-wiki-link';
import { fixtures } from './fixtures.mjs';

// --- Config A: bare CommonMark (the naive baseline) ---
const cfgBaseline = unified().use(remarkParse).use(remarkStringify);

// --- Config B: + gfm, frontmatter, math (the obvious extensions) ---
const cfgExtended = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkMath)
  .use(remarkStringify);

// --- Config C: + remark-wiki-link (community wikilink plugin) ---
const cfgWiki = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkMath)
  .use(remarkWikiLink, { aliasDivider: '|' })
  .use(remarkStringify);

// --- Config D: markdown-first protection layer (the prototype) ---
// Hypothesis: protect OFM constructs the CommonMark parser mangles by masking
// them to placeholder text BEFORE parse, then restoring AFTER stringify.
// This is the cheap, lossless-by-construction approach: the bytes are never
// handed to a parser that would re-interpret them. A real impl uses micromark
// extensions; this proves the round-trip is achievable.
const OFM_PATTERNS = [
  // order matters: embeds (![[...]]) before wikilinks ([[...]])
  { re: /!\[\[[^\]]+\]\]/g },        // ![[embed]] / ![[embed|size]] / ![[note#sec]]
  { re: /\[\[[^\]]+\]\]/g },         // [[wikilink]] / [[a|b]] / [[a#h]] / [[a#^id]]
  { re: /\[![A-Za-z][\w-]*\]/g },    // [!note] / [!warning] callout markers
];
function mask(src) {
  const store = [];
  let out = src;
  for (const { re } of OFM_PATTERNS) {
    out = out.replace(re, (m) => {
      const token = `OFMMASK${store.length}OFMMASK`;
      store.push(m);
      return token;
    });
  }
  return { out, store };
}
function unmask(text, store) {
  let out = text;
  store.forEach((orig, i) => {
    out = out.replaceAll(`OFMMASK${i}OFMMASK`, orig);
  });
  return out;
}
function roundtripProtected(src) {
  const { out, store } = mask(src);
  const rendered = cfgExtended.processSync(out).toString();
  return unmask(rendered, store);
}

function rt(cfg, src) {
  try {
    return cfg.processSync(src).toString();
  } catch (e) {
    return `<<ERROR: ${e.message}>>`;
  }
}

// Normalize trailing whitespace differences that are cosmetic, not semantic.
const norm = (s) => s.replace(/\s+$/g, '');

function show(s) {
  return JSON.stringify(s);
}

const configs = [
  { key: 'A:baseline', run: (src) => rt(cfgBaseline, src) },
  { key: 'B:extended', run: (src) => rt(cfgExtended, src) },
  { key: 'C:wikilink', run: (src) => rt(cfgWiki, src) },
  { key: 'D:protected', run: (src) => roundtripProtected(src) },
];

const tally = Object.fromEntries(configs.map((c) => [c.key, { ok: 0, fail: 0 }]));
const rows = [];

for (const fx of fixtures) {
  const row = { name: fx.name };
  for (const c of configs) {
    const out = c.run(fx.src);
    const ok = norm(out) === norm(fx.src);
    row[c.key] = ok ? 'OK' : 'XX';
    tally[c.key][ok ? 'ok' : 'fail']++;
    if (!ok) row[`${c.key}_out`] = out;
  }
  rows.push(row);
}

// --- print results table ---
const w = (s, n) => String(s).padEnd(n);
console.log('\n=== OFM ROUND-TRIP FIDELITY SPIKE ===\n');
console.log(w('fixture', 22), configs.map((c) => w(c.key, 13)).join(''));
console.log('-'.repeat(22 + 13 * configs.length));
for (const r of rows) {
  console.log(w(r.name, 22), configs.map((c) => w(r[c.key], 13)).join(''));
}
console.log('-'.repeat(22 + 13 * configs.length));
console.log(
  w('TOT: ' + fixtures.length + ' fixtures', 22),
  configs.map((c) => w(`${tally[c.key].ok}/${fixtures.length}`, 13)).join('')
);

// --- show the corruptions for the best off-the-shelf config (C) ---
console.log('\n=== Where config C (best off-the-shelf) corrupts OFM ===\n');
for (const r of rows) {
  if (r['C:wikilink'] === 'XX') {
    const fx = fixtures.find((f) => f.name === r.name);
    console.log(`[${r.name}]`);
    console.log('  in : ' + show(fx.src));
    console.log('  out: ' + show(r['C:wikilink_out']));
  }
}

// --- confirm config D (protected) result ---
console.log('\n=== Config D (markdown-first protection) failures, if any ===\n');
let dFails = 0;
for (const r of rows) {
  if (r['D:protected'] === 'XX') {
    dFails++;
    const fx = fixtures.find((f) => f.name === r.name);
    console.log(`[${r.name}]`);
    console.log('  in : ' + show(fx.src));
    console.log('  out: ' + show(r['D:protected_out']));
  }
}
if (dFails === 0) console.log('(none — the protection layer round-trips every fixture)');
console.log('');
