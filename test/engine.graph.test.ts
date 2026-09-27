import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  findPath,
  isReachable,
  naturalCompare,
  topoSort,
  validateAddEdge,
} from '../src/engine/index.ts';
import { chain, diamond, edge, task } from './helpers.ts';

describe('topoSort', () => {
  it('orders a linear chain', () => {
    const r = topoSort(chain(4));
    assert.ok(r.ok);
    assert.deepEqual(r.value, ['L0', 'L1', 'L2', 'L3']);
  });

  it('orders a diamond with predecessors before successors', () => {
    const r = topoSort(diamond());
    assert.ok(r.ok);
    assert.deepEqual(r.value, ['A', 'B', 'C', 'D']);
  });

  it('handles an empty graph', () => {
    const r = topoSort({ tasks: [], edges: [] });
    assert.ok(r.ok);
    assert.deepEqual(r.value, []);
  });

  it('handles a single node and disconnected components', () => {
    const single = topoSort({ tasks: [task('X', 1)], edges: [] });
    assert.ok(single.ok);
    assert.deepEqual(single.value, ['X']);

    // Two independent components. The frontier always takes the lowest-keyed
    // ready node, so the order is deterministic as well as topologically valid.
    const split = topoSort({
      tasks: [task('A', 1), task('B', 1), task('C', 1), task('D', 1)],
      edges: [edge('A', 'B'), edge('C', 'D')],
    });
    assert.ok(split.ok);
    assert.deepEqual(split.value, ['A', 'B', 'C', 'D']);
    const at = (id: string) => split.value.indexOf(id);
    assert.ok(at('A') < at('B') && at('C') < at('D'));
  });

  it('is deterministic regardless of input ordering', () => {
    const g = diamond();
    const shuffled = { tasks: [...g.tasks].reverse(), edges: [...g.edges].reverse() };
    const a = topoSort(g);
    const b = topoSort(shuffled);
    assert.ok(a.ok && b.ok);
    assert.deepEqual(a.value, b.value);
  });

  it('reports the cycle when the graph is not a DAG', () => {
    const r = topoSort({
      tasks: [task('A', 1), task('B', 1), task('C', 1)],
      edges: [edge('A', 'B'), edge('B', 'C'), edge('C', 'A')],
    });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'CYCLE');
    // A closed walk: first and last element are the same node.
    assert.equal(r.error.path[0], r.error.path.at(-1));
    assert.equal(r.error.path.length, 4);
    assert.match(r.error.message, /A -> B -> C -> A/);
  });

  it('detects an 8-node cycle', () => {
    const tasks = Array.from({ length: 8 }, (_, i) => task(`N${i}`, 1));
    const edges = tasks.map((_, i) => edge(`N${i}`, `N${(i + 1) % 8}`));
    const r = topoSort({ tasks, edges });
    assert.ok(!r.ok);
    assert.equal(r.error.path.length, 9);
  });
});

describe('naturalCompare', () => {
  it('sorts TF-2 before TF-10', () => {
    const keys = ['TF-10', 'TF-2', 'TF-1'].sort(naturalCompare);
    assert.deepEqual(keys, ['TF-1', 'TF-2', 'TF-10']);
  });
});

describe('findPath / isReachable', () => {
  it('finds a multi-hop path and returns null when unreachable', () => {
    const g = chain(4);
    assert.deepEqual(findPath(g, 'L0', 'L3'), ['L0', 'L1', 'L2', 'L3']);
    assert.equal(findPath(g, 'L3', 'L0'), null);
    assert.equal(isReachable(g, 'L0', 'L2'), true);
    assert.equal(isReachable(g, 'L2', 'L0'), false);
  });
});

describe('validateAddEdge', () => {
  const g = diamond();

  it('accepts a legal new edge', () => {
    const v = validateAddEdge(
      { tasks: [...g.tasks, task('E', 1)], edges: g.edges },
      edge('D', 'E'),
    );
    assert.equal(v.kind, 'OK');
  });

  it('rejects a self-edge', () => {
    const v = validateAddEdge(g, edge('A', 'A'));
    assert.equal(v.kind, 'REJECTED');
    assert.equal(v.kind === 'REJECTED' && v.code, 'SELF_EDGE');
  });

  it('rejects a duplicate edge', () => {
    const v = validateAddEdge(g, edge('A', 'B'));
    assert.equal(v.kind === 'REJECTED' && v.code, 'DUPLICATE');
  });

  it('rejects an edge referencing an unknown task', () => {
    const v = validateAddEdge(g, edge('A', 'NOPE'));
    assert.equal(v.kind === 'REJECTED' && v.code, 'UNKNOWN_TASK');
  });

  it('rejects a direct 2-cycle', () => {
    const v = validateAddEdge(g, edge('B', 'A'));
    assert.equal(v.kind === 'REJECTED' && v.code, 'CYCLE');
    assert.deepEqual(v.kind === 'REJECTED' && v.cyclePath, ['A', 'B', 'A']);
  });

  it('rejects a longer cycle and names the exact path', () => {
    // A -> B -> D already exists; adding D -> A closes A -> B -> D -> A.
    const v = validateAddEdge(g, edge('D', 'A'));
    assert.equal(v.kind === 'REJECTED' && v.code, 'CYCLE');
    const path = v.kind === 'REJECTED' ? v.cyclePath! : [];
    // A cycle is reported as a closed walk, so it ends where it starts.
    assert.equal(path[0], 'A');
    assert.equal(path.at(-1), 'A');
    assert.deepEqual(path, ['A', 'B', 'D', 'A']);
    assert.match(
      v.kind === 'REJECTED' ? v.message : '',
      /would create a cycle: A -> B -> D -> A|A -> C -> D -> A/,
    );
  });

  it('flags a transitively redundant edge without rejecting it', () => {
    const v = validateAddEdge(diamond(), edge('A', 'D'));
    assert.equal(v.kind, 'OK');
    assert.ok(v.kind === 'OK' && v.redundantVia !== null);
  });
});
