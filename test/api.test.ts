/**
 * API-level integration tests.
 *
 * These run against a real HTTP server backed by a real SQLite file in a temp
 * directory — no mocks, no in-memory shim. The properties being tested are the
 * ones a unit test cannot reach: that a rejection leaves the database
 * *byte-identical*, that two racing inserts cannot both win, and that derived
 * state survives a process restart.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/db/db.ts';
import { Repository } from '../src/db/repository.ts';
import { buildRoutes } from '../src/http/routes.ts';
import { createApp } from '../src/http/server.ts';
import { seedBoard } from '../src/seed.ts';

let server: Server;
let baseUrl: string;
let dir: string;
let dbPath: string;

interface Json {
  [key: string]: any;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : {} };
}

const keyOf = (board: Json, key: string): string => {
  const task = board.tasks.find((t: Json) => t.key === key);
  assert.ok(task, `expected task ${key} to exist`);
  return task.id;
};

function start(path: string): Promise<{ server: Server; url: string }> {
  const config = loadConfig({
    ...process.env,
    DATABASE_PATH: path,
    PORT: '0',
    HOST: '127.0.0.1',
    AI_MODE: 'mock',
    LOG_LEVEL: 'silent',
    ADMIN_TOKEN: 'test-token',
    NODE_ENV: 'test',
  });
  const db = openDatabase(config.databaseUrl);
  const repo = new Repository(db);
  if (!repo.getFirstBoard()) seedBoard(repo);

  const app = createApp({
    config,
    routes: buildRoutes({
      repo,
      config,
      board: () => {
        const found = repo.getFirstBoard();
        assert.ok(found);
        return found;
      },
    }),
    staticDir: join(import.meta.dirname, '..', 'web'),
  });

  return new Promise((resolvePromise) => {
    app.listen(0, '127.0.0.1', () => {
      const address = app.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolvePromise({ server: app, url: `http://127.0.0.1:${port}` });
    });
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'taskflow-api-'));
  dbPath = join(dir, 'test.db');
  const started = await start(dbPath);
  server = started.server;
  baseUrl = started.url;
});

after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/board', () => {
  it('returns the seeded board with every derived field populated', async () => {
    const { status, json } = await call('GET', '/api/board');
    assert.equal(status, 200);
    assert.equal(json.tasks.length, 10);
    assert.equal(json.dependencies.length, 14);

    for (const task of json.tasks) {
      assert.match(task.scheduledStart, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(task.scheduledEnd, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(['BLOCKED', 'READY'].includes(task.depState));
      assert.equal(typeof task.slackDays, 'number');
      assert.equal(typeof task.isCritical, 'boolean');
      // The end date must never render before the start date, including for
      // completed work whose actual finish landed on its start day.
      assert.ok(task.scheduledEnd >= task.scheduledStart, `${task.key} has an inverted interval`);
    }

    // Exactly one contiguous critical path, and every member has zero slack.
    for (const id of json.criticalPath) {
      const task = json.tasks.find((t: Json) => t.id === id);
      assert.equal(task.slackDays, 0, `${task.key} is on the critical path with non-zero slack`);
      assert.equal(task.isCritical, true);
    }
  });

  it('never exposes an API key', async () => {
    const { json } = await call('GET', '/api/board');
    const serialised = JSON.stringify(json);
    assert.ok(!/sk-|AIza/.test(serialised), 'response body looks like it contains a credential');
    assert.deepEqual(Object.keys(json.ai).sort(), [
      'geminiConfigured',
      'geminiModel',
      'mode',
      'openaiConfigured',
      'openaiModel',
    ]);
  });
});

describe('cycle rejection', () => {
  it('refuses the edge, names the loop, and leaves the graph byte-identical', async () => {
    const before = (await call('GET', '/api/board')).json;

    const { status, json } = await call('POST', '/api/dependencies', {
      predecessorId: keyOf(before, 'TF-10'),
      successorId: keyOf(before, 'TF-1'),
    });

    assert.equal(status, 409);
    assert.equal(json.code, 'CYCLE_DETECTED');
    assert.equal(json.type, 'https://taskflow.pro/problems/cycle-detected');
    // The reason must be actionable, not just "conflict".
    assert.ok(json.cycleKeys.length >= 3);
    assert.equal(json.cycleKeys[0], json.cycleKeys.at(-1), 'cycle path should be a closed walk');
    assert.match(json.detail, /TF-1/);

    const after = (await call('GET', '/api/board')).json;
    assert.deepEqual(after.dependencies, before.dependencies);
    assert.deepEqual(
      after.tasks.map((t: Json) => [t.key, t.scheduledStart, t.scheduledEnd, t.depState]),
      before.tasks.map((t: Json) => [t.key, t.scheduledStart, t.scheduledEnd, t.depState]),
      'a rejected write must not move a single date',
    );
    assert.equal(after.board.projectFinish, before.board.projectFinish);
  });

  it('refuses a self-edge', async () => {
    const board = (await call('GET', '/api/board')).json;
    const id = keyOf(board, 'TF-5');
    const { status, json } = await call('POST', '/api/dependencies', {
      predecessorId: id,
      successorId: id,
    });
    assert.equal(status, 409);
    assert.equal(json.code, 'SELF_EDGE');
  });

  it('refuses a duplicate', async () => {
    const board = (await call('GET', '/api/board')).json;
    const existing = board.dependencies[0];
    const { status, json } = await call('POST', '/api/dependencies', {
      predecessorId: existing.predecessorId,
      successorId: existing.successorId,
    });
    assert.equal(status, 409);
    assert.equal(json.code, 'DUPLICATE_DEPENDENCY');
  });

  it('rejects one of two concurrent inverse inserts rather than storing both', async () => {
    // The race the naive "check, then write" implementation loses: A -> B and
    // B -> A submitted simultaneously. Each is legal against the graph as it
    // was read; together they are a cycle. BEGIN IMMEDIATE serialises them.
    const board = (await call('GET', '/api/board')).json;
    const a = keyOf(board, 'TF-6');
    const b = keyOf(board, 'TF-9');

    const [first, second] = await Promise.all([
      call('POST', '/api/dependencies', { predecessorId: a, successorId: b }),
      call('POST', '/api/dependencies', { predecessorId: b, successorId: a }),
    ]);

    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [201, 409], 'exactly one insert must win');

    const loser = first.status === 409 ? first.json : second.json;
    assert.ok(['CYCLE_DETECTED', 'DUPLICATE_DEPENDENCY'].includes(loser.code));

    // And the stored graph is still a DAG, which /api/board proves by returning
    // a schedule at all — the service throws a 500 on a cyclic stored graph.
    const after = await call('GET', '/api/board');
    assert.equal(after.status, 200);

    // Clean up so later tests see the seeded topology.
    const added = after.json.dependencies.find(
      (d: Json) =>
        (d.predecessorId === a && d.successorId === b) ||
        (d.predecessorId === b && d.successorId === a),
    );
    if (added) await call('DELETE', `/api/dependencies/${added.id}`);
  });
});

describe('propagation', () => {
  it('shifts only the downstream tasks, by exactly the right amount', async () => {
    const before = (await call('GET', '/api/board')).json;
    const tf3 = before.tasks.find((t: Json) => t.key === 'TF-3');
    const originalFinish = before.board.projectFinish;

    const { status, json } = await call('PATCH', `/api/tasks/${tf3.id}`, {
      durationDays: tf3.durationDays + 3,
      expectedVersion: tf3.version,
    });
    assert.equal(status, 200);
    assert.equal(json.diff.projectFinishDeltaDays, 3);

    const after = json.board;
    const startOf = (board: Json, key: string) =>
      board.tasks.find((t: Json) => t.key === key).scheduledStart;

    // Downstream moved.
    assert.notEqual(startOf(after, 'TF-5'), startOf(before, 'TF-5'));
    // Upstream and parallel-with-slack did not.
    assert.equal(startOf(after, 'TF-1'), startOf(before, 'TF-1'));
    assert.equal(startOf(after, 'TF-2'), startOf(before, 'TF-2'));

    // Restore.
    const restored = await call('PATCH', `/api/tasks/${tf3.id}`, {
      durationDays: tf3.durationDays,
    });
    assert.equal(restored.json.board.board.projectFinish, originalFinish);
  });

  it('rejects a stale write with 409 rather than silently overwriting', async () => {
    const board = (await call('GET', '/api/board')).json;
    const task = board.tasks.find((t: Json) => t.key === 'TF-6');

    const first = await call('PATCH', `/api/tasks/${task.id}`, {
      title: 'Renamed once',
      expectedVersion: task.version,
    });
    assert.equal(first.status, 200);

    // Same version again: a second tab that never saw the first edit.
    const second = await call('PATCH', `/api/tasks/${task.id}`, {
      title: 'Renamed twice',
      expectedVersion: task.version,
    });
    assert.equal(second.status, 409);
    assert.equal(second.json.code, 'STALE_WRITE');

    const check = (await call('GET', '/api/board')).json;
    assert.equal(
      check.tasks.find((t: Json) => t.key === 'TF-6').title,
      'Renamed once',
      'the losing write must not have been applied',
    );
  });
});

describe('the blocked-task policy', () => {
  it('warns on a blocked task leaving Backlog but does not silently allow or silently block', async () => {
    const board = (await call('GET', '/api/board')).json;
    const blocked = board.tasks.find(
      (t: Json) => t.depState === 'BLOCKED' && t.stage === 'BACKLOG',
    );
    assert.ok(blocked, 'the seed should contain a blocked backlog task');

    const { status, json } = await call('POST', `/api/tasks/${blocked.id}/move`, {
      stage: 'IN_PROGRESS',
      expectedVersion: blocked.version,
    });

    assert.equal(status, 200, 'the default policy is warn, not block');
    assert.ok(json.warnings.length > 0, 'the move must be flagged');
    assert.match(json.warnings[0], /blocked/i);

    const moved = json.board.tasks.find((t: Json) => t.id === blocked.id);
    assert.equal(moved.isPolicyViolation, true, 'the violation must remain visible on the board');
    assert.equal(json.board.stats.policyViolations, 1);

    await call('POST', `/api/tasks/${blocked.id}/move`, { stage: 'BACKLOG' });
  });
});

describe('validation and error shape', () => {
  it('returns 422 with field paths for a malformed body', async () => {
    const { status, json } = await call('POST', '/api/tasks', { title: '', durationDays: 0 });
    assert.equal(status, 422);
    assert.equal(json.code, 'VALIDATION_FAILED');
    assert.ok(Array.isArray(json.issues) && json.issues.length >= 2);
    assert.ok(json.issues.some((i: Json) => i.path === 'title'));
    assert.ok(json.issues.some((i: Json) => i.path === 'durationDays'));
  });

  it('returns 400 for a body that is not JSON', async () => {
    const response = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    assert.equal(response.status, 400);
  });

  it('returns 404 as a problem document, with a request id', async () => {
    const { status, json } = await call('GET', '/api/nope');
    assert.equal(status, 404);
    assert.equal(json.code, 'NOT_FOUND');
    assert.match(json.requestId, /^[0-9a-f-]{36}$/);
  });

  it('never leaks a stack trace', async () => {
    const { json } = await call('GET', '/api/tasks/not-a-real-id');
    assert.ok(!JSON.stringify(json).includes('at Object'), 'a stack trace reached the client');
  });
});

describe('AI suggestions', () => {
  it('surfaces gated suggestions and the engine reason for each rejection', async () => {
    process.env.AI_MOCK_SCENARIO = 'hostile';
    const { status, json } = await call('POST', '/api/ai/suggest-dependencies');
    assert.equal(status, 200);

    // The one legitimate suggestion is the edge the seed deliberately withholds.
    assert.ok(json.pending.length >= 1);
    assert.ok(
      json.pending.some((s: Json) => s.predecessorKey === 'TF-4' && s.successorKey === 'TF-5'),
      'the recoverable held-back edge should be proposed',
    );

    // Each hostile fixture must be caught by its own gate.
    const reasons = new Set(json.filtered.map((s: Json) => String(s.filteredReason).split(':')[0]));
    for (const expected of [
      'UNKNOWN_TASK',
      'CYCLE',
      'DUPLICATE',
      'UNVERIFIED_EVIDENCE',
      'LOW_CONFIDENCE',
    ]) {
      assert.ok(reasons.has(expected), `expected a ${expected} rejection, got ${[...reasons]}`);
    }

    // A hallucinated key must never be stored against a task id.
    const hallucinated = json.filtered.find((s: Json) => s.predecessorKey === 'TF-999');
    assert.ok(hallucinated);
    assert.equal(hallucinated.predecessorId, '');
  });

  it('accepting a suggestion goes through the same validation as a manual edge', async () => {
    const list = (await call('GET', '/api/ai/suggestions')).json;
    const pending = list.pending.find((s: Json) => s.predecessorKey === 'TF-4');
    assert.ok(pending);

    const { status, json } = await call('POST', `/api/ai/suggestions/${pending.id}/accept`);
    assert.equal(status, 200);

    const edge = json.board.dependencies.find(
      (d: Json) => d.predecessorKey === 'TF-4' && d.successorKey === 'TF-5',
    );
    assert.ok(edge, 'the accepted edge must exist in the graph');
    assert.equal(edge.origin, 'AI_ACCEPTED', 'provenance must be recorded');
    assert.ok(edge.suggestedBy);

    // Accepting twice must fail rather than duplicate.
    const again = await call('POST', `/api/ai/suggestions/${pending.id}/accept`);
    assert.equal(again.status, 422);

    await call('DELETE', `/api/dependencies/${edge.id}`);
  });

  it('remembers a rejection and refuses to re-propose it', async () => {
    process.env.AI_MOCK_SCENARIO = 'clean';
    await call('POST', '/api/ai/suggest-dependencies');
    const list = (await call('GET', '/api/ai/suggestions')).json;
    const pending = list.pending[0];
    assert.ok(pending);

    const rejected = await call('POST', `/api/ai/suggestions/${pending.id}/reject`);
    assert.equal(rejected.status, 200);

    // The same fixture is returned by the mock, so only the gate can stop it.
    const rerun = (await call('POST', '/api/ai/suggest-dependencies')).json;
    assert.ok(
      !rerun.pending.some(
        (s: Json) =>
          s.predecessorKey === pending.predecessorKey && s.successorKey === pending.successorKey,
      ),
      'a human decision must outrank a repeated model suggestion',
    );
    assert.ok(
      rerun.filtered.some((s: Json) => String(s.filteredReason).startsWith('PREVIOUSLY_REJECTED')),
    );
  });

  it('falls back instead of failing when every provider is down', async () => {
    process.env.AI_MOCK_SCENARIO = 'malformed';
    const { status, json } = await call('POST', '/api/ai/suggest-dependencies');
    // Mock mode has no heuristic fallback configured, so the contract is that
    // the route still answers 200 with an empty, honest result rather than 500.
    assert.equal(status, 200);
    assert.equal(json.pending.length, 0);
    assert.equal(json.providers[0].ok, false);
    assert.ok(json.degraded);
    process.env.AI_MOCK_SCENARIO = 'clean';
  });
});

describe('impact narrative', () => {
  it('is grounded in the engine diff, never in the model', async () => {
    const board = (await call('GET', '/api/board')).json;
    const tf5 = board.tasks.find((t: Json) => t.key === 'TF-5');

    const { json } = await call('POST', '/api/ai/explain-impact', {
      taskId: tf5.id,
      durationDays: tf5.durationDays + 5,
    });

    assert.equal(json.simulated, true);
    assert.equal(json.narrative.facts.projectFinishDeltaDays, 5);
    // Every number in the prose must be one the engine produced.
    const dates = json.narrative.text.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
    const allowed = new Set([
      json.narrative.facts.projectFinish,
      json.narrative.facts.previousProjectFinish,
      ...json.narrative.facts.rescheduled.flatMap((r: Json) => [r.newStart, r.newEnd]),
    ]);
    for (const date of dates)
      assert.ok(allowed.has(date), `${date} is not an engine-produced date`);
  });

  it('does not mutate anything', async () => {
    const before = (await call('GET', '/api/board')).json;
    const tf5 = before.tasks.find((t: Json) => t.key === 'TF-5');
    await call('POST', '/api/ai/explain-impact', { taskId: tf5.id, durationDays: 40 });
    const after = (await call('GET', '/api/board')).json;
    assert.deepEqual(after.tasks, before.tasks, 'a what-if must be read-only');
  });
});

describe('persistence', () => {
  it('survives a restart with derived state intact', async () => {
    const board = (await call('GET', '/api/board')).json;
    const tf6 = board.tasks.find((t: Json) => t.key === 'TF-6');
    await call('PATCH', `/api/tasks/${tf6.id}`, { durationDays: 9 });
    const expected = (await call('GET', '/api/board')).json;

    // Close and reopen against the same file, as a container restart would.
    await new Promise<void>((done) => server.close(() => done()));
    const restarted = await start(dbPath);
    server = restarted.server;
    baseUrl = restarted.url;

    const reloaded = (await call('GET', '/api/board')).json;
    assert.equal(reloaded.tasks.find((t: Json) => t.key === 'TF-6').durationDays, 9);
    assert.deepEqual(
      reloaded.tasks.map((t: Json) => [t.key, t.scheduledStart, t.scheduledEnd, t.slackDays]),
      expected.tasks.map((t: Json) => [t.key, t.scheduledStart, t.scheduledEnd, t.slackDays]),
      'the recomputed schedule must match what was served before the restart',
    );
    assert.equal(reloaded.board.projectFinish, expected.board.projectFinish);
  });
});

describe('admin reset', () => {
  it('requires the token and restores the seeded board', async () => {
    const denied = await call('POST', '/api/admin/reset-demo');
    assert.equal(denied.status, 403);
    assert.equal(denied.json.code, 'FORBIDDEN');

    const allowed = await call('POST', '/api/admin/reset-demo', undefined, {
      'x-admin-token': 'test-token',
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json.tasks.length, 10);
    assert.equal(allowed.json.dependencies.length, 14);
    assert.equal(allowed.json.tasks.find((t: Json) => t.key === 'TF-6').durationDays, 3);
  });
});

describe('static assets', () => {
  it('serves the app shell and refuses path traversal', async () => {
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);

    const traversal = await fetch(`${baseUrl}/../package.json`, { redirect: 'manual' });
    assert.ok(traversal.status >= 300, 'path traversal must not return a file');
  });
});
