/**
 * Public surface of the dependency engine.
 *
 * This package is intentionally dependency-free and side-effect-free: it
 * imports nothing outside itself, touches no database, reads no clock, and
 * makes no network calls. Everything it needs arrives as an argument.
 *
 * That constraint is what makes the scheduling rules exhaustively unit-testable
 * in milliseconds without any infrastructure, and it keeps the correctness of
 * the DAG independent of how the application happens to store or serve it.
 */

export * from './types.ts';
export * from './dates.ts';
export * from './graph.ts';
export * from './schedule.ts';
export * from './diff.ts';
export * as rank from './rank.ts';
