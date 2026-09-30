-- loaves we bake daily
CREATE TABLE loaves (
  id   serial PRIMARY KEY,
  name text NOT NULL,
  crust text
);

CREATE INDEX loaves_name_idx ON loaves (name);

ALTER TABLE loaves ADD COLUMN baked_at timestamptz;
