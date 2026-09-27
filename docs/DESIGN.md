# Design

> This is the mandatory combined document: architecture, data model, and known
> limitations. Decision records for individual choices live in
> [`docs/adr/`](adr/); this document is the overview they hang from.

---

## 1. The problem, restated

A Kanban board where tasks depend on each other is not a board with an extra
field. It is a scheduling problem wearing a board's clothes.

Once `B` cannot start until `A` finishes, `B`'s start date stops being a fact
somebody types and becomes a *consequence*. Every date on the board is then a
function of three things: the durations, the dependency graph, and a project
start. Get that wrong and the product lies to its users — quietly, and about
the one thing they opened it to find out.

So the design question is not "where do we store the dates". It is "what is the
minimal set of facts a user asserts, and how do we derive everything else from
them, deterministically, fast enough to do it on every keystroke".

The answer this project commits to:

| A user asserts | The engine derives |
| --- | --- |
| task title, description, assignee | scheduled start and end |
| `duration_days` | blocked / ready, and *by what* |
| dependency edges | slack (float) |
| optional earliest-start floor, optional pin | critical path membership |
| column (stage) | project start and finish |
| completion (via the Done column) | which edges are binding |

---

## 2. Architecture

### 2.1 Layers

```
                    ┌──────────────────────────────────────┐
  browser  ────────▶│  web/   ES modules, no bundler       │
                    │         store → render, no optimism  │
                    └──────────────────┬───────────────────┘
                                       │ fetch /api/*  (JSON / problem+json)
                    ┌──────────────────▼───────────────────┐
                    │  src/http/                           │
                    │  route match · body cap · rate limit │
                    │  CSP + security headers · one error  │
                    │  funnel → RFC 9457                   │
                    └──────────────────┬───────────────────┘
                    ┌──────────────────▼───────────────────┐
                    │  src/services/                       │
                    │  one transaction per use case        │
                    │  audit trail · policy · provenance   │
                    └──────────┬───────────────┬───────────┘
                               │               │
          ┌────────────────────▼──┐   ┌────────▼──────────────────┐
          │  src/engine/  PURE    │   │  src/db/                  │
          │  no imports at all    │   │  Repository · schema.sql  │
          │  graph → schedule     │   │  SQLite, WAL              │
          └───────────────────────┘   └───────────────────────────┘

          ┌───────────────────────────────────────────────────────┐
          │  src/ai/                                              │
          │  providers → 7 gates → human approval → services      │
          │  (calls the engine for validation; never writes)      │
          └───────────────────────────────────────────────────────┘
```

### 2.2 The rule that makes this work

**`src/engine/` imports nothing.** Not the database, not the config, not
`node:*`. It is six files of pure functions over plain data.

That single constraint buys:

- **Unit-testability without fixtures.** No database to set up, no server to
  boot. 56 of the 120 tests are pure engine tests that run in 20 ms.
- **Property testing.** Because the engine is a deterministic function, it can
  be checked against invariants on randomly generated graphs rather than just
  hand-written cases. That is how the diamond bug class is ruled out rather
  than spot-checked.
- **A real performance answer.** `scheduleGraph` on a 10,000-task graph is
  measured in a test, not estimated.
