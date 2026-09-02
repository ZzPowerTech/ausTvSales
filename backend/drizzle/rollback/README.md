# Rollback scripts

`drizzle-kit` generates the forward migration only. A migration whose reversal
was never written down is a migration nobody can undo under pressure, so each
one that creates or alters a table gets a hand-written `*.down.sql` here, named
after the migration it reverses.

## Rules

- **Reverse exactly one migration.** Chaining is the operator's job, one file at
  a time, so a partial rollback is a decision rather than an accident.
- **Delete the `__drizzle_migrations` row.** Otherwise `db:migrate` reports the
  migration as applied and silently refuses to recreate what was dropped.
- **Be tested.** `test/suggestions-schema.e2e-spec.ts` shows the shape: apply the
  script inside a transaction, assert the objects are gone, roll the transaction
  back so the suite's database survives. Postgres DDL is transactional, so this
  exercises the real statements without leaving a broken database behind.

## What a rollback can and cannot restore

`drizzle-kit` decides what to apply by **timestamp**, not by hash: it reads the
most recent `created_at` in `__drizzle_migrations` and applies everything newer.
So deleting a migration's row makes it re-appliable only while it is the **latest
applied** migration. Rolling back 0009 on a database that has already applied
0010 removes the table, and the next `db:migrate` still skips 0009 because 0010's
row is newer.

That is a property of the linear migration model, not of these scripts. Roll back
from the head, one at a time.

## Coverage

Scripts start at 0009. Migrations 0000–0008 predate this convention and have no
rollback script; writing them is worth doing and is not this story.
