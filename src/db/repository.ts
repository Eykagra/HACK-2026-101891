/**
 * The only module that speaks SQL.
 *
 * Services depend on this interface, never on `node:sqlite`, which is what
 * keeps the Postgres migration a single-file change: reimplement `Repository`
 * against `pg`, swap `withTransaction` for `SELECT ... FOR UPDATE`, and nothing
 * above this line moves.
 *
 * Every statement is parameterised. No SQL is ever built by concatenating input.
 */

import type { EdgeOrigin, Stage, TaskId } from '../engine/index.ts';
import { newId, nowIso, type Db } from './db.ts';

export interface BoardRow {
  id: string;
  name: string;
  project_start: number;
  settings: string;
  created_at: string;
}

export interface TaskRow {
  id: string;
  board_id: string;
  key: string;
  title: string;
  description: string;
  stage: Stage;
  position: string;
  duration_days: number;
  planned_start: number | null;
  is_pinned: number;
  actual_finish: number | null;
  assignee: string | null;
  priority: string | null;
  version: number;
  scheduled_start: number | null;
  scheduled_end: number | null;
  dep_state: 'BLOCKED' | 'READY' | null;
  unmet_count: number;
  slack_days: number | null;
  is_critical: number;
  computed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DependencyRow {
  id: string;
  board_id: string;
  predecessor_id: string;
  successor_id: string;
  lag_days: number;
  origin: EdgeOrigin;
  suggested_by: string | null;
  is_critical: number;
  created_by: string;
  created_at: string;
}

export interface SuggestionRow {
  id: string;
  board_id: string;
  predecessor_id: string;
  successor_id: string;
  confidence: number;
  rationale: string;
  evidence: string;
  providers: string;
  agreement: number;
  prompt_version: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'FILTERED';
  filtered_reason: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

export interface AuditRow {
  id: string;
  board_id: string;
  type: string;
  actor: string;
  summary: string;
  payload: string;
  created_at: string;
}

export interface NewTask {
  boardId: string;
  key: string;
  title: string;
  description: string;
  stage: Stage;
  position: string;
  durationDays: number;
  plannedStart: number | null;
  isPinned: boolean;
  actualFinish: number | null;
  assignee: string | null;
  priority: string | null;
}

export interface TaskPatch {
  title?: string;
  description?: string;
  stage?: Stage;
  position?: string;
  durationDays?: number;
  plannedStart?: number | null;
  isPinned?: boolean;
  actualFinish?: number | null;
  assignee?: string | null;
  priority?: string | null;
}

const COLUMN_OF: Record<keyof TaskPatch, string> = {
  title: 'title',
  description: 'description',
  stage: 'stage',
  position: 'position',
  durationDays: 'duration_days',
  plannedStart: 'planned_start',
  isPinned: 'is_pinned',
  actualFinish: 'actual_finish',
  assignee: 'assignee',
  priority: 'priority',
};

/**
 * Note on `as unknown as XRow`.
 *
 * `node:sqlite` returns `Record<string, SQLOutputValue>`, which TypeScript will
 * not narrow to a row interface directly. The assertion is unavoidable at this
 * boundary; what matters is that it happens *only* here. `src/db/schema.sql` is
 * the single source of truth for these shapes, and no layer above this file
 * ever touches a raw SQL row.
 */
export class Repository {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // ---- boards --------------------------------------------------------------

  getBoard(id: string): BoardRow | null {
    return (
      (this.db.prepare('SELECT * FROM boards WHERE id = ?').get(id) as unknown as BoardRow) ?? null
    );
  }

