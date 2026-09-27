/**
 * Seed data, engineered so the board *is* the demo script.
 *
 * Ten tasks that between them exercise every constraint in the brief:
 *
 *   * A canonical diamond    TF-3 -> {TF-5, TF-6} -> TF-7
 *     Extending TF-3 by 3 days moves TF-7 by exactly 3, not 6.
 *   * A genuine slack case   TF-6 is 3 days against TF-5's 6, so it carries
 *     3 days of float. Extending TF-6 by 1 day moves nothing downstream, which
 *     is the case a delta-propagation implementation gets wrong.
 *   * A five-level chain     TF-1 -> TF-3 -> TF-5 -> TF-7 -> TF-10 for the
 *     critical path.
 *   * Mixed dependency state TF-3 and TF-4 are Ready, TF-5..TF-10 are Blocked.
 *   * A regression source    TF-1 is Done; dragging it back to In Progress
 *     re-blocks TF-3 and TF-4.
 *   * A gap for the AI       there is deliberately no TF-4 -> TF-5 edge even
 *     though "Auth service" before "Frontend Kanban UI" is exactly what a
 *     planner would propose.
 *   * A trap for the AI      models regularly propose TF-10 -> TF-1, which the
 *     engine rejects as TF-1 -> TF-3 -> TF-5 -> TF-7 -> TF-10 -> TF-1.
 *
 * Idempotent: re-running upserts by key rather than duplicating.
 */

import { rank, todayEpochDay } from './engine/index.ts';
import { openDatabase, withTransaction } from './db/db.ts';
import { Repository } from './db/repository.ts';
import { DEFAULT_SETTINGS, recomputeBoard } from './services/board.ts';
import { loadConfig } from './config.ts';
import type { Stage } from './engine/index.ts';

interface SeedTask {
  key: string;
  title: string;
  description: string;
  stage: Stage;
  durationDays: number;
  dependsOn: string[];
  assignee: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  /** Days before "today" that this completed task finished. */
  finishedDaysAgo?: number;
}

export const SEED_TASKS: SeedTask[] = [
  {
    key: 'TF-1',
    title: 'Design database schema',
    description:
      'Define tables for tasks, dependencies and audit history, including the derived columns the scheduler writes. Produces the migration that every other service builds on.',
    stage: 'DONE',
    durationDays: 3,
    dependsOn: [],
    assignee: 'Priya',
    priority: 'HIGH',
    finishedDaysAgo: 2,
  },
  {
    key: 'TF-2',
    title: 'Set up CI/CD pipeline',
    description:
      'GitHub Actions workflow running typecheck, unit tests and integration tests, plus a secret scan. Independent of the application code.',
    stage: 'DONE',
    durationDays: 2,
    dependsOn: [],
    assignee: 'Marco',
    priority: 'MEDIUM',
    finishedDaysAgo: 1,
  },
  {
    key: 'TF-3',
    title: 'Backend API endpoints',
    description:
      'REST handlers for boards, tasks and dependencies. Reads and writes the tables defined by the database schema, so it cannot start until the schema is settled.',
    stage: 'IN_PROGRESS',
    durationDays: 5,
    dependsOn: ['TF-1'],
    assignee: 'Priya',
    priority: 'HIGH',
  },
  {
    key: 'TF-4',
    title: 'Auth service',
    description:
      'Session issuing and verification against the users table. Needs the database schema in place before the user and session tables can be queried.',
    stage: 'REVIEW',
    durationDays: 4,
    dependsOn: ['TF-1'],
    assignee: 'Dan',
    priority: 'HIGH',
  },
  {
    key: 'TF-5',
    title: 'Frontend Kanban UI',
    description:
      'Four-column board with drag-and-drop, a task drawer and the dependency editor. Consumes the backend API endpoints and renders the signed-in user, so it needs both.',
    stage: 'BACKLOG',
    durationDays: 6,
    dependsOn: ['TF-3'],
    assignee: 'Aisha',
    priority: 'HIGH',
  },
  {
    key: 'TF-6',
    title: 'Notification service',
    description:
      'Emails an assignee when one of their tasks becomes ready. Subscribes to the events published by the backend API endpoints.',
    stage: 'BACKLOG',
    durationDays: 3,
    dependsOn: ['TF-3'],
    assignee: 'Marco',
    priority: 'LOW',
  },
  {
    key: 'TF-7',
    title: 'Integration tests',
    description:
      'End-to-end suite driving the browser against a live server. Requires the Kanban UI to exist and the notification service to be wired up, because both are asserted on.',
    stage: 'BACKLOG',
    durationDays: 3,
    dependsOn: ['TF-5', 'TF-6'],
    assignee: 'Aisha',
    priority: 'MEDIUM',
  },
  {
    key: 'TF-8',
    title: 'Load and performance testing',
    description:
      'Measure recompute latency and request throughput under a synthetic 10k-task board. Drives traffic through the backend API endpoints behind the auth service.',
    stage: 'BACKLOG',
    durationDays: 2,
    dependsOn: ['TF-3', 'TF-4'],
    assignee: 'Dan',
    priority: 'LOW',
  },
  {
    key: 'TF-9',
    title: 'Security audit',
    description:
      'Review authentication, input validation and secret handling, and confirm the integration test suite covers the authorisation paths.',
    stage: 'BACKLOG',
    durationDays: 2,
    dependsOn: ['TF-4', 'TF-7'],
    assignee: 'Priya',
    priority: 'MEDIUM',
  },
  {
    key: 'TF-10',
    title: 'Production deploy',
    description:
      'Ship to production behind TLS. Gated on green integration tests, a completed load test, a signed-off security audit and a working CI/CD pipeline.',
    stage: 'BACKLOG',
    durationDays: 1,
    dependsOn: ['TF-2', 'TF-7', 'TF-8', 'TF-9'],
    assignee: 'Marco',
    priority: 'HIGH',
  },
];

