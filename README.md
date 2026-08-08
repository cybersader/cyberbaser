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

The current v1 product interpretation is an **owner-controlled change boundary** around a version-controlled knowledge base. Reader controls, trusted rich browser/WYSIWYG/CMS-like tools, forge editors, local Markdown tools, and agents may all be replaceable authoring spokes. External spokes submit bounded proposals against pinned source; the owner keeps direct local authoring, the authoritative Markdown, and the final decision.

GitHub, GitHub Actions, Pages, and pinned Quartz implement the current dogfood path. They prove one working arrangement; they are not Cyberbaser's product essence.

> Anyone should be able to suggest a correction where they read it, while the owner keeps the authoritative Markdown files and decides what changes. [Read the vision.](https://cybersader.github.io/cyberbaser/getting-started/vision/)

## How it works today

```text
OWNER LANE
local Markdown editor → authoritative source → publish boundary → swappable rendered view

EXTERNAL PROPOSAL LANES
reader · rich/CMS-like editor · forge · agent
        → pinned, bounded proposal
        → exact-change + integrity + trust + rendered comparison
        → owner decision
        → authoritative source
```

Three source-change mechanisms exist in the dogfood stack today:

- The maintainer edits the authoritative source locally in Obsidian and pushes with git.
- The private owner-alpha wiki provides an exact-Markdown editor on one owner-chosen private network address (loopback by default); one **Save and publish** action authorizes a strict durable local policy to run the exact source-to-live pipeline.
- An outside contributor uses GitHub's account-required web editor and pull-request flow.

The evaluated serializer-backed CMS writers are rejected because they regenerated complete files. That does **not** ban rich browser or CMS-shaped authoring. A conforming tool can be swapped in through a deliberate adapter that emits bounded source proposals and never becomes a second authority. The account-free product path and trusted rich-authoring product surface have not shipped.

## Current phase: v1 Build

Research & Foundations closed on 2026-07-25. [`OD-01`](https://cybersader.github.io/cyberbaser/research/owner-self-dogfood/) completed the sole real owner loop required in this phase: signed-out mobile handoff, exact proposal, owner acceptance, separate application, deployment, and live verification. The immutable charter remains historical evidence; `OD-02` and `OD-03` are **Not run — superseded**. Stale-source, ambiguous-quote, and rejection-path obligations now run as deterministic synthetic mechanical checks, and no human owner rejection occurred. The private owner-alpha app and automatic exact-change pipeline are implemented, and the first real policy-activated Cyberbase Save/push completed on 2026-08-02 with a verified commit, normal push, successful deployment, and confirmed live transition; routine owner use is current. This remains maintainer operational evidence only, not independent human validation. The preserved [five-reader protocol](https://cybersader.github.io/cyberbaser/research/concierge-human-correction-pilot/) remains optional before stronger usability claims. The seven local fields are temporary observation inputs, not the eventual reader interface or generalized proposal schema, and Q09 remains open.

[`@cyberbaser/correction`](packages/correction/) supplies exact UTF-8 quote anchoring and fail-closed single-splice preparation/application for the pilot. It is a no-I/O primitive, **not** a shipped editor, generalized authoring-adapter API, intake endpoint, automatic writer, hosted console, forge integration, or account-free product.

**What exists:**

- A default-deny publish boundary and post-copy leak verification
- A projection pipeline that preserves source bytes and paths
- `@cyberbaser/ofm`, which classifies Markdown changes as `clean`, `suspect`, or `damage`
- `@cyberbaser/trust`, which computes an owner-configured review route
- `@cyberbaser/linkcheck`, which ratschets internal-link quality
- `@cyberbaser/correction`, the exact single-splice primitive used by the pilot
- `@cyberbaser/owner-alpha`, the private owner wiki/editor and durable automatic source-to-live pipeline, bound to one owner-chosen private network address
- A live dogfood vault with 933 Markdown sources selected and projected into 931 public page URLs, rendered by pinned Quartz and deployed to GitHub Pages
- The Astro + Starlight docs site, which is the canonical project knowledge base rather than the product surface

**What does not exist:**

- An account-free contribution endpoint or product editor
- A generalized authoring-adapter API or selected trusted-contributor rich editor
- A serializer-backed CMS writer, direct external source writer, or second authoritative content database
- An automatic writer for external proposals or a writer that can bypass the owner-controlled policy boundary
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
