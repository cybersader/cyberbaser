# 40 — Open Questions

> **Status**: ✅ Superseded as a list — the canonical open-questions register is `docs/src/content/docs/reference/open-questions.mdx` (`/cyberbaser/reference/open-questions/`, Q01–Q07). This stub tracks the agent-side state. When a question resolves, log it in `41-QUESTIONS-RESOLVED.md` with rationale.

Keep the canonical list short (≤ ~15). Resolve before adding.

## Current state (2026-07-25)

Most of the register now has a **proposed answer awaiting the R09 gate** (the corpus round-trip measurement + census — see `/cyberbaser/research/v1-build-plan/` and `41-QUESTIONS-RESOLVED.md` R09). Status per question:

- **Q01** local research vault audit — proposed KILL (audits the wrong vault; the real-vault census in the gate answers it empirically)
- **Q02** — **CLOSED 2026-07-25 (R14)**: Quartz adopted on measurement, 20/20 checklist (`/cyberbaser/research/quartz-spike-results/`)
- **Q03** CMS preview rendered vs raw — proposed answer: **both, on opposite sides of a one-way boundary** (raw editing surface, read-only rendered preview; `/cyberbaser/research/proposal-write-path/`)
- **Q04** round-trip enforcement — fully specified as the packaged serializer + required CI check + fidelity-break log (`/cyberbaser/research/proposal-write-path/`); becomes the first build item under most shapes
- **Q05** incremental builds — answered by one measurement inside the gate run
- **Q06** stable URLs — two competing conventions (path-slug + `aliases` vs `permalink`); `/cyberbaser/research/proposal-renderer-urls/` argues the former; the gate's path census (slug collisions) feeds the call
- **Q07** OAuth-proxy hosting — unchanged (near-resolved by RA-01; disappears on Forgejo)

The old FOCUS-tracked gates are superseded: external demand validation was waived (R08); the zero-account path and the CMS bake-off were retired by the plan critique (`/cyberbaser/research/plan-critique/`). The live gates now are **selective publishing** (blocks roadmap Phase 3) and **R09** (blocks the v1 shape).
