import { describe, expect, it } from 'vitest';
import type { Finding, Status } from '../../../src/core/report/types.js';
import { fileVerdict, tier1Matcher, touchedTier1Files } from '../../../src/core/verdict/index.js';
import type { FileVerdictInput } from '../../../src/core/verdict/index.js';

function finding(severity: Finding['severity'], state: Finding['state']): Finding {
  return {
    id: `f-${severity}-${state}`,
    source: 'semgrep',
    severity,
    category: 'correctness',
    file: 'src/harbor/dock.ts',
    line: 7,
    title: 'Unbounded retry',
    message: 'The retry loop has no upper bound.',
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

describe('verdict order: first match wins (SPEC.md 5.2, ADR-009)', () => {
  it('V1 eyes: tier 1 beats sig, open high finding and inSpec false together', () => {
    expect(
      fileVerdict(
        input({
          status: 'sig',
          symbolStatuses: ['sig'],
          tier1: true,
          findings: [finding('high', 'open')],
          inSpec: false,
        }),
      ),
    ).toBe('eyes');
  });

  it('V1 eyes: tier 1 beats inSpec false', () => {
    expect(fileVerdict(input({ tier1: true, inSpec: false }))).toBe('eyes');
  });

  it('V2 eyes: a single sig among many symbols is enough, even when the file status is mod', () => {
    expect(fileVerdict(input({ status: 'mod', symbolStatuses: ['same', 'mod', 'add', 'sig'] }))).toBe(
      'eyes',
    );
  });

  it('V2 eyes: sig beats inSpec false', () => {
    expect(fileVerdict(input({ status: 'sig', symbolStatuses: ['sig'], inSpec: false }))).toBe('eyes');
  });

  it('V3 risky: one open high finding counts even next to intended and fixed ones', () => {
    expect(
      fileVerdict(
        input({
          findings: [finding('high', 'intended'), finding('high', 'fixed'), finding('high', 'open')],
        }),
      ),
    ).toBe('risky');
  });

  it('V3 risky: an open med finding is not enough', () => {
    expect(fileVerdict(input({ findings: [finding('med', 'open')] }))).toBe('ok');
  });

  it('V4 intended and fixed high findings do not block the spec verdict', () => {
    expect(
      fileVerdict(
        input({ findings: [finding('high', 'intended'), finding('high', 'fixed')], inSpec: false }),
      ),
    ).toBe('spec');
  });

  it('V5 spec: applies to added and deleted files too', () => {
    const statuses: Status[] = ['add', 'del', 'mod'];
    for (const status of statuses) {
      expect(fileVerdict(input({ status, symbolStatuses: [status], inSpec: false }))).toBe('spec');
    }
  });

  it('V6 inSpec null with only non-counting findings stays ok', () => {
    expect(fileVerdict(input({ findings: [finding('high', 'intended')], inSpec: null }))).toBe('ok');
  });

  it('V8 same: untouched wins over tier 1, sig-free high findings and inSpec false together', () => {
    expect(
      fileVerdict(
        input({
          status: 'same',
          symbolStatuses: [],
          tier1: true,
          findings: [finding('high', 'open')],
          inSpec: false,
        }),
      ),
    ).toBe('same');
  });
});

describe('tier 1 matcher feeding the verdict (T1, T3, V1)', () => {
  it('T1 + V1 a touched file under a default token gets eyes', () => {
    const isTier1 = tier1Matcher(undefined);
    const path = 'src/harbor/Auth/tokens.ts';
    expect(fileVerdict(input({ tier1: isTier1(path) }))).toBe('eyes');
  });

  it('T3 an array config that drops the default makes the same file ok', () => {
    const isTier1 = tier1Matcher(['vault']);
    const path = 'src/harbor/Auth/tokens.ts';
    expect(fileVerdict(input({ tier1: isTier1(path) }))).toBe('ok');
  });

  it('T3 a function config that narrows the defaults makes the file ok, others stay eyes', () => {
    const isTier1 = tier1Matcher((defaults) => defaults.filter((token) => token !== 'auth'));
    expect(fileVerdict(input({ tier1: isTier1('src/harbor/Auth/tokens.ts') }))).toBe('ok');
    expect(fileVerdict(input({ tier1: isTier1('src/harbor/session/tokens.ts') }))).toBe('eyes');
  });

  it('T3 a function config sees exactly the 14 defaults', () => {
    let seen: string[] = [];
    tier1Matcher((defaults) => {
      seen = [...defaults];
      return defaults;
    });
    expect(seen).toHaveLength(14);
  });

  it('T3 the config replaces the list for summary.tier1Files too', () => {
    const files = [
      { path: 'src/auth/login.ts', status: 'mod' as Status },
      { path: 'src/vault/keys.ts', status: 'add' as Status },
      { path: 'src/vault/old.ts', status: 'same' as Status },
    ];
    expect(touchedTier1Files(files, tier1Matcher(['vault']))).toEqual(['src/vault/keys.ts']);
  });
});

describe('tier 1 packages (T4)', () => {
  it.each([
    ['packages/guardian', true],
    ['Services/Billing', true],
    ['deploy/K8s', true],
    ['packages/harbor', false],
    ['packages/harbor/ui', false],
  ])('package %s tier 1 = %s', (path, expected) => {
    expect(tier1Matcher(undefined)(path)).toBe(expected);
  });
});
