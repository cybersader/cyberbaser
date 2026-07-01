# 20 — Roadmap

> **Status**: 🌳 Current (re-anchored 2026-06-21). The canonical public roadmap is `docs/src/content/docs/getting-started/roadmap.mdx` (`/cyberbaser/getting-started/roadmap/`); this file is the agent-side operating view. Only Phase R is active; later phases stay sketches until research justifies them.

## Current Phase: **R — Research & Foundations** 🔴 ACTIVE

**Goal (updated):** the foundations are *written* — the canonical KB (the docs site) now has substantive, vision-swept content for problem, ecosystem, primitives, prior art, vision, principles, architecture, translation layer, and contribution workflows. What Phase R still owes is **external validation**: evidence that someone besides us wants this, and that the contribution model holds up outside our heads.

**Exit criteria** (content criteria re-anchored to the canonical docs pages):
- [x] Problem articulated (TL;DR, whose pain, scope) — `concepts/problem.mdx` 🌳
- [x] Ecosystem surveyed, every tool substantive — `concepts/ecosystem.mdx` 🌳
- [x] Primitives defined (what/why/how + visuals) — `concepts/primitives.mdx` 🌳
- [x] Prior art with lessons — `research/prior-art/` 🌳 (incl. the tested Quartz audit)
- [x] Existing work inventoried — `reference/existing-work.mdx` 🌳
- [x] Vision written from the locked essence — `getting-started/vision.mdx` 🌳
- [x] Principles justified (Rule/Why/Rules-out each) — `getting-started/principles.mdx` 🌳
- [x] **Demand** — waived as a gate 2026-06-21: the maintainer is user #1; dogfooding is the v1 validation (R08). External demand = growth question, not a build gate.
- [ ] **Cheap falsification tests run** (LLM→vault PR probe · moderation policy draft · vault LICENSE) ← the open gate — see `FOCUS.md`
- [ ] Open questions ≤ 5 unresolved blockers — currently 7 on `reference/open-questions.mdx`; several are near-resolvable

**In scope during Phase R:** research into the canonical docs pages; the validation tests above; keeping this `.claude/` orientation layer aligned in the same session as any locked decision.

**Explicitly out of scope during Phase R:** CMS/auth/editor/collaboration implementation; extending the Phase-0 prototype beyond publishing the research; alternative-SSG evaluation (the renderer is a commodity spoke by principle); any code not justified by a written principle or trade-off.

---

## Phase 0: Foundation (PARKED)

**Status**: ⚪ Paused. The Astro + Starlight prototype in `docs/` publishes the research; it is not the product.

Built before/around the reinit: Astro + Starlight scaffold (Nova theme), Playwright layout + smoke suites, GitHub Pages deploy workflow (`actions/deploy-pages@v4`; the old Cloudflare Pages workflow is a dead artifact), Bun toolchain, the visual component library in `brand.css` (mockups, trees, diffs, dials), the OFM round-trip spike in `spikes/`.

Intentionally *not* built (no principle justified it yet): translation-layer implementation, CMS integration, auth, backlinks rendering, Obsidian-aware nav.

Phase 0 may resume after Phase R, possibly as a rewrite if principles say so — and renderer-agnostic by principle either way.

---

## Future Phases (Deferred — do not flesh out yet)

Placeholders only; each gets a real outline when Phase R exits.

### Phase 1 — Translation Layer Hands-On
> Prove Tier 1 against real vault content (`astro-loader-obsidian` sufficiency vs custom remark/rehype); build on the 20/21 spike.

### Phase 2 — Contribution Workflows
> Implement ≥2 of the three paths (Web CMS + direct GitHub likely MVP pair); trust curve + moderation queue; the zero-account contribution-bot path; Forgejo/RA-01 substrate decision.

### Phase 3 — Publish the Real Vault
> Point at `cybersader/cyberbase`, deploy to a real domain (stable-URL scheme decided by then).

### Phase 4 — Community Onboarding
> CONTRIBUTING.md, LICENSE follow-through, first external contributor.

---

## Roadmap Operating Rules

1. **Roadmap is downstream of principles.** A step that no principle justifies means: write the principle first or drop the step. (Principles: `getting-started/principles.mdx`.)
2. **Phase R exits only by the exit criteria above** — and the open gate is now *validation*, not writing. Resist "the docs look done, so we're done."
3. **Update this file when a phase exits or scope changes.** `FOCUS.md` is the short-term snapshot; this file is the long-term plan; the docs roadmap page is the public canon.
