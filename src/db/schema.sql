-- TaskFlow Pro schema.
--
-- Two kinds of column live on `tasks`:
--   * scheduling *inputs*  (duration_days, planned_start, is_pinned, stage, ...)
--   * derived *outputs*    (scheduled_start, dep_state, slack_days, is_critical)
--
-- The derived columns are a cache with a transactional invariant: they are
-- written only by recomputeBoard(), only inside the same transaction as the
-- mutation that invalidated them. They are never a second source of truth, and
-- an idempotency test asserts the cache equals what the pure engine computes.

CREATE TABLE IF NOT EXISTS boards (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  project_start INTEGER NOT NULL,           -- epoch day
  settings      TEXT NOT NULL DEFAULT '{}', -- JSON
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  board_id        TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  stage           TEXT NOT NULL CHECK (stage IN ('BACKLOG','IN_PROGRESS','REVIEW','DONE')),
  position        TEXT NOT NULL,            -- fractional index
  duration_days   INTEGER NOT NULL CHECK (duration_days >= 1 AND duration_days <= 3650),
  planned_start   INTEGER,                  -- epoch day
  is_pinned       INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0,1)),
  actual_finish   INTEGER,                  -- epoch day, set when stage = DONE
  assignee        TEXT,
  priority        TEXT CHECK (priority IS NULL OR priority IN ('LOW','MEDIUM','HIGH')),
  version         INTEGER NOT NULL DEFAULT 1,
  -- derived, written only by recomputeBoard()
  scheduled_start INTEGER,
  scheduled_end   INTEGER,
  dep_state       TEXT CHECK (dep_state IS NULL OR dep_state IN ('BLOCKED','READY')),
  unmet_count     INTEGER NOT NULL DEFAULT 0,
  slack_days      INTEGER,
  is_critical     INTEGER NOT NULL DEFAULT 0 CHECK (is_critical IN (0,1)),
  computed_at     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (board_id, key)
);

CREATE TABLE IF NOT EXISTS dependencies (
  id             TEXT PRIMARY KEY,
  board_id       TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  predecessor_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  successor_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  lag_days       INTEGER NOT NULL DEFAULT 0 CHECK (lag_days >= 0 AND lag_days <= 365),
  origin         TEXT NOT NULL CHECK (origin IN ('MANUAL','AI_ACCEPTED','SEED')),
  suggested_by   TEXT,                      -- provider/model that proposed it
  is_critical    INTEGER NOT NULL DEFAULT 0 CHECK (is_critical IN (0,1)),
  created_by     TEXT NOT NULL DEFAULT 'user',
  created_at     TEXT NOT NULL,
  -- A self-edge is impossible at the storage layer, not merely discouraged.
  CHECK (predecessor_id <> successor_id),
  UNIQUE (predecessor_id, successor_id)
);

CREATE TABLE IF NOT EXISTS suggestions (
  id               TEXT PRIMARY KEY,
  board_id         TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  predecessor_id   TEXT NOT NULL,
  successor_id     TEXT NOT NULL,
  confidence       REAL NOT NULL,
  rationale        TEXT NOT NULL,
  evidence         TEXT NOT NULL DEFAULT '[]',  -- JSON: verbatim spans
  providers        TEXT NOT NULL DEFAULT '[]',  -- JSON: which models proposed it
  agreement        INTEGER NOT NULL DEFAULT 1,  -- how many models agreed
  prompt_version   TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('PENDING','ACCEPTED','REJECTED','FILTERED')),
  filtered_reason  TEXT,
  created_at       TEXT NOT NULL,
  decided_at       TEXT,
  decided_by       TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id         TEXT PRIMARY KEY,
  board_id   TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  actor      TEXT NOT NULL DEFAULT 'user',
  summary    TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}',   -- JSON: the ScheduleDiff and inputs
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_board_stage_pos ON tasks (board_id, stage, position);
CREATE INDEX IF NOT EXISTS idx_tasks_board_key       ON tasks (board_id, key);
CREATE INDEX IF NOT EXISTS idx_deps_board            ON dependencies (board_id);
CREATE INDEX IF NOT EXISTS idx_deps_successor        ON dependencies (successor_id);
CREATE INDEX IF NOT EXISTS idx_deps_predecessor      ON dependencies (predecessor_id);
CREATE INDEX IF NOT EXISTS idx_suggestions_board     ON suggestions (board_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_board_created   ON audit_events (board_id, created_at DESC);
