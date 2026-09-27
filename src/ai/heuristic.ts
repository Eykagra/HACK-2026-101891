/**
 * Deterministic, offline suggester.
 *
 * This is not a toy fallback, it is a load-bearing part of the design:
 *
 *   * The app stays fully usable with no API key, so a reviewer who clones the
 *     repo and runs it without credentials still sees the whole feature work.
 *   * It is the published baseline in the evaluation table. "Our LLM scores
 *     0.8 precision" is meaningless without knowing what keyword matching
 *     scores on the same fixture.
 *   * Being deterministic and network-free, it makes the suggestion path
 *     testable in CI.
 *
 * The model is a delivery-phase lexicon (schema -> api -> ui -> tests -> deploy)
 * combined with lexical overlap between task texts. It knows nothing about
 * semantics, which is exactly why it is a fair baseline.
 */

import type { LlmProvider, RawSuggestion, SuggestRequest, SuggestTask } from './provider.ts';

interface Phase {
  name: string;
  rank: number;
  terms: string[];
}

const PHASES: Phase[] = [
  { name: 'data', rank: 0, terms: ['schema', 'migration', 'database', 'data model', 'table'] },
  {
    name: 'platform',
    rank: 1,
    terms: ['ci/cd', 'pipeline', 'infrastructure', 'scaffold', 'setup'],
  },
  { name: 'service', rank: 2, terms: ['api', 'endpoint', 'backend', 'auth', 'service', 'server'] },
  { name: 'client', rank: 3, terms: ['ui', 'frontend', 'kanban', 'board', 'screen', 'component'] },
  { name: 'verify', rank: 4, terms: ['test', 'integration', 'qa', 'load', 'performance', 'audit'] },
  { name: 'release', rank: 5, terms: ['deploy', 'release', 'launch', 'production', 'rollout'] },
];

const STOPWORDS = new Set(
  (
    'the a an and or of for to in on with that this it its into from be is are as by using ' +
    'every each all any not no than then when which who whom whose where what will would can ' +
    'could should may might must task tasks work needs need requires required including plus'
  ).split(' '),
);

function textOf(task: SuggestTask): string {
  return `${task.title} ${task.description}`.toLowerCase();
}

function phaseOf(task: SuggestTask): Phase | null {
  const text = textOf(task);
  let best: Phase | null = null;
  let bestHits = 0;
  for (const phase of PHASES) {
    const hits = phase.terms.filter((term) => text.includes(term)).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = phase;
    }
  }
  return best;
}

function tokens(task: SuggestTask): Set<string> {
  return new Set(
    textOf(task)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w)),
  );
}

/** Longest shared phrase, used as verbatim evidence so the gate can verify it. */
function sharedPhrase(a: SuggestTask, b: SuggestTask): string {
  const aTokens = [...tokens(a)];
  const bText = textOf(b);
  const hit = aTokens.find((token) => bText.includes(token));
  if (!hit) return '';
  const source = `${a.title} ${a.description}`;
  const index = source.toLowerCase().indexOf(hit);
  if (index < 0) return '';
  // Trim to a word boundary. A quote cut mid-word ("plus a secr") reads like a
  // bug even when the evidence behind it is sound.
  const window = source.slice(index, Math.min(source.length, index + 60));
  const cut = window.length < 60 ? window : window.slice(0, window.lastIndexOf(' '));
  return cut.replace(/[\s,.;:]+$/, '').trim();
}

export class HeuristicProvider implements LlmProvider {
  readonly name = 'heuristic';
  readonly model = 'phase-lexicon@1';
  readonly available = true;

  async suggestDependencies(request: SuggestRequest): Promise<RawSuggestion[]> {
    const existing = new Set(request.existingEdges.map(([p, s]) => `${p}>${s}`));
    const rejected = new Set(request.rejectedPairs.map(([p, s]) => `${p}>${s}`));
    const out: RawSuggestion[] = [];

    for (const predecessor of request.tasks) {
      for (const successor of request.tasks) {
        if (predecessor.key === successor.key) continue;
        const pair = `${predecessor.key}>${successor.key}`;
        if (existing.has(pair) || rejected.has(pair)) continue;

        const pPhase = phaseOf(predecessor);
        const sPhase = phaseOf(successor);
        if (!pPhase || !sPhase || pPhase.rank >= sPhase.rank) continue;

        const shared = [...tokens(predecessor)].filter((t) => tokens(successor).has(t));
        if (shared.length === 0) continue;

        const phaseGap = sPhase.rank - pPhase.rank;
        // Adjacent phases with strong lexical overlap score highest; distant
        // phases are usually already covered transitively.
        const confidence = Math.min(
          0.88,
          0.42 + shared.length * 0.08 + (phaseGap === 1 ? 0.18 : 0.04),
        );
        const evidencePredecessor = sharedPhrase(predecessor, successor);
        const evidenceSuccessor = sharedPhrase(successor, predecessor);

        out.push({
          predecessorKey: predecessor.key,
          successorKey: successor.key,
          confidence: Number(confidence.toFixed(2)),
          rationale:
            `"${predecessor.title}" is ${pPhase.name}-phase work and "${successor.title}" is ` +
            `${sPhase.name}-phase work; they share: ${shared.slice(0, 3).join(', ')}.`,
          evidence: { predecessor: evidencePredecessor, successor: evidenceSuccessor },
        });
      }
    }

    return out
      .sort(
        (a, b) => b.confidence - a.confidence || a.predecessorKey.localeCompare(b.predecessorKey),
      )
      .slice(0, request.maxSuggestions * 2);
  }
}
