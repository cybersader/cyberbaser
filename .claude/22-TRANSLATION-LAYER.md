# 22 — Translation Layer

> **Status**: ✅ Superseded. The canonical, maintained version of this content is the docs page below. This stub keeps the key facts greppable and points there. **Do not extend this file; edit the docs page instead.**
>
> **Canonical**: `docs/src/content/docs/design/translation-layer.mdx` · published at `/cyberbaser/design/translation-layer/`

## Current truth (summary, 2026-08-10)

- The translation layer separates two jobs: render authoring semantics through replaceable output spokes, and return accepted external changes without regenerating untouched source.
- The 20/21 fixture spike proved that masking protected tested Obsidian-flavored Markdown constructs through parsing. The 1,430-file R12 gate then measured only 4.6% byte identity and disproved whole-file parse/stringify as a safe source-write mechanism.
- **Fixed write boundary:** a conforming external adapter reads a pinned source base, maps intended edits to bounded source operations, fails closed on stale or ambiguous mapping, and preserves every byte outside those operations by construction. `@cyberbaser/ofm` classifies damage and never writes.
- **Interface freedom:** a browser editor may parse, render, use blocks, or provide WYSIWYG controls. R12 constrains its proposal output, not its presentation. The shared `@cyberbaser/proposal` contract now covers one existing Markdown file and one exact quote- or offset-bound splice. Multi-splice, source-map, structural, new-page, asset, and rich-editor lane work remains unbuilt.
- Rendering support still has tiers: common Markdown/OFM constructs render fully, partial constructs must remain non-lossy, and unsupported runtime features need documented workarounds.
