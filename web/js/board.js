/**
 * The Kanban board.
 *
 * Two things here are worth more than the drag-and-drop:
 *
 *  - Every card shows its *derived* facts — scheduled dates, blocked state,
 *    slack, critical-path membership, and which prerequisites are unmet. A card
 *    that says "Blocked" without saying by what is a dead end for the user.
 *  - Drag-and-drop is not the only way to move a task. Each card carries
 *    keyboard-operable ◀ ▶ buttons, because HTML5 drag events are unusable with
 *    a keyboard or a screen reader and a board you can only operate with a mouse
 *    excludes people for no good reason.
 */

import { clear, dateRange, el, plural, shortDate } from './dom.js';
import { state, tasks } from './state.js';

export const STAGES = [
  { id: 'BACKLOG', label: 'Backlog' },
  { id: 'IN_PROGRESS', label: 'In progress' },
  { id: 'REVIEW', label: 'Review' },
  { id: 'DONE', label: 'Done' },
];

const stageIndex = (id) => STAGES.findIndex((s) => s.id === id);

/**
 * @param {object} task
 * @param {{ onOpen: (task: any) => void, onMove: (task: any, stage: string) => void }} handlers
 */
function renderCard(task, handlers) {
  const classes = ['card'];
  if (task.isCritical) classes.push('is-critical');
  if (task.isPolicyViolation) classes.push('is-violation');
  if (state.highlight.has(task.id)) classes.push('just-changed');

  const badges = [
    task.depState === 'BLOCKED'
      ? el('span', { class: 'badge badge-blocked', text: 'Blocked' })
      : el('span', { class: 'badge badge-ready', text: 'Ready' }),
    task.isCritical ? el('span', { class: 'badge badge-critical', text: 'Critical path' }) : null,
    task.isPolicyViolation
      ? el('span', {
          class: 'badge badge-violation',
          text: 'Policy violation',
          title: 'This task is blocked but has been moved out of Backlog.',
        })
      : null,
    task.isPinned ? el('span', { class: 'badge badge-pinned', text: 'Pinned' }) : null,
    !task.isCritical && task.slackDays > 0
      ? el('span', {
          class: 'badge badge-slack',
          text: `${plural(task.slackDays, 'day')} slack`,
          title: `This task can slip ${plural(task.slackDays, 'day')} before the project finish moves.`,
        })
      : null,
  ].filter(Boolean);

  const current = stageIndex(task.stage);

  const card = el(
    'article',
    {
      class: classes.join(' '),
      draggable: true,
      tabIndex: 0,
      role: 'button',
      dataset: { taskId: task.id },
      'aria-label':
        `${task.key}: ${task.title}. ${task.depState === 'BLOCKED' ? 'Blocked' : 'Ready'}. ` +
        `Scheduled ${task.scheduledStart} to ${task.scheduledEnd}.` +
        (task.isCritical
          ? ' On the critical path.'
          : ` ${plural(task.slackDays, 'day')} of slack.`),
      onclick: (event) => {
        if (event.target.closest('.card-move')) return;
        handlers.onOpen(task);
      },
      onkeydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          handlers.onOpen(task);
        }
      },
    },
    [
      el('div', { class: 'card-top' }, [
        el('span', { class: 'card-key', text: task.key }),
        ...badges,
      ]),
      el('h3', { class: 'card-title', text: task.title }),
      el('div', { class: 'card-meta' }, [
        el('span', {
          text: dateRange(task.scheduledStart, task.scheduledEnd),
          title: 'Computed by the scheduler from durations and dependencies; not editable.',
        }),
        el('span', { text: plural(task.durationDays, 'day') }),
        task.assignee ? el('span', { text: task.assignee }) : null,
      ]),
      task.unmetPrereqKeys.length > 0
        ? el('p', { class: 'card-blockers' }, [
            'Waiting on ',
            el('code', { text: task.unmetPrereqKeys.join(', ') }),
          ])
        : null,
      // The keyboard-accessible alternative to dragging.
      el('div', { class: 'card-move' }, [
        el('button', {
          type: 'button',
          text: '◀ Back',
          disabled: current <= 0,
          'aria-label': `Move ${task.key} to ${STAGES[current - 1]?.label ?? ''}`,
          onclick: () => handlers.onMove(task, STAGES[current - 1].id),
        }),
        el('button', {
          type: 'button',
          text: 'Forward ▶',
          disabled: current >= STAGES.length - 1,
          'aria-label': `Move ${task.key} to ${STAGES[current + 1]?.label ?? ''}`,
          onclick: () => handlers.onMove(task, STAGES[current + 1].id),
        }),
      ]),
    ],
  );

  card.addEventListener('dragstart', (event) => {
    event.dataTransfer.setData('text/plain', task.id);
    event.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));

  return card;
}

/**
 * @param {HTMLElement} host
 * @param {{ onOpen: Function, onMove: Function, onDrop: (taskId: string, stage: string, beforeTaskId: string|null) => void }} handlers
 */
export function renderBoard(host, handlers) {
  clear(host);
  const all = tasks();

  for (const stage of STAGES) {
    const inStage = all
      .filter((t) => t.stage === stage.id)
      .sort((a, b) => a.position.localeCompare(b.position) || a.key.localeCompare(b.key));

    const list = el('div', {
      class: 'column-list',
      role: 'list',
      'aria-label': `${stage.label} tasks`,
    });

    if (inStage.length === 0) {
      list.append(el('p', { class: 'column-empty', text: 'Nothing here yet.' }));
    }
    for (const task of inStage) {
      const card = renderCard(task, handlers);
      card.setAttribute('role', 'listitem');
      list.append(card);
    }

    const column = el('section', { class: 'column', dataset: { stage: stage.id } }, [
      el('div', { class: 'column-head' }, [
        el('h2', { text: stage.label }),
        el('span', { class: 'column-count', text: String(inStage.length) }),
      ]),
      list,
    ]);

    column.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      column.classList.add('drag-over');
    });
    column.addEventListener('dragleave', (event) => {
      // Ignore transitions between child nodes of the same column.
      if (!column.contains(event.relatedTarget)) column.classList.remove('drag-over');
    });
    column.addEventListener('drop', (event) => {
      event.preventDefault();
      column.classList.remove('drag-over');
      const taskId = event.dataTransfer.getData('text/plain');
      if (!taskId) return;
      // Insert before whichever card the pointer is over, so ordering within a
      // column is under the user's control rather than always appending.
      const overCard = event.target.closest?.('.card');
      const beforeTaskId =
        overCard && overCard.dataset.taskId !== taskId ? overCard.dataset.taskId : null;
      handlers.onDrop(taskId, stage.id, beforeTaskId);
    });

    host.append(column);
  }
}

/** @param {HTMLElement} host */
export function renderMetrics(board) {
  const set = (id, value) => {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  };
  if (!board) return;
  set(
    'm-window',
    `${shortDate(board.board.projectStart)} → ${shortDate(board.board.projectFinish)}`,
  );
  set('m-duration', plural(board.stats.durationDays, 'day'));
  set('m-blocked', String(board.stats.blocked));
  set('m-ready', String(board.stats.ready));
  set('m-critical', `${board.stats.criticalCount} of ${board.stats.total}`);
}
