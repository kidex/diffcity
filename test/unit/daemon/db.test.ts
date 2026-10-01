// getDb (src/daemon/db.ts): one database per daemon, shared by every plugin,
// closed by dbPlugin on stop.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homePaths } from '../../../src/core/home.js';
import { closeDb, dbPlugin, getDb } from '../../../src/daemon/db.js';
import type { DaemonContext } from '../../../src/daemon/plugin.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dc-daemon-db-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** getDb reads only `paths`; the rest of the context is never touched. */
function context(home = dir): DaemonContext {
  return { paths: homePaths(home) } as unknown as DaemonContext;
}

describe('getDb', () => {
  it('opens <home>/diffcity.db once and hands every caller the same Db', async () => {
    const ctx = context();
    const [a, b] = await Promise.all([getDb(ctx), getDb(ctx)]);
    expect(a).toBe(b);
    expect(a.path).toBe(join(dir, 'diffcity.db'));
    expect(await getDb(ctx)).toBe(a);
    await closeDb(ctx);
  });

  it('gives another daemon its own Db', async () => {
    const first = context();
    const second = context();
    expect(await getDb(first)).not.toBe(await getDb(second));
    await closeDb(first);
    await closeDb(second);
  });

  it('dbPlugin.stop closes it; the next getDb opens a new one; closing twice is fine', async () => {
    const ctx = context();
    const db = await getDb(ctx);
    await dbPlugin.stop?.(ctx);
    expect(() => db.repos.list()).toThrow();
    await closeDb(ctx);
    const again = await getDb(ctx);
    expect(again).not.toBe(db);
    expect(again.repos.list()).toEqual([]);
    await closeDb(ctx);
  });

  it('stop without an open database does nothing', async () => {
    await expect(dbPlugin.stop?.(context())).resolves.toBeUndefined();
  });

  it('a failing open still in flight does not drop the Db opened after a close', async () => {
    // getDb reads context.paths on each open, so the first open fails and the reopen succeeds.
    const ctx = { paths: homePaths(join(dir, 'missing', 'home')) };
    const failing = getDb(ctx as unknown as DaemonContext);
    const closing = closeDb(ctx as unknown as DaemonContext);
    ctx.paths = homePaths(dir);
    const reopened = getDb(ctx as unknown as DaemonContext);
    await expect(failing).rejects.toThrow(/directory does not exist/);
    await closing;
    const db = await reopened;
    expect(await getDb(ctx as unknown as DaemonContext)).toBe(db);
    await closeDb(ctx as unknown as DaemonContext);
  });

  it('a failed open rejects and is retried on the next call', async () => {
    const ctx = context(join(dir, 'missing', 'home'));
    await expect(getDb(ctx)).rejects.toThrow(/directory does not exist/);
    await expect(getDb(ctx)).rejects.toThrow(/directory does not exist/);
    await closeDb(ctx);
  });
});
