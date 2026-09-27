/**
 * Task mutations.
 *
 * Every mutation follows the same five steps inside one transaction:
 * snapshot the schedule, mutate, recompute derived state, diff, audit. The
 * uniform shape is why no write path can forget to refresh Blocked/Ready.
 */

import { rank, todayEpochDay, toEpochDay, type Stage } from '../engine/index.ts';
import { withTransaction } from '../db/db.ts';
import type { BoardRow, Repository, TaskPatch } from '../db/repository.ts';
import { AppError, notFound, staleWrite, validationFailed } from '../errors.ts';
import {
  computeSchedule,
  describeDiff,
  diffSchedules,
  parseSettings,
  readBoard,
  recomputeBoard,
  type BoardView,
} from './board.ts';
import type { ScheduleDiff } from '../engine/index.ts';
import { addDependencyUnsafe } from './dependencies.ts';

export interface MutationResult {
  board: BoardView;
  diff: ScheduleDiff;
  summary: string;
  warnings: string[];
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  stage?: Stage;
  durationDays?: number;
  plannedStart?: string | null;
  isPinned?: boolean;
  assignee?: string | null;
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  dependsOn?: string[];
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  durationDays?: number;
  plannedStart?: string | null;
  isPinned?: boolean;
  assignee?: string | null;
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  expectedVersion?: number;
}

export interface MoveTaskInput {
  stage: Stage;
  /** The task this one should sit immediately after, if any. */
  afterTaskId?: string | null;
  /** The task this one should sit immediately before, if any. */
  beforeTaskId?: string | null;
  /** Explicit acknowledgement when moving a blocked task out of Backlog. */
  acknowledgeBlocked?: boolean;
  expectedVersion?: number;
}

function positionBetween(
  repo: Repository,
  boardId: string,
  stage: Stage,
  afterTaskId: string | null | undefined,
  beforeTaskId: string | null | undefined,
): string {
  const after = afterTaskId ? repo.getTask(afterTaskId) : null;
  const before = beforeTaskId ? repo.getTask(beforeTaskId) : null;
  if (after || before) {
    return rank.between(after?.position ?? null, before?.position ?? null);
  }
  // No neighbours given: append to the end of the column.
  return rank.between(repo.lastPositionInStage(boardId, stage), null);
}

function parseDay(value: string | null | undefined, field: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  try {
    return toEpochDay(value);
  } catch {
    throw validationFailed(`${field} must be a YYYY-MM-DD date.`, [
      { path: field, message: 'invalid date' },
    ]);
  }
}

/**
 * Stage transitions own the `actual_finish` column.
 *
 * Completing a task records when it actually finished, so downstream dates are
 * driven by reality rather than the estimate. Moving it back out of Done clears
 * that record, which is what makes a regression affect *both* dependency state
 * and the schedule.
 */
function actualFinishFor(
  stage: Stage,
  current: number | null,
  scheduledStart: number,
): number | null {
  if (stage !== 'DONE') return null;
  if (current !== null) return current;
  return Math.max(todayEpochDay(), scheduledStart + 1);
}

export function createTask(
  repo: Repository,
  board: BoardRow,
  input: CreateTaskInput,
): MutationResult {
  return withTransaction(repo.db, () => {
    const before = computeSchedule(repo, board);
    const settings = parseSettings(board.settings);
    const stage = input.stage ?? 'BACKLOG';
    const key = `${settings.keyPrefix}-${repo.nextKeyNumber(board.id, settings.keyPrefix)}`;

    const created = repo.createTask({
      boardId: board.id,
      key,
      title: input.title,
      description: input.description ?? '',
      stage,
      position: positionBetween(repo, board.id, stage, null, null),
      durationDays: input.durationDays ?? 1,
      plannedStart: parseDay(input.plannedStart, 'plannedStart'),
      isPinned: input.isPinned ?? false,
      actualFinish: null,
      assignee: input.assignee ?? null,
      priority: input.priority ?? null,
    });

    const warnings: string[] = [];
    for (const predecessorId of input.dependsOn ?? []) {
      // Reuse the dependency service's validation rather than duplicating it.
      const verdict = addDependencyUnsafe(repo, board, {
        predecessorId,
        successorId: created.id,
        lagDays: 0,
        origin: 'MANUAL',
      });
      if (verdict) warnings.push(verdict);
    }

    if (stage === 'DONE') {
      const mid = computeSchedule(repo, board);
      repo.updateTask(created.id, {
        actualFinish: actualFinishFor('DONE', null, mid.byId[created.id]!.earliestStart),
      });
    }

    const after = recomputeBoard(repo, board);
    const diff = diffSchedules(before, after);
    const keyOf = new Map(repo.listTasks(board.id).map((t) => [t.id, t.key] as const));
    const summary = `Created ${key} "${input.title}"`;
    repo.appendAudit({
      boardId: board.id,
      type: 'task.created',
      summary,
      payload: { taskId: created.id, key, diff },
    });
    return {
      board: readBoard(repo, board),
      diff,
      summary: `${summary}. ${describeDiff(diff, keyOf)}`,
      warnings,
    };
  });
}

