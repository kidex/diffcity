CREATE TABLE depots (id integer primary key);

CREATE TABLE crates (id integer primary key, depot_id integer, weight integer);

CREATE INDEX crates_depot_idx ON crates (depot_id);

CREATE INDEX crates_weight_idx ON crates (weight);