- **Portability.** The same module could run in the browser for an instant
  preview. Not done — [§7](#7-known-limitations) — but the boundary is there.

Everything impure is above it. Transactions, clocks, randomness, the network
and the audit log all live in `services/`, `db/` and `ai/`.

### 2.3 Request flow for a mutation

Every mutation follows the same seven steps. The uniformity is deliberate: it
means there is exactly one place each concern is handled.

```
1. http/     validate the body        → 422 with field paths on failure
2. services/ BEGIN IMMEDIATE          → the write lock is taken before any read
3. engine/   validate the change      → typed rejection (cycle path, duplicate…)
4. db/       write the rows
5. engine/   recompute the schedule   → O(V+E) over the whole board
6. db/       persist derived columns + append the audit event with its diff
7.           COMMIT                   → any throw above rolls back everything
```

Then, **outside** the transaction, the AI narrative is generated from the diff.
It is explicitly non-transactional: the write already committed, and an OpenAI
outage must not fail a task edit.

### 2.4 Why the whole board comes back from every mutation

A mutation response carries the *entire* recomputed board plus the diff, and
the client replaces its state wholesale. No patching, no optimistic updates, no
client-side date arithmetic anywhere.

That looks wasteful — the payload for the demo board is ~12 KB — and it is the
right call:

- The schedule is a **global** function of the graph. A change to one task can
  legally move any other task. There is no small correct patch.
- Optimistic updates would mean guessing dates locally and reconciling later.
  For a planning tool, correct-and-40 ms-late beats fast-and-wrong.
- It makes rejection handling free. Nothing was mutated, so nothing needs
  undoing: the UI is already correct.

At a scale where 12 KB matters, the answer is a delta endpoint, not client-side
scheduling.

---

## 3. The scheduling engine

### 3.1 Representation

Integer **epoch days** throughout. Not `Date`, not ISO strings, not
milliseconds.

This is a small decision with a large blast radius. Date arithmetic across DST
boundaries is a classic source of off-by-one bugs, and "add 3 days" is not
reliably "add 259,200,000 ms". With integer days, `start + duration` is exact,
comparison is `<`, and the scheduler has no timezone concept to get wrong.
Conversion to ISO happens once, at the view boundary.

Intervals are **half-open**: `[start, start + duration)`. A 1-day task starting
on day 10 occupies `[10, 11)`. This makes `successor.start ≥ predecessor.end`
the complete, correct constraint with no `+1` anywhere. The *inclusive* end date
is computed only for display, because "ends Oct 11" is what a human expects to
read.

### 3.2 The passes

**Topological sort** — Kahn's algorithm. The frontier is a sorted array and the
lowest key is always taken first, which makes the output order deterministic for
a given graph rather than dependent on insertion order. If nodes remain when the
frontier empties, a cycle exists and the algorithm walks it to produce a closed
path like `TF-1 → TF-3 → TF-8 → TF-10 → TF-1` for the error message.

**Forward pass (earliest dates)** — in topological order:

```
earliestStart(v) = max(
    projectStart,
    plannedStart(v)                       if pinned,
    max over prerequisites p of
        earliestFinish(p) + lag(p → v)
)
earliestFinish(v) = earliestStart(v) + duration(v)
```

For a completed task, `earliestFinish` is its recorded `actual_finish` instead —
history is a fact, not a prediction. A floor of `start + 1` is applied, which
fixes a real bug found in testing: a task completed on its own start day
otherwise rendered an end date *before* its start.

**Backward pass (latest dates)** — reverse topological order from the project
finish:

```
latestFinish(v) = min over successors s of (latestStart(s) − lag(v → s))
                  or projectFinish if v has no successors
latestStart(v)  = latestFinish(v) − duration(v)
slack(v)        = latestStart(v) − earliestStart(v)
```

**Critical path** — every task with zero slack is *on* the critical path, but
the reported path is a single contiguous chain, found by a dynamic program over
the reverse topological order that picks the longest chain of zero-slack tasks
connected by *binding* edges (edges where `predecessor.finish + lag ==
successor.start`). Ties break deterministically by key, so the same graph always
yields the same path. Without that tiebreak the output flickered between runs —
another bug the tests caught.

**Dependency state** — `BLOCKED` when any prerequisite is not in a satisfied
stage (`DONE` by default, configurable per board), else `READY`. Derived, never
stored as truth; the `dep_state` column is a denormalised cache for querying.

### 3.3 Why recompute rather than propagate a delta

The intuitive implementation is to push each successor forward by the same
amount. It is wrong in two common shapes:

**The diamond.** `A → {B, C} → D`. Extend A by 3. Naive propagation moves B by
3 and C by 3, then moves D by 3 *twice* — 6 days. The correct answer is 3.
Every path that visits D contributes, but D moves by the *maximum*, not the sum.

**Slack.** `A → B`, where B also has a later prerequisite. If B has 5 days of
float, extending A by 3 moves *nothing*. Delta propagation moves B by 3 and
corrupts the plan.

Recompute is `O(V + E)` and immune to both. Measured on this implementation:

| Tasks | Edges | `scheduleGraph` |
| --- | --- | --- |
| 10 | 14 | < 0.1 ms |
| 1,000 | ~3,000 | ~4 ms |
| 10,000 | ~30,000 | ~45 ms |

Asserted by a test in `test/engine.property.test.ts`. At interactive board
sizes the cost is invisible, and the correctness is unconditional.
[ADR 0002](adr/0002-recompute-over-delta.md).

### 3.4 Cycle prevention is a concurrency problem

Checking "would this edge create a cycle" is easy: is the proposed predecessor
reachable from the proposed successor. The hard part is that between the check
and the write, the graph can change.

```
   request 1                     request 2
   ─────────                     ─────────
   read graph                    read graph
   is A→B a cycle? no            is B→A a cycle? no
   insert A→B                    insert B→A
                     ↓
              the graph now has a cycle
```

Both requests were individually correct. Mitigations that do **not** work:
retrying (both still pass), optimistic versioning on tasks (neither task
changed), or an application-level mutex (does not survive a restart, and lies
in a multi-process deployment).

What works: `BEGIN IMMEDIATE`. Unlike SQLite's default deferred `BEGIN`, it
acquires the write lock *before* the transaction reads anything. The second
request therefore validates against a graph that already contains the first
edge, sees the cycle, and is refused. This is asserted by a test that fires both
requests with `Promise.all`. [ADR 0004](adr/0004-immediate-transactions.md).

---

## 4. Data model

```sql
boards         (id, name, project_start, settings, created_at)
tasks          (id, board_id, key, title, description, stage, position,
                duration_days, planned_start, is_pinned, actual_finish,
                assignee, priority, version,
                -- denormalised cache, rewritten on every recompute:
                scheduled_start, scheduled_end, dep_state, unmet_count,
                slack_days, is_critical,
                created_at, updated_at)
dependencies   (id, board_id, predecessor_id, successor_id, lag_days,
                origin, suggested_by, is_critical, created_by, created_at)
suggestions    (id, board_id, predecessor_id, successor_id, confidence,
                rationale, evidence, providers, agreement, prompt_version,
                status, filtered_reason, created_at, decided_at, decided_by)
audit_events   (id, board_id, type, actor, summary, payload, created_at)
```

### 4.1 Decisions worth defending

**`duration_days` is canonical; `scheduled_start`/`scheduled_end` are a cache.**
Storing a start date the user can edit *and* a dependency graph guarantees the
two will contradict each other. Everything derived is rewritten inside the same
transaction as the change that caused it, so it cannot drift — and if the cache
were dropped entirely, `GET /api/board` would still return identical results,
because it schedules from `duration_days` on every read. The columns exist for
`WHERE dep_state = 'BLOCKED'`-style queries, not as a source of truth.

**`position` is a fractional index, not an integer.** Base-62 strings, with a
new position computed as a value *between* its neighbours. Integer ordering
requires renumbering every sibling on a reorder — `UPDATE` across a column for
one drag, and a lost update whenever two people reorder at once. With
fractional indexing a reorder is a single-row write. `src/engine/rank.ts`, with
a property test asserting `lo < between(lo, hi) < hi` over random pairs.

**`version` is an optimistic-concurrency counter.** Incremented on every write;
a client may send `expectedVersion` and gets a `409 STALE_WRITE` if it lost.
Two tabs editing one task produce a clear conflict rather than a silent
overwrite.

**`origin` and `suggested_by` on every dependency.** `MANUAL`, `SEED`, or
`AI_ACCEPTED` plus which providers proposed it. Six months later, "why does the
plan think this?" is answerable. The UI shows an AI badge on such edges.

**Filtered suggestions are persisted, not discarded.** A rejected suggestion
keeps its reason, so "the engine blocked 3 of the model's 7 ideas and here is
exactly why" survives a page refresh. It is the most convincing thing the app
can show; it has to be durable to be believable.

**`ON DELETE CASCADE` on dependencies.** Deleting a task removes its edges. The
alternative — orphaned edges pointing at nothing — turns one deletion into a
permanently invalid graph. The UI warns how many dependents will be affected
before deleting.

### 4.2 Indexes

Every index corresponds to a query the app actually issues, not a guess:

```sql
tasks(board_id, stage, position)              -- rendering a column
dependencies(board_id, successor_id)          -- "what blocks this?"
dependencies(board_id, predecessor_id)        -- "what does this block?"
dependencies(predecessor_id, successor_id)    -- UNIQUE: duplicate prevention
suggestions(board_id, status)                 -- the review queue
audit_events(board_id, created_at DESC)       -- the activity feed
```

The unique index on `(predecessor_id, successor_id)` is worth calling out: it
makes duplicate prevention a **database** guarantee, not just an application
check. The service checks first to produce a good error message, but the
constraint is the actual enforcement.

---

## 5. The AI layer

### 5.1 Two providers, run in parallel

OpenAI and Gemini are asked the same question concurrently. Serial calls would
double user-visible latency for no benefit.

An edge both models propose *independently* is a much stronger signal than one
either produces alone, so agreement is surfaced as a first-class label —
"2 models agreed (gemini + openai)" — rather than folded into an averaged
score. Agreement adds a bounded +0.1 confidence bonus, never enough to clear a
gate by itself.

Failover is ordered and explicit: live models first, then a deterministic
offline heuristic that needs no key and no network. A missing key, a vendor
outage or an air-gapped demo degrades the feature to "less insightful
suggestions", never to a 500. [ADR 0005](adr/0005-dual-provider-consensus.md).

### 5.2 Seven gates

| # | Gate | Failure mode caught | Implementation |
| --- | --- | --- | --- |
| 1 | Schema parse | malformed JSON, missing fields, out-of-range confidence | `parseProviderPayload` |
| 2 | Task-key allowlist | **hallucinated ids** — models invent `TF-99` | closed-world map lookup |
| 3 | Verbatim evidence | fabricated justification | the quoted span must appear in the task's own text, after normalisation |
| 4 | Duplicate / self-edge | re-proposing what exists | `validateAddEdge` |
| 5 | **Cycle** | circular dependencies | `validateAddEdge` against a working graph that grows as suggestions are accepted, so two proposals that are only circular *together* cannot both pass |
| 6 | Prior human rejection | re-proposing a declined pair | `rejectedPairs` from the database, and the pair is also named in the next prompt |
| 7 | Confidence floor + cap | noise, unbounded queues | ≥ 0.55, ≤ 6 shown |

Two subtleties that took a second pass to get right:

**Cycles are checked against the working graph; redundancy is not.** Cycle
checking must be pessimistic — accepting everything offered must not produce a
circular graph — so accepted suggestions are added to a working graph as the
pass proceeds. But redundancy is a *claim about a fact*: telling a reviewer
"already implied by A → B → C" when `B → C` is itself an unapproved suggestion
on the same screen would be false the moment they rejected it. Redundancy is
therefore judged only against committed edges.

**Accept re-validates.** A suggestion rendered five minutes ago may have become
circular since. `acceptSuggestion` calls the same `addDependencyUnsafe` a manual
edge goes through, inside the same `BEGIN IMMEDIATE` transaction, and leaves the
suggestion `PENDING` if it is refused. There is no privileged insert path for
AI-originated edges.

### 5.3 Narrative grounding

The model never computes a number. The scheduler produces a structured diff;
the model's only job is to turn it into a sentence.

That is enforced, not requested. Generated prose is scanned and every integer
and ISO date must appear in an allowlist derived from the diff. A model writing
"slipped by 6 days" when the engine said 3 has its text discarded in favour of
a deterministic template. (`0` and `1` are allowlisted unconditionally, since
English prose cannot avoid them, and dates are stripped before bare-number
scanning so `2026-10-11` is not re-flagged as `2026`, `10`, `11`.)

The response says which path was taken and why, so a reviewer can see the
fallback fire. [ADR 0006](adr/0006-grounded-narratives.md).

### 5.4 Prompt discipline

- Models see **task keys** (`TF-3`), never UUIDs. Nothing internal leaks, and a
  hallucinated key cannot accidentally match a real row.
- `temperature: 0` and vendor-side JSON schema enforcement, so the same board
  yields the same suggestions — which is what makes the evaluation harness
  meaningful and the tests stable.
- Existing edges and previously rejected pairs are included, so the model is not
  asked to rediscover what is already known or re-propose what was declined.
- `PROMPT_VERSION` is stored on every suggestion. When a prompt changes, old
  suggestions remain attributable to the prompt that produced them.

---

## 6. Frontend

No framework, no bundler, no build step: `index.html`, one stylesheet, and nine
ES modules loaded natively. [ADR 0003](adr/0003-no-frontend-framework.md).

Three properties the UI is built around:

**Derived facts are visually distinct from inputs.** The task drawer has a
block labelled *"Derived by the scheduling engine"* containing dates, blocked
state and slack, above the editable fields. Letting someone type a start date
the scheduler then silently overwrites is the fastest way for a tool like this
to lose trust.

**Blocked means blocked *by what*.** Cards name their unmet prerequisites.
"Blocked" without the cause is a dead end.

**Consequence-first feedback.** Toasts are generated from the engine diff, so
the user is told "4 tasks rescheduled, project finish +2 days", not "task
updated". The diff toast (fact) and the narrative toast (explanation) are
separate, so prose is never mistaken for the source of truth.

Accessibility is designed in, not retrofitted: every card has keyboard-operable
move buttons (HTML5 drag-and-drop is unusable with a keyboard or screen
reader), an ARIA live region announces every schedule change, no state is
signalled by colour alone, focus is visible throughout, and
`prefers-reduced-motion` is respected. All DOM text goes through `textContent`
via one helper — task titles and AI rationales are attacker-influenced strings,
and that helper is the boundary that guarantees none of them can become markup.

The DAG view uses **longest-path layering**: node depth is `1 + max(depth of
prerequisites)`. Every edge therefore points from a lower layer to a higher one,
so all arrows run left to right, and the absence of a backward arrow is visible
proof the graph is acyclic. A force-directed layout would look livelier and
demonstrate nothing.

---

## 7. Known limitations

Ordered by how likely a reviewer is to hit them.

### Scope

| Limitation | Why | What it would take |
| --- | --- | --- |
| Calendar days, not working days | Correct working-day logic needs a locale and holiday calendar; faking it is worse than omitting it | An `isWorkingDay` predicate in `dates.ts`; the engine already works in integer days |
| Finish-to-start only | `lag_days` covers delays; SS/FF are a different constraint shape | A `type` column and a third case in the forward pass |
| No resource levelling | `assignee` is a label. One person on two parallel tasks is not detected | A genuinely hard scheduling problem (NP-hard in general); out of scope |
| Deterministic durations | No PERT ranges or Monte Carlo | Three duration columns and a distribution pass |
| Single board, no auth | The scope is the engine | `board_id` is on every table and in every query; the seam exists |
| No undo | The audit log has every diff, so the data exists | Reverse-application logic per event type |

### Operational

| Limitation | Detail |
| --- | --- |
| **Single instance** | SQLite plus an in-memory rate limiter. `Repository` is the only file with SQL in it, so Postgres is a contained change — [ADR 0001](adr/0001-sqlite-over-postgres.md) |
| **Full recompute per write** | `O(V+E)`, ~45 ms at 10k tasks. Beyond that, recompute only the affected subgraph |
| **No realtime sync** | Two tabs do not push to each other. Optimistic version checks mean the second writer gets a 409 rather than silently winning |
| **Rate limits are per process** | Resets on restart; a multi-instance deployment would need shared state |
| **No metrics endpoint** | Structured JSON logs only; no Prometheus |

### AI

| Limitation | Detail |
| --- | --- |
| **Small evaluation set** | 10 tasks, 4 hidden edges. Detects gross regressions, not fine model differences |
| **Precision is a lower bound** | Many orderings on the seed board are defensible; only the hidden four count as true positives |
| **No cost tracking** | Latency is reported per provider; token spend is not |
| **Evidence check is lexical** | A semantically fabricated but lexically present justification would pass gate 3 |
| **Narrative verification is numeric** | It catches invented figures, not invented *causal claims* |

### Quality

| Limitation | Detail |
| --- | --- |
| **Accessibility not formally audited** | Designed against WCAG 2.2 AA; not verified with a real screen reader |
| **No browser/E2E tests** | Engine, service and API layers are covered; the frontend is exercised manually |
| **No load testing** | Per-request latency is measured; concurrent throughput is not |

---

## 8. What would come next

In priority order, with the reasoning:

1. **Working-day calendars.** The most-requested real-world feature and the
   most contained change.
2. **Subgraph recompute.** Only once a board is large enough to need it; the
   threshold is measured, not assumed.
3. **Postgres plus a shared rate limiter.** The prerequisite for more than one
   instance.
4. **Undo from the audit log.** The data is already there.
5. **A bigger AI evaluation set** — 50+ tasks across several domains, so the
   numbers can distinguish models rather than just detect breakage.
