# 41 — Resolved Questions

> **Status**: 🌳 Live decision log. Move entries here from `40-QUESTIONS-OPEN.md` when answered. Preserve the *why*, not just the what.

## Log

### [R01] Is git the right single source of truth?
- **Asked**: 2026-04-11 · **Resolved**: 2026-06-17
- **Answer**: Yes, **scoped**. Git stays the SSOT as the *current manifestation*, not the essence, with an explicit off-ramp if a loss-free markdown↔block serializer ever ships.
- **Rationale**: 14-agent challenge run (`research/source-of-truth.mdx`): git scored 21/26; its two structural zeros (sub-repo access control, federation) are exactly the v2+ pillars, but no alternative fixes them without breaking the plain-`.md` constraint.
- **Consequence**: Principle 1 renamed to "A single source of truth you own"; the layer never forces git on contributors.

### [R02] What *is* cyberbaser, in one phrase?
- **Asked**: 2026-04-11 (roadmap "identity" task) · **Resolved**: 2026-06-20
- **Answer**: **An interoperability layer for contributable, version-controlled knowledge bases.** Category word: "layer."
- **Rationale**: 12-agent essence panel + maintainer's own choices. "Publishing tool" is a dead frame (Quartz wins it); "CMS/contributability layer" drops the interoperability half. The category-defining move is the inversion: the content owns itself; every tool is a replaceable adapter.
- **Consequence**: every page leads with the essence; "Obsidian Publish successor" framing stays private; general-not-cyber locked (cyberbase = dogfood).

### [R03] What's the contribution/identity model?
- **Asked**: Phase-R (auth model task) · **Resolved**: 2026-06-19/20
- **Answer**: Maintainer-set **trust curve + moderation queue**. Accounts never forced; an account is a trust signal, not a wall. "Contributable, not controllable."
- **Rationale**: identity gates are mostly theater (email aliasing is trivial; a GitHub-account wall filters out the domain expert you want). The real question is "can this hurt anything before a human approves it?" — moderation is the load-bearing mechanism. DoS is a separate, edge-layer problem.
- **Consequence**: GitHub OAuth scoped to the Decap path only; the serverless contribution-bot pattern is the zero-account path to evaluate; compose existing tools (Discourse-style trust, moderation tooling), don't build from scratch.

### [R04] Where does this get hosted, and on whose infrastructure?
- **Asked**: Phase-R · **Resolved**: 2026-06-19/20
- **Answer**: **GitHub Pages** is the current deploy target (`actions/deploy-pages@v4`). **Self-hosting is preferred** for anything needing identity (Forgejo). **Cloudflare is edge-only** (CDN/WAF/rate-limit), never the host. **No AWS/GCP, ever** (maintainer constraint).
- **Rationale**: GitHub-trust concern + self-host preference; RA-01 showed Decap/Sveltia authenticate directly via PKCE against Forgejo's built-in OIDC — the OAuth proxy and its secret disappear entirely on the self-hosted path.
- **Consequence**: the old "Cloudflare Pages (current choice)" framing was purged site-wide in the vision sweep; RA-01 is the reference architecture.

### [R05] Is the lossless round-trip actually achievable?
- **Asked**: 2026-04-11 (the keystone doubt) · **Resolved**: 2026-06-17 (empirically)
- **Answer**: Yes — the `spikes/ofm-roundtrip/` spike round-tripped **20/21 fixtures**, via a markdown-first path (block model = the OFM AST; markdown as serialization, not lossy export).
- **Rationale**: right-sized to an afternoon go/no-go per the red-team, instead of a multi-week keystone build.
- **Consequence**: unblocks block-grade editing UX and the SSOT off-ramp; leading candidate stack = `mdast-util-to-markdown` + CodeMirror 6 (swappable spokes).

### [R06] Is the hub or the renderer the product?
- **Asked**: implicit since Phase 0 · **Resolved**: 2026-06-19/20
- **Answer**: **The hub** (round-trip translation + trust/moderation + federation later), and it must stay **renderer-agnostic**. SSG renderers are swappable commodity spokes.
- **Rationale**: tested Quartz audit — Quartz v5 beats our own prototype on OFM fidelity for free, and its maintainer publicly closed CMS/web-editor requests as out of scope. Forward publishing is commoditized; the reverse direction is structurally impossible in any SSG and genuinely unclaimed.
- **Consequence**: never couple the hub to one SSG; Astro/Starlight demoted to "current prototype" everywhere.

### [R07] Where does the canonical knowledge base live (knowledge-ops)?
- **Asked**: 2026-06-21 (meta-layer drift discovered) · **Resolved**: 2026-06-21
- **Answer**: The **docs site** (`docs/src/content/docs/`) is the canonical KB. The `.claude/` numbered files are pointer stubs with greppable summaries; `PROJECT_CONTEXT.md` + `FOCUS.md` are the orientation layer.
- **Rationale**: the numbered files froze in April while the docs matured through research + the vision sweep — two disagreeing brains, and agents read the stale one first. One canonical home per fact; the orientation layer must be updated in the same session as any locked decision.
- **Consequence**: 12 numbered files converted to stubs; roadmap exit criteria re-anchored to docs pages; CLAUDE.md updated.

### [R08] Does v1 need external demand validation before building?
- **Asked**: 2026-06-19 (red-team #1 meta-risk) · **Resolved**: 2026-06-21
- **Answer**: **No.** The maintainer is user #1 and will use it regardless — dogfooding is the v1 validation. External demand becomes a growth/adoption question, not a build gate.
- **Rationale**: maintainer decision; the red-team's "unverified demand" risk applied to a product framing, not a dogfood-first tool.
- **Consequence**: the Phase-R open gate shifts to the cheap falsification tests (PR probe, moderation policy, LICENSE) and the zero-account path; CMS/plugin hands-on unblocks after those.
