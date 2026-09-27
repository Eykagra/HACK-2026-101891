# Test plan

120 tests. `npm test`.

The suite is built around **invariants**, not snapshots. A snapshot test tells
you something changed; an invariant test tells you something is wrong. For a
scheduling engine that distinction is the whole game — the interesting bugs
produce output that looks perfectly plausible.

## Layers

| Suite | Files | Tests | Needs |
| --- | --- | --- | --- |
| Engine | `engine.{graph,propagation,state,criticalpath,property}.test.ts` | 56 | nothing — pure functions |
| API | `api.test.ts` | 22 | a real HTTP server and a real SQLite file |
| AI | `ai.{gates,consensus}.test.ts` | 42 | nothing — fixture providers, no network |

No mocks of our own code. The API tests run a real server against a real
database in a temp directory; the AI tests use a fixture provider behind the
same interface the live ones implement.

## The tests that matter most

### The diamond

```
        ┌── B ──┐
A ──────┤       ├── D
        └── C ──┘
```

Extend A by 3 days. D must move by **3**, not 6. This is the case naive delta
propagation gets wrong, and it is the single most important test in the
project. There is also a *path-count invariance* test: adding more parallel
paths through a join must not change the answer, which catches the
accumulate-instead-of-max bug in its general form.

### Slack absorbs change

A task with 5 days of float, extended by 1 day, must move **nothing**
downstream. The complement of the diamond: delta propagation over-propagates
here too.

### Property tests over random DAGs

Seeded PRNG (`mulberry32`), so a failure is reproducible from its seed. For
every generated graph:

- every task starts at or after all of its prerequisites finish, plus lag;
- the critical path has zero slack at every node, and is contiguous;
- no interval is inverted (`end ≥ start`) for any task, completed or not;
- project finish equals the maximum task finish;
- the topological order is a valid linearisation;
- the same graph scheduled twice gives byte-identical output.

This is what turns "we handle diamonds" into "we handle the shape class that
diamonds belong to".

### Rollback is byte-clean

A rejected dependency must leave the board **field-by-field identical** — not
merely "still valid". The test snapshots every task's dates and state, attempts
a cycle, and asserts deep equality afterwards, including the project finish.

### The concurrency race

Two inverse dependencies (`A → B` and `B → A`) submitted with `Promise.all`.
Exactly one may return `201`; the other must be a `409`. Without
`BEGIN IMMEDIATE` ([ADR 0004](adr/0004-immediate-transactions.md)) this test
fails and the stored graph becomes permanently unschedulable.

### Restart persistence

Close the server, reopen against the same file, and assert every derived date,
slack value and the project finish match what was served before. This proves
derived state is genuinely derived rather than accidentally cached.

### Every gate, individually

`ai.gates.test.ts` has one test per failure mode, each corresponding to
something a real model actually does:

| Test | Catches |
| --- | --- |
| hallucinated key at confidence 1.0 | invented task ids |
| fabricated evidence | invented justifications |
| punctuation/case differences in a real quote | **false positives** in the evidence gate |
| three-word quote | over-zealous evidence rejection |
| cycle-creating edge | the main event |
| two edges circular only *together* | joint validity, not just individual |
| redundancy judged on committed edges only | claiming an unapproved edge as fact |
| previously rejected pair | ignoring a human decision |
| below the confidence floor | noise |
| cap with 10 proposals | unbounded review queues, and that the *best* survive |

Note the two tests that assert the gates are *not* too aggressive. A gate that
rejects everything passes every "blocks bad input" test and is useless.

### Narrative grounding

`findUnsupportedFigure` is tested from both directions: prose using only engine
figures passes; an invented day count or date is caught and named. Plus the
subtle one — the components of a *legitimate* date (`2026`, `10`, `11`) must not
be re-flagged as unsupported bare numbers, or every correct sentence would be
rejected.

### Security assertions

- No response body may contain something key-shaped.
- The public `ai` block has an exact, asserted key list.
- No `500` may contain a stack trace.
- `GET /../package.json` must not return a file.
- CSP headers are present on the app shell.

## Bugs these tests found

All three were found by a test failing, not by review. Detail in
[KNOWN-ISSUES.md](KNOWN-ISSUES.md).

1. **Stack overflow at 10k nodes.** The reachability check used recursive DFS.
   The 10,000-task performance test crashed with `RangeError`. Rewritten
   iteratively — a deep dependency chain in a real board would have hit this in
   production.
2. **Non-deterministic critical-edge output.** `criticalEdges` inherited the
   input array's order, so the same graph produced different output across
   runs. Caught by the determinism property test. Fixed with an explicit
   deterministic tiebreak.
3. **Inverted date range on a completed task.** A task finished on its own start
   day rendered an end date *before* its start. Caught by the interval-validity
   invariant. Fixed with a `max(start + 1, actualFinish)` floor.

## Deliberately not tested

Stated so the gaps are choices rather than oversights:

| Not tested | Why |
| --- | --- |
| **Live API calls to OpenAI/Gemini** | Non-deterministic, costs money, fails without a key. The provider *interface* is tested with fixtures; the HTTP plumbing is thin and its failure modes (timeout, non-200, malformed JSON) are tested through the mock |
| **Browser E2E** | Playwright would add a large dependency and a browser download to a project with no build step. The UI was verified manually and by screenshot; the logic it renders is covered at the API layer |
| **Load/throughput** | Per-request latency is measured; concurrent throughput on a single-writer SQLite deployment is bounded by design, not by a number worth asserting |
| **Caddy / Docker Compose wiring** | CI does build the image and assert the container serves a healthy board, which is the part that can silently break |

## Running

```bash
npm test              # all 120
npm run test:engine   # pure logic, ~20 ms
npm run test:api      # real server + real SQLite
npm run test:ai       # gates, consensus, grounding
npm run typecheck     # tsc --noEmit, strict
npm run ai:eval       # precision/recall for the suggestion feature
```

CI runs all of the above plus a boot smoke test that asserts a correct board
and a rejected cycle over real HTTP, and builds the Docker image.
