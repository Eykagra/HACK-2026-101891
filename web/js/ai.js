/**
 * The AI panel.
 *
 * This panel is designed around a claim the project has to earn: *the engine
 * outranks the model.* So it shows both halves of the transaction.
 *
 *  - Accepted suggestions come with a confidence score, which models agreed,
 *    and the verbatim span of task text each one was derived from.
 *  - Rejected suggestions are shown too, with the engine's reason — the cycle it
 *    would have closed, the path that already implies it, the hallucinated key
 *    that does not exist. Hiding these would hide the most interesting thing
 *    the system does.
 *
 * Nothing here writes to the graph. Accept calls the same validated endpoint a
 * human dragging a dependency would hit.
 */

import { $, clear, el, plural } from './dom.js';
import { state } from './state.js';

const REASON_COPY = {
  CYCLE: 'Rejected: would create a circular dependency',
  REDUNDANT: 'Rejected: already implied by an existing path',
  DUPLICATE: 'Rejected: this dependency already exists',
  SELF_EDGE: 'Rejected: a task cannot block itself',
  UNKNOWN_TASK: 'Rejected: referenced a task that does not exist',
  LOW_CONFIDENCE: 'Rejected: below the confidence threshold',
  PREVIOUSLY_REJECTED: 'Rejected: a reviewer already declined this pair',
  UNVERIFIED_EVIDENCE: 'Rejected: the quoted justification is not in the task text',
};

const reasonOf = (filteredReason) => {
  const code = String(filteredReason ?? '').split(':')[0];
  return REASON_COPY[code] ?? 'Rejected by the dependency engine';
};
const detailOf = (filteredReason) =>
  String(filteredReason ?? '')
    .split(/:\s*/)
    .slice(1)
    .join(': ');

export function closeAiPanel() {
  const panel = $('#ai-panel');
  panel.hidden = true;
  panel.setAttribute('aria-hidden', 'true');
}

export function openAiPanel() {
  const panel = $('#ai-panel');
  panel.hidden = false;
  panel.setAttribute('aria-hidden', 'false');
}

function providerStatus(run) {
  const rows = [];
  const ai = state.board?.ai;

  if (ai) {
    rows.push(
      el('div', { class: 'ai-status-row' }, [
        el('span', { class: 'label', text: 'Mode' }),
        el('span', { text: ai.mode }),
      ]),
    );
  }

  for (const p of run.providers ?? []) {
    rows.push(
      el('div', { class: 'ai-status-row' }, [
        el('span', {
          class: 'label',
          text: `${p.provider} (${p.model})${p.fallback ? ' — fallback' : ''}`,
        }),
        el('span', {
          class: p.ok ? 'ok' : 'bad',
          text: p.ok ? `${p.count} proposed · ${p.latencyMs} ms` : (p.error ?? 'failed'),
        }),
      ]),
    );
  }

  if ((run.providers ?? []).length === 0 && ai) {
    rows.push(
      el('div', { class: 'ai-status-row' }, [
        el('span', { class: 'label', text: 'Providers' }),
        el('span', {
          text:
            ai.openaiConfigured || ai.geminiConfigured
              ? [ai.openaiConfigured && ai.openaiModel, ai.geminiConfigured && ai.geminiModel]
                  .filter(Boolean)
                  .join(' + ')
              : 'none configured — offline heuristic in use',
        }),
      ]),
    );
  }

  const counts = run.counts ?? {};
  if (counts.proposed !== undefined) {
    rows.push(
      el('div', { class: 'ai-status-row' }, [
        el('span', { class: 'label', text: 'Engine verdict' }),
        el('span', {
          text: `${counts.proposed} proposed → ${counts.accepted ?? 0} for review, ${counts.filtered ?? 0} blocked`,
        }),
      ]),
    );
  }

  return el('div', { class: 'ai-status' }, rows);
}