export function updateTask(
  repo: Repository,
  board: BoardRow,
  taskId: string,
  input: UpdateTaskInput,
): MutationResult {
  return withTransaction(repo.db, () => {
    const existing = repo.getTask(taskId);
    if (!existing || existing.board_id !== board.id) throw notFound('Task');
    if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
      throw staleWrite(input.expectedVersion, existing.version);
    }

    const before = computeSchedule(repo, board);
    const patch: TaskPatch = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description;
    if (input.durationDays !== undefined) patch.durationDays = input.durationDays;
    if (input.plannedStart !== undefined)
      patch.plannedStart = parseDay(input.plannedStart, 'plannedStart');
    if (input.isPinned !== undefined) patch.isPinned = input.isPinned;
    if (input.assignee !== undefined) patch.assignee = input.assignee;
    if (input.priority !== undefined) patch.priority = input.priority;

    repo.updateTask(taskId, patch);
    const after = recomputeBoard(repo, board);
    const diff = diffSchedules(before, after);
    const keyOf = new Map(repo.listTasks(board.id).map((t) => [t.id, t.key] as const));

    const changedFields = Object.keys(patch);
    const summary = `Updated ${existing.key} (${changedFields.join(', ') || 'no fields'})`;
    repo.appendAudit({
      boardId: board.id,
      type: 'task.updated',
      summary,
      payload: { taskId, key: existing.key, fields: changedFields, diff },
    });
    return {
      board: readBoard(repo, board),
      diff,
      summary: `${summary}. ${describeDiff(diff, keyOf)}`,
      warnings: [],
    };
  });
}

export function moveTask(
  repo: Repository,
  board: BoardRow,
  taskId: string,
  input: MoveTaskInput,
): MutationResult {
  return withTransaction(repo.db, () => {
    const existing = repo.getTask(taskId);
    if (!existing || existing.board_id !== board.id) throw notFound('Task');
    if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
      throw staleWrite(input.expectedVersion, existing.version);
    }

    const before = computeSchedule(repo, board);
    const settings = parseSettings(board.settings);
    const blocked = before.byId[taskId]!.depState === 'BLOCKED';
    const leavingBacklog = input.stage !== 'BACKLOG' && blocked;

    // Policy, not correctness. Default is `warn`: the move is allowed and the
    // card keeps a badge, because refusing it is over-reach the product never
    // asked for. A board can opt into `block`.
    if (leavingBacklog && settings.enforceBlockedGate === 'block' && !input.acknowledgeBlocked) {
      const unmet = before.byId[taskId]!.unmetPrereqIds.length;
      throw new AppError(
        'FORBIDDEN',
        409,
        `${existing.key} has ${unmet} unfinished prerequisite(s) and this board blocks that move.`,
        { unmetPrereqIds: before.byId[taskId]!.unmetPrereqIds },
      );
    }

    repo.updateTask(taskId, {
      stage: input.stage,
      position: positionBetween(repo, board.id, input.stage, input.afterTaskId, input.beforeTaskId),
      actualFinish: actualFinishFor(
        input.stage,
        existing.stage === 'DONE' ? existing.actual_finish : null,
        before.byId[taskId]!.earliestStart,
      ),
    });

    const after = recomputeBoard(repo, board);
    const diff = diffSchedules(before, after);
    const keyOf = new Map(repo.listTasks(board.id).map((t) => [t.id, t.key] as const));

    const warnings: string[] = [];
    if (leavingBacklog && settings.enforceBlockedGate === 'warn') {
      // Name the blockers. "1 unfinished prerequisite" tells the user they have
      // a problem; naming TF-3 tells them what to do about it.
      const unmet = before.byId[taskId]!.unmetPrereqIds.map((id) => keyOf.get(id) ?? id);
      warnings.push(
        `${existing.key} is still blocked by ${unmet.join(', ')}. ` +
          'The move was allowed, but the card keeps a policy-violation badge until those finish.',
      );
    }
    const regression =
      existing.stage === 'DONE' && input.stage !== 'DONE' ? ` Rolled back from Done.` : '';
    const summary = `Moved ${existing.key} from ${existing.stage} to ${input.stage}.${regression}`;
    repo.appendAudit({
      boardId: board.id,
      type: existing.stage === 'DONE' && input.stage !== 'DONE' ? 'task.regressed' : 'task.moved',
      summary,
      payload: { taskId, key: existing.key, from: existing.stage, to: input.stage, diff },
    });
    return {
      board: readBoard(repo, board),
      diff,
      summary: `${summary} ${describeDiff(diff, keyOf)}`,
      warnings,
    };
  });
}

export function deleteTask(repo: Repository, board: BoardRow, taskId: string): MutationResult {
  return withTransaction(repo.db, () => {
    const existing = repo.getTask(taskId);
    if (!existing || existing.board_id !== board.id) throw notFound('Task');

    const before = computeSchedule(repo, board);
    // `ON DELETE CASCADE` removes the task's edges, so the remaining graph
    // stays a valid DAG by construction.
    repo.deleteTask(taskId);
    const after = recomputeBoard(repo, board);
    const diff = diffSchedules(before, after);
    const keyOf = new Map(repo.listTasks(board.id).map((t) => [t.id, t.key] as const));

    const summary = `Deleted ${existing.key} "${existing.title}"`;
    repo.appendAudit({
      boardId: board.id,
      type: 'task.deleted',
      summary,
      payload: { taskId, key: existing.key, diff },
    });
    return {
      board: readBoard(repo, board),
      diff,
      summary: `${summary}. ${describeDiff(diff, keyOf)}`,
      warnings: [],
    };
  });
}
