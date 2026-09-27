# AI tool usage declaration

Declared because the submission rules require it, and because pretending
otherwise would be dishonest.

## Tools used

**Claude (Anthropic)** — used throughout, as a pair-programming partner: design
discussion, implementation, test writing, and documentation.

**OpenAI and Google Gemini APIs** — not build tools. They are a *runtime
feature* of the application, in `src/ai/`, used to suggest dependencies and
phrase impact narratives. The app runs fully without them.

## How it was used

Honestly: most of this code was written with AI assistance. What that means in
practice matters more than the percentage.

| Area | How AI was involved |
| --- | --- |
| **Scheduling engine** | Design discussion first — the delta-propagation-versus-recompute question was argued out before any code existed. Implementation was AI-written and then corrected by failing tests. |
| **Test suite** | Largely AI-written, and the most valuable use. The property tests over random DAGs — which found all three real bugs — came from asking "what invariant would catch a whole class of error here" rather than "write tests for this function". |
| **Frontend** | AI-written. Reviewed closely for the things AI gets wrong by default: `textContent` versus `innerHTML`, keyboard alternatives to drag-and-drop, and colour not being the only state channel. |
| **Documentation** | AI-written from the actual code and the actual decisions. Every number in it was measured, not estimated. |
| **The AI feature itself** | Prompts iterated against real model failures. The gates exist *because* early runs produced hallucinated task keys and fabricated justifications — the gate list is a record of observed failures, not a theoretical checklist. |

## What was verified by hand rather than trusted

The parts where AI confidently produces plausible-looking wrongness:

- **Every propagation number.** The diamond case (+3, not +6) was worked out on
  paper before it was coded, and the test asserts the paper answer.
- **The concurrency argument.** `BEGIN IMMEDIATE` versus deferred `BEGIN` was
  checked against SQLite's documentation, not taken on trust, and then proven
  by a test that fails without it.
- **Half-open intervals.** The `[start, end)` convention and the inclusive-end
  display conversion were reasoned through by hand. The first version had an
  off-by-one for same-day completions, caught by an invariant test.
- **Every benchmark in the documentation.** Run in this repository. The 10k-task
  timing is asserted by a test, not quoted from memory.
- **The AI evaluation numbers.** Produced by `npm run ai:eval`, which is in the
  repository and runs in CI.

## Bugs AI introduced that tests caught

Recorded because it is the most useful thing in this document, and all of them
are in [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) with the mechanism:

1. **Recursive DFS** in the reachability check — elegant, and a stack overflow
   at 10,000 nodes.
2. **Non-deterministic critical-edge ordering** — the code filtered an input
   array and inherited its order, so identical graphs produced different output.
3. **An inverted date range** for a task completed on its own start day.
4. **`loadConfig(env)` reading `process.env`** — a signature that lied about
   where it got its values.
5. **Redundancy claimed against unapproved edges** — the gate told the user a
   falsehood about their own board.
6. **A no-op store subscriber** — the graph view silently never rendered.

Every one of these looked correct on review. Every one was caught by a test that
asserted an invariant rather than an output.

## What was not AI-generated

- Every architectural decision. The ADRs record choices that were argued and
  made, with the rejected alternatives written down.
- The trade-offs. Recompute over delta, SQLite over Postgres, no framework,
  where to draw the AI's authority — these were decided, then implemented.
- The seed scenario. The ten demo tasks were chosen deliberately to contain a
  diamond, a genuine slack case, a five-level chain, mixed dependency states,
  and one held-back edge the AI can plausibly rediscover.
- The decision to show the AI's *rejected* suggestions in the UI, which is the
  most important product decision in the project.

## Position

AI assistance made this faster and, specifically because of the property tests,
more correct than a hand-written equivalent in the same time. It also
confidently introduced six real bugs. Both halves are true, and the engineering
that matters is the part that catches the second half.
