-- Drop the `posts` and `comments` tables inherited from the project template.
--
-- Those two domains were demo CRUD, not part of the OEE product, and their
-- modules have been deleted. `0001_init.sql`, which created them, is deleted
-- too — so a fresh database never creates them and this migration is a no-op
-- there. An environment that already ran 0001 still has both tables with
-- nothing referencing them, and this is what removes them.
--
-- The migration runner tracks applied migrations by FILENAME in
-- `schema_migrations`, so the existing `0001_init.sql` row is simply left
-- behind, pointing at a file that no longer exists. That is harmless: the
-- runner only ever computes `pending = files - applied`, and never re-reads an
-- already-applied file.
--
-- Numbered 0002 rather than reusing 0001 so any database that already applied
-- 0001 still sees this as new work.

-- IF EXISTS on both: this must succeed against a fresh database that never had
-- them, and against one where a previous partial run already removed one.
-- Their indexes are dropped along with the tables, so they need no statements.
DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS posts;
