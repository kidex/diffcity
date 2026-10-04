// The review state of the open change and the writes that change it (ADR-028).
// Holds what the ReviewPort last said (marks, general note, progress), answers
// a mark at once and puts the old state back when the daemon refuses
// (optimistic update with rollback), refetches when the daemon says the marks
// moved (a write from another tab, a new snapshot, a reconnect) and when a
// mark lost the race with a new snapshot (409 `snapshot-moved`). Nothing is
// computed here: progress, outdated flags and the summary are the daemon's.
// No DOM; the screen draws from state() and is told through onChange().

import type { ReviewMark, ReviewMarkValue } from '../../../../core/model/types.js';
import { restored, withMark, withoutMark } from '../model/review.js';
import type { ReviewTarget } from '../model/review.js';
import type { MarkRequest, ReviewPort, ReviewState } from '../ports.js';

export const SNAPSHOT_MOVED = 'This change has a newer snapshot than the one you marked. The marks were refreshed: look again and mark it once more.';
export const NOT_IN_SNAPSHOT = 'That file or symbol is not in the latest snapshot any more. The marks were refreshed.';
export const ARCHIVED = 'This change is archived: its marks can no longer be changed.';

export interface ReviewControllerOptions {
  port: ReviewPort;
  /** Tells the reviewer something went wrong (a toast). */
  toast(text: string): void;
  now?: () => string;
}

export interface MarkExtras {
  note?: string;
  lines?: { side: 'old' | 'new'; start: number; end: number };
}

export interface ReviewController {
  /** What the daemon last said, with writes in flight applied; null while the change has no snapshot or the first answer has not come. */
  state(): ReviewState | null;
  mark(target: ReviewTarget, filePath: string, mark: ReviewMarkValue, extras?: MarkExtras): Promise<boolean>;
  clear(target: ReviewTarget): Promise<boolean>;
  saveNote(note: string): Promise<boolean>;
  /** The markdown summary; null while there is no snapshot. */
  summary(signal?: AbortSignal): Promise<string | null>;
  refresh(): Promise<void>;
  /** Calls `listener` whenever state() changed. */
  onChange(listener: () => void): () => void;
  dispose(): void;
}

/** The status and code of a rejected port call (the SPA's ApiRequestError), without importing it. */
function failure(error: unknown): { status: number | null; code: string | null; message: string } {
  if (typeof error !== 'object' || error === null) return { status: null, code: null, message: String(error) };
  const { status, code, message } = error as { status?: unknown; code?: unknown; message?: unknown };
  return {
    status: typeof status === 'number' ? status : null,
    code: typeof code === 'string' ? code : null,
    message: typeof message === 'string' ? message : 'request failed',
  };
}

export function createReviewController(options: ReviewControllerOptions): ReviewController {
  const port = options.port;
  const now = options.now ?? ((): string => new Date().toISOString());
  const listeners = new Set<() => void>();
  let state: ReviewState | null = null;
  let disposed = false;
  let loading: AbortController | null = null;
  /** Writes in flight: an answer to a read that started before them could undo their optimistic state, so reads wait. */
  let writing = 0;
  let stale = false;

  // Read after an await: the closure may have changed them meanwhile, which a narrowed `let` would hide from the compiler.
  const current = (): ReviewState | null => state;
  const gone = (): boolean => disposed;
  const writes = (): number => writing;

  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };

  function set(next: ReviewState | null): void {
    state = next;
    emit();
  }

  async function refresh(): Promise<void> {
    if (disposed) return;
    if (writing > 0) {
      stale = true;
      return;
    }
    loading?.abort();
    const request = new AbortController();
    loading = request;
    try {
      const next = await port.load(request.signal);
      if (request.signal.aborted || gone() || writes() > 0) {
        if (!gone() && writes() > 0) stale = true;
        return;
      }
      set(next);
    } catch {
      // Keep what is on screen: the daemon indicator says why it is stale; the next event or reconnect reads again.
    }
  }

  async function write<T>(optimistic: ReviewState | null, task: () => Promise<T>, undo: () => void): Promise<T | null> {
    if (optimistic !== null) set(optimistic);
    writing += 1;
    try {
      return await task();
    } catch (error) {
      undo();
      const { status, code, message } = failure(error);
      if (status === 409 && code === 'snapshot-moved') options.toast(SNAPSHOT_MOVED);
      else if (status === 404 && code === 'target-not-found') options.toast(NOT_IN_SNAPSHOT);
      else if (status === 409 && code === 'archived') options.toast(ARCHIVED);
      else options.toast(`The review change was not saved: ${message}`);
      stale = true;
      return null;
    } finally {
      writing -= 1;
      if (writes() === 0 && stale) {
        stale = false;
        void refresh();
      }
    }
  }

  const stop = port.onChange(() => {
    void refresh();
  });
  void refresh();

  return {
    state: () => state,
    async mark(target, filePath, mark, extras = {}) {
      if (state === null || disposed) return false;
      const request: MarkRequest = { snapshotId: state.snapshotId, target, mark, ...extras };
      const before = state.marks.find((other) => other.targetKind === target.kind && other.targetId === target.id);
      const answer = await write(
        withMark(state, request, filePath, now()),
        () => port.setMark(request),
        () => {
          const held = current();
          if (held !== null) set(restored(held, target, before));
        },
      );
      if (answer === null) return false;
      // The daemon's mark and progress replace the guess; marks of other targets stay as they are.
      const latest = current();
      if (!gone() && latest !== null) {
        const others = latest.marks.filter((other) => !(other.targetKind === target.kind && other.targetId === target.id));
        set({ ...latest, marks: [...others, answer.mark], progress: answer.progress });
      }
      return true;
    },
    async clear(target) {
      if (state === null || disposed) return false;
      const before: ReviewMark | undefined = state.marks.find((other) => other.targetKind === target.kind && other.targetId === target.id);
      if (before === undefined) return true;
      const answer = await write(
        withoutMark(state, target),
        () => port.clearMark(target),
        () => {
          const held = current();
          if (held !== null) set(restored(held, target, before));
        },
      );
      // The 204 carries no progress: read it again.
      if (answer === null) return false;
      void refresh();
      return true;
    },
    async saveNote(note) {
      if (state === null || disposed) return false;
      const answer = await write(
        null,
        () => port.setNote(note),
        () => undefined,
      );
      if (answer === null) return false;
      const latest = current();
      if (!gone() && latest !== null) set({ ...latest, note: answer.note });
      return true;
    },
    summary: (signal) => port.summary(signal),
    refresh,
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      loading?.abort();
      stop();
      listeners.clear();
    },
  };
}
