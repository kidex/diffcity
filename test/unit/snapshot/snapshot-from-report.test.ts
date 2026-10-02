// snapshotFromReport (ADR-018, ADR-021): the denormalized columns of a snapshot
// and its content hash, from a Report alone.

import { describe, expect, it } from 'vitest';
import { contentHashOf, snapshotFromReport } from '../../../src/core/report/snapshot.js';
import type { Fingerprints } from '../../../src/core/model/types.js';
import type { Report } from '../../../src/core/report/types.js';

const NO_FINGERPRINTS: Fingerprints = { files: {}, symbols: {} };

function sampleReport(generatedAt: string): Report {
  return {
    meta: { repo: 'sample-shop', base: 'main', head: 'feature/checkout', commits: 2, generatedAt },
    packages: [
      {
        id: 'src/cart',
        path: 'src/cart',
        tier1: false,
        files: [
          { id: 'src/cart/line.ts', path: 'src/cart/line.ts', language: 'typescript', status: 'same', verdict: 'same', inSpec: null, symbols: [] },
          { id: 'src/cart/total.ts', path: 'src/cart/total.ts', language: 'typescript', status: 'mod', verdict: 'ok', inSpec: null, symbols: [] },
        ],
      },
      {
        id: 'src/session',
        path: 'src/session',
        tier1: true,
        files: [
          { id: 'src/session/token.ts', path: 'src/session/token.ts', language: 'typescript', status: 'add', verdict: 'eyes', inSpec: null, symbols: [] },
        ],
      },
    ],
    steps: [],
    findings: [],
    summary: {
      files: 3,
      byStatus: { add: 1, mod: 1, sig: 0, del: 0, same: 1 },
      byVerdict: { eyes: 1, risky: 0, spec: 0, ok: 1, same: 1 },
      tier1Files: ['src/session/token.ts'],
    },
  };
}

describe('snapshot/summary-and-touched', () => {
  it('summary is Report.summary plus touchedFiles; touched lists the files that are not `same`', () => {
    const report = sampleReport('2026-03-04T05:06:07.000Z');
    const snapshot = snapshotFromReport(report, 'a'.repeat(40), 'b'.repeat(40), NO_FINGERPRINTS);
    expect(snapshot.summary).toEqual({ ...report.summary, touchedFiles: 2 });
    expect(snapshot.touched).toEqual(['src/cart/total.ts', 'src/session/token.ts']);
    expect(snapshot.headCommit).toBe('a'.repeat(40));
    expect(JSON.parse(snapshot.reportJson)).toEqual(report);
  });
});

describe('snapshot/content-hash-ignores-generated-at', () => {
  it('the same content at another time has the same hash', () => {
    const early = sampleReport('2026-03-04T05:06:07.000Z');
    const late = sampleReport('2026-03-05T00:00:00.000Z');
    expect(contentHashOf(early)).toBe(contentHashOf(late));
    expect(snapshotFromReport(early, 'x', 'y', NO_FINGERPRINTS).reportJson).not.toBe(snapshotFromReport(late, 'x', 'y', NO_FINGERPRINTS).reportJson);
  });

  it('a different content has a different hash', () => {
    const report = sampleReport('2026-03-04T05:06:07.000Z');
    const changed = sampleReport('2026-03-04T05:06:07.000Z');
    changed.meta.commits = 3;
    expect(contentHashOf(changed)).not.toBe(contentHashOf(report));
  });

  it('the hash is a sha256 hex digest', () => {
    expect(contentHashOf(sampleReport('2026-03-04T05:06:07.000Z'))).toMatch(/^[0-9a-f]{64}$/);
  });
});
