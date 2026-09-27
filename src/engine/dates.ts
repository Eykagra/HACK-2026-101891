/**
 * Date handling for the engine.
 *
 * The engine works exclusively in integer **epoch days** (days since
 * 1970-01-01, UTC). This is a deliberate decision: scheduling maths becomes
 * plain integer arithmetic, so there is no possibility of DST drift, local
 * timezone skew, or floating point error in date propagation. Conversion to
 * and from ISO calendar dates happens only at the system boundary.
 *
 * Intervals are half-open: a task occupies `[start, end)`. A 3-day task
 * starting on day 100 ends on day 103, and its successor starts on day 103.
 * The UI renders the *inclusive* last day (`end - 1`) so users see
 * "Mon-Wed" rather than "Mon-Thu".
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const MS_PER_DAY = 86_400_000;

/** Parse a strict `YYYY-MM-DD` string into an epoch day. */
export function toEpochDay(iso: string): number {
  const m = ISO_DATE.exec(iso);
  if (!m) throw new RangeError(`Expected a YYYY-MM-DD date, received "${iso}"`);
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new RangeError(`"${iso}" is not a valid calendar date`);
  }
  const ms = Date.UTC(year, month - 1, day);
  const roundTrip = new Date(ms);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    throw new RangeError(`"${iso}" is not a valid calendar date`);
  }
  return Math.floor(ms / MS_PER_DAY);
}

/** Render an epoch day as `YYYY-MM-DD`. */
export function fromEpochDay(day: number): string {
  if (!Number.isFinite(day)) throw new RangeError(`Not a finite epoch day: ${day}`);
  return new Date(Math.trunc(day) * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Render the last *inclusive* day of a half-open interval that ends at `end`.
 * Used for display only.
 */
export function inclusiveEndDate(end: number): string {
  return fromEpochDay(end - 1);
}

/** Epoch day for "today" in UTC. The only clock read in the codebase. */
export function todayEpochDay(now: number = Date.now()): number {
  return Math.floor(now / MS_PER_DAY);
}
