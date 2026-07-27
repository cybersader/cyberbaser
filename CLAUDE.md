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

**v1 Build** — see `.claude/20-ROADMAP.md` and the canonical [Direction](docs/src/content/docs/getting-started/direction.mdx) page. The current product interpretation is an **owner-controlled change boundary** around a version-controlled knowledge base: publication selection, exact byte-preserving candidate changes, integrity/trust classification, and owner decision. GitHub, Actions, Pages, and pinned Quartz are the current dogfood infrastructure, not the product essence.

The immediate milestone is the precommitted five-reader, one-independent-owner concierge human-correction pilot. `@cyberbaser/correction` is its no-I/O exact-anchor and single-splice primitive, not a shipped editor, endpoint, automatic writer, or account-free product path. Do not build account-free automation until the pilot's fixed thresholds produce evidence.

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

1. **A single source of truth you own.** One authoritative, version-controlled copy. Git and GitHub are the current dogfood manifestation, not the essence or a requirement for the general maintainer.
2. **Authoring semantics and untouched bytes survive edits.** No whole-file re-serialization in a write path. Accepted changes use exact raw-text splices; `@cyberbaser/ofm` validates and never writes.
3. **Contributors shouldn't need git or a forced account.** The current GitHub path does not satisfy this. Contribution safety is owner review plus a maintainer-set trust curve, not an identity wall.
4. **Every offered contribution path works independently.** This does not mandate three paths or a Web CMS. Today the local maintainer path and GitHub editor exist; account-free intake is under a bounded concierge experiment.
5. **The vault is primary; cyberbaser is derivative.** If cyberbaser disappears, the vault still works.
6. **Research before implementation.** Code follows principles and measured evidence, not the other way around.

Plus two architecture constraints: **the hub is renderer-agnostic** (SSGs are swappable spokes; never couple to one) and **no hyperscalers** (GitHub Pages current host, Cloudflare edge-only, self-hosted Forgejo preferred for identity).

## The Critical Boundary: Exact Changes Without Re-serialization

The deciding measurement showed that whole-file markdown re-serialization preserved exact bytes for only 4.6% of the real vault. The write-path rule is therefore fixed: preserve untouched bytes by construction and apply only exact raw-text splices. The full treatment lives in `docs/src/content/docs/design/translation-layer.mdx` (stub: `.claude/22-TRANSLATION-LAYER.md`).

`@cyberbaser/ofm` classifies whether a before/after change damages authoring semantics. `@cyberbaser/correction` resolves one exact UTF-8 quote and prepares/applies one base-bound candidate splice in memory. Neither is a whole-file writer, and the correction core performs no file I/O. Any future editing surface must conform to this boundary.

## Sibling Projects (Convention References)

- **cybersader/crosswalker** — most mature `.claude/` layout; the numbered-file convention here was copied from it
- **cybersader/cyberchaste** — source of `KNOWLEDGE_BASE_PHILOSOPHY.md` and `DOCUMENTATION_STYLE.md` (identical across both)
- **cybersader/agentic-workflow-and-tech-stack** — meta scaffold for agent workflows
- **A private browser-Obsidian sibling** — strategically adjacent (a potential trusted-contributor authoring surface, and the owner of mixed-privacy/RBAC/real-time scope). Tracked privately; details in `.workspace/sibling-boundary-analysis.md` (gitignored). An earlier version of this file misattributed this role to Retake Forge, which is unrelated.
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

- Turn the Astro + Starlight docs site into the product surface without a principle and explicit decision
- Relitigate the locked decisions in `.claude/FOCUS.md` / `41-QUESTIONS-RESOLVED.md` without new evidence
- Build a Web CMS or place any whole-file serializer in a write path
- Call the concierge pilot, local review card, or `@cyberbaser/correction` primitive a shipped account-free product
- Extract a federation profile by momentum; controlled local fixture evidence comes first, demonstrated peer need comes before protocol work
- Treat GitHub or Quartz as product essence rather than current dogfood infrastructure
- Let the `.claude/` orientation layer drift: locked decisions propagate there in the same session
- Edit files in `.workspace/_archive-phase-0-docs/` — it's an archive, not a live doc source
