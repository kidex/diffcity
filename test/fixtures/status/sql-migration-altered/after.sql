-- 0007: crumb inventory, grams now fractional
CREATE TABLE crumbs (
  id integer PRIMARY KEY,
  grams numeric(8, 2) NOT NULL
);

ALTER TABLE crumbs ADD COLUMN origin text;
