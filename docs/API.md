# API

All responses are JSON. All errors are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)
problem documents with `content-type: application/problem+json`, so the client
has exactly one error-handling path. Every response carries an `x-request-id`
header; quote it when reporting a problem.

**Every mutation returns the entire recomputed board plus a diff.** The client
replaces its state rather than patching it, so it cannot drift out of sync with
the server's schedule. See [DESIGN §2.4](DESIGN.md#24-why-the-whole-board-comes-back-from-every-mutation).

## Endpoints

| Method | Path | Limit/min | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | — | Liveness, version, AI configuration |
| GET | `/api/board` | 600 | The whole board with all derived state |
| GET | `/api/audit` | 120 | Activity log with full diffs |
| POST | `/api/tasks` | 120 | Create a task, optionally with prerequisites |
| PATCH | `/api/tasks/:id` | 240 | Edit title, duration, pin, assignee… |
| POST | `/api/tasks/:id/move` | 240 | Change column and/or position |
| DELETE | `/api/tasks/:id` | 120 | Delete a task and its edges |
| POST | `/api/dependencies` | 240 | Add an edge (cycle-checked) |
| DELETE | `/api/dependencies/:id` | 240 | Remove an edge |
| GET | `/api/ai/suggestions` | 120 | Current review queue |
| POST | `/api/ai/suggest-dependencies` | **10** | Run a suggestion pass |
| POST | `/api/ai/suggestions/:id/accept` | 60 | Approve — re-validated on the way in |
| POST | `/api/ai/suggestions/:id/reject` | 60 | Decline, and remember it |
| POST | `/api/ai/explain-impact` | 20 | Non-mutating what-if |
| POST | `/api/admin/reset-demo` | 5 | Reseed (token-guarded) |

The AI suggestion route has the tightest limit because it is the only one that
costs money per call.

---

## `GET /api/board`

```json
{
  "board": {
    "id": "…", "name": "Platform Delivery",
    "projectStart": "2026-09-22",
    "projectFinish": "2026-10-11",
    "settings": { "satisfiedStages": ["DONE"], "enforceBlockedGate": "warn" }
  },
  "tasks": [
    {
      "id": "…", "key": "TF-5", "title": "Frontend Kanban UI",
      "stage": "BACKLOG", "position": "V", "durationDays": 6,
      "plannedStart": null, "isPinned": false, "actualFinish": null,
      "version": 1,

      "scheduledStart": "2026-09-30",   // derived
      "scheduledEnd":   "2026-10-05",   // derived, inclusive for display
      "depState": "BLOCKED",            // derived
      "unmetPrereqKeys": ["TF-3", "TF-8"],
      "slackDays": 0,                   // derived
      "isCritical": true,               // derived
      "isPolicyViolation": false
    }
  ],
  "dependencies": [
    { "id": "…", "predecessorKey": "TF-3", "successorKey": "TF-5",
      "lagDays": 0, "origin": "SEED", "suggestedBy": null, "isCritical": true }
  ],
  "criticalPath": ["…task ids in order…"],
  "stats": { "total": 10, "blocked": 6, "ready": 4, "done": 2,
             "policyViolations": 0, "criticalCount": 6, "durationDays": 20 },
  "ai": { "mode": "consensus", "openaiConfigured": true, "geminiConfigured": true,
          "openaiModel": "gpt-4o-mini", "geminiModel": "gemini-2.0-flash" }
}
```

The `ai` block deliberately exposes only whether a provider is *configured* —
never a credential. A test asserts the response cannot contain something
key-shaped.

---

## `POST /api/dependencies`

```bash
curl -X POST localhost:8080/api/dependencies \
  -H 'content-type: application/json' \
  -d '{"predecessorId":"<id>","successorId":"<id>","lagDays":0}'
```

`201` with `{ board, diff, summary, warnings, narrative }`.

A legal-but-redundant edge is accepted with a warning naming the implying path,
because it is not an error — just noise the user should know about.

### Cycle rejection — `409`

```json
{
  "type": "https://taskflow.pro/problems/cycle-detected",
  "title": "Circular dependency rejected",
  "status": 409,
  "detail": "This dependency would create a cycle: TF-1 -> TF-3 -> TF-8 -> TF-10 -> TF-1",
  "code": "CYCLE_DETECTED",
  "requestId": "…",
  "cycleKeys": ["TF-1", "TF-3", "TF-8", "TF-10", "TF-1"],
  "cyclePath": ["…uuids…"]
}
```

The loop is returned as a closed walk so the UI can render the exact path rather
than a generic conflict. Validation happens *inside* the write transaction, so
the graph is byte-identical afterwards.

---

## `PATCH /api/tasks/:id`

```bash
curl -X PATCH localhost:8080/api/tasks/<id> \
  -H 'content-type: application/json' \
  -d '{"durationDays":8,"expectedVersion":1}'
```

```json
{
  "board": { "…": "…" },
  "diff": {
    "changed": [
      { "id": "…", "startDeltaDays": 0, "endDeltaDays": 3, "slackDeltaDays": 0,
        "depStateBefore": "READY", "depStateAfter": "READY",
        "becameCritical": false, "leftCriticalPath": false }
    ],
    "added": [], "removed": [], "projectFinishDeltaDays": 3
  },
  "summary": "Updated TF-3 (durationDays). 7 tasks rescheduled; project finish slipped 3 day(s)",
  "warnings": [],
  "narrative": {
    "text": "Editing TF-3 pushed the project finish out by 3 days, from 2026-10-11 to 2026-10-14. …",
    "source": "template",
    "facts": { "…": "the engine-derived fact set the prose is checked against" },
    "fallbackReason": null
  }
}
```

