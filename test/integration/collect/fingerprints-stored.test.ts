// A daemon collect stores the merge-base and a fingerprint entry for every
// file of the Report, touched or not (ADR-027), and an unchanged recollect
// leaves the stored row alone.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Fingerprints } from '../../../src/core/model/types.js';
import { isolateGitConfig } from '../../helpers/git-env.js';
import { cleanupAfterEach, ghNotInstalled, sampleRepo, startTestDaemon } from './collect-helpers.js';

isolateGitConfig();
cleanupAfterEach();

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('snapshot/merge-base-stored: end to end through the collector', () => {
  it('stores mergeBase = git merge-base and an entry for every Report file', async () => {
    const repo = await sampleRepo({
      files: {
        'src/cart/total.ts': 'export function total(items: number[]): number {\n  return items.length;\n}\n',
        'src/cart/untouched.ts': 'export const untouched = 1;\n',
        'README.md': '# sample-shop\n',
      },
    });
    await repo.branch('feature/checkout');
    const newTotal = 'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n';
    await repo.commit('sum the cart', { 'src/cart/total.ts': newTotal });
    await repo.commit('add a session token', { 'src/session/token.ts': 'export const token = "";\n' });
    await repo.checkout('main');
    await repo.commit('update the readme', { 'README.md': '# sample-shop\n\nA shop.\n' });

    const test = await startTestDaemon({ gh: ghNotInstalled() });
    const response = await test.track(repo.dir);
    if (!response.ok) throw new Error(response.error);
    await test.idle();

    const db = test.collection.db();
    const change = db.changes.listLive(response.repo.id).find((c) => c.ref === 'branch:feature/checkout');
    if (change === undefined) throw new Error('feature change not collected');
    const snapshot = db.snapshots.latest(change.id);
    if (snapshot === null) throw new Error('no snapshot');

    const expectedMergeBase = (await repo.git('merge-base', change.base, snapshot.head)).trim();
    expect(snapshot.mergeBase).toBe(expectedMergeBase);

    const report = JSON.parse(snapshot.report) as { packages: { files: { id: string; path: string }[] }[] };
    const reportFiles = report.packages.flatMap((p) => p.files);
    const fingerprints = JSON.parse(snapshot.fingerprints ?? 'null') as Fingerprints | null;
    if (fingerprints === null) throw new Error('fingerprints not stored');
    const reportIds = reportFiles.map((f) => f.id).sort();
    expect(reportFiles.map((f) => f.path).sort()).toEqual(['src/cart/total.ts', 'src/cart/untouched.ts', 'src/session/token.ts']);
    expect(Object.keys(fingerprints.files).sort()).toEqual(reportIds);
    const byPath = new Map(reportFiles.map((f) => [f.path, f.id]));
    const untouched = fingerprints.files[byPath.get('src/cart/untouched.ts') ?? ''];
    expect(untouched).toEqual({ before: sha('export const untouched = 1;\n'), after: sha('export const untouched = 1;\n') });
    expect(fingerprints.files[byPath.get('src/cart/total.ts') ?? '']?.after).toBe(sha(newTotal));
    expect(fingerprints.files[byPath.get('src/session/token.ts') ?? '']).toEqual({ before: null, after: sha('export const token = "";\n') });
    expect(db.snapshots.latestFingerprints(change.id)).toBe(snapshot.fingerprints);
  });
});
