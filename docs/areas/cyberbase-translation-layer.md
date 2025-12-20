# Translation Layer

**Status**: Living Document - The Critical Problem

---

## Overview

The translation layer converts Obsidian-flavored Markdown into web-compatible formats. This is the hardest part of the system because Obsidian's plugin ecosystem creates content that may not be representable on the web.

## Feature Support Tiers

### Tier 1: Full Support

These features are fully converted to web equivalents:

| Obsidian Feature | Web Equivalent | Implementation |
|------------------|----------------|----------------|
| `[[wikilinks]]` | `/path/to/page` | remark-wiki-link or custom |
| `[[link\|alias]]` | `<a href="...">alias</a>` | Custom transformer |
| `![[embeds]]` | Inline content | Resolve at build time |
| `#tags` | Tag index pages | Frontmatter extraction |
| Frontmatter YAML | Astro Content Schema | Zod validation |
| Standard Markdown | Standard Markdown | Pass-through |
| Callouts `> [!type]` | Styled blockquotes | remark-callouts |
| Code blocks | Syntax highlighted | Shiki |
| Math (LaTeX) | KaTeX | remark-math |
| Mermaid diagrams | Rendered SVG | Build-time render |

### Tier 2: Partial Support

These features work with limitations:

| Obsidian Feature | Web Behavior | Limitation |
|------------------|--------------|------------|
| Dataview (simple) | Static snapshot | No dynamic updates |
| Block references `^id` | Anchor links | Syntax converted |
| Heading links | Auto-generated slugs | Must match slug format |
| Folder notes | Index pages | Convention required |
| Aliases | Redirect pages | SEO considerations |

### Tier 3: No Support

These features cannot be replicated:

| Obsidian Feature | Web Behavior | Resolution |
|------------------|--------------|------------|
| Dataview (complex) | Warning placeholder | "Dynamic content - view in Obsidian" |
| Dataview JS | Stripped | Build warning |
| Tasks plugin | Static checkbox | No interactivity |
| Templater | Already expanded | N/A (pre-processed) |
| Canvas | Link to Obsidian | Not web-renderable |
| Custom CSS snippets | Theme mismatch | Web theme applies |
| Plugin-specific syntax | Stripped | Build-time warnings |

## Translation Pipeline

```
Input: Obsidian Markdown File
        │
        ▼
┌─────────────────────────────────────┐
│ STAGE 1: PARSE                      │
│ - Extract frontmatter (gray-matter) │
│ - Parse markdown to AST (remark)    │
│ - Identify Obsidian-specific syntax │
└───────────────┬─────────────────────┘
                │
                ▼
┌─────────────────────────────────────┐
│ STAGE 2: RESOLVE                    │
│ - Build link resolution map         │
│ - Filename → path index             │
│ - Alias → canonical path            │
│ - Handle ambiguous links            │
└───────────────┬─────────────────────┘
                │
                ▼
┌─────────────────────────────────────┐
│ STAGE 3: TRANSFORM                  │
│ - Wikilinks → HTML links            │
│ - Embeds → inline content           │
│ - Callouts → styled divs            │
│ - Dataview → static output          │
└───────────────┬─────────────────────┘
                │
                ▼
┌─────────────────────────────────────┐
│ STAGE 4: VALIDATE                   │
│ - Frontmatter schema (Zod)          │
│ - Broken link detection             │
│ - Unsupported syntax warnings       │
└───────────────┬─────────────────────┘
                │
                ▼
┌─────────────────────────────────────┐
│ STAGE 5: EMIT                       │
│ - Generate Astro-compatible MD      │
│ - JSON index for search             │
│ - Backlinks data                    │
│ - Graph data (nodes + edges)        │
└─────────────────────────────────────┘
```

## Implementation Options

### Option A: astro-loader-obsidian

- Existing library: https://github.com/aitorllj93/astro-loader-obsidian
- Handles basic wikilinks, embeds, frontmatter
- May need extension for full Tier 1 support

### Option B: Custom remark Pipeline

Build custom unified/remark plugins:
- `remark-obsidian-wikilinks`
- `remark-obsidian-callouts`
- `remark-obsidian-embeds`
- `remark-dataview-static`

### Option C: Hybrid

Use astro-loader-obsidian as base, extend with custom plugins for gaps.

**Recommended**: Start with Option A, identify gaps, extend as needed (Option C).

## CMS Editor Constraints

The Web CMS must prevent Tier 2/3 syntax:

**Allowed in Editor:**
- Standard markdown
- Internal links via picker (no raw wikilink syntax)
- Images, callouts, code blocks
- Frontmatter via form fields

**Blocked in Editor:**
- Raw wikilink syntax (use picker)
- Dataview code blocks
- Embed syntax
- Block references
- Custom HTML/JavaScript

**Visible but Read-Only:**
- Existing Dataview (shown as rendered output)
- Existing embeds (shown as linked reference)
- Complex plugin content (with "Obsidian-only" badge)

## Open Questions

1. How to handle cross-vault links in future federation?
2. Should Dataview results be cached or regenerated each build?
3. How to handle wikilinks to non-existent pages (red links)?

## Related Documents

- `cyberbase-architecture.md` - Overall system design
- `research-astro-obsidian-integration.md` - Detailed research on Astro + Obsidian
