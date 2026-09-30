import { describe, expect, it } from 'vitest';
import { listScenarios, parseSteps } from '../helpers/scenario.js';

const minimal = { repo: 'sample-shop', base: 'main', branch: 'feature/x', now: '2026-01-01T00:00:00Z', commits: [] };

describe('test/helpers/scenario.ts parseSteps', () => {
  it('accepts a minimal steps.json', () => {
    expect(parseSteps('sample', minimal)).toEqual(minimal);
  });

  it('accepts commits, base commits and an uncommitted state with staging', () => {
    const steps = {
      ...minimal,
      commits: [{ message: 'one', files: 'steps/01', delete: ['a.ts'], rename: { 'b.ts': 'c.ts' } }],
      baseCommits: [{ message: 'later on main', files: 'later' }],
      uncommitted: { files: 'wip', stage: ['d.ts'] },
    };
    expect(parseSteps('sample', steps)).toEqual(steps);
  });

  it.each([
    ['an unknown top-level field', { ...minimal, extra: 1 }, /unknown field "extra"/],
    ['a missing repo', { ...minimal, repo: '' }, /"repo" must be a non-empty string/],
    ['a commit without a message', { ...minimal, commits: [{ files: 'x' }] }, /commits\[0\]\.message/],
    ['staging inside a commit', { ...minimal, commits: [{ message: 'm', stage: ['a'] }] }, /only for uncommitted/],
    ['a message on the uncommitted state', { ...minimal, uncommitted: { message: 'm' } }, /must not have a message/],
    ['a rename to a non-string', { ...minimal, commits: [{ message: 'm', rename: { a: 1 } }] }, /rename must map/],
    ['an unknown change field', { ...minimal, uncommitted: { remove: ['a'] } }, /unknown field "remove"/],
  ])('rejects %s', (_name, value, message) => {
    expect(() => parseSteps('sample', value)).toThrow(message);
  });
});

describe('test/fixtures/scenarios', () => {
  it('every scenario uses its own invented repo name and a fixed clock', () => {
    const scenarios = listScenarios();
    const repos = scenarios.map((s) => s.steps.repo);
    expect(new Set(repos).size).toBe(repos.length);
    for (const { steps } of scenarios) expect(Number.isNaN(Date.parse(steps.now))).toBe(false);
  });
});
