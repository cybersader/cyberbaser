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

Cyberbaser is the tooling project for turning **any Obsidian vault into a contributable wiki** — a general contributability layer / CMS for markdown knowledge bases, for any domain. Obsidian authoring. Git as the single source of truth. Zero-git contribution for anyone. (It's not a cyber tool — the `cyberbase` vault is just the first content we dogfood it on.)

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

Cyberbaser is in **Phase R** — building first-principles understanding before writing implementation code. Most of the open research is now answered; the findings live in the docs.

**Key findings so far:**
- 🧭 [**Is git the right source of truth?**](https://cybersader.github.io/cyberbaser/research/source-of-truth/) — 83+ systems evaluated. Git scores 21/26 and stays SSOT, with a documented off-ramp.
- 🏗️ [**The v1 architecture decision**](https://cybersader.github.io/cyberbaser/research/v1-architecture/) — CMS, auth, translation layer, Forgejo, collaboration, and the keystone, decided across a 20-agent run.
- 🔑 [**OFM round-trip spike**](https://github.com/cybersader/cyberbaser/tree/main/spikes/ofm-roundtrip) — the keystone (lossless Obsidian-markdown round-trip) is empirically **achievable** (20/21 of the hardest fixtures).
- 🧱 [**Reference architectures**](https://cybersader.github.io/cyberbaser/design/reference-architectures/) — e.g. a fully self-hosted Forgejo + PKCE auth stack (no proxy, no hyperscaler).
- 🚨 [**Assumptions & risks**](https://cybersader.github.io/cyberbaser/research/assumptions-and-risks/) — a living red-team register: the real product-gating risks (demand, contribution friction, moderation) ranked against the technical keystone.

**What exists today:**
- 📖 [**Live docs site**](https://cybersader.github.io/cyberbaser/) — 80+ pages of first-principles content, research findings, and architecture diagrams
- 🧪 Astro + Starlight prototype with Nova theme, 74 passing Playwright tests, silver+emerald palette
- 🎯 [Agent-delegatable challenges](https://cybersader.github.io/cyberbaser/agent-context/zz-challenges/) — adversarial research briefs for parallel agent runs

## Docs site

The knowledge base lives in `docs/` and is published to GitHub Pages. On Windows, double-click **`dev-docs.bat`** to launch it; or run it directly:

```bash
cd docs
bun install
bun run dev              # localhost:4321/cyberbaser/
bun run dev:host         # bind to 0.0.0.0 (Tailscale / LAN)
bun run build            # production build
bun run preview --host   # serve built output
bun run test:local       # Playwright smoke tests (74 passing)
```

A [portagenty](https://cybersader.github.io/portagenty/) workspace (`cyberbaser.portagenty.toml`) defines `shell` / `agent` / `docs` sessions for one-command launch.

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
│   ├── src/content/docs/ # 80+ pages: concepts, design, research, challenges
│   ├── tests/            # Playwright smoke + screenshot specs
│   └── scripts/          # Cross-platform preflight
│
├── spikes/               # Throwaway experiments (e.g. ofm-roundtrip fidelity spike)
├── .workspace/           # Personal scratch (tracked folder, ignored contents)
├── dev-docs.bat          # Windows double-click docs launcher
├── CLAUDE.md             # Agent entry point
├── LICENSE               # AGPL-3.0 (the tooling)
└── CLA.md                # Contributor License Agreement
```

> Code license is AGPL-3.0; the **vault content** license (CC-BY-SA / CC0) is a separate, still-open decision — see [Assumptions & risks](https://cybersader.github.io/cyberbaser/research/assumptions-and-risks/).

## License

[AGPL-3.0](LICENSE) — open source, but anyone hosting cyberbaser as a service must share their modifications. See [CLA.md](CLA.md) for contributor terms.
