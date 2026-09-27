# ADR 0006 — Narrative text is verified against the engine

**Status:** Accepted · **Date:** 2026-09-27

## Context

When a change ripples through the board, users want prose: *"extending the API
work pushed the launch out two days and put the notification service on the
critical path."* An LLM writes that well.

An LLM also writes *"pushed the launch out **six** days"* equally well, and
equally confidently. In a planning tool that number will be repeated in a
standup, and a confident wrong number is worse than a plain right one.

## Options considered

### A. Let the model compute from raw data

Send the before/after board and ask for an explanation. Rejected: the model is
now doing arithmetic, which is exactly the thing it is least reliable at and the
thing the deterministic engine is perfect at.

### B. Templates only

Deterministic, always correct, and stiff. Rejected as the sole approach — the
project has two AI-provider integrations available, and a readable explanation
is genuine user value.

### C. Model writes, engine verifies — **chosen**

Three stages:

1. **The engine computes a structured fact set** from the schedule diff: day
   shifts, before/after dates, which tasks moved, what became blocked, whether
   the critical path changed. All integers, all derived.
2. **The model is given only that JSON** and asked to phrase it. It has no
   access to raw dates and nothing to calculate.
3. **The output is verified.** Every integer and ISO date in the prose must
   appear in an allowlist built from the fact set. One unsupported figure and
   the text is discarded in favour of the deterministic template.

```
findUnsupportedFigure("slipped by 6 days", facts)  →  "6"   → template used
findUnsupportedFigure("slipped by 3 days", facts)  →  null  → model text used
```

Two details that matter:

- **`0` and `1` are allowlisted unconditionally.** English cannot avoid them
  ("one task", "no days"), and rejecting them would reject correct sentences.
- **Dates are stripped before bare-number scanning**, so an allowed
  `2026-10-11` is not re-flagged as `2026`, `10` and `11`.

The response reports which path was taken and, on fallback, why — so the
mechanism is observable rather than a claim in a README.

## Consequences

- **A hallucinated figure can never reach the user.** The worst case is
  slightly stiffer prose.
- The template is not a degraded mode, it is the floor. It is complete,
  readable, and used whenever AI is disabled, unavailable, or wrong.
- Verification is **numeric**. It catches invented figures, not invented
  *causal* claims — a model could still assert a bad reason using only correct
  numbers. The prompt forbids speculation; that instruction is not enforced.
  Recorded as a limitation rather than solved, because enforcing it needs
  semantic checking the project does not have.

## Revisit when

The same verify-then-fall-back pattern is wanted for other generated text, in
which case `allowedTokens` / `findUnsupportedFigure` should move into a shared
grounding module.
