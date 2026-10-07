CREATE TABLE routes (id integer primary key, name text);
ALTER TABLE crates ADD COLUMN route_id integer;
CREATE INDEX crates_route_idx ON crates (route_id);
