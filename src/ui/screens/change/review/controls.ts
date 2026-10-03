// The mark buttons of one place (the selection card, the file view's header):
// Checked, Looks good, Needs rewrite and Undo for a target, with what the
// target is marked now: the mark, its note and line range, and "changed since
// you checked it" for a mark that went outdated (ADR-028). It draws what it is
// given and reports clicks; the screen decides what a click does. Text goes in
// through textContent: notes are the reviewer's, file and symbol names the
// repo's.

import type { ReviewMark, ReviewMarkValue } from '../../../../core/model/types.js';
import { h } from '../../../shared/dom.js';
import { linesText, MARK_KEY, MARK_LABEL, OUTDATED_HINT } from '../model/review.js';
import type { TargetInfo } from '../model/review.js';

export interface MarkBarActions {
  onMark(mark: Exclude<ReviewMarkValue, 'rewrite'>): void;
  onRewrite(): void;
  onUndo(): void;
  /** The reviewer chose the whole file (true) or the focused floor (false) as the target. */
  onScope(wholeFile: boolean): void;
}

export interface MarkBar {
  root: HTMLElement;
  /**
   * Shows `info` as the target (null: nothing can be marked), its own `mark`,
   * and `inherited`: the mark of the file when the target is one of its floors.
   */
  set(info: TargetInfo | null, mark: ReviewMark | undefined, inherited: ReviewMark | undefined): void;
}

const VALUES: ReviewMarkValue[] = ['checked', 'good', 'rewrite'];

export function createMarkBar(actions: MarkBarActions): MarkBar {
  const caption = h('div', { class: 'rv-caption', 'data-testid': 'mark-target' });
  const buttons = new Map<string, HTMLButtonElement>();
  const make = (key: string, label: string, shortcut: string, click: () => void): HTMLButtonElement => {
    const button = h(
      'button',
      { type: 'button', class: `rv-btn ${key}`, 'data-testid': `mark-${key}`, 'aria-keyshortcuts': shortcut, onclick: click },
      label,
      h('span', { class: 'k', 'aria-hidden': 'true' }, shortcut),
    );
    buttons.set(key, button);
    return button;
  };
  const row = h(
    'div',
    { class: 'rv-buttons', role: 'group', 'aria-label': 'Review mark' },
    VALUES.map((value) =>
      make(value, MARK_LABEL[value], MARK_KEY[value], () => {
        if (value === 'rewrite') actions.onRewrite();
        else actions.onMark(value);
      }),
    ),
    make('undo', 'Undo', 'U', () => {
      actions.onUndo();
    }),
  );
  const fileScope = h('button', { type: 'button', class: 'rv-scope-btn', 'data-testid': 'mark-scope-file', onclick: () => { actions.onScope(true); } }, 'This file');
  const floorScope = h('button', { type: 'button', class: 'rv-scope-btn', 'data-testid': 'mark-scope-floor', onclick: () => { actions.onScope(false); } });
  const scope = h('div', { class: 'rv-scope', role: 'group', 'aria-label': 'What to mark', 'data-testid': 'mark-scope' }, fileScope, floorScope);
  scope.hidden = true;
  const status = h('div', { class: 'rv-status', 'data-testid': 'mark-status', 'aria-live': 'polite' });
  const root = h('div', { class: 'rv-bar', 'data-testid': 'mark-bar' }, caption, scope, row, status);

  function describe(mark: ReviewMark | undefined, inherited: ReviewMark | undefined): (HTMLElement | string)[] {
    if (mark === undefined) {
      return inherited === undefined
        ? [h('span', { class: 'rv-none', 'data-testid': 'mark-none' }, 'Not marked')]
        : [
            h(
              'span',
              { class: 'rv-inherited', 'data-testid': 'mark-inherited' },
              `The file is marked ${MARK_LABEL[inherited.mark]}${inherited.state === 'outdated' ? `, ${OUTDATED_HINT}` : ''}`,
            ),
          ];
    }
    const parts: (HTMLElement | string)[] = [h('b', { class: `rv-mark ${mark.mark}`, 'data-testid': 'mark-current', 'data-mark': mark.mark }, MARK_LABEL[mark.mark])];
    if (mark.lines !== null) parts.push(h('span', { class: 'rv-lines', 'data-testid': 'mark-lines' }, linesText(mark.lines)));
    if (mark.state === 'outdated') parts.push(h('span', { class: 'rv-outdated', 'data-testid': 'mark-outdated' }, OUTDATED_HINT));
    if (mark.note !== null && mark.note !== '') parts.push(h('p', { class: 'rv-note', 'data-testid': 'mark-note' }, mark.note));
    return parts;
  }

  return {
    root,
    set(info, mark, inherited) {
      const marked = info !== null;
      scope.hidden = info?.floor == null;
      if (info?.floor != null) {
        floorScope.textContent = `Floor ${info.floor.name}`;
        fileScope.setAttribute('aria-pressed', String(!info.symbol));
        floorScope.setAttribute('aria-pressed', String(info.symbol));
        fileScope.classList.toggle('on', !info.symbol);
        floorScope.classList.toggle('on', info.symbol);
      }
      caption.textContent = info === null ? 'Untouched files cannot be marked' : info.symbol ? `Mark floor ${info.label}` : 'Mark this file';
      for (const [key, button] of buttons) {
        const own = mark?.mark === key && mark.state === 'current';
        button.disabled = !marked || (key === 'undo' && mark === undefined);
        button.setAttribute('aria-pressed', key === 'undo' ? 'false' : String(own));
        button.classList.toggle('on', own);
      }
      status.replaceChildren(...(marked ? describe(mark, inherited) : []));
    },
  };
}
