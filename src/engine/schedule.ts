/**
 * The scheduling engine: a critical-path-method pass over the dependency DAG.
 *
 * ## Why this is a recompute and not a delta propagation
 *
 * The naive approach to "task A slipped 3 days" is to walk A's successors and
 * shift each of them by +3. That is wrong in two ways the problem statement
 * cares about:
 *
 *   1. **Compounding.** In a diamond `A -> B -> D` and `A -> C -> D`, task D is
 *      reached twice and moves +6.
 *   2. **Slack.** Adding a `visited` set fixes the arithmetic but not the
 *      semantics: if D is actually held by some other predecessor, or if one
 *      diamond arm is shorter than the other, the correct answer is *less* than
 *      +3 and a delta walk cannot know that.
 *
 * Instead we store only the *inputs* (duration, pins, edges) and derive the
 * schedule with `earliestStart = max(constraints)`. Because `max` is idempotent
 * under a common shift:
 *
 *     ES(D) = max(EF(B), EF(C))
 *     A grows by 3  =>  EF(B) += 3 and EF(C) += 3
 *                   =>  ES(D) = max(x + 3, y + 3) = max(x, y) + 3
 *
 * D moves by exactly 3 through two paths, or ten paths, or a hundred. The
 * no-compounding guarantee is a property of the formula rather than a special
 * case in the code, and slack falls out for free because `max` ignores any
 * path that is not binding.
 */

import { buildAdjacency, naturalCompare, topoSort } from './graph.ts';
import type {
  CycleError,
  Graph,
  Result,
  ScheduleOptions,
  ScheduleResult,
  Stage,
  TaskId,
  TaskInput,
  TaskSchedule,
} from './types.ts';
import { err, ok } from './types.ts';

export const DEFAULT_SATISFIED_STAGES: readonly Stage[] = ['DONE'];

/**
 * Effective finish of a task given its start: a recorded actual wins over the
 * estimate, but a task always occupies at least one day.
 *
 * The floor matters. Without it, a task completed on the same day it became
 * available yields the empty interval `[x, x)`, and the UI renders an end date
 * one day *before* the start. Half-open intervals make that class of bug
 * cheap to fix once and impossible to reintroduce.
 */
function finishOf(task: TaskInput, start: number): number {
  if (task.actualFinish !== null) return Math.max(start + 1, task.actualFinish);
  return start + task.durationDays;
}

export function scheduleGraph(g: Graph, opts: ScheduleOptions): Result<ScheduleResult, CycleError> {
  // Build the adjacency index exactly once and share it with every pass; this
  // is the difference between three O(V log V) sorts per recompute and one.
  const adj = buildAdjacency(g);
  const sorted = topoSort(g, adj);
  if (!sorted.ok) return err(sorted.error);

  const order = sorted.value;
  const taskById = new Map(g.tasks.map((t) => [t.id, t] as const));
  const satisfied = new Set(opts.satisfiedStages);

  const ES = new Map<TaskId, number>();
  const EF = new Map<TaskId, number>();
  const depth = new Map<TaskId, number>();

  // ---- Forward pass: earliest feasible dates ------------------------------
  for (const id of order) {
    const task = taskById.get(id)!;
    let start = opts.projectStart;
    let level = 0;

    if (task.isPinned && task.plannedStart !== null) {
      start = Math.max(start, task.plannedStart);
    }
    for (const e of adj.predecessors.get(id)!) {
      // Predecessors are already finalised: `order` is topological.
      start = Math.max(start, EF.get(e.predecessorId)! + e.lagDays);
      level = Math.max(level, depth.get(e.predecessorId)! + 1);
    }

    ES.set(id, start);
    EF.set(id, finishOf(task, start));
    depth.set(id, level);
  }

  const projectFinish = order.length
    ? Math.max(...order.map((id) => EF.get(id)!))
    : opts.projectStart;

  // ---- Backward pass: latest dates, slack, criticality ---------------------
  const LF = new Map<TaskId, number>();
  const LS = new Map<TaskId, number>();

  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!;
    const successors = adj.successors.get(id)!;
    let latestFinish = successors.length === 0 ? projectFinish : Number.POSITIVE_INFINITY;
    for (const e of successors) {
      latestFinish = Math.min(latestFinish, LS.get(e.successorId)! - e.lagDays);
    }
    // Use the realised span rather than the estimate, so a task with a recorded
    // actual finish does not report phantom slack.
    const span = EF.get(id)! - ES.get(id)!;
    LF.set(id, latestFinish);
    LS.set(id, latestFinish - span);
  }

  // ---- Dependency state ----------------------------------------------------
  const byId: Record<TaskId, TaskSchedule> = {};
  order.forEach((id, topoIndex) => {
    const unmet = adj.predecessors
      .get(id)!
      .map((e) => e.predecessorId)
      .filter((pid) => !satisfied.has(taskById.get(pid)!.stage));

    const slack = LS.get(id)! - ES.get(id)!;
    byId[id] = {
      id,
      earliestStart: ES.get(id)!,
      earliestFinish: EF.get(id)!,
      latestStart: LS.get(id)!,
      latestFinish: LF.get(id)!,
      slackDays: slack,
      isCritical: slack === 0,
      depState: unmet.length > 0 ? 'BLOCKED' : 'READY',
      unmetPrereqIds: unmet,
      topoIndex,
      depth: depth.get(id)!,
    };
  });

  const { path, edges: criticalEdges } = extractCriticalPath(g, adj, order, byId, ES, EF);

  return ok({
    byId,
    order,
    projectStart: opts.projectStart,
    projectFinish,
    criticalPath: path,
    criticalEdges,
  });
}

