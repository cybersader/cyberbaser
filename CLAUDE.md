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

**v1 Build** — see `.claude/20-ROADMAP.md` and the canonical [Direction](docs/src/content/docs/getting-started/direction.mdx) page. The current product interpretation is an **owner-controlled change boundary** around a version-controlled knowledge base: publication selection, pinned source/base identity, bounded exact changes, integrity/trust classification, and owner decision. Reader controls, rich browser/WYSIWYG/CMS-like tools, forge editors, local Markdown tools, and agents may all be replaceable authoring spokes. External spokes propose; the owner keeps direct local authoring and source authority. GitHub, Actions, Pages, and pinned Quartz are the current dogfood infrastructure, not the product essence.

`OD-01` completed the sole real owner self-dogfood loop required in this phase. The immutable three-ID charter remains historical evidence; `OD-02` and `OD-03` are **Not run — superseded** and must not be initialized. Stale-source, ambiguous-quote, and rejection-path obligations now run as deterministic synthetic `ADV-*` coverage; no human owner rejection occurred. The private owner-alpha wiki, automatic exact-change pipeline, restart recovery, deployment/live verification, and hermetic browser acceptance rehearsal are implemented, and the first real policy-activated Cyberbase Save/push completed on 2026-08-02 (verified commit, normal push, successful deployment, confirmed live transition). Routine owner use is current; the app binds one owner-chosen private numeric IPv4 address (loopback default, transport-neutral, never coupled to one overlay vendor). The owner-local route is a selected policy-bound writer; external proposal spokes remain no-write. `@cyberbaser/proposal` provides the pure canonical one-file, one-splice external adapter-output contract. `@cyberbaser/forgejo-intake` provides the read-only Forgejo Lane A adapter. WP4 Lane B now has a strict account-free derivation package, carrier-neutral local filesystem queue, separate optional sibling intake app, disabled-by-default Quartz form, and local-only internal-network OCI bundle. These mechanics are tested at their stated layers but are not publicly deployed, human-tested, offered, an identity verifier, an owner decision surface, a source writer, or production authority. Q09 remains open. WP3 phase one completed its container-isolated real Forgejo 16.0.2 gate on 2026-08-10; production authority remains unchanged. The preserved five-reader, one-independent-owner protocol remains optional later, before any unfamiliar-reader or independent-owner usability claim.

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
2. **Authoring semantics and untouched bytes survive edits.** No Cyberbaser-mediated source application may regenerate the untouched file. External adapters emit exact source-bound operations; `@cyberbaser/ofm` validates and never writes. This constrains adapter output, not interface richness.
3. **Contributors shouldn't need git or a forced account.** The current GitHub path does not satisfy this. Contribution safety is owner review plus a maintainer-set trust curve, not an identity wall.
4. **Every offered contribution path works independently.** This does not mandate three paths or a Web CMS. Owner-local direct authoring is distinct from external proposal lanes. Today the local path and GitHub editor are offered. Both WP4 lane mechanics are implemented, but Lane A is not installed or offered and Lane B is disabled, local-only, unexposed, and human-untested. The rich trusted-contributor product lane remains unbuilt and unselected.
5. **The vault is primary; cyberbaser is derivative.** If cyberbaser disappears, the vault still works.
6. **Research before implementation.** Code follows principles and measured evidence, not the other way around.

Plus three architecture constraints: **authoring and rendering spokes are independently replaceable**; **external authoring spokes never directly own or regenerate canonical source**; and **no hyperscalers** (GitHub Pages current host, Cloudflare edge-only, self-hosted Forgejo preferred for identity).

## The Critical Boundary: Exact Changes Without Re-serialization

The deciding measurement showed that whole-file Markdown re-serialization preserved exact bytes for only 4.6% of the real vault. The source-application rule is therefore fixed: bind external proposals to pinned source, preserve untouched bytes by construction, and apply only declared exact operations. The full treatment lives in `docs/src/content/docs/design/translation-layer.mdx` (stub: `.claude/22-TRANSLATION-LAYER.md`).

`@cyberbaser/ofm` classifies whether a before/after change damages authoring semantics. `@cyberbaser/correction` resolves one exact UTF-8 quote and prepares/applies one base-bound candidate splice in memory. Neither is a whole-file writer, and the correction core performs no file I/O. A future editor may be rich, block-based, WYSIWYG, or CMS-shaped, but its adapter must fail closed on stale/ambiguous mapping, emit bounded reviewable proposals, preserve all undeclared bytes, and leave application with the owner-controlled route.

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
- Put a whole-file serializer, direct external writer, or second content authority in the source-application path; rich browser/CMS-shaped presentation itself is allowed
- Select or build the trusted-contributor rich editor before evidence and an explicit product decision justify it
- Call the concierge pilot, local review card, `@cyberbaser/correction`, `@cyberbaser/proposal`, or `@cyberbaser/forgejo-intake` a shipped account-free product; the proposal package is a pure contract, and the Forgejo package is a hermetic read-only adapter, not an offered lane
- Extract a federation profile by momentum; controlled local fixture evidence comes first, demonstrated peer need comes before protocol work
- Treat GitHub or Quartz as product essence rather than current dogfood infrastructure
- Let the `.claude/` orientation layer drift: locked decisions propagate there in the same session
- Edit files in `.workspace/_archive-phase-0-docs/` — it's an archive, not a live doc source
