/**
 * Property-based tests over randomly generated DAGs.
 *
 * A seeded PRNG keeps failures reproducible: the seed is printed in the
 * assertion message so any counterexample can be replayed exactly.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EdgeInput, Graph, TaskInput } from '../src/engine/index.ts';
import { buildAdjacency, rank, topoSort } from '../src/engine/index.ts';
import { extend, schedule } from './helpers.ts';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generate a random DAG. Edges always point from a lower index to a higher one,
 * which makes acyclicity structural rather than something we have to trust.
 */
function randomDag(rnd: () => number, n: number, density = 0.25): Graph {
  const tasks: TaskInput[] = Array.from({ length: n }, (_, i) => ({
    id: `T${i}`,
    key: `T-${i}`,
    stage: rnd() < 0.2 ? 'DONE' : 'BACKLOG',
    durationDays: 1 + Math.floor(rnd() * 6),
    plannedStart: null,
    isPinned: false,
    actualFinish: null,
  }));
  const edges: EdgeInput[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rnd() < density) {
        edges.push({ predecessorId: `T${i}`, successorId: `T${j}`, lagDays: rnd() < 0.15 ? 1 : 0 });
      }
    }
  }
  return { tasks, edges };
}

describe('scheduling invariants over random DAGs', () => {
  it('never starts a task before a predecessor finishes', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rnd = mulberry32(seed);
      const g = randomDag(rnd, 4 + Math.floor(rnd() * 14));
      const s = schedule(g);
      for (const e of g.edges) {
        assert.ok(
          s.byId[e.successorId]!.earliestStart >=
            s.byId[e.predecessorId]!.earliestFinish + e.lagDays,
          `seed ${seed}: ${e.predecessorId} -> ${e.successorId} violated`,
        );
      }
    }
  });

  it('shifts every downstream task by at most the upstream growth (no compounding)', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rnd = mulberry32(seed);
      const g = randomDag(rnd, 5 + Math.floor(rnd() * 12));
      const source = g.tasks[0]!;
      const growth = 3;
      const before = schedule(g);
      const after = schedule(extend(g, source.key, growth));
      for (const t of g.tasks) {
        const delta = after.byId[t.id]!.earliestStart - before.byId[t.id]!.earliestStart;
        assert.ok(
          delta >= 0 && delta <= growth,
          `seed ${seed}: ${t.id} moved ${delta} days for a +${growth} change`,
        );
      }
    }
  });

  it('keeps slack non-negative and the critical path at zero slack', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rnd = mulberry32(seed);
      const g = randomDag(rnd, 4 + Math.floor(rnd() * 14));
      const s = schedule(g);
      for (const t of g.tasks) {
        assert.ok(s.byId[t.id]!.slackDays >= 0, `seed ${seed}: negative slack on ${t.id}`);
      }
      for (const id of s.criticalPath) {
        assert.equal(s.byId[id]!.slackDays, 0, `seed ${seed}: ${id} on path with slack`);
      }
      assert.ok(s.criticalPath.length > 0 || g.tasks.length === 0);
    }
  });

  it('is idempotent and order-independent', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const g = randomDag(mulberry32(seed), 10);
      const reversed = { tasks: [...g.tasks].reverse(), edges: [...g.edges].reverse() };
      assert.deepEqual(schedule(g), schedule(g), `seed ${seed}: not idempotent`);
      assert.deepEqual(schedule(g), schedule(reversed), `seed ${seed}: order-dependent`);
    }
  });

  it('topologically sorts every generated DAG', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const g = randomDag(mulberry32(seed), 12);
      const r = topoSort(g);
      assert.ok(r.ok, `seed ${seed}: generated graph was not a DAG`);
      const position = new Map(r.value.map((id, i) => [id, i] as const));
      for (const e of g.edges) {
        assert.ok(position.get(e.predecessorId)! < position.get(e.successorId)!);
      }
      assert.equal(new Set(r.value).size, g.tasks.length);
    }
  });

  it('builds adjacency lists that agree with the edge list', () => {
    const g = randomDag(mulberry32(7), 15);
    const adj = buildAdjacency(g);
    let counted = 0;
    for (const list of adj.successors.values()) counted += list.length;
    assert.equal(counted, g.edges.length);
  });
});

describe('fractional rank', () => {
  it('always mints a rank strictly between its neighbours', () => {
    const rnd = mulberry32(99);
    let list = rank.sequence(5);
    for (let i = 0; i < 400; i++) {
      const at = Math.floor(rnd() * (list.length + 1));
      const lo = at > 0 ? list[at - 1]! : null;
      const hi = at < list.length ? list[at]! : null;
      const mid = rank.between(lo, hi);
      if (lo !== null) assert.ok(lo < mid, `${lo} < ${mid}`);
      if (hi !== null) assert.ok(mid < hi, `${mid} < ${hi}`);
      list = [...list.slice(0, at), mid, ...list.slice(at)];
    }
    assert.deepEqual(list, [...list].sort());
    assert.equal(new Set(list).size, list.length);
  });

  it('seeds an empty column and appends without collision', () => {
    assert.equal(rank.between(null, null).length, 1);
    const seq = rank.sequence(200);
    assert.deepEqual(seq, [...seq].sort());
  });
});

describe('performance', () => {
  it('recomputes a 10k-task / ~30k-edge board well under 2 seconds', () => {
    const n = 10_000;
    const tasks: TaskInput[] = Array.from({ length: n }, (_, i) => ({
      id: `T${i}`,
      key: `T-${i}`,
      stage: 'BACKLOG',
      durationDays: 1 + (i % 5),
      plannedStart: null,
      isPinned: false,
      actualFinish: null,
    }));
    const edges: EdgeInput[] = [];
    for (let i = 3; i < n; i++) {
      edges.push({ predecessorId: `T${i - 1}`, successorId: `T${i}`, lagDays: 0 });
      edges.push({ predecessorId: `T${i - 2}`, successorId: `T${i}`, lagDays: 0 });
      edges.push({ predecessorId: `T${i - 3}`, successorId: `T${i}`, lagDays: 0 });
    }
    const started = performance.now();
    const s = schedule({ tasks, edges });
    const elapsed = performance.now() - started;
    assert.equal(s.order.length, n);
    assert.ok(elapsed < 2000, `recompute took ${elapsed.toFixed(0)}ms`);
    console.log(`      ${n} tasks / ${edges.length} edges recomputed in ${elapsed.toFixed(0)}ms`);
  });
});
