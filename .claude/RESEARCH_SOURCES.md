# Key Research Sources

> Pointers to the primary sources that ground cyberbaser's research & foundations phase. When you add a finding to one of the numbered `.claude/` files, cite the source here.

## User's Own Work

### Live Cyberbase Content Vault
- **Repo**: https://github.com/cybersader/cyberbase
- **Description**: The actual content that cyberbaser publishes. Mix of cybersecurity knowledge and personal notes. Already uses Notion + Obsidian + GitHub sync.

### Local Obsidian Research Vault
- **Path**: `C:\Users\Cybersader\Documents\4 VAULTS\cyberbase\📁 51 - Cyberbase\`
- **Description**: Staging area for cyberbaser-specific research notes. Not yet pushed to any repo. Mine this for existing thoughts before researching from scratch.

### MCP + Agent Workflow Patterns
- **Path**: `C:\Users\Cybersader\Documents\1 Projects, Workspaces\mcp-workflow-and-tech-stack\docs\`
- **Description**: Cross-project notes on AI agent workflows, MCP, filesystem-based KB patterns. Relevant to how `.claude/` and the KB are structured.

## Sibling Projects (convention references)

- **crosswalker** — https://github.com/cybersader/crosswalker
  - Most mature `.claude/` layout. Numbered files (01-PROBLEM, 02-ECOSYSTEM, ...) came from here.
  - Uses `docs/` as the Astro Starlight root (same pattern we just adopted).
  - `.workspace/` gitignore rule came from here.
- **cyberchaste** — https://github.com/cybersader/cyberchaste
  - Source of `KNOWLEDGE_BASE_PHILOSOPHY.md` and `DOCUMENTATION_STYLE.md` (identical across both siblings).
  - Research-heavy project that has already walked the path we're starting now.
- **agentic-workflow-and-tech-stack** — https://github.com/cybersader/agentic-workflow-and-tech-stack
  - Meta scaffold for agent workflows. Useful for decisions about skills/agents/hooks.

## Static Site Generators & Docs Frameworks (for 02-ECOSYSTEM)

- **Astro** — https://docs.astro.build/
- **Starlight** — https://starlight.astro.build/
- **Quartz v4** — https://quartz.jzhao.xyz/ (the current Obsidian→web comparison baseline)
- **Obsidian Publish** — https://obsidian.md/publish
- **Digital Garden plugin for Obsidian** — https://dg-docs.ole.dev/
- **Docusaurus** — https://docusaurus.io/
- **MkDocs Material** — https://squidfunk.github.io/mkdocs-material/
- **Logseq Publish** — https://docs.logseq.com/#/page/publishing

## CMS & Contribution Tooling (for 02-ECOSYSTEM and 23-CONTRIBUTION-WORKFLOWS)

- **Decap CMS** (formerly Netlify CMS) — https://decapcms.org/
  - Open Authoring docs: https://decapcms.org/docs/open-authoring/
- **Sveltia CMS** — https://github.com/sveltia/sveltia-cms (modern Decap fork, worth tracking)
- **TinaCMS** — https://tina.io/
- **GitHub web editor + PR workflow** — baseline for "direct GitHub" contribution path

## Translation Layer (for 22-TRANSLATION-LAYER)

- **unified / remark / rehype** — https://unifiedjs.com/
- **remark-wiki-link** — https://github.com/landakram/remark-wiki-link
- **astro-loader-obsidian** — https://github.com/cody-lightning/astro-loader-obsidian (currently a dependency)
- **Obsidian flavored markdown spec** — https://help.obsidian.md/Editing+and+formatting/Obsidian+Flavored+Markdown
- **CommonMark** — https://commonmark.org/

## Hosting & Auth

- **Cloudflare Pages** — https://developers.cloudflare.com/pages/
- **GitHub OAuth App docs** — https://docs.github.com/en/developers/apps/building-oauth-apps
- **Cloudflare Pages Functions** — for OAuth proxy if needed

## People / Communities Worth Following

- TODO: add specific maintainers / blogs / Discord communities as research turns them up.
