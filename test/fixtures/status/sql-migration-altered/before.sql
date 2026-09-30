-- 0007: crumb inventory
CREATE TABLE crumbs (
  id integer PRIMARY KEY,
  grams integer NOT NULL
);

ALTER TABLE crumbs ADD COLUMN origin text;
