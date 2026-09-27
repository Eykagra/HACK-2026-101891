/**
 * The API surface.
 *
 * Three conventions hold across every route and are worth stating once:
 *
 *  - **Every mutation returns the whole recomputed board plus the diff.** The
 *    client never patches its own state from a partial response, so it cannot
 *    drift out of sync with the server's schedule. One request, one truth.
 *  - **Validation happens at the edge**, before any service is called, so a
 *    malformed payload produces a 422 with field paths rather than a 500 from
 *    somewhere deep in SQLite.
 *  - **Nothing is trusted from the client except ids and intent.** Dates,
 *    blocked/ready state, slack and the critical path are all derived
 *    server-side; the client cannot assert them.
 */

import { STAGES } from '../engine/index.ts';
import type { Config } from '../config.ts';
import { publicAiInfo } from '../config.ts';
import type { BoardRow, Repository } from '../db/repository.ts';
import { forbidden, notFound, validationFailed } from '../errors.ts';
import { explainImpact } from '../ai/narrative.ts';
import { computeSchedule, diffSchedules, readBoard, recomputeBoard } from '../services/board.ts';
import { addDependency, removeDependency } from '../services/dependencies.ts';
import { createTask, deleteTask, moveTask, updateTask } from '../services/tasks.ts';
import {
  acceptSuggestion,
  listSuggestions,
  rejectSuggestion,
  runSuggestionPass,
} from '../services/suggestions.ts';
import { seedBoard } from '../seed.ts';
import {
  arrayOf,
  bool,
  int,
  isoDate,
  nullable,
  object,
  oneOf,
  optional,
  parse,
  str,
  type Check,
} from '../validate.ts';
import type { Route } from './server.ts';

const STAGE = oneOf(STAGES);
const PRIORITY = oneOf(['LOW', 'MEDIUM', 'HIGH'] as const);

const createTaskCheck = object({
  title: str({ min: 1, max: 200 }),
  description: optional(str({ max: 4000 })),
  stage: optional(STAGE),
  durationDays: optional(int({ min: 1, max: 365 })),
  plannedStart: optional(nullable(isoDate())),
  isPinned: optional(bool()),
  assignee: optional(nullable(str({ max: 80 }))),
  priority: optional(nullable(PRIORITY)),
  dependsOn: optional(arrayOf(str({ min: 1, max: 64 }), { max: 32 })),
});

const updateTaskCheck = object({
  title: optional(str({ min: 1, max: 200 })),
  description: optional(str({ max: 4000 })),
  durationDays: optional(int({ min: 1, max: 365 })),
  plannedStart: optional(nullable(isoDate())),
  isPinned: optional(bool()),
  assignee: optional(nullable(str({ max: 80 }))),
  priority: optional(nullable(PRIORITY)),
  expectedVersion: optional(int({ min: 1 })),
});

const moveTaskCheck = object({
  stage: STAGE,
  afterTaskId: optional(nullable(str({ max: 64 }))),
  beforeTaskId: optional(nullable(str({ max: 64 }))),
  acknowledgeBlocked: optional(bool()),
  expectedVersion: optional(int({ min: 1 })),
});

const dependencyCheck = object({
  predecessorId: str({ min: 1, max: 64 }),
  successorId: str({ min: 1, max: 64 }),
  lagDays: optional(int({ min: 0, max: 365 })),
});

/** Parse or throw a 422 carrying every field path that failed. */
function decode<T>(check: Check<T>, payload: unknown): T {
  const result = parse(check, payload);
  if (!result.ok) {
    throw validationFailed('The request body did not pass validation.', result.issues);
  }
  return result.value;
}

export interface RouteDeps {
  repo: Repository;
  config: Config;
  /** Resolved lazily: the demo board is created on first boot. */
  board: () => BoardRow;
}

