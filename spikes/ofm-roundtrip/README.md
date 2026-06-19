# OFM round-trip fidelity spike

The keystone gate. The [v1 architecture findings](../../docs/src/content/docs/research/v1-architecture.mdx)
named a **lossless Obsidian-Flavored-Markdown round-trip** as cyberbaser's value moat, and the
completeness critic flagged it as *asserted-safe but never tested.* This spike tests it empirically.

**Question:** does `parse → mdast → stringify === original` for the hardest OFM constructs, and if not,
exactly where does it break and how cheaply can it be fixed?

## Run it

```bash
cd spikes/ofm-roundtrip
bun install
bun roundtrip.mjs
```

## Method

21 fixtures covering every Tier-1 OFM feature plus the hard cases (wikilink aliases, heading/block
references, `![[embeds]]`, nested callouts, `$$math$$`, dollar-ambiguity, hex-in-code, frontmatter).
Each is round-tripped through four escalating pipelines and compared byte-for-byte (trailing
whitespace normalized):

- **A · baseline** — bare `remark-parse` + `remark-stringify` (CommonMark)
- **B · extended** — + `remark-gfm` + `remark-frontmatter` + `remark-math`
- **C · wikilink** — + `remark-wiki-link`
- **D · protected** — a ~10-line **markdown-first protection layer**: mask OFM constructs
  (`![[...]]`, `[[...]]`, `[!type]`) to inert placeholders *before* parse, restore *after* stringify,
  so the bytes are never handed to a parser that would re-interpret them.

## Results

| Pipeline | Score | What it fixes |
|---|---|---|
| A · baseline (CommonMark) | **6/21** | nothing OFM-specific; escapes every bracket construct |
| B · + gfm/frontmatter/math | **8/21** | `$$math$$`, frontmatter |
| C · + remark-wiki-link | **12/21** | `[[wikilinks]]` (all variants) — but **not** `![[embeds]]` (it escapes them) |
| D · markdown-first protection | **20/21** | wikilinks **and** embeds **and** simple/title/foldable callouts |

## Findings

1. **The corruption is exactly one mechanism: bracket-escaping.** The CommonMark parser doesn't know
   OFM constructs, so `remark-stringify` escapes them: `[[x]]`→`\[\[x]]`, `![[x]]`→`!\[\[x]]`,
   `[!note]`→`\[!note]`. Everything that survives (math, Mermaid, tables, code, frontmatter, tags) does
   so because it's either standard or covered by an extension.

2. **`remark-wiki-link` handles `[[links]]` but not `![[embeds]]`** — it round-trips wikilinks but
   still escapes the embed form. So the off-the-shelf stack tops out at 12/21.

3. **A trivial markdown-first protection layer reaches 20/21.** Masking the three bracket constructs
   before parse and restoring after stringify is lossless by construction (the parser never touches
   them). ~10 lines of regex. This validates the v1 CMS plan (raw-markdown mode that treats OFM tokens
   as opaque) *and* the markdown-first serialization thesis for the future block editor.

4. **The one genuine remaining gap is nested callouts — and it's reflow, not data loss.**
   `> [!note] Outer\n> > [!info] Inner` comes back as `> [!note] Outer\n>\n> > [!info] Inner` — remark
   inserts a blank `>` line between a blockquote's content and a nested blockquote. The brackets are
   preserved; only blockquote *spacing* changes, and Obsidian still renders it as a nested callout. To
   make it byte-identical you need either a custom `remark-stringify` blockquote handler or first-class
   callout AST nodes (the "real" approach). Until then it's a candidate to classify as
   *semantically-equivalent* rather than corruption.

## Verdict

**The keystone moves from `NEEDS-PROTOTYPE` to `ACHIEVABLE, gap precisely bounded.`** Lossless OFM
round-trip is real: a crude protection layer already hits 20/21, and the single holdout is cosmetic
blockquote reflow, not lost content. The remaining engineering is narrow and known:

- **Embeds** (`![[...]]`) — need their own serializer (the wikilink plugin doesn't cover them).
- **Nested callouts** — need a blockquote-spacing-preserving stringify, or first-class callout nodes.
- **Block-ID transclusion** (`![[note#^id]]`) — resolves *as a link/embed* losslessly here, but
  *rendering* the referenced block still needs the multi-pass vault resolver (a separate v2 problem).

## Caveats (what this does and does NOT prove)

- It proves **serialization fidelity** (bytes survive a parse/stringify cycle) — the core technical
  risk the critic flagged. It does **not** prove the **editor UX**: a real block/WYSIWYG editor must
  also *render and edit* these constructs, which is downstream and harder.
- The protection-layer is a proof-of-achievability, not the production design. The production path is
  micromark extensions / first-class AST nodes (per the research: `mdast-util-to-markdown` handlers,
  `mdast-util-directive` pattern for callouts, CodeMirror 6 as the editor).
- Equivalence here is byte-identical. Some "failures" (nested-callout reflow) are semantically
  equivalent; a real fixture suite should define per-feature equivalence rules
  (see [Challenge 05](../../docs/src/content/docs/agent-context/zz-challenges/05-translation-equivalence.mdx)).
