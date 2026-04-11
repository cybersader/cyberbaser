# 40 — Open Questions

> **Status**: 🌱 Skeleton. Questions accumulate here during research; when answered, move to `41-QUESTIONS-RESOLVED.md` with the answer.

Keep this list short. If it grows past ~15 items, it means we're accumulating questions faster than we're resolving them — slow down and resolve some.

## Format

```markdown
### [Q##] Short question title
- **Asked**: DATE
- **Source**: file/section that raised it
- **Why it matters**: 1 sentence
- **Blocks**: which phase or which decision
- **Leads**: any partial findings
```

---

## Current Questions

### [Q01] What's in the local Obsidian research vault at `📁 51 - Cyberbase/`?
- **Asked**: 2026-04-11
- **Source**: `05-EXISTING-WORK.md`
- **Why it matters**: we might be re-researching things that already exist in prior notes.
- **Blocks**: efficient use of Phase R time.
- **Leads**: none yet — needs a manual audit pass.

### [Q02] Is `astro-loader-obsidian` sufficient for Tier 1 translation, or does it need replacement/augmentation?
- **Asked**: 2026-04-11
- **Source**: `22-TRANSLATION-LAYER.md`
- **Why it matters**: determines whether the translation layer is a configuration problem or a build problem.
- **Blocks**: Phase 1 translation layer spike.
- **Leads**: none yet.

### [Q03] Should the Web CMS show Obsidian-rendered preview, or raw markdown?
- **Asked**: 2026-04-11
- **Source**: `23-CONTRIBUTION-WORKFLOWS.md`
- **Why it matters**: changes the architecture of the CMS layer significantly.
- **Blocks**: Web CMS design in Phase 2.
- **Leads**: depends on how Decap/Sveltia/Tina each handle custom preview.

### [Q04] How does the translation layer guarantee no lossy round-trip, in practice?
- **Asked**: 2026-04-11
- **Source**: `22-TRANSLATION-LAYER.md`, `12-PRINCIPLES.md` (principle #2)
- **Why it matters**: principle #2 is only a principle if it's enforceable; otherwise it's an aspiration.
- **Blocks**: claim of "round-trip editability" in vision and principles.
- **Leads**: possibly property-based tests on a vault fixture corpus.

### [Q05] What's the incremental build story for a vault of thousands of pages?
- **Asked**: 2026-04-11
- **Source**: `21-ARCHITECTURE.md`, carried forward from `.workspace/_archive-phase-0-docs/areas/cyberbase-build-scaling.md`
- **Why it matters**: if every edit triggers a full rebuild, the feedback loop breaks.
- **Blocks**: scaling, but not Phase R.
- **Leads**: Astro 5 has improved incremental support; needs benchmarking.

---

> Add new questions as they surface. Don't feel obligated to resolve them immediately — tracking them here is enough.
