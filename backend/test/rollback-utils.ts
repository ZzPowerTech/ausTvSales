import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DRIZZLE_DIR = join(__dirname, '..', 'drizzle');
const ROLLBACK_DIR = join(DRIZZLE_DIR, 'rollback');

/**
 * A rollback script up to (but excluding) its final `COMMIT`.
 *
 * The scripts are written to be run whole by an operator, so each opens and
 * closes its own transaction. A test needs everything except that close: it runs
 * the real statements — guards included — asserts against the uncommitted state,
 * and issues its own `ROLLBACK`. Asserting the trailing `COMMIT` is present
 * keeps this from quietly becoming a no-op if a script stops managing its
 * transaction.
 */
export function bodyBeforeCommit(file: string): string {
  const script = readFileSync(file).toString();
  const commitAt = script.lastIndexOf('COMMIT;');
  if (commitAt === -1) {
    throw new Error(`${file} does not end with COMMIT; — is it still guarded?`);
  }
  return script.slice(0, commitAt);
}

/** The `NNNN` prefix of a migration or rollback file name. */
function prefixOf(fileName: string): string {
  return fileName.slice(0, 4);
}

/**
 * Every rollback body from the newest migration down to `target`, newest first.
 *
 * ## Why this exists rather than one script per test
 *
 * Each `.down.sql` refuses to run unless its own migration is the **head** —
 * because `drizzle-kit` decides what to apply by timestamp, so rolling back a
 * migration that sits under a newer one drops its objects while `db:migrate`
 * keeps reporting nothing pending.
 *
 * That guard is correct, and it means a test for migration N stops working the
 * day migration N+1 lands. The first version of this suite hit exactly that:
 * 0010 arrived and 0009's rollback test failed with "0009 is not the head" — the
 * guard doing its job on its own author.
 *
 * Chaining down from the head is the procedure the README describes and the
 * only one the guards allow, so it is encoded here instead of being re-typed
 * (and re-forgotten) per spec.
 */
export function rollbackChainDownTo(target: string): string[] {
  const files = readdirSync(ROLLBACK_DIR)
    .filter((name) => name.endsWith('.down.sql'))
    .sort()
    .reverse();

  const chain: string[] = [];
  for (const name of files) {
    chain.push(bodyBeforeCommit(join(ROLLBACK_DIR, name)));
    if (prefixOf(name) === target) return chain;
  }

  throw new Error(
    `No rollback script for migration ${target} in ${ROLLBACK_DIR}. ` +
      'Every migration from the head down to it needs one for the chain to run.',
  );
}

/**
 * The forward migrations that {@link rollbackChainDownTo} undoes, oldest first.
 *
 * Re-applying them is what makes a rollback safe to use rather than merely
 * destructive, so a test that rolls back should always roll forward again.
 */
export function migrationChainFrom(target: string): string[] {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .filter((name) => prefixOf(name) >= target);

  return files.map((name) => readFileSync(join(DRIZZLE_DIR, name)).toString());
}

/** The migration file for one `NNNN` prefix. */
export function migrationFile(target: string): string {
  const name = readdirSync(DRIZZLE_DIR)
    .filter((entry) => entry.endsWith('.sql'))
    .find((entry) => prefixOf(entry) === target);

  if (!name) throw new Error(`No migration file with prefix ${target}`);
  return join(DRIZZLE_DIR, name);
}

/** The rollback script file for one `NNNN` prefix. */
export function rollbackFile(target: string): string {
  const name = readdirSync(ROLLBACK_DIR)
    .filter((entry) => entry.endsWith('.down.sql'))
    .find((entry) => prefixOf(entry) === target);

  if (!name) throw new Error(`No rollback script with prefix ${target}`);
  return join(ROLLBACK_DIR, name);
}
