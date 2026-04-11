# Documentation Style Guide

## File Naming

- Use SCREAMING_SNAKE_CASE for markdown files: `TOOL_NAME_ANALYSIS.md`
- Be descriptive but concise
- Make names searchable (think: what would someone grep for?)

## File Structure

### Analysis Documents
```markdown
# Title

## Overview / TL;DR
Brief summary (2-3 sentences max)

## Key Details
Tables for quick reference

## Deep Dive
Detailed analysis with code samples where relevant

## Sources
Links to references
```

### Technical Documents
```markdown
# Title

## Overview
What this covers

## Architecture / How It Works
Diagrams (ASCII art), flow descriptions

## Implementation
Code samples, API references

## Limitations / Trade-offs
Honest assessment

## Recommendations
Actionable guidance
```

## Formatting Preferences

- Use tables for comparisons
- Use code blocks for technical details (even pseudo-code)
- ASCII diagrams over external images (portable, git-friendly)
- Keep files focused - split into multiple files rather than one giant doc
- Link between related files using relative paths

## Content Philosophy

- **Exhaustive over brief** - This is a knowledge base, not a pitch deck
- **Honest about limitations** - Don't oversell approaches
- **Cite sources** - Link to where info came from
- **Code samples matter** - Show how things actually work
- **Update as we learn** - Files should evolve

## Folder Structure

Cyberbaser keeps its first-principles knowledge base inside `.claude/` as numbered files (not as root-level folders). The published wiki content lives in `docs/src/content/docs/` (Astro Starlight).

```
.claude/
├── PROJECT_CONTEXT.md           - What cyberbaser is, who it's for
├── KNOWLEDGE_BASE_PHILOSOPHY.md - Shared KB pattern across projects
├── FOCUS.md                     - Current state, what's next (updated often)
├── DOCUMENTATION_STYLE.md       - This file
├── RESEARCH_SOURCES.md          - Primary sources, vault links, URLs
│
├── 00-INDEX.md                  - Navigation of the numbered files
├── 01-PROBLEM.md                - What problem cyberbaser solves
├── 02-ECOSYSTEM.md              - Landscape of Obsidian-adjacent tools
├── 03-CONCEPTS.md               - First-principles concepts
├── 04-PRIOR-ART.md              - Existing Obsidian→web publishers
├── 05-EXISTING-WORK.md          - What has already been built
├── 10-VISION-SHORT.md           - One-paragraph pitch
├── 11-VISION-LONG.md            - End-state narrative
├── 12-PRINCIPLES.md             - Design principles that constrain decisions
├── 20-ROADMAP.md                - Phased implementation plan
├── 21-ARCHITECTURE.md           - Technical architecture
├── 22-TRANSLATION-LAYER.md      - Obsidian→web syntax translation
├── 23-CONTRIBUTION-WORKFLOWS.md - Web CMS / Obsidian+Git / GitHub
├── 31-TRADEOFFS.md              - Key decisions and rationale
├── 40-QUESTIONS-OPEN.md         - Unresolved blockers
└── 41-QUESTIONS-RESOLVED.md     - Answered questions with rationale

docs/                            - Astro + Starlight publish pipeline (the wiki itself)
.workspace/                      - Personal scratch (tracked folder, ignored contents)
```
