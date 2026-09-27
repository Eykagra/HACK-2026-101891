/**
 * Task drawer: edit a task, manage its dependencies, preview an impact.
 *
 * The drawer draws a hard line between what a user can *assert* and what the
 * engine *derives*. Title, duration, pin and planned start are inputs. Dates,
 * blocked state, slack and critical-path membership are shown as a read-only
 * readout labelled "derived". Letting someone type a start date that the
 * scheduler then silently overwrites is the single most common way a tool like
 * this loses a user's trust.
 */

import { $, clear, el, plural, shortDate } from './dom.js';
import { legalPredecessors, predecessorsOf, state, successorsOf } from './state.js';

let activeTaskId = null;
let lastFocused = null;

export function isDrawerOpen() {
  return activeTaskId !== null;
}

export function closeDrawer() {
  const drawer = $('#drawer');
  drawer.hidden = true;
  drawer.setAttribute('aria-hidden', 'true');
  activeTaskId = null;
  lastFocused?.focus?.();
}

/**
 * @param {object} task
 * @param {object} handlers
 */
export function openDrawer(task, handlers) {
  activeTaskId = task.id;
  lastFocused = document.activeElement;
  const drawer = $('#drawer');
  drawer.hidden = false;
  drawer.setAttribute('aria-hidden', 'false');
  renderDrawer(handlers);
  $('.drawer-panel', drawer)?.focus?.();
}

/** Re-renders in place after a board refresh, so the drawer never goes stale. */
export function refreshDrawer(handlers) {
  if (activeTaskId) renderDrawer(handlers);
}

function derivedReadout(task) {
  return el('dl', { class: 'readout' }, [
    el('dt', { text: 'Scheduled' }),
    el('dd', {
      class: 'derived',
      text: `${shortDate(task.scheduledStart)} → ${shortDate(task.scheduledEnd)}`,
    }),
    el('dt', { text: 'State' }),
    el('dd', {
      class: 'derived',
      text:
        task.depState === 'BLOCKED'
          ? `Blocked by ${task.unmetPrereqKeys.join(', ')}`
          : 'Ready — all prerequisites are complete',
    }),
    el('dt', { text: 'Slack' }),
    el('dd', {
      class: 'derived',
      text: task.isCritical
        ? 'None — on the critical path'
        : `${plural(task.slackDays, 'day')} before the project finish moves`,
    }),
    el('dt', { text: 'Version' }),
    el('dd', { class: 'derived', text: String(task.version) }),
  ]);
}

function dependencyRow(entry, direction, handlers) {
  const { task, dependency } = entry;
  return el('li', { class: `dep-row${dependency.isCritical ? ' is-critical' : ''}` }, [
    el('span', { class: 'dep-key', text: task.key }),
    el('span', { class: 'dep-title', text: task.title }),
    dependency.origin === 'AI_ACCEPTED'
      ? el('span', {
          class: 'badge badge-pinned',
          text: 'AI',
          title: `Suggested by ${dependency.suggestedBy ?? 'AI'} and approved by a reviewer.`,
        })
      : null,
    direction === 'in'
      ? el('button', {
          class: 'btn-icon',
          type: 'button',
          text: '×',
          'aria-label': `Remove dependency on ${task.key}`,
          onclick: () => handlers.onRemoveDependency(dependency.id, task.key),
        })
      : null,
  ]);
}

