/**
 * Seeded PRNG for the synthetic sales generator (spec S5.0 §1.3).
 *
 * `Math.random()` is deliberately unused here. A reproducible dataset is a
 * precondition for the S5.1 index work: two `EXPLAIN (ANALYZE)` runs are only
 * comparable if the rows underneath them are identical. Same seed, same data.
 *
 * mulberry32 — small, fast, well-distributed for test data. Not cryptographic,
 * and it must never be used for anything that needs to be unguessable.
 */
export type Rng = () => number;

/** FNV-1a over the seed string, so `--seed=austv` maps to a stable 32-bit state. */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function createRng(seed: string): Rng {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in `[minInclusive, maxInclusive]`. */
export function intBetween(
  rng: Rng,
  minInclusive: number,
  maxInclusive: number,
): number {
  return minInclusive + Math.floor(rng() * (maxInclusive - minInclusive + 1));
}

/**
 * Power-law-ish weights for `size` entries: entry 0 is the "campeão", the tail
 * decays as 1/(i+1). A uniform draw would hide exactly the spikes and the
 * ranking separation that CA4/CA5 exist to show.
 */
export function powerLawWeights(size: number): number[] {
  return Array.from({ length: size }, (_, i) => 1 / (i + 1));
}

/** Running totals of `weights`, for `pickWeighted`. */
export function cumulative(weights: number[]): number[] {
  const totals: number[] = [];
  let running = 0;
  for (const weight of weights) {
    running += weight;
    totals.push(running);
  }
  return totals;
}

/**
 * Index drawn proportionally to the weights behind `cumulativeWeights`.
 * Binary search keeps a 50k-row generation over a large catalog cheap.
 */
export function pickWeighted(rng: Rng, cumulativeWeights: number[]): number {
  const total = cumulativeWeights[cumulativeWeights.length - 1];
  const target = rng() * total;
  let low = 0;
  let high = cumulativeWeights.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (cumulativeWeights[mid] <= target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}