/**
 * The critical path is the longest chain *by duration*, not by node count.
 *
 * Ties are normal, so every zero-slack task is marked critical and one
 * canonical chain is then chosen by dynamic programming over binding edges,
 * breaking ties on the natural task key so the UI and the tests always agree.
 *
 * The DP is a single reverse-topological sweep rather than a recursive walk:
 * recursion here overflows the stack on deep graphs.
 */
function extractCriticalPath(
  g: Graph,
  adj: ReturnType<typeof buildAdjacency>,
  order: TaskId[],
  byId: Record<TaskId, TaskSchedule>,
  ES: Map<TaskId, number>,
  EF: Map<TaskId, number>,
): { path: TaskId[]; edges: Array<{ predecessorId: TaskId; successorId: TaskId }> } {
  const critical = (id: TaskId) => byId[id]?.isCritical === true;

  // An edge only drives the schedule when the successor starts exactly when the
  // predecessor's finish (plus lag) allows. Without this check we would draw
  // "critical" edges that are not actually constraining anything.
  const binding = g.edges.filter(
    (e) =>
      critical(e.predecessorId) &&
      critical(e.successorId) &&
      EF.get(e.predecessorId)! + e.lagDays === ES.get(e.successorId)!,
  );
  const bindingBySource = new Map<TaskId, typeof binding>();
  const hasBindingPredecessor = new Set<TaskId>();
  for (const e of binding) {
    const list = bindingBySource.get(e.predecessorId) ?? [];
    list.push(e);
    bindingBySource.set(e.predecessorId, list);
    hasBindingPredecessor.add(e.successorId);
  }
  const keyOf = (id: TaskId) => adj.keyOf.get(id) ?? id;

  // Longest remaining chain starting at each node, computed bottom-up.
  const bestSpan = new Map<TaskId, number>();
  const bestNext = new Map<TaskId, TaskId | null>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!;
    const span = EF.get(id)! - ES.get(id)!;
    let chosenSpan = span;
    let chosenNext: TaskId | null = null;
    const outgoing = [...(bindingBySource.get(id) ?? [])].sort((a, b) =>
      naturalCompare(keyOf(a.successorId), keyOf(b.successorId)),
    );
    for (const e of outgoing) {
      const total = span + e.lagDays + (bestSpan.get(e.successorId) ?? 0);
      if (total > chosenSpan) {
        chosenSpan = total;
        chosenNext = e.successorId;
      }
    }
    bestSpan.set(id, chosenSpan);
    bestNext.set(id, chosenNext);
  }

  // `adj.ids` is key-sorted, so a strict `>` comparison makes the tiebreak
  // deterministic: the lowest-keyed of two equally long chains wins.
  let winnerSpan = -1;
  let winnerStart: TaskId | null = null;
  for (const id of adj.ids) {
    if (!critical(id) || hasBindingPredecessor.has(id)) continue;
    const span = bestSpan.get(id) ?? -1;
    if (span > winnerSpan) {
      winnerSpan = span;
      winnerStart = id;
    }
  }

  const path: TaskId[] = [];
  for (let cursor = winnerStart; cursor !== null; cursor = bestNext.get(cursor) ?? null) {
    path.push(cursor);
  }

  // Sort the returned edges so the result is byte-identical regardless of the
  // order the caller happened to supply `g.edges` in.
  const edges = binding
    .map((e) => ({ predecessorId: e.predecessorId, successorId: e.successorId }))
    .sort(
      (a, b) =>
        naturalCompare(keyOf(a.predecessorId), keyOf(b.predecessorId)) ||
        naturalCompare(keyOf(a.successorId), keyOf(b.successorId)),
    );

  return { path, edges };
}