function renderDrawer(handlers) {
  const task = state.board?.tasks.find((t) => t.id === activeTaskId);
  if (!task) {
    closeDrawer();
    return;
  }

  $('#drawer-key').textContent = `${task.key} · ${task.stage.replace('_', ' ').toLowerCase()}`;
  $('#drawer-title').textContent = task.title;

  const body = clear($('#drawer-body'));
  const busy = state.pending.has(task.id);

  // ---- derived facts, read-only ------------------------------------------
  body.append(
    el('p', { class: 'section-title', text: 'Derived by the scheduling engine' }),
    derivedReadout(task),
  );

  // ---- duration ----------------------------------------------------------
  const output = el('output', { text: plural(task.durationDays, 'day') });
  body.append(
    el('div', { class: 'field' }, [
      el('label', { text: 'Duration', for: 'dur-out' }),
      el('div', { class: 'stepper' }, [
        el('button', {
          type: 'button',
          text: '−',
          disabled: busy || task.durationDays <= 1,
          'aria-label': 'Decrease duration by one day',
          onclick: () => handlers.onDuration(task, task.durationDays - 1),
        }),
        output,
        el('button', {
          type: 'button',
          text: '+',
          disabled: busy,
          'aria-label': 'Increase duration by one day',
          onclick: () => handlers.onDuration(task, task.durationDays + 1),
        }),
      ]),
      el('p', {
        class: 'field-hint',
        text: 'Changing this re-plans every downstream task immediately.',
      }),
      el('button', {
        class: 'btn-link',
        type: 'button',
        text: 'Preview +3 days without changing anything',
        onclick: () => handlers.onWhatIf(task, task.durationDays + 3),
      }),
    ]),
  );

  // ---- editable fields ---------------------------------------------------
  const titleInput = el('input', {
    type: 'text',
    value: task.title,
    maxLength: 200,
    id: 'f-title',
  });
  const descInput = el('textarea', { value: task.description, maxLength: 4000, id: 'f-desc' });
  const assigneeInput = el('input', {
    type: 'text',
    value: task.assignee ?? '',
    maxLength: 80,
    id: 'f-assignee',
  });
  const pinInput = el('input', { type: 'checkbox', checked: task.isPinned, id: 'f-pin' });
  const startInput = el('input', { type: 'date', value: task.plannedStart ?? '', id: 'f-start' });

  body.append(
    el('p', { class: 'section-title', text: 'Details' }),
    el('div', { class: 'field' }, [el('label', { text: 'Title', for: 'f-title' }), titleInput]),
    el('div', { class: 'field' }, [el('label', { text: 'Description', for: 'f-desc' }), descInput]),
    el('div', { class: 'field' }, [
      el('label', { text: 'Assignee', for: 'f-assignee' }),
      assigneeInput,
    ]),
    el('div', { class: 'field' }, [
      el('label', { text: 'Earliest possible start', for: 'f-start' }),
      startInput,
      el('p', {
        class: 'field-hint',
        text: 'A floor, not a fixed date. The scheduler still pushes this task later when a prerequisite demands it.',
      }),
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'check' }, [
        pinInput,
        ' Pin to this start date (ignore earlier availability)',
      ]),
    ]),
    el('div', { class: 'drawer-footer' }, [
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: busy ? 'Saving…' : 'Save changes',
        disabled: busy,
        onclick: () =>
          handlers.onSave(task, {
            title: titleInput.value.trim(),
            description: descInput.value,
            assignee: assigneeInput.value.trim() || null,
            isPinned: pinInput.checked,
            plannedStart: startInput.value || null,
            expectedVersion: task.version,
          }),
      }),
      el('button', {
        class: 'btn btn-danger',
        type: 'button',
        text: 'Delete task',
        disabled: busy,
        onclick: () => handlers.onDelete(task),
      }),
    ]),
  );

  // ---- dependencies ------------------------------------------------------
  const incoming = predecessorsOf(task.id);
  const outgoing = successorsOf(task.id);

  body.append(el('p', { class: 'section-title', text: 'Depends on (must finish first)' }));
  if (incoming.length === 0) {
    body.append(
      el('p', {
        class: 'dep-empty',
        text: 'Nothing. This task can start as soon as its dates allow.',
      }),
    );
  } else {
    body.append(
      el(
        'ul',
        { class: 'dep-list' },
        incoming.map((e) => dependencyRow(e, 'in', handlers)),
      ),
    );
  }

  const options = legalPredecessors(task.id);
  const select = el('select', { 'aria-label': 'Add a prerequisite' }, [
    el('option', {
      value: '',
      text: options.length ? 'Choose a prerequisite…' : 'No legal options left',
    }),
    ...options.map((t) => el('option', { value: t.id, text: `${t.key} — ${t.title}` })),
  ]);
  body.append(
    el('div', { class: 'inline-form' }, [
      select,
      el('button', {
        class: 'btn',
        type: 'button',
        text: 'Add',
        disabled: busy || options.length === 0,
        onclick: () => {
          if (select.value) handlers.onAddDependency(select.value, task.id);
        },
      }),
    ]),
    el('p', {
      class: 'field-hint',
      text:
        'Tasks that already depend on this one are omitted: adding them would close a loop. ' +
        'The server enforces the same rule, so a stale page cannot slip one through.',
    }),
  );

  body.append(el('p', { class: 'section-title', text: 'Blocks (waiting on this)' }));
  if (outgoing.length === 0) {
    body.append(el('p', { class: 'dep-empty', text: 'Nothing is waiting on this task.' }));
  } else {
    body.append(
      el(
        'ul',
        { class: 'dep-list' },
        outgoing.map((e) => dependencyRow(e, 'out', handlers)),
      ),
    );
  }
}