/** The ground-truth edge set, reused by the AI evaluation harness. */
export const SEED_EDGES: Array<[string, string]> = SEED_TASKS.flatMap((t) =>
  t.dependsOn.map((p) => [p, t.key] as [string, string]),
);

/** Edges a good suggester should find but the seed deliberately omits. */
export const HELD_BACK_EDGES: Array<[string, string]> = [['TF-4', 'TF-5']];

export function seedBoard(repo: Repository, opts: { reset?: boolean } = {}) {
  return withTransaction(repo.db, () => {
    let board = repo.getFirstBoard();

    if (board && opts.reset) {
      repo.db.prepare('DELETE FROM boards WHERE id = ?').run(board.id);
      board = null;
    }
    if (!board) {
      board = repo.createBoard({
        name: 'Platform Delivery',
        // Start five days ago so the Done column has believable history and
        // the in-progress work sits around "today".
        projectStart: todayEpochDay() - 5,
        settings: DEFAULT_SETTINGS,
      });
    }

    const positions = new Map<Stage, string | null>();
    const nextPosition = (stage: Stage): string => {
      const last = positions.get(stage) ?? repo.lastPositionInStage(board!.id, stage);
      const next = rank.between(last, null);
      positions.set(stage, next);
      return next;
    };

    const idByKey = new Map<string, string>();
    for (const t of SEED_TASKS) {
      const existing = repo.getTaskByKey(board.id, t.key);
      if (existing) {
        idByKey.set(t.key, existing.id);
        continue;
      }
      const created = repo.createTask({
        boardId: board.id,
        key: t.key,
        title: t.title,
        description: t.description,
        stage: t.stage,
        position: nextPosition(t.stage),
        durationDays: t.durationDays,
        plannedStart: null,
        isPinned: false,
        actualFinish: t.finishedDaysAgo === undefined ? null : todayEpochDay() - t.finishedDaysAgo,
        assignee: t.assignee,
        priority: t.priority,
      });
      idByKey.set(t.key, created.id);
    }

    const existingEdges = new Set(
      repo.listDependencies(board.id).map((d) => `${d.predecessor_id}>${d.successor_id}`),
    );
    for (const [predecessorKey, successorKey] of SEED_EDGES) {
      const predecessorId = idByKey.get(predecessorKey)!;
      const successorId = idByKey.get(successorKey)!;
      if (existingEdges.has(`${predecessorId}>${successorId}`)) continue;
      repo.createDependency({
        boardId: board.id,
        predecessorId,
        successorId,
        lagDays: 0,
        origin: 'SEED',
        createdBy: 'seed',
      });
    }

    const schedule = recomputeBoard(repo, board);
    return { board, schedule, taskCount: SEED_TASKS.length, edgeCount: SEED_EDGES.length };
  });
}

// Run directly: `npm run db:seed` / `npm run db:reset`
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const cfg = loadConfig();
  const db = openDatabase(cfg.databaseUrl);
  const result = seedBoard(new Repository(db), { reset: process.argv.includes('--reset') });
  console.log(
    `Seeded "${result.board.name}" with ${result.taskCount} tasks and ${result.edgeCount} dependencies.`,
  );
  console.log(`Critical path: ${result.schedule.criticalPath.length} tasks.`);
  db.close();
}
