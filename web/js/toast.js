/**
 * Toasts and the live region.
 *
 * Toast copy is generated from the engine diff, not hand-written per action, so
 * the user is told the *consequence* ("4 tasks moved, project finish +2 days")
 * rather than the mechanic ("task updated"). Errors are phrased as refusals
 * with reasons, because "why can't I do this" is the question a rejection
 * actually raises.
 */

import { $, clear, el, plural } from './dom.js';

const MAX_VISIBLE = 4;

/** @param {string} message */
export function announce(message) {
  const region = $('#live');
  if (!region) return;
  // Re-announce identical text by clearing first; some screen readers dedupe.
  clear(region);
  region.textContent = message;
}

/**
 * @param {{ title: string, body?: string, kind?: 'ok'|'warn'|'error'|'info', ms?: number }} options
 */
export function toast({ title, body, kind = 'info', ms }) {
  const host = $('#toasts');
  if (!host) return;
  while (host.children.length >= MAX_VISIBLE) host.firstElementChild?.remove();

  const node = el('div', { class: `toast is-${kind}`, role: 'alert' }, [
    el('p', { class: 'toast-title', text: title }),
    body ? el('p', { class: 'toast-body', text: body }) : null,
  ]);
  host.append(node);
  announce(body ? `${title}. ${body}` : title);

  // Errors stay until dismissed; a rejection the user missed is a bug report.
  const lifetime = ms ?? (kind === 'error' ? 9000 : 5000);
  setTimeout(() => node.remove(), lifetime);
  node.addEventListener('click', () => node.remove());
}

/**
 * Turns a schedule diff into consequence-first copy.
 * @param {string} action
 * @param {{ changed: any[], projectFinishDeltaDays: number }} diff
 * @param {Map<string,string>} keyOf
 */
export function toastDiff(action, diff, keyOf) {
  const moved = diff.changed.filter((d) => d.startDeltaDays !== 0 || d.endDeltaDays !== 0);
  const blocked = diff.changed.filter(
    (d) => d.depStateBefore === 'READY' && d.depStateAfter === 'BLOCKED',
  );
  const unblocked = diff.changed.filter(
    (d) => d.depStateBefore === 'BLOCKED' && d.depStateAfter === 'READY',
  );

  const bits = [];
  if (moved.length > 0) {
    const keys = moved.map((d) => keyOf.get(d.id) ?? d.id);
    const shown = keys.slice(0, 5).join(', ');
    bits.push(
      `${plural(moved.length, 'task')} rescheduled: ${shown}${keys.length > 5 ? `, +${keys.length - 5} more` : ''}`,
    );
  }
  if (unblocked.length > 0) {
    bits.push(`unblocked ${unblocked.map((d) => keyOf.get(d.id) ?? d.id).join(', ')}`);
  }
  if (blocked.length > 0) {
    bits.push(`now blocked: ${blocked.map((d) => keyOf.get(d.id) ?? d.id).join(', ')}`);
  }
  if (diff.projectFinishDeltaDays !== 0) {
    const n = diff.projectFinishDeltaDays;
    bits.push(`project finish ${n > 0 ? '+' : '−'}${plural(Math.abs(n), 'day')}`);
  }

  toast({
    title: action,
    body: bits.length > 0 ? `${bits.join(' · ')}.` : 'No downstream impact.',
    kind: diff.projectFinishDeltaDays > 0 ? 'warn' : 'ok',
  });
}

/**
 * Renders an API failure as an explained refusal.
 * @param {import('./api.js').ApiError} error
 */
export function toastError(error) {
  const bodies = {
    CYCLE_DETECTED: () => {
      const path = (error.problem.cycleKeys ?? []).join(' → ');
      return path
        ? `That would create the loop ${path}. Nothing was changed.`
        : `${error.message} Nothing was changed.`;
    },
    VALIDATION_FAILED: () => {
      const issues = error.problem.issues ?? [];
      return issues.length > 0
        ? issues
            .map((i) => `${i.path}: ${i.message}`)
            .slice(0, 3)
            .join('; ')
        : error.message;
    },
    STALE_WRITE: () =>
      'This task was changed somewhere else. Reload to see the current version, then retry.',
    RATE_LIMITED: () =>
      `Slow down for ${plural(error.problem.retryAfterSeconds ?? 60, 'second')} and try again.`,
    AI_UNAVAILABLE: () => `${error.message} The board itself is unaffected.`,
  };

  toast({
    title: error.title,
    body: (bodies[error.code] ?? (() => error.message))(),
    kind: error.code === 'CYCLE_DETECTED' || error.status >= 500 ? 'error' : 'warn',
  });
}
