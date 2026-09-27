/**
 * Wiring.
 *
 * Every handler follows the same shape, and the uniformity is the point:
 *
 *     call the API  →  replace the whole board  →  toast the diff  →  re-render
 *
 * There is no optimistic update and no local schedule arithmetic anywhere in
 * the client. The scheduler lives on the server, runs once per change, and the
 * browser only ever renders what it returned. That is why a rejected mutation
 * leaves the UI in a correct state for free: nothing was changed to undo.
 */

import { api, ApiError } from './api.js';
import { $, el } from './dom.js';
import { announce, toast, toastDiff, toastError } from './toast.js';
import { highlightFromDiff, keyMap, setState, state, subscribe } from './state.js';
import { renderBoard, renderMetrics } from './board.js';
import {
  closeDrawer,
  isDrawerOpen,
  openCreateDrawer,
  openDrawer,
  refreshDrawer,
} from './drawer.js';
import { closeAiPanel, narrativeToastBody, openAiPanel, renderAiPanel } from './ai.js';
import { renderGraph } from './graph.js';

/** Tracks an in-flight mutation so its controls can disable without a global lock. */
async function withPending(id, fn) {
  state.pending.add(id);
  render();
  try {
    return await fn();
  } finally {
    state.pending.delete(id);
    render();
  }
}

/**
 * Applies a mutation response.
 *
 * `narrative` is deliberately toasted separately from the diff: the diff toast
 * is the fact, the narrative is the explanation, and the explanation must never
 * be mistaken for the source of truth.
 */
function applyMutation(action, response) {
  if (!response) return;
  const previousKeys = keyMap();
  setState({ board: response.board ?? response });
  if (response.diff) {
    highlightFromDiff(response.diff);
    toastDiff(action, response.diff, new Map([...previousKeys, ...keyMap()]));
  }
  for (const warning of response.warnings ?? []) {
    toast({ title: 'Allowed, with a caveat', body: warning, kind: 'warn' });
  }
  const body = narrativeToastBody(response.narrative);
  if (
    body &&
    response.diff &&
    (response.diff.changed.length > 0 || response.diff.projectFinishDeltaDays !== 0)
  ) {
    toast({ title: 'Impact', body, kind: 'info', ms: 11000 });
  }
  render();
  // The pulse is a one-shot; clear it so the next render does not replay it.
  setTimeout(() => {
    state.highlight = new Set();
  }, 1200);
}

function fail(error) {
  if (error instanceof ApiError) toastError(error);
  else {
    console.error(error);
    toast({ title: 'Something went wrong', body: String(error?.message ?? error), kind: 'error' });
  }
}

// ---- handlers --------------------------------------------------------------

const handlers = {
  onOpen: (task) => openDrawer(task, handlers),

  onMove: (task, stage) =>
    withPending(task.id, async () => {
      try {
        const response = await api.moveTask(task.id, { stage, expectedVersion: task.version });
        applyMutation(`Moved ${task.key} to ${stage.replace('_', ' ').toLowerCase()}`, response);
      } catch (error) {
        fail(error);
      }
    }),

  onDrop: (taskId, stage, beforeTaskId) =>
    withPending(taskId, async () => {
      const task = state.board.tasks.find((t) => t.id === taskId);
      if (!task) return;
      if (task.stage === stage && !beforeTaskId) return;
      try {
        const response = await api.moveTask(taskId, {
          stage,
          beforeTaskId,
          expectedVersion: task.version,
        });
        applyMutation(`Moved ${task.key} to ${stage.replace('_', ' ').toLowerCase()}`, response);
      } catch (error) {
        fail(error);
      }
    }),

  onDuration: (task, durationDays) =>
    withPending(task.id, async () => {
      try {
        const response = await api.updateTask(task.id, {
          durationDays,
          expectedVersion: task.version,
        });
        applyMutation(`${task.key} is now ${durationDays} days`, response);
      } catch (error) {
        fail(error);
      }
    }),

  onSave: (task, patch) =>
    withPending(task.id, async () => {
      try {
        const response = await api.updateTask(task.id, patch);
        applyMutation(`Updated ${task.key}`, response);
      } catch (error) {
        fail(error);
      }
    }),

  onDelete: (task) =>
    withPending(task.id, async () => {
      // Deleting a node changes other people's dates, so name the consequence.
      const blocked = state.board.dependencies.filter((d) => d.predecessorId === task.id).length;
      const warning =
        blocked > 0
          ? `\n\n${blocked} task(s) depend on it; those dependencies will be removed and their dates will move.`
          : '';
      if (!confirm(`Delete ${task.key} — ${task.title}?${warning}`)) return;
      try {
        const response = await api.deleteTask(task.id);
        closeDrawer();
        applyMutation(`Deleted ${task.key}`, response);
      } catch (error) {
        fail(error);
      }
    }),

  onCreate: async (input) => {
    if (!input.title) {
      toast({ title: 'A title is required', kind: 'warn' });
      return;
    }
    try {
      const response = await api.createTask(input);
      closeDrawer();
      applyMutation(`Created ${response.board.tasks.at(-1)?.key ?? 'task'}`, response);
    } catch (error) {
      fail(error);
    }
  },

  onAddDependency: (predecessorId, successorId) =>
    withPending(successorId, async () => {
      try {
        const response = await api.addDependency({ predecessorId, successorId });
        applyMutation('Dependency added', response);
      } catch (error) {
        fail(error);
      }
    }),

  onRemoveDependency: (dependencyId, key) =>
    withPending(dependencyId, async () => {
      try {
        const response = await api.removeDependency(dependencyId);
        applyMutation(`Removed the dependency on ${key}`, response);
      } catch (error) {
        fail(error);
      }
    }),

  onWhatIf: async (task, durationDays) => {
    try {
      const response = await api.whatIf(task.id, durationDays);
      toast({
        title: `If ${task.key} took ${durationDays} days`,
        body: response.narrative.text,
        kind: 'info',
        ms: 13000,
      });
    } catch (error) {
      fail(error);
    }
  },

  onAccept: (suggestion) =>
    withPending(suggestion.id, async () => {
      try {
        const response = await api.acceptSuggestion(suggestion.id);
        applyMutation(
          `Accepted ${suggestion.predecessorKey} → ${suggestion.successorKey}`,
          response,
        );
        await refreshSuggestions();
      } catch (error) {
        // The commonest failure is a suggestion that has gone stale — which is
        // exactly the safety property worth demonstrating.
        fail(error);
        await refreshSuggestions();
      }
    }),

  onReject: (suggestion) =>
    withPending(suggestion.id, async () => {
      try {
        const response = await api.rejectSuggestion(suggestion.id);
        toast({ title: 'Rejected', body: response.summary, kind: 'ok' });
        await refreshSuggestions();
      } catch (error) {
        fail(error);
      }
    }),
};

