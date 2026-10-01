// The one data source of the three directions: the golden Report of the
// order-discounts scenario, exactly as `diffcity diff --json` produces it.
// Bundled at build time, so the pages make no network request.
//
// That Report has no execution path and no findings yet (the path and the
// findings import are later phases). To show how the reading path and the
// finding pins would look, the pages add a small sample overlay that points
// at real symbol ids of the Report. The overlay is static data: nothing here
// computes a path, a verdict or an anchor. The HUD labels it as a sample.

import type { Finding, Report, Step } from '../../../src/core/report/types.js';
import golden from '../../../test/fixtures/scenarios/order-discounts/expected.json';

export type { Finding, Report, Step };

export interface LoadedReport {
  report: Report;
  /** True when steps or findings come from the sample overlay, not the Report. */
  sampleOverlay: boolean;
}

const SAMPLE_STEPS: readonly Omit<Step, 'diff'>[] = [
  {
    order: 1,
    fileId: 'src/api/orders/orders.routes.ts',
    symbolId: 'src/api/orders/orders.routes.ts#registerRoutes',
    why: 'New public endpoint. Unauthenticated calls reach the controller.',
  },
  {
    order: 2,
    fileId: 'src/api/orders/orders.controller.ts',
    symbolId: 'src/api/orders/orders.controller.ts#OrdersController.cancel',
    why: 'Reads the id from the URL and hands off to the service.',
  },
  {
    order: 3,
    fileId: 'src/auth/order.guard.ts',
    symbolId: 'src/auth/order.guard.ts#OrderGuard.canPlace',
    why: 'Signature grew a second parameter.',
  },
  {
    order: 4,
    fileId: 'src/services/orders/orders.service.ts',
    symbolId: 'src/services/orders/orders.service.ts#OrdersService.applyDiscount',
    why: 'Discount math added to place(). This is where the money changes.',
  },
  {
    order: 5,
    fileId: 'src/repo/orders.repo.ts',
    symbolId: 'src/repo/orders.repo.ts#OrdersRepo.insert',
    why: 'Persists discount_pct and discounted_total on the row.',
  },
  {
    order: 6,
    fileId: 'db/migrations/20260921_order_discounts.sql',
    symbolId: 'db/migrations/20260921_order_discounts.sql#ALTER TABLE orders',
    why: 'Schema change. Runs on every environment on deploy.',
  },
];

const SAMPLE_FINDINGS: readonly Finding[] = [
  {
    id: 'sample-1',
    source: 'claude',
    severity: 'med',
    category: 'correctness',
    file: 'src/api/orders/orders.controller.ts',
    line: 32,
    symbolId: 'src/api/orders/orders.controller.ts#OrdersController.cancel',
    title: 'Missing NotFound handling',
    message: 'The route has no error mapping, callers get a 500.',
    state: 'open',
  },
  {
    id: 'sample-2',
    source: 'claude',
    severity: 'high',
    category: 'security',
    file: 'src/auth/order.guard.ts',
    line: 17,
    symbolId: 'src/auth/order.guard.ts#OrderGuard.canPlace',
    title: 'Optional order defaults to allow',
    message: 'When order is undefined the guard returns true.',
    state: 'open',
  },
  {
    id: 'sample-3',
    source: 'claude',
    severity: 'high',
    category: 'correctness',
    file: 'src/services/orders/orders.service.ts',
    line: 30,
    symbolId: 'src/services/orders/orders.service.ts#OrdersService.applyDiscount',
    title: 'Percentages stack without a cap',
    message: 'Two rules at 60% each give a negative total.',
    state: 'open',
  },
  {
    id: 'sample-4',
    source: 'eslint',
    severity: 'low',
    category: 'style',
    file: 'src/services/orders/orders.service.ts',
    line: 3,
    title: 'Unused import Logger',
    message: 'Imported on line 3, never referenced.',
    state: 'open',
  },
  {
    id: 'sample-5',
    source: 'semgrep',
    severity: 'med',
    category: 'correctness',
    file: 'db/migrations/20260921_order_discounts.sql',
    line: 4,
    symbolId: 'db/migrations/20260921_order_discounts.sql#CREATE INDEX orders_discount_idx',
    title: 'Index on a low-cardinality column',
    message: 'The index costs writes and helps no query in this diff.',
    state: 'open',
  },
];

/** The golden Report, with the sample path and findings when it has none. */
export function loadReport(): LoadedReport {
  // The JSON module is typed from its literal content; it is a Report by
  // construction (the golden test compares it with the CLI output).
  const report = structuredClone(golden) as unknown as Report;
  let sampleOverlay = false;
  if (report.steps.length === 0) {
    report.steps = SAMPLE_STEPS.map((step) => ({ ...step, diff: [] }));
    sampleOverlay = true;
  }
  if (report.findings.length === 0) {
    report.findings = SAMPLE_FINDINGS.map((finding) => ({ ...finding }));
    sampleOverlay = true;
  }
  return { report, sampleOverlay };
}
