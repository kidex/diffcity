// The action buttons of the finding cards (ADR-036): "Ask agent to fix",
// which turns into "Queued", "Mark as intended" and, for a finding marked in
// this session, "Undo". Holds what the session did (queued keys, marked keys,
// requests in flight, written states the Report has not shown yet, the line
// under a refused action) and calls the FindingsPort. The card's state, the
// pins and the verdict outlines come from the Report the route refetches after
// a write: nothing here changes them. Every text from the Report or the daemon
// goes in through textContent or an attribute.

import type { Finding, Report } from '../../../../core/report/types.js';
import { h } from '../../../shared/dom.js';
import type { ActionsView, FindingAction } from '../model/findings.js';
import { ACTION_FAILED, actionName, actionsView, QUEUED } from '../model/findings.js';
import type { FindingsPort } from '../ports.js';

export interface FindingActions {
  /** Draws the buttons of `finding` into its card's slot; buttons already there are updated in place, so the focus stays. */
  fill(slot: HTMLElement, finding: Finding): void;
  /** The buttons `finding`'s card offers now (what fill() draws). */
  view(finding: Pick<Finding, 'id' | 'state'>): ActionsView;
  /** Runs an action as its button does; resolves once the daemon answered (or did not). */
  act(action: FindingAction, finding: Pick<Finding, 'id'>): Promise<void>;
  /**
   * A new Report is about to be shown; `startedAt` is when its fetch began
   * (`performance.now()`), null when unknown. A written state is settled when
   * the Report shows it, no longer has the finding, or was fetched after the
   * write was answered: whatever that Report says is the daemon's word, so a
   * card never stays inert for good.
   */
  sync(report: Report, startedAt: number | null): void;
  /** Calls `listener` when the buttons must be drawn again (a request started or ended). */
  onChange(listener: () => void): () => void;
  dispose(): void;
}

export function createFindingActions(port: FindingsPort): FindingActions {
  const queued = new Set<string>();
  const marked = new Set<string>();
  const pending = new Map<string, FindingAction>();
  const expected = new Map<string, 'open' | 'intended'>();
  /** When the write behind each expected state was answered (`performance.now()`). */
  const answeredAt = new Map<string, number>();
  const errors = new Map<string, string>();
  const session = { queued, marked, pending, expected, errors };
  const listeners = new Set<() => void>();
  let disposed = false;

  const emit = (): void => {
    if (disposed) return;
    for (const listener of [...listeners]) listener();
  };

  async function run(action: FindingAction, finding: Pick<Finding, 'id'>): Promise<void> {
    const key = finding.id;
    errors.delete(key);
    pending.set(key, action);
    emit();
    try {
      if (action === 'ask') {
        const answer = await port.ask(key);
        // `queued: false` means the queue had it already: queued all the same.
        if (answer.ok) queued.add(key).add(answer.value.key);
        else errors.set(key, answer.refusal.message);
      } else {
        const state = action === 'intend' ? 'intended' : 'open';
        const answer = await port.setState(key, state);
        if (answer.ok) {
          if (state === 'intended') marked.add(key);
          else marked.delete(key);
          expected.set(key, state);
          answeredAt.set(key, answer.at);
        } else {
          errors.set(key, answer.refusal.message);
        }
      }
    } catch {
      errors.set(key, ACTION_FAILED);
    } finally {
      pending.delete(key);
    }
    emit();
  }

  function button(action: FindingAction): HTMLButtonElement {
    return h('button', { type: 'button', 'data-action': action, 'data-testid': `finding-${action}` });
  }

  // While a written state has not come back in the Report, the card offers what it will offer then, inert.
  const viewOf = (finding: Pick<Finding, 'id' | 'state'>): ActionsView => actionsView({ id: finding.id, state: expected.get(finding.id) ?? finding.state }, session);

  return {
    view: viewOf,
    act: run,
    fill(slot, finding) {
      const view = viewOf(finding);
      const hadFocus = document.activeElement !== null && slot.contains(document.activeElement);
      const existing = new Map<string, HTMLButtonElement>();
      for (const node of slot.querySelectorAll<HTMLButtonElement>('button[data-action]')) existing.set(node.dataset['action'] ?? '', node);
      const buttons = view.buttons.map((spec) => {
        const node = existing.get(spec.action) ?? button(spec.action);
        node.textContent = spec.label;
        node.classList.toggle('queued', spec.label === QUEUED);
        node.setAttribute('aria-label', actionName(spec, finding.title));
        if (spec.disabled) node.setAttribute('aria-disabled', 'true');
        else node.removeAttribute('aria-disabled');
        node.onclick = (event) => {
          event.stopPropagation();
          if (node.getAttribute('aria-disabled') === 'true') return;
          void run(spec.action, finding);
        };
        return node;
      });
      // The line is kept while its text stays, so the alert is read once.
      let error = slot.querySelector<HTMLElement>('.fix-error');
      if (view.error === null) error = null;
      else if (error === null || error.textContent !== view.error) error = h('p', { class: 'fix-error', role: 'alert', 'data-testid': 'finding-error' }, view.error);
      // Children are moved only when they must: removing the focused button, even to put it back, would drop the focus.
      const wanted: HTMLElement[] = error === null ? buttons : [...buttons, error];
      for (const child of [...slot.children]) if (!wanted.includes(child as HTMLElement)) child.remove();
      wanted.forEach((node, index) => {
        if (slot.children[index] !== node) slot.insertBefore(node, slot.children[index] ?? null);
      });
      slot.hidden = buttons.length === 0 && error === null;
      // The focused button went away (Mark as intended became Undo): the focus moves to the card's first button.
      if (hadFocus && !slot.contains(document.activeElement)) buttons[0]?.focus({ preventScroll: true });
    },
    sync(report, startedAt) {
      if (expected.size === 0) return;
      const states = new Map(report.findings.map((finding) => [finding.id, finding.state]));
      for (const [key, state] of expected) {
        const now = states.get(key);
        const fresh = startedAt !== null && startedAt >= (answeredAt.get(key) ?? Number.POSITIVE_INFINITY);
        if (now === undefined || now === state || fresh) {
          expected.delete(key);
          answeredAt.delete(key);
        }
      }
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
