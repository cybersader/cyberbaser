# 12 — Principles

> **Status**: ✅ Superseded. The canonical, maintained version of this content is the docs page below. This stub keeps the key facts greppable and points there. **Do not extend this file; edit the docs page instead.**
>
> **Canonical**: `docs/src/content/docs/getting-started/principles.mdx` · published at `/cyberbaser/getting-started/principles/`

## Current truth (summary, 2026-07-30)

Six principles, each with Rule / Why / Rules-out and a visual on the docs page:

1. **A single source of truth you own** — a version-controlled vault under the owner's control. Git and GitHub are the current dogfood manifestation, not the product essence or a requirement for the general maintainer. A CMS or sidecar database may hold transient state but cannot become a second content authority.
2. **Authoring semantics and untouched bytes must survive edits** — Cyberbaser-mediated application uses exact source-bound operations and never regenerates the untouched file. This constrains adapter output, not interface richness. `@cyberbaser/ofm` validates changes and never rewrites files.
3. **Contributors should not need git or a forced account** — the live GitHub path does not yet satisfy this. Owner self-dogfooding now exercises one narrow real workflow before account-free automation is built. The preserved concierge pilot is deferred until stronger unfamiliar-reader or independent-owner claims need it.
4. **Every offered contribution path must work independently** — this is an independence rule, not a requirement for three paths or a Web CMS. Owner-local direct authoring is distinct from external proposal lanes. Rich browser, CMS-like, forge, reader, and agent surfaces remain allowed when their adapters conform to the exact-change boundary.
5. **The vault is primary; Cyberbaser is derivative** — delete Cyberbaser and the vault still opens cleanly in its native authoring tool.
6. **Research before implementation** — no feature without a written justification first. The exact-correction package and seven-field pilot form are narrow evidence, not a shipped editor, endpoint, generalized adapter contract, writer, or product path.
