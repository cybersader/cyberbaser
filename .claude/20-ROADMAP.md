# 20 — Roadmap

> **Status**: 🌳 Current (aligned 2026-08-03). The canonical public roadmap is `docs/src/content/docs/getting-started/roadmap.mdx` (`/cyberbaser/getting-started/roadmap/`); this file is the agent-side operating view.

## Current Phase: **v1 Build**

The Research & Foundations phase closed on 2026-07-25. The v1 shape is locked by measurement: **byte-preservation by construction, validation, and owner-controlled governance**. The current product interpretation is an **owner-controlled change boundary** around a version-controlled knowledge base. It decides what may be published, what exact bytes may change, and which changes require owner review.

GitHub, GitHub Actions, Pages, and pinned Quartz are the current dogfood infrastructure. They prove one operating path; they are not the product essence and must not become mandatory for a general maintainer.

### Built foundation

- [x] No whole-file re-serialization in any Cyberbaser-mediated external proposal or source-application path; accepted external changes are exact, base-bound operations. The owner's local editor remains a separate direct-authoring lane.
- [x] `@cyberbaser/ofm` validator, fail-closed publish boundary, projection and leak verification, link checker, and trust classifier.
- [x] Real vault published through Quartz: 933 Markdown sources selected and projected into 931 public page URLs at [cybersader.github.io/cyberbase](https://cybersader.github.io/cyberbase/).
- [x] GitHub-backed contribution loop rehearsed twice end to end.
- [x] `@cyberbaser/correction` exact UTF-8 quote-anchor and single-splice core. This is a no-I/O primitive for preparing and validating a candidate change, **not** a shipped editor, endpoint, automatic writer, or contribution product.

### Owner self-dogfood phase: closed by supersession

- [x] `OD-01`: one genuine owner loop completed through signed-out mobile handoff, exact owner-controlled application, successful deployment, and live verification on 2026-07-31; the original policy-free failure remains preserved.
- [x] Close this manual phase after the one real loop. Preserve the immutable three-ID charter; mark `OD-02` and `OD-03` **Not run — superseded** and do not initialize them.
- [x] Replace staged stale-source, ambiguous-quote, and rejection rituals with deterministic `ADV-*` mechanical coverage. The rejection fixture proves binding mechanics only and is not a human owner rejection.
- [x] Add read-only post-application verification for the explicit commit, all deployment jobs, and the exact live URL. The verifier creates one private evidence artifact and performs no Git, source, remote, deployment, or observation mutation.
- [x] Build the private owner-alpha wiki and automatic exact source-to-live pipeline. One owner Save durably binds the exact operation before acknowledgement, then checks, applies, commits, pushes, binds the deployment, verifies the live witness, and rebuilds locally under the configured policy. Startup recovery resumes only classified-safe states, and a hermetic browser rehearsal proves Save plus recovery without mutating the real Cyberbase.
- [x] Activate the durable owner policy and complete the first low-risk real Cyberbase acceptance Save (2026-08-02: verified one-path commit, normal push, successful deployment, confirmed live transition; also surfaced and fixed one fail-closed frontmatter-comparison defect).
- [x] Bind owner-alpha to one owner-chosen private numeric IPv4 address (loopback default; RFC 1918 and RFC 6598 accepted; transport-neutral) with per-device bootstrap sessions and console re-arm, so the owner can reach the wiki from other devices over a trusted private network.
- [ ] Use the owner-alpha boundary for routine work and fix only measured friction (first logged item: Edit-link placement). Keep Q09 open.

This closes the owner phase by supersession after one completed real loop, not by claiming a completed three-attempt human series. The local form, review card, correction primitive, synthetic adversarial runner, and live verifier are experiment and operating infrastructure, not a shipped contribution path. Owner-controlled authority may be delegated by policy; it does not imply a synchronous human click for every low-risk mechanical operation. The five-reader, one-independent-owner protocol remains deferred and unchanged until stronger usability claims need it.

### Next arc: governance, deployment, intake (canonical plan: `docs/src/content/docs/design/v2-architecture-plan.mdx`)

Ordered work packages, written 2026-08-02 and aligned 2026-08-03: **WP1** two-stage trusted ledger trigger → **WP2** container packaging → **WP3** Forgejo phase 1 (deployment adapter + disposable one-time-mirrored acceptance; authority cutover is a separate explicit decision) → **WP4** Q09 intake lanes behind one shared `@cyberbaser/proposal` contract → **WP5** management console (configure/delegate, never store identity) → **WP6** identity seam stays open. **WP1 implementation is complete and hermetically tested. WP2 implementation and mechanical acceptance are complete within the documented Linux/amd64 evidence boundary. WP3 phase 1's adapter and fixture implementation are hermetically tested, but adversarial review disproved the planned same-UID host runner as an isolation boundary. The real gate now fails before resource creation pending a reviewed runner design; complete storage measurement and real-engine acceptance also remain pending, so WP4 remains blocked.** WP1 live installation remains a separate authorization boundary, and the evidence clock has not started. The plan's standing-constraints header is locked; executors start there, not from scratch.

### Other v1 Build work

- [x] Implement and hermetically test the decision-ledger trigger. Stage A is permissionless and emits only a non-authoritative routing hint; trusted Stage B binds the exact run/artifact, reconstructs every authority field from GitHub APIs and exact inert Git objects, and publishes one ledger-only commit through bounded normal-push checks. Acceptance covers maintainer, fork, closed-unmerged, duplicate, and tampered-artifact scenarios. Canonical design: `/cyberbaser/design/decision-ledger/`.
- [ ] Separately authorize and install the two reviewed workflows in the live vault, replacing the deliberate all-zero tooling placeholder with one reviewed immutable Cyberbaser commit. Then run real maintainer, fork, and closed-unmerged cases and accumulate observations. No install or real fork run has occurred; the default branch has no ledger and the 20-PR precondition remains at zero live observations.
- [x] Build and mechanically accept WP2 container packaging: one local-only Linux/amd64 OCI image, explicit rootless/rootful Docker Engine profiles, mandatory host networking, exact mounts, socket-only HTTPS credentials, attached bootstrap re-arm, offline Quartz seed, and readiness-aware recovery. Physical-device Save, external-forge/live-site container Save, actual rootful-daemon evidence, registry publication, and service installation remain pending.
- [ ] Finish WP3 phase-one acceptance: adapter, dispatcher, strict config, disposable one-time-mirrored fixture, private-checkout authentication, checksum-bound runner staging, cleanup recovery, 4 GiB guard, and hermetic/static tests are implemented. Select and review a runner-isolation boundary that denies workflow access to run-root credentials and ambient container-control sockets, then obtain a complete Docker data-root baseline and run the opt-in Forgejo 16 engine gate before calling it complete or starting WP4.
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
