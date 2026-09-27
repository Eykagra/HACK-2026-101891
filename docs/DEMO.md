# Five-minute demo script

Ordered so each step builds on the last. Timings assume talking while clicking.

---

## 0:00 — Frame the problem (20s)

> "This looks like a Kanban board. Underneath it is a scheduling engine.
> Every date you can see is computed, not typed — and that turns out to be the
> only way to make dependencies work."

Point at one card. It shows: the key, blocked-or-ready state, **what it is
waiting on**, its computed dates, its duration, and either its slack or a
critical-path badge.

---

## 0:20 — Correct propagation (60s) · *the most important minute*

Open **TF-3 (Backend API endpoints)**. Press **+** three times: 5 days → 8.

> "Seven tasks just moved. The project finish slipped exactly **three** days."

Then say the thing that matters:

> "TF-3 feeds two parallel tasks, TF-5 and TF-6, and both feed TF-7. The
> obvious implementation pushes each successor forward by three, which moves
> TF-7 by six. That is wrong — it moves by three. That is why this engine
> re-solves the whole graph instead of propagating a delta."

Now open **TF-6 (Notification service)** — it has **5 days of slack**. Press
**+** once.

> "Nothing downstream moved. It had float, and the float absorbed it. Delta
> propagation gets this wrong in the other direction."

Undo both with **−**.

---

## 1:20 — Cycle rejection (40s)

Open **TF-1 (Design database schema)** → *Depends on* → the dropdown.

> "TF-10 isn't offered. The client already knows it's downstream, so offering
> it would be offering a guaranteed error."

Then prove the server does not rely on that:

```bash
curl -X POST localhost:8080/api/dependencies \
  -H 'content-type: application/json' \
  -d '{"predecessorId":"<TF-10 id>","successorId":"<TF-1 id>"}'
```

```
409  CYCLE_DETECTED
"This dependency would create a cycle: TF-1 -> TF-3 -> TF-8 -> TF-10 -> TF-1"
```

> "It names the exact loop. And validation happens *inside* the write
> transaction, so nothing moved — not the edge, not a single date. There's a
> test that fires the two halves of that cycle simultaneously with
> `Promise.all` and asserts exactly one wins."

---

## 2:00 — The DAG (30s)

Click **Graph view**.

> "Laid out by dependency depth, so every arrow points left to right. The
> absence of a backward arrow *is* the proof the graph is acyclic. Orange is
> the critical path."

Tick **Critical path only** to strip it to the spine.

---

## 2:30 — AI under supervision (90s) · *the second most important minute*

Click **Suggest dependencies**.

> "Two models, OpenAI and Gemini, asked the same question in parallel."

Point at an agreed suggestion:

> "Both models found this one independently. That's a much stronger signal than
> one confident model, so it's shown as a label rather than averaged into a
> score."

Then scroll to **Blocked by the dependency engine** — the part to dwell on:

> "These are the model's ideas that the engine refused, and they're shown on
> purpose.
>
> This one invented a task that doesn't exist. This one would have created a
> cycle — here's the exact path. This one is already implied by an existing
> path. This one quoted a justification that appears nowhere in the task text,
> so it was fabricated.
>
> Seven deterministic gates run before a human sees anything. The AI proposes,
> the engine disposes, and then a person approves."

Click **Accept** on one.

> "Accepting re-runs the full cycle check inside the write transaction. There's
> no privileged insert path for AI — it goes through exactly what a manual edge
> goes through. If the board changed since the suggestion was rendered, it gets
> refused."

Point at the toast:

> "Every number in that explanation came from the scheduler. The model only
> phrased it — and the prose is scanned afterwards to make sure every figure in
> it is one the engine actually produced. If the model writes 'six days' when
> the engine said three, the text is thrown away."

---

## 4:00 — Non-destructive what-if (30s)

Open any task → **Preview +3 days without changing anything**.

> "Full impact analysis, computed by the same scheduler that serves the real
> board, with nothing written. It can't disagree with the outcome, because it's
> the same pure function."

---

## 4:30 — Close on engineering (30s)

> "120 tests. The interesting ones are property tests over randomly generated
> DAGs — they assert invariants rather than snapshots, which is how you rule out
> a *class* of bug instead of one case.
>
> Three real bugs came from that: a stack overflow at ten thousand nodes from
> recursive DFS, non-deterministic output from inherited input ordering, and a
> completed task rendering an end date before its start date. All three are in
> `docs/KNOWN-ISSUES.md` with how they were caught.
>
> Zero runtime dependencies. Node's standard library, SQLite, and the DOM."

---

## If asked

**"Why not Postgres?"** → [ADR 0001](adr/0001-sqlite-over-postgres.md). Short
version: a real transaction is the one hard requirement, `BEGIN IMMEDIATE`
provides it, and `Repository` is the only file with SQL in it, so the port is
one file.

**"Why no React?"** → [ADR 0003](adr/0003-no-frontend-framework.md). One piece
of state, replaced wholesale on every change. No build step means no stale
bundle during a demo.

**"How do you know the AI suggestions are any good?"** → `npm run ai:eval`.
Hides four known-true dependencies, scores precision/recall/F1 *after* gating,
and includes the offline heuristic as a floor.

**"What breaks first at scale?"** → the full recompute, at roughly 10k tasks
(~45 ms). The fix is subgraph recompute, not delta propagation —
[ADR 0002](adr/0002-recompute-over-delta.md).

**"What would you do next?"** → working-day calendars, then Postgres and a
shared rate limiter for multi-instance, then undo from the audit log.
