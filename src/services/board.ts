/**
 * The read model and the one function allowed to write derived columns.
 *
 * `recomputeBoard` is the only bridge between the pure engine and storage.
 * Every mutation service calls it inside its transaction, which is what makes
 * "Blocked/Ready", dates, slack and the critical path impossible to leave stale.
 */

import {
  DEFAULT_SATISFIED_STAGES,
  diffSchedules,
  fromEpochDay,
  inclusiveEndDate,
  scheduleGraph,
  type EdgeInput,
  type Graph,
  type ScheduleDiff,
  type ScheduleResult,
  type Stage,
  type TaskInput,
} from '../engine/index.ts';
import { AppError } from '../errors.ts';
import type { BoardRow, DependencyRow, Repository, TaskRow } from '../db/repository.ts';

export interface BoardSettings {
  satisfiedStages: Stage[];
  /** `warn` shows a badge, `block` refuses the move, `off` stays silent. */
  enforceBlockedGate: 'warn' | 'block' | 'off';
  keyPrefix: string;
}

export const DEFAULT_SETTINGS: BoardSettings = {
  satisfiedStages: [...DEFAULT_SATISFIED_STAGES],
  enforceBlockedGate: 'warn',
  keyPrefix: 'TF',
};

export function parseSettings(raw: string): BoardSettings {
  try {
    const parsed = JSON.parse(raw) as Partial<BoardSettings>;
    return {
      satisfiedStages:
        Array.isArray(parsed.satisfiedStages) && parsed.satisfiedStages.length
          ? parsed.satisfiedStages
          : DEFAULT_SETTINGS.satisfiedStages,
      enforceBlockedGate: parsed.enforceBlockedGate ?? DEFAULT_SETTINGS.enforceBlockedGate,
      keyPrefix: parsed.keyPrefix ?? DEFAULT_SETTINGS.keyPrefix,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Project stored rows onto the engine's input shape. Nothing derived crosses. */
export function toGraph(tasks: TaskRow[], deps: DependencyRow[]): Graph {
  const taskInputs: TaskInput[] = tasks.map((t) => ({
    id: t.id,
    key: t.key,
    stage: t.stage,
    durationDays: t.duration_days,
    plannedStart: t.planned_start,
    isPinned: t.is_pinned === 1,
    actualFinish: t.actual_finish,
  }));
  const edgeInputs: EdgeInput[] = deps.map((d) => ({
    predecessorId: d.predecessor_id,
    successorId: d.successor_id,
    lagDays: d.lag_days,
  }));
  return { tasks: taskInputs, edges: edgeInputs };
}

/**
 * Schedule the board's current rows without writing anything.
 *
 * `transform` lets a caller schedule a *hypothetical* board — "what if TF-5
 * took 8 days instead of 5" — through the exact same code path that serves the
 * real one. Because the scheduler is pure, a preview can never disagree with
 * the outcome of actually making the change.
 */
export function computeSchedule(
  repo: Repository,
  board: BoardRow,
  transform?: (tasks: TaskRow[]) => TaskRow[],
): ScheduleResult {
  const settings = parseSettings(board.settings);
  const tasks = repo.listTasks(board.id);
  const graph = toGraph(transform ? transform(tasks) : tasks, repo.listDependencies(board.id));
  const result = scheduleGraph(graph, {
    projectStart: board.project_start,
    satisfiedStages: settings.satisfiedStages,
  });
  if (!result.ok) {
    // Unreachable through the public API: every write path validates first. If
    // it ever fires, the stored graph has been corrupted out of band and the
    // loud failure is correct.
    throw new AppError(
      'INTERNAL',
      500,
      `Stored dependency graph is not a DAG: ${result.error.message}`,
      {
        cyclePath: result.error.path,
      },
    );
  }
  return result.value;
}

/**
 * Recompute and persist every derived value for one board.
 *
 * Call only inside a transaction. O(V + E); at 10k tasks this is single-digit
 * milliseconds, so the prototype recomputes the whole board on every write
 * rather than tracking dirty subgraphs. `docs/DESIGN.md` documents when that
 * trade-off should be revisited.
 */
export function recomputeBoard(repo: Repository, board: BoardRow): ScheduleResult {
  const schedule = computeSchedule(repo, board);
  repo.writeDerived(
    schedule.order.map((id) => {
      const s = schedule.byId[id]!;
      return {
        id,
        scheduledStart: s.earliestStart,
        scheduledEnd: s.earliestFinish,
        depState: s.depState,
        unmetCount: s.unmetPrereqIds.length,
        slackDays: s.slackDays,
        isCritical: s.isCritical,
      };
    }),
  );
  repo.markCriticalEdges(board.id, schedule.criticalEdges);
  return schedule;
}

export interface TaskView {
  id: string;
  key: string;
  title: string;
  description: string;
  stage: Stage;
  position: string;
  durationDays: number;
  plannedStart: string | null;
  isPinned: boolean;
  actualFinish: string | null;
  assignee: string | null;
  priority: string | null;
  version: number;
  scheduledStart: string;
  scheduledEnd: string;
  scheduledStartDay: number;
  scheduledEndDay: number;
  depState: 'BLOCKED' | 'READY';
  unmetPrereqIds: string[];
  unmetPrereqKeys: string[];
  slackDays: number;
  isCritical: boolean;
  /** Blocked but already pulled out of Backlog: worth surfacing, not blocking. */
  isPolicyViolation: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BoardView {
  board: {
    id: string;
    name: string;
    projectStart: string;
    projectFinish: string;
    settings: BoardSettings;
  };
  tasks: TaskView[];
  dependencies: Array<{
    id: string;
    predecessorId: string;
    successorId: string;
    predecessorKey: string;
    successorKey: string;
    lagDays: number;
    origin: string;
    suggestedBy: string | null;
    isCritical: boolean;
    createdAt: string;
  }>;
  criticalPath: string[];
  stats: {
    total: number;
    blocked: number;
    ready: number;
    done: number;
    policyViolations: number;
    criticalCount: number;
    durationDays: number;
  };
}

export function readBoard(repo: Repository, board: BoardRow): BoardView {
  const tasks = repo.listTasks(board.id);
  const deps = repo.listDependencies(board.id);
  const schedule = computeSchedule(repo, board);
  const keyOf = new Map(tasks.map((t) => [t.id, t.key] as const));

  const taskViews: TaskView[] = tasks.map((t) => {
    const s = schedule.byId[t.id]!;
    return {
      id: t.id,
      key: t.key,
      title: t.title,
      description: t.description,
      stage: t.stage,
      position: t.position,
      durationDays: t.duration_days,
      plannedStart: t.planned_start === null ? null : fromEpochDay(t.planned_start),
      isPinned: t.is_pinned === 1,
      actualFinish: t.actual_finish === null ? null : fromEpochDay(t.actual_finish),
      assignee: t.assignee,
      priority: t.priority,
      version: t.version,
      scheduledStart: fromEpochDay(s.earliestStart),
      scheduledEnd: inclusiveEndDate(s.earliestFinish),
      scheduledStartDay: s.earliestStart,
      scheduledEndDay: s.earliestFinish,
      depState: s.depState,
      unmetPrereqIds: s.unmetPrereqIds,
      unmetPrereqKeys: s.unmetPrereqIds.map((id) => keyOf.get(id) ?? id),
      slackDays: s.slackDays,
      isCritical: s.isCritical,
      isPolicyViolation: s.depState === 'BLOCKED' && t.stage !== 'BACKLOG',
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    };
  });

  return {
    board: {
      id: board.id,
      name: board.name,
      projectStart: fromEpochDay(schedule.projectStart),
      projectFinish: inclusiveEndDate(schedule.projectFinish),
      settings: parseSettings(board.settings),
    },
    tasks: taskViews,
    dependencies: deps.map((d) => ({
      id: d.id,
      predecessorId: d.predecessor_id,
      successorId: d.successor_id,
      predecessorKey: keyOf.get(d.predecessor_id) ?? d.predecessor_id,
      successorKey: keyOf.get(d.successor_id) ?? d.successor_id,
      lagDays: d.lag_days,
      origin: d.origin,
      suggestedBy: d.suggested_by,
      isCritical: d.is_critical === 1,
      createdAt: d.created_at,
    })),
    criticalPath: schedule.criticalPath,
    stats: {
      total: taskViews.length,
      blocked: taskViews.filter((t) => t.depState === 'BLOCKED').length,
      ready: taskViews.filter((t) => t.depState === 'READY').length,
      done: taskViews.filter((t) => t.stage === 'DONE').length,
      policyViolations: taskViews.filter((t) => t.isPolicyViolation).length,
      criticalCount: taskViews.filter((t) => t.isCritical).length,
      durationDays: schedule.projectFinish - schedule.projectStart,
    },
  };
}

/** Human-readable summary of a diff, reused by audit entries and toasts. */
export function describeDiff(diff: ScheduleDiff, keyOf: Map<string, string>): string {
  const moved = diff.changed.filter((d) => d.startDeltaDays !== 0 || d.endDeltaDays !== 0);
  const blocked = diff.changed.filter(
    (d) => d.depStateBefore === 'READY' && d.depStateAfter === 'BLOCKED',
  );
  const unblocked = diff.changed.filter(
    (d) => d.depStateBefore === 'BLOCKED' && d.depStateAfter === 'READY',
  );
  const parts: string[] = [];
  if (moved.length) {
    const days = [...new Set(moved.map((d) => d.startDeltaDays))];
    const label =
      days.length === 1
        ? `${days[0]! > 0 ? '+' : ''}${days[0]} day${Math.abs(days[0]!) === 1 ? '' : 's'}`
        : 'new dates';
    parts.push(
      `${moved.length} task${moved.length === 1 ? '' : 's'} rescheduled (${label}): ` +
        moved.map((d) => keyOf.get(d.id) ?? d.id).join(', '),
    );
  }
  if (blocked.length) {
    parts.push(
      `${blocked.length} now blocked: ${blocked.map((d) => keyOf.get(d.id) ?? d.id).join(', ')}`,
    );
  }
  if (unblocked.length) {
    parts.push(
      `${unblocked.length} now ready: ${unblocked.map((d) => keyOf.get(d.id) ?? d.id).join(', ')}`,
    );
  }
  if (diff.projectFinishDeltaDays !== 0) {
    parts.push(
      `project finish ${diff.projectFinishDeltaDays > 0 ? 'slipped' : 'pulled in'} ` +
        `${Math.abs(diff.projectFinishDeltaDays)} day(s)`,
    );
  }
  return parts.length ? parts.join('; ') : 'No downstream impact';
}

export { diffSchedules };
