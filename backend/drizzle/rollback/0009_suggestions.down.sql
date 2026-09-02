-- Rollback for 0009_suggestions.sql
--
-- Drops the `suggestions` table and, with it, the identity sequence, the unique
-- index on `discord_msg_id`, the listing index and the four check constraints —
-- `DROP TABLE` owns all of them, so nothing is left behind to collide with a
-- re-apply.
DROP TABLE IF EXISTS "suggestions";

-- The bookkeeping row has to go too. Without this, drizzle-kit still believes
-- 0009 is applied and a later `db:migrate` reports success while the table stays
-- missing.
--
-- Deleted by hash, not by "the most recent row": on a database that has already
-- applied 0010, the most recent row is 0010's, and this would silently roll back
-- a migration nobody asked about.
--
-- The hash is sha256 of the whole `0009_suggestions.sql` file, which is what
-- drizzle's migrator stores. It is pinned here because SQL cannot read the file,
-- and `test/suggestions-schema.e2e-spec.ts` asserts the pinned value against the
-- row the migrator actually wrote — so editing an applied migration fails the
-- suite instead of making this DELETE a no-op.
DELETE FROM "drizzle"."__drizzle_migrations"
WHERE "hash" = '5b5a75fcd392893b9f947d2a416c60d38e75a18a6ade0a66531ed4613f82bffb';
