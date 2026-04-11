# 31 — Trade-offs

> **Status**: 🌱 Skeleton. Add entries as decisions accumulate; each entry is dated.

A log of significant design trade-offs and why each one was decided the way it was. Each entry should outlive the person who made it.

## Entry Template

```markdown
### [DATE] — [Decision Title]
- **Context**: what was being decided and why it came up
- **Options**: 2–4 alternatives considered
- **Decision**: the choice made
- **Rationale**: why, grounded in which principle(s) from 12-PRINCIPLES.md
- **Trade-off accepted**: what we gave up
- **Revisit when**: the specific condition under which we'd reconsider
```

---

## Log

### 2026-04-11 — Reinitialize to crosswalker/cyberchaste convention
- **Context**: cyberbaser had been dormant for ~4 months. Sibling projects had converged on a `.claude/` numbered-file workspace convention that made sprint-to-sprint continuity much easier. Current cyberbaser had a PARA `docs/` structure and a separate `site/` folder for the Astro prototype, with an almost-empty `.claude/`.
- **Options**:
  1. Leave it alone, just add a FOCUS.md
  2. Add `.claude/` meta layer but keep `site/` and `docs/` split
  3. Full reinit: consolidate `site/` → `docs/`, archive old PARA docs, scaffold numbered first-principles files (matches crosswalker exactly)
- **Decision**: Option 3
- **Rationale**: user explicitly asked to match sibling convention for sprint continuity; the "ground-up first principles" focus meant the existing PARA implementation notes were noise relative to the work actually queued up; and the consolidated `docs/` pattern is what Astro Starlight expects anyway.
- **Trade-off accepted**: git history shows a large rename churn; `.workspace/_archive-phase-0-docs/` needs to be mined or deleted later; the reinit cost ~1 session's time that could've been spent on Phase R research.
- **Revisit when**: never. This was a one-shot setup decision.

---

> TODO: future entries go here. Keep them short. When something grows past ~40 lines of discussion, split it into its own file (`31a-TRANSLATION-LAYER-CHOICE.md`, etc.).

## Decisions Pending (not yet made)

These are decisions we know we'll need to make but haven't yet. When one gets decided, move it from here to the log above.

- **SSG choice: Astro vs. Quartz vs. custom?** (inherited from Phase 0 as "Astro"; not re-validated)
- **CMS choice: Decap vs. Sveltia vs. Tina?** (not yet made)
- **Auth: GitHub OAuth only, or multi-provider?** (default: GitHub only; no principle yet justifies broader)
- **Hosting: Cloudflare Pages vs. GitHub Pages vs. Vercel?** (inherited from Phase 0 as "Cloudflare"; not re-validated)
- **Backlinks: build-time compute vs. runtime?** (not yet made; see 21-ARCHITECTURE)
- **Asset hosting: in-vault vs. CDN?** (not yet made)
- **Tier 2/3 rendering strategy: fallback, hide, or render-as-error?** (not yet made; see 22-TRANSLATION-LAYER)
