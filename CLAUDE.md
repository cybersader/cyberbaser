# Cyberbaser

> **An interoperability layer for contributable, version-controlled knowledge bases.** It sits between authoring tools (Obsidian first-class, any markdown surface), swappable renderers, and — eventually — other knowledge bases. General, not a cyber tool: the `cybersader/cyberbase` vault is the first dogfood content, not the scope.

## Read These First (in order)

When starting any Claude session in this repo:

1. **`.claude/PROJECT_CONTEXT.md`** — the locked identity, hard constraints, knowledge-ops map, sibling repos
2. **`.claude/FOCUS.md`** — current state, what's locked, what's next, what's out of scope
3. **`.claude/KNOWLEDGE_BASE_PHILOSOPHY.md`** — the living-KB pattern used across all Cybersader projects
4. **`.claude/00-INDEX.md`** — how the two-layer KB works + the stub → canonical-page map

Most questions about "what is this / where does this belong / what should I do" are answered by those four files.

**Knowledge-ops rule:** the **canonical KB is the docs site** (`docs/src/content/docs/` — problem, principles, vision, architecture, research). The `.claude/` layer orients agents and points there. When a decision gets locked, update `.claude/` (FOCUS, 41-QUESTIONS-RESOLVED, PROJECT_CONTEXT if direction changed) **in the same session** — a stale orientation layer sends fresh agents in an old direction.

## Current Phase

**Research & Foundations** 🔴 — see `.claude/20-ROADMAP.md`. The foundational content is written (the docs pages for problem through principles are substantive and vision-swept); the **open gate is external validation** — confirming real demand and running the cheap falsification tests in `.claude/FOCUS.md`. No CMS/auth/editor implementation until then. The Phase-0 Astro + Starlight prototype in `docs/` publishes the research and is otherwise parked — don't extend it without a principle to justify the extension.

## Repo Layout

```
cyberbaser/
├── .claude/              # Agent-first meta layer (read first, see above)
│   ├── PROJECT_CONTEXT.md
│   ├── FOCUS.md
│   ├── KNOWLEDGE_BASE_PHILOSOPHY.md
│   ├── DOCUMENTATION_STYLE.md
│   ├── RESEARCH_SOURCES.md
│   ├── 00-INDEX.md … 41-QUESTIONS-RESOLVED.md  # pointer stubs → canonical docs pages + the decision log
│   └── settings.local.json
│
├── .workspace/           # Personal scratch (folder tracked, contents ignored)
│   └── _archive-phase-0-docs/   # Old PARA dev docs, mine or delete
│
├── docs/                 # Astro + Starlight publish pipeline (the wiki itself)
│   ├── astro.config.mjs
│   ├── package.json
│   ├── src/content/docs/
│   ├── tests/            # Playwright E2E
│   └── …
│
├── .github/workflows/    # CI (deploy.yml → GitHub Pages via actions/deploy-pages@v4)
├── CLAUDE.md             # This file
└── README.md
```

## Running the Docs Site

```bash
cd docs
bun install
bun run dev          # http://localhost:4321/
bun run build        # Production build
bun run test:e2e     # Playwright tests
```

## Key Invariants (the six principles, canonical: `docs/src/content/docs/getting-started/principles.mdx`)

Grounded and justified on the principles page; treat as hard constraints unless new evidence overturns them.

1. **A single source of truth you own.** One authoritative, version-controlled copy (a git repo today — the current manifestation, not the essence; contributors are never forced onto git).
2. **Authoring semantics must round-trip.** Web edits must not corrupt vault files and vice versa (Obsidian is the first-class case). Proven feasible: `spikes/ofm-roundtrip/`, 20/21.
3. **Contributors shouldn't need to learn git.** Contribution = maintainer-set trust curve + moderation queue; accounts optional, never a wall.
4. **Every contribution path works independently.** Web CMS, Obsidian+Git, direct GitHub; no path is a client of another.
5. **The vault is primary; cyberbaser is derivative.** If cyberbaser disappears, the vault still works.
6. **Research before implementation.** Code follows principles, not the other way around.

Plus two architecture constraints: **the hub is renderer-agnostic** (SSGs are swappable spokes; never couple to one) and **no hyperscalers** (GitHub Pages current host, Cloudflare edge-only, self-hosted Forgejo preferred for identity).

## The Critical Problem: Translation Layer

The hardest part of cyberbaser is round-tripping markdown between authoring tools and the web without loss. The full treatment lives in `docs/src/content/docs/design/translation-layer.mdx` (stub: `.claude/22-TRANSLATION-LAYER.md`). Short version of the tier system:

