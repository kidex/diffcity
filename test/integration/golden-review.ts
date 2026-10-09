// Hand-reviewed outcome of each golden scenario, written from SPEC.md 5.1-5.3
// and ADR-005..009, not copied from the CLI output. UPDATE_GOLDEN never
// touches this file: a regenerated expected.json that disagrees with it fails.
//
// `files` lists every file of the Report with its status and verdict, in
// report order. `path` lists every step in order (SPEC.md 5.4, ADR-034):
// section, symbol, the entry it hangs from and why; `callsites` the call
// sites of every `sig` symbol. `symbols` lists, for every file (touched or not), each symbol
// id (the part after `#`) with its status, in report order. The summary
// counts are not written here: the test derives files, byStatus, byVerdict
// and checks them against the Report, so a golden that breaks a rule cannot
// pass through a regenerated expected.json.

import type { Status, Step, Verdict } from '../../src/core/report/types.js';

export type ReviewedStep = [section: NonNullable<Step['section']>, symbolId: string, entry: string | null, why: string];

export interface ReviewedScenario {
  files: [path: string, status: Status, verdict: Verdict][];
  symbols: Record<string, [name: string, status: Status][]>;
  packages: [path: string, tier1: boolean][];
  tier1Files: string[];
  /** The execution path, step by step, in order. */
  path: ReviewedStep[];
  /** Symbol.callsites of every `sig` symbol. */
  callsites: Record<string, number>;
  /**
   * `inSpec` of every file, in report order (SPEC.md 5.5, ADR-035). Absent for
   * a scenario without a spec: every file is then null and the Report has no
   * `specNotice`.
   */
  inSpec?: [path: string, inSpec: boolean | null][];
}