async function refreshSuggestions() {
  try {
    const run = await api.suggestions();
    setState({ suggestions: run });
  } catch (error) {
    fail(error);
  }
}

// ---- render ----------------------------------------------------------------

function render() {
  if (!state.board) return;
  renderMetrics(state.board);

  const boardView = $('#board-view');
  const graphView = $('#graph-view');
  boardView.hidden = state.view !== 'board';
  graphView.hidden = state.view !== 'graph';
  $('#btn-view').setAttribute('aria-pressed', String(state.view === 'graph'));
  $('#btn-view').textContent = state.view === 'graph' ? 'Board view' : 'Graph view';

  if (state.view === 'board') renderBoard($('#columns'), handlers);
  else {
    renderGraph($('#graph-wrap'), state.board, {
      criticalOnly: state.criticalOnly,
      onSelect: (task) => openDrawer(task, handlers),
    });
  }

  if (isDrawerOpen()) refreshDrawer(handlers);
  if (!$('#ai-panel').hidden) renderAiPanel(state.suggestions, handlers);

  const ai = state.board.ai;
  const banner = $('#banner');
  if (ai && !ai.openaiConfigured && !ai.geminiConfigured) {
    banner.hidden = false;
    banner.textContent =
      'No AI provider keys are configured, so suggestions come from the built-in offline heuristic. ' +
      'Every dependency-engine guarantee on this page still applies — set OPENAI_API_KEY or GEMINI_API_KEY for model-backed consensus.';
  } else {
    banner.hidden = true;
  }
}

// ---- boot ------------------------------------------------------------------

function wireChrome() {
  $('#btn-new').addEventListener('click', () => openCreateDrawer(handlers));

  $('#btn-view').addEventListener('click', () => {
    setState({ view: state.view === 'board' ? 'graph' : 'board' });
    announce(state.view === 'graph' ? 'Graph view' : 'Board view');
  });

  $('#graph-critical-only').addEventListener('change', (event) => {
    setState({ criticalOnly: event.target.checked });
  });

  $('#btn-suggest').addEventListener('click', async () => {
    const button = $('#btn-suggest');
    const label = $('.btn-label', button);
    button.disabled = true;
    label.textContent = 'Asking the models…';
    button.prepend(el('span', { class: 'spinner' }));
    openAiPanel();
    renderAiPanel({ pending: [], filtered: [], providers: [], counts: {} }, handlers);
    try {
      const run = await api.suggest();
      setState({ suggestions: run });
      renderAiPanel(run, handlers);
      toast({
        title: 'Suggestion pass complete',
        body:
          `${run.counts.proposed ?? 0} proposed, ${run.pending.length} awaiting your decision, ` +
          `${run.filtered.length} blocked by the engine.`,
        kind: 'ok',
      });
    } catch (error) {
      fail(error);
    } finally {
      button.disabled = false;
      button.querySelector('.spinner')?.remove();
      label.textContent = 'Suggest dependencies';
    }
  });

  $('#btn-reset').addEventListener('click', async () => {
    if (!confirm('Reset the demo board to its seeded state? All changes will be lost.')) return;
    const token = window.localStorage.getItem('taskflow.adminToken') ?? '';
    try {
      const board = await api.resetDemo(token);
      setState({ board, suggestions: { pending: [], filtered: [], providers: [], counts: {} } });
      toast({ title: 'Demo board reset', kind: 'ok' });
      render();
    } catch (error) {
      fail(error);
    }
  });

  // Close overlays from the keyboard and from the scrim.
  for (const id of ['#drawer', '#ai-panel']) {
    $(id).addEventListener('click', (event) => {
      if (event.target.closest('[data-close]')) {
        if (id === '#drawer') closeDrawer();
        else closeAiPanel();
      }
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('#ai-panel').hidden) closeAiPanel();
    else if (isDrawerOpen()) closeDrawer();
  });
}

async function boot() {
  wireChrome();
  // The store drives rendering: every setState re-renders, so no handler has to
  // remember to. Forgetting one is exactly how a view silently goes stale.
  subscribe(render);
  try {
    const [board, suggestions] = await Promise.all([api.board(), api.suggestions()]);
    setState({ board, suggestions });
    render();
    announce(
      `Board loaded. ${board.stats.total} tasks, ${board.stats.blocked} blocked, ` +
        `project finishes ${board.board.projectFinish}.`,
    );
  } catch (error) {
    fail(error);
  }
}

boot();
