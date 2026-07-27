<p align="center">
  <img src="docs/public/logo.svg" alt="Cyberbaser" width="120" />
</p>

<h1 align="center">Cyberbaser</h1>

<p align="center">
  <strong>An interoperability layer for contributable, version-controlled knowledge bases.</strong>
</p>

<p align="center">
  <a href="https://github.com/cybersader/cyberbaser/blob/main/LICENSE"><img src="https://img.shields.io/github/license/cybersader/cyberbaser?style=flat-square" alt="License" /></a>
  <a href="https://cybersader.github.io/cyberbaser/"><img src="https://img.shields.io/badge/docs-live-10b981?style=flat-square" alt="Docs" /></a>
  <a href="https://obsidian.md"><img src="https://img.shields.io/badge/Obsidian-first--class-7c3aed?style=flat-square" alt="Obsidian" /></a>
  <a href="https://quartz.jzhao.xyz/"><img src="https://img.shields.io/badge/renderer-Quartz-8b5cf6?style=flat-square" alt="Quartz" /></a>
</p>

---

Cyberbaser sits between the tools people author in, the systems that publish their knowledge, and eventually other independently owned knowledge bases. It is general-purpose: the [`cybersader/cyberbase`](https://github.com/cybersader/cyberbase) cybersecurity vault is the first dogfood content, not the scope.

The current v1 product interpretation is an **owner-controlled change boundary** around a version-controlled knowledge base. It decides what may be published, prepares only exact byte-preserving candidate changes, classifies their integrity and trust route, and keeps the final decision with the owner.

GitHub, GitHub Actions, Pages, and pinned Quartz implement the current dogfood path. They prove one working arrangement; they are not Cyberbaser's product essence.

> Anyone should be able to suggest a correction where they read it, while the owner keeps the authoritative Markdown files and decides what changes. [Read the vision.](https://cybersader.github.io/cyberbaser/getting-started/vision/)

## How it works today

```text
OWNER-CONTROLLED VAULT
plain Markdown + history
        |
        v
CHANGE BOUNDARY
publish selection + leak verification
exact byte-splice candidates
OFM integrity classification
trust route + owner decision
        |
        v
SWAPPABLE PUBLISHED VIEW
Quartz + GitHub Pages in the dogfood stack
```

Two contribution mechanisms exist today:

- The maintainer edits locally in Obsidian and pushes with git.
- An outside contributor uses GitHub's account-required web editor and pull-request flow.

There is **no active Web CMS** and no requirement for three named paths. The principle is that every path Cyberbaser offers must work independently. The account-free product path has not shipped.

## Current phase: v1 Build

Research & Foundations closed on 2026-07-25. The immediate milestone is the precommitted [concierge human-correction pilot](https://cybersader.github.io/cyberbaser/research/concierge-human-correction-pilot/): five ordinary readers and one independently operated Markdown-KB owner test whether a useful correction can be submitted without an account, reviewed locally, applied as one exact splice, and published without GitHub.

[`@cyberbaser/correction`](packages/correction/) supplies exact UTF-8 quote anchoring and fail-closed single-splice preparation/application for the pilot. It is a no-I/O primitive, **not** a shipped editor, intake endpoint, automatic writer, hosted console, forge integration, or account-free product.

**What exists:**

- A default-deny publish boundary and post-copy leak verification
- A projection pipeline that preserves source bytes and paths
- `@cyberbaser/ofm`, which classifies Markdown changes as `clean`, `suspect`, or `damage`
- `@cyberbaser/trust`, which computes an owner-configured review route
- `@cyberbaser/linkcheck`, which ratschets internal-link quality
- `@cyberbaser/correction`, the exact single-splice primitive used by the pilot
- A live 933-page dogfood vault rendered by pinned Quartz and deployed to GitHub Pages
- The Astro + Starlight docs site, which is the canonical project knowledge base rather than the product surface

**What does not exist:**

- An account-free contribution endpoint or editor
- A Web CMS in the write path
- An automatic source writer
- A hosted moderation console or per-change rendered preview
- Required merge enforcement across the current workflows
- A production federation protocol or independently interoperable implementation

## Long-term federation seam

Cyberbaser's long arc is a web of independently owned bases and ordinary meta-wikis, not a central Cyberbaser database. Direct owner links are the failure floor; collections, mappings, annotations, caches, graph views, and search indexes remain source-qualified and disposable.

A bounded five-origin fixture has passed controlled local falsification tests. That is **local compatibility evidence only**, not independent interoperability. A provisional profile waits until an independently operated peer demonstrates a concrete need.

## Docs site

The canonical knowledge base lives in `docs/` and is published to GitHub Pages.

```bash
cd docs
bun install
bun run dev              # localhost:4321/cyberbaser/
bun run dev:host         # bind to 0.0.0.0
bun run build            # production build
bun run preview --host   # serve built output
bun run test:local       # Playwright smoke tests
```

## Repo layout

```text
cyberbaser/
├── .claude/              # Fresh-agent orientation and pointer layer
├── docs/                 # Canonical KB and Astro + Starlight publish pipeline
├── packages/             # Boundary, validation, trust, link, and correction primitives
├── renderers/            # Swappable renderer adapters; Quartz is current dogfood
├── spikes/               # Bounded experiments, including federation evidence
├── .workspace/           # Personal scratch; contents ignored
├── CLAUDE.md             # Agent entry point
├── LICENSE               # AGPL-3.0 for the tooling
└── CLA.md                # Contributor License Agreement
```

## License

[AGPL-3.0](LICENSE). Anyone hosting modified Cyberbaser tooling as a service must share those modifications. Vault content licensing is separate from the tooling license.
