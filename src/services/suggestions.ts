/**
 * The AI suggestion workflow.
 *
 * The flow is deliberately three-legged, and the middle leg is the interesting
 * one:
 *
 *   1. ask the models            (non-deterministic, untrusted, best effort)
 *   2. run every suggestion through the engine's gates   (deterministic, final)
 *   3. show the survivors to a human, who accepts or rejects  (authoritative)
 *
 * Nothing the model says becomes a real dependency without steps 2 and 3. Even
 * an accepted suggestion is re-validated inside the write transaction, because
 * the board may have changed between the suggestion being rendered and the
 * reviewer clicking Accept — and a suggestion that was acyclic five minutes ago
 * is not necessarily acyclic now.
 */

import { runConsensus, type ProviderReport } from '../ai/consensus.ts';
import { applyGates, type FilteredSuggestion } from '../ai/gates.ts';
import { PROMPT_VERSION } from '../ai/prompt.ts';
import type { SuggestRequest, SuggestTask } from '../ai/provider.ts';
import type { Config } from '../config.ts';
import type { BoardRow, Repository, SuggestionRow } from '../db/repository.ts';
import { withTransaction } from '../db/db.ts';
import { notFound, validationFailed } from '../errors.ts';
import { addDependencyUnsafe } from './dependencies.ts';
import {
  computeSchedule,
  describeDiff,
  diffSchedules,
  readBoard,
  recomputeBoard,
  toGraph,
} from './board.ts';
import type { MutationResult } from './tasks.ts';

/** Hard cap on the review queue. More than this is noise, not assistance. */
const MAX_SUGGESTIONS = 6;

export interface SuggestionView {
  id: string;
  predecessorId: string;
  successorId: string;
  predecessorKey: string;
  successorKey: string;
  confidence: number;
  rationale: string;
  evidence: string[];
  providers: string[];
  agreement: number;
  /** "2 of 2 models agreed" style label, precomputed for the UI. */
  agreementLabel: string;
  status: SuggestionRow['status'];
  filteredReason: string | null;
  promptVersion: string;
  createdAt: string;
}

export interface SuggestRunResult {
  pending: SuggestionView[];
  /** Suggestions the engine overruled. Shown, not hidden — this is the demo. */
  filtered: SuggestionView[];
  providers: ProviderReport[];
  counts: Record<string, number>;
  degraded: boolean;
  latencyMs: number;
  promptVersion: string;
}