  getFirstBoard(): BoardRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM boards ORDER BY created_at LIMIT 1')
        .get() as unknown as BoardRow) ?? null
    );
  }

  createBoard(input: { name: string; projectStart: number; settings: unknown }): BoardRow {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO boards (id, name, project_start, settings, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.projectStart, JSON.stringify(input.settings ?? {}), nowIso());
    return this.getBoard(id)!;
  }

  // ---- tasks ---------------------------------------------------------------

  listTasks(boardId: string): TaskRow[] {
    return this.db
      .prepare('SELECT * FROM tasks WHERE board_id = ? ORDER BY stage, position, key')
      .all(boardId) as unknown as TaskRow[];
  }

  getTask(id: string): TaskRow | null {
    return (
      (this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRow) ?? null
    );
  }

  getTaskByKey(boardId: string, key: string): TaskRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM tasks WHERE board_id = ? AND key = ?')
        .get(boardId, key) as unknown as TaskRow) ?? null
    );
  }

  /** Highest numeric suffix of `PREFIX-n` keys, for minting the next key. */
  nextKeyNumber(boardId: string, prefix: string): number {
    const rows = this.db.prepare('SELECT key FROM tasks WHERE board_id = ?').all(boardId) as Array<{
      key: string;
    }>;
    let max = 0;
    for (const { key } of rows) {
      const m = new RegExp(`^${prefix}-(\\d+)$`).exec(key);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  }

  lastPositionInStage(boardId: string, stage: Stage): string | null {
    const row = this.db
      .prepare(
        `SELECT position FROM tasks WHERE board_id = ? AND stage = ?
         ORDER BY position DESC LIMIT 1`,
      )
      .get(boardId, stage) as { position: string } | undefined;
    return row?.position ?? null;
  }

  createTask(input: NewTask): TaskRow {
    const id = newId();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO tasks (
           id, board_id, key, title, description, stage, position, duration_days,
           planned_start, is_pinned, actual_finish, assignee, priority, version,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        input.boardId,
        input.key,
        input.title,
        input.description,
        input.stage,
        input.position,
        input.durationDays,
        input.plannedStart,
        input.isPinned ? 1 : 0,
        input.actualFinish,
        input.assignee,
        input.priority,
        ts,
        ts,
      );
    return this.getTask(id)!;
  }

  /**
   * Apply a partial update and bump `version`.
   *
   * The `version` column is an optimistic-concurrency token: the service
   * compares the client's expected version before calling this, so two tabs
   * editing the same task produce a 409 rather than a silent lost update.
   */
  updateTask(id: string, patch: TaskPatch): TaskRow {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return this.getTask(id)!;

    const assignments = entries.map(([k]) => `${COLUMN_OF[k as keyof TaskPatch]} = ?`);
    const values = entries.map(([, v]) => (typeof v === 'boolean' ? (v ? 1 : 0) : v));
    this.db
      .prepare(
        `UPDATE tasks SET ${assignments.join(', ')}, version = version + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(...(values as never[]), nowIso(), id);
    return this.getTask(id)!;
  }

  deleteTask(id: string): void {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  /** Written only by `recomputeBoard`. */
  writeDerived(
    rows: Array<{
      id: string;
      scheduledStart: number;
      scheduledEnd: number;
      depState: 'BLOCKED' | 'READY';
      unmetCount: number;
      slackDays: number;
      isCritical: boolean;
    }>,
  ): void {
    const stmt = this.db.prepare(
      `UPDATE tasks SET scheduled_start = ?, scheduled_end = ?, dep_state = ?,
              unmet_count = ?, slack_days = ?, is_critical = ?, computed_at = ?
       WHERE id = ?`,
    );
    const ts = nowIso();
    for (const r of rows) {
      stmt.run(
        r.scheduledStart,
        r.scheduledEnd,
        r.depState,
        r.unmetCount,
        r.slackDays,
        r.isCritical ? 1 : 0,
        ts,
        r.id,
      );
    }
  }

  // ---- dependencies --------------------------------------------------------

  listDependencies(boardId: string): DependencyRow[] {
    return this.db
      .prepare('SELECT * FROM dependencies WHERE board_id = ? ORDER BY created_at, id')
      .all(boardId) as unknown as DependencyRow[];
  }

  getDependency(id: string): DependencyRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM dependencies WHERE id = ?')
        .get(id) as unknown as DependencyRow) ?? null
    );
  }

  createDependency(input: {
    boardId: string;
    predecessorId: string;
    successorId: string;
    lagDays: number;
    origin: EdgeOrigin;
    suggestedBy?: string | null;
    createdBy?: string;
  }): DependencyRow {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO dependencies (
           id, board_id, predecessor_id, successor_id, lag_days, origin,
           suggested_by, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.boardId,
        input.predecessorId,
        input.successorId,
        input.lagDays,
        input.origin,
        input.suggestedBy ?? null,
        input.createdBy ?? 'user',
        nowIso(),
      );
    return this.getDependency(id)!;
  }

  deleteDependency(id: string): void {
    this.db.prepare('DELETE FROM dependencies WHERE id = ?').run(id);
  }

  markCriticalEdges(
    boardId: string,
    critical: Array<{ predecessorId: TaskId; successorId: TaskId }>,
  ): void {
    this.db.prepare('UPDATE dependencies SET is_critical = 0 WHERE board_id = ?').run(boardId);
    const stmt = this.db.prepare(
      `UPDATE dependencies SET is_critical = 1
       WHERE board_id = ? AND predecessor_id = ? AND successor_id = ?`,
    );
    for (const e of critical) stmt.run(boardId, e.predecessorId, e.successorId);
  }

  // ---- suggestions ---------------------------------------------------------

  listSuggestions(boardId: string, statuses: string[]): SuggestionRow[] {
    const placeholders = statuses.map(() => '?').join(', ');
    return this.db
      .prepare(
        `SELECT * FROM suggestions
         WHERE board_id = ? AND status IN (${placeholders})
         ORDER BY agreement DESC, confidence DESC, created_at DESC`,
      )
      .all(boardId, ...statuses) as unknown as SuggestionRow[];
  }

  getSuggestion(id: string): SuggestionRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM suggestions WHERE id = ?')
        .get(id) as unknown as SuggestionRow) ?? null
    );
  }

  /** Pairs a human has already rejected, fed back into the next prompt. */
  rejectedPairs(boardId: string): Array<{ predecessor_id: string; successor_id: string }> {
    return this.db
      .prepare(
        `SELECT DISTINCT predecessor_id, successor_id FROM suggestions
         WHERE board_id = ? AND status = 'REJECTED'`,
      )
      .all(boardId) as Array<{ predecessor_id: string; successor_id: string }>;
  }

  clearPendingSuggestions(boardId: string): void {
    this.db
      .prepare(`DELETE FROM suggestions WHERE board_id = ? AND status IN ('PENDING','FILTERED')`)
      .run(boardId);
  }

  createSuggestion(input: {
    boardId: string;
    predecessorId: string;
    successorId: string;
    confidence: number;
    rationale: string;
    evidence: unknown;
    providers: string[];
    agreement: number;
    promptVersion: string;
    status: SuggestionRow['status'];
    filteredReason?: string | null;
  }): SuggestionRow {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO suggestions (
           id, board_id, predecessor_id, successor_id, confidence, rationale,
           evidence, providers, agreement, prompt_version, status, filtered_reason, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.boardId,
        input.predecessorId,
        input.successorId,
        input.confidence,
        input.rationale,
        JSON.stringify(input.evidence ?? []),
        JSON.stringify(input.providers),
        input.agreement,
        input.promptVersion,
        input.status,
        input.filteredReason ?? null,
        nowIso(),
      );
    return this.getSuggestion(id)!;
  }

  decideSuggestion(id: string, status: 'ACCEPTED' | 'REJECTED', by = 'user'): void {
    this.db
      .prepare('UPDATE suggestions SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?')
      .run(status, nowIso(), by, id);
  }

  // ---- audit ---------------------------------------------------------------

  appendAudit(input: {
    boardId: string;
    type: string;
    summary: string;
    payload: unknown;
    actor?: string;
  }): AuditRow {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO audit_events (id, board_id, type, actor, summary, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.boardId,
        input.type,
        input.actor ?? 'user',
        input.summary,
        JSON.stringify(input.payload ?? {}),
        nowIso(),
      );
    return this.db
      .prepare('SELECT * FROM audit_events WHERE id = ?')
      .get(id) as unknown as AuditRow;
  }

  listAudit(boardId: string, limit = 30): AuditRow[] {
    return this.db
      .prepare(
        'SELECT * FROM audit_events WHERE board_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(boardId, limit) as unknown as AuditRow[];
  }

  latestAudit(boardId: string): AuditRow | null {
    return this.listAudit(boardId, 1)[0] ?? null;
  }
}
