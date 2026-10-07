import { sql } from './tag';

export function findOrder(): string {
  return sql`select * from orders` + '2';
}