- **Tier 1 (Full)**: Wikilinks, callouts, embeds, code, math, Mermaid, tables
- **Tier 2 (Partial)**: Simple Dataview, block refs, aliases, frontmatter metadata
- **Tier 3 (None)**: Complex Dataview, Canvas, plugin-specific syntax

Any design decision anywhere in the project should be checked against the translation layer implications.

## Sibling Projects (Convention References)

- **cybersader/crosswalker** — most mature `.claude/` layout; the numbered-file convention here was copied from it
- **cybersader/cyberchaste** — source of `KNOWLEDGE_BASE_PHILOSOPHY.md` and `DOCUMENTATION_STYLE.md` (identical across both)
- **cybersader/agentic-workflow-and-tech-stack** — meta scaffold for agent workflows
- **Retake Forge** — Obsidian in the browser (strategically adjacent: a potential authoring spoke for the web-edit path)
- **Sinario** — cyber scenarios tooling (content-adjacent)

## External Context

- **Live vault**: https://github.com/cybersader/cyberbase
- **Local research vault**: Obsidian vault, local research vault (local path varies by machine)
- **MCP / agent patterns**: `cybersader/agentic-workflow-and-tech-stack` sibling project

## Conventions

- **`.claude/` KB files**: `SCREAMING_SNAKE_CASE.md` (e.g., `TRANSLATION_LAYER.md`)
- **Numbered meta files**: `NN-TITLE.md` where NN groups by topic (00 index, 01-05 problem space, 10-12 vision/principles, 20-29 roadmap/architecture, 30-39 decisions, 40-49 questions)
- **Published wiki content** (inside `docs/src/content/docs/`): kebab-case topic folders, per Astro Starlight conventions
- **Research goes INTO files, not chat.** New findings go to the canonical docs page (or a new page in `docs/src/content/docs/research/`); locked decisions also land in `.claude/41-QUESTIONS-RESOLVED.md`, and in `FOCUS.md`/`PROJECT_CONTEXT.md` if they change direction.

## Writing style

- **Use em-dashes sparingly.** They're fine occasionally for genuine emphasis or an aside, but don't reach for them as the default connector. Prefer commas, periods, colons, or parentheses. Two em-dashes in a paragraph is usually one too many. Applies to docs content and chat.
- Prefer plain, concrete language over clever section titles. If a heading needs a beat to parse, rename it.
- Don't over-anchor on Obsidian: cyberbaser is for markdown knowledge bases in general; Obsidian is a first-class surface, not the whole point or the only one.

## Starlight component layout (read before building any multi-column visual)

Custom flex/grid components inside `.sl-markdown-content` keep coming out lopsided ("the left box is taller," "a column overflows"). Three causes, fix them by default instead of rediscovering them:

1. **Starlight injects `margin-top` onto consecutive flow elements; this is the one that "comes back like the plague."** That margin lands on the children of your flex/grid containers, and the first child is spared, so the 2nd and 3rd items get shoved down and equal-height breaks. Neutralize it on the container's children: `.sl-markdown-content :is(<your-container-classes>) > * { margin-top: 0; }` (class-level specificity beats Starlight's injection), then let the component space itself with `gap` and `padding`. See the `cb-dial-bar` / `cb-step` block in `brand.css` for the live example.
2. **Flex children default to `min-width: auto`** and refuse to shrink below their content. A long URL or wide mockup then forces the row wider. Put `min-width: 0` on every flex child, plus `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` for long unbreakable text.
3. **Never cap one column's `max-width` while leaving its sibling uncapped.** For balanced columns use `display: grid; grid-template-columns: repeat(N, minmax(0, 1fr))` (the `minmax(0, …)` is what lets them actually shrink) and stack to `1fr` under ~640px.

When unsure, verify instead of guessing: serve the built site and measure the boxes headless with `getBoundingClientRect` (that is how the trust dial was pinned down), rather than eyeballing a screenshot.

## Don't

- Extend the Phase-0 Astro site without a principle (canonical: `getting-started/principles.mdx`) that justifies the extension
- Relitigate the locked decisions in `.claude/FOCUS.md` / `41-QUESTIONS-RESOLVED.md` without new evidence
- Start CMS/auth/editor implementation before the demand-validation gate in FOCUS.md is passed
- Populate later roadmap phases with concrete steps while Phase R is still active
- Let the `.claude/` orientation layer drift: locked decisions propagate there in the same session
- Edit files in `.workspace/_archive-phase-0-docs/` — it's an archive, not a live doc source
