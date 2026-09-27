# Traceability

Each stated requirement mapped to the code that implements it and the test that
proves it. The purpose is to make "did they actually do it" checkable in a
minute rather than by reading the codebase.

## Core requirements

| # | Requirement | Implementation | Test |
| --- | --- | --- | --- |
| R1 | Kanban board with four columns | `web/js/board.js`, `STAGES` | `api.test.ts` → board shape |
| R2 | Create, edit, delete tasks | `services/tasks.ts` | `api.test.ts` → validation, propagation |
| R3 | Drag-and-drop between columns | `board.js` HTML5 DnD + keyboard move buttons | `api.test.ts` → `/move` |
| R4 | Tasks declare dependencies | `services/dependencies.ts`, `dependencies` table | `api.test.ts` → add/remove |
| R5 | **Circular dependencies are prevented** | `engine/graph.ts` `validateAddEdge` → `topoSort` | `engine.graph.test.ts`; `api.test.ts` → cycle rejection, graph unchanged |
| R6 | Blocked tasks are identified with their blockers | `engine/schedule.ts` `depState`, `unmetPrereqIds` | `engine.state.test.ts` |
| R7 | **Dates propagate through the graph** | `engine/schedule.ts` forward pass | `engine.propagation.test.ts` → diamond, slack, chain |
| R8 | Critical path is identified | `engine/schedule.ts` backward pass + DP | `engine.criticalpath.test.ts` |
| R9 | Data survives a refresh | `db/` SQLite + WAL | `api.test.ts` → restart persistence |
| R10 | AI suggests dependencies | `ai/consensus.ts`, `services/suggestions.ts` | `ai.consensus.test.ts`; `api.test.ts` → suggestion pass |
| R11 | AI explains schedule impact | `ai/narrative.ts` | `ai.consensus.test.ts` → grounding; `api.test.ts` → narrative |
| R12 | AI output cannot corrupt the graph | `ai/gates.ts` — seven gates | `ai.gates.test.ts` — one test per gate |
| R13 | Deployed and publicly reachable | `Dockerfile`, `docker-compose.yml`, `deploy/` | CI `docker` job boots the image and checks `/api/health` |
| R14 | Architecture + data model + limitations document | [`docs/DESIGN.md`](DESIGN.md) | — |

## Cycle prevention in detail

The headline requirement, so the mapping is explicit.

| Property | Where | Test |
| --- | --- | --- |
| Direct self-edge refused | `validateAddEdge` `SELF_EDGE` | `ai.gates.test.ts`, `api.test.ts` |
| Two-node loop refused | reachability check | `engine.graph.test.ts` |
| Long transitive loop refused | `findPath` BFS | `engine.graph.test.ts` |
| The offending path is reported | `topoSort` cycle walk → `cycleKeys` | `api.test.ts` asserts a closed walk |
| Duplicate edge refused | `DUPLICATE` + a UNIQUE index | `api.test.ts` |
| Redundant edge allowed, with a warning | `redundantVia` | `engine.graph.test.ts` |
| A rejection changes nothing | validation inside `BEGIN IMMEDIATE` | `api.test.ts` asserts field-by-field equality |
| **Concurrent inverse inserts** | `BEGIN IMMEDIATE` | `api.test.ts` `Promise.all`, exactly one wins |
| AI cannot introduce a cycle | gate 5 uses the same `validateAddEdge` | `ai.gates.test.ts` |
| Two suggestions circular only *together* | working graph grows during the pass | `ai.gates.test.ts` |
| A stale accepted suggestion is refused | re-validated inside the transaction | `api.test.ts` |
| No cycle can be stored, ever | `computeSchedule` throws on a cyclic stored graph | `services/board.ts` |

## Propagation correctness

| Property | Test | Why it is the interesting case |
| --- | --- | --- |
| Diamond: +3 moves the join by 3, not 6 | `engine.propagation.test.ts` | The bug delta propagation always has |
| Path count does not affect the result | `engine.propagation.test.ts` | Generalises the diamond to its whole shape class |
| A task with slack absorbs a change | `engine.propagation.test.ts` | The other delta-propagation failure |
| Lag is respected | `engine.propagation.test.ts` | — |
| A pinned start overrides earlier availability | `engine.propagation.test.ts` | — |
| A completed task uses its actual finish | `engine.propagation.test.ts` | History is a fact, not a prediction |
| No interval is ever inverted | `engine.property.test.ts` | Found bug #3 |
| Identical input → identical output | `engine.property.test.ts` | Found bug #2 |
| 10,000 tasks schedule in bounded time | `engine.property.test.ts` | Found bug #1 |

## Non-functional

| Requirement | Implementation | Verification |
| --- | --- | --- |
| Input validation at the edge | `validate.ts` + per-route checks | `api.test.ts` → 422 with field paths |
| Consistent error contract | `http/problem.ts`, RFC 9457 | `api.test.ts` → problem shape, request id |
| No secrets reach the client | `config.ts` `publicAiInfo` | `api.test.ts` asserts no key-shaped string |
| No stack traces reach the client | one error funnel in `http/server.ts` | `api.test.ts` |
| Rate limiting | token bucket per client + route | route table in `http/routes.ts` |
| Path traversal blocked | `serveStatic` normalise + prefix check | `api.test.ts` |
| CSP and security headers | `SECURITY_HEADERS` | `api.test.ts` |
| Optimistic concurrency | `version` column + `expectedVersion` | `api.test.ts` → 409 `STALE_WRITE` |
| Body size cap | `MAX_BODY_BYTES` | `http/server.ts` → 413 |
| Audit trail with diffs | `repo.appendAudit` in every mutation | `GET /api/audit` |
| Graceful shutdown | SIGTERM handler in `main.ts` | Docker `tini` + healthcheck |
| Keyboard operable | move buttons on every card, focus styles | manual |
| Screen-reader announcements | `#live` ARIA region, `announce()` | manual |
| Works with no AI key | `HeuristicProvider` | `ai.consensus.test.ts`; CI runs keyless |

## Submission checklist mapping

| Checklist item | Where |
| --- | --- |
| Problem statement addressed | [README](../README.md) → "What is actually hard here" |
| Architecture document | [docs/DESIGN.md](DESIGN.md) §2 |
| Data model | [docs/DESIGN.md](DESIGN.md) §4 |
| Known limitations | [docs/DESIGN.md](DESIGN.md) §7, [KNOWN-ISSUES.md](KNOWN-ISSUES.md) |
| Key assumptions | [README](../README.md) → "Key assumptions" |
| Setup instructions | [README](../README.md) → "60-second quickstart" |
| AI tool usage declared | [AI-TOOL-DECLARATION.md](../AI-TOOL-DECLARATION.md) |
| Tests | [docs/TEST-PLAN.md](TEST-PLAN.md), 120 tests |
| Deployment | [docs/DEPLOY.md](DEPLOY.md) |
| Demo script | [docs/DEMO.md](DEMO.md) |
