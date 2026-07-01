# 22 — Translation Layer

> **Status**: ✅ Superseded. The canonical, maintained version of this content is the docs page below. This stub keeps the key facts greppable and points there. **Do not extend this file; edit the docs page instead.**
>
> **Canonical**: `docs/src/content/docs/design/translation-layer.mdx` · published at `/cyberbaser/design/translation-layer/`

## Current truth (summary, 2026-06-21)

- The hardest, most load-bearing problem: round-tripping markdown between authoring tools and the web without loss. Obsidian-flavored markdown is the first-class case; the layer is surface- and renderer-agnostic (remark/rehype today, on Astro in the current prototype only).
- **Tier 1** (must round-trip): wikilinks, callouts, embeds, code, math, Mermaid, tables. **Tier 2** (partial, never lossy): simple Dataview, block refs, aliases, frontmatter. **Tier 3** (documented workaround): Canvas, DataviewJS, graph.
- **Keystone proven:** the `spikes/ofm-roundtrip/` spike round-tripped 20/21 fixtures via a markdown-first path (mdast-util-to-markdown + CodeMirror 6 is the leading candidate stack).
