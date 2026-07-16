import { ThrottlerModuleOptions } from '@nestjs/throttler';

/**
 * Rate-limit calibration for the ingest group (ADR-0001, spec §1.4).
 *
 * These are a *starting point*, calibrated for the real workload: ingest is one
 * request per in-game purchase, so the volume is naturally low. Nginx
 * (`limit_req`) is the edge defense on the game-server IP; this app-layer
 * throttler is the second line if someone bypasses the proxy.
 *
 * Values are intentionally easy to tune — adjust here as real traffic is
 * observed. `ttl` is in milliseconds (@nestjs/throttler v6 convention).
 */
export const INGEST_THROTTLE_TTL_MS = 1_000; // window: 1 second
export const INGEST_THROTTLE_LIMIT = 10; // ~10 req/s with a small burst → 429 over

export const ingestThrottlerOptions: ThrottlerModuleOptions = [
  {
    ttl: INGEST_THROTTLE_TTL_MS,
    limit: INGEST_THROTTLE_LIMIT,
  },
];
