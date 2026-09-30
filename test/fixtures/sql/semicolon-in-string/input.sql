INSERT INTO croissant_notes (body) VALUES ('flaky; buttery; ''golden''');
INSERT INTO croissant_notes (body) VALUES (E'escaped \'; still inside');
CREATE TABLE "odd;name" (id int);
-- a comment; with a semicolon
/* block; comment /* nested; */ still; comment */
CREATE FUNCTION bake_count() RETURNS int AS $$
BEGIN
  PERFORM 1;
  RETURN 2;
END;
$$ LANGUAGE plpgsql;
CREATE FUNCTION glaze_count() RETURNS int AS $glaze$
BEGIN
  EXECUTE $$SELECT 1;$$;
  RETURN 3;
END;
$glaze$ LANGUAGE plpgsql;
SELECT 'last; one'
