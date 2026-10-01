// An in-memory change store for scenario tests: applies a ChangePlan the way
// the daemon's store does (new ids, partial updates, archive stamped with the
// store's own `now`), so a sequence of collections can be replayed without a DB.

import type { ChangePlan } from '../../src/core/changes/types.js';
import type { ChangeRecord } from '../../src/core/model/types.js';

export class MemoryChangeStore {
  private readonly records: ChangeRecord[] = [];
  private nextId = 1;

  constructor(private readonly repoId = 1) {}

  /** Live changes (not archived), in id order. */
  live(): ChangeRecord[] {
    return this.records.filter((change) => change.archivedAt === null).map((change) => ({ ...change }));
  }

  /** Archived changes, in id order. */
  archived(): ChangeRecord[] {
    return this.records.filter((change) => change.archivedAt !== null).map((change) => ({ ...change }));
  }

  get(id: number): ChangeRecord {
    const change = this.records.find((candidate) => candidate.id === id);
    if (change === undefined) throw new Error(`no change with id ${String(id)}`);
    return { ...change };
  }

  /** Applies a plan in one step; throws on an update or archive of an unknown or archived change. */
  apply(plan: ChangePlan, now: Date): void {
    const at = now.toISOString();
    const liveRecord = (id: number): ChangeRecord => {
      const change = this.records.find((candidate) => candidate.id === id);
      if (change === undefined || change.archivedAt !== null) throw new Error(`change ${String(id)} is not live`);
      return change;
    };
    for (const { id, ...columns } of plan.update) Object.assign(liveRecord(id), columns, { updatedAt: at });
    for (const { id, reason } of plan.archive) Object.assign(liveRecord(id), { archivedAt: at, archiveReason: reason, updatedAt: at });
    for (const fields of plan.create) {
      this.records.push({ ...fields, id: this.nextId++, repoId: this.repoId, updatedAt: at, archivedAt: null, archiveReason: null });
    }
  }
}
