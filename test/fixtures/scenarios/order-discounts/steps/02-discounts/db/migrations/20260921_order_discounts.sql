ALTER TABLE orders
  ADD COLUMN discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN discounted_total NUMERIC(12,2);
CREATE INDEX orders_discount_idx ON orders (discount_pct);
