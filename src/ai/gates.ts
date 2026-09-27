/**
 * "The AI proposes, the engine disposes."
 *
 * Seven deterministic gates run between a model's raw output and anything a
 * human is shown, and a human approval gate runs between that and anything the
 * database stores as a real dependency. A suggestion the engine rejects is not
 * discarded silently: it is kept with its reason and surfaced in the UI, because
 * showing the engine overrule the model is the clearest possible demonstration
 * of where authority actually sits.
 */

import { validateAddEdge, type Graph, type TaskId } from '../engine/index.ts';
import { arrayOf, num, object, parse, str, type Issue } from '../validate.ts';
import type { RawSuggestion } from './provider.ts';

export const MIN_CONFIDENCE = 0.55;

export const rawSuggestionCheck = object({
  predecessorKey: str({ min: 1, max: 40 }),
  successorKey: str({ min: 1, max: 40 }),
  confidence: num({ min: 0, max: 1 }),
  rationale: str({ min: 1, max: 400 }),
  evidence: object({
    predecessor: str({ min: 0, max: 400 }),
    successor: str({ min: 0, max: 400 }),
  }),
});

export const providerPayloadCheck = object({
  suggestions: arrayOf(rawSuggestionCheck, { max: 32 }),
});

/** Parse and shape-check a provider payload. Gate 1. */
export function parseProviderPayload(
  value: unknown,
): { ok: true; value: RawSuggestion[] } | { ok: false; issues: Issue[] } {
  const parsed = parse(providerPayloadCheck, value);
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value.suggestions as RawSuggestion[] };
}

export type FilterReason =
  | 'UNKNOWN_TASK'
  | 'SELF_EDGE'
  | 'DUPLICATE'
  | 'REDUNDANT'
  | 'CYCLE'
  | 'PREVIOUSLY_REJECTED'
  | 'UNVERIFIED_EVIDENCE'
  | 'LOW_CONFIDENCE';

export interface GateInput {
  raw: RawSuggestion[];
  graph: Graph;
  /** Task text keyed by task key, for verbatim evidence verification. */
  textByKey: Map<string, string>;
  idByKey: Map<string, TaskId>;
  rejectedPairs: Set<string>;
  maxSuggestions: number;
  minConfidence?: number;
}

export interface GatedSuggestion {
  predecessorId: TaskId;
  successorId: TaskId;
  predecessorKey: string;
  successorKey: string;
  confidence: number;
  rationale: string;
  evidence: string[];
}

export interface FilteredSuggestion {
  predecessorKey: string;
  successorKey: string;
  predecessorId: TaskId | null;
  successorId: TaskId | null;
  confidence: number;
  rationale: string;
  reason: FilterReason;
  /** Human-readable explanation, including the cycle path when relevant. */
  detail: string;
}

export interface GateOutput {
  accepted: GatedSuggestion[];
  filtered: FilteredSuggestion[];
  counts: Record<string, number>;
}

/** Normalise for comparison: models vary punctuation and whitespace. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

/**
 * Gate 3. The model claimed this span appears in the task's own text; check it.
 *
 * A short quote could be coincidental, so spans under 12 normalised characters
 * are not treated as evidence either way. The purpose is to catch confidently
 * fabricated justifications, not to police phrasing.
 */
function evidenceVerified(span: string, taskText: string | undefined): boolean {
  if (!taskText) return false;
  const needle = normalise(span);
  if (needle.length < 12) return true;
  return normalise(taskText).includes(needle);
}

