import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  RuleCheck,
  DiffLine,
  File,
  Finding,
  Package,
  Report,
  Status,
  Step,
  Symbol,
  Verdict,
} from '../../src/core/report/types.js';
import type { ParsedSymbol } from '../../src/core/parse/types.js';

function sampleReport(): Report {
  const symbol: Symbol = {
    id: 'lib/ledger/invoice.ts#InvoiceBook.total',
    name: 'total',
    kind: 'method',
    status: 'sig',
    range: { start: 4, end: 12 },
    signatureBefore: 'total(): number',
    signatureAfter: 'total(currency: string): number',
    callsites: 3,
  };
  const file: File = {
    id: 'lib/ledger/invoice.ts',
    path: 'lib/ledger/invoice.ts',
    language: 'typescript',
    status: 'sig',
    verdict: 'eyes',
    inSpec: null,
    symbols: [symbol],
  };
  const pkg: Package = { id: 'lib/ledger', path: 'lib/ledger', tier1: false, files: [file] };
  const diff: DiffLine[] = [
    { kind: 'ctx', text: 'class InvoiceBook {' },
    { kind: 'del', text: '  total(): number {' },
    { kind: 'add', text: '  total(currency: string): number {' },
  ];
  const step: Step = { order: 1, symbolId: symbol.id, fileId: file.id, why: 'signature changed with 3 call sites', diff };
  const finding: Finding = {
    id: 'f-1',
    source: 'claude',
    severity: 'high',
    category: 'correctness',
    file: file.path,
    line: 7,
    symbolId: symbol.id,
    title: 'Currency ignored',
    message: 'The currency argument is never read.',
    fix: 'Use the currency when summing.',
    state: 'open',
  };
  return {
    meta: {
      repo: 'sample-ledger',
      base: 'main',
      head: 'feature/currency',
      commits: 2,
      generatedAt: '2026-01-01T00:00:00.000Z',
    },
    packages: [pkg],
    steps: [step],
    findings: [finding],
    summary: {
      files: 1,
      byStatus: { add: 0, mod: 0, sig: 1, del: 0, same: 0 },
      byVerdict: { eyes: 1, risky: 0, spec: 0, ok: 0, same: 0 },
      tier1Files: [],
    },
  };
}

describe('Report types (SPEC.md 4.1)', () => {
  it('builds a complete Report', () => {
    const report = sampleReport();
    expect(report.packages[0]?.files[0]?.symbols[0]?.status).toBe('sig');
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('Status and Verdict are exactly the spec unions', () => {
    expectTypeOf<Status>().toEqualTypeOf<'add' | 'mod' | 'sig' | 'del' | 'same'>();
    expectTypeOf<Verdict>().toEqualTypeOf<'eyes' | 'risky' | 'spec' | 'ok' | 'same'>();
  });

  it('interfaces carry exactly the spec fields', () => {
    expectTypeOf<Report>().toEqualTypeOf<{
      meta: { repo: string; base: string; head: string; commits: number; generatedAt: string };
      packages: Package[];
      steps: Step[];
      findings: Finding[];
      checks?: RuleCheck[];
      specNotice?: string;
      summary: {
        files: number;
        byStatus: Record<Status, number>;
        byVerdict: Record<Verdict, number>;
        tier1Files: string[];
      };
    }>();
    expectTypeOf<Package>().toEqualTypeOf<{ id: string; path: string; tier1: boolean; files: File[] }>();
    expectTypeOf<File>().toEqualTypeOf<{
      id: string;
      path: string;
      language: string;
      status: Status;
      verdict: Verdict;
      inSpec: boolean | null;
      symbols: Symbol[];
    }>();
    expectTypeOf<Symbol>().toEqualTypeOf<{
      id: string;
      name: string;
      kind: 'class' | 'function' | 'method' | 'export' | 'sql';
      status: Status;
      range: { start: number; end: number };
      signatureBefore?: string;
      signatureAfter?: string;
      callsites?: number;
    }>();
    expectTypeOf<Step>().toEqualTypeOf<{
      order: number;
      symbolId: string;
      fileId: string;
      why: string;
      diff: DiffLine[];
      section?: 'path' | 'migration' | 'unconnected';
      entry?: string;
    }>();
    expectTypeOf<DiffLine>().toEqualTypeOf<{ kind: 'ctx' | 'add' | 'del'; text: string }>();
    expectTypeOf<Finding>().toEqualTypeOf<{
      id: string;
      source: string;
      sources?: string[];
      severity: 'high' | 'med' | 'low';
      category: 'security' | 'correctness' | 'scope' | 'style' | 'tests' | 'architecture';
      file: string;
      line: number;
      symbolId?: string;
      title: string;
      message: string;
      fix?: string;
      state: 'open' | 'intended' | 'fixed';
    }>();
    expectTypeOf<RuleCheck>().toEqualTypeOf<{
      ruleId: string;
      kind: 'file-size' | 'layers' | 'pipeline' | 'cve';
      state: 'passed' | 'violations' | 'not-checked' | 'pending' | 'error';
      reason?: string;
      findings: number;
      checkedAt: string;
    }>();
  });
});

describe('ParsedSymbol', () => {
  it('has name, qualifiedName, baseQualifiedName, kind, range, normalized signature and body, signatureText', () => {
    const parsed: ParsedSymbol = {
      name: 'total',
      qualifiedName: 'InvoiceBook.total',
      baseQualifiedName: 'InvoiceBook.total',
      kind: 'method',
      range: { start: 4, end: 12 },
      signature: 'total(currency:string):number',
      body: 'return this.lines.reduce((a,b)=>a+b,0);',
      signatureText: 'total(currency: string): number',
    };
    expect(parsed.qualifiedName).toBe('InvoiceBook.total');
    expectTypeOf<ParsedSymbol>().toEqualTypeOf<{
      name: string;
      qualifiedName: string;
      baseQualifiedName: string;
      kind: Symbol['kind'];
      range: Symbol['range'];
      signature: string;
      body: string;
      signatureText: string;
    }>();
  });
});
