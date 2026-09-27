/**
 * Gate tests.
 *
 * Each test corresponds to one real model failure mode. Together they are the
 * evidence behind the claim "the AI cannot corrupt the graph": not that the
 * model is reliable, but that every way it could be wrong is intercepted by
 * deterministic code with a named reason.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyGates, MIN_CONFIDENCE, parseProviderPayload } from '../src/ai/gates.ts';
import type { RawSuggestion } from '../src/ai/provider.ts';
import type { Graph, TaskInput } from '../src/engine/index.ts';

const task = (key: string): TaskInput => ({
  id: `id-${key}`,
  key,
  stage: 'BACKLOG',
  durationDays: 3,
  plannedStart: null,
  isPinned: false,
  actualFinish: null,
});

/** A -> B -> C, plus an unrelated D. */
function fixture() {
  const tasks = ['A', 'B', 'C', 'D'].map(task);
  const graph: Graph = {
    tasks,
    edges: [
      { predecessorId: 'id-A', successorId: 'id-B', lagDays: 0 },
      { predecessorId: 'id-B', successorId: 'id-C', lagDays: 0 },
    ],
  };
  return {
    graph,
    input: {
      graph,
      textByKey: TEXT,
      idByKey: new Map(tasks.map((t) => [t.key, t.id])),
      rejectedPairs: new Set<string>(),
      maxSuggestions: 10,
    },
  };
}

const TEXT = new Map([
  ['A', 'Design the schema. Defines the tables every later task reads.'],
  ['B', 'Build the API. Reads the tables defined by the schema.'],
  ['C', 'Build the UI. Calls the API endpoints.'],
  ['D', 'Write the launch blog post. Independent of the build.'],
]);

/**
 * Builds a suggestion whose evidence is *genuinely* quoted from the fixture, so
 * a test about the cycle gate is not accidentally caught by the evidence gate
 * first. Tests that want fabricated evidence override it explicitly.
 */
function suggestion(overrides: Partial<RawSuggestion> = {}): RawSuggestion {
  const predecessorKey = overrides.predecessorKey ?? 'A';
  const successorKey = overrides.successorKey ?? 'D';
  return {
    predecessorKey,
    successorKey,
    confidence: 0.9,
    rationale: 'Plausible-sounding reason.',
    evidence: {
      predecessor: TEXT.get(predecessorKey) ?? 'unknown',
      successor: TEXT.get(successorKey) ?? 'unknown',
    },
    ...overrides,
  };
}

describe('payload parsing (gate 1)', () => {
  it('rejects a payload that is not the agreed shape', () => {
    for (const bad of [null, 42, 'text', {}, { suggestions: 'nope' }, { suggestions: [{}] }]) {
      assert.equal(parseProviderPayload(bad).ok, false, `accepted ${JSON.stringify(bad)}`);
    }
  });

  it('rejects an out-of-range confidence rather than clamping it', () => {
    const result = parseProviderPayload({ suggestions: [{ ...suggestion(), confidence: 4 }] });
    assert.equal(result.ok, false);
  });

  it('accepts a well-formed payload', () => {
    const result = parseProviderPayload({ suggestions: [suggestion()] });
    assert.equal(result.ok, true);
  });
});

describe('the allowlist (gate 2)', () => {
  it('blocks a hallucinated task key and stores no id for it', () => {
    const { input } = fixture();
    const out = applyGates({ ...input, raw: [suggestion({ predecessorKey: 'Z-99' })] });
    assert.equal(out.accepted.length, 0);
    assert.equal(out.filtered[0]!.reason, 'UNKNOWN_TASK');
    assert.equal(out.filtered[0]!.predecessorId, null);
    assert.match(out.filtered[0]!.detail, /does not exist/i);
  });

  it('blocks a hallucinated key even at maximum confidence', () => {
    const { input } = fixture();
    const out = applyGates({
      ...input,
      raw: [suggestion({ successorKey: 'GHOST', confidence: 1 })],
    });
    assert.equal(out.accepted.length, 0);
  });
});

describe('evidence verification (gate 3)', () => {
  it('blocks a suggestion whose quoted justification is not in the task text', () => {
    const { input } = fixture();
    const out = applyGates({
      ...input,
      raw: [
        suggestion({
          evidence: {
            predecessor: 'this task explicitly blocks the launch announcement',
            successor: 'cannot start until the schema is frozen',
          },
        }),
      ],
    });
    assert.equal(out.accepted.length, 0);
    assert.equal(out.filtered[0]!.reason, 'UNVERIFIED_EVIDENCE');
  });

  it('tolerates punctuation and case differences in a genuine quote', () => {
    const { input } = fixture();
    const out = applyGates({
      ...input,
      raw: [
        suggestion({
          evidence: {
            predecessor: 'DEFINES THE TABLES, every later task reads!',
            successor: 'write the launch blog post.',
          },
        }),
      ],
    });
    assert.equal(out.accepted.length, 1, 'normalisation should not reject a real quote');
  });

  it('does not treat a very short span as fabricated', () => {
    // Policing three-word quotes would reject honest suggestions; the gate
    // exists to catch invented sentences, not terse ones.
    const { input } = fixture();
    const out = applyGates({
      ...input,
      raw: [suggestion({ evidence: { predecessor: 'schema', successor: 'blog' } })],
    });
    assert.equal(out.accepted.length, 1);
  });
});

