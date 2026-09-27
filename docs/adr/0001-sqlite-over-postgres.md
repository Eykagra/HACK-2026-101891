# ADR 0001 — SQLite over Postgres

**Status:** Accepted · **Date:** 2026-09-27

## Context

The app needs durable storage with real transactions, because dependency
validation and insertion have to be atomic (see
[ADR 0004](0004-immediate-transactions.md)). The deployment target is a single
EC2 instance for a time-boxed build.

## Options considered

### A. Postgres (via Prisma or Drizzle)

The default professional answer. Real concurrency, advisory locks, `WITH
RECURSIVE` for reachability queries, and the obvious scaling story.

Rejected, and the honest reason matters: **it could not be run or tested in the
build environment.** Shipping database code that had never executed against a
real server would have been the single largest correctness risk in the project.
Untested persistence code that looks professional is worse than tested
persistence code that looks modest. It also adds a container, a migration tool,
a connection pool and roughly 60 MB of dependencies to a single-instance demo.

### B. SQLite via `better-sqlite3`

The usual choice. Rejected because it is a native module requiring a compile
step, which complicates the Docker build and the setup instructions for no
functional gain over the alternative below.

### C. `node:sqlite` — **chosen**

Built into Node 24. Synchronous, transactional, zero dependencies, no compile
step.

- **Transactions are real.** `BEGIN IMMEDIATE` gives exactly the serialisation
  the cycle-prevention race needs, which is the one hard concurrency
  requirement in the system.
- **Synchronous API is an advantage here.** The whole scheduling recompute is
  CPU-bound and sub-millisecond at demo scale. Making it `async` would add
  interleaving points inside a transaction — more ways to be wrong, no
  throughput gained.
- **WAL mode** allows concurrent readers alongside one writer, which matches the
  access pattern: many board reads, occasional mutations.
- Setup is genuinely two commands, with nothing to install and nothing to
  configure.

### D. In-memory with a JSON snapshot

Rejected. "Data survives a refresh" is an explicit requirement, and hand-rolled
atomic file writes are a worse version of a problem SQLite already solved.

## Consequences

**Accepted cost: one process.** SQLite serialises writes at the file level, so
horizontal scaling is not available. For a single-board planning tool this is
not the binding constraint; write volume is one transaction per user action.

**Mitigation — the migration seam is real, not aspirational.** `Repository` is
the only file in the codebase containing SQL. Services depend on its methods,
never on a driver. Porting to Postgres means rewriting one file and swapping
`BEGIN IMMEDIATE` for `SERIALIZABLE`; nothing above `db/` changes, and the
existing test suite validates the port.

Every schema choice is already Postgres-compatible: no SQLite-specific types, no
`rowid` dependence, ISO-8601 strings for timestamps, integers for dates.

## Revisit when

More than one application instance is needed, or write contention becomes
measurable rather than theoretical.
