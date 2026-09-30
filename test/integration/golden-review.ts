// Hand-reviewed outcome of each golden scenario, written from SPEC.md 5.1-5.3
// and ADR-005..009, not copied from the CLI output. UPDATE_GOLDEN never
// touches this file: a regenerated expected.json that disagrees with it fails.
//
// `files` lists every file of the Report with its status and verdict, in
// report order. `symbols` lists, for every touched file, each symbol id (the
// part after `#`) with its status, in range order. Untouched files are checked
// generically: every one of their symbols must be `same`.

import type { Status, Verdict } from '../../src/core/report/types.js';

export interface ReviewedScenario {
  files: [path: string, status: Status, verdict: Verdict][];
  symbols: Record<string, [name: string, status: Status][]>;
  packages: [path: string, tier1: boolean][];
  tier1Files: string[];
}

export const reviewed: Record<string, ReviewedScenario> = {
  // Mirrors design/mockup.html. Phase 1 has no findings and no spec (ADR-010),
  // so the mockup's risky service and spec-less pricing/mailer are `ok` here.
  'order-discounts': {
    files: [
      // Untouched file in a touched tier 1 package: same first (ADR-009).
      ['db/migrations/20260811_orders.sql', 'same', 'same'],
      // New file, every statement add (5.1); tier 1 path `migration` (5.3).
      ['db/migrations/20260921_order_discounts.sql', 'add', 'eyes'],
      // New `cancel` test block add, `create` test body mod; heaviest add; no tier 1, no sig.
      ['src/api/orders/orders.controller.spec.ts', 'add', 'ok'],
      // cancel() add, create() mod; class head untouched so the class is same (ADR-006).
      ['src/api/orders/orders.controller.ts', 'add', 'ok'],
      // CreateOrderDto gains fields (class body, mod); CancelOrderDto is new (add).
      ['src/api/orders/orders.dto.ts', 'add', 'ok'],
      // registerRoutes gains a route, same parameters: mod.
      ['src/api/orders/orders.routes.ts', 'mod', 'ok'],
      // canPlace grows a parameter: sig; tier 1 `auth`/`guard` and sig both give eyes.
      ['src/auth/order.guard.ts', 'sig', 'eyes'],
      ['src/auth/roles.ts', 'same', 'same'],
      // insert() keeps its declared parameters (mod), markCancelled() is new (add).
      ['src/repo/orders.repo.ts', 'add', 'ok'],
      ['src/repo/users.repo.ts', 'same', 'same'],
      ['src/services/orders/discount.rules.ts', 'add', 'ok'],
      ['src/services/orders/mailer.ts', 'add', 'ok'],
      ['src/services/orders/orders.service.ts', 'add', 'ok'],
      // roundMoney() deleted: del outranks the untouched same symbols.
      ['src/services/orders/pricing.ts', 'del', 'ok'],
      // The whole src/shared package is untouched.
      ['src/shared/errors.ts', 'same', 'same'],
      ['src/shared/logger.ts', 'same', 'same'],
      ['src/shared/money.ts', 'same', 'same'],
    ],
    symbols: {
      'db/migrations/20260921_order_discounts.sql': [
        ['ALTER TABLE orders', 'add'],
        ['CREATE INDEX orders_discount_idx', 'add'],
      ],
      'src/api/orders/orders.controller.spec.ts': [
        ['list', 'same'],
        ['create', 'mod'],
        ['cancel', 'add'],
      ],
      'src/api/orders/orders.controller.ts': [
        ['OrdersController', 'same'],
        ['OrdersController.constructor', 'same'],
        ['OrdersController.list', 'same'],
        ['OrdersController.get', 'same'],
        ['OrdersController.create', 'mod'],
        ['OrdersController.cancel', 'add'],
      ],
      'src/api/orders/orders.dto.ts': [
        ['CreateOrderDto', 'mod'],
        ['CreateOrderDto.from', 'same'],
        ['CancelOrderDto', 'add'],
        ['CancelOrderDto.from', 'add'],
      ],
      'src/api/orders/orders.routes.ts': [['registerRoutes', 'mod']],
      'src/auth/order.guard.ts': [
        ['OrderGuard', 'same'],
        ['OrderGuard.canRead', 'same'],
        ['OrderGuard.canPlace', 'sig'],
      ],
      'src/repo/orders.repo.ts': [
        ['OrdersRepo', 'same'],
        ['OrdersRepo.constructor', 'same'],
        ['OrdersRepo.findById', 'same'],
        ['OrdersRepo.insert', 'mod'],
        ['OrdersRepo.markCancelled', 'add'],
      ],
      'src/services/orders/discount.rules.ts': [
        ['DiscountRule', 'add'],
        ['percentage', 'add'],
        ['threshold', 'add'],
      ],
      'src/services/orders/mailer.ts': [
        ['send', 'mod'],
        ['template', 'add'],
      ],
      'src/services/orders/orders.service.ts': [
        ['OrdersService', 'same'],
        ['OrdersService.constructor', 'same'],
        ['OrdersService.place', 'mod'],
        ['OrdersService.validate', 'mod'],
        ['OrdersService.calcTotal', 'add'],
        ['OrdersService.applyDiscount', 'add'],
        ['OrdersService.notify', 'add'],
      ],
      'src/services/orders/pricing.ts': [
        ['basePrice', 'same'],
        ['vat', 'same'],
        ['roundMoney', 'del'],
      ],
    },
    packages: [
      ['db/migrations', true],
      ['src/api/orders', false],
      ['src/auth', true],
      ['src/repo', false],
      ['src/services/orders', false],
      ['src/shared', false],
    ],
    tier1Files: ['db/migrations/20260921_order_discounts.sql', 'src/auth/order.guard.ts'],
  },

  // Base `master` (no `main`); diffcity.config.js drops `schema` and adds
  // `release`; master moved on after the fork (export.ts must not appear).
  'report-cli-command': {
    files: [
      ['diffcity.config.js', 'same', 'same'],
      ['src/cli.ts', 'same', 'same'],
      ['src/program.ts', 'same', 'same'],
      // Two new `export { }` specifiers (one aliased): add.
      ['src/commands/index.ts', 'add', 'ok'],
      // Only the import lines changed: no symbol changed, status from git (ADR-008).
      ['src/commands/list.ts', 'mod', 'ok'],
      ['src/commands/report.ts', 'add', 'ok'],
      ['src/commands/status.ts', 'same', 'same'],
      // Initializer changed (mod); `schema` is removed from tier 1 by the config, so ok, not eyes.
      ['src/config/schema.ts', 'mod', 'ok'],
      // A new overload changes the overload list: sig (ADR-006), eyes.
      ['src/format/duration.ts', 'sig', 'eyes'],
      // Body change; tier 1 through the `release` token added by the config.
      ['src/release/version.ts', 'mod', 'eyes'],
      ['src/ui/ReportTable.tsx', 'add', 'ok'],
    ],
    symbols: {
      'src/commands/index.ts': [
        ['registerList', 'same'],
        ['registerHealth', 'same'],
        ['registerReport', 'add'],
        ['report', 'add'],
      ],
      'src/commands/list.ts': [['registerList', 'same']],
      // parsePeriod: two overloads and the implementation are one symbol.
      'src/commands/report.ts': [
        ['Period', 'add'],
        ['parsePeriod', 'add'],
        ['runReport', 'add'],
        ['registerReport', 'add'],
      ],
      'src/config/schema.ts': [
        ['configSchema', 'mod'],
        ['ConfigKey', 'same'],
      ],
      'src/format/duration.ts': [
        ['MS_PER_SECOND', 'same'],
        ['formatDuration', 'sig'],
      ],
      'src/release/version.ts': [['nextVersion', 'mod']],
      'src/ui/ReportTable.tsx': [
        ['ReportRow', 'add'],
        ['ReportTable', 'add'],
        ['ReportLine', 'add'],
      ],
    },
    packages: [
      ['.', false],
      ['src', false],
      ['src/commands', false],
      ['src/config', false],
      ['src/format', false],
      ['src/release', true],
      ['src/ui', false],
    ],
    tier1Files: ['src/release/version.ts'],
  },

  // Working-tree mode: three commits plus a staged edit, an unstaged edit and
  // an untracked file.
  'session-refresh': {
    files: [
      // Non-code file: status from git (ADR-008); tier 1 `Dockerfile`, case-insensitive (ADR-007).
      ['Dockerfile', 'mod', 'eyes'],
      // Staged: a new arrow function (add); only the import line of seedAccounts changed.
      ['scripts/seed-ledger.js', 'add', 'ok'],
      ['src/ledger/accounts.ts', 'same', 'same'],
      // Reformatted and commented only: same (ADR-005), so untouched (ADR-009) though git sees a change.
      ['src/ledger/format.ts', 'same', 'same'],
      // Renamed from entries.ts and balance() modified: compared old path vs new path, id is the new path.
      ['src/ledger/journal.ts', 'mod', 'ok'],
      // Deleted file: every symbol del; tier 1 `session`.
      ['src/session/cookie.ts', 'del', 'eyes'],
      ['src/session/index.ts', 'same', 'same'],
      // Untracked new test in a tier 1 path.
      ['src/session/refresh.test.ts', 'add', 'eyes'],
      // refreshSession parameters changed (sig) on top of a new function and body edits.
      ['src/session/refresh.ts', 'sig', 'eyes'],
    ],
    symbols: {
      // Not parsed: a non-code file has no symbols.
      Dockerfile: [],
      'scripts/seed-ledger.js': [
        ['seedAccounts', 'same'],
        ['seedJournal', 'add'],
      ],
      'src/ledger/journal.ts': [
        ['Entry', 'same'],
        ['debit', 'same'],
        ['credit', 'same'],
        ['balance', 'mod'],
        ['describeEntry', 'same'],
        ['byAccount', 'same'],
      ],
      'src/session/cookie.ts': [
        ['readCookie', 'del'],
        ['writeCookie', 'del'],
      ],
      'src/session/refresh.test.ts': [['refreshSession', 'add']],
      'src/session/refresh.ts': [
        ['SESSION_TTL_MS', 'same'],
        // A new interface property is a body change (ADR-006).
        ['Session', 'mod'],
        // The unstaged edit (`>` to `>=`).
        ['isExpired', 'mod'],
        ['refreshSession', 'sig'],
        ['rotate', 'add'],
      ],
    },
    packages: [
      ['.', false],
      ['scripts', false],
      ['src/ledger', false],
      ['src/session', true],
    ],
    tier1Files: ['Dockerfile', 'src/session/cookie.ts', 'src/session/refresh.test.ts', 'src/session/refresh.ts'],
  },
};
