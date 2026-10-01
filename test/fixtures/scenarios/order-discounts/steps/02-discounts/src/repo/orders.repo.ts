import type { Money } from '../shared/money';

interface Db {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
}

interface NewOrder {
  ownerId: string;
  total: Money;
  discounted: Money;
  discountPct: number;
}

export class OrdersRepo {
  constructor(private readonly db: Db) {}

  async findById(id: string) {
    const { rows } = await this.db.query('SELECT * FROM orders WHERE id = $1', [id]);
    return rows[0];
  }

  async insert(order: NewOrder) {
    const { rows } = await this.db.query(
      'INSERT INTO orders (id, owner_id, total, discount_pct, discounted_total) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING *',
      [order.ownerId, order.total.cents, order.discountPct, order.discounted.cents],
    );
    return rows[0];
  }

  async markCancelled(id: string) {
    await this.db.query('UPDATE orders SET cancelled_at = now() WHERE id = $1', [id]);
  }
}
