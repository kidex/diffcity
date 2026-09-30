-- Migration: add discounts to the bakery shop.

CREATE TABLE IF NOT EXISTS orders (
  id bigserial PRIMARY KEY,
  total numeric(10, 2) NOT NULL
);

ALTER TABLE orders ADD COLUMN discount numeric(10, 2) DEFAULT 0;

/* Speeds up the discount report. */
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS orders_discount_idx
  ON orders (discount);

CREATE OR REPLACE FUNCTION pastry.apply_discount(amount numeric)
RETURNS numeric AS $$
  SELECT amount * 0.9;
$$ LANGUAGE sql;

CREATE MATERIALIZED VIEW pastry."Daily Totals" AS SELECT 1;
INSERT INTO pastry.order_status (code) VALUES ('open');
DROP TABLE IF EXISTS legacy_coupons, legacy_vouchers;
COMMENT ON COLUMN orders.discount IS 'Applied discount';
CREATE INDEX ON orders (total);
GRANT SELECT ON orders TO bakery_reader;
DO $$ BEGIN RAISE NOTICE 'done'; END $$;
