import { shared } from './shared';

it('shares', () => {
  expect(shared()).toBe(2);
});
