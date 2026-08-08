# Cyberbaser Project Context

> Last aligned: 2026-08-03 (WP1 implemented and hermetically tested; live installation pending. WP2 implemented and mechanically accepted. WP3 adapter and fixture implementation hermetically tested; real gate quarantined pending reviewed runner isolation, so WP4 remains blocked). If this file disagrees with the docs site, the docs site wins, and this file should be fixed in the same session.

## What This Project Is

**Cyberbaser is an interoperability layer for contributable, version-controlled knowledge bases.** It sits *between* replaceable authoring tools (Obsidian first-class, rich browser or CMS-like surfaces allowed), replaceable renderers (Quartz, Starlight, anything), and eventually other knowledge bases. The owner's plain-text corpus remains authoritative: external tools return bounded, source-bound proposals rather than regenerating or owning the files.

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

## Current Phase and Immediate Work

**Current phase: v1 Build.** Research & Foundations closed on 2026-07-25. The current product interpretation is an **owner-controlled change boundary** around a version-controlled knowledge base: decide what may publish, accept bounded proposals against pinned source, preserve untouched bytes, classify integrity and trust, and keep the final decision with the owner. Reader controls, trusted rich browser/WYSIWYG/CMS-like tools, forge editors, local Markdown tools, and agents may all be replaceable authoring spokes.

`OD-01` completed the one real [owner self-dogfood](/cyberbaser/research/owner-self-dogfood/) loop required in this phase. The immutable three-ID charter remains historical evidence; `OD-02` and `OD-03` are Not run — superseded and blocked from initialization. Deterministic `ADV-*` scenarios cover stale source, ambiguity, and rejection-path binding mechanically; no human owner rejection occurred. A private owner-alpha app is now selected and implemented for routine dogfood, bound to one owner-chosen private numeric IPv4 address (loopback default; transport-neutral, never coupled to one overlay vendor): browse the real Quartz wiki, edit one existing Markdown body, and click Save once; a strict durable local policy performs the exact checks, application, commit, normal push, deployment monitoring, live witness, and local rebuild. The owner-local lane may write under that authority, while external spokes remain proposal-only. The first real acceptance Save completed on 2026-08-02: one policy-activated browser Save produced a verified one-path commit, normal push, successful Pages deployment, and confirmed live-text transition; routine owner use is now current. The seven-field form, review card, and `@cyberbaser/correction` primitive remain instruments, not a selected reader UI, rich external editor, generalized adapter API, or shipped account-free contribution product. The five-reader, one-independent-owner protocol is preserved as an optional later gate before stronger usability claims. WP1's GitHub governance adapter is now implemented and hermetically tested as two stages: an unprivileged capture emits only a non-authoritative routing hint, and a trusted recorder reconstructs authority from exact GitHub records and inert Git objects before ledger-only publication. It is not installed in the live vault, no real fork run has occurred, and there are zero live observations; installing it is a separate explicit authorization boundary. WP2 now packages owner-alpha as a local-only Linux/amd64 OCI image with explicit rootless/rootful Docker Engine profiles, mandatory Linux host networking, exact private-address binding, a read-only image root, exact vault/config/state/socket mounts, offline Quartz seed, attached bootstrap re-arm, and readiness-aware recovery. Mechanical acceptance passed on a real rootless Linux daemon plus numeric nonzero identity fixtures; an actual rootful-daemon run, physical-device Save, external-forge/live-site container Save, image publication, and service installation remain pending. WP3 phase 1 now has a strict Forgejo 16 deployment adapter, provider dispatcher, configuration branch, disposable one-time-mirrored fixture, private-checkout authentication, checksum-bound runner staging, cleanup recovery, a 4 GiB guard, and passing hermetic/static tests. Adversarial review disproved the planned same-UID host runner as an isolation boundary because it can read run-root credentials and reach ambient same-user container sockets. The harness now blocks the opt-in gate before resource creation pending a separately reviewed runner boundary. Complete storage measurement and real-engine acceptance also remain pending, so phase one is implemented but not complete and WP4 remains blocked.

## The Architecture in One Line

Replaceable external authoring spokes submit bounded proposals against pinned source → the **owner-controlled boundary** decides what may publish, verifies exact changes, and classifies integrity and trust → owner authority, expressed directly or through a precise durable policy, controls application to one authoritative Markdown source → swappable renderers publish disposable views. The owner's preferred local editor and the private owner-alpha wiki are separate direct-authority lanes. GitHub, Actions, Pages, and Quartz implement the current dogfood path; none is the product essence. Federation follows the same non-central rule later: each base publishes its own authority, ordinary meta-wikis publish source-qualified claims, and every crawler, graph store, cache, and search provider remains a disposable spoke.

## Hard Constraints (violating these = going the wrong direction)

1. **Renderer-agnostic and forge-agnostic.** Quartz and GitHub are the current dogfood infrastructure only. The change boundary must survive swapping either one.
2. **No hyperscalers.** Self-hosting preferred (Forgejo for identity/hosting; see RA-01). GitHub Pages is the *current* deploy target; Cloudflare is edge-only (CDN/WAF/rate-limit), never the host. No AWS/GCP.
3. **Accounts are not the safety mechanism.** Contribution safety = owner review plus the maintainer's trust curve. The current GitHub path still has an account wall, so do not claim the general product requirement is satisfied.
4. **No whole-file writer or second authority.** The real-vault gate measured 4.6% byte identity and killed whole-file regeneration in Cyberbaser-mediated source application. External adapters bind to pinned source and emit bounded operations; `@cyberbaser/ofm` validates and `@cyberbaser/correction` prepares one base-bound candidate without performing I/O. Rich presentation is allowed; direct reserialized saves are not.
5. **Evidence before product claims.** One owner loop has completed, and its remaining staged failure obligations were superseded by synthetic mechanical coverage. This earns only maintainer operational and harness-safety claims. Independent-reader or independent-owner claims still require the preserved larger protocol. A primitive, fixture, or study workflow cannot select a rich editor or generalized adapter contract.

## Who It's For

- **Knowledge owners** with a markdown KB who need an owner-controlled boundary around publication and proposed changes, without surrendering the source.
- **Readers** who spot a wrong fact but will not use a CLI or create a forge account. Their product path is not shipped; `OD-01` exercised the boundary once with the maintainer switching roles, while unfamiliar-reader usability remains unvalidated.
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
