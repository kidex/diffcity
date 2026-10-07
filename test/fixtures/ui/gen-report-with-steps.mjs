#!/usr/bin/env node
// Writes report-order-discounts-with-steps.json, the reading panel's fixture
// for the sections of the execution path: the golden Report of the
// order-discounts scenario (invented names) with its real steps, computed by
// the daemon (sections path, migration and unconnected, with `why` and the
// inline diffs), plus three findings anchored to step symbols, one per
// section. The findings are medium and low, so the golden's file verdicts stay
// what SPEC.md section 5.2 gives (an open high finding would make a file
// risky). A unit test checks the committed file against this script.
//
// Usage: node test/fixtures/ui/gen-report-with-steps.mjs [--out <path>]

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const golden = fileURLToPath(new URL('../scenarios/order-discounts/expected.json', import.meta.url));
const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt >= 0 && args[outAt + 1] !== undefined ? args[outAt + 1] : fileURLToPath(new URL('report-order-discounts-with-steps.json', import.meta.url));

const SERVICE = 'src/services/orders/orders.service.ts';
const MIGRATION = 'db/migrations/20260921_order_discounts.sql';
const REPO = 'src/repo/orders.repo.ts';

const report = JSON.parse(readFileSync(golden, 'utf8'));
report.findings = [
  {
    id: 'ws-place',
    source: 'semgrep',
    sources: ['semgrep'],
    severity: 'med',
    category: 'correctness',
    file: SERVICE,
    line: 14,
    symbolId: `${SERVICE}#OrdersService.place`,
    title: 'Total is not rounded before it is stored',
    message: 'The discounted total keeps fractions of a cent; round it with roundMoney before insert.',
    state: 'open',
  },
  {
    id: 'ws-alter',
    source: 'claude',
    sources: ['claude'],
    severity: 'med',
    category: 'correctness',
    file: MIGRATION,
    line: 2,
    symbolId: `${MIGRATION}#ALTER TABLE orders`,
    title: 'New column has no default for existing rows',
    message: 'Orders placed before the migration read discount_cents as NULL.',
    state: 'open',
  },
  {
    id: 'ws-mark',
    source: 'claude',
    sources: ['claude'],
    severity: 'low',
    category: 'scope',
    file: REPO,
    line: 31,
    symbolId: `${REPO}#OrdersRepo.markCancelled`,
    title: 'Nothing calls markCancelled yet',
    message: 'The cancel handler updates the row itself; this method is unused.',
    state: 'open',
  },
];

writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
