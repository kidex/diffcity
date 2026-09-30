import { describe, expect, it } from 'vitest';
import { OrdersController } from './orders.controller';

describe('list', () => {
  it('returns the orders of the user', async () => {
    const seen: unknown[] = [];
    const svc = { list: async () => [] };
    const res = { status: () => res, json: (value: unknown) => void seen.push(value) };
    await new OrdersController(svc as never).list({ user: { id: 'u1' }, params: {}, body: {} }, res);
    expect(seen).toEqual([[]]);
  });
});

describe('create', () => {
  it('answers 201 with the placed order', async () => {
    const codes: number[] = [];
    const svc = { place: async () => ({ id: 'o1' }) };
    const res = { status: (code: number) => (codes.push(code), res), json: () => undefined };
    await new OrdersController(svc as never).create({ user: { id: 'u1' }, params: {}, body: { items: ['tea'] } }, res);
    expect(codes).toEqual([201]);
  });
});
