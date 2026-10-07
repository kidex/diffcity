ALTER TABLE ledgers ADD COLUMN name text;
CREATE INDEX ledgers_name_idx ON ledgers (name);
