/**
 * Schedule diffing.
 *
 * Every mutation returns the recomputed board *and* a diff. That single small
 * structure does three jobs: it drives the "3 tasks moved by 3 days" toast, it
 * is the grounded input to the AI impact narrative (so the model never invents
 * a number), and it is the payload of the audit event.
 */

import type { DepState, ScheduleResult, TaskId } from './types.ts';

export interface TaskDelta {
  id: TaskId;
  startDeltaDays: number;
  endDeltaDays: number;
  slackDeltaDays: number;
  depStateBefore: DepState | null;
  depStateAfter: DepState | null;
  becameCritical: boolean;
  leftCriticalPath: boolean;
}

export interface ScheduleDiff {
  changed: TaskDelta[];
  added: TaskId[];
  removed: TaskId[];
  projectFinishDeltaDays: number;
}

export const EMPTY_DIFF: ScheduleDiff = {
  changed: [],
  added: [],
  removed: [],
  projectFinishDeltaDays: 0,
};

export function diffSchedules(before: ScheduleResult | null, after: ScheduleResult): ScheduleDiff {
  if (!before) {
    return { ...EMPTY_DIFF, added: [...after.order] };
  }

  const changed: TaskDelta[] = [];
  for (const id of after.order) {
    const b = before.byId[id];
    const a = after.byId[id]!;
    if (!b) continue;
    const delta: TaskDelta = {
      id,
      startDeltaDays: a.earliestStart - b.earliestStart,
      endDeltaDays: a.earliestFinish - b.earliestFinish,
      slackDeltaDays: a.slackDays - b.slackDays,
      depStateBefore: b.depState,
      depStateAfter: a.depState,
      becameCritical: !b.isCritical && a.isCritical,
      leftCriticalPath: b.isCritical && !a.isCritical,
    };
    const moved =
      delta.startDeltaDays !== 0 ||
      delta.endDeltaDays !== 0 ||
      delta.depStateBefore !== delta.depStateAfter ||
      delta.becameCritical ||
      delta.leftCriticalPath;
    if (moved) changed.push(delta);
  }

  const beforeIds = new Set(before.order);
  const afterIds = new Set(after.order);
  return {
    changed,
    added: after.order.filter((id) => !beforeIds.has(id)),
    removed: before.order.filter((id) => !afterIds.has(id)),
    projectFinishDeltaDays: after.projectFinish - before.projectFinish,
  };
}

/** Tasks whose dates moved. Used by the narrative and the toast copy. */
export function rescheduled(diff: ScheduleDiff): TaskDelta[] {
  return diff.changed.filter((d) => d.startDeltaDays !== 0 || d.endDeltaDays !== 0);
}

/** Tasks that flipped from READY to BLOCKED, i.e. the rollback-on-regression set. */
export function newlyBlocked(diff: ScheduleDiff): TaskDelta[] {
  return diff.changed.filter((d) => d.depStateBefore === 'READY' && d.depStateAfter === 'BLOCKED');
}
