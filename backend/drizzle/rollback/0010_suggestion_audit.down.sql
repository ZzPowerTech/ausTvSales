-- Rollback for 0010_suggestion_audit.sql
--
-- Run it whole, in one transaction. The guards abort rather than leave a
-- database that looks migrated and is not.
--
-- The hash is sha256 of the entire `0010_suggestion_audit.sql` file, which is
-- what drizzle's migrator stores. It is pinned here because SQL cannot read the
-- file, and `test/suggestion-states.e2e-spec.ts` asserts the pinned value
-- against the row the migrator actually wrote.
--
-- ## What this rollback destroys, and it is not recoverable
--
-- `suggestion_audit` is append-only and is the only record of who tried to
-- change what. Dropping it is not like dropping a cache: the trail is gone, and
-- the refusals it held (`transition_denied`, `auth_denied`) exist nowhere else.
-- Export before running this if the database has seen production traffic.

BEGIN;

-- Guard 1: 0010 has to be the head.
--
-- drizzle decides what to apply by TIMESTAMP, not by hash: it reads the newest
-- `created_at` and applies everything after it. Roll 0010 back under a newer
-- migration and the table is dropped while `db:migrate` still reports nothing
-- pending, forever.
DO $$
DECLARE head_hash text;
BEGIN
  SELECT hash INTO head_hash
  FROM "drizzle"."__drizzle_migrations"
  ORDER BY "created_at" DESC
  LIMIT 1;

  IF head_hash IS DISTINCT FROM '2c83d9a085babbc97d10bfeb927194dbe96f4c7ed0b489327a1b9d8f0d4dfcb8' THEN
    RAISE EXCEPTION
      'Migration 0010 is not the head (head hash is %). Rolling it back here would drop the table and leave db:migrate reporting success. Roll back from the head, one at a time.',
      coalesce(head_hash, '<no migrations applied>');
  END IF;
END $$;

-- Drops the table and, with it, the identity sequence, both indexes, the four
-- check constraints and the foreign key to `suggestions`.
DROP TABLE IF EXISTS "suggestion_audit";

-- Guard 2: the bookkeeping row has to actually go. `DELETE 0` prints among
-- other output and reads like success.
DO $$
DECLARE removed integer;
BEGIN
  DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = '2c83d9a085babbc97d10bfeb927194dbe96f4c7ed0b489327a1b9d8f0d4dfcb8';
  GET DIAGNOSTICS removed = ROW_COUNT;

  IF removed <> 1 THEN
    RAISE EXCEPTION
      'Expected to remove exactly 1 bookkeeping row for migration 0010, removed %.',
      removed;
  END IF;
END $$;

COMMIT;
