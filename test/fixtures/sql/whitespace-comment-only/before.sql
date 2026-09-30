CREATE TABLE baguette_batches (id int, flour_kg numeric, note text DEFAULT 'two  spaces');

ALTER TABLE baguette_batches ADD COLUMN baked_at timestamptz;
