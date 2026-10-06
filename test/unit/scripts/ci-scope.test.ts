// scripts/ci-scope.mjs and scripts/e2e-budget.mjs: which CI jobs a change
// pays for, and the spec-file budget of the Playwright projects. Pure
// functions on invented paths; the budget checks use temporary directories.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countSpecs, LIMITS, overBudget } from '../../../scripts/e2e-budget.mjs';
import { classify, classifyPath, plan } from '../../../scripts/ci-scope.mjs';

const push = (paths: string[]) => plan({ event: 'push', ref: 'refs/heads/main', paths });
const pr = (paths: string[]) => plan({ event: 'pull_request', ref: 'refs/pull/7/merge', paths });

/** A folder with `count` spec files spread over two levels. */
function specFolder(count: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'diffcity-budget-'));
  mkdirSync(join(dir, 'nested'));
  for (let i = 0; i < count; i++) writeFileSync(join(dir, i % 2 === 0 ? '' : 'nested', `s${String(i)}.spec.ts`), '');
  writeFileSync(join(dir, 'helper.ts'), '');
  return dir;
}

describe('ci scope', () => {
  it('ci/scope-core-only-skips-screens', () => {
    const p = pr(['src/core/verdict/tier.ts', 'src/daemon/api.ts', 'src/cli/index.ts', 'test/unit/a.test.ts', 'test/integration/b.test.ts', 'test/fixtures/repos/small/a.ts']);
    expect(p.scope).toBe('core');
    expect(p.screens).toBe(false);
    expect(p.visual).toBe(false);
    expect(p.check).toBe(true);
    expect(p.acceptance).toBe(true);
    expect(classifyPath('test/fixtures/ui/report.json')).toBe('full');
  });

  it('ci/scope-ui-change-runs-screens', () => {
    for (const path of ['src/ui/screens/change/a.ts', 'test/e2e/screens/change/a.spec.ts', 'test/fixtures/ui/r.json', 'vite.config.ts', 'vite.standalone.config.ts', 'design/mockup.html']) {
      const p = pr(['src/core/a.ts', path]);
      expect(p.scope, path).toBe('full');
      expect(p.screens, path).toBe(true);
      expect(p.visual, path).toBe(true);
      expect(p.acceptance, path).toBe(true);
    }
    // Not classified: fail safe.
    expect(classify(['src/core/a.ts', 'tools/new-thing.sh'])).toBe('full');
    expect(classify(['test/e2e/support/a.ts'])).toBe('full');
    expect(classify([])).toBe('full');
    expect(plan({ event: 'push', ref: 'refs/heads/feature', paths: null }).scope).toBe('full');
  });

  it('ci/scope-lockfile-or-workflow-runs-all', () => {
    for (const path of ['package.json', 'package-lock.json', '.github/workflows/ci.yml', '.github/actions/e2e-setup/action.yml', '.github/README.md']) {
      const p = pr(['docs/a.md', path]);
      expect(p.scope, path).toBe('full');
      expect(p.screens, path).toBe(true);
      expect(p.visual, path).toBe(true);
    }
  });

  it('ci/scope-tag-runs-all', () => {
    const tag = plan({ event: 'push', ref: 'refs/tags/v0.4.0', paths: ['README.md'] });
    expect(tag).toMatchObject({ scope: 'full', check: true, screens: true, visual: true, acceptance: true, node: [22, 24] });
    const dispatch = plan({ event: 'workflow_dispatch', ref: 'refs/heads/main', full: true, paths: ['README.md'] });
    expect(dispatch).toMatchObject({ scope: 'full', screens: true, visual: true, acceptance: true });
    // Node 24 only on main and tags.
    expect(push(['src/core/a.ts']).node).toEqual([22, 24]);
    expect(pr(['src/core/a.ts']).node).toEqual([22]);
    expect(plan({ event: 'push', ref: 'refs/heads/feature', paths: ['src/core/a.ts'] }).node).toEqual([22]);
  });

  it('ci/scope-docs-only-skips-all', () => {
    const p = push(['README.md', 'CHANGELOG.md', 'docs/guide/a.png', 'docs/b.txt', 'SPEC.md']);
    expect(p).toMatchObject({ scope: 'none', check: false, acceptance: false, screens: false, visual: false, node: [] });
    expect(pr(['README.md', 'src/core/a.ts']).scope).toBe('core');
  });
});

describe('ci scope: e2e folders and the pull request range', () => {
  it('counts the acceptance specs as core, the shared e2e files as full', () => {
    expect(plan({ event: 'pull_request', paths: ['test/e2e/acceptance/a.spec.ts'] })).toMatchObject({ scope: 'core', acceptance: true, screens: false, visual: false });
    expect(classifyPath('test/e2e/support/daemon.ts')).toBe('full');
    expect(classifyPath('test/playwright.config.ts')).toBe('full');
  });

  it('diffs a pull request from the merge base, so a moved base does not widen it', () => {
    const repo = mkdtempSync(join(tmpdir(), 'diffcity-scope-'));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    mkdirSync(join(repo, 'src/core'), { recursive: true });
    mkdirSync(join(repo, 'src/ui'), { recursive: true });
    writeFileSync(join(repo, 'src/core/a.ts'), '1');
    git('add', '.');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'topic');
    writeFileSync(join(repo, 'src/core/a.ts'), '2');
    git('commit', '-qam', 'topic');
    git('checkout', '-q', 'main');
    writeFileSync(join(repo, 'src/ui/b.ts'), '1');
    git('add', '.');
    git('commit', '-qm', 'main moves on, in the UI');
    const script = join(process.cwd(), 'scripts/ci-scope.mjs');
    const scope = (event: string) =>
      /^scope=(\w+)$/m.exec(execFileSync('node', [script, '--event', event, '--base', git('rev-parse', 'main'), '--sha', git('rev-parse', 'topic')], { cwd: repo, encoding: 'utf8' }))?.[1];
    expect(scope('pull_request')).toBe('core');
    expect(scope('push')).toBe('full');
    // A base that is not in the clone: fail safe.
    const lost = execFileSync('node', [script, '--event', 'pull_request', '--base', 'deadbeef', '--sha', 'topic'], { cwd: repo, encoding: 'utf8' });
    expect(lost).toContain('scope=full');
  });
});

describe('e2e budget', () => {
  it('ci/budget-guard-screens-180', () => {
    expect(LIMITS.screens).toBe(180);
    expect(countSpecs(specFolder(180))).toBe(180);
    expect(overBudget({ screens: 180, acceptance: 0 })).toEqual([]);
    const over = overBudget({ screens: countSpecs(specFolder(181)), acceptance: 0 });
    expect(over).toHaveLength(1);
    expect(over[0]).toContain('screens: 181');
  });

  it('ci/budget-guard-acceptance-10', () => {
    expect(LIMITS.acceptance).toBe(10);
    expect(overBudget({ screens: 0, acceptance: 10 })).toEqual([]);
    const over = overBudget({ screens: 0, acceptance: countSpecs(specFolder(11)) });
    expect(over).toHaveLength(1);
    expect(over[0]).toContain('acceptance: 11');
  });
});
