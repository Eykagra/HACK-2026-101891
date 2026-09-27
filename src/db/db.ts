/**
 * Database connection, migration and transaction management.
 *
 * ## Why SQLite
 *
 * The engine is storage-agnostic, so the store only has to provide durable
 * rows and a serialisable transaction. SQLite in WAL mode provides both, ships
 * inside Node 22+ as `node:sqlite`, needs no server process, and therefore
 * turns "clone and run" into two commands with zero dependencies to install.
 *
 * ## Why this closes the cycle race for free
 *
 * A dependency insert is a check-then-write: read the graph, prove the new edge
 * is acyclic, insert it. Two concurrent inserts of `B -> C` and `C -> B` can
 * each individually pass and together create a cycle. On Postgres the fix is a
 * `SELECT ... FOR UPDATE` on the board row. SQLite gives the same guarantee
 * more simply: `BEGIN IMMEDIATE` takes the single writer lock up front, so the
 * read that validates and the write that commits are one serialised unit and
 * the interleaving cannot occur. See `docs/adr/0004-transactions-and-races.md`.
 */

import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));

export type Db = DatabaseSync;

export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // WAL lets readers proceed during a write; NORMAL is the right durability
  // trade-off for WAL. `busy_timeout` makes a contended writer wait instead of
  // immediately failing with SQLITE_BUSY.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

/**
 * Run `fn` inside one serialised write transaction.
 *
 * `BEGIN IMMEDIATE` (rather than the default deferred `BEGIN`) acquires the
 * write lock before `fn` reads anything, which is what makes validate-then-write
 * atomic. Any throw rolls the whole transaction back, so a rejected dependency
 * leaves no trace: not the edge, and not the derived schedule columns.
 */
export function withTransaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // A failed rollback means the transaction was already aborted; the
      // original error is the one worth surfacing.
    }
    throw error;
  }
}

export const nowIso = (): string => new Date().toISOString();
export const newId = (): string => crypto.randomUUID();
