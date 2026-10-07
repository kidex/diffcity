import { sum } from '../src/sum';

function sample(): number[] {
  return [1, 2, 3];
}

describe('adds numbers', () => {
  it('adds', () => {
    expect(sum(sample())).toBe(6);
  });
});