/** Renders the create-task form into the same drawer shell. */
export function openCreateDrawer(handlers) {
  activeTaskId = null;
  lastFocused = document.activeElement;
  const drawer = $('#drawer');
  drawer.hidden = false;
  drawer.setAttribute('aria-hidden', 'false');
  $('#drawer-key').textContent = 'New task';
  $('#drawer-title').textContent = 'Add a task';

  const body = clear($('#drawer-body'));
  const title = el('input', {
    type: 'text',
    id: 'n-title',
    maxLength: 200,
    placeholder: 'e.g. Wire up payment webhooks',
  });
  const desc = el('textarea', {
    id: 'n-desc',
    maxLength: 4000,
    placeholder: 'What has to be true for this to be done?',
  });
  const duration = el('input', { type: 'text', id: 'n-dur', value: '3', inputMode: 'numeric' });
  const stage = el('select', { id: 'n-stage' }, [
    el('option', { value: 'BACKLOG', text: 'Backlog' }),
    el('option', { value: 'IN_PROGRESS', text: 'In progress' }),
    el('option', { value: 'REVIEW', text: 'Review' }),
    el('option', { value: 'DONE', text: 'Done' }),
  ]);
  const depsSelect = el(
    'select',
    { id: 'n-deps', multiple: true, size: 6, 'aria-label': 'Prerequisites' },
    (state.board?.tasks ?? []).map((t) =>
      el('option', { value: t.id, text: `${t.key} — ${t.title}` }),
    ),
  );

  body.append(
    el('div', { class: 'field' }, [el('label', { text: 'Title', for: 'n-title' }), title]),
    el('div', { class: 'field' }, [el('label', { text: 'Description', for: 'n-desc' }), desc]),
    el('div', { class: 'field' }, [
      el('label', { text: 'Duration in days', for: 'n-dur' }),
      duration,
    ]),
    el('div', { class: 'field' }, [el('label', { text: 'Column', for: 'n-stage' }), stage]),
    el('div', { class: 'field' }, [
      el('label', { text: 'Depends on', for: 'n-deps' }),
      depsSelect,
      el('p', {
        class: 'field-hint',
        text: 'Hold Ctrl or Cmd to pick several. A new task cannot create a cycle, so every task is offered.',
      }),
    ]),
    el('div', { class: 'drawer-footer' }, [
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: 'Create task',
        onclick: () =>
          handlers.onCreate({
            title: title.value.trim(),
            description: desc.value,
            durationDays: Number(duration.value) || 1,
            stage: stage.value,
            dependsOn: [...depsSelect.selectedOptions].map((o) => o.value),
          }),
      }),
      el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: closeDrawer }),
    ]),
  );
  title.focus();
}
