/**
 * Fixture-driven provider for tests.
 *
 * The fixtures are chosen to be hostile on purpose. Every one of them is a real
 * failure mode of a real model, and each has a corresponding gate:
 *
 *   * a hallucinated task key            -> allowlist gate
 *   * a cycle-creating edge              -> engine gate
 *   * a reversed / already-existing edge -> duplicate gate
 *   * fabricated evidence                -> verbatim evidence gate
 *   * an over-confident weak guess       -> confidence gate
 *   * malformed JSON / a thrown error    -> failover to the next provider
 *
 * A mock that only returns good data proves nothing.
 */

import type { LlmProvider, RawSuggestion, SuggestRequest } from './provider.ts';

export type MockScenario = 'clean' | 'hostile' | 'malformed' | 'empty' | 'timeout';

export class MockProvider implements LlmProvider {
  readonly name: string;
  readonly model = 'mock@1';
  readonly available = true;
  private readonly scenario: MockScenario;
  private readonly override: RawSuggestion[] | null;
  calls = 0;

  constructor(
    scenario: MockScenario = 'clean',
    opts: { name?: string; suggestions?: RawSuggestion[] } = {},
  ) {
    this.scenario = scenario;
    this.name = opts.name ?? 'mock';
    this.override = opts.suggestions ?? null;
  }

  async suggestDependencies(request: SuggestRequest): Promise<RawSuggestion[]> {
    this.calls += 1;
    if (this.override) return this.override;

    switch (this.scenario) {
      case 'malformed':
        throw new Error('mock returned output that is not valid JSON');
      case 'timeout':
        throw new Error('mock request timed out after 1ms');
      case 'empty':
        return [];
      case 'hostile':
        return hostileFixtures(request);
      case 'clean':
      default:
        return cleanFixtures(request);
    }
  }

  async explainImpact(): Promise<string> {
    return 'Extending TF-3 by 3 days pushes 4 tasks out by 3 days.';
  }
}

function quote(request: SuggestRequest, key: string, words = 6): string {
  const task = request.tasks.find((t) => t.key === key);
  if (!task) return 'no such task';
  return `${task.title} ${task.description}`.split(/\s+/).slice(0, words).join(' ');
}

/** One legitimate, verifiable suggestion: the edge the seed deliberately omits. */
function cleanFixtures(request: SuggestRequest): RawSuggestion[] {
  return [
    {
      predecessorKey: 'TF-4',
      successorKey: 'TF-5',
      confidence: 0.82,
      rationale: 'The Kanban UI renders the signed-in user, so it needs the auth service first.',
      evidence: { predecessor: quote(request, 'TF-4'), successor: quote(request, 'TF-5') },
    },
  ];
}

function hostileFixtures(request: SuggestRequest): RawSuggestion[] {
  return [
    ...cleanFixtures(request),
    {
      // Gate 2: this task does not exist.
      predecessorKey: 'TF-999',
      successorKey: 'TF-5',
      confidence: 0.95,
      rationale: 'Confidently references a task that was never on the board.',
      evidence: { predecessor: 'invented', successor: quote(request, 'TF-5') },
    },
    {
      // Gate 5: TF-1 -> ... -> TF-10 already exists, so this closes a cycle.
      predecessorKey: 'TF-10',
      successorKey: 'TF-1',
      confidence: 0.91,
      rationale: 'Deploying seems like a prerequisite for schema design.',
      evidence: { predecessor: quote(request, 'TF-10'), successor: quote(request, 'TF-1') },
    },
    {
      // Gate 4: already exists in the seed.
      predecessorKey: 'TF-1',
      successorKey: 'TF-3',
      confidence: 0.88,
      rationale: 'Re-proposes an edge that is already on the board.',
      evidence: { predecessor: quote(request, 'TF-1'), successor: quote(request, 'TF-3') },
    },
    {
      // Gate 3: the quoted evidence appears nowhere in the task text.
      predecessorKey: 'TF-2',
      successorKey: 'TF-6',
      confidence: 0.79,
      rationale: 'Cites a sentence that does not exist anywhere in either task.',
      evidence: {
        predecessor: 'this task explicitly blocks the notification service rollout',
        successor: 'cannot begin until the continuous delivery pipeline is verified',
      },
    },
    {
      // Gate 7a: honest but weak.
      predecessorKey: 'TF-6',
      successorKey: 'TF-8',
      confidence: 0.21,
      rationale: 'A guess based on both touching infrastructure.',
      evidence: { predecessor: quote(request, 'TF-6'), successor: quote(request, 'TF-8') },
    },
  ];
}