export function applyGates(input: GateInput): GateOutput {
  const minConfidence = input.minConfidence ?? MIN_CONFIDENCE;
  const accepted: GatedSuggestion[] = [];
  const filtered: FilteredSuggestion[] = [];
  const counts: Record<string, number> = { proposed: input.raw.length };
  const bump = (reason: string) => (counts[reason] = (counts[reason] ?? 0) + 1);

  // The graph grows as suggestions are accepted, so two proposals that are
  // individually fine but jointly circular cannot both get through.
  let workingGraph: Graph = { tasks: input.graph.tasks, edges: [...input.graph.edges] };
  const seen = new Set<string>();
  const keyOf = new Map(input.graph.tasks.map((t) => [t.id, t.key] as const));

  const sorted = [...input.raw].sort((a, b) => b.confidence - a.confidence);

  for (const raw of sorted) {
    const predecessorId = input.idByKey.get(raw.predecessorKey) ?? null;
    const successorId = input.idByKey.get(raw.successorKey) ?? null;
    const base = {
      predecessorKey: raw.predecessorKey,
      successorKey: raw.successorKey,
      predecessorId,
      successorId,
      confidence: raw.confidence,
      rationale: raw.rationale,
    };

    // ---- Gate 2: closed-world allowlist ----------------------------------
    if (!predecessorId || !successorId) {
      bump('unknown_task');
      filtered.push({
        ...base,
        reason: 'UNKNOWN_TASK',
        detail: `Referenced a task that does not exist on this board (${
          !predecessorId ? raw.predecessorKey : raw.successorKey
        }). Hallucinated keys can never reach the database.`,
      });
      continue;
    }

    const pairKey = `${predecessorId}>${successorId}`;
    if (seen.has(pairKey)) {
      bump('duplicate');
      continue;
    }
    seen.add(pairKey);

    // ---- Gate 7a: confidence floor ---------------------------------------
    if (raw.confidence < minConfidence) {
      bump('low_confidence');
      filtered.push({
        ...base,
        reason: 'LOW_CONFIDENCE',
        detail: `Confidence ${raw.confidence.toFixed(2)} is below the ${minConfidence} threshold.`,
      });
      continue;
    }

    // ---- Gate 6: a human already said no ---------------------------------
    if (input.rejectedPairs.has(pairKey)) {
      bump('previously_rejected');
      filtered.push({
        ...base,
        reason: 'PREVIOUSLY_REJECTED',
        detail: 'A reviewer already rejected this pair.',
      });
      continue;
    }

    // ---- Gate 3: verbatim evidence ---------------------------------------
    const predecessorOk = evidenceVerified(
      raw.evidence.predecessor,
      input.textByKey.get(raw.predecessorKey),
    );
    const successorOk = evidenceVerified(
      raw.evidence.successor,
      input.textByKey.get(raw.successorKey),
    );
    if (!predecessorOk || !successorOk) {
      bump('unverified_evidence');
      filtered.push({
        ...base,
        reason: 'UNVERIFIED_EVIDENCE',
        detail:
          'The quoted evidence does not appear in the task text, so the justification could not be verified.',
      });
      continue;
    }

    // ---- Gates 4 and 5: the engine has the final word --------------------
    //
    // Two graphs are checked here, on purpose.
    //
    // *Cycles* are checked against `workingGraph`, which includes suggestions
    // already accepted in this pass. Two proposals can each be acyclic alone
    // yet circular together, and offering a reviewer a set that self-destructs
    // if they approve all of it would be a trap.
    //
    // *Redundancy* is checked against the committed graph only. Telling someone
    // "already implied by A -> B -> C" when B -> C is itself an unapproved
    // suggestion on the same screen would be a claim about a fact that does not
    // exist yet, and it would become false the moment they rejected it.
    const verdict = validateAddEdge(workingGraph, { predecessorId, successorId, lagDays: 0 });
    if (verdict.kind === 'REJECTED') {
      bump(verdict.code.toLowerCase());
      filtered.push({
        ...base,
        reason: verdict.code === 'CYCLE' ? 'CYCLE' : verdict.code,
        detail: verdict.message,
      });
      continue;
    }

    const committed = validateAddEdge(input.graph, { predecessorId, successorId, lagDays: 0 });
    if (committed.kind === 'OK' && committed.redundantVia) {
      bump('redundant');
      filtered.push({
        ...base,
        reason: 'REDUNDANT',
        detail: `Already implied by the existing path ${committed.redundantVia
          .map((id) => keyOf.get(id) ?? id)
          .join(' -> ')}.`,
      });
      continue;
    }

    accepted.push({
      predecessorId,
      successorId,
      predecessorKey: raw.predecessorKey,
      successorKey: raw.successorKey,
      confidence: raw.confidence,
      rationale: raw.rationale,
      evidence: [raw.evidence.predecessor, raw.evidence.successor].filter(Boolean),
    });
    workingGraph = {
      tasks: workingGraph.tasks,
      edges: [...workingGraph.edges, { predecessorId, successorId, lagDays: 0 }],
    };

    // ---- Gate 7b: cap the review queue -----------------------------------
    if (accepted.length >= input.maxSuggestions) break;
  }

  counts.accepted = accepted.length;
  counts.filtered = filtered.length;
  return { accepted, filtered, counts };
}
