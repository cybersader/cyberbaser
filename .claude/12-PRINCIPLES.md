# 12 — Principles

> **Status**: 🌱 Skeleton. Don't write principles before the evidence that justifies them (see 01, 02, 04, 05 first).

Design principles are constraints on future decisions. Each principle should:
1. State a rule
2. Justify it with a reason (ideally grounded in a prior-art lesson or a concrete incident)
3. Say what it *rules out*, so it's falsifiable

## Candidate Principles (to validate after research)

### 1. GitHub is the single source of truth.
- **Why**: TODO — grounded in the "vendor lock-in is the enemy" lesson from ecosystem and prior-art surveys.
- **Rules out**: sidecar databases; CMSes that store content outside the repo; solutions that put the vault in a proprietary format.

### 2. Obsidian semantics must round-trip.
- **Why**: TODO — if wikilinks break or callouts don't survive web editing, contributors are forced into one tool.
- **Rules out**: lossy transforms; publishing pipelines that flatten Obsidian syntax to plain HTML without reverse mapping.

### 3. Contributors shouldn't need to learn git.
- **Why**: TODO — the biggest barrier to community contribution on existing Obsidian vaults.
- **Rules out**: "Just send a PR" as the only path.

### 4. Every contribution path must work independently.
- **Why**: TODO — if Web CMS depends on Obsidian being running, it's not really a separate path.
- **Rules out**: architectures where one path is a privileged client of another.

### 5. The vault is primary; cyberbaser is derivative.
- **Why**: TODO — if cyberbaser disappears, the vault should still be a fully functional Obsidian vault.
- **Rules out**: vault-side tooling that can't be removed without breaking the vault.

### 6. Prefer open-source, composable tools over bundled platforms.
- **Why**: TODO — grounded in the "no vendor lock-in" lesson and the sibling-project pattern of small composable parts.
- **Rules out**: solutions where the SSG, CMS, auth, and hosting come from a single vendor and can't be swapped.

### 7. Research before implementation.
- **Why**: TODO — this is meta-principle, but the reinit itself is evidence. The Phase-0 scaffolding was built before the first-principles thinking; now we're retro-fitting principles.
- **Rules out**: writing code to "see what happens" before the relevant numbered file has substantive content.

---

> Once validated, promote these into `CLAUDE.md` as the project's invariants.
