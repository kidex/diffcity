// Small invented Report and fingerprints for the findings tests (shopfront).

import type { Fingerprints } from '../../../src/core/model/types.js';
import type { File, Report, Symbol } from '../../../src/core/report/types.js';

export function symbol(path: string, name: string, kind: Symbol['kind'], status: Symbol['status'], start: number, end: number): Symbol {
  return { id: `${path}#${name}`, name, kind, status, range: { start, end } };
}

export function file(path: string, status: File['status'], symbols: Symbol[]): File {
  return { id: path, path, language: 'typescript', status, verdict: 'ok', inSpec: null, symbols };
}

const ORDERS = 'src/orders/orders.service.ts';
const GUARD = 'src/auth/order.guard.ts';

/** Four files: a tier 1 guard, a service with nested symbols and a deleted one, a controller, an untouched helper. */
export function shopfrontReport(): Report {
  const files = {
    guard: file(GUARD, 'mod', [symbol(GUARD, 'canCancel', 'function', 'mod', 10, 30)]),
    orders: file(ORDERS, 'mod', [
      symbol(ORDERS, 'OrdersService', 'class', 'mod', 1, 60),
      symbol(ORDERS, 'OrdersService.cancel', 'method', 'mod', 10, 30),
      symbol(ORDERS, 'OrdersService.refund', 'method', 'mod', 32, 50),
      symbol(ORDERS, 'legacyCancel', 'function', 'del', 70, 80),
    ]),
    controller: file('src/orders/orders.controller.ts', 'add', [
      symbol('src/orders/orders.controller.ts', 'cancelRoute', 'function', 'add', 5, 20),
    ]),
    format: file('src/util/format.ts', 'same', [symbol('src/util/format.ts', 'money', 'function', 'same', 1, 9)]),
  };
  return {
    meta: { repo: 'shopfront', base: 'main', head: 'feature/cancel', commits: 3, generatedAt: '2026-01-01T00:00:00.000Z' },
    packages: [
      { id: 'src/auth', path: 'src/auth', tier1: true, files: [files.guard] },
      { id: 'src/orders', path: 'src/orders', tier1: false, files: [files.orders, files.controller] },
      { id: 'src/util', path: 'src/util', tier1: false, files: [files.format] },
    ],
    steps: [],
    findings: [],
    summary: {
      files: 4,
      byStatus: { add: 2, mod: 5, sig: 0, del: 1, same: 1 },
      byVerdict: { eyes: 1, risky: 0, spec: 0, ok: 2, same: 1 },
      tier1Files: [GUARD],
    },
    checks: [{ ruleId: 'size', kind: 'file-size', state: 'passed', findings: 0, checkedAt: '2026-01-01T00:00:00.000Z' }],
  };
}

export function shopfrontFingerprints(): Fingerprints {
  return {
    files: {
      'src/auth/order.guard.ts': { before: 'g0', after: 'g1' },
      'src/orders/orders.service.ts': { before: 's0', after: 's1' },
      'src/orders/orders.controller.ts': { before: null, after: 'c1' },
      'src/util/format.ts': { before: 'u0', after: 'u0' },
    },
    symbols: {
      'src/auth/order.guard.ts#canCancel': 'sym-guard',
      'src/orders/orders.service.ts#OrdersService': 'sym-class',
      'src/orders/orders.service.ts#OrdersService.cancel': 'sym-cancel',
      'src/orders/orders.service.ts#OrdersService.refund': 'sym-refund',
      'src/orders/orders.controller.ts#cancelRoute': 'sym-route',
    },
  };
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
