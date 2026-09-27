# Known issues

Two sections: bugs that were found and fixed (with how they were caught), and
issues that are still open.

---

## Fixed during development

Kept in the record because *how* a bug was caught is more informative than the
bug.

### 1. Stack overflow on deep graphs

**Symptom:** `RangeError: Maximum call stack size exceeded` in the 10,000-task
performance test.

**Cause:** `findPath` used recursive depth-first search. A long dependency chain
is a deep recursion, and V8's stack gives out around 10k frames.

**Fix:** rewritten as an iterative BFS with an explicit queue
(`src/engine/graph.ts`).

**Why it matters:** a real board with a long chain would have hit this in
production, and the failure mode is a 500 on every read — because scheduling
would throw. The performance test was written to measure speed and found a
correctness bug instead.

### 2. Non-deterministic critical-edge output

**Symptom:** the determinism property test — schedule the same graph twice,
assert identical output — failed intermittently.

**Cause:** `criticalEdges` was built by filtering the input edge array, so its
order depended on insertion order rather than graph structure. Two databases
with the same graph inserted in different orders produced different output.

**Fix:** explicit deterministic tiebreaks throughout the critical-path dynamic
program, keyed on task key (`src/engine/schedule.ts`).

**Why it matters:** non-determinism makes every downstream test flaky and makes
the graph view appear to change for no reason. It would have been diagnosed as
"the tests are flaky" rather than as a bug.

### 3. A completed task rendering an end date before its start

**Symptom:** the interval-validity invariant (`end ≥ start` for every task)
failed on a seeded board.

**Cause:** for a `DONE` task the engine uses `actual_finish` as the finish. A
task completed on the same day it started has `actualFinish == earliestStart`,
and the half-open interval `[start, start)` converts to an *inclusive* display
end of `start − 1`.

**Fix:** `finishOf` applies a `max(start + 1, actualFinish)` floor
(`src/engine/schedule.ts`).

**Why it matters:** a user seeing "Oct 5 → Oct 4" loses confidence in every
other date on the page. A hand-written test suite would very likely have missed
a same-day completion.

### 4. Config ignored its own `env` argument

**Symptom:** an API test set `ADMIN_TOKEN` in an isolated config and the
token-guarded route still allowed unauthenticated access.

**Cause:** `loadConfig(env)` validated non-secret values from `env` but read
secrets from `process.env` directly.

**Fix:** `optionalSecret(env, name)` (`src/config.ts`).

**Why it matters:** beyond the test isolation failure, this is the class of bug
where a deployment sets a variable one way and the process reads it another.

### 5. Redundancy claimed against unapproved edges

**Symptom:** a suggestion pass reported *"already implied by TF-4 → TF-8 → TF-5
→ TF-7"* where `TF-8 → TF-5` was itself an unapproved suggestion on the same
screen.

**Cause:** both the cycle check and the redundancy check ran against a working
graph that grew as suggestions were accepted within the pass.

**Fix:** cycle checking still uses the working graph — it must be pessimistic,
so that approving everything offered cannot produce a loop — but redundancy is
judged against committed edges only (`src/ai/gates.ts`).

**Why it matters:** it told the user a falsehood about their own board, and the
statement would have become wrong the instant they rejected the other
suggestion.

### 6. The store had a no-op subscriber

**Symptom:** clicking *Graph view* highlighted the button but never showed the
graph.

**Cause:** `boot()` called `subscribe(() => {})`, so `setState` notified nobody.
Handlers that called `render()` directly worked; handlers that relied on the
store did not.

**Fix:** `subscribe(render)` — one line. Now every `setState` re-renders and no
handler has to remember to.

**Why it matters:** it is the canonical vanilla-JS failure mode, and the fix is
structural rather than a patch at each call site.

---

## Open issues

Ordered by likelihood of being noticed.

### Functional

| # | Issue | Impact | Workaround |
| --- | --- | --- | --- |
| O-1 | Calendar days, not working days. A 5-day task can span a weekend | Dates are optimistic for teams that do not work weekends | Add slack, or extend durations |
| O-2 | No undo | A mistaken delete cannot be reversed in the UI | The full diff is in `GET /api/audit`; re-create manually |
| O-3 | Two open tabs do not sync | The second writer gets a `409` rather than an update | Reload |
| O-4 | Deleting a task silently removes its edges | Cascade is correct but the dependents' dates change | The UI warns with the dependent count before deleting |
| O-5 | The project start is fixed per board and not editable in the UI | Cannot re-baseline a plan | `boards.project_start` via SQL |
| O-6 | Seeded demo dates are relative to *today*, so total duration can vary by a day across runs | Screenshots taken on different days differ slightly | Expected; keeps the demo board looking current |

### AI

| # | Issue | Impact | Notes |
| --- | --- | --- | --- |
| O-7 | The evidence gate is lexical | A justification that is semantically wrong but lexically present passes | Catches fabrication, not misinterpretation |
| O-8 | Narrative verification is numeric only | A model could state a wrong *cause* using correct numbers | The prompt forbids speculation; that is not enforced |
| O-9 | Evaluation set is 10 tasks / 4 hidden edges | Detects gross regressions, not fine model differences | [ADR 0005](adr/0005-dual-provider-consensus.md) |
| O-10 | No token-cost tracking | Spend is not visible in the app | Latency is reported per provider |
| O-11 | The offline heuristic has low precision (~0.13 on the eval set) | Keyless suggestions are noisy | Working as intended: it is a floor, and the gates absorb the noise |

### Operational

| # | Issue | Impact | Notes |
| --- | --- | --- | --- |
| O-12 | Single instance only | No horizontal scaling | [ADR 0001](adr/0001-sqlite-over-postgres.md); `Repository` is the only file to change |
| O-13 | Rate limits are per process and reset on restart | A restart clears counters | Acceptable for one instance |
| O-14 | No automated backups | Data loss if the volume is lost | `docs/DEPLOY.md` has a one-line cron using `sqlite3 .backup` |
| O-15 | `ADMIN_TOKEN` unset disables demo reset in production | Intentional: better than an open reset endpoint | Set the variable |
| O-16 | No structured metrics endpoint | No Prometheus scraping | JSON logs to stdout |

### Quality

| # | Issue | Impact |
| --- | --- | --- |
| O-17 | Accessibility not audited with a real screen reader | Designed against WCAG 2.2 AA but unverified |
| O-18 | No browser E2E tests | Frontend logic verified manually |
| O-19 | No i18n | English and ISO dates only |
