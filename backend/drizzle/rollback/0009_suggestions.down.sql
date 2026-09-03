-- Rollback for 0009_suggestions.sql
--
-- Run it whole, in one transaction. The guards below abort rather than leave a
-- database that looks migrated and is not.
--
-- The hash is sha256 of the entire `0009_suggestions.sql` file, which is what
-- drizzle's migrator stores. It is pinned here because SQL cannot read the file,
-- and `test/suggestions-schema.e2e-spec.ts` asserts the pinned value against the
-- row the migrator actually wrote - so editing an applied migration fails the
-- suite instead of turning the DELETE below into a silent no-op.

BEGIN;

-- Guard 1: 0009 has to be the head.
--
-- drizzle decides what to apply by TIMESTAMP, not by hash: it reads the newest
-- `created_at` and applies everything after it. Roll 0009 back on a database
-- that already has 0010 and the table is dropped while `db:migrate` still sees
-- 0010 as the newest row, reports nothing pending, and exits 0. The bot then
-- fails with `relation "suggestions" does not exist` and no migration tool says
-- a word.
--
-- The README said "roll back from the head, one at a time". A rule that lives in
-- a README is not a rule - the same argument this story's own store makes about
-- sanitizing at one door. So it is checked here.
DO $$
DECLARE head_hash text;
BEGIN
  SELECT hash INTO head_hash
  FROM "drizzle"."__drizzle_migrations"
  ORDER BY "created_at" DESC
  LIMIT 1;

  IF head_hash IS DISTINCT FROM '8339d0f30cf5d89bf2ca61410c79ef1dab53744132464f24511963c7400bc629' THEN
    RAISE EXCEPTION
      'Migration 0009 is not the head (head hash is %). Rolling it back here would drop the table and leave db:migrate reporting success. Roll back from the head, one at a time.',
      coalesce(head_hash, '<no migrations applied>');
  END IF;
END $$;

-- Drops the table and, with it, the identity sequence, the unique index on
-- `discord_msg_id`, the listing index and the four check constraints - DROP
-- TABLE owns all of them, so nothing survives to collide with a re-apply.
DROP TABLE IF EXISTS "suggestions";

-- Guard 2: the bookkeeping row has to actually go.
--
-- `DELETE 0` prints among other output and reads like success. If the pinned
-- hash ever stops matching, this is the difference between an aborted rollback
-- and a database whose table is gone while drizzle believes 0009 is applied.
DO $$
DECLARE removed integer;
BEGIN
  DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = '8339d0f30cf5d89bf2ca61410c79ef1dab53744132464f24511963c7400bc629';
  GET DIAGNOSTICS removed = ROW_COUNT;

  IF removed <> 1 THEN
    RAISE EXCEPTION
      'Expected to remove exactly 1 bookkeeping row for migration 0009, removed %.',
      removed;
  END IF;
END $$;

COMMIT;
