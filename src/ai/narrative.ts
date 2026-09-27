/**
 * Impact narratives.
 *
 * The rule here is strict and worth stating plainly: **the model never computes
 * a number.** Every date, day count and task key in the narrative comes from
 * the deterministic scheduler. The LLM is only used to turn an already-correct
 * structured diff into a readable sentence.
 *
 * To make that more than a promise, generated prose is verified: every integer
 * and ISO date in the model's output must appear in an allowlist derived from
 * the diff. If the model writes "slipped by 6 days" when the engine said 3, the
 * text is discarded and the deterministic template is used instead. A confident
 * wrong number in a planning tool is worse than a plain right one.
 */
import type { ScheduleDiff, ScheduleResult } from '../engine/index.ts';
import { fromEpochDay, inclusiveEndDate } from '../engine/index.ts';
import type { Config } from '../config.ts';
import { buildNarrativePrompt } from './prompt.ts';
import { providersFor } from './consensus.ts';
import type { LlmProvider } from './provider.ts';

export interface MovedTaskFact {
  key: string;
  startDeltaDays: number;
  endDeltaDays: number;
  newStart: string;
  newEnd: string;
  slackDays: number;
  becameCritical: boolean;
}

export interface NarrativeFacts {
  action: string;
  projectFinishDeltaDays: number;
  previousProjectFinish: string | null;
  projectFinish: string;
  rescheduled: MovedTaskFact[];
  newlyBlocked: string[];
  newlyReady: string[];
  criticalPathChanged: boolean;
  criticalPath: string[];
}

export interface Narrative {
  text: string;
  /** 'template' means deterministic prose; otherwise the provider name. */
  source: string;
  facts: NarrativeFacts;
  /** Set when a model reply was discarded, so the UI can say why. */
  fallbackReason: string | null;
}

const dayWord = (n: number): string => (Math.abs(n) === 1 ? 'day' : 'days');

/**
 * Projects an engine diff onto the small set of facts a narrative may mention.
 * Keys, not UUIDs: the prose is for humans and the model never sees an ID it
 * could leak.
 */
export function factsFrom(
  action: string,
  diff: ScheduleDiff,
  before: ScheduleResult | null,
  after: ScheduleResult,
  keyOf: Map<string, string>,
): NarrativeFacts {
  const key = (id: string): string => keyOf.get(id) ?? id;
  const criticalPathChanged =
    before === null ||
    before.criticalPath.length !== after.criticalPath.length ||
    before.criticalPath.some((id, i) => id !== after.criticalPath[i]);

  return {
    action,
    projectFinishDeltaDays: diff.projectFinishDeltaDays,
    previousProjectFinish: before ? inclusiveEndDate(before.projectFinish) : null,
    projectFinish: inclusiveEndDate(after.projectFinish),
    rescheduled: diff.changed
      .filter((d) => d.startDeltaDays !== 0 || d.endDeltaDays !== 0)
      .map((d) => {
        const s = after.byId[d.id]!;
        return {
          key: key(d.id),
          startDeltaDays: d.startDeltaDays,
          endDeltaDays: d.endDeltaDays,
          newStart: fromEpochDay(s.earliestStart),
          newEnd: inclusiveEndDate(s.earliestFinish),
          slackDays: s.slackDays,
          becameCritical: d.becameCritical,
        };
      }),
    newlyBlocked: diff.changed
      .filter((d) => d.depStateBefore === 'READY' && d.depStateAfter === 'BLOCKED')
      .map((d) => key(d.id)),
    newlyReady: diff.changed
      .filter((d) => d.depStateBefore === 'BLOCKED' && d.depStateAfter === 'READY')
      .map((d) => key(d.id)),
    criticalPathChanged,
    criticalPath: after.criticalPath.map(key),
  };
}

/**
 * Deterministic renderer. Always available, always correct, and used verbatim
 * when AI is off or when verification rejects generated text.
 */
