# 01 — The Problem

> **Status**: 🌱 Skeleton. Replace TODO prompts with real articulation.

## TL;DR (one sentence)

> TODO: one sentence that, if deleted, would make the rest of this project pointless. What problem — precisely — does cyberbaser solve?

## The Pain

> TODO: who feels pain today, doing what? Describe the actual friction someone hits when they try to (a) read a cyber knowledge vault, (b) contribute a correction, (c) share a page externally. Be specific — name the steps, not the abstraction.

Candidate friction points to explore:

- Obsidian vaults are private by default. Sharing requires either Obsidian Publish (paid, vendor-locked, limited features) or a static site generator + custom tooling (brittle, loses Obsidian affordances).
- Contributing to someone else's vault requires cloning the repo, installing Obsidian, and learning git — a massive barrier for casual domain experts.
- Existing "Obsidian→web" tools either (a) silently drop Obsidian-specific syntax, (b) require maintenance burden on the vault owner, or (c) break round-trip editing.
- Cyber-specific wikis (awesome-lists, gitbook-based wikis, Notion-based public pages) don't compose well with a personal Obsidian workflow.

> TODO: for each bullet above, either expand into a real finding or delete it.

## Why Existing Solutions Don't Cover This

> TODO: this is *not* prior-art analysis (that goes in `04-PRIOR-ART.md`). This is a summary of *why* none of them are a fit, phrased as constraints on cyberbaser.

## Scope Boundaries

> TODO: equally important — what problem cyberbaser is *not* trying to solve, so future-you doesn't scope-creep.

Candidates to explicitly rule out (or in):

- Is this a general-purpose Obsidian publisher, or only for cyber content? (currently: cyber-focused, but the tooling should generalize)
- Is this a replacement for Obsidian Publish, or a parallel option? (currently: parallel)
- Does it try to solve vault hosting, or just publishing? (currently: just publishing; the vault lives in `cybersader/cyberbase`)

## Whose Pain Motivates This

> TODO: write the one or two real users whose frustration this is built to address. Could be "me, when I want to share a page from my vault without committing to Publish" or "the generic cyber practitioner who wants to contribute a tool correction but doesn't know git."

## Success Looks Like

> TODO: a paragraph describing the state of the world if cyberbaser is successful. Not features — outcomes. What happens that couldn't happen before?
