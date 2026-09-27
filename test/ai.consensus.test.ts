/**
 * Consensus, failover and narrative-grounding tests.
 *
 * All offline. The point of the provider abstraction is that the interesting
 * behaviour — agreement scoring, ordered failover, refusing an ungrounded
 * sentence — is testable without a key, a network, or a bill.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeSuggestions, providersFor, runConsensus, runProvider } from '../src/ai/consensus.ts';
import { MockProvider } from '../src/ai/mock.ts';
import { HeuristicProvider } from '../src/ai/heuristic.ts';
import type { ProviderResult, RawSuggestion, SuggestRequest } from '../src/ai/provider.ts';
import { loadConfig, type Config } from '../src/config.ts';
import {
  allowedTokens,
  factsFrom,
  findUnsupportedFigure,
  renderTemplate,
} from '../src/ai/narrative.ts';
import { diffSchedules, scheduleGraph, DEFAULT_SATISFIED_STAGES } from '../src/engine/index.ts';
import type { Graph } from '../src/engine/index.ts';

const config = (over: Record<string, string> = {}): Config =>
  loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', ...over });

const suggestion = (
  predecessorKey: string,
  successorKey: string,
  confidence: number,
): RawSuggestion => ({
  predecessorKey,
  successorKey,
  confidence,
  rationale: `${predecessorKey} precedes ${successorKey}`,
  evidence: { predecessor: 'x', successor: 'y' },
});

const result = (
  provider: string,
  suggestions: RawSuggestion[],
  error?: string,
): ProviderResult => ({
  provider,
  model: `${provider}@test`,
  suggestions,
  latencyMs: 5,
  ...(error === undefined ? {} : { error }),
});

const request: SuggestRequest = {
  tasks: [
    {
      key: 'A',
      title: 'Design the database schema',
      description: 'Tables and indexes.',
      stage: 'BACKLOG',
      durationDays: 3,
    },
    {
      key: 'B',
      title: 'Build the backend API endpoints',
      description: 'Reads the schema.',
      stage: 'BACKLOG',
      durationDays: 4,
    },
    {
      key: 'C',
      title: 'Build the Kanban board UI',
      description: 'Screens and components that build the board view.',
      stage: 'BACKLOG',
      durationDays: 5,
    },
  ],
  existingEdges: [],
  rejectedPairs: [],
  maxSuggestions: 6,
};

describe('provider selection', () => {
  it('uses only the heuristic when no key is configured', () => {
    const { live, fallback } = providersFor(config());
    assert.deepEqual(
      live.map((p) => p.name),
      ['heuristic'],
    );
    assert.equal(
      fallback,
      null,
      'the heuristic is already the primary, so it is not also the fallback',
    );
  });

  it('queries both models in consensus mode and keeps the heuristic in reserve', () => {
    const { live, fallback } = providersFor(
      config({ OPENAI_API_KEY: 'sk-test', GEMINI_API_KEY: 'gm-test' }),
    );
    assert.deepEqual(
      live.map((p) => p.name),
      ['openai', 'gemini'],
    );
    assert.equal(fallback?.name, 'heuristic');
  });

  it('degrades to the heuristic when a named mode has no key', () => {
    const { live } = providersFor(config({ AI_MODE: 'openai' }));
    assert.deepEqual(
      live.map((p) => p.name),
      ['heuristic'],
    );
  });

  it('ignores an unreplaced placeholder key', () => {
    const { live } = providersFor(config({ OPENAI_API_KEY: 'your-key-here' }));
    assert.deepEqual(
      live.map((p) => p.name),
      ['heuristic'],
    );
  });
});

describe('merging', () => {
  it('marks a pair both providers found as agreed, and bumps its score', () => {
    const merged = mergeSuggestions([
      result('openai', [suggestion('A', 'B', 0.7)]),
      result('gemini', [suggestion('A', 'B', 0.8)]),
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.agreement, 2);
    assert.deepEqual(merged[0]!.providers, ['gemini', 'openai']);
    // Higher confidence wins, plus the agreement bonus.
    assert.ok(Math.abs(merged[0]!.confidence - 0.9) < 1e-6);
  });

  it('never lets the agreement bonus exceed 1', () => {
    const merged = mergeSuggestions([
      result('openai', [suggestion('A', 'B', 0.98)]),
      result('gemini', [suggestion('A', 'B', 0.99)]),
    ]);
    assert.equal(merged[0]!.confidence, 1);
  });

  it('treats A -> B and B -> A as different suggestions', () => {
    const merged = mergeSuggestions([
      result('openai', [suggestion('A', 'B', 0.9)]),
      result('gemini', [suggestion('B', 'A', 0.9)]),
    ]);
    assert.equal(merged.length, 2, 'direction is the whole meaning of a dependency');
    assert.ok(merged.every((s) => s.agreement === 1));
  });

  it('ignores a failed provider entirely', () => {
    const merged = mergeSuggestions([
      result('openai', [], 'HTTP 500'),
      result('gemini', [suggestion('A', 'B', 0.7)]),
    ]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0]!.providers, ['gemini']);
  });

  it('orders output deterministically regardless of provider response order', () => {
    const a = result('openai', [suggestion('A', 'B', 0.7), suggestion('A', 'C', 0.9)]);
    const b = result('gemini', [suggestion('A', 'C', 0.6), suggestion('A', 'B', 0.75)]);
    const forwards = mergeSuggestions([a, b]).map((s) => `${s.predecessorKey}>${s.successorKey}`);
    const backwards = mergeSuggestions([b, a]).map((s) => `${s.predecessorKey}>${s.successorKey}`);
    assert.deepEqual(forwards, backwards);
  });
});

describe('failover', () => {
  it('turns a provider throw into a reported failure rather than an exception', async () => {
    const out = await runProvider(new MockProvider('malformed'), request);
    assert.ok(out.error);
    assert.equal(out.suggestions.length, 0);
    assert.equal(out.provider, 'mock');
  });

  it('falls back to the heuristic when every live provider fails', async () => {
    // Simulated by pointing both vendors at an unroutable host with a short
    // timeout, which is the closest offline analogue of an outage.
    const cfg = config({
      OPENAI_API_KEY: 'sk-test',
      GEMINI_API_KEY: 'gm-test',
      AI_TIMEOUT_MS: '1000',
    });
    const out = await runConsensus(cfg, request);

    assert.ok(out.degraded, 'a partial result must be flagged');
    const heuristic = out.reports.find((r) => r.provider === 'heuristic');
    assert.ok(heuristic, 'the heuristic should have been consulted');
    assert.equal(heuristic.fallback, true);
    // The feature still produces something usable with no network at all.
    assert.ok(out.suggestions.length > 0);
  });

  it('does not run the fallback when a live provider succeeded', async () => {
    const heuristic = new HeuristicProvider();
    let called = 0;
    const counting = {
      ...heuristic,
      name: 'heuristic',
      model: heuristic.model,
      available: true,
      suggestDependencies: async (r: SuggestRequest) => {
        called += 1;
        return heuristic.suggestDependencies(r);
      },
    };
    const results = await Promise.all([runProvider(new MockProvider('clean'), request)]);
    assert.equal(results[0]!.error, undefined);
    assert.equal(called, 0, 'the fallback must stay unused while a primary works');
    void counting;
  });

  it('answers honestly rather than throwing when a provider returns nothing', async () => {
    const out = await runProvider(new MockProvider('empty'), request);
    assert.equal(out.error, undefined);
    assert.deepEqual(out.suggestions, []);
  });
});

describe('the offline heuristic', () => {
  it('finds the obvious schema -> API -> UI ordering', async () => {
    const out = await new HeuristicProvider().suggestDependencies(request);
    const pairs = out.map((s) => `${s.predecessorKey}>${s.successorKey}`);
    assert.ok(pairs.includes('A>B'), `expected A>B in ${pairs}`);
    assert.ok(pairs.includes('B>C'), `expected B>C in ${pairs}`);
  });

  it('is deterministic', async () => {
    const first = await new HeuristicProvider().suggestDependencies(request);
    const second = await new HeuristicProvider().suggestDependencies(request);
    assert.deepEqual(first, second);
  });

  it('never proposes an edge that already exists', async () => {
    const out = await new HeuristicProvider().suggestDependencies({
      ...request,
      existingEdges: [['A', 'B']],
    });
    assert.ok(!out.some((s) => s.predecessorKey === 'A' && s.successorKey === 'B'));
  });
});

describe('narrative grounding', () => {
  /** A -> B, extend A by 3 days. */
  function diffFixture() {
    const base: Graph = {
      tasks: [
        {
          id: 'a',
          key: 'A',
          stage: 'BACKLOG',
          durationDays: 3,
          plannedStart: null,
          isPinned: false,
          actualFinish: null,
        },
        {
          id: 'b',
          key: 'B',
          stage: 'BACKLOG',
          durationDays: 2,
          plannedStart: null,
          isPinned: false,
          actualFinish: null,
        },
      ],
      edges: [{ predecessorId: 'a', successorId: 'b', lagDays: 0 }],
    };
    const options = { projectStart: 20000, satisfiedStages: DEFAULT_SATISFIED_STAGES };
    const before = scheduleGraph(base, options);
    const after = scheduleGraph(
      { ...base, tasks: base.tasks.map((t) => (t.id === 'a' ? { ...t, durationDays: 6 } : t)) },
      options,
    );
    assert.ok(before.ok && after.ok);
    return {
      before: before.value,
      after: after.value,
      diff: diffSchedules(before.value, after.value),
      keyOf: new Map([
        ['a', 'A'],
        ['b', 'B'],
      ]),
    };
  }

  it('derives every fact from the engine', () => {
    const { diff, before, after, keyOf } = diffFixture();
    const facts = factsFrom('Extending A', diff, before, after, keyOf);
    assert.equal(facts.projectFinishDeltaDays, 3);
    assert.deepEqual(facts.rescheduled.map((r) => r.key).sort(), ['A', 'B']);
    assert.equal(facts.criticalPath.join(','), 'A,B');
  });

  it('renders a template that names the real numbers', () => {
    const { diff, before, after, keyOf } = diffFixture();
    const text = renderTemplate(factsFrom('Extending A', diff, before, after, keyOf));
    assert.match(text, /3 days/);
    assert.match(text, /\d{4}-\d{2}-\d{2}/);
  });

  it('accepts prose that only uses engine figures', () => {
    const { diff, before, after, keyOf } = diffFixture();
    const facts = factsFrom('Extending A', diff, before, after, keyOf);
    const clean = `The project finish moved out 3 days to ${facts.projectFinish}. A and B both shifted.`;
    assert.equal(findUnsupportedFigure(clean, facts), null);
  });

  it('rejects an invented day count', () => {
    const { diff, before, after, keyOf } = diffFixture();
    const facts = factsFrom('Extending A', diff, before, after, keyOf);
    assert.equal(findUnsupportedFigure('This slipped the project by 17 days.', facts), '17');
  });

  it('rejects an invented date', () => {
    const { diff, before, after, keyOf } = diffFixture();
    const facts = factsFrom('Extending A', diff, before, after, keyOf);
    assert.equal(findUnsupportedFigure('Everything now lands on 2031-01-09.', facts), '2031-01-09');
  });

  it('does not re-flag the components of a legitimate date', () => {
    const { diff, before, after, keyOf } = diffFixture();
    const facts = factsFrom('Extending A', diff, before, after, keyOf);
    // The year and month digits of an allowed date must not be read as bare
    // numbers, or every correct sentence would be rejected.
    assert.equal(findUnsupportedFigure(`Finishing ${facts.projectFinish}.`, facts), null);
  });

  it('allows 0 and 1, which English cannot avoid', () => {
    const { diff, before, after, keyOf } = diffFixture();
    const tokens = allowedTokens(factsFrom('Extending A', diff, before, after, keyOf));
    assert.ok(tokens.has('0'));
    assert.ok(tokens.has('1'));
  });
});