const ROUTES = 'src/api/orders/orders.routes.ts';
const CONTROLLER = 'src/api/orders/orders.controller.ts';
const SERVICE = 'src/services/orders/orders.service.ts';

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
      'db/migrations/20260811_orders.sql': [['CREATE TABLE orders', 'same']],
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
      'src/auth/roles.ts': [['Role', 'same']],
      'src/repo/orders.repo.ts': [
        ['OrdersRepo', 'same'],
        ['OrdersRepo.constructor', 'same'],
        ['OrdersRepo.findById', 'same'],
        ['OrdersRepo.insert', 'mod'],
        ['OrdersRepo.markCancelled', 'add'],
      ],
      'src/repo/users.repo.ts': [
        ['UsersRepo', 'same'],
        ['UsersRepo.constructor', 'same'],
        ['UsersRepo.findById', 'same'],
        ['UsersRepo.byEmail', 'same'],
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
      'src/shared/errors.ts': [
        ['AppError', 'same'],
        ['NotFound', 'same'],
        ['Forbidden', 'same'],
      ],
      'src/shared/logger.ts': [['log', 'same']],
      'src/shared/money.ts': [
        ['Money', 'same'],
        ['Money.constructor', 'same'],
        ['Money.of', 'same'],
        ['Money.zero', 'same'],
        ['Money.plus', 'same'],
        ['Money.times', 'same'],
        ['round', 'same'],
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
    path: [
      // Class 1, HTTP route: registerRoutes is mod and gained POST /orders/:id/cancel (not in before).
      ['path', `${ROUTES}#registerRoutes`, `${ROUTES}#registerRoutes`, 'New endpoint POST /orders/:id/cancel'],
      // Class 2, controller handlers by file then range: create, cancel, then the handler guard.canPlace.
      // Handlers passed by name are not calls: registerRoutes reaches nothing by BFS.
      ['path', `${CONTROLLER}#OrdersController.create`, `${CONTROLLER}#OrdersController.create`, 'Body changed'],
      // BFS from create: CreateOrderDto.from is same (skipped); svc.place is next.
      ['path', `${SERVICE}#OrdersService.place`, `${CONTROLLER}#OrdersController.create`, 'Body changed'],
      // place's callees in source order: validate, calcTotal, applyDiscount, repo.insert, notify.
      ['path', `${SERVICE}#OrdersService.validate`, `${CONTROLLER}#OrdersController.create`, 'Body changed'],
      ['path', `${SERVICE}#OrdersService.calcTotal`, `${CONTROLLER}#OrdersController.create`, 'New method'],
      ['path', `${SERVICE}#OrdersService.applyDiscount`, `${CONTROLLER}#OrdersController.create`, 'New method'],
      ['path', 'src/repo/orders.repo.ts#OrdersRepo.insert', `${CONTROLLER}#OrdersController.create`, 'Body changed'],
      ['path', `${SERVICE}#OrdersService.notify`, `${CONTROLLER}#OrdersController.create`, 'New method'],
      // Next BFS level: notify calls send, send calls template.
      ['path', 'src/services/orders/mailer.ts#send', `${CONTROLLER}#OrdersController.create`, 'Body changed'],
      ['path', 'src/services/orders/mailer.ts#template', `${CONTROLLER}#OrdersController.create`, 'New function'],
      // cancel: CancelOrderDto.from, which constructs CancelOrderDto; svc.cancel is no touched symbol.
      ['path', `${CONTROLLER}#OrdersController.cancel`, `${CONTROLLER}#OrdersController.cancel`, 'New method'],
      ['path', 'src/api/orders/orders.dto.ts#CancelOrderDto.from', `${CONTROLLER}#OrdersController.cancel`, 'New method'],
      ['path', 'src/api/orders/orders.dto.ts#CancelOrderDto', `${CONTROLLER}#OrdersController.cancel`, 'New class'],
      // canPlace is only passed by reference, never called: sig with no call site.
      ['path', 'src/auth/order.guard.ts#OrderGuard.canPlace', 'src/auth/order.guard.ts#OrderGuard.canPlace', 'Signature changed'],
      // Class 5: the new `cancel` test block (its callee cancel is already on the path).
      ['path', 'src/api/orders/orders.controller.spec.ts#cancel', 'src/api/orders/orders.controller.spec.ts#cancel', 'New test'],
      // Touched SQL after the path, file then range order.
      ['migration', 'db/migrations/20260921_order_discounts.sql#ALTER TABLE orders', null, 'Schema modified: ALTER TABLE orders'],
      ['migration', 'db/migrations/20260921_order_discounts.sql#CREATE INDEX orders_discount_idx', null, 'Schema modified: CREATE INDEX orders_discount_idx'],
      // Reached from no entry: the modified (not new) test, the dto reached only through the same from(),
      // markCancelled (svc.cancel does not exist), the rules called through an interface, the removed roundMoney.
      ['unconnected', 'src/api/orders/orders.controller.spec.ts#create', null, 'Body changed'],
      ['unconnected', 'src/api/orders/orders.dto.ts#CreateOrderDto', null, 'Body changed'],
      ['unconnected', 'src/repo/orders.repo.ts#OrdersRepo.markCancelled', null, 'New method'],
      ['unconnected', 'src/services/orders/discount.rules.ts#DiscountRule', null, 'New export'],
      ['unconnected', 'src/services/orders/discount.rules.ts#percentage', null, 'New function'],
      ['unconnected', 'src/services/orders/discount.rules.ts#threshold', null, 'New function'],
      ['unconnected', 'src/services/orders/pricing.ts#roundMoney', null, 'Removed function'],
    ],
    callsites: { 'src/auth/order.guard.ts#OrderGuard.canPlace': 0 },
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
      'diffcity.config.js': [['default', 'same']],
      'src/cli.ts': [['main', 'same']],
      'src/program.ts': [['Program', 'same']],
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
      'src/commands/status.ts': [['registerStatus', 'same']],
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
    // No entry point: no route, no controller, main (src/cli.ts) is same, the bin file dist/cli.js is not
    // in the change, `program.command(name, run)` is not a commander `.action()`, no job, no test.
    // Everything touched is Unconnected, in file then range order.
    path: [
      ['unconnected', 'src/commands/index.ts#registerReport', null, 'New export'],
      ['unconnected', 'src/commands/index.ts#report', null, 'New export'],
      ['unconnected', 'src/commands/report.ts#Period', null, 'New export'],
      ['unconnected', 'src/commands/report.ts#parsePeriod', null, 'New function'],
      ['unconnected', 'src/commands/report.ts#runReport', null, 'New function'],
      ['unconnected', 'src/commands/report.ts#registerReport', null, 'New function'],
      ['unconnected', 'src/config/schema.ts#configSchema', null, 'Body changed'],
      // Called by runReport (report.ts) and by list.ts, whose only change is its imports.
      ['unconnected', 'src/format/duration.ts#formatDuration', null, 'Signature changed, 2 call sites rewritten'],
      ['unconnected', 'src/release/version.ts#nextVersion', null, 'Body changed'],
      ['unconnected', 'src/ui/ReportTable.tsx#ReportRow', null, 'New export'],
      ['unconnected', 'src/ui/ReportTable.tsx#ReportTable', null, 'New function'],
      ['unconnected', 'src/ui/ReportTable.tsx#ReportLine', null, 'New function'],
    ],
    callsites: { 'src/format/duration.ts#formatDuration': 2 },
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
      'src/ledger/accounts.ts': [
        ['AccountBook', 'same'],
        ['AccountBook.open', 'same'],
        ['AccountBook.has', 'same'],
      ],
      // Same symbols as before the reformat.
      'src/ledger/format.ts': [
        ['formatAmount', 'same'],
        ['formatAccount', 'same'],
        ['DEFAULT_CURRENCY', 'same'],
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
      'src/session/index.ts': [
        ['SESSION_TTL_MS', 'same'],
        ['isExpired', 'same'],
        ['refreshSession', 'same'],
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
    path: [
      // Class 5: the new test block; BFS: refreshSession, then its callees isExpired and rotate in call order.
      ['path', 'src/session/refresh.test.ts#refreshSession', 'src/session/refresh.test.ts#refreshSession', 'New test'],
      ['path', 'src/session/refresh.ts#refreshSession', 'src/session/refresh.test.ts#refreshSession', 'Signature changed, 2 call sites rewritten'],
      ['path', 'src/session/refresh.ts#isExpired', 'src/session/refresh.test.ts#refreshSession', 'Body changed'],
      ['path', 'src/session/refresh.ts#rotate', 'src/session/refresh.test.ts#refreshSession', 'New function'],
      // No SQL. Unconnected in file then range order; the deleted file's symbols are removed steps.
      ['unconnected', 'scripts/seed-ledger.js#seedJournal', null, 'New function'],
      ['unconnected', 'src/ledger/journal.ts#balance', null, 'Body changed'],
      ['unconnected', 'src/session/cookie.ts#readCookie', null, 'Removed function'],
      ['unconnected', 'src/session/cookie.ts#writeCookie', null, 'Removed function'],
      // An interface: nothing calls a type.
      ['unconnected', 'src/session/refresh.ts#Session', null, 'Body changed'],
    ],
    callsites: { 'src/session/refresh.ts#refreshSession': 2 },
  },
  // A spec on the branch (.diffcity/spec.md, ADR-035) that names one route; one file is outside it.
  'spec-scope': {
    files: [
      // The spec file itself is touched (add) and in the spec; not code, no symbols.
      ['.diffcity/spec.md', 'add', 'ok'],
      // registerRoutes gains a route, same parameters: mod. In the spec: it declares `POST /orders/:id/cancel`.
      ['src/api/routes.ts', 'mod', 'ok'],
      // Outside the spec: no route, no name, no call links bannerText to the roots.
      ['src/catalog/banner.ts', 'mod', 'spec'],
      // New file; cancelOrder is the route's handler, a root.
      ['src/orders/cancel.ts', 'add', 'ok'],
      ['src/orders/lookup.ts', 'same', 'same'],
      // refundOrder gains `reason`: sig, eyes (5.2 order), and in the spec as a callee of cancelOrder.
      ['src/orders/refund.ts', 'sig', 'eyes'],
      ['src/shared/money.ts', 'same', 'same'],
    ],
    symbols: {
      '.diffcity/spec.md': [],
      'src/api/routes.ts': [['registerRoutes', 'mod']],
      'src/catalog/banner.ts': [['bannerText', 'mod']],
      'src/orders/cancel.ts': [['cancelOrder', 'add']],
      'src/orders/lookup.ts': [['getOrder', 'same']],
      'src/orders/refund.ts': [['refundOrder', 'sig']],
      'src/shared/money.ts': [['formatCents', 'same']],
    },
    packages: [
      ['.diffcity', false],
      ['src/api', false],
      ['src/catalog', false],
      ['src/orders', false],
      ['src/shared', false],
    ],
    tier1Files: [],
    path: [
      // Class 1: the new route, declared by registerRoutes, which calls nothing touched.
      ['path', 'src/api/routes.ts#registerRoutes', 'src/api/routes.ts#registerRoutes', 'New endpoint POST /orders/:id/cancel'],
      // Class 2: its handler, then its callee.
      ['path', 'src/orders/cancel.ts#cancelOrder', 'src/orders/cancel.ts#cancelOrder', 'New function'],
      ['path', 'src/orders/refund.ts#refundOrder', 'src/orders/cancel.ts#cancelOrder', 'Signature changed, 1 call site rewritten'],
      ['unconnected', 'src/catalog/banner.ts#bannerText', null, 'Body changed'],
    ],
    callsites: { 'src/orders/refund.ts#refundOrder': 1 },
    inSpec: [
      ['.diffcity/spec.md', true],
      ['src/api/routes.ts', true],
      ['src/catalog/banner.ts', false],
      ['src/orders/cancel.ts', true],
      // Untouched files are null.
      ['src/orders/lookup.ts', null],
      ['src/orders/refund.ts', true],
      ['src/shared/money.ts', null],
    ],
  },
};
