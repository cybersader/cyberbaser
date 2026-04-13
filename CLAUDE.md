# Cyberbaser

> Tooling repo for **Cyberbase** — a distributed, contributable cybersecurity knowledge wiki built on Obsidian + GitHub.

## Read These First (in order)

When starting any Claude session in this repo:

1. **`.claude/PROJECT_CONTEXT.md`** — what cyberbaser is, who it's for, how it relates to sibling repos
2. **`.claude/FOCUS.md`** — current phase, what's active right now, what's explicitly out of scope
3. **`.claude/KNOWLEDGE_BASE_PHILOSOPHY.md`** — the living-KB pattern used across all Cybersader projects
4. **`.claude/00-INDEX.md`** — navigation to the numbered first-principles files (01 through 41)

Most questions about "what is this / where does this belong / what should I do" are answered by those four files.

## Current Phase

**Research & Foundations** 🔴 — see `.claude/20-ROADMAP.md`. No shipping-oriented implementation work until the `.claude/01-PROBLEM.md` through `.claude/12-PRINCIPLES.md` files have substantive content. The Phase-0 Astro + Starlight prototype in `docs/` exists and works, but it's parked — don't extend it without a principle to justify the extension.

## Repo Layout

```
cyberbaser/
├── .claude/              # Agent-first meta layer (read first, see above)
│   ├── PROJECT_CONTEXT.md
│   ├── FOCUS.md
│   ├── KNOWLEDGE_BASE_PHILOSOPHY.md
│   ├── DOCUMENTATION_STYLE.md
│   ├── RESEARCH_SOURCES.md
│   ├── 00-INDEX.md … 41-QUESTIONS-RESOLVED.md  # first-principles KB
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
├── .github/workflows/    # CI (deploy.yml → Cloudflare Pages)
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

## Key Invariants (candidate principles, see `.claude/12-PRINCIPLES.md`)

These are working hypotheses, not yet fully grounded. Treat them as constraints unless research explicitly overturns them.

1. **GitHub is the single source of truth.** The vault repo (`cybersader/cyberbase`) is authoritative.
2. **Obsidian semantics must round-trip.** Web edits must not corrupt Obsidian files and vice versa.
3. **Contributors shouldn't need to learn git.** Every contribution path must work independently.
4. **The vault is primary; cyberbaser is derivative.** If cyberbaser disappears, the vault still works.
5. **Research before implementation.** Code follows principles, not the other way around.

## The Critical Problem: Translation Layer

The hardest part of cyberbaser is converting Obsidian content to web without losing fidelity. The full treatment lives in `.claude/22-TRANSLATION-LAYER.md`. Short version of the tier system:

- **Tier 1 (Full)**: Wikilinks, callouts, embeds, code, math, Mermaid, tables
- **Tier 2 (Partial)**: Simple Dataview, block refs, aliases, frontmatter metadata
- **Tier 3 (None)**: Complex Dataview, Canvas, plugin-specific syntax

Any design decision anywhere in the project should be checked against the translation layer implications.

## Sibling Projects (Convention References)

- **cybersader/crosswalker** — most mature `.claude/` layout; the numbered-file convention here was copied from it
- **cybersader/cyberchaste** — source of `KNOWLEDGE_BASE_PHILOSOPHY.md` and `DOCUMENTATION_STYLE.md` (identical across both)
- **cybersader/agentic-workflow-and-tech-stack** — meta scaffold for agent workflows

## External Context

- **Live vault**: https://github.com/cybersader/cyberbase
- **Local research vault**: Obsidian vault, local research vault (local path varies by machine)
- **MCP / agent patterns**: `cybersader/agentic-workflow-and-tech-stack` sibling project

## Conventions

- **`.claude/` KB files**: `SCREAMING_SNAKE_CASE.md` (e.g., `TRANSLATION_LAYER.md`)
- **Numbered meta files**: `NN-TITLE.md` where NN groups by topic (00 index, 01-05 problem space, 10-12 vision/principles, 20-29 roadmap/architecture, 30-39 decisions, 40-49 questions)
- **Published wiki content** (inside `docs/src/content/docs/`): kebab-case topic folders, per Astro Starlight conventions
- **Research goes INTO files, not chat.** When researching a topic, update the relevant numbered file or create a new one in `docs/src/content/docs/research/`.

## Don't

- Extend the Phase-0 Astro site without a principle in `.claude/12-PRINCIPLES.md` that justifies the extension
- Write principles before the evidence in 01/02/04 justifies them
- Populate later roadmap phases with concrete steps while Phase R is still active
- Edit files in `.workspace/_archive-phase-0-docs/` — it's an archive, not a live doc source
