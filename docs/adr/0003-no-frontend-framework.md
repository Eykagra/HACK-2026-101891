# ADR 0003 — No frontend framework and no bundler

**Status:** Accepted · **Date:** 2026-09-27

## Context

The UI needs four columns, drag-and-drop, a task drawer, an AI review panel, an
SVG dependency graph and toast notifications.

## Options considered

### A. React + Vite

The default. Rejected for this project, for reasons specific to it:

- **The state model does not benefit.** There is exactly one piece of state —
  the board returned by the server — and it is replaced wholesale on every
  change. No optimistic updates, no client-side scheduling, no derived local
  state. React's value is managing complex state transitions; there are none
  here.
- **A build step costs more than it returns.** `npm start` currently runs the
  app with no compile, no dev server, and no chance of a stale bundle during a
  demo. Adding a bundler to save some DOM-building code is a bad exchange when
  the total DOM-building code is a 30-line helper.
- **Dependency surface.** React plus Vite is ~300 packages. For a project judged
  partly on auditability, every one of them is unreviewed code.

### B. A small library (Preact, Alpine, htmx)

Rejected as the worst of both: still a dependency and a build step or a CDN, but
without the ecosystem that justifies React.

### C. Vanilla ES modules — **chosen**

Nine modules, loaded natively by the browser, with JSDoc types.

- No build step. Edit, reload.
- A single `el()` helper builds DOM nodes. Because it assigns text through
  `textContent` exclusively, it is also the one place that guarantees an
  attacker-influenced string — a task title, an AI rationale — can never become
  markup. That is easier to prove here than with a framework's escape hatches.
- Modules split along real seams: `api`, `state`, `board`, `drawer`, `ai`,
  `graph`, `toast`, `dom`, `main`.

## Consequences

**Accepted cost: manual re-rendering.** `renderBoard` rebuilds its subtree. At
a few dozen cards this is imperceptible; at a few thousand it would need
keyed reconciliation — which is the point at which a framework earns its place.

**Mitigation for the classic vanilla-JS failure mode.** The usual way this goes
wrong is handlers that mutate the DOM directly and drift out of sync with the
data. That is structurally prevented: `render()` is subscribed to the store, so
every `setState` re-renders, and no handler touches the DOM itself. (This was
briefly wrong during development — the subscriber was a no-op and the graph
view silently never appeared. The fix was one line, and the lesson is that the
discipline has to be enforced by the wiring, not by remembering.)

**No TypeScript in the browser**, since that would need a build step. JSDoc
annotations give editor support without one.

## Revisit when

Boards routinely exceed ~500 visible cards, or realtime collaborative editing is
added.
