-- Rollback for 0011_suggestion_assignee.sql
--
-- Run it whole, in one transaction. The guards abort rather than leave a
-- database that looks migrated and is not.
--
-- ## What this destroys
--
-- `assignee_nickname` is a **snapshot**: the approver's Discord nickname as it
-- was at the moment of approval. It cannot be recomputed, because the nickname
-- may have changed since and because this API holds no Discord token to ask.
-- Dropping the column loses the shop's credit line for every suggestion already
-- approved. Export before running this on a database that has seen traffic.

BEGIN;

-- Guard 1: 0011 has to be the head. drizzle decides what to apply by TIMESTAMP,
-- so rolling this back under a newer migration drops the column while
-- `db:migrate` keeps reporting nothing pending.
DO $$
DECLARE head_hash text;
BEGIN
  SELECT hash INTO head_hash
  FROM "drizzle"."__drizzle_migrations"
  ORDER BY "created_at" DESC
  LIMIT 1;

  IF head_hash IS DISTINCT FROM 'e176a36d0174f00bc8dd26dbd3f78238e82e4da2c2e71d1ed462018cf5abcfc8' THEN
    RAISE EXCEPTION
      'Migration 0011 is not the head (head hash is %). Rolling it back here would drop the column and leave db:migrate reporting success. Roll back from the head, one at a time.',
      coalesce(head_hash, '<no migrations applied>');
  END IF;
END $$;

ALTER TABLE "suggestions" DROP CONSTRAINT IF EXISTS "suggestions_assignee_nickname_valid";
ALTER TABLE "suggestions" DROP CONSTRAINT IF EXISTS "suggestions_assignee_pair";
ALTER TABLE "suggestions" DROP COLUMN IF EXISTS "assignee_nickname";

-- Guard 2: the bookkeeping row has to actually go. `DELETE 0` prints among
-- other output and reads like success.
DO $$
DECLARE removed integer;
BEGIN
  DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = 'e176a36d0174f00bc8dd26dbd3f78238e82e4da2c2e71d1ed462018cf5abcfc8';
  GET DIAGNOSTICS removed = ROW_COUNT;

  IF removed <> 1 THEN
    RAISE EXCEPTION
      'Expected to remove exactly 1 bookkeeping row for migration 0011, removed %.',
      removed;
  END IF;
END $$;

COMMIT;
