# 23 — Contribution Workflows

> **Status**: ✅ Superseded. The canonical, maintained version of this content is the docs page below. This stub keeps the key facts greppable and points there. **Do not extend this file; edit the docs page instead.**
>
> **Canonical**: `docs/src/content/docs/design/contribution-workflows.mdx` · published at `/cyberbaser/design/contribution-workflows/`

## Current truth (summary, 2026-07-27)

- The old mandatory three-path model is gone. Principle 4 requires **every path the product offers to work independently**; it does not require three paths or a Web CMS.
- Two mechanisms exist in the dogfood stack: the maintainer's local Obsidian+Git path and GitHub's account-required web editor for outside contributors. GitHub supplies the editor, identity, pull request, review, and merge surfaces; Quartz supplies the published site. They are current infrastructure, not Cyberbaser's product essence.
- No Web CMS is active. R12 ruled whole-file re-serializing CMS writers out of every write path.
- The missing account-free path is Q09. Its immediate milestone is the precommitted concierge human-correction pilot: five ordinary readers and one independently operated Markdown-KB owner, with local review and application outside GitHub.
- `@cyberbaser/correction` is the pilot's exact, fail-closed, single-splice, no-I/O primitive. It prepares and validates candidate bytes; it is not a shipped editor, endpoint, automatic writer, forge integration, or product path.
- `@cyberbaser/ofm` is report-only and `@cyberbaser/trust` is decision-only. Nothing in the current pipeline can block or auto-merge a change; a human owner decides.
