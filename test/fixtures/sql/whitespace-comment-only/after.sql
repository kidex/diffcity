-- Batches of baguettes, one row per oven run.
CREATE TABLE baguette_batches (
  id int,          -- surrogate key
  flour_kg numeric, /* kilograms */
  note text DEFAULT 'two  spaces'
);


ALTER TABLE baguette_batches
  ADD COLUMN baked_at timestamptz  ;
