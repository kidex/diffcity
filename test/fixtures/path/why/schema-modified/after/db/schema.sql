CREATE TABLE ledgers (id integer primary key, name text);
CREATE TABLE notes (id integer primary key);
CREATE INDEX ledgers_name_idx ON ledgers (name);
