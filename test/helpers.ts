/** Fixture builders shared by the engine tests. */
import type { EdgeInput, Graph, Stage, TaskInput } from '../src/engine/index.ts';
import { DEFAULT_SATISFIED_STAGES, scheduleGraph } from '../src/engine/index.ts';

export const DAY0 = 20000; // an arbitrary but fixed epoch day

export function task(
  key: string,
  durationDays: number,
  overrides: Partial<TaskInput> = {},
): TaskInput {
  return {
    id: key,
    key,
    stage: 'BACKLOG' as Stage,
    durationDays,
    plannedStart: null,
    isPinned: false,
    actualFinish: null,
    ...overrides,
  };
}

export function edge(predecessorId: string, successorId: string, lagDays = 0): EdgeInput {
  return { predecessorId, successorId, lagDays };
}

export function schedule(g: Graph, projectStart = DAY0) {
  const result = scheduleGraph(g, {
    projectStart,
    satisfiedStages: DEFAULT_SATISFIED_STAGES,
  });
  if (!result.ok) throw new Error(`Expected a DAG, got ${result.error.message}`);
  return result.value;
}

/** Deep-clone a graph with one task's duration changed by `delta`. */
export function extend(g: Graph, key: string, delta: number): Graph {
  return {
    tasks: g.tasks.map((t) =>
      t.key === key ? { ...t, durationDays: t.durationDays + delta } : { ...t },
    ),
    edges: g.edges.map((e) => ({ ...e })),
  };
}

export function restage(g: Graph, key: string, stage: Stage): Graph {
  return {
    tasks: g.tasks.map((t) => (t.key === key ? { ...t, stage } : { ...t })),
    edges: g.edges.map((e) => ({ ...e })),
  };
}

/** `A -> B -> D`, `A -> C -> D`: the canonical diamond from the problem statement. */
export function diamond(durations = { A: 2, B: 4, C: 4, D: 2 }): Graph {
  return {
    tasks: [
      task('A', durations.A),
      task('B', durations.B),
      task('C', durations.C),
      task('D', durations.D),
    ],
    edges: [edge('A', 'B'), edge('A', 'C'), edge('B', 'D'), edge('C', 'D')],
  };
}

/** A fan of `paths` parallel chains of `length` hops between `SRC` and `SINK`. */
export function fan(paths: number, length: number): Graph {
  const tasks: TaskInput[] = [task('SRC', 3), task('SINK', 2)];
  const edges: EdgeInput[] = [];
  for (let p = 0; p < paths; p++) {
    let prev = 'SRC';
    for (let i = 0; i < length; i++) {
      const key = `P${p}_${i}`;
      tasks.push(task(key, 2));
      edges.push(edge(prev, key));
      prev = key;
    }
    edges.push(edge(prev, 'SINK'));
  }
  return { tasks, edges };
}

export function chain(length: number, duration = 2): Graph {
  const tasks: TaskInput[] = [];
  const edges: EdgeInput[] = [];
  for (let i = 0; i < length; i++) {
    tasks.push(task(`L${i}`, duration));
    if (i > 0) edges.push(edge(`L${i - 1}`, `L${i}`));
  }
  return { tasks, edges };
}
