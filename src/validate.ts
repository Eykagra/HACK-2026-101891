/**
 * A ~150-line schema validator.
 *
 * Every byte entering the system is validated here: HTTP request bodies,
 * environment variables, and LLM responses all go through the same combinators.
 * Using one validator for all three means the AI output path gets exactly the
 * same scrutiny as an untrusted HTTP body, which is the point.
 *
 * A dedicated library would be a fine choice; this exists so the application
 * ships with zero runtime dependencies and therefore zero supply-chain surface.
 */

export interface Issue {
  path: string;
  message: string;
}

export type Check<T> = (value: unknown, path?: string) => { value: T; issues: Issue[] };

const fail = (path: string, message: string): Issue => ({ path: path || '(root)', message });

export function str(
  opts: { min?: number; max?: number; trim?: boolean; pattern?: RegExp } = {},
): Check<string> {
  return (value, path = '') => {
    if (typeof value !== 'string') return { value: '', issues: [fail(path, 'must be a string')] };
    const v = opts.trim === false ? value : value.trim();
    const issues: Issue[] = [];
    if (opts.min !== undefined && v.length < opts.min) {
      issues.push(fail(path, `must be at least ${opts.min} character(s)`));
    }
    if (opts.max !== undefined && v.length > opts.max) {
      issues.push(fail(path, `must be at most ${opts.max} character(s)`));
    }
    if (opts.pattern && !opts.pattern.test(v)) {
      issues.push(fail(path, `must match ${opts.pattern}`));
    }
    return { value: v, issues };
  };
}

export function int(opts: { min?: number; max?: number } = {}): Check<number> {
  return (value, path = '') => {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isInteger(n)) {
      return { value: 0, issues: [fail(path, 'must be an integer')] };
    }
    const issues: Issue[] = [];
    if (opts.min !== undefined && n < opts.min) issues.push(fail(path, `must be >= ${opts.min}`));
    if (opts.max !== undefined && n > opts.max) issues.push(fail(path, `must be <= ${opts.max}`));
    return { value: n, issues };
  };
}

export function num(opts: { min?: number; max?: number } = {}): Check<number> {
  return (value, path = '') => {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      return { value: 0, issues: [fail(path, 'must be a number')] };
    }
    const issues: Issue[] = [];
    if (opts.min !== undefined && n < opts.min) issues.push(fail(path, `must be >= ${opts.min}`));
    if (opts.max !== undefined && n > opts.max) issues.push(fail(path, `must be <= ${opts.max}`));
    return { value: n, issues };
  };
}

export function bool(): Check<boolean> {
  return (value, path = '') => {
    if (typeof value === 'boolean') return { value, issues: [] };
    if (value === 'true' || value === 1) return { value: true, issues: [] };
    if (value === 'false' || value === 0) return { value: false, issues: [] };
    return { value: false, issues: [fail(path, 'must be a boolean')] };
  };
}

export function oneOf<const T extends readonly string[]>(options: T): Check<T[number]> {
  return (value, path = '') => {
    if (typeof value === 'string' && (options as readonly string[]).includes(value)) {
      return { value: value as T[number], issues: [] };
    }
    return {
      value: options[0] as T[number],
      issues: [fail(path, `must be one of: ${options.join(', ')}`)],
    };
  };
}

export const isoDate = (): Check<string> =>
  str({ pattern: /^\d{4}-\d{2}-\d{2}$/, min: 10, max: 10 });

export function nullable<T>(check: Check<T>): Check<T | null> {
  return (value, path = '') => {
    if (value === null || value === undefined || value === '') {
      return { value: null, issues: [] };
    }
    return check(value, path);
  };
}

export function arrayOf<T>(check: Check<T>, opts: { max?: number } = {}): Check<T[]> {
  return (value, path = '') => {
    if (!Array.isArray(value)) return { value: [], issues: [fail(path, 'must be an array')] };
    if (opts.max !== undefined && value.length > opts.max) {
      return { value: [], issues: [fail(path, `must have at most ${opts.max} item(s)`)] };
    }
    const out: T[] = [];
    const issues: Issue[] = [];
    value.forEach((item, i) => {
      const r = check(item, `${path}[${i}]`);
      out.push(r.value);
      issues.push(...r.issues);
    });
    return { value: out, issues };
  };
}

type Shape = Record<string, Check<unknown>>;
type Infer<S extends Shape> = { [K in keyof S]: ReturnType<S[K]>['value'] };

/** All keys are required; use `nullable(...)` or `optional(...)` to relax one. */
export function object<S extends Shape>(shape: S): Check<Infer<S>> {
  return (value, path = '') => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { value: {} as Infer<S>, issues: [fail(path, 'must be an object')] };
    }
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const issues: Issue[] = [];
    for (const [key, check] of Object.entries(shape)) {
      const r = check(src[key], path ? `${path}.${key}` : key);
      out[key] = r.value;
      issues.push(...r.issues);
    }
    return { value: out as Infer<S>, issues };
  };
}

const ABSENT = Symbol('absent');

/** Marks a field as absent-or-valid; absent fields are omitted from the result. */
export function optional<T>(check: Check<T>): Check<T | undefined> {
  return (value, path = '') => {
    if (value === undefined) return { value: undefined, issues: [] };
    return check(value, path);
  };
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

export function parse<T>(check: Check<T>, input: unknown): Parsed<T> {
  const { value, issues } = check(input, '');
  return issues.length === 0 ? { ok: true, value } : { ok: false, issues };
}

/** Drop keys whose value is `undefined`, so partial updates stay partial. */
export function definedOnly<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

export { ABSENT };
