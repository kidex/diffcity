import type { Money } from '../shared/money';

interface Db {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
}

interface NewOrder {
  ownerId: string;
  total: Money;
}

export class OrdersRepo {
  constructor(private readonly db: Db) {}

  async findById(id: string) {
    const { rows } = await this.db.query('SELECT * FROM orders WHERE id = $1', [id]);
    return rows[0];
  }

  async insert(order: NewOrder) {
    const { rows } = await this.db.query(
      'INSERT INTO orders (id, owner_id, total) VALUES (gen_random_uuid(), $1, $2) RETURNING *',
      [order.ownerId, order.total.cents],
    );
    return rows[0];
  }
}
