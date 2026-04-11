# 23 — Contribution Workflows

> **Status**: 🌱 Skeleton. Fill in after `11-VISION-LONG.md` user journeys are written.

Cyberbaser promises three contribution paths. This file is where we specify how each one actually works end-to-end. It's downstream of `12-PRINCIPLES.md` (especially "every path must work independently" and "contributors shouldn't need to learn git").

## Path A — Web CMS (Decap, Open Authoring)

**Target user**: domain expert, zero git knowledge, has a GitHub account (or willing to make one).

**Flow (TODO)**:
1. Visitor lands on a wiki page → sees "Suggest edit" button
2. TODO: rest of the flow — auth, editing surface, preview, submit, PR creation
3. TODO: what they see after submission (PR link, status page, email?)

**Open questions**:
- Where does the OAuth proxy live (Cloudflare Pages Functions)?
- What are the exact OAuth scopes needed?
- How are draft edits handled (local browser state, CMS backend, or discarded)?
- How does the Web CMS surface Tier 2/3 Obsidian features it can't render?

## Path B — Obsidian + Git

**Target user**: vault-native power user, comfortable with git or using an Obsidian git plugin.

**Flow (TODO)**:
1. Clone `cybersader/cyberbase` as an Obsidian vault
2. Edit locally with full Obsidian affordances
3. Commit and push (manually or via plugin)
4. TODO: rest of flow — PR vs. direct push, branch model, review

**Open questions**:
- Is direct push-to-main allowed for trusted maintainers, or always-PR?
- What Obsidian git plugin is recommended (obsidian-git)?
- How is the Astro build triggered on push?

## Path C — Direct GitHub

**Target user**: developer, knows git, doesn't use Obsidian, wants to fix a typo or add a reference.

**Flow (TODO)**:
1. "Edit this page on GitHub" link in every page footer
2. GitHub web editor or local clone + PR
3. TODO: rest of flow

**Open questions**:
- Do we need to hide Obsidian-specific syntax from direct-GitHub editors, or document it?
- What's the PR template — auto-filled with the page being edited?

## Cross-Path Concerns

### Conflict resolution
> TODO: what happens if two contributors (from different paths) edit the same page simultaneously?

### Review model
> TODO: auto-merge for trusted contributors? Required review for anonymous? How are trusted contributors designated?

### Preview / staging
> TODO: does every PR get a preview deployment (Cloudflare Pages preview)? How is that wired?

### Attribution
> TODO: how are contributors credited in the published wiki?

### Abuse / spam
> TODO: how is open CMS contribution protected against spam/abuse? Rate limiting? CAPTCHA? Trusted-contributor list?

## Minimum Viable Contribution Set

> Based on prior art (`04-PRIOR-ART.md`), the *floor* is "as easy as editing an awesome-list repo on GitHub." Any of the three paths above that is harder than that is a failure of principle #3 ("contributors shouldn't need to learn git").
