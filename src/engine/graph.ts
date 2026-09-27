/**
 * Graph primitives: adjacency, deterministic topological sort, reachability,
 * and the single authority that decides whether a new dependency edge is legal.
 */

import type { CycleError, EdgeInput, EdgeVerdict, Graph, Result, TaskId } from './types.ts';
import { err, ok } from './types.ts';

export interface Adjacency {
  successors: Map<TaskId, EdgeInput[]>;
  predecessors: Map<TaskId, EdgeInput[]>;
  ids: TaskId[];
  keyOf: Map<TaskId, string>;
}

/**
 * Compare two task keys "naturally", so `TF-2` sorts before `TF-10`.
 * Used purely to make every traversal deterministic: identical input always
 * produces byte-identical output, which is what makes the engine testable.
 */
export function naturalCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const as = a.match(re) ?? [];
  const bs = b.match(re) ?? [];
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    const x = as[i]!;
    const y = bs[i]!;
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return as.length - bs.length;
}

export function buildAdjacency(g: Graph): Adjacency {
  const successors = new Map<TaskId, EdgeInput[]>();
  const predecessors = new Map<TaskId, EdgeInput[]>();
  const keyOf = new Map<TaskId, string>();

  for (const t of g.tasks) {
    successors.set(t.id, []);
    predecessors.set(t.id, []);
    keyOf.set(t.id, t.key);
  }
  for (const e of g.edges) {
    // Edges referencing unknown tasks are ignored here; `validateAddEdge`
    // rejects them at the boundary so they can never be persisted.
    successors.get(e.predecessorId)?.push(e);
    predecessors.get(e.successorId)?.push(e);
  }

  const cmp = (x: TaskId, y: TaskId) => naturalCompare(keyOf.get(x) ?? x, keyOf.get(y) ?? y);
  for (const list of successors.values()) list.sort((p, q) => cmp(p.successorId, q.successorId));
  for (const list of predecessors.values())
    list.sort((p, q) => cmp(p.predecessorId, q.predecessorId));

  const ids = [...keyOf.keys()].sort(cmp);
  return { successors, predecessors, ids, keyOf };
}

/**
 * Kahn's algorithm, O(V + E). Returns the cycle when the graph is not a DAG,
 * so callers can render `TF-1 -> TF-3 -> TF-7 -> TF-1` instead of a bare error.
 */
export function topoSort(g: Graph, prebuilt?: Adjacency): Result<TaskId[], CycleError> {
  const adj = prebuilt ?? buildAdjacency(g);
  const indegree = new Map<TaskId, number>();
  for (const id of adj.ids) indegree.set(id, adj.predecessors.get(id)!.length);

  // Deterministic frontier: `adj.ids` is already key-sorted, and we always take
  // the lowest-keyed ready node, so the emitted order is stable.
  const ready = adj.ids.filter((id) => indegree.get(id) === 0);
  const order: TaskId[] = [];

  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const e of adj.successors.get(id)!) {
      const next = indegree.get(e.successorId)!;
      indegree.set(e.successorId, next - 1);
      if (next - 1 === 0) {
        // Insert in key order to keep the traversal deterministic.
        const key = adj.keyOf.get(e.successorId) ?? e.successorId;
        let at = ready.length;
        for (let i = 0; i < ready.length; i++) {
          if (naturalCompare(key, adj.keyOf.get(ready[i]!) ?? ready[i]!) < 0) {
            at = i;
            break;
          }
        }
        ready.splice(at, 0, e.successorId);
      }
    }
  }

  if (order.length !== adj.ids.length) {
    const emitted = new Set(order);
    const stuck = new Set(adj.ids.filter((id) => !emitted.has(id)));
    const cycle = extractCycle(adj, stuck);
    return err({
      code: 'CYCLE',
      path: cycle,
      message: `Dependency cycle: ${cycle.map((id) => adj.keyOf.get(id) ?? id).join(' -> ')}`,
    });
  }
  return ok(order);
}

