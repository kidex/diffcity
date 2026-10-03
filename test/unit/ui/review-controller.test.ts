// review-ui/controller (ADR-028, T10): the optimistic update with rollback, the
// refetch after `snapshot-moved`, reads waiting for writes in flight, and a
// change event reading the state again, against a fake ReviewPort.

import { describe, expect, it } from 'vitest';
import type { ReviewMark, ReviewProgress } from '../../../src/core/model/types.js';
import { createReviewController, SNAPSHOT_MOVED } from '../../../src/ui/screens/change/review/controller.js';
import type { MarkRequest, ReviewPort, ReviewState } from '../../../src/ui/screens/change/ports.js';

const progress = (done: number): ReviewProgress => ({ attention: { done, total: 2 }, touched: { done, total: 4 }, rewrite: 0, outdated: 0, allAttentionDone: false });
const saved = (request: MarkRequest): ReviewMark => ({
  targetKind: request.target.kind,
  targetId: request.target.id,
  filePath: 'src/a.ts',
  mark: request.mark,
  note: request.note ?? null,
  lines: request.lines ?? null,
  state: 'current',
  createdAt: 'then',
  updatedAt: 'now',
  outdatedAt: null,
});

class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function fake() {
  const server: ReviewState = { snapshotId: 1, marks: [], note: null, progress: progress(0) };
  const listeners = new Set<() => void>();
  let release: (() => void) | null = null;
  const port = {
    reads: 0,
    failWith: null as ApiFailure | null,
    hold: false,
    load() {
      port.reads += 1;
      return Promise.resolve(structuredClone(server));
    },
    async setMark(request: MarkRequest) {
      if (port.hold) await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (port.failWith !== null) throw port.failWith;
      const mark = saved(request);
      server.marks = [...server.marks.filter((other) => other.targetId !== request.target.id), mark];
      server.progress = progress(server.marks.length);
      return { mark, progress: server.progress };
    },
    clearMark(target: MarkRequest['target']) {
      if (port.failWith !== null) return Promise.reject(port.failWith);
      server.marks = server.marks.filter((other) => other.targetId !== target.id);
      return Promise.resolve();
    },
    setNote(note: string) {
      server.note = note === '' ? null : note;
      return Promise.resolve({ note: server.note });
    },
    summary() {
      return Promise.resolve('# summary');
    },
    onChange(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const typed: ReviewPort = port;
  return { port, typed, server, emit: () => {
      for (const listener of listeners) listener();
    },
    release: () => {
      release?.();
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const file = { kind: 'file', id: 'src/a.ts' } as const;

describe('review-ui/controller', () => {
  it('review-ui/controller-optimistic: the mark shows before the daemon answers, then the daemon\'s mark and progress replace it', async () => {
    const f = fake();
    const toasts: string[] = [];
    const controller = createReviewController({ port: f.typed, toast: (text) => toasts.push(text) });
    await tick();
    expect(controller.state()?.marks).toEqual([]);
    f.port.hold = true;
    const writing = controller.mark(file, 'src/a.ts', 'checked');
    await tick();
    expect(controller.state()?.marks.map((m) => m.mark)).toEqual(['checked']);
    expect(controller.state()?.progress.touched.done).toBe(0);
    f.release();
    expect(await writing).toBe(true);
    expect(controller.state()?.marks[0]?.updatedAt).toBe('now');
    expect(controller.state()?.progress.touched.done).toBe(1);
    expect(toasts).toEqual([]);
  });

  it('review-ui/controller-rollback: a refused write puts the old mark back and says so; snapshot-moved reads again and says why', async () => {
    const f = fake();
    f.server.marks = [saved({ snapshotId: 1, target: file, mark: 'good' })];
    const toasts: string[] = [];
    const controller = createReviewController({ port: f.typed, toast: (text) => toasts.push(text) });
    await tick();
    f.port.failWith = new ApiFailure(409, 'snapshot-moved');
    const reads = f.port.reads;
    expect(await controller.mark(file, 'src/a.ts', 'rewrite', { note: 'redo' })).toBe(false);
    expect(controller.state()?.marks.map((m) => m.mark)).toEqual(['good']);
    expect(toasts).toEqual([SNAPSHOT_MOVED]);
    await tick();
    expect(f.port.reads).toBeGreaterThan(reads);
    // Any other failure: the same rollback, with the daemon's message.
    f.port.failWith = new ApiFailure(500, 'boom');
    expect(await controller.clear(file)).toBe(false);
    expect(controller.state()?.marks.map((m) => m.mark)).toEqual(['good']);
    expect(toasts[1]).toMatch(/boom/);
  });

  it('review-ui/controller-change-event: a change event reads again; a read that finishes during a write waits for it', async () => {
    const f = fake();
    const controller = createReviewController({ port: f.typed, toast: () => undefined });
    await tick();
    f.server.note = 'from another tab';
    f.emit();
    await tick();
    expect(controller.state()?.note).toBe('from another tab');
    f.port.hold = true;
    const writing = controller.mark(file, 'src/a.ts', 'good');
    await tick();
    const reads = f.port.reads;
    f.emit();
    await tick();
    // The read is deferred while the write is in flight, so it cannot undo the optimistic mark.
    expect(f.port.reads).toBe(reads);
    f.release();
    await writing;
    await tick();
    expect(f.port.reads).toBeGreaterThan(reads);
    expect(controller.state()?.marks.map((m) => m.mark)).toEqual(['good']);
    controller.dispose();
  });
});
