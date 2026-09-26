# Proposal review mockup

A coherent, unprivileged, static/no-effect research surface for the proposal operating model. It is deliberately separate from the authenticated owner-alpha baseline and contains no queue access, source checkout, owner session, decision store, Git integration, renderer, deployment provider, or publication witness dependency.

```bash
bun run --cwd docs review:proposal-mockup
bun run --cwd docs test:proposal-mockup
bun run --cwd docs screenshots:proposal-mockup
```

The server binds only the distinct numeric loopback host `127.0.0.2` and defaults to `http://127.0.0.2:4328/`. This keeps host-scoped owner-alpha cookies on `127.0.0.1` away from the unprivileged mockup; the server also rejects every inbound `Cookie` header. Set `CYBERBASER_PROPOSAL_MOCKUP_PORT` to another port on the same fixed mockup host. Set `CYBERBASER_PROPOSAL_MOCKUP_NO_OPEN=1` for non-opening runs. The launcher claims its ignored status file through exclusive creation and cleans it only when both PID and claim token still match.

Each proposal opens in one of four route-addressable modes: **Changes** (unified inline), **Proposed**, **Current**, and **Compare**. Every mode replays the declared exact operations against the pinned base rather than inferring a diff, and it refuses to render a view it cannot derive: unordered or overlapping operations, old bytes that do not match the base, and a replay that does not reproduce the declared candidate all report why instead of approximating. Rendered reading is on by default: untouched blocks render as headings, paragraphs, lists, quotes, code, and page metadata, while any block containing a declared change reveals its exact source, the way Obsidian's live preview reveals source at the cursor. The Markdown subset is conservative, unknown syntax falls back to plain text, raw HTML is never injected, and links do not navigate. It is an approximate reading projection, not the published site rendering, and it can be switched off to read plain Markdown source.

The decision surface is a collapsible fixed dock on wide screens and the sticky bar plus full-width sheet on narrow ones. Collapsed, it still shows attention, complete atomic scope, support and evidence labels, and one primary action.

All controls are memory-only. Approval and rejection create only an in-memory receipt preview. Reloading clears the note and previews. Confirmation and receipt previews repeat every affected path and numbered operation. The client uses no mutation request, cookie, persistent browser storage, worker, cache, clipboard, or download capability.

Navigation uses plain language over internal vocabulary while the routes stay stable: Inbox (`#inbox`), Decisions (`#receipts`), How this works (`#system`), What the labels mean (`#evidence`), and Questions for you (`#checkpoint`). The inbox holds only ready, retained-blocked, and decided projections; pre-admission failures, adversarial cases, and conceptual later examples live under What the labels mean. How this works exposes eight selectable authority boundaries rather than implying an automatic successful pipeline.

Support labels remain explicit: Executable v1, Target capability, Conceptual later, Negative synthetic, and Future operational design. Fixture and screenshot evidence is limited to Synthetic mechanical and Static design only. It cannot establish maintainer comprehension, independent-human usability, live effects, offered lanes, public exposure, or OCI parity.

Screenshots are written only to a new ignored directory under `.workspace/proposal-review-mockup/screenshots/<UTC-run-id>/`. No prior run is deleted or overwritten.

The focused checkpoint passes only when the maintainer can unaided identify the proposal purpose, Current versus Proposed, page and operation scope, required action, approval effects and non-effects, blocked versus rejected, support level, and system placement. Automation never records that result.