describe('graph validity (gates 4 and 5)', () => {
  it('blocks an edge that would close a cycle, and names the loop', () => {
    const { input } = fixture();
    const out = applyGates({
      ...input,
      raw: [suggestion({ predecessorKey: 'C', successorKey: 'A' })],
    });
    assert.equal(out.accepted.length, 0);
    assert.equal(out.filtered[0]!.reason, 'CYCLE');
    assert.match(out.filtered[0]!.detail, /A -> B -> C -> A/);
  });

  it('blocks a duplicate of an existing edge', () => {
    const { input } = fixture();
    const out = applyGates({
      ...input,
      raw: [suggestion({ predecessorKey: 'A', successorKey: 'B' })],
    });
    assert.equal(out.filtered[0]!.reason, 'DUPLICATE');
  });

  it('blocks a self-edge', () => {
    const { input } = fixture();
    const out = applyGates({
      ...input,
      raw: [suggestion({ predecessorKey: 'A', successorKey: 'A' })],
    });
    assert.equal(out.filtered[0]!.reason, 'SELF_EDGE');
  });

  it('blocks a transitively redundant edge and names the implying path', () => {
    const { input } = fixture();
    const out = applyGates({
      ...input,
      raw: [suggestion({ predecessorKey: 'A', successorKey: 'C' })],
    });
    assert.equal(out.accepted.length, 0);
    assert.equal(out.filtered[0]!.reason, 'REDUNDANT');
    assert.match(out.filtered[0]!.detail, /A -> B -> C/);
  });

  it('blocks two suggestions that are only circular together', () => {
    // D -> A and A -> D are each fine against the stored graph. Accepting both
    // is a cycle, so the second must be refused within the same pass.
    const { input } = fixture();
    const out = applyGates({
      ...input,
      raw: [
        suggestion({ predecessorKey: 'A', successorKey: 'D', confidence: 0.95 }),
        suggestion({ predecessorKey: 'D', successorKey: 'A', confidence: 0.94 }),
      ],
    });
    assert.equal(out.accepted.length, 1);
    assert.equal(out.filtered.length, 1);
    assert.equal(out.filtered[0]!.reason, 'CYCLE');
  });

  it('judges redundancy against the committed graph only', () => {
    // If B -> D is merely *suggested*, then A -> D is not yet implied by
    // anything, so calling it redundant would be a claim about a fact that does
    // not exist. The reviewer may reject B -> D a second later.
    const { input } = fixture();
    const out = applyGates({
      ...input,
      raw: [
        suggestion({ predecessorKey: 'B', successorKey: 'D', confidence: 0.95 }),
        suggestion({ predecessorKey: 'A', successorKey: 'D', confidence: 0.9 }),
      ],
    });
    assert.equal(out.accepted.length, 2, 'neither should be called redundant');
    assert.equal(out.filtered.length, 0);
  });
});

describe('human and threshold gates (6 and 7)', () => {
  it('blocks a pair a reviewer already rejected', () => {
    const { input } = fixture();
    const out = applyGates({
      ...input,
      rejectedPairs: new Set(['id-A>id-D']),
      raw: [suggestion()],
    });
    assert.equal(out.accepted.length, 0);
    assert.equal(out.filtered[0]!.reason, 'PREVIOUSLY_REJECTED');
  });

  it('blocks a suggestion below the confidence floor', () => {
    const { input } = fixture();
    const out = applyGates({ ...input, raw: [suggestion({ confidence: MIN_CONFIDENCE - 0.01 })] });
    assert.equal(out.filtered[0]!.reason, 'LOW_CONFIDENCE');
  });

  it('caps the review queue and keeps the most confident suggestions', () => {
    const tasks = Array.from({ length: 12 }, (_, i) => task(`T${i}`));
    const out = applyGates({
      graph: { tasks, edges: [] },
      textByKey: new Map(tasks.map((t) => [t.key, `Task ${t.key} description text here.`])),
      idByKey: new Map(tasks.map((t) => [t.key, t.id])),
      rejectedPairs: new Set(),
      maxSuggestions: 3,
      raw: Array.from({ length: 10 }, (_, i) => ({
        predecessorKey: 'T0',
        successorKey: `T${i + 1}`,
        confidence: 0.6 + i * 0.03,
        rationale: 'reason',
        evidence: { predecessor: 'short', successor: 'short' },
      })),
    });
    assert.equal(out.accepted.length, 3);
    // Highest confidence first: T10 (0.87), T9 (0.84), T8 (0.81).
    assert.deepEqual(
      out.accepted.map((s) => s.successorKey),
      ['T10', 'T9', 'T8'],
    );
  });

  it('deduplicates identical proposals without reporting a rejection', () => {
    const { input } = fixture();
    const out = applyGates({ ...input, raw: [suggestion(), suggestion()] });
    assert.equal(out.accepted.length, 1);
    assert.equal(out.filtered.length, 0);
  });

  it('reports a count for every gate that fired', () => {
    const { input } = fixture();
    const out = applyGates({
      ...input,
      raw: [
        suggestion(),
        suggestion({ predecessorKey: 'GHOST' }),
        suggestion({ predecessorKey: 'C', successorKey: 'A' }),
        suggestion({ predecessorKey: 'B', successorKey: 'D', confidence: 0.1 }),
      ],
    });
    assert.equal(out.counts.proposed, 4);
    assert.equal(out.counts.accepted, out.accepted.length);
    assert.equal(out.counts.filtered, out.filtered.length);
    assert.ok(out.counts.unknown_task! >= 1);
    assert.ok(out.counts.low_confidence! >= 1);
  });
});
