/**
 * Dependency mutations: the guarded edge of the system.
 *
 * The contract from the problem statement is precise: an invalid dependency
 * must not be persisted, and the existing valid graph must remain unchanged.
 * That is delivered structurally rather than by careful coding:
 *
 *   1. `BEGIN IMMEDIATE` takes the writer lock, so validate-then-write is one
 *      serialised unit and two concurrent inverse inserts cannot both pass.
 *   2. Validation runs through the same `validateAddEdge` that guards AI
 *      suggestions, so there is exactly one definition of a legal edge.
 *   3. A rejection throws, the transaction rolls back, and neither the edge nor
 *      the derived schedule columns retain any trace of the attempt.
 */

import { validateAddEdge, type EdgeOrigin } from '../engine/index.ts';
import { withTransaction } from '../db/db.ts';
import type { BoardRow, Repository } from '../db/repository.ts';
import { cycleDetected, duplicateDependency, notFound, selfEdge, unknownTask } from '../errors.ts';
import {
  computeSchedule,
  describeDiff,
  diffSchedules,
  readBoard,
  recomputeBoard,
  toGraph,
} from './board.ts';
import type { MutationResult } from './tasks.ts';

export interface AddDependencyInput {
  predecessorId: string;
  successorId: string;
  lagDays?: number;
  origin?: EdgeOrigin;
  suggestedBy?: string | null;
}

/**
 * Validate and insert one edge. **Must already be inside a transaction.**
 *
 * Returns a warning string when the edge is legal but transitively redundant,
 * otherwise `null`. Throws a typed `AppError` for every rejection.
 */
export function addDependencyUnsafe(
  repo: Repository,
  board: BoardRow,
  input: AddDependencyInput,
): string | null {
  const tasks = repo.listTasks(board.id);
  const deps = repo.listDependencies(board.id);
  const graph = toGraph(tasks, deps);
  const keyOf = new Map(tasks.map((t) => [t.id, t.key] as const));

  const verdict = validateAddEdge(graph, {
    predecessorId: input.predecessorId,
    successorId: input.successorId,
    lagDays: input.lagDays ?? 0,
  });

  if (verdict.kind === 'REJECTED') {
    switch (verdict.code) {
      case 'CYCLE':
        throw cycleDetected(
          verdict.message,
          verdict.cyclePath ?? [],
          (verdict.cyclePath ?? []).map((id) => keyOf.get(id) ?? id),
        );
      case 'SELF_EDGE':
        throw selfEdge(verdict.message);
      case 'DUPLICATE':
        throw duplicateDependency(verdict.message);
      case 'UNKNOWN_TASK':
      default:
        throw unknownTask(verdict.message);
    }
  }

  repo.createDependency({
    boardId: board.id,
    predecessorId: input.predecessorId,
    successorId: input.successorId,
    lagDays: input.lagDays ?? 0,
    origin: input.origin ?? 'MANUAL',
    suggestedBy: input.suggestedBy ?? null,
  });

  return verdict.redundantVia
    ? `This dependency was already implied by ${verdict.redundantVia
        .map((id) => keyOf.get(id) ?? id)
        .join(' -> ')}.`
    : null;
}

export function addDependency(
  repo: Repository,
  board: BoardRow,
  input: AddDependencyInput,
): MutationResult {
  return withTransaction(repo.db, () => {
    const before = computeSchedule(repo, board);
    const redundancy = addDependencyUnsafe(repo, board, input);
    const after = recomputeBoard(repo, board);
    const diff = diffSchedules(before, after);

    const keyOf = new Map(repo.listTasks(board.id).map((t) => [t.id, t.key] as const));
    const label = `${keyOf.get(input.predecessorId)} -> ${keyOf.get(input.successorId)}`;
    const summary = `Added dependency ${label}`;
    repo.appendAudit({
      boardId: board.id,
      type: 'dependency.created',
      summary,
      payload: { ...input, diff },
    });
    return {
      board: readBoard(repo, board),
      diff,
      summary: `${summary}. ${describeDiff(diff, keyOf)}`,
      warnings: redundancy ? [redundancy] : [],
    };
  });
}

export function removeDependency(
  repo: Repository,
  board: BoardRow,
  dependencyId: string,
): MutationResult {
  return withTransaction(repo.db, () => {
    const existing = repo.getDependency(dependencyId);
    if (!existing || existing.board_id !== board.id) throw notFound('Dependency');

    const before = computeSchedule(repo, board);
    repo.deleteDependency(dependencyId);
    const after = recomputeBoard(repo, board);
    const diff = diffSchedules(before, after);

    const keyOf = new Map(repo.listTasks(board.id).map((t) => [t.id, t.key] as const));
    const label = `${keyOf.get(existing.predecessor_id)} -> ${keyOf.get(existing.successor_id)}`;
    const summary = `Removed dependency ${label}`;
    repo.appendAudit({
      boardId: board.id,
      type: 'dependency.deleted',
      summary,
      payload: { dependencyId, diff },
    });
    return {
      board: readBoard(repo, board),
      diff,
      summary: `${summary}. ${describeDiff(diff, keyOf)}`,
      warnings: [],
    };
  });
}
