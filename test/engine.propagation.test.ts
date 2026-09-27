/**
 * The requirements that decide the submission: no compounding across converging
 * paths, correct behaviour in the presence of slack, and multi-level propagation.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chain, diamond, edge, extend, fan, schedule, task } from './helpers.ts';

describe('no compounding across converging paths', () => {
  it('moves the diamond sink by +3, not +6, when the source grows by 3', () => {
    const before = schedule(diamond());
    const after = schedule(extend(diamond(), 'A', 3));

    assert.equal(after.byId.D!.earliestStart - before.byId.D!.earliestStart, 3);
    assert.equal(after.byId.D!.earliestFinish - before.byId.D!.earliestFinish, 3);
    // Both arms carried the change, and neither stretched.
    assert.equal(after.byId.B!.earliestStart - before.byId.B!.earliestStart, 3);
    assert.equal(after.byId.C!.earliestStart - before.byId.C!.earliestStart, 3);
    assert.equal(
      after.byId.B!.earliestFinish - after.byId.B!.earliestStart,
      before.byId.B!.earliestFinish - before.byId.B!.earliestStart,
    );
  });

  it('is invariant to the number of converging paths', () => {
    for (const paths of [2, 3, 5, 10]) {
      const before = schedule(fan(paths, 1));
      const after = schedule(extend(fan(paths, 1), 'SRC', 3));
      assert.equal(
        after.byId.SINK!.earliestStart - before.byId.SINK!.earliestStart,
        3,
        `${paths} parallel paths should still yield +3`,
      );
    }
  });

  it('is invariant to path length as well as path count', () => {
    for (const length of [1, 2, 4, 8]) {
      const before = schedule(fan(3, length));
      const after = schedule(extend(fan(3, length), 'SRC', 3));
      assert.equal(after.byId.SINK!.earliestStart - before.byId.SINK!.earliestStart, 3);
    }
  });

  it('propagates through a 10-level chain without drift', () => {
    const before = schedule(chain(10));
    const after = schedule(extend(chain(10), 'L0', 3));
    for (let i = 1; i < 10; i++) {
      assert.equal(
        after.byId[`L${i}`]!.earliestStart - before.byId[`L${i}`]!.earliestStart,
        3,
        `level ${i} should move exactly 3 days`,
      );
    }
  });
});

describe('slack: the case a delta walk gets wrong', () => {
  it('does not move the sink when the short arm of an asymmetric diamond grows', () => {
    // B = 1 day, C = 10 days, so D is held by C and B has 9 days of float.
    const g = diamond({ A: 2, B: 1, C: 10, D: 2 });
    const before = schedule(g);
    assert.equal(before.byId.B!.slackDays, 9);

    const after = schedule(extend(g, 'B', 1));
    assert.equal(after.byId.D!.earliestStart - before.byId.D!.earliestStart, 0);
  });

  it('moves the sink only by the excess once slack is exhausted', () => {
    const g = diamond({ A: 2, B: 1, C: 10, D: 2 });
    const before = schedule(g);
    const after = schedule(extend(g, 'B', 12)); // 9 days of slack, 12 days of growth
    assert.equal(after.byId.D!.earliestStart - before.byId.D!.earliestStart, 3);
  });

  it('ignores an upstream slip when a different predecessor is binding', () => {
    // E is pinned far in the future and is what actually holds D.
    const g = {
      tasks: [
        task('A', 2),
        task('B', 2),
        task('D', 2),
        task('E', 2, { isPinned: true, plannedStart: 20100 }),
      ],
      edges: [edge('A', 'B'), edge('B', 'D'), edge('E', 'D')],
    };
    const before = schedule(g);
    const after = schedule(extend(g, 'A', 3));
    assert.equal(after.byId.D!.earliestStart - before.byId.D!.earliestStart, 0);
  });
});

describe('pins, shrinks and lag', () => {
  it('a pinned task absorbs an upstream slip until its slack runs out', () => {
    const g = {
      tasks: [task('A', 2), task('B', 2, { isPinned: true, plannedStart: 20010 })],
      edges: [edge('A', 'B')],
    };
    const before = schedule(g);
    assert.equal(before.byId.B!.earliestStart, 20010);

    // A finishes at 20002; B is pinned to 20010, so 8 days of float absorb this.
    assert.equal(schedule(extend(g, 'A', 5)).byId.B!.earliestStart, 20010);
    // 9 days of growth pushes past the pin.
    assert.equal(schedule(extend(g, 'A', 9)).byId.B!.earliestStart, 20011);
  });

  it('pulls dates in when a duration shrinks, but never past a pin', () => {
    const g = chain(3, 5);
    const before = schedule(g);
    const after = schedule(extend(g, 'L0', -3));
    assert.equal(after.byId.L2!.earliestStart - before.byId.L2!.earliestStart, -3);

    const pinned = {
      tasks: [task('A', 5), task('B', 2, { isPinned: true, plannedStart: 20004 })],
      edges: [edge('A', 'B')],
    };
    assert.equal(schedule(extend(pinned, 'A', -4)).byId.B!.earliestStart, 20004);
  });

  it('respects edge lag', () => {
    const g = { tasks: [task('A', 2), task('B', 2)], edges: [edge('A', 'B', 4)] };
    const s = schedule(g);
    assert.equal(s.byId.A!.earliestFinish, 20002);
    assert.equal(s.byId.B!.earliestStart, 20006);
  });

  it('honours a recorded actual finish over the estimate', () => {
    const g = {
      tasks: [task('A', 2, { stage: 'DONE', actualFinish: 20007 }), task('B', 2)],
      edges: [edge('A', 'B')],
    };
    assert.equal(schedule(g).byId.B!.earliestStart, 20007);
    // Clearing the actual finish (what a regression out of DONE does) reverts it.
    const reopened = {
      tasks: [task('A', 2, { stage: 'IN_PROGRESS' }), task('B', 2)],
      edges: [edge('A', 'B')],
    };
    assert.equal(schedule(reopened).byId.B!.earliestStart, 20002);
  });
});

describe('determinism and idempotency', () => {
  it('produces identical output for reordered input', () => {
    const g = diamond();
    const reversed = { tasks: [...g.tasks].reverse(), edges: [...g.edges].reverse() };
    assert.deepEqual(schedule(g), schedule(reversed));
  });

  it('is idempotent: rescheduling a scheduled board changes nothing', () => {
    const g = diamond();
    const once = schedule(g);
    const twice = schedule(g);
    assert.deepEqual(once, twice);
  });
});

describe('interval invariants', () => {
  it('never produces a finish before the start, even for same-day completions', () => {
    // A task recorded as finishing on the very day it became available.
    const g = {
      tasks: [task('A', 3, { stage: 'DONE', actualFinish: 20000 })],
      edges: [],
    };
    const s = schedule(g, 20000);
    assert.ok(s.byId.A!.earliestFinish > s.byId.A!.earliestStart);
    assert.equal(s.byId.A!.earliestFinish, 20001);
  });

  it('keeps a completed task from dragging its successor backwards', () => {
    const g = {
      tasks: [task('A', 3, { stage: 'DONE', actualFinish: 20000 }), task('B', 2)],
      edges: [edge('A', 'B')],
    };
    const s = schedule(g, 20000);
    assert.ok(s.byId.B!.earliestStart >= s.byId.A!.earliestFinish);
  });
});
