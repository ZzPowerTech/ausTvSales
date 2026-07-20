import { createHash } from 'node:crypto';

/**
 * Deterministic UUID derived from the seed and a positional key (spec S5.0 §1.3).
 *
 * This is what makes the generator idempotent: `sales.id` is the plugin-owned
 * idempotency key, so deriving it from `<seed>:<kind>:<index>` means re-running
 * the same command is an `ON CONFLICT DO NOTHING` no-op instead of a duplicate
 * dataset. Changing `--seed` produces a disjoint set, so volume can be added
 * without recreating the database.
 *
 * Shaped as a UUIDv5 (SHA-1 based, name-derived) because that is exactly what
 * this is; the `uuid` column would accept any valid UUID, but a well-formed
 * version nibble keeps the rows honest about their origin.
 */
export function deterministicUuid(
  seed: string,
  kind: string,
  index: number,
): string {
  const digest = createHash('sha1').update(`${seed}:${kind}:${index}`).digest();
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);

  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
