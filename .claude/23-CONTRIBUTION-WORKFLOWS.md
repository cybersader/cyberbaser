# 23 — Contribution Workflows

> **Status**: ✅ Superseded. The canonical, maintained version of this content is the docs page below. This stub keeps the key facts greppable and points there. **Do not extend this file; edit the docs page instead.**
>
> **Canonical**: `docs/src/content/docs/design/contribution-workflows.mdx` · published at `/cyberbaser/design/contribution-workflows/`

## Current truth (summary, 2026-07-29)

- Cyberbaser does not prescribe one authoring interface. Four distinct experiences frame the current vision: reader micro-correction, trusted-contributor rich browser/WYSIWYG/CMS-like authoring, owner-local direct authoring, and owner-controlled review of external proposals.
- Two mechanisms exist in the dogfood stack: the owner's local Obsidian+Git path and GitHub's account-required web editor for outside contributors. GitHub supplies the borrowed proposal/review surface; Quartz supplies the published site. Neither defines the product.
- The evaluated serializer-backed CMS writers are rejected because they regenerated complete files. Rich CMS-shaped authoring remains allowed as a replaceable spoke when a deliberate adapter emits bounded proposals against pinned source and never becomes a second authority.
- The missing account-free path is Q09. The precommitted concierge pilot uses a temporary seven-field study instrument with five readers and one independently operated owner. It cannot select the final reader UI, rich editor, generalized proposal record, or adapter API.
- `@cyberbaser/correction` is the pilot's exact, fail-closed, single-splice, no-I/O primitive. It prepares and applies candidate bytes in memory; it is not a shipped editor, endpoint, automatic writer, forge integration, or product path.
- `@cyberbaser/ofm` is report-only and `@cyberbaser/trust` is decision-only. Nothing in the current pipeline can block or auto-merge a change; a human owner decides.
