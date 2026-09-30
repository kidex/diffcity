import { describe, expect, it, test } from 'vitest';

describe('invoice totals', () => {
  it('adds tax', () => {
    expect(1 + 1).toBe(2);
  });
});

it("rounds to cents", () => {
  expect(Math.round(1.005 * 100)).toBe(100);
});

test(`template title`, async () => {});

describe.skip('skipped suite', () => {});

it.each([1, 2])('case %s', (n) => {
  expect(n).toBeGreaterThan(0);
});

const title = 'dynamic';
test(title, () => {});
test(`with ${title}`, () => {});
