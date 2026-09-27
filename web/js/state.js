/**
 * The client store.
 *
 * Single source of truth, replaced wholesale on every server response. There is
 * no optimistic local mutation anywhere in this app, and that is a considered
 * decision: the schedule is a global function of the graph, so "guess locally,
 * reconcile later" would mean rendering dates the server may reject a moment
 * later. Correct-and-a-moment-late beats fast-and-wrong for a planning tool.
 */

const listeners = new Set();

/** @type {{ board: any, suggestions: any, view: 'board'|'graph', criticalOnly: boolean, pending: Set<string>, highlight: Set<string> }} */
export const state = {
  board: null,
  suggestions: { pending: [], filtered: [], providers: [], counts: {} },
  view: 'board',
  criticalOnly: false,
  /** Ids of in-flight mutations, used to disable controls without a global lock. */
  pending: new Set(),
  /** Task ids to pulse after the last change. */
  highlight: new Set(),
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of listeners) fn(state);
}

/** @param {Partial<typeof state>} patch */
export function setState(patch) {
  Object.assign(state, patch);
  emit();
}

export const tasks = () => state.board?.tasks ?? [];
export const dependencies = () => state.board?.dependencies ?? [];
export const taskById = (id) => tasks().find((t) => t.id === id) ?? null;
export const keyMap = () => new Map(tasks().map((t) => [t.id, t.key]));

/** Prerequisites of a task, as task views. */
export function predecessorsOf(taskId) {
  const byId = new Map(tasks().map((t) => [t.id, t]));
  return dependencies()
    .filter((d) => d.successorId === taskId)
    .map((d) => ({ dependency: d, task: byId.get(d.predecessorId) }))
    .filter((x) => x.task);
}

/** Tasks this one blocks. */
export function successorsOf(taskId) {
  const byId = new Map(tasks().map((t) => [t.id, t]));
  return dependencies()
    .filter((d) => d.predecessorId === taskId)
    .map((d) => ({ dependency: d, task: byId.get(d.successorId) }))
    .filter((x) => x.task);
}

/**
 * Tasks that may legally become a prerequisite of `taskId`.
 *
 * Mirrors the server's rules so the dropdown does not offer a choice that is
 * certain to be refused: no self-edge, no duplicate, and nothing already
 * downstream (which would close a loop). The server still validates — this is
 * courtesy, not security, and the two implementations are checked against each
 * other by the API tests.
 */
export function legalPredecessors(taskId) {
  const existing = new Set(predecessorsOf(taskId).map((p) => p.task.id));
  const downstream = reachableFrom(taskId);
  return tasks()
    .filter((t) => t.id !== taskId && !existing.has(t.id) && !downstream.has(t.id))
    .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}

/** Everything reachable by following dependency edges forwards. */
export function reachableFrom(taskId) {
  const adjacency = new Map();
  for (const d of dependencies()) {
    if (!adjacency.has(d.predecessorId)) adjacency.set(d.predecessorId, []);
    adjacency.get(d.predecessorId).push(d.successorId);
  }
  const seen = new Set();
  const stack = [taskId];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return seen;
}

/** Marks the tasks a diff touched so the board can pulse them once. */
export function highlightFromDiff(diff) {
  state.highlight = new Set(
    (diff?.changed ?? [])
      .filter(
        (d) =>
          d.startDeltaDays !== 0 || d.endDeltaDays !== 0 || d.depStateBefore !== d.depStateAfter,
      )
      .map((d) => d.id),
  );
}
