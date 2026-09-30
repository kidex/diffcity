CREATE TABLE loaves (
  id serial PRIMARY KEY,
  name text NOT NULL
);

CREATE INDEX loaves_name_idx ON loaves (name);

DROP TABLE stale_loaves;
