---
description: Run a point-in-time adversarial red-team of the project's CURRENT high-level direction, via delegated sub-agents. Guards against tunnel vision.
argument-hint: "[optional: a specific bet/direction to attack; defaults to the current active focus]"
---

# /red-team — adversarial check of the current direction

Purpose: at this point in time, stop and **adversarially stress-test the project's current high-level direction** with a fan-out of delegated sub-agents — so we don't tunnel-vision on a locally-interesting problem while a higher-level assumption quietly fails. This is the repeatable version of the manual zoom-out that has paid off before.

Run this when: about to commit to a multi-day/multi-week investment, at a phase boundary, when something feels too easy/fun, or just periodically to keep the big-picture honest.

## Steps

1. **Snapshot the current direction.** Read `.claude/FOCUS.md`, `.claude/20-ROADMAP.md`, the principles, the latest `docs/src/content/docs/research/*.mdx` findings, and the last ~10 commits. From these, write a 3-5 sentence statement of **the single biggest active bet / direction right now** (the thing time and tokens are about to go into). If `$ARGUMENTS` is given, attack that specific bet instead. Also note the project's own constraints (e.g. Phase R rules) so the red-team can flag self-rule violations.

2. **Delegate the attack** — call the `Workflow` tool (this command is your opt-in to multi-agent orchestration). Use a fan-out of **four adversarial lenses + a synthesizer**, each fed the current-direction snapshot:
   - `scale` — what structurally breaks at 10×–100× (pages, contributors, media, federation, moderation, build/latency)?
   - `falsify` — steel-man that the current bet is a local optimum that loses long-term; construct the worlds where it's wrong and the early signal for each.
   - `assumptions` — enumerate the load-bearing assumptions baked into the current bet that nobody has questioned; rank by (riskiness × cheapness-to-test).
   - `gating` — assume the current bet *succeeds perfectly*; what could still kill the project? Rank the **real** product-gating risks against the current technical focus. Is the current focus the right obsession, or a seductive distraction?
   - `synth` — verdict (does the direction survive?), **falsification tests to run now** (cheap experiments that would prove it wrong early), **real gating risks ranked**, an honest tunnel-vision check on the current focus, and long-term signals to watch.
   Give research agents web access (sonnet/high is fine for lenses; the synth should be the strongest model). Schemas should force structured output (findings, thesisFailsIf, testableNow, doNotOverinvest for lenses; verdict, falsificationTests, realGatingRisksRanked, tunnelVisionCheck, whatToWatch for synth). A reference script lives at `.claude/workflows/` from prior runs — adapt its `CONTEXT` to the live direction; do not reuse a stale thesis.

3. **Synthesize and persist.** Append a dated section to `docs/src/content/docs/research/assumptions-and-risks.mdx` (create it if missing) with: the date, the bet under test, the verdict, the ranked gating risks, and the falsification tests. Keep it tight — this is a living risk register, not a transcript.

4. **Report to the user** the 3-5 highest-leverage corrections in plain language: what the current focus is getting right, what it's under-weighting, the cheapest kill-shot tests to run next, and whether to re-sequence. Be blunt; the value of this command is that it's allowed to say "you're optimizing the wrong variable."

## Notes

- This is a *thinking* tool, not a *building* tool — it must not start implementation. If the project is in a research phase, respect the phase rules and let the red-team flag any rule violations (e.g. building before the problem is defined).
- Bias the synthesis toward **cheap, high-severity falsification tests** over expensive validation. The point is to find the wrong assumption fast, not to feel reassured.
