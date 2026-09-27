# ADR 0005 — Two AI providers with visible consensus

**Status:** Accepted · **Date:** 2026-09-27

## Context

Both OpenAI and Gemini credentials were available. The AI feature — suggesting
dependencies a user may have missed — is inherently unreliable: a wrong
suggestion is plausible-looking, and a reviewer has limited patience for
checking.

## Options considered

### A. One provider

Simplest. Rejected because it wastes the strongest available signal: whether
two independent models reach the same conclusion. It also means one vendor
outage disables the feature.

### B. Two providers, results averaged into one score

Rejected because it destroys the information. "0.85" from two agreeing models
and "0.85" from one confident model are very different claims, and a reviewer
deciding whether to accept an edge needs to know which they are looking at.

### C. Two providers, agreement surfaced — **chosen**

Both models are queried **in parallel** and results are merged by ordered pair.
Agreement is shown as a label: *"2 models agreed (gemini + openai)"* versus
*"openai only"*. Agreement also adds a bounded +0.1 confidence bonus — enough to
sort agreed suggestions first, never enough to clear a gate on its own.

Parallel rather than serial: asking two models in sequence would double
user-visible latency for no benefit.

### D. A model judging another model's output

Rejected. It compounds unreliability, doubles cost, and produces a confident
verdict with no ground truth behind it. The deterministic engine is a better
judge than a third LLM, and it is already there.

## Failover

Ordered and explicit: **live models → offline heuristic**.

The heuristic (`src/ai/heuristic.ts`) is a phase lexicon
(data → platform → service → client → verify → release) combined with lexical
overlap. It is not a token fallback; it does three real jobs:

1. **The app is fully usable with no API key.** A reviewer who clones the repo
   and runs it without credentials sees the whole feature work, gates and all.
2. **It is the published baseline** in the evaluation table. "Our LLM scores
   0.8 precision" is meaningless without knowing what keyword matching scores on
   the same fixture.
3. **It makes the AI path testable in CI** — deterministic, offline, free.

The heuristic only runs when *every* live provider failed, so a working model is
never second-guessed by keyword matching.

## Consequences

- Two API calls per suggestion pass. Acceptable: the route is rate-limited to 10
  per minute, and it is the only endpoint that costs money.
- A partial failure is reported honestly. The panel shows per-provider status,
  latency and error, and marks the result `degraded`.
- Provenance is stored per suggestion: which providers proposed it, the
  agreement count, and the prompt version. "Why does the plan think this?" stays
  answerable.

## Revisit when

A third provider is added — the merge logic is already `n`-provider — or if
measurement shows single-model precision is already high enough that the second
call is not earning its cost.
