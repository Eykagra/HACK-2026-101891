/**
 * Core domain types for the TaskFlow Pro dependency engine.
 *
 * Everything in `src/engine` is pure: no I/O, no database, no clock, no network.
 * Dates are integer *epoch days* (see `dates.ts`) and intervals are half-open
 * `[earliestStart, earliestFinish)`, which keeps every calculation integer
 * arithmetic and eliminates timezone and inclusive/exclusive off-by-one bugs.
 */

export type TaskId = string;

export const STAGES = ['BACKLOG', 'IN_PROGRESS', 'REVIEW', 'DONE'] as const;
export type Stage = (typeof STAGES)[number];

/** Dependency state is *derived*, never stored as a source of truth. */
export type DepState = 'BLOCKED' | 'READY';

export const EDGE_ORIGINS = ['MANUAL', 'AI_ACCEPTED', 'SEED'] as const;
export type EdgeOrigin = (typeof EDGE_ORIGINS)[number];

/** The scheduling inputs for one task. Derived values are never inputs. */
export interface TaskInput {
  id: TaskId;
  /** Human-readable stable key such as `TF-3`. Used for deterministic ordering. */
  key: string;
  stage: Stage;
  /** Estimated duration in calendar days. Always >= 1. */
  durationDays: number;
  /** Epoch day. Acts as "start no earlier than" when `isPinned` is true. */
  plannedStart: number | null;
  isPinned: boolean;
  /** Recorded finish (exclusive, epoch day) for completed work. */
  actualFinish: number | null;
}

export interface EdgeInput {
  /** `predecessorId` must finish before `successorId` may start. */
  predecessorId: TaskId;
  successorId: TaskId;
  /** Extra calendar days between predecessor finish and successor start. */
  lagDays: number;
}

export interface Graph {
  tasks: readonly TaskInput[];
  edges: readonly EdgeInput[];
}

export interface ScheduleOptions {
  /** Epoch day before which nothing may start. */
  projectStart: number;
  /** Stages that count as satisfying a prerequisite. Default: `['DONE']`. */
  satisfiedStages: readonly Stage[];
}

export interface TaskSchedule {
  id: TaskId;
  /** Half-open interval: the task occupies `[earliestStart, earliestFinish)`. */
  earliestStart: number;
  earliestFinish: number;
  latestStart: number;
  latestFinish: number;
  /** `latestStart - earliestStart`. Zero means the task is on the critical path. */
  slackDays: number;
  isCritical: boolean;
  depState: DepState;
  unmetPrereqIds: TaskId[];
  /** Position in the topological order. */
  topoIndex: number;
  /** Longest predecessor chain length in nodes; used for layered graph layout. */
  depth: number;
}

export interface ScheduleResult {
  byId: Record<TaskId, TaskSchedule>;
  order: TaskId[];
  projectStart: number;
  projectFinish: number;
  /** One canonical longest (duration-weighted) chain, deterministically chosen. */
  criticalPath: TaskId[];
  /** Every binding edge between two critical tasks. */
  criticalEdges: Array<{ predecessorId: TaskId; successorId: TaskId }>;
}

export interface CycleError {
  code: 'CYCLE';
  /** The cycle as a closed walk, e.g. `[TF-1, TF-3, TF-7, TF-1]`. */
  path: TaskId[];
  message: string;
}

export type EdgeRejectionCode = 'SELF_EDGE' | 'DUPLICATE' | 'UNKNOWN_TASK' | 'CYCLE';

export type EdgeVerdict =
  | { kind: 'OK'; redundantVia: TaskId[] | null }
  | {
      kind: 'REJECTED';
      code: EdgeRejectionCode;
      message: string;
      cyclePath?: TaskId[];
    };

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