export function renderTemplate(f: NarrativeFacts): string {
  const parts: string[] = [];
  const shift = f.projectFinishDeltaDays;

  if (shift > 0) {
    parts.push(
      `${f.action} pushed the project finish out by ${shift} ${dayWord(shift)}, ` +
        `from ${f.previousProjectFinish} to ${f.projectFinish}.`,
    );
  } else if (shift < 0) {
    parts.push(
      `${f.action} pulled the project finish in by ${Math.abs(shift)} ${dayWord(shift)}, ` +
        `from ${f.previousProjectFinish} to ${f.projectFinish}.`,
    );
  } else {
    parts.push(`${f.action} left the project finish unchanged at ${f.projectFinish}.`);
  }

  if (f.rescheduled.length === 0) {
    parts.push('No task dates moved.');
  } else {
    const shown = f.rescheduled.slice(0, 4);
    const detail = shown
      .map((t) => {
        if (t.startDeltaDays === 0 && t.endDeltaDays === 0) return `${t.key} held at ${t.newEnd}`;
        const d = t.startDeltaDays !== 0 ? t.startDeltaDays : t.endDeltaDays;
        const verb = d > 0 ? 'slipped' : 'moved earlier by';
        // A one-day task has start == end; printing it twice reads like a bug.
        const when = t.newStart === t.newEnd ? t.newStart : `${t.newStart}–${t.newEnd}`;
        return `${t.key} ${verb} ${Math.abs(d)} ${dayWord(d)} to ${when}`;
      })
      .join('; ');
    const more = f.rescheduled.length - shown.length;
    parts.push(
      `${f.rescheduled.length} ${f.rescheduled.length === 1 ? 'task' : 'tasks'} rescheduled: ` +
        `${detail}${more > 0 ? `, plus ${more} more` : ''}.`,
    );
  }

  if (f.newlyBlocked.length > 0) parts.push(`Now blocked: ${f.newlyBlocked.join(', ')}.`);
  if (f.newlyReady.length > 0) parts.push(`Now ready to start: ${f.newlyReady.join(', ')}.`);
  if (f.criticalPathChanged && f.criticalPath.length > 0) {
    parts.push(`The critical path is now ${f.criticalPath.join(' → ')}.`);
  }
  return parts.join(' ');
}

/** The numbers and dates the model is permitted to use. */
export function allowedTokens(f: NarrativeFacts): Set<string> {
  const allowed = new Set<string>();
  const num = (n: number): void => void allowed.add(String(Math.abs(n)));
  const date = (d: string | null): void => void (d && allowed.add(d));

  num(f.projectFinishDeltaDays);
  date(f.previousProjectFinish);
  date(f.projectFinish);
  allowed.add(String(f.rescheduled.length));
  allowed.add(String(f.newlyBlocked.length));
  allowed.add(String(f.newlyReady.length));
  allowed.add(String(f.criticalPath.length));

  for (const t of f.rescheduled) {
    num(t.startDeltaDays);
    num(t.endDeltaDays);
    num(t.slackDays);
    date(t.newStart);
    date(t.newEnd);
  }
  // 0 and 1 are structurally unavoidable in English prose ("one task", "no days").
  allowed.add('0');
  allowed.add('1');
  return allowed;
}

const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}/g;
const NUMBER_RE = /\d+(?:\.\d+)?/g;

/**
 * Returns the first figure in `text` that the engine did not produce, or null
 * when the prose is fully grounded.
 */
export function findUnsupportedFigure(text: string, f: NarrativeFacts): string | null {
  const allowed = allowedTokens(f);
  for (const d of text.match(ISO_DATE_RE) ?? []) {
    if (!allowed.has(d)) return d;
  }
  // Strip dates first so 2026 / 10 / 11 are not re-flagged as bare numbers.
  for (const n of text.replace(ISO_DATE_RE, ' ').match(NUMBER_RE) ?? []) {
    if (!allowed.has(n)) return n;
  }
  return null;
}

/** One narrator is enough for prose, so consensus mode uses the first live model. */
function narratorFor(cfg: Config): LlmProvider | null {
  const { live } = providersFor(cfg);
  const candidate = live.find((p) => p.available && typeof p.explainImpact === 'function');
  // The heuristic and mock providers have nothing useful to say in prose.
  if (!candidate || candidate.name === 'heuristic') return null;
  return candidate;
}

/**
 * Produces a narrative for a schedule change. Never throws: any AI failure or
 * any unsupported figure downgrades to the deterministic template.
 */
export async function explainImpact(
  cfg: Config,
  action: string,
  diff: ScheduleDiff,
  before: ScheduleResult | null,
  after: ScheduleResult,
  keyOf: Map<string, string>,
): Promise<Narrative> {
  const facts = factsFrom(action, diff, before, after, keyOf);
  const template = renderTemplate(facts);
  const narrator = narratorFor(cfg);
  if (!narrator?.explainImpact) {
    return { text: template, source: 'template', facts, fallbackReason: null };
  }

  try {
    const text = (await narrator.explainImpact(buildNarrativePrompt(facts))).trim();
    if (text.length === 0) throw new Error('empty response');
    const bad = findUnsupportedFigure(text, facts);
    if (bad !== null) {
      return {
        text: template,
        source: 'template',
        facts,
        fallbackReason:
          `${narrator.name} wrote the unsupported figure "${bad}", ` +
          'which the engine never produced; used the verified template instead',
      };
    }
    return { text, source: narrator.name, facts, fallbackReason: null };
  } catch (error) {
    return {
      text: template,
      source: 'template',
      facts,
      fallbackReason: `${narrator.name} unavailable (${(error as Error).message})`,
    };
  }
}
