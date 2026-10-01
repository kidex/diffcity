-- Orders placed through the storefront.
CREATE TABLE orders (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL,
  total NUMERIC(12,2) NOT NULL,
  cancelled_at TIMESTAMPTZ
);
