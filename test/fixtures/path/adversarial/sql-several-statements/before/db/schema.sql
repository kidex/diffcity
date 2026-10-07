CREATE TABLE depots (id integer primary key);

CREATE TABLE crates (id integer primary key, depot_id integer);

CREATE INDEX crates_depot_idx ON crates (depot_id);
