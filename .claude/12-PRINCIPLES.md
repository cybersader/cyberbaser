# 12 — Principles

> **Status**: ✅ Superseded. The canonical, maintained version of this content is the docs page below. This stub keeps the key facts greppable and points there. **Do not extend this file; edit the docs page instead.**
>
> **Canonical**: `docs/src/content/docs/getting-started/principles.mdx` · published at `/cyberbaser/getting-started/principles/`

## Current truth (summary, 2026-07-27)

Six principles, each with Rule / Why / Rules-out and a visual on the docs page:

1. **A single source of truth you own** — a version-controlled vault under the owner's control. Git and GitHub are the current dogfood manifestation, not the product essence or a requirement for the general maintainer.
2. **Authoring semantics and untouched bytes must survive edits** — accepted changes use exact raw-text splices; no whole-file re-serialization may enter a write path. `@cyberbaser/ofm` validates changes and never rewrites files.
3. **Contributors should not need git or a forced account** — the live GitHub path does not yet satisfy this. The precommitted concierge pilot tests the narrower human workflow before an account-free product surface is built.
4. **Every offered contribution path must work independently** — this is an independence rule, not a requirement for three paths or a Web CMS. Today the local maintainer path and GitHub editor exist; account-free intake remains an experiment.
5. **The vault is primary; cyberbaser is derivative** — delete cyberbaser and the vault still opens cleanly in its native authoring tool.
6. **Research before implementation** — no feature without a written justification first. The exact-correction package is a no-I/O primitive for the pilot, not a shipped editor, endpoint, writer, or product path.