export function buildRoutes(deps: RouteDeps): Route[] {
  const { repo, config } = deps;

  /**
   * Shared tail for mutations that want an AI narrative.
   *
   * The narrative is computed from the engine diff, never from the request, and
   * a failure here must not fail the mutation — the write already committed.
   */
  const withNarrative = async (
    action: string,
    result: {
      board: ReturnType<typeof readBoard>;
      diff: ReturnType<typeof diffSchedules>;
      summary: string;
      warnings: string[];
    },
    before: ReturnType<typeof computeSchedule> | null,
  ) => {
    const board = deps.board();
    const after = computeSchedule(repo, board);
    const keyOf = new Map(repo.listTasks(board.id).map((t) => [t.id, t.key] as const));
    const narrative = await explainImpact(config, action, result.diff, before, after, keyOf);
    return { ...result, narrative };
  };

  return [
    {
      method: 'GET',
      pattern: '/api/health',
      handler: () => {
        const board = deps.board();
        const view = readBoard(repo, board);
        return {
          status: 'ok',
          version: process.env.APP_VERSION ?? 'dev',
          uptimeSeconds: Math.round(process.uptime()),
          ai: publicAiInfo(config),
          board: { id: board.id, tasks: view.stats.total, dependencies: view.dependencies.length },
        };
      },
    },

    {
      method: 'GET',
      pattern: '/api/board',
      limitPerMinute: 600,
      handler: () => ({
        ...readBoard(repo, deps.board()),
        ai: publicAiInfo(config),
      }),
    },

    {
      method: 'GET',
      pattern: '/api/audit',
      limitPerMinute: 120,
      handler: ({ query }) => {
        const limit = Math.min(Number(query.get('limit') ?? 30) || 30, 200);
        return {
          events: repo.listAudit(deps.board().id, limit).map((e) => ({
            id: e.id,
            type: e.type,
            actor: e.actor,
            summary: e.summary,
            payload: JSON.parse(e.payload),
            createdAt: e.created_at,
          })),
        };
      },
    },

    // ---- tasks --------------------------------------------------------------

    {
      method: 'POST',
      pattern: '/api/tasks',
      limitPerMinute: 120,
      handler: async ({ body, res }) => {
        const board = deps.board();
        const input = decode(createTaskCheck, await body());
        const before = computeSchedule(repo, board);
        const result = createTask(repo, board, input);
        res.statusCode = 201;
        return withNarrative(
          `Creating ${result.board.tasks.at(-1)?.key ?? 'a task'}`,
          result,
          before,
        );
      },
    },

    {
      method: 'PATCH',
      pattern: '/api/tasks/:id',
      limitPerMinute: 240,
      handler: async ({ params, body }) => {
        const board = deps.board();
        const input = decode(updateTaskCheck, await body());
        const existing = repo.getTask(params.id!);
        if (!existing || existing.board_id !== board.id) throw notFound(`Task ${params.id}`);
        const before = computeSchedule(repo, board);
        const result = updateTask(repo, board, params.id!, input);
        return withNarrative(`Editing ${existing.key}`, result, before);
      },
    },

    {
      method: 'POST',
      pattern: '/api/tasks/:id/move',
      limitPerMinute: 240,
      handler: async ({ params, body }) => {
        const board = deps.board();
        const input = decode(moveTaskCheck, await body());
        const existing = repo.getTask(params.id!);
        if (!existing || existing.board_id !== board.id) throw notFound(`Task ${params.id}`);
        const before = computeSchedule(repo, board);
        const result = moveTask(repo, board, params.id!, input);
        return withNarrative(`Moving ${existing.key} to ${input.stage}`, result, before);
      },
    },

    {
      method: 'DELETE',
      pattern: '/api/tasks/:id',
      limitPerMinute: 120,
      handler: async ({ params }) => {
        const board = deps.board();
        const existing = repo.getTask(params.id!);
        if (!existing || existing.board_id !== board.id) throw notFound(`Task ${params.id}`);
        const before = computeSchedule(repo, board);
        const result = deleteTask(repo, board, params.id!);
        return withNarrative(`Deleting ${existing.key}`, result, before);
      },
    },

    // ---- dependencies -------------------------------------------------------

    {
      method: 'POST',
      pattern: '/api/dependencies',
      limitPerMinute: 240,
      handler: async ({ body, res }) => {
        const board = deps.board();
        const input = decode(dependencyCheck, await body());
        const before = computeSchedule(repo, board);
        // A cycle raises here; the transaction rolls back and the graph is
        // byte-identical to what it was before the request.
        const result = addDependency(repo, board, input);
        res.statusCode = 201;
        return withNarrative('Adding that dependency', result, before);
      },
    },

    {
      method: 'DELETE',
      pattern: '/api/dependencies/:id',
      limitPerMinute: 240,
      handler: ({ params }) => {
        const board = deps.board();
        const before = computeSchedule(repo, board);
        const result = removeDependency(repo, board, params.id!);
        return withNarrative('Removing that dependency', result, before);
      },
    },

    // ---- AI -----------------------------------------------------------------

    {
      method: 'GET',
      pattern: '/api/ai/suggestions',
      limitPerMinute: 120,
      handler: () => listSuggestions(repo, deps.board()),
    },

    {
      // Tighter limit: this is the only route that costs money per call.
      method: 'POST',
      pattern: '/api/ai/suggest-dependencies',
      limitPerMinute: 10,
      handler: () => runSuggestionPass(repo, deps.board(), config),
    },

    {
      method: 'POST',
      pattern: '/api/ai/suggestions/:id/accept',
      limitPerMinute: 60,
      handler: async ({ params }) => {
        const board = deps.board();
        const before = computeSchedule(repo, board);
        const result = acceptSuggestion(repo, board, params.id!);
        return withNarrative('Accepting that suggestion', result, before);
      },
    },

    {
      method: 'POST',
      pattern: '/api/ai/suggestions/:id/reject',
      limitPerMinute: 60,
      handler: ({ params }) => rejectSuggestion(repo, deps.board(), params.id!),
    },

    {
      /**
       * Re-narrates the most recent change without mutating anything. Useful
       * for retrying prose after a provider outage, and for demonstrating that
       * the narrative is derived rather than stored.
       */
      method: 'POST',
      pattern: '/api/ai/explain-impact',
      limitPerMinute: 20,
      handler: async ({ body }) => {
        const board = deps.board();
        const payload = (await body()) as { taskId?: string; durationDays?: number };
        const after = computeSchedule(repo, board);
        const keyOf = new Map(repo.listTasks(board.id).map((t) => [t.id, t.key] as const));

        // A what-if: apply the hypothetical duration in memory only.
        if (payload.taskId && typeof payload.durationDays === 'number') {
          const task = repo.getTask(payload.taskId);
          if (!task || task.board_id !== board.id) throw notFound(`Task ${payload.taskId}`);
          const hypothetical = simulateDuration(repo, board, payload.taskId, payload.durationDays);
          const diff = diffSchedules(after, hypothetical);
          const narrative = await explainImpact(
            config,
            `Changing ${task.key} from ${task.duration_days} to ${payload.durationDays} days`,
            diff,
            after,
            hypothetical,
            keyOf,
          );
          return { narrative, diff, simulated: true };
        }

        const narrative = await explainImpact(
          config,
          'The current plan',
          { changed: [], added: [], removed: [], projectFinishDeltaDays: 0 },
          after,
          after,
          keyOf,
        );
        return { narrative, simulated: false };
      },
    },

    // ---- admin --------------------------------------------------------------

    {
      /**
       * Resets the demo board. Guarded by `ADMIN_TOKEN` when one is set, and
       * disabled outright when one is not *and* we are in production — a public
       * unauthenticated reset endpoint would be an obvious footgun.
       */
      method: 'POST',
      pattern: '/api/admin/reset-demo',
      limitPerMinute: 5,
      handler: ({ req }) => {
        if (config.adminToken) {
          const provided = req.headers['x-admin-token'];
          if (provided !== config.adminToken) throw forbidden('A valid X-Admin-Token is required.');
        } else if (config.nodeEnv === 'production') {
          throw forbidden('Demo reset is disabled because ADMIN_TOKEN is not configured.');
        }
        const { board } = seedBoard(repo, { reset: true });
        return { ...readBoard(repo, board), ai: publicAiInfo(config) };
      },
    },
  ];
}

/**
 * Computes the schedule the board *would* have with one different duration,
 * without writing anything.
 *
 * This works only because the scheduler is a pure function of the graph: the
 * same code path that serves the real board answers the what-if, so the preview
 * can never disagree with the outcome.
 */
function simulateDuration(
  repo: Repository,
  board: BoardRow,
  taskId: string,
  durationDays: number,
): ReturnType<typeof computeSchedule> {
  if (durationDays < 1 || durationDays > 365 || !Number.isInteger(durationDays)) {
    throw validationFailed('durationDays must be an integer between 1 and 365.', [
      { path: 'durationDays', message: String(durationDays) },
    ]);
  }
  return computeSchedule(repo, board, (tasks) =>
    tasks.map((t) => (t.id === taskId ? { ...t, duration_days: durationDays } : t)),
  );
}

export { recomputeBoard };
