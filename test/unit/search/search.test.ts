// Cmd+K search (ADR-017): case-insensitive over repo names, refs and titles of
// live changes and touched paths; prefix matches before substring matches, and
// within each group repo, then change, then file.

import { describe, expect, it } from 'vitest';
import { MAX_QUERY_LENGTH, searchCorpus, type SearchCorpus } from '../../../src/core/search/index.js';

const corpus: SearchCorpus = {
  repos: [
    { id: 1, name: 'sample-shop', path: '/work/sample-shop' },
    { id: 2, name: 'order-service', path: '/work/order-service' },
    { id: 3, name: 'docs-site', path: '/work/docs-site' },
  ],
  changes: [
    { id: 11, repoId: 1, kind: 'branch', ref: 'branch:feature/order-discounts', prNumber: null, title: 'Add percentage discounts' },
    { id: 12, repoId: 1, kind: 'pr', ref: 'pr:7', prNumber: 7, title: 'Refresh the session before it expires' },
    { id: 13, repoId: 1, kind: 'draft', ref: 'draft:.', prNumber: null, title: 'Uncommitted changes on main' },
    { id: 21, repoId: 2, kind: 'branch', ref: 'branch:fix/retry', prNumber: null, title: 'Retry failed orders' },
  ],
  files: [
    { repoId: 1, changeId: 11, paths: ['src/orders/discounts.ts', 'src/orders/cart.ts'] },
    { repoId: 1, changeId: 12, paths: ['src/auth/session.ts'] },
    { repoId: 2, changeId: 21, paths: ['lib/order-queue.ts'] },
  ],
};

describe('api/search-repo-change-file', () => {
  it('ranks prefix matches above substring matches, and repo > change > file inside each group', () => {
    const results = searchCorpus(corpus, 'order', 20);
    expect(results.map((r) => [r.kind, r.label])).toEqual([
      // prefix: the repo name, a file basename
      ['repo', 'order-service'],
      ['file', 'lib/order-queue.ts'],
      // substring
      ['change', 'Add percentage discounts'],
      ['change', 'Retry failed orders'],
      ['file', 'src/orders/discounts.ts'],
      ['file', 'src/orders/cart.ts'],
    ]);
  });

  it('is case-insensitive and trims the query', () => {
    expect(searchCorpus(corpus, '  SAMPLE ', 20)).toEqual([
      { kind: 'repo', label: 'sample-shop', detail: '/work/sample-shop', repoId: 1 },
    ]);
  });

  it('matches the branch name of a ref as a prefix', () => {
    const results = searchCorpus(corpus, 'feature/', 20);
    expect(results).toEqual([
      { kind: 'change', label: 'Add percentage discounts', detail: 'sample-shop, Branch feature/order-discounts', repoId: 1, changeId: 11 },
    ]);
  });

  it('matches a PR by #number and labels its detail with PR #N', () => {
    expect(searchCorpus(corpus, '#7', 20)).toEqual([
      { kind: 'change', label: 'Refresh the session before it expires', detail: 'sample-shop, PR #7', repoId: 1, changeId: 12 },
    ]);
  });

  it('gives a file result its changeId, path and the change in the detail', () => {
    expect(searchCorpus(corpus, 'session.ts', 20)).toEqual([
      {
        kind: 'file',
        label: 'src/auth/session.ts',
        detail: 'sample-shop, Refresh the session before it expires',
        repoId: 1,
        changeId: 12,
        path: 'src/auth/session.ts',
      },
    ]);
  });

  it('labels a draft as Draft', () => {
    expect(searchCorpus(corpus, 'uncommitted', 20)).toEqual([
      { kind: 'change', label: 'Uncommitted changes on main', detail: 'sample-shop, Draft', repoId: 1, changeId: 13 },
    ]);
  });

  it('does not match a draft on its worktree ref or a file on its repo name', () => {
    expect(searchCorpus(corpus, 'draft', 20)).toEqual([]);
    expect(searchCorpus(corpus, 'docs-site', 20).map((r) => r.kind)).toEqual(['repo']);
  });

  it('applies the limit after ranking', () => {
    expect(searchCorpus(corpus, 'order', 2).map((r) => r.label)).toEqual(['order-service', 'lib/order-queue.ts']);
  });

  it('returns nothing for an empty or blank query', () => {
    expect(searchCorpus(corpus, '', 20)).toEqual([]);
    expect(searchCorpus(corpus, '   ', 20)).toEqual([]);
  });

  it(`caps the query at ${String(MAX_QUERY_LENGTH)} characters`, () => {
    const long = `sample-shop${'x'.repeat(MAX_QUERY_LENGTH)}`;
    const named: SearchCorpus = { repos: [{ id: 9, name: long.slice(0, MAX_QUERY_LENGTH), path: '/work/x' }], changes: [], files: [] };
    expect(searchCorpus(named, long, 20).map((r) => r.repoId)).toEqual([9]);
  });
});