const jsonArray = (raw: string): string[] => {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

function agreementLabel(providers: string[], agreement: number): string {
  if (agreement >= 2) return `${agreement} models agreed (${providers.join(' + ')})`;
  return `${providers[0] ?? 'model'} only`;
}

export function toSuggestionView(row: SuggestionRow, keyOf: Map<string, string>): SuggestionView {
  const providers = jsonArray(row.providers);
  return {
    id: row.id,
    predecessorId: row.predecessor_id,
    successorId: row.successor_id,
    predecessorKey: keyOf.get(row.predecessor_id) ?? row.predecessor_id,
    successorKey: keyOf.get(row.successor_id) ?? row.successor_id,
    confidence: row.confidence,
    rationale: row.rationale,
    evidence: jsonArray(row.evidence),
    providers,
    agreement: row.agreement,
    agreementLabel: agreementLabel(providers, row.agreement),
    status: row.status,
    filteredReason: row.filtered_reason,
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
  };
}

/** Builds the model-facing view of the board. Keys only, never UUIDs. */
export function buildSuggestRequest(repo: Repository, board: BoardRow): SuggestRequest {
  const tasks = repo.listTasks(board.id);
  const deps = repo.listDependencies(board.id);
  const keyOf = new Map(tasks.map((t) => [t.id, t.key] as const));

  const modelTasks: SuggestTask[] = tasks.map((t) => ({
    key: t.key,
    title: t.title,
    description: t.description,
    stage: t.stage,
    durationDays: t.duration_days,
  }));

  return {
    tasks: modelTasks,
    existingEdges: deps.map(
      (d) =>
        [
          keyOf.get(d.predecessor_id) ?? d.predecessor_id,
          keyOf.get(d.successor_id) ?? d.successor_id,
        ] as [string, string],
    ),
    // Telling the model what a human already rejected stops it re-proposing the
    // same thing every run, which is the fastest way to lose a reviewer's trust.
    rejectedPairs: repo
      .rejectedPairs(board.id)
      .map(
        (p) =>
          [
            keyOf.get(p.predecessor_id) ?? p.predecessor_id,
            keyOf.get(p.successor_id) ?? p.successor_id,
          ] as [string, string],
      ),
    maxSuggestions: MAX_SUGGESTIONS,
  };
}

/**
 * Runs a suggestion pass: query the models, gate the results, persist both the
 * survivors and the rejects.
 *
 * Previous undecided suggestions are cleared first. A stale suggestion computed
 * against an older graph is worse than no suggestion, because the reviewer has
 * no way to tell that it is stale.
 */
export async function runSuggestionPass(
  repo: Repository,
  board: BoardRow,
  cfg: Config,
): Promise<SuggestRunResult> {
  const request = buildSuggestRequest(repo, board);
  if (request.tasks.length < 2) {
    throw validationFailed('At least two tasks are needed before dependencies can be suggested.', [
      { path: 'tasks', message: `board has ${request.tasks.length} task(s)` },
    ]);
  }

  const consensus = await runConsensus(cfg, request);

  const tasks = repo.listTasks(board.id);
  const deps = repo.listDependencies(board.id);
  const keyOf = new Map(tasks.map((t) => [t.id, t.key] as const));
  const idByKey = new Map(tasks.map((t) => [t.key, t.id] as const));
  // Evidence is checked against title + description, which is the only text the
  // model was given. Anything else would be checking against unseen data.
  const textByKey = new Map(tasks.map((t) => [t.key, `${t.title}\n${t.description}`] as const));
  const rejectedPairs = new Set(
    repo.rejectedPairs(board.id).map((p) => `${p.predecessor_id}>${p.successor_id}`),
  );

  const gated = applyGates({
    raw: consensus.suggestions,
    graph: toGraph(tasks, deps),
    textByKey,
    idByKey,
    rejectedPairs,
    maxSuggestions: MAX_SUGGESTIONS,
  });

  // Agreement metadata is lost when gates return their own type, so re-attach it.
  const metaByPair = new Map(
    consensus.suggestions.map((s) => [`${s.predecessorKey}>${s.successorKey}`, s] as const),
  );
  const metaFor = (predecessorKey: string, successorKey: string) =>
    metaByPair.get(`${predecessorKey}>${successorKey}`);

  const stored = withTransaction(repo.db, () => {
    repo.clearPendingSuggestions(board.id);

    const pending = gated.accepted.map((s) => {
      const meta = metaFor(s.predecessorKey, s.successorKey);
      return repo.createSuggestion({
        boardId: board.id,
        predecessorId: s.predecessorId,
        successorId: s.successorId,
        confidence: s.confidence,
        rationale: s.rationale,
        evidence: s.evidence,
        providers: meta?.providers ?? ['unknown'],
        agreement: meta?.agreement ?? 1,
        promptVersion: PROMPT_VERSION,
        status: 'PENDING',
      });
    });

    // Rejects are persisted too. "The engine blocked 3 of the model's 7 ideas,
    // and here is exactly why" is the single most convincing thing this app can
    // show, and it has to survive a page refresh to be believable.
    const filtered = gated.filtered
      .filter((f): f is FilteredSuggestion & { predecessorId: string; successorId: string } =>
        Boolean(f.predecessorId && f.successorId),
      )
      .map((f) => {
        const meta = metaFor(f.predecessorKey, f.successorKey);
        return repo.createSuggestion({
          boardId: board.id,
          predecessorId: f.predecessorId,
          successorId: f.successorId,
          confidence: f.confidence,
          rationale: f.rationale,
          evidence: [],
          providers: meta?.providers ?? ['unknown'],
          agreement: meta?.agreement ?? 1,
          promptVersion: PROMPT_VERSION,
          status: 'FILTERED',
          filteredReason: `${f.reason}: ${f.detail}`,
        });
      });

    repo.appendAudit({
      boardId: board.id,
      type: 'ai.suggested',
      summary:
        `AI proposed ${gated.counts.proposed ?? 0} dependencies; ` +
        `engine accepted ${pending.length} for review, filtered ${gated.filtered.length}`,
      payload: {
        counts: gated.counts,
        providers: consensus.reports,
        promptVersion: PROMPT_VERSION,
        filtered: gated.filtered.map((f) => ({
          pair: `${f.predecessorKey}->${f.successorKey}`,
          reason: f.reason,
        })),
      },
      actor: 'ai',
    });

    return { pending, filtered };
  });

  // Hallucinated keys have no UUID, so they cannot be stored against a task.
  // They still belong in the response: a model inventing TF-99 is exactly the
  // failure mode the allowlist exists to stop.
  const unstorable: SuggestionView[] = gated.filtered
    .filter((f) => !f.predecessorId || !f.successorId)
    .map((f, i) => ({
      id: `unstored-${i}`,
      predecessorId: f.predecessorId ?? '',
      successorId: f.successorId ?? '',
      predecessorKey: f.predecessorKey,
      successorKey: f.successorKey,
      confidence: f.confidence,
      rationale: f.rationale,
      evidence: [],
      providers: metaFor(f.predecessorKey, f.successorKey)?.providers ?? [],
      agreement: 0,
      agreementLabel: 'not stored',
      status: 'FILTERED',
      filteredReason: `${f.reason}: ${f.detail}`,
      promptVersion: PROMPT_VERSION,
      createdAt: new Date().toISOString(),
    }));

  return {
    pending: stored.pending.map((r) => toSuggestionView(r, keyOf)),
    filtered: [...stored.filtered.map((r) => toSuggestionView(r, keyOf)), ...unstorable],
    providers: consensus.reports,
    counts: gated.counts,
    degraded: consensus.degraded,
    latencyMs: consensus.latencyMs,
    promptVersion: PROMPT_VERSION,
  };
}

export function listSuggestions(repo: Repository, board: BoardRow): SuggestRunResult {
  const keyOf = new Map(repo.listTasks(board.id).map((t) => [t.id, t.key] as const));
  const rows = repo.listSuggestions(board.id, ['PENDING', 'FILTERED']);
  const views = rows.map((r) => toSuggestionView(r, keyOf));
  return {
    pending: views.filter((v) => v.status === 'PENDING'),
    filtered: views.filter((v) => v.status === 'FILTERED'),
    providers: [],
    counts: {},
    degraded: false,
    latencyMs: 0,
    promptVersion: PROMPT_VERSION,
  };
}

/**
 * Accepts a suggestion: re-validate, then insert as a real dependency.
 *
 * The re-validation is the point. `addDependencyUnsafe` runs the same cycle and
 * duplicate checks a manual edge gets, inside the same `BEGIN IMMEDIATE`
 * transaction, so an accepted suggestion that has since become circular is
 * rejected with the same error a human would have seen — and the suggestion is
 * left PENDING rather than being marked accepted.
 */
export function acceptSuggestion(
  repo: Repository,
  board: BoardRow,
  suggestionId: string,
): MutationResult {
  return withTransaction(repo.db, () => {
    const suggestion = repo.getSuggestion(suggestionId);
    if (!suggestion || suggestion.board_id !== board.id) {
      throw notFound(`Suggestion ${suggestionId}`);
    }
    if (suggestion.status !== 'PENDING') {
      throw validationFailed(`This suggestion was already ${suggestion.status.toLowerCase()}.`, [
        { path: 'status', message: suggestion.status },
      ]);
    }

    const before = computeSchedule(repo, board);

    // Same validation path as a manual edge. No privileged insert for AI.
    const redundancy = addDependencyUnsafe(repo, board, {
      predecessorId: suggestion.predecessor_id,
      successorId: suggestion.successor_id,
      lagDays: 0,
      origin: 'AI_ACCEPTED',
      suggestedBy: jsonArray(suggestion.providers).join('+') || 'ai',
    });

    repo.decideSuggestion(suggestionId, 'ACCEPTED');
    const after = recomputeBoard(repo, board);
    const diff = diffSchedules(before, after);

    const keyOf = new Map(repo.listTasks(board.id).map((t) => [t.id, t.key] as const));
    const label = `${keyOf.get(suggestion.predecessor_id)} -> ${keyOf.get(suggestion.successor_id)}`;
    const summary = `Accepted AI suggestion ${label}`;

    repo.appendAudit({
      boardId: board.id,
      type: 'ai.accepted',
      summary,
      payload: {
        suggestionId,
        providers: jsonArray(suggestion.providers),
        agreement: suggestion.agreement,
        confidence: suggestion.confidence,
        promptVersion: suggestion.prompt_version,
        diff,
      },
    });

    return {
      board: readBoard(repo, board),
      diff,
      summary: `${summary}. ${describeDiff(diff, keyOf)}`,
      warnings: redundancy ? [redundancy] : [],
    };
  });
}

/**
 * Rejects a suggestion. The pair is remembered and fed into future prompts, so
 * the same idea is not proposed again — and the gate blocks it even if it is.
 */
export function rejectSuggestion(
  repo: Repository,
  board: BoardRow,
  suggestionId: string,
): { suggestion: SuggestionView; summary: string } {
  return withTransaction(repo.db, () => {
    const suggestion = repo.getSuggestion(suggestionId);
    if (!suggestion || suggestion.board_id !== board.id) {
      throw notFound(`Suggestion ${suggestionId}`);
    }
    repo.decideSuggestion(suggestionId, 'REJECTED');

    const keyOf = new Map(repo.listTasks(board.id).map((t) => [t.id, t.key] as const));
    const label = `${keyOf.get(suggestion.predecessor_id)} -> ${keyOf.get(suggestion.successor_id)}`;
    const summary = `Rejected AI suggestion ${label}; it will not be proposed again`;

    repo.appendAudit({
      boardId: board.id,
      type: 'ai.rejected',
      summary,
      payload: { suggestionId, confidence: suggestion.confidence },
    });

    return {
      suggestion: toSuggestionView(repo.getSuggestion(suggestionId)!, keyOf),
      summary,
    };
  });
}
