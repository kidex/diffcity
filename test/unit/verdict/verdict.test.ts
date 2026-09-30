import { describe, expect, it } from 'vitest';
import type { Finding, Status, Verdict } from '../../../src/core/report/types.js';
import {
  fileVerdict,
  tier1Matcher,
  touchedTier1Files,
} from '../../../src/core/verdict/index.js';
import type { FileVerdictInput } from '../../../src/core/verdict/index.js';

function finding(
  severity: Finding['severity'],
  state: Finding['state'],
  line = 12,
): Finding {
  return {
    id: `f-${severity}-${state}-${String(line)}`,
    source: 'claude',
    severity,
    category: 'security',
    file: 'src/ledger/invoice.ts',
    line,
    title: 'Unchecked discount',
    message: 'The discount is applied without validation.',
    state,
  };
}

function input(overrides: Partial<FileVerdictInput>): FileVerdictInput {
  return {
    status: 'mod',
    symbolStatuses: ['mod'],
    tier1: false,
    findings: [],
    inSpec: null,
    ...overrides,
  };
}

interface Case {
  name: string;
  input: FileVerdictInput;
  expected: Verdict;
}

const cases: Case[] = [
  {
    // V1
    name: 'verdict/tier1-with-high-finding',
    input: input({ tier1: true, findings: [finding('high', 'open')] }),
    expected: 'eyes',
  },
  {
    // V2
    name: 'verdict/sig-outside-tier1',
    input: input({ status: 'sig', symbolStatuses: ['mod', 'sig', 'same'] }),
    expected: 'eyes',
  },
  {
    // V2 before V3
    name: 'verdict/sig-with-high-finding',
    input: input({ status: 'sig', symbolStatuses: ['sig'], findings: [finding('high', 'open')] }),
    expected: 'eyes',
  },
  {
    // V3
    name: 'verdict/high-finding',
    input: input({ findings: [finding('low', 'open'), finding('high', 'open', 30)] }),
    expected: 'risky',
  },
  {
    // V3 before V5
    name: 'verdict/high-finding-outside-spec',
    input: input({ findings: [finding('high', 'open')], inSpec: false }),
    expected: 'risky',
  },
  {
    // V4
    name: 'verdict/high-finding-intended',
    input: input({ findings: [finding('high', 'intended')] }),
    expected: 'ok',
  },
  {
    // V4
    name: 'verdict/high-finding-fixed',
    input: input({ findings: [finding('high', 'fixed')] }),
    expected: 'ok',
  },
  {
    name: 'verdict/med-finding-only',
    input: input({ findings: [finding('med', 'open'), finding('low', 'open', 40)] }),
    expected: 'ok',
  },
  {
    // V5
    name: 'verdict/outside-spec',
    input: input({ inSpec: false }),
    expected: 'spec',
  },
  {
    name: 'verdict/inside-spec',
    input: input({ inSpec: true }),
    expected: 'ok',
  },
  {
    // V6
    name: 'verdict/no-spec-file',
    input: input({ inSpec: null }),
    expected: 'ok',
  },
  {
    // V7
    name: 'verdict/touched-clean',
    input: input({ status: 'add', symbolStatuses: ['add', 'add'] }),
    expected: 'ok',
  },
  {
    // V8
    name: 'verdict/untouched',
    input: input({ status: 'same', symbolStatuses: ['same', 'same'] }),
    expected: 'same',
  },
  {
    // ADR-009: untouched is checked before tier 1
    name: 'verdict/untouched-tier1',
    input: input({ status: 'same', symbolStatuses: ['same'], tier1: true }),
    expected: 'same',
  },
  {
    // ADR-009: untouched is checked before findings
    name: 'verdict/untouched-with-high-finding',
    input: input({
      status: 'same',
      symbolStatuses: ['same'],
      findings: [finding('high', 'open')],
      inSpec: false,
    }),
    expected: 'same',
  },
  {
    // ADR-008: status mod from git with no changed symbol, still tier 1
    name: 'verdict/touched-tier1-only-imports',
    input: input({ status: 'mod', symbolStatuses: ['same', 'same'], tier1: true }),
    expected: 'eyes',
  },
  {
    name: 'verdict/deleted-file',
    input: input({ status: 'del', symbolStatuses: ['del'] }),
    expected: 'ok',
  },
  {
    name: 'verdict/touched-no-symbols',
    input: input({ status: 'add', symbolStatuses: [] }),
    expected: 'ok',
  },
];

describe('fileVerdict (SPEC.md 5.2, ADR-009)', () => {
  it.each(cases)('$name → $expected', ({ input: verdictInput, expected }) => {
    expect(fileVerdict(verdictInput)).toBe(expected);
  });

  it('never yields spec when inSpec is null, for every touched status', () => {
    const touched: Status[] = ['add', 'mod', 'del'];
    for (const status of touched) {
      expect(fileVerdict(input({ status, symbolStatuses: [status], inSpec: null }))).toBe('ok');
    }
  });

  it('does not mutate its input', () => {
    const verdictInput = input({ findings: [finding('high', 'open')] });
    const snapshot = structuredClone(verdictInput);
    fileVerdict(verdictInput);
    expect(verdictInput).toEqual(snapshot);
  });
});

describe('touchedTier1Files (summary.tier1Files, ADR-009)', () => {
  const isTier1 = tier1Matcher(undefined);

  it('lists touched tier 1 files only, sorted by path', () => {
    const files: { path: string; status: Status }[] = [
      { path: 'src/session/store.ts', status: 'mod' },
      { path: 'src/auth/login.ts', status: 'sig' },
      { path: 'src/auth/roles.ts', status: 'same' },
      { path: 'src/reports/weekly.ts', status: 'mod' },
      { path: 'db/migrations/0042_add_orders.sql', status: 'add' },
      { path: 'src/billing/legacy.ts', status: 'del' },
    ];
    expect(touchedTier1Files(files, isTier1)).toEqual([
      'db/migrations/0042_add_orders.sql',
      'src/auth/login.ts',
      'src/billing/legacy.ts',
      'src/session/store.ts',
    ]);
  });

  it('is empty when nothing tier 1 is touched', () => {
    expect(
      touchedTier1Files(
        [
          { path: 'src/auth/roles.ts', status: 'same' },
          { path: 'src/reports/weekly.ts', status: 'mod' },
        ],
        isTier1,
      ),
    ).toEqual([]);
  });
});
