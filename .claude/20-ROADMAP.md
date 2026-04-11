# 20 — Roadmap

> **Status**: 🌱 Skeleton. Only Phase R is active. Do not populate later phases with concrete steps until the research outputs justify them.

## Current Phase: **R — Research & Foundations** 🔴 ACTIVE

**Goal**: Produce substantive content in `.claude/01-PROBLEM.md` through `.claude/12-PRINCIPLES.md` so that every subsequent phase can cite a specific file/section as its justification. No implementation work in this phase except minor fixes to the parked Phase-0 prototype if it blocks research.

**Exit criteria** (all must be true to leave Phase R):
- [ ] `01-PROBLEM.md` is 🌳 — one-sentence TL;DR plus an articulated pain, whose pain it is, and explicit scope boundaries.
- [ ] `02-ECOSYSTEM.md` is 🌿 or better — every tool listed has a real paragraph, not a TODO.
- [ ] `03-CONCEPTS.md` is 🌳 — every primitive has "What / Why / How" filled in.
- [ ] `04-PRIOR-ART.md` is 🌳 — every entry has a "Lesson for cyberbaser" sentence.
- [ ] `05-EXISTING-WORK.md` is ✅ — inventory is complete and audited against reality.
- [ ] `10-VISION-SHORT.md` rewritten (not the draft) after reading 01–05.
- [ ] `11-VISION-LONG.md` is 🌳 — every stakeholder perspective has a real narrative.
- [ ] `12-PRINCIPLES.md` is 🌳 — every principle has a justified "Why" grounded in 01/02/04 content, not a TODO.
- [ ] `40-QUESTIONS-OPEN.md` has at most 5 unresolved blockers (the rest have been moved to 41-RESOLVED).

**In scope during Phase R**:
- Reading and writing into the numbered `.claude/` files
- Auditing the local Obsidian research vault at `C:\Users\Cybersader\Documents\4 VAULTS\cyberbase\📁 51 - Cyberbase\` for prior thinking to port in
- Mining `.workspace/_archive-phase-0-docs/` for content that should be hoisted into the numbered files (especially for 21-ARCHITECTURE and 22-TRANSLATION-LAYER)
- Surveying sibling projects (crosswalker, cyberchaste) for patterns worth borrowing
- Minor bug fixes to the parked Phase-0 prototype *only* if a research path requires running the site

**Explicitly out of scope during Phase R**:
- New features in `docs/` (the Astro Starlight site)
- Refactoring Astro configuration, Starlight theme, or test infrastructure
- Alternative SSG evaluation (unless research explicitly calls for it)
- Decap CMS / Open Authoring integration work
- Translation layer implementation
- Any code that isn't a direct consequence of an already-written principle in `12-PRINCIPLES.md`

---

## Phase 0: Foundation (PARKED)

**Status**: ⚪ Paused. Prototype exists in `docs/`. Not actively developed.

What was built before the reinit (captured here only so future-me doesn't forget):
- Astro + Starlight scaffold
- Playwright E2E smoke tests
- Cloudflare Pages deploy workflow
- Bun migration from npm
- Custom domain + Cloudflare Pages project creation

What was intentionally *not* built (because there was no principle to justify it yet):
- Translation layer (wikilinks, callouts, embeds)
- Decap CMS integration
- GitHub OAuth proxy
- Backlinks rendering
- Obsidian-aware navigation generation

Phase 0 may resume after Phase R, possibly with a rewrite if principles say so.

---

## Future Phases (Deferred — do not flesh out yet)

These are placeholders. Each will get a real outline only after Phase R exits and the relevant principles are written.

### Phase 1 — Translation Layer Spike
> TODO (after Phase R). Likely focus: prove the Tier 1 translation layer (wikilinks, callouts, embeds, math, Mermaid) with real vault content.

### Phase 2 — Contribution Workflows
> TODO (after Phase R). Likely focus: implement at least two of the three contribution paths (Web CMS + Direct GitHub is probably the MVP pair).

### Phase 3 — Publish the Real Vault
> TODO (after Phase R). Likely focus: point cyberbaser at `cybersader/cyberbase` content and deploy to a real domain.

### Phase 4 — Community Onboarding
> TODO (after Phase R). Likely focus: CONTRIBUTING.md, docs, examples, first external contributor.

---

## Roadmap Operating Rules

1. **Roadmap is downstream of principles.** If you find yourself adding a step here that isn't justified by a principle in `12-PRINCIPLES.md`, stop and write the principle first (or decide you don't need the step).
2. **Phase R exits only by the exit criteria above.** No "close enough" shortcuts. The whole point of the reinit was to resist the pull to implementation before thinking is done.
3. **Update this file when a phase exits or scope changes.** Keep `FOCUS.md` as the short-term snapshot and this file as the long-term plan.
