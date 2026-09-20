---
name: jev
description: Decision gestures backed by jev System One. Use when the user asks to "jev choose/pick between options", "jev score/evaluate", or "jev noul/reflect", or wants a second-opinion primitive for a decision instead of answering from priors alone. Use when the user mentions jev.
---

# jev — decision gestures

`jev` is a lightweight second-opinion channel to **System One**
(`api.typesafe.ai/v1/systemone`) with three primitives: `choice`, `score`,
`noul`. All calls **degrade, never fail the conversation**: if jev is
unreachable, the fallback answer is used and the degradation is reported.

Invoke the tools from `dsh-jev-mcp`:

## Gestures

### /jev-choice — pick between options

When the user asks to choose among ≥2 concrete options (or you face such a
fork in planning):

1. Call `jev_choice` with `question` (one crisp sentence), `options`
   (short labels), and `fallbackPick` (the safe/conservative option).
2. Report the pick in one line: `jev → <option> (<ok|degraded>)` plus the
   rationale when present. Do not re-litigate; treat it as a tiebreaker.

### /jev-score — evaluate against criteria

When comparing a plan/design/option against explicit criteria:

1. Call `jev_score` with `subject` and 2–5 named `criteria`.
2. Present as a compact table (criterion → score). A degraded call yields
   uniform `fallbackScore` (default 0.5) — say so and stop.

### /jev-noul — open reflection

When the user asks for a "blank slate" take on a problem, or before
committing to a nontrivial architectural decision:

1. Call `jev_noul` with a `prompt` framing the situation.
2. Use the text as input to your own reasoning, not as an oracle.

## Rules

- **Always pass a fallback** — every gesture must succeed locally even when
  the network fails.
- Never send secrets in `question` / `prompt` / `context`.
- One gesture per decision point; do not batch-loop jev calls.
- If a call reports degraded twice in a row, mention that jev appears down
  and proceed without it.
