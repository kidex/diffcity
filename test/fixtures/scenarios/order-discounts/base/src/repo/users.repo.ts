interface Db {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
}

export class UsersRepo {
  constructor(private readonly db: Db) {}

  async findById(id: string) {
    const { rows } = await this.db.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0];
  }

  async byEmail(email: string) {
    const { rows } = await this.db.query('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0];
  }
}
