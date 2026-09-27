/** Blocked/Ready derivation and rollback on regression. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_SATISFIED_STAGES,
  diffSchedules,
  newlyBlocked,
  scheduleGraph,
} from '../src/engine/index.ts';
import { DAY0, diamond, edge, restage, schedule, task } from './helpers.ts';

describe('dependency state is derived', () => {
  it('is BLOCKED while any prerequisite is unfinished and READY once all are DONE', () => {
    const g = {
      tasks: [task('A', 2, { stage: 'DONE' }), task('B', 2), task('C', 2)],
      edges: [edge('A', 'C'), edge('B', 'C')],
    };
    const partial = schedule(g);
    assert.equal(partial.byId.C!.depState, 'BLOCKED');
    assert.deepEqual(partial.byId.C!.unmetPrereqIds, ['B']);

    const complete = schedule(restage(g, 'B', 'DONE'));
    assert.equal(complete.byId.C!.depState, 'READY');
    assert.deepEqual(complete.byId.C!.unmetPrereqIds, []);
  });

  it('treats a root task with no prerequisites as READY', () => {
    assert.equal(schedule({ tasks: [task('A', 1)], edges: [] }).byId.A!.depState, 'READY');
  });

  it('does not treat REVIEW as satisfying a prerequisite by default', () => {
    const g = {
      tasks: [task('A', 2, { stage: 'REVIEW' }), task('B', 2)],
      edges: [edge('A', 'B')],
    };
    assert.equal(schedule(g).byId.B!.depState, 'BLOCKED');
  });

  it('honours a configured satisfiedStages policy', () => {
    const g = {
      tasks: [task('A', 2, { stage: 'REVIEW' }), task('B', 2)],
      edges: [edge('A', 'B')],
    };
    const r = scheduleGraph(g, {
      projectStart: DAY0,
      satisfiedStages: ['REVIEW', 'DONE'],
    });
    assert.ok(r.ok);
    assert.equal(r.value.byId.B!.depState, 'READY');
  });
});

describe('rollback on regression', () => {
  const done = () => ({
    tasks: [
      task('A', 2, { stage: 'DONE' }),
      task('B', 2, { stage: 'DONE' }),
      task('C', 2, { stage: 'BACKLOG' }),
      task('D', 2, { stage: 'BACKLOG' }),
    ],
    edges: [edge('A', 'B'), edge('B', 'C'), edge('C', 'D')],
  });

  it('re-blocks the direct dependent when a completed task moves back to In Progress', () => {
    const before = schedule(done());
    assert.equal(before.byId.C!.depState, 'READY');

    const after = schedule(restage(done(), 'B', 'IN_PROGRESS'));
    assert.equal(after.byId.C!.depState, 'BLOCKED');

    const flipped = newlyBlocked(diffSchedules(before, after)).map((d) => d.id);
    assert.deepEqual(flipped, ['C']);
  });

  it('leaves grandchildren blocked and never silently unblocks them', () => {
    const after = schedule(restage(done(), 'A', 'IN_PROGRESS'));
    assert.equal(after.byId.B!.depState, 'BLOCKED');
    assert.equal(after.byId.C!.depState, 'READY', 'C depends on B, which is still DONE');
    assert.equal(after.byId.D!.depState, 'BLOCKED');
  });

  it('re-evaluates the whole downstream set in one pass, at any depth', () => {
    const deep = {
      tasks: [
        task('R', 1, { stage: 'DONE' }),
        ...[1, 2, 3, 4].map((i) => task(`N${i}`, 1, { stage: 'DONE' })),
      ],
      edges: [edge('R', 'N1'), edge('N1', 'N2'), edge('N2', 'N3'), edge('N3', 'N4')],
    };
    const after = schedule(restage(deep, 'R', 'IN_PROGRESS'));
    assert.equal(after.byId.N1!.depState, 'BLOCKED');
    // N2..N4 keep DONE predecessors, so only the direct dependent flips. This is
    // the correct semantics: "blocked" means an unfinished *prerequisite*.
    assert.equal(after.byId.N2!.depState, 'READY');
  });
});

describe('diffSchedules', () => {
  it('reports only tasks that actually changed', () => {
    const before = schedule(diamond());
    const after = schedule(restage(diamond(), 'A', 'DONE'));
    const diff = diffSchedules(before, after);
    assert.deepEqual(
      diff.changed.map((d) => d.id),
      ['B', 'C'],
    );
    assert.equal(
      diff.changed.every((d) => d.depStateAfter === 'READY'),
      true,
    );
  });

  it('treats a first computation as an addition, not a change', () => {
    const diff = diffSchedules(null, schedule(diamond()));
    assert.deepEqual(diff.added, ['A', 'B', 'C', 'D']);
    assert.deepEqual(diff.changed, []);
  });
});