/** Recover one concrete cycle from the set of nodes that never reached indegree 0. */
function extractCycle(adj: Adjacency, stuck: Set<TaskId>): TaskId[] {
  const start = [...stuck].sort((a, b) =>
    naturalCompare(adj.keyOf.get(a) ?? a, adj.keyOf.get(b) ?? b),
  )[0]!;
  const seen = new Map<TaskId, number>();
  const stack: TaskId[] = [];
  let node = start;
  for (;;) {
    if (seen.has(node)) {
      return [...stack.slice(seen.get(node)!), node];
    }
    seen.set(node, stack.length);
    stack.push(node);
    const next = adj.successors.get(node)!.find((e) => stuck.has(e.successorId));
    if (!next) return [...stack, start];
    node = next.successorId;
  }
}

/**
 * Shortest path from `from` to `to`, inclusive of both ends, or `null` when
 * `to` is unreachable.
 *
 * Deliberately breadth-first and iterative. A recursive depth-first walk
 * overflows the call stack on realistically deep graphs (it died at ~10k nodes
 * during testing), and BFS additionally yields the *shortest* cycle, which
 * makes the rejection message a user can act on rather than a 40-node walk.
 */
export function findPath(g: Graph, from: TaskId, to: TaskId): TaskId[] | null {
  return findPathIn(buildAdjacency(g), from, to);
}

export function findPathIn(adj: Adjacency, from: TaskId, to: TaskId): TaskId[] | null {
  if (!adj.keyOf.has(from) || !adj.keyOf.has(to)) return null;
  if (from === to) return [from];

  const parent = new Map<TaskId, TaskId>();
  const seen = new Set<TaskId>([from]);
  const queue: TaskId[] = [from];

  for (let head = 0; head < queue.length; head++) {
    for (const e of adj.successors.get(queue[head]!) ?? []) {
      const next = e.successorId;
      if (seen.has(next)) continue;
      seen.add(next);
      parent.set(next, queue[head]!);
      if (next === to) {
        const path: TaskId[] = [to];
        let cursor = to;
        while (parent.has(cursor)) {
          cursor = parent.get(cursor)!;
          path.push(cursor);
        }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

export function isReachable(g: Graph, from: TaskId, to: TaskId): boolean {
  return findPath(g, from, to) !== null;
}

/**
 * The only place in the system that decides whether a dependency may exist.
 *
 * A new edge `u -> v` closes a cycle exactly when `u` is already reachable from
 * `v`. Checking that direction is O(V + E) and the DFS stack *is* the cycle, so
 * the rejection can name the offending path.
 *
 * `REDUNDANT` is reported as a warning rather than a rejection: the edge is
 * legal but already implied transitively, so the UI can offer to skip it. This
 * also filters the majority of low-value LLM suggestions.
 */
export function validateAddEdge(g: Graph, edge: EdgeInput): EdgeVerdict {
  const { predecessorId, successorId } = edge;
  const adj = buildAdjacency(g);
  const label = (id: TaskId) => adj.keyOf.get(id) ?? id;

  if (!adj.keyOf.has(predecessorId) || !adj.keyOf.has(successorId)) {
    return {
      kind: 'REJECTED',
      code: 'UNKNOWN_TASK',
      message: 'Both tasks must exist on this board.',
    };
  }
  if (predecessorId === successorId) {
    return {
      kind: 'REJECTED',
      code: 'SELF_EDGE',
      message: `${label(predecessorId)} cannot depend on itself.`,
    };
  }
  if ((adj.successors.get(predecessorId) ?? []).some((e) => e.successorId === successorId)) {
    return {
      kind: 'REJECTED',
      code: 'DUPLICATE',
      message: `${label(predecessorId)} -> ${label(successorId)} already exists.`,
    };
  }

  const backPath = findPathIn(adj, successorId, predecessorId);
  if (backPath) {
    const cyclePath = [...backPath, successorId];
    return {
      kind: 'REJECTED',
      code: 'CYCLE',
      cyclePath,
      message: `This dependency would create a cycle: ${cyclePath.map(label).join(' -> ')}`,
    };
  }

  // Already implied by a longer chain?
  const indirect = findPathIn(adj, predecessorId, successorId);
  return { kind: 'OK', redundantVia: indirect && indirect.length > 2 ? indirect : null };
}
