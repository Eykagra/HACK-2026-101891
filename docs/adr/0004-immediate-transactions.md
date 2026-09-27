# ADR 0004 — `BEGIN IMMEDIATE` for every graph mutation

**Status:** Accepted · **Date:** 2026-09-27

## Context

Cycle prevention has a race condition that is easy to miss and impossible to
paper over.

```
   request 1                     request 2
   ─────────                     ─────────
   read graph                    read graph
   is A→B a cycle? no            is B→A a cycle? no
   insert A→B                    insert B→A
                     ↓
              the graph now has a cycle
```

Both requests validated correctly against the graph as they read it. Neither did
anything wrong. The stored graph is now invalid, and — worse — every subsequent
read fails, because scheduling a cyclic graph is impossible. One lost race
corrupts the board permanently.

## Options considered

### A. Validate, then write (no transaction)

The bug above. Rejected.

### B. Retry on conflict

Rejected: there is no conflict to detect. Both inserts succeed. Retrying
re-runs a check that already passed.

### C. Optimistic version numbers on tasks

Rejected: neither *task* changed. The invariant being violated is a property of
the graph, not of any row, so per-row versioning cannot see it.

### D. An application-level mutex

Rejected: does not survive a process restart, silently does nothing across
multiple instances, and adds a deadlock risk. It is a lock that looks like a
lock without being one.

### E. `SELECT ... FOR UPDATE` on the board row

The Postgres-idiomatic answer, and a good one — but it needs Postgres
([ADR 0001](0001-sqlite-over-postgres.md)) and adds a lock row whose only
purpose is to be locked.

### F. `BEGIN IMMEDIATE` — **chosen**

SQLite's default `BEGIN` is *deferred*: the write lock is acquired lazily, on
the first write. `BEGIN IMMEDIATE` acquires it up front, before the transaction
reads anything.

That single word closes the race. Request 2 blocks until request 1 commits,
then reads a graph that already contains `A → B`, detects the cycle, and refuses
correctly.

## Implementation

```ts
export function withTransaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');   // write lock taken here, before any read
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');        // the rejected edge leaves no trace
    throw error;
  }
}
```

Every graph mutation — create task with dependencies, add dependency, remove
dependency, accept suggestion, delete task — runs inside one of these, and the
recompute of derived columns happens in the same transaction as the change that
caused it. Derived state therefore cannot be observed disagreeing with the
graph.

## Consequences

**Writes are serialised.** Correct, and irrelevant at this scale: one
transaction per user action, each a few milliseconds. WAL mode keeps readers
concurrent throughout.

**Rejections are byte-clean.** Because validation happens *inside* the
transaction, raising an error rolls back the insert and the derived-column
writes together. A refused dependency leaves the board exactly as it was — which
is asserted field-by-field in `test/api.test.ts`.

**The test is the deliverable.** `Promise.all` fires both inverse inserts
simultaneously and asserts exactly one returns 201 and the other 409. Without
`IMMEDIATE`, that test fails.

## Revisit when

Migrating to Postgres: the equivalent is `SET TRANSACTION ISOLATION LEVEL
SERIALIZABLE` with retry on `40001`, or an explicit lock on the board row.
