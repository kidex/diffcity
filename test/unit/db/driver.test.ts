// The node:sqlite driver (ADR-025): typed statements, pragma, and transactions
// with BEGIN / BEGIN IMMEDIATE / SAVEPOINT tracked by the driver's own depth.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Connection } from '../../../src/core/db/driver.js';
import { rawConnection, tempDbPath } from './db-helpers.js';

let path: string;
let remove: () => void;
let db: Connection;

beforeEach(() => {
  ({ path, remove } = tempDbPath());
  db = new Connection(path);
  db.execScript('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)');
});
afterEach(() => {
  db.close();
  remove();
});

const names = (): string[] => db.prepare<[], { name: string }>('SELECT name FROM items ORDER BY id').all().map((row) => row.name);

describe('statements and pragma', () => {
  it('runs typed statements with positional parameters', () => {
    const insert = db.prepare<[string], { id: number; name: string }>('INSERT INTO items (name) VALUES (?) RETURNING *');
    expect({ ...insert.get('cart') }).toEqual({ id: 1, name: 'cart' });
    expect(db.prepare<[string]>('INSERT INTO items (name) VALUES (?)').run('orders')).toEqual({ changes: 1, lastInsertRowid: 2 });
    expect(db.prepare<[number], { name: string }>('SELECT name FROM items WHERE id = ?').get(42)).toBeUndefined();
    expect(names()).toEqual(['cart', 'orders']);
  });

  it('pragma returns rows, or the first value with simple', () => {
    db.pragma('user_version = 3');
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    expect(db.pragma('table_info(items)').length).toBe(2);
    expect(db.pragma('foreign_key_check', { simple: true })).toBeUndefined();
  });
});

describe('transaction', () => {
  it('commits and returns the result of fn', () => {
    expect(db.transaction(() => db.prepare<[string]>('INSERT INTO items (name) VALUES (?)').run('cart').changes)).toBe(1);
    expect(db.inTransaction).toBe(false);
    expect(names()).toEqual(['cart']);
  });

  it('rolls back and rethrows when fn throws', () => {
    expect(() =>
      db.transaction(() => {
        db.prepare<[string]>('INSERT INTO items (name) VALUES (?)').run('cart');
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(db.inTransaction).toBe(false);
    expect(names()).toEqual([]);
  });

  it('a nested transaction is a savepoint: its failure rolls back only its own writes', () => {
    db.transaction(() => {
      db.prepare<[string]>('INSERT INTO items (name) VALUES (?)').run('outer');
      expect(db.inTransaction).toBe(true);
      expect(() => { db.transaction(
          () => {
            db.prepare<[string]>('INSERT INTO items (name) VALUES (?)').run('inner');
            db.prepare<[string]>('INSERT INTO items (name) VALUES (?)').run('outer'); // UNIQUE violation
          },
          { immediate: true },
        ); },
      ).toThrow(/UNIQUE constraint failed/);
      db.transaction(() => db.prepare<[string]>('INSERT INTO items (name) VALUES (?)').run('second'));
    });
    expect(names()).toEqual(['outer', 'second']);
  });

  it('an outer failure rolls back committed savepoints too', () => {
    expect(() =>
      db.transaction(() => {
        db.transaction(() => db.prepare<[string]>('INSERT INTO items (name) VALUES (?)').run('inner'));
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(names()).toEqual([]);
  });

  it('immediate takes the write lock up front; deferred only on the first write', () => {
    const other = rawConnection(path, { busyTimeoutMs: 0 });
    try {
      db.transaction(() => {
        expect(() => {
          other.execScript('BEGIN IMMEDIATE');
        }).toThrow(/database is locked/);
      }, { immediate: true });
      db.transaction(() => {
        other.execScript('BEGIN IMMEDIATE');
        other.execScript('COMMIT');
      });
    } finally {
      other.close();
    }
  });

  it('refuses an async fn and rolls it back', () => {
    expect(() =>
      db.transaction(() => {
        db.prepare<[string]>('INSERT INTO items (name) VALUES (?)').run('cart');
        return Promise.resolve();
      }),
    ).toThrow(/synchronous/);
    expect(db.inTransaction).toBe(false);
    expect(names()).toEqual([]);
  });
});
