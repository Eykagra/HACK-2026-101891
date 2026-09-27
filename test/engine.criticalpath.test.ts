/** Critical path, slack, and the binding-edge rule. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chain, diamond, edge, schedule, task } from './helpers.ts';

describe('critical path', () => {
  it('is the whole chain when there is only one path', () => {
    const s = schedule(chain(4, 3));
    assert.deepEqual(s.criticalPath, ['L0', 'L1', 'L2', 'L3']);
    assert.equal(s.projectFinish - s.projectStart, 12);
    assert.ok(s.order.every((id) => s.byId[id]!.slackDays === 0));
  });

  it('follows the longer arm of an asymmetric diamond', () => {
    const s = schedule(diamond({ A: 2, B: 1, C: 10, D: 2 }));
    assert.deepEqual(s.criticalPath, ['A', 'C', 'D']);
    assert.equal(s.byId.C!.slackDays, 0);
    assert.equal(s.byId.B!.slackDays, 9);
    assert.equal(s.byId.B!.isCritical, false);
  });

  it('is duration-weighted, not node-count-weighted', () => {
    // Short hop of 20 days beats a three-hop chain of 3x2 days.
    const g = {
      tasks: [
        task('S', 1),
        task('LONG', 20),
        task('M1', 2),
        task('M2', 2),
        task('M3', 2),
        task('T', 1),
      ],
      edges: [
        edge('S', 'LONG'),
        edge('LONG', 'T'),
        edge('S', 'M1'),
        edge('M1', 'M2'),
        edge('M2', 'M3'),
        edge('M3', 'T'),
      ],
    };
    assert.deepEqual(schedule(g).criticalPath, ['S', 'LONG', 'T']);
  });

  it('marks every zero-slack task critical when paths tie, and picks one canonical chain', () => {
    const s = schedule(diamond({ A: 2, B: 4, C: 4, D: 2 }));
    assert.equal(s.byId.B!.isCritical, true);
    assert.equal(s.byId.C!.isCritical, true);
    // Tie broken deterministically on the natural key.
    assert.deepEqual(s.criticalPath, ['A', 'B', 'D']);
  });

  it('only reports edges that are actually binding', () => {
    const s = schedule(diamond({ A: 2, B: 1, C: 10, D: 2 }));
    const pairs = s.criticalEdges.map((e) => `${e.predecessorId}->${e.successorId}`);
    assert.deepEqual(pairs, ['A->C', 'C->D']);
    assert.ok(!pairs.includes('A->B'), 'A->B is critical-looking but not binding');
  });

  it('gives an isolated task zero slack and reports a coherent project finish', () => {
    const s = schedule({ tasks: [task('A', 3), task('B', 5)], edges: [] });
    assert.equal(s.projectFinish, s.projectStart + 5);
    assert.equal(s.byId.B!.slackDays, 0);
    assert.equal(s.byId.A!.slackDays, 2);
  });

  it('exposes graph depth for layered layout', () => {
    const s = schedule(diamond());
    assert.equal(s.byId.A!.depth, 0);
    assert.equal(s.byId.B!.depth, 1);
    assert.equal(s.byId.D!.depth, 2);
  });
});
