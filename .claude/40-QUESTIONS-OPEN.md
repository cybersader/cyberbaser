# 40 — Open Questions

> **Status**: ✅ Superseded as a list — the canonical open-questions register is `docs/src/content/docs/reference/open-questions.mdx` (`/cyberbaser/reference/open-questions/`, Q01–Q10). This stub tracks the agent-side state. When a question resolves, log it in `41-QUESTIONS-RESOLVED.md` with rationale.

Keep the canonical list short (≤ ~15). Resolve before adding.

## Current state (2026-08-11)

Three questions are genuinely open:

- **Q08 — contributor attribution:** the GitHub fork flow's commit attribution has not been independently verified, yet the licensing and future credit story depend on it.
- **Q09 — account-free contribution:** both WP4 lane mechanics are implemented. Lane A remains hermetic only: not live-validated, installed, linked, or offered. Lane B now has a strict account-free adapter, finite local filesystem queue, separate optional sibling app, disabled Quartz form, and local-only internal-network OCI bundle. It stops at anonymous `pending-review` evidence and is disabled by default, not publicly deployed, human-tested, offered, protected by a production reverse proxy/TLS/edge-abuse layer, an owner decision UI, a source writer, or production authority. The private owner-alpha writer is a separate local direct-authority route. `OD-01` completed one real owner loop; `OD-02` and `OD-03` are Not run — superseded, with their safety obligations covered mechanically by synthetic `ADV-*` scenarios. This supplies maintainer operational and harness-safety evidence only. The five-reader, one-independent-owner protocol remains deferred before stronger usability claims. **Direction plus no-R implementation amendment (2026-08-02/10, not a product lock):** all intake options supportable but "super easy"; no maintainer-run hosting or relay; realistic shapes are Forgejo-native or one-click container self-host; v1 uses a local queue and sibling intake service; a future management console configures/delegates auth and shows the review queue but never stores identity.
- **Q10 — moderation enforcement:** OFM is report-only, trust is decision-only, `main` has no required checks, and the maintainer's direct-push path needs validation that does not break daily local authoring.

Q06 closed through R23 on 2026-08-11. The emitted-site continuity checker passes 24 tests, the local rehearsal reproduced all 931 current public URLs, and the live Cyberbase workflow now retains the cumulative baseline and requires pinned `cb-urlcheck` before Pages publication. Run `31540402789` passed with all 931 URLs unchanged and deployed successfully.

The earlier Q01–Q07 register was repaired on 2026-07-26. Q01, Q02, Q03, Q05, Q06, and Q07 are closed; Q04 is answered by the raw-text-splice rule but remains unenforced through Q10.

Federation is not the immediate open gate. Its long-term seam remains owner-controlled publication with no central registry or database. The five-origin fixture is controlled local evidence only; extracting a provisional profile waits for a concrete need from an independently operated peer.
