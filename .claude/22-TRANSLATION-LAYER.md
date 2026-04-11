# 22 — The Translation Layer

> **Status**: 🌱 Skeleton. This is the hardest problem in the project. Most of the research effort in Phase R should land here.

The pipeline that converts Obsidian-flavored markdown into web-safe output while preserving round-trip editability (see `03-CONCEPTS.md`).

## Why This File Gets Its Own Number

Every other subsystem is solvable with off-the-shelf parts. The translation layer is where cyberbaser either succeeds or reduces to "yet another SSG aimed at Obsidian." Prioritize accordingly.

## Tier System (inherited from Phase-0 thinking, validate in research)

> This tier system was defined in the old CLAUDE.md before the reinit. Validate each entry — don't accept it uncritically.

### Tier 1 — Full Support (target for MVP)

Features that must round-trip cleanly between Obsidian, the web view, and the Web CMS:

- **Wikilinks** — `[[Page Name]]`, `[[Page Name|alias]]`
- **Callouts** — `> [!note]`, `> [!warning]`, etc.
- **Embeds** — `![[Image.png]]`, `![[Other Note]]`, `![[Other Note#Section]]`
- **Code blocks** — fenced, language-tagged
- **Math** — inline `$...$` and block `$$...$$`
- **Mermaid diagrams** — fenced ```mermaid blocks
- **Tables** — standard markdown tables

> TODO: for each of the above, document:
> - The exact source syntax
> - The target HTML/MDX output
> - The reverse transform (how the CMS round-trips an edit)
> - Known edge cases
> - Which remark/rehype plugin handles it (or "bespoke")

### Tier 2 — Partial Support (best effort)

Features that render *something* but may lose fidelity or require fallbacks:

- **Simple Dataview** — `LIST FROM #tag`, `TABLE ... FROM ...` with straightforward queries
- **Block references** — `[[Note#^block-id]]`
- **Aliases** (frontmatter `aliases:` field)
- **Frontmatter metadata** exposed as page properties

> TODO: for each, document what "partial" means precisely. A Tier 2 feature should never silently corrupt a round-trip edit.

### Tier 3 — Not Supported (document the workaround)

Features that cyberbaser will not translate, with a documented alternative:

- **Complex Dataview** queries with JS, custom views
- **Canvas** files (`.canvas`)
- **Plugin-specific syntax** (Templater, Dataview JS, etc.)
- **Graph view** (inherently interactive)

> TODO: for each Tier 3 feature, either (a) document the contributor-facing workaround, or (b) propose degrading it to a Tier 2 approximation.

## Round-Trip Correctness Test Suite (TODO)

> The single most important artifact this file should eventually produce is a test corpus: for each Tier 1/2 feature, a fixture vault page plus its expected web output plus a "Web CMS edit → vault diff" snapshot. Without this, "round-trip" is an aspiration instead of a property.

## Open Research Questions

> Migrate these to `40-QUESTIONS-OPEN.md` when they become blockers.

1. Is `astro-loader-obsidian` (currently a dep) sufficient, or does it need augmentation / replacement?
2. Does the Web CMS need to render Obsidian preview, or can it stay raw-markdown?
3. How do embeds render in the CMS, given that the CMS can't resolve `![[...]]` without access to the whole vault?
4. What's the authoring story for callouts in the Web CMS — raw syntax, or a rich editor widget?
5. How do we guarantee no lossy transform, practically? (Property-based tests? Diffing?)

## Reference Material

- Obsidian Flavored Markdown spec: https://help.obsidian.md/Editing+and+formatting/Obsidian+Flavored+Markdown
- unified/remark ecosystem: https://unifiedjs.com/
- remark-wiki-link: https://github.com/landakram/remark-wiki-link
- Old notes mining target: `.workspace/_archive-phase-0-docs/areas/cyberbase-translation-layer.md`
