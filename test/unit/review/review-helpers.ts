// A tiny invented Report, its fingerprints and marks for the review tests.

import type { Fingerprints, ReviewMark } from '../../../src/core/model/types.js';
import type { File, Report, Status, Symbol, Verdict } from '../../../src/core/report/types.js';
import { fileFingerprint, type StoredMark } from '../../../src/core/review/index.js';

export const T = '2026-09-01T10:00:00.000Z';

export function sym(id: string, name: string, status: Status = 'mod'): Symbol {
  return { id, name, kind: 'function', status, range: { start: 1, end: 5 } };
}

export function file(id: string, path: string, status: Status, verdict: Verdict, symbols: Symbol[]): File {
  return { id, path, language: 'typescript', status, verdict, inSpec: null, symbols };
}

/**
 * src/cart: total.ts (touched, eyes: total, roundCents), tax.ts (touched, ok: taxRate);
 * src/docs: readme.ts (untouched, same: banner).
 */
export function sampleReport(): Report {
  return {
    meta: { repo: 'sample-shop', base: 'main', head: 'f'.repeat(40), commits: 1, generatedAt: T },
    packages: [
      {
        id: 'p-cart',
        path: 'src/cart',
        tier1: false,
        files: [
          file('f-total', 'src/cart/total.ts', 'mod', 'eyes', [sym('s-total', 'total'), sym('s-round', 'roundCents')]),
          file('f-tax', 'src/cart/tax.ts', 'mod', 'ok', [sym('s-rate', 'taxRate')]),
        ],
      },
      {
        id: 'p-docs',
        path: 'src/docs',
        tier1: false,
        files: [file('f-readme', 'src/docs/readme.ts', 'same', 'same', [sym('s-banner', 'banner', 'same')])],
      },
    ],
    steps: [],
    findings: [],
    summary: {
      files: 3,
      byStatus: { add: 0, mod: 3, sig: 0, del: 0, same: 1 },
      byVerdict: { eyes: 1, risky: 0, spec: 0, ok: 1, same: 1 },
      tier1Files: [],
    },
  };
}

export function sampleFingerprints(overrides: { files?: Fingerprints['files']; symbols?: Fingerprints['symbols'] } = {}): Fingerprints {
  return {
    files: {
      'f-total': { before: 'b-total', after: 'a-total' },
      'f-tax': { before: 'b-tax', after: 'a-tax' },
      'f-readme': { before: 'same', after: 'same' },
      ...overrides.files,
    },
    symbols: { 's-total': 'sym-total', 's-round': 'sym-round', 's-rate': 'sym-rate', 's-banner': 'sym-banner', ...overrides.symbols },
  };
}

/** A current mark of `kind` on `id` fingerprinted against `fingerprints`. */
export function storedMark(
  fingerprints: Fingerprints,
  kind: 'file' | 'symbol',
  id: string,
  overrides: Partial<StoredMark> = {},
): StoredMark {
  const fingerprint =
    kind === 'file' ? fileFingerprint(fingerprints.files[id] ?? { before: null, after: null }) : (fingerprints.symbols[id] ?? '');
  return {
    targetKind: kind,
    targetId: id,
    filePath: 'src/cart/total.ts',
    mark: 'checked',
    note: null,
    lines: null,
    state: 'current',
    createdAt: T,
    updatedAt: T,
    outdatedAt: null,
    fingerprint,
    snapshotId: null,
    ...overrides,
  };
}

/** The ReviewMark of a stored mark, as the API sends it. */
export function publicMark(stored: StoredMark): ReviewMark {
  return {
    targetKind: stored.targetKind,
    targetId: stored.targetId,
    filePath: stored.filePath,
    mark: stored.mark,
    note: stored.note,
    lines: stored.lines,
    state: stored.state,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    outdatedAt: stored.outdatedAt,
  };
}
