# 20 — Roadmap

> **Status**: 🌳 Current (aligned 2026-07-30). The canonical public roadmap is `docs/src/content/docs/getting-started/roadmap.mdx` (`/cyberbaser/getting-started/roadmap/`); this file is the agent-side operating view.

## Current Phase: **v1 Build**

The Research & Foundations phase closed on 2026-07-25. The v1 shape is locked by measurement: **byte-preservation by construction, validation, and owner-controlled governance**. The current product interpretation is an **owner-controlled change boundary** around a version-controlled knowledge base. It decides what may be published, what exact bytes may change, and which changes require owner review.

GitHub, GitHub Actions, Pages, and pinned Quartz are the current dogfood infrastructure. They prove one operating path; they are not the product essence and must not become mandatory for a general maintainer.

### Built foundation

- [x] No whole-file re-serialization in any Cyberbaser-mediated external proposal or source-application path; accepted external changes are exact, base-bound operations. The owner's local editor remains a separate direct-authoring lane.
- [x] `@cyberbaser/ofm` validator, fail-closed publish boundary, projection and leak verification, link checker, and trust classifier.
- [x] Real vault published through Quartz: 933 Markdown sources selected and projected into 931 public page URLs at [cybersader.github.io/cyberbase](https://cybersader.github.io/cyberbase/).
- [x] GitHub-backed contribution loop rehearsed twice end to end.
- [x] `@cyberbaser/correction` exact UTF-8 quote-anchor and single-splice core. This is a no-I/O primitive for preparing and validating a candidate change, **not** a shipped editor, endpoint, automatic writer, or contribution product.

### Immediate milestone: owner self-dogfooding

- [ ] Run the [owner self-dogfood series](/cyberbaser/research/owner-self-dogfood/) on Cyberbase with OD attempt IDs and one maintainer switching between reader and owner contexts.
- [ ] Cover a normal correction, signed-out mobile handoff, stale source, ambiguous quote, and owner rejection across three to five attempts.
- [ ] If a real correction is accepted, apply it only through the owner's normal local workflow and verify the approved candidate live. Automated attempts remain no-write.
- [ ] Keep Q09 open. Fix only friction or safety defects actually observed in the series.

No owner self-dogfood attempt has completed the full reader-to-live loop yet. The completed internal dry run and private operator rehearsal are mechanical evidence only. The local form, review card, and correction primitive are experiment infrastructure, not a shipped contribution path. The five-reader, one-independent-owner protocol remains deferred and unchanged until stronger usability claims need it.

### Other v1 Build work

- [ ] Make enforcement honest without breaking the maintainer's direct Obsidian+Git workflow (Q10).
- [ ] Verify contributor attribution through the GitHub fork flow (Q08).
- [ ] Freeze the live URL contract and add the slug-diff gate (Q06).
- [ ] Decide the operating model for a maintainer who does not use GitHub: hosted, one-click self-hosted, or local-first. Owner self-dogfooding tests one local workflow but does not choose the general product model.

**Exit criteria for v1 Build** are canonical on the public roadmap. The owner dogfood result is one criterion; it does not by itself ship or settle an account-free product path.

---

## Long-term seam: linked knowledge bases

Federation remains part of the long arc: independently owned bases and ordinary meta-wikis publish owner-controlled state, direct links are the failure floor, and crawlers, graph stores, caches, and search providers are disposable views. No central Cyberbaser registry or database sits in the authority chain.

The bounded five-origin fixture passed only as **controlled local compatibility**. It is preserved as architecture evidence, not promoted into a production package or immediate protocol workstream. A provisional profile is contingent on one independently operated peer demonstrating a concrete need; only then should the smallest necessary profile and conformance material be extracted.

---

## Publishing prototype <span class="cb-pill cb-pill-parked">Parked as product</span>

The Astro + Starlight site in `docs/` remains the canonical knowledge base and publishing pipeline for project research. It is not the v1 product surface. Quartz renders the live dogfood vault as a swappable commodity spoke.

---

## Roadmap Operating Rules

1. **Roadmap is downstream of principles and measured evidence.** A step that no principle or explicit trade-off justifies is dropped.
2. **Do not infer a product from a primitive.** A validator, exact-correction library, local fixture, or concierge workflow earns only the narrow claim it tested.
3. **Do not turn controlled federation evidence into a protocol workstream by momentum.** Peer need comes before profile extraction.
4. **Update this file when phase, milestone, or product interpretation changes.** `FOCUS.md` is the short-term snapshot; this is the operating roadmap; the docs roadmap page is the public canon.
