---
title: "The Notion writer, audited"
description: "The vault's feared third writer turns out to be dormant since August 2024, perfectly subtree-confined, and OFM-free — but it mirrors by delete-and-recreate, so it may never restart as-is. Frozen and absorbed (R13)."
sidebar:
  label: "Notion writer audit"
  order: 17
status: research
tags: [research, contribution, governance]
---

The [plan critique](/cyberbaser/research/plan-critique/) flagged the vault's Notion sync as an uncontrolled third writer into the source of truth, unexamined by any research, with the 20/21 round-trip proof modeling only two parties. The [write path proposal](/cyberbaser/research/proposal-write-path/) specified a seven-question empirical audit. It ran on 2026-07-25 against the full-history clone. Every claim below has the command that produced it.

## The headline: the writer is dormant

```bash
git log --author='<null>' --format='%h %ad %s' --date=short | head -1
# bc0cf79e 2024-08-20 🔄 synced local 'CybersaderNotion/' with remote 'CybersaderNotion/'
```

The sync is identifiable by its commit signature (author email `<null>`, message `🔄 synced local 'CybersaderNotion/' …`): **35 commits, the last on 2024-08-20** — dormant for almost two years. The repo description still advertises the Notion+Obsidian+GitHub sync, which is what made every analysis (including the critics') treat it as live. The risk register was reasoning about a ghost.

## The seven questions, answered

| # | Question | Answer | Evidence |
| --- | --- | --- | --- |
| 1 | Identifiable writer? | **Yes** — distinct author signature + message pattern, 35 commits | `git log --format='%an <%ae>'` author census: 2146 Obsidian Git backups, 323 GitHub-web, 35 sync |
| 2 | Writes frontmatter? | Partially — some exported files carry frontmatter, most are bare `# Title` markdown | grep over `CybersaderNotion/` |
| 3 | Renames? | Minor — 22 renames across its whole history; **no 32-hex Notion IDs in filenames** | `--diff-filter=R` per sync commit |
| 4 | Rewrites links? | It writes **plain CommonMark only**: 1681 `[text](url)` links, **zero wikilinks** in the subtree | grep counts over `CybersaderNotion/` |
| 5 | Churn (touches what it didn't change)? | **Yes, badly, in-subtree**: paired commits of 1574 and 1560 files on 2024-03-08/09 — a full delete-and-recreate mirror cycle | files-per-commit ranking |
| 6 | Deletes? | **Yes: 1570 deletions** across its history — it is a mirror, not a merge | `--diff-filter=D` per sync commit |
| 7 | Subtree-confined? | **Perfectly.** Every path it ever touched is under `CybersaderNotion/` | union of `--name-only` over all 35 commits |
| + | OFM safety of its output | 133 surviving files: 0 parse errors, 0 mask leaks, normalization profile matches the rest of the vault | `ofm-check corpus CybersaderNotion/` (0.5 s) |

## What this changes

Two of the write path proposal's three **cut triggers** are met (mass churn, deletes) — but they describe a writer that is already off. And the corruption fear inverts, exactly as that proposal predicted in its "the thing the fence is actually protecting against" section: Notion's output contains no OFM to corrupt. The only real hazard was always the *other* direction — the maintainer enriches an exported note with wikilinks, then a re-export overwrites it. With the sync dormant, that hazard is currently zero.

## Decision (R13): frozen and absorbed, restart only as a fenced bot

1. **The last export is absorbed.** `CybersaderNotion/` (133 files) is now an ordinary maintainer-owned subtree like any other; no special handling, no fence needed for a writer that does not write.
2. **The sync may not restart in its historical form.** It meets two cut triggers (delete-and-recreate mirroring, mass churn), which destroy reviewable diffs and enable the overwrite hazard. If Notion import is ever wanted again, it comes back as the fenced design: its own bot identity, committing to a branch, arriving as a PR through the same `ofm-check`-gated moderation queue as every other writer, with a one-way promotion door out of its subtree.
3. **The repo description should stop advertising the live sync** (it misleads every future analysis the way it misled this project's own risk register), and the writers-manifest concept from the [write path proposal](/cyberbaser/research/proposal-write-path/) remains the right general shape for any future automated writer.

## Related

- [The write path](/cyberbaser/research/proposal-write-path/) — the audit spec and fence design this executed
- [The v1 build plan](/cyberbaser/research/v1-build-plan/) — the R12 shape this audit feeds
- [Plan critique](/cyberbaser/research/plan-critique/) — where the third-writer risk was first flagged
- `packages/ofm` — the validator that made the OFM-safety half of this audit a one-liner
