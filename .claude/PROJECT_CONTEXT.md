# Cyberbaser Project Context

> Last aligned: 2026-07-27 (v1 Build + concierge-pilot direction). If this file disagrees with the docs site, the docs site wins, and this file should be fixed in the same session.

## What This Project Is

**Cyberbaser is an interoperability layer for contributable, version-controlled knowledge bases.** It sits *between* the tools people author in (Obsidian first-class, but any markdown surface), the renderers that publish the result (Quartz, Starlight, anything), and — eventually — other knowledge bases, keeping one plain-text corpus faithful as changes round-trip through all of them.

Three pillars, held in one phrase:
- **Interoperability** — author from different tools, render with swappable generators, and eventually connect independently owned bases. Federation is long-term **owner-controlled publication**: ordinary meta-wikis may curate, map, annotate, mirror, index, disagree, and fork, while every crawler, graph, and search index remains a disposable view. No central Cyberbaser database or registry sits in the authority chain. The five-origin fixture is controlled local evidence only; a profile waits for demonstrated peer need.
- **Contributable** — the product boundary must let an owner accept bounded changes under a maintainer-set **trust curve + moderation queue**, without treating accounts as the safety mechanism. The current GitHub dogfood path still requires an account; the precommitted concierge pilot tests the missing account-free human workflow.
- **Version-controlled / resilient** — plain text with full history: durable, portable, owned. Git is how version control happens in the dogfood stack today; it is the current manifestation, **not the essence**, and the general product must not require contributors or maintainers to operate GitHub.

**It is general, not a cyber tool.** The `cybersader/cyberbase` vault (cybersecurity content) is the first dogfooding corpus, not the scope. Any wiki — research, handbook, course, standard — is the target.

There are two repos to keep straight:

| Repo | Role |
|---|---|
| `cybersader/cyberbase` | The dogfood content vault (cyber topics) — the first content, not the point |
| `cybersader/cyberbaser` (this repo) | The layer: owner-controlled change-boundary packages, research, contribution/trust design, and the docs site that publishes the canonical KB |

## Current Phase and Immediate Milestone

**Current phase: v1 Build.** Research & Foundations closed on 2026-07-25. The current product interpretation is an **owner-controlled change boundary** around a version-controlled knowledge base: decide what may publish, prepare only exact byte-preserving changes, classify integrity and trust, and keep the final decision with the owner.

The immediate milestone is the precommitted [concierge human-correction pilot](/cyberbaser/research/concierge-human-correction-pilot/): five ordinary readers and one independently operated Markdown-KB owner test a local, account-free correction workflow before any endpoint or editor is built. `@cyberbaser/correction` is the exact quote-anchor and single-splice primitive used by that experiment. It performs no I/O and is not a shipped contribution product.

## The Architecture in One Line

An owner-controlled vault → a **change boundary** decides what may publish and admits only exact, reviewable byte changes → validators classify integrity and trust without taking authority from the owner → swappable renderers publish disposable views. GitHub, Actions, Pages, and Quartz implement the current dogfood path; none is the product essence. Federation follows the same non-central rule later: each base publishes its own authority, ordinary meta-wikis publish source-qualified claims, and every crawler, graph store, cache, and search provider remains a disposable spoke.

## Hard Constraints (violating these = going the wrong direction)

1. **Renderer-agnostic and forge-agnostic.** Quartz and GitHub are the current dogfood infrastructure only. The change boundary must survive swapping either one.
2. **No hyperscalers.** Self-hosting preferred (Forgejo for identity/hosting; see RA-01). GitHub Pages is the *current* deploy target; Cloudflare is edge-only (CDN/WAF/rate-limit), never the host. No AWS/GCP.
3. **Accounts are not the safety mechanism.** Contribution safety = owner review plus the maintainer's trust curve. The current GitHub path still has an account wall, so do not claim the general product requirement is satisfied.
4. **No whole-file writer.** The real-vault gate measured 4.6% byte identity and killed re-serialization. Write paths use exact raw-text splices; `@cyberbaser/ofm` validates and `@cyberbaser/correction` prepares one base-bound candidate without performing I/O.
5. **Evidence before product claims.** The precommitted concierge pilot comes before an account-free endpoint or editor. A primitive, fixture, or study workflow earns only its narrow tested claim.

## Who It's For

- **Knowledge owners** with a markdown KB who need an owner-controlled boundary around publication and proposed changes, without surrendering the source.
- **Readers** who spot a wrong fact but will not use a CLI or create a forge account. Their product path is not shipped; the concierge pilot is the immediate falsification test.
- **Developers** who can use the current GitHub dogfood path by editing a `.md` and opening a PR.
- **AI agents** maintaining content through the same reviewed pipeline as humans — the tool is deliberately agent-friendly.
- **User (Cybersader)**: cybersecurity professional, Obsidian power user, WSL on Windows, collaborates heavily with Claude Code across sibling projects.

## Where Knowledge Lives (knowledge-ops map)

The **canonical knowledge base is the docs site** (`docs/src/content/docs/`) — problem, ecosystem, primitives, prior art, vision, principles, architecture, translation layer, contribution workflows, research findings, open questions. It is mature, vision-swept, and covered by Playwright tests.

The `.claude/` layer is the **orientation + pointer layer**: this file and `FOCUS.md` orient a fresh agent; the numbered files are greppable stubs pointing at their canonical docs pages; `40/41-QUESTIONS-*.md` track decision state; `RESEARCH_SOURCES.md` holds curated sources. **When a decision gets locked in a session, propagate it here in the same session** — this layer going stale is how agents end up pointed in an old direction.

## How to Approach Work in This Repo

1. **Read this file, then `FOCUS.md`.** That's the direction and the current state. Follow stub pointers into the docs site for depth.
2. **Research goes INTO files, not chat.** New findings go to the canonical docs page (or a new page in `docs/src/content/docs/research/`); locked decisions also land in `41-QUESTIONS-RESOLVED.md` and, if they change direction, here and in `FOCUS.md`.
3. **The docs/ folder is both the dev environment AND the published research.** `cd docs && bun run dev` to preview.
4. **Scratch goes in `.workspace/`** (tracked folder, gitignored contents). Old Phase-0 docs live in `.workspace/_archive-phase-0-docs/` — an archive, not a live source.

## Relationship to Sibling Projects

Shared `.claude/` workspace convention across Cybersader projects:

- **crosswalker** — ontology lifecycle management system for knowledge bases (GRC crosswalking). Most mature `.claude/` layout; the numbered-file convention came from it. Its identity phrasing rhymes with cyberbaser's on purpose.
- **cyberchaste** — device-level content filtering research. Source of `KNOWLEDGE_BASE_PHILOSOPHY.md` and `DOCUMENTATION_STYLE.md`.
- **agentic-workflow-and-tech-stack** — meta scaffold for filesystem-based agent workflows.
- **A private browser-Obsidian sibling** — strategically adjacent: a browser-native Obsidian surface is a potential trusted-contributor authoring spoke, and that project owns the mixed-privacy/RBAC/real-time-collaboration scope that is out of cyberbaser's roadmap. Tracked privately in `.workspace/sibling-boundary-analysis.md` (gitignored; not for the public repo). Corrected 2026-07-25: this role was previously misattributed to Retake Forge, which is unrelated.
- **Sinario** — cyber scenarios tooling. Content-adjacent (scenario content could live on a cyberbase-style wiki).

When in doubt about convention, check crosswalker first.
