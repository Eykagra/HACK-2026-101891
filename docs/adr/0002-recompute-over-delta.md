# ADR 0002 — Full recompute instead of delta propagation

**Status:** Accepted · **Date:** 2026-09-27

## Context

When a duration or a dependency changes, dependent dates must update. Two
strategies exist.

## Options considered

### A. Delta propagation

Walk forward from the changed task, shifting each successor by the same number
of days.

Appealing: touches only the affected subgraph, `O(affected)`.

**Rejected because it is wrong on two shapes that occur constantly.**

**The diamond.** `A → {B, C} → D`, and A slips 3 days:

```
        ┌── B (3d) ──┐
A (3d)──┤            ├── D
        └── C (5d) ──┘
```

Propagating along `A → B → D` moves D by 3. Propagating along `A → C → D` moves
D by 3 again — total 6. The correct answer is 3: D moves by the *maximum* over
paths, not the sum. Fixing this requires visit-once bookkeeping plus a max
reduction at every join, which is a hand-rolled, bug-prone longest-path
algorithm.

**Slack.** If a successor has float, a delta may move it by less than the shift,
or not at all:

```
A (3d) ──────────┐
                 ├── C        B has 5 days of slack
B (2d) ──────────┘            extending A by 3 must move nothing
```

Delta propagation moves B by 3 and corrupts the plan. Handling this needs the
backward pass anyway — at which point the full recompute has been reimplemented,
incrementally and less correctly.

**There is also no way to unit-test it properly.** Correctness depends on
traversal order, so a test proves the implementation matches itself.

### B. Full recompute — **chosen**

Re-solve the whole board: topological sort, forward pass, backward pass, slack,
critical path.

- **Unconditionally correct.** Diamonds, slack, lag, pinned dates and completed
  tasks all fall out of the same two passes.
- **`O(V + E)`** — linear, no hidden constant.
- **Testable as a pure function.** This is what makes property testing over
  randomly generated DAGs possible, which is what rules out the diamond bug
  *class* rather than spot-checking one case.

## Measurements

| Tasks | Edges | `scheduleGraph` |
| --- | --- | --- |
| 10 | 14 | < 0.1 ms |
| 1,000 | ~3,000 | ~4 ms |
| 10,000 | ~30,000 | ~45 ms |

Asserted in `test/engine.property.test.ts`, so a regression fails CI rather than
going unnoticed.

## Consequences

Every write pays for a full board recompute. At 10k tasks that is ~45 ms inside
the transaction — acceptable, and two orders of magnitude above any realistic
board for this tool.

The optimisation, when needed, is **not** delta propagation. It is recomputing
only the affected subgraph: take the changed node's transitive closure, recompute
that, and stop early when a node's dates are unchanged. That keeps the same
correct algorithm and narrows its input. It is deliberately not implemented yet,
because an optimisation for a load that does not exist is a liability.

## Revisit when

A board exceeds ~10,000 tasks, or recompute shows up in a latency profile.
