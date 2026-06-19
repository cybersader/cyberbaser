# Cyberbaser — Current Focus

> Update when direction changes, milestones complete, or priorities shift.

**Current:** Phase R deep research. The SSOT question is answered (keep git, scoped). Now delegating the remaining open research tasks to a multi-agent run, with three top-priority threads: (1) **high-fidelity block↔markdown round-trip** — the keystone that gates the CMS editor, real-time collab, *and* the SSOT off-ramp; (2) **Forgejo as a GitHub-alternative wiki host** (GitHub-trust concern); (3) **identity** — synthesized once the input tasks land.

Last updated: 2026-06-17

## Project State

- Phase R (Research & Foundations) is the only active phase. The Phase-0 Astro + Starlight prototype exists and is **parked** — it publishes the research, it is not the product.
- Docs site: ~77 pages, silver+emerald theme, **9 agent-delegatable `zz-challenge` briefs**, 74 passing Playwright smoke tests.
- **Challenge 09 (SSOT) answered** via a 14-agent run → [`research/source-of-truth.mdx`](/cyberbaser/research/source-of-truth/). Git scores 21/26. Outcome: keep git as SSOT, reframe Principle 1 as *scoped*, with an **off-ramp** if a loss-free Obsidian-markdown↔block serializer ever ships. Git's two structural zeros (sub-repo access control, federation) are exactly the v2+ vision pillars — but no alternative fixes them without breaking the plain-`.md` constraint.
- **Master linchpin identified:** high-fidelity block↔markdown round-trip. A *markdown-first* block schema (block model = the Obsidian-Flavored-Markdown AST, not a richer superset) could round-trip losslessly **by construction** — markdown as serialization, not lossy export. That would unlock block-grade editing UX + real-time collab while keeping the plain-`.md` SSOT.

## What's Next (in priority order)

1. **Delegated research run (in progress)** — multi-agent workflow answering the open tasks: CMS, auth, plugin execution, collaboration, translation layer, publish-site UX, data sync, SEO, operational model, inline editing — plus **Forgejo-as-host** and **block↔markdown fidelity**. Identity is synthesized from all of them.
2. **Block↔markdown fidelity (keystone)** — decide buildable vs not. If promising, prototype: Tiptap/ProseMirror + remark, throw the hardest OFM fixtures (nested callouts, `![[embed#^block]]`, wikilink aliases) at it and measure round-trip survival.
3. **Forgejo evaluation** — can cyberbaser be GitHub-optional / Forgejo-primary for v1? The trade: lose anonymous open-authoring (GitHub-only today), gain trust + self-hosting.
4. **Translation layer hands-on** — test `astro-loader-obsidian` against the Tier 1 feature list with real `cyberbase` vault content.
5. **Identity** — once the inputs land, rewrite `concepts/problem.mdx` and `getting-started/vision.mdx`.

## Deliberately NOT Doing Right Now

- Building new features (Phase 0 is parked)
- Implementation of CMS, auth, editor, or collaboration (research first)
- Filling out later roadmap phases (research drives the roadmap, not the reverse)

## Running the Docs Site

```bash
cd docs
bun run dev          # http://localhost:4321/cyberbaser/ (dev, HMR — may be flaky on mobile)
bun run dev:host     # bind to 0.0.0.0 (Tailscale / LAN)
bun run build        # production build
bun run preview --host 0.0.0.0  # serve built output (use this for mobile testing via Tailscale)
bun run test:local   # headless Playwright smoke tests (test:e2e is --headed, needs a display)
```

## Pointers to External Context

- **Live content vault**: https://github.com/cybersader/cyberbase
- **Local research vault**: Obsidian vault, local research vault (local path varies by machine)
- **SSOT findings**: [Is git the right source of truth?](/cyberbaser/research/source-of-truth/)
- **Challenge briefs**: [zz-challenges](/cyberbaser/agent-context/zz-challenges/)
- **Vault mining logs**: [Vision mining](/cyberbaser/agent-context/zz-log/2026-04-13-vault-vision-mining/) · [Tech stack mining](/cyberbaser/agent-context/zz-log/2026-04-13-vault-tech-stack-mining/) · [Collab mining](/cyberbaser/agent-context/zz-log/2026-04-13-vault-collab-mining/)
- **Research roadmap**: [Roadmap · Phase R](/cyberbaser/getting-started/roadmap/)
- **Sibling repos**: `cybersader/crosswalker`, `cybersader/cyberchaste`
