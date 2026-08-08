# 23 — Contribution Workflows

> **Status**: ✅ Superseded. The canonical, maintained version of this content is the docs page below. This stub keeps the key facts greppable and points there. **Do not extend this file; edit the docs page instead.**
>
> **Canonical**: `docs/src/content/docs/design/contribution-workflows.mdx` · published at `/cyberbaser/design/contribution-workflows/`

## Current truth (summary, 2026-08-03)

- Cyberbaser does not prescribe one authoring interface. Four distinct experiences frame the current vision: reader micro-correction, trusted-contributor rich browser/WYSIWYG/CMS-like authoring, owner-local direct authoring, and owner-controlled review of external proposals.
- Three source-change lanes exist in the dogfood stack: the owner's local Obsidian+Git path, the private owner-alpha exact editor, and GitHub's account-required web editor for outside contributors. Owner-alpha now has a mechanically accepted local-only Linux/amd64 OCI deployment with explicit rootless/rootful Docker profiles; that packaging does not turn it into external intake. GitHub supplies the borrowed proposal/review surface; Quartz supplies the published site. Neither defines the product.
- The evaluated serializer-backed CMS writers are rejected because they regenerated complete files. Rich CMS-shaped authoring remains allowed as a replaceable spoke when a deliberate adapter emits bounded proposals against pinned source and never becomes a second authority.
- The missing account-free path is Q09. `OD-01` completed one real owner loop; `OD-02` and `OD-03` are Not run — superseded, with stale/ambiguity/rejection-path mechanics covered by synthetic `ADV-*` scenarios only. No human owner rejection occurred. The five-reader, one-independent-owner protocol is deferred until stronger usability claims need it. Neither the owner instrument nor the independent protocol can select the final reader UI, rich editor, generalized proposal record, or adapter API.
- `@cyberbaser/correction` is the exact, fail-closed, single-splice, no-I/O primitive used by these experiments. It prepares and applies candidate bytes in memory; it is not a shipped editor, endpoint, automatic writer, forge integration, or product path.
- `@cyberbaser/ofm` is report-only and `@cyberbaser/trust` is decision-only. Nothing in the current external contribution pipeline can block or auto-merge a change; a human owner decides.
- Post-closure decision recording now has an implemented and hermetically tested two-stage GitHub adapter. Stage A has no repository permissions or checkout and emits only a bounded, non-authoritative routing hint. Trusted Stage B binds the exact run/artifact, reconstructs authority from GitHub APIs and exact inert Git objects, and publishes only `.cyberbaser/decision-ledger.jsonl` through normal non-force checks. The templates are not installed, the tooling pin remains a deliberate non-runnable placeholder, no real fork run occurred, and live observations remain zero.
