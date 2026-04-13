<p align="center">
  <img src="docs/public/logo.svg" alt="Cyberbaser" width="120" />
</p>

<h1 align="center">Cyberbaser</h1>

<p align="center">
  <strong>The contributable wiki, reinvented.</strong>
</p>

<p align="center">
  <a href="https://github.com/cybersader/cyberbaser/blob/main/LICENSE"><img src="https://img.shields.io/github/license/cybersader/cyberbaser?style=flat-square" alt="License" /></a>
  <a href="https://cybersader.github.io/cyberbaser/"><img src="https://img.shields.io/badge/docs-live-10b981?style=flat-square" alt="Docs" /></a>
  <a href="https://obsidian.md"><img src="https://img.shields.io/badge/Obsidian-powered-7c3aed?style=flat-square" alt="Obsidian" /></a>
  <a href="https://astro.build"><img src="https://img.shields.io/badge/Astro-Starlight-ff5d01?style=flat-square" alt="Astro" /></a>
</p>

---

Cyberbaser is the tooling project for building **contributable wikis on top of Obsidian vaults**. Obsidian authoring. GitHub as the single source of truth. Zero-git contribution for anyone.

> Wikipedia is old. Cyberbaser is what replaces it — your vault, your content, contributable by anyone, controllable by you. [Read the vision.](https://cybersader.github.io/cyberbaser/getting-started/vision/)

## How it works

```
AUTHORING SURFACES               VAULT (SSOT)              READERS
                                 
Obsidian (local)      ─────►                    ─────►   cyberbase.wiki
Web CMS (Decap)       ─────►   cybersader/      ─────►   Obsidian (reader)
Inline edit (in-page) ─────►   cyberbase        ─────►   Search index
GitHub direct         ─────►     (GitHub)       ─────►   Mobile
API / script          ─────►                    
                                     │
                              TRANSLATION LAYER
                            wikilinks · callouts
                            embeds · math · mermaid
                            round-trip fidelity
```

Multiple authoring surfaces → one GitHub vault → one translation layer → published wiki. Contribution flows upward from five surfaces, each serving a different perspective. The translation layer guarantees Obsidian semantics survive the round trip.

## Current phase: Research & Foundations

Cyberbaser is in **Phase R** — building first-principles understanding before writing implementation code. The [research roadmap](https://cybersader.github.io/cyberbaser/getting-started/roadmap/) has 11 concrete tasks covering identity, CMS choice, auth model, plugin execution, collaboration, translation layer, and more.

**What exists today:**
- 📖 [**Live docs site**](https://cybersader.github.io/cyberbaser/) — 57+ pages of first-principles content, research logs, and architecture diagrams
- 🧪 Astro + Starlight prototype with Nova theme, Playwright tests, silver+emerald palette
- 🔬 [Decision logs](https://cybersader.github.io/cyberbaser/agent-context/zz-log/) documenting vault mining and research findings
- 📊 [Operational landscape](https://cybersader.github.io/cyberbaser/concepts/operational-landscape/) — work gradient, responsibility matrix, sustainability model

**Key research questions being resolved:**
- [CMS landscape survey](https://cybersader.github.io/cyberbaser/getting-started/roadmap/) — Decap, Sveltia, Tina, EmDash (Cloudflare), and 15+ others
- [Plugin execution abstraction](https://cybersader.github.io/cyberbaser/getting-started/roadmap/) — Obsidian now has an [official headless runtime + CLI](https://obsidian.md/cli)
- [Collaboration model](https://cybersader.github.io/cyberbaser/agent-context/zz-log/2026-04-13-vault-collab-mining/) — git-only async vs real-time CRDT
- [Operational model](https://cybersader.github.io/cyberbaser/concepts/operational-landscape/) — where the sustained value lives

## Docs site

The knowledge base lives in `docs/` and is published to GitHub Pages:

```bash
cd docs
bun install
bun run dev              # localhost:4321/cyberbaser/
bun run dev:host         # bind to 0.0.0.0 (Tailscale / LAN)
bun run build            # production build
bun run preview --host   # serve built output
bun run test:local       # Playwright smoke tests (32 passing)
```

## Repo layout

```
cyberbaser/
├── .claude/              # Agent-first meta layer (read first)
│   ├── PROJECT_CONTEXT.md
│   ├── FOCUS.md
│   ├── KNOWLEDGE_BASE_PHILOSOPHY.md
│   ├── RESEARCH_SOURCES.md    # 200+ curated links
│   └── 00-INDEX.md … 41-QUESTIONS-RESOLVED.md
│
├── docs/                 # Astro + Starlight docs site (the KB itself)
│   ├── src/content/docs/ # 57+ pages of content
│   ├── tests/            # Playwright smoke + screenshot specs
│   └── scripts/          # Cross-platform preflight
│
├── .workspace/           # Personal scratch (tracked folder, ignored contents)
├── CLAUDE.md             # Agent entry point
├── LICENSE               # AGPL-3.0
└── CLA.md                # Contributor License Agreement
```

## Sibling projects

- [**crosswalker**](https://github.com/cybersader/crosswalker) — GRC framework crosswalking Obsidian plugin. Most mature `.claude/` layout; research roadmap pattern copied from here.
- [**cyberchaste**](https://github.com/cybersader/cyberchaste) — Device-level content filtering research. Source of the shared KB philosophy.
- [**cyberbase**](https://github.com/cybersader/cyberbase) — The live Obsidian content vault that cyberbaser will eventually publish.

## License

[AGPL-3.0](LICENSE) — open source, but anyone hosting cyberbaser as a service must share their modifications. See [CLA.md](CLA.md) for contributor terms.
