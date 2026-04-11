# 03 — First-Principles Concepts

> **Status**: 🌱 Skeleton. Each concept gets a real "What / Why it matters / How cyberbaser uses it" treatment after actual thought.

The primitives the rest of the project reasons about. If someone new to cyberbaser reads this file, they should be able to follow discussions in every other file. Concepts are ordered roughly from foundational to derived.

---

## Wikilink

**What it is**: `[[Page Name]]` syntax that resolves to a link based on page title, not file path. Invented by wiki systems, canonicalized by Obsidian.

**Why it matters**: TODO — contrast with standard Markdown `[text](path.md)` links and explain why wikilinks are load-bearing for vault portability.

**How cyberbaser uses it**: TODO — wikilinks must round-trip between Obsidian and the published web site without breaking.

---

## Backlink

**What it is**: Automatically-generated "pages that link to this one" list.

**Why it matters**: TODO — emergent structure vs. explicit hierarchy; enables wiki-style discovery.

**How cyberbaser uses it**: TODO — must be computed at build time and rendered on each page.

---

## Translation Layer

**What it is**: The pipeline that converts Obsidian-flavored markdown into web-safe HTML (or MDX) while preserving as much semantic fidelity as possible.

**Why it matters**: TODO — this is the hardest and most load-bearing concept in the whole project. Get this wrong and nothing else matters.

**How cyberbaser uses it**: TODO — see `22-TRANSLATION-LAYER.md` for the tier system.

---

## Open Authoring

**What it is**: A CMS pattern (popularized by Decap/Netlify CMS) where unauthenticated or lightly-authenticated users can propose changes via forked-PR workflow, without needing direct commit access.

**Why it matters**: TODO — removes the single biggest contribution barrier (git + write access).

**How cyberbaser uses it**: TODO — primary contribution path for the web CMS entry point.

---

## Structural vs. Presentational Content

**What it is**: A distinction between content that is *about* something (a note on "DNS tunneling") and content that is *about how something looks* (a custom sidebar, a landing page hero).

**Why it matters**: TODO — the vault should be purely structural; presentation lives in the SSG layer.

**How cyberbaser uses it**: TODO — this is how we decide what goes in the vault vs. what goes in the Astro site code.

---

## Round-Trip Editability

**What it is**: The property that a contributor can edit a page in Obsidian, in the web CMS, or on GitHub, and the other surfaces see the change without corruption.

**Why it matters**: TODO — without this, contributors get locked into one entry point and the whole "three entry points" vision collapses.

**How cyberbaser uses it**: TODO — it's a constraint on the translation layer (no lossy transforms).

---

## Content Addressability / Stable URLs

**What it is**: The property that a page's URL doesn't change when the vault is reorganized.

**Why it matters**: TODO — breakage of external links is a wiki cardinal sin.

**How cyberbaser uses it**: TODO — frontmatter slug, or permanent hash, or something else? Open question.

---

## Single Source of Truth (SSOT)

**What it is**: The principle that there is exactly one authoritative place for any given piece of content.

**Why it matters**: TODO — prevents drift, simplifies sync, makes conflict resolution tractable.

**How cyberbaser uses it**: TODO — `cybersader/cyberbase` (the vault repo) is the SSOT. Everything else is a read-view or a proposed-edit.

---

## Vault

**What it is**: In Obsidian parlance, a folder of markdown files + metadata that behaves as a self-contained knowledge base.

**Why it matters**: TODO — "vault" is the unit of content cyberbaser operates on. The vault is primary; cyberbaser is derivative.

**How cyberbaser uses it**: TODO.

---

> Add new concepts here as they emerge in research. Keep this file as the glossary; if a concept grows past ~40 lines, split it into its own numbered file (e.g., `03a-WIKILINKS.md`).
