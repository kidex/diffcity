// A small seeded diffcity home for the JSON API end to end (ADR-017): three
// invented repos, live and archived changes, a report stored with unusual
// spacing (so a re-serialisation would show) and a 2 MB report.

import { mkdir } from 'node:fs/promises';
import { openDb } from '../../src/core/db/index.js';
import type { HomePaths } from '../../src/core/home.js';
import { T0, branchFields, daysAfter, sampleSummary, snapshotInput } from '../unit/db/db-helpers.js';

export { T0 };

/** Stored as is; spacing, key order and 1.50 would change if the daemon parsed and re-serialised it. */
export const ODD_REPORT = '{ "version" : 1.50,\n  "meta": {"repo": "sample-shop", "generatedAt": "2026-09-05T00:00:00Z"},  "files": [] }';

/** A valid JSON report of a little over 2 MB. */
export function bigReport(): string {
  const file = (i: number) => `{"path":"src/generated/module-${String(i)}.ts","status":"mod","verdict":"ok","note":"${'x'.repeat(180)}"}`;
  const files: string[] = [];
  let size = 0;
  for (let i = 0; size < 2 * 1024 * 1024; i += 1) {
    const entry = file(i);
    files.push(entry);
    size += entry.length + 1;
  }
  return `{"version":1,"meta":{"repo":"sample-shop"},"files":[${files.join(',')}]}`;
}

export interface ApiSeed {
  shopId: number;
  ordersId: number;
  docsId: number;
  /** Live branch of sample-shop with ODD_REPORT. */
  cartId: number;
  /** Live PR of sample-shop with the 2 MB report. */
  sessionId: number;
  /** Archived (merged) change of sample-shop. */
  mergedId: number;
  /** Live branch of order-service without a snapshot. */
  retryId: number;
  big: string;
}

/** Creates `paths.home` (0700) and writes the database the daemon will open. */
export async function seedApiHome(paths: HomePaths): Promise<ApiSeed> {
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  const db = openDb(paths.db);
  try {
    const add = (name: string, active = true) =>
      db.repos.upsert({ path: `/work/${name}`, gitCommonDir: `/work/${name}/.git`, name, active, seenAt: T0 }).repo;
    const docs = add('docs-site', false);
    const shop = add('sample-shop');
    const orders = add('order-service');

    const shopCreated = db.changes.applyPlan(
      shop.id,
      {
        create: [
          branchFields('cart', { title: 'Order totals in the cart', lastEventAt: daysAfter(T0, 5) }),
          branchFields('session', {
            kind: 'pr',
            ref: 'pr:9',
            prNumber: 9,
            title: 'Refresh the session',
            reviewState: 'approved',
            lastEventType: 'agent',
            lastEventAt: daysAfter(T0, 4),
          }),
          branchFields('draft', { kind: 'draft', ref: 'draft:.', dirty: true, title: 'Uncommitted changes on main', lastEventAt: daysAfter(T0, 2) }),
          branchFields('old-merged', { title: 'Merged long ago', lastEventAt: daysAfter(T0, 1) }),
        ],
        update: [],
        archive: [],
      },
      T0,
    ).created;
    const [cart, session, , merged] = shopCreated;
    if (cart === undefined || session === undefined || merged === undefined) throw new Error('seed: changes not created');
    db.changes.applyPlan(shop.id, { create: [], update: [], archive: [{ id: merged.id, reason: 'merged' }] }, daysAfter(T0, 6));

    const retry = db.changes.applyPlan(
      orders.id,
      { create: [branchFields('retry', { title: 'Retry failed orders', lastEventAt: daysAfter(T0, 3) })], update: [], archive: [] },
      T0,
    ).created[0];
    if (retry === undefined) throw new Error('seed: retry not created');

    const big = bigReport();
    db.snapshots.put(
      snapshotInput(cart.id, cart.head, { report: ODD_REPORT, touched: ['src/order/total.ts', 'src/cart.ts'], summary: sampleSummary(), contentHash: 'cart-1' }),
    );
    db.snapshots.put(snapshotInput(session.id, session.head, { report: big, touched: ['src/auth/session.ts'], contentHash: 'session-1' }));

    return { shopId: shop.id, ordersId: orders.id, docsId: docs.id, cartId: cart.id, sessionId: session.id, mergedId: merged.id, retryId: retry.id, big };
  } finally {
    db.close();
  }
}