function suggestionCard(suggestion, handlers) {
  const busy = state.pending.has(suggestion.id);
  const highConfidence = suggestion.confidence >= 0.8;

  return el('article', { class: 'suggestion' }, [
    el('div', { class: 'suggestion-head' }, [
      el('span', { class: 'suggestion-pair' }, [
        suggestion.predecessorKey,
        el('span', { class: 'suggestion-arrow', text: ' → ' }),
        suggestion.successorKey,
      ]),
      el('span', {
        class: `confidence${highConfidence ? ' high' : ''}`,
        text: `${Math.round(suggestion.confidence * 100)}%`,
        title: 'Model confidence, plus a bonus when providers agreed independently.',
      }),
      suggestion.agreement >= 2
        ? el('span', { class: 'agreement', text: suggestion.agreementLabel })
        : el('span', { class: 'confidence', text: suggestion.agreementLabel }),
    ]),
    el('p', { class: 'suggestion-why', text: suggestion.rationale }),
    ...suggestion.evidence
      .filter(Boolean)
      .map((span) => el('p', { class: 'suggestion-evidence', text: `“${span}”` })),
    el('div', { class: 'suggestion-actions' }, [
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: busy ? 'Validating…' : 'Accept',
        disabled: busy,
        onclick: () => handlers.onAccept(suggestion),
      }),
      el('button', {
        class: 'btn',
        type: 'button',
        text: 'Reject',
        disabled: busy,
        onclick: () => handlers.onReject(suggestion),
      }),
    ]),
    el('p', {
      class: 'field-hint',
      text: 'Accepting re-runs the full cycle check before anything is written.',
    }),
  ]);
}

function filteredCard(suggestion) {
  return el('article', { class: 'suggestion is-filtered' }, [
    el('div', { class: 'suggestion-head' }, [
      el('span', { class: 'suggestion-pair' }, [
        suggestion.predecessorKey,
        el('span', { class: 'suggestion-arrow', text: ' → ' }),
        suggestion.successorKey,
      ]),
      el('span', { class: 'confidence', text: `${Math.round(suggestion.confidence * 100)}%` }),
    ]),
    el('p', { class: 'suggestion-why', text: suggestion.rationale }),
    el('p', { class: 'suggestion-reason', text: reasonOf(suggestion.filteredReason) }),
    detailOf(suggestion.filteredReason)
      ? el('p', { class: 'field-hint', text: detailOf(suggestion.filteredReason) })
      : null,
  ]);
}

/**
 * @param {{ pending: any[], filtered: any[], providers: any[], counts: object, degraded?: boolean, latencyMs?: number }} run
 */
export function renderAiPanel(run, handlers) {
  const body = clear($('#ai-body'));

  body.append(
    el('div', { class: 'explainer' }, [
      el('strong', { text: 'The model proposes. The engine decides. You approve.' }),
      'Every suggestion below was checked against the live dependency graph before you saw it: ' +
        'hallucinated task ids, duplicates, transitively redundant edges and anything that would ' +
        'create a cycle are blocked automatically. Accepting still runs the full validation again, ' +
        'so a suggestion that has gone stale is refused rather than written.',
    ]),
    providerStatus(run),
  );

  if (run.degraded) {
    body.append(
      el('p', {
        class: 'suggestion-reason',
        text: 'At least one provider failed, so these results are partial or came from the offline heuristic.',
      }),
    );
  }

  body.append(
    el('p', { class: 'section-title', text: `Awaiting your decision (${run.pending.length})` }),
  );
  if (run.pending.length === 0) {
    body.append(
      el('p', {
        class: 'dep-empty',
        text: 'Nothing pending. Run “Suggest dependencies” to ask the models for ideas.',
      }),
    );
  }
  for (const suggestion of run.pending) body.append(suggestionCard(suggestion, handlers));

  if (run.filtered.length > 0) {
    body.append(
      el('p', {
        class: 'section-title',
        text: `Blocked by the dependency engine (${run.filtered.length})`,
      }),
      el('p', {
        class: 'field-hint',
        style: 'margin:-4px 0 12px',
        text: 'Shown deliberately. These never reached the graph and cannot be accepted.',
      }),
    );
    for (const suggestion of run.filtered) body.append(filteredCard(suggestion));
  }

  if (run.latencyMs) {
    body.append(
      el('p', {
        class: 'field-hint',
        text: `Round trip ${run.latencyMs} ms · prompt ${run.promptVersion}`,
      }),
    );
  }
}

/** Shows the grounded narrative returned alongside a mutation. */
export function narrativeToastBody(narrative) {
  if (!narrative) return null;
  const suffix =
    narrative.source === 'template'
      ? narrative.fallbackReason
        ? ` (${narrative.fallbackReason})`
        : ''
      : ` — written by ${narrative.source}, figures verified against the engine`;
  return `${narrative.text}${suffix}`;
}

export { plural };