`source` is `template` for deterministic prose, or a provider name when a model
wrote it and every figure passed verification. `fallbackReason` explains a
downgrade — including *"openai wrote the unsupported figure \"6\""*.

`expectedVersion` is optional. Supplying it turns a lost update into a
`409 STALE_WRITE` instead of a silent overwrite.

---

## `POST /api/tasks/:id/move`

```json
{ "stage": "IN_PROGRESS", "beforeTaskId": "<id>", "expectedVersion": 3 }
```

Ordering within a column uses `beforeTaskId`/`afterTaskId` rather than an index,
so a reorder is a single-row write (fractional indexing, see
[DESIGN §4.1](DESIGN.md#41-decisions-worth-defending)).

Moving a **blocked** task out of Backlog returns `200` with a warning naming the
blockers, and the task is flagged `isPolicyViolation` on the board. A board
configured with `enforceBlockedGate: "block"` returns `409` instead unless
`acknowledgeBlocked: true` is sent.

---

## `POST /api/ai/suggest-dependencies`

```json
{
  "pending": [
    { "id": "…", "predecessorKey": "TF-4", "successorKey": "TF-5",
      "confidence": 0.92, "agreement": 2,
      "agreementLabel": "2 models agreed (gemini + openai)",
      "providers": ["gemini", "openai"],
      "rationale": "The Kanban UI renders the signed-in user, so it needs the auth service first.",
      "evidence": ["…verbatim span from TF-4…", "…verbatim span from TF-5…"],
      "status": "PENDING", "promptVersion": "suggest-dependencies@1.2.0" }
  ],
  "filtered": [
    { "predecessorKey": "TF-10", "successorKey": "TF-1", "confidence": 0.91,
      "filteredReason": "CYCLE: This dependency would create a cycle: TF-1 -> TF-3 -> TF-8 -> TF-10 -> TF-1" },
    { "predecessorKey": "TF-999", "successorKey": "TF-5", "confidence": 0.95,
      "predecessorId": "",
      "filteredReason": "UNKNOWN_TASK: Referenced a task that does not exist on this board (TF-999)." }
  ],
  "providers": [
    { "provider": "openai", "model": "gpt-4o-mini", "ok": true, "count": 5, "latencyMs": 1840, "error": null, "fallback": false },
    { "provider": "gemini", "model": "gemini-2.0-flash", "ok": true, "count": 6, "latencyMs": 1120, "error": null, "fallback": false }
  ],
  "counts": { "proposed": 11, "cycle": 1, "unknown_task": 1, "redundant": 2, "accepted": 4, "filtered": 7 },
  "degraded": false,
  "latencyMs": 1905
}
```

`filtered` is returned deliberately. Showing the engine overrule the model is
the clearest demonstration of where authority sits; hiding it would hide the
most interesting behaviour in the system. Filtered entries have no accept
action and cannot be approved. A hallucinated key has an empty `predecessorId`,
because there is no row to store it against.

---

## `POST /api/ai/explain-impact`

Non-mutating what-if.

```bash
curl -X POST localhost:8080/api/ai/explain-impact \
  -H 'content-type: application/json' \
  -d '{"taskId":"<id>","durationDays":11}'
```

```json
{
  "simulated": true,
  "diff": { "projectFinishDeltaDays": 5, "changed": ["…"] },
  "narrative": { "text": "Changing TF-5 from 6 to 11 days pushed the project finish out by 5 days, from 2026-10-13 to 2026-10-18. …" }
}
```

The hypothetical duration is applied **in memory only**, and scheduled by the
same pure function that serves the real board — so a preview can never disagree
with the outcome of actually making the change. A test asserts the board is
untouched afterwards.

---

## Error codes

| Code | Status | Meaning |
| --- | --- | --- |
| `VALIDATION_FAILED` | 422 | Body failed validation; `issues` lists field paths |
| `NOT_FOUND` | 404 | Unknown id or route |
| `CYCLE_DETECTED` | 409 | Would create a loop; `cycleKeys` has the path |
| `SELF_EDGE` | 409 | A task cannot depend on itself |
| `DUPLICATE_DEPENDENCY` | 409 | The edge already exists |
| `UNKNOWN_TASK` | 422 | Referenced task is not on this board |
| `STALE_WRITE` | 409 | `expectedVersion` lost; includes `currentVersion` |
| `RATE_LIMITED` | 429 | Includes `retryAfterSeconds` |
| `AI_UNAVAILABLE` | 503 | Every provider failed and no fallback applied |
| `FORBIDDEN` | 403 | Missing or wrong `X-Admin-Token` |
| `PAYLOAD_TOO_LARGE` | 413 | Body exceeded `MAX_BODY_BYTES` |
| `INTERNAL` | 500 | Unexpected; returns only a `requestId` |

A `500` deliberately carries no detail. The client gets an id to quote; the
server log gets the stack trace. A test asserts no stack trace ever reaches a
client.

## Security headers

Every response:

```
content-security-policy: default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self';
  base-uri 'none'; form-action 'none'; frame-ancestors 'none'
x-content-type-options: nosniff
x-frame-options: DENY
referrer-policy: no-referrer
```

There are no inline event handlers and no remote assets anywhere in the
frontend, which is what allows the policy to stay this tight.
`'unsafe-inline'` appears for styles only, for the `style` attributes that
position SVG graph nodes.
