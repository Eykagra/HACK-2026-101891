/**
 * Fractional indexing for card ordering inside a Kanban column.
 *
 * Reordering by integer index forces a rewrite of every row after the insert
 * point. Instead each card stores an opaque base-62 rank string, and inserting
 * between two neighbours mints a new string that sorts lexicographically
 * between them. Every drag is therefore a single-row update, regardless of how
 * many cards the column holds.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;

function indexOf(ch: string): number {
  const i = DIGITS.indexOf(ch);
  if (i < 0) throw new RangeError(`Invalid rank character: ${JSON.stringify(ch)}`);
  return i;
}

/**
 * Mint a rank strictly between `lo` and `hi`.
 * Pass `null` for an open end (`between(null, first)` prepends,
 * `between(last, null)` appends, `between(null, null)` seeds an empty column).
 */
export function between(lo: string | null, hi: string | null): string {
  const a = lo ?? '';
  const b = hi ?? '';
  if (a && b && a >= b) {
    throw new RangeError(`Ranks out of order: ${a} >= ${b}`);
  }
  let out = '';
  for (let i = 0; ; i++) {
    // A missing `lo` digit is the minimum; a missing `hi` digit is one past the
    // maximum, because any longer string sharing the prefix sorts before `hi`.
    const da = i < a.length ? indexOf(a[i]!) : 0;
    const db = i < b.length ? indexOf(b[i]!) : BASE;
    if (db - da > 1) return out + DIGITS[Math.floor((da + db) / 2)];
    out += DIGITS[da];
  }
}

/** Ranks for `n` evenly spread new items in an empty column. */
export function sequence(n: number): string[] {
  const out: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    prev = between(prev, null);
    out.push(prev);
  }
  return out;
}
