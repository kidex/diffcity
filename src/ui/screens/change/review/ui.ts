// The review actions of the change screen (SPEC.md section 6, ADR-028): the
// mark bars on the selection card and in the file view's header, the keys C G
// W U on the selected file or focused floor, the "Needs rewrite" dialog and
// the review summary. The state and the writes are the controller's; this puts
// them in front of the reviewer. Only built when the screen has a ReviewPort.

import type { Report } from '../../../../core/report/types.js';
import type { ReviewMarkValue } from '../../../../core/model/types.js';
import { markOf, targetFor } from '../model/review.js';
import type { TargetInfo } from '../model/review.js';
import type { LineRange } from '../panel/fileview/view.js';
import type { ReviewController } from './controller.js';
import type { MarkBar } from './controls.js';
import { createMarkBar } from './controls.js';
import type { Dialog } from './dialog.js';
import { openRewriteDialog } from './rewrite.js';
import type { SummaryDialog } from './summary.js';
import { openSummaryDialog } from './summary.js';

export interface ReviewUiOptions {
  controller: ReviewController;
  report(): Report | null;
  /** The selected building and focused floor, or null. */
  selection(): { fileId: string; symbolId: string | null } | null;
  /** The line range selected in the open file's diff. */
  range(): { fileId: string; range: LineRange } | null;
}

export interface ReviewUi {
  /** Puts a mark bar for the file (and focused floor) into `slot`; calling it again for the same slot updates it. */
  fill(slot: HTMLElement, fileId: string, symbolId: string | null): void;
  /** The review state changed: every bar and the open summary are brought up to date. */
  refresh(): void;
  openSummary(trigger: Element | null): void;
  dispose(): void;
}

const isEditable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement);

interface Slot {
  bar: MarkBar;
  fileId: string;
  symbolId: string | null;
}

export function createReviewUi(options: ReviewUiOptions): ReviewUi {
  const { controller } = options;
  const slots = new Map<HTMLElement, Slot>();
  /** The selection the reviewer chose "This file" for while a floor is focused: another floor or file goes back to the floor. */
  let whole: { fileId: string; symbolId: string | null } | null = null;
  let rewrite: Dialog | null = null;
  let summary: SummaryDialog | null = null;

  const targetOf = (fileId: string, symbolId: string | null): TargetInfo | null => {
    const report = options.report();
    const chosen = whole !== null && whole.fileId === fileId && whole.symbolId === symbolId;
    return report === null ? null : targetFor(report, fileId, symbolId, chosen);
  };

  function mark(info: TargetInfo, value: Exclude<ReviewMarkValue, 'rewrite'>): void {
    void controller.mark(info.target, info.filePath, value);
  }

  function askRewrite(info: TargetInfo, fileId: string): void {
    if (rewrite !== null || summary !== null) return;
    const existing = markOf(controller.state(), info.target);
    // The file view's line selection, when it is in this file; else the range the mark already has.
    const selected = options.range();
    const lines = selected !== null && selected.fileId === fileId ? selected.range : (existing?.lines ?? null);
    rewrite = openRewriteDialog({
      info,
      note: existing?.mark === 'rewrite' ? (existing.note ?? '') : '',
      lines,
      returnFocus: document.activeElement,
      onSave: (note, range) => {
        void controller.mark(info.target, info.filePath, 'rewrite', { note, ...(range === undefined ? {} : { lines: range }) });
      },
      onClose: () => {
        rewrite = null;
      },
    });
  }

  function undo(info: TargetInfo): void {
    void controller.clear(info.target);
  }

  function render(slot: HTMLElement, entry: Slot): void {
    const state = controller.state();
    slot.hidden = state === null;
    if (state === null) return;
    const info = targetOf(entry.fileId, entry.symbolId);
    const own = info === null ? undefined : markOf(state, info.target);
    const inherited = info !== null && info.symbol ? markOf(state, { kind: 'file', id: entry.fileId }) : undefined;
    entry.bar.set(info, own, inherited);
  }

  function fill(slot: HTMLElement, fileId: string, symbolId: string | null): void {
    let entry = slots.get(slot);
    if (entry === undefined) {
      const created: Slot = {
        fileId,
        symbolId,
        bar: createMarkBar({
          onMark: (value) => {
            const info = targetOf(created.fileId, created.symbolId);
            if (info !== null) mark(info, value);
          },
          onRewrite: () => {
            const info = targetOf(created.fileId, created.symbolId);
            if (info !== null) askRewrite(info, created.fileId);
          },
          onUndo: () => {
            const info = targetOf(created.fileId, created.symbolId);
            if (info !== null) undo(info);
          },
          onScope: (wholeFile) => {
            whole = wholeFile ? { fileId: created.fileId, symbolId: created.symbolId } : null;
            api.refresh();
          },
        }),
      };
      entry = created;
      slots.set(slot, entry);
      slot.replaceChildren(entry.bar.root);
    }
    entry.fileId = fileId;
    entry.symbolId = symbolId;
    render(slot, entry);
  }

  const keys = new AbortController();
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) return;
      const key = event.key.toLowerCase();
      if (key !== 'c' && key !== 'g' && key !== 'w' && key !== 'u') return;
      const selected = options.selection();
      if (selected === null || controller.state() === null) return;
      const info = targetOf(selected.fileId, selected.symbolId);
      if (info === null) return;
      event.preventDefault();
      if (key === 'c') mark(info, 'checked');
      else if (key === 'g') mark(info, 'good');
      else if (key === 'w') askRewrite(info, selected.fileId);
      else undo(info);
    },
    { signal: keys.signal },
  );

  const api: ReviewUi = {
    fill,
    refresh() {
      for (const [slot, entry] of slots) {
        if (slot.isConnected) render(slot, entry);
        else slots.delete(slot);
      }
      summary?.refresh();
    },
    openSummary(trigger) {
      if (summary !== null || rewrite !== null) return;
      summary = openSummaryDialog(controller, trigger ?? document.activeElement, () => {
        summary = null;
      });
    },
    dispose() {
      keys.abort();
      rewrite?.close();
      summary?.dialog.close();
      slots.clear();
    },
  };
  return api;
}
