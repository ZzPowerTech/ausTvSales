import { Controller, Get } from '@nestjs/common';
import {
  appThrottlerOptions,
  DashboardThrottle,
  dashboardThrottle,
  DASHBOARD_THROTTLE_LIMIT,
  DASHBOARD_THROTTLE_TTL_MS,
  INGEST_THROTTLE_LIMIT,
  INGEST_THROTTLE_TTL_MS,
} from './throttling';

/**
 * Metadata keys `@Throttle` writes, as literals.
 *
 * `THROTTLER_LIMIT` and `THROTTLER_TTL` exist in `@nestjs/throttler` but are not
 * re-exported from its entry point, and importing a missing export yields
 * `undefined` at runtime — which silently builds the key `"undefineddefault"`
 * and makes this assertion read `undefined === undefined`. That is how a test
 * that proves nothing passes, so the values are written out.
 *
 * The coupling to a library internal is deliberate and cheap: if upstream
 * renames these, this fails loudly, which is the correct outcome — the composed
 * decorator would have stopped configuring anything.
 */
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';
const THROTTLER_TTL = 'THROTTLER:TTL';

/** A throwaway class, decorated exactly as a real dashboard controller is. */
@DashboardThrottle()
@Controller('probe')
class ProbeController {
  @Get()
  read(): string {
    return 'ok';
  }
}

describe('throttling profiles', () => {
  it('registers exactly one unnamed throttler', () => {
    // Named throttlers would stack rather than replace: `ThrottlerGuard` applies
    // *every* configured throttler to any route it guards, so a second named
    // profile for the dashboard would silently also impose ingest's 10/s on it.
    // Per-route overrides go through `@Throttle({ default: ... })` instead.
    expect(appThrottlerOptions).toHaveLength(1);
    expect(appThrottlerOptions[0]).toEqual({
      ttl: INGEST_THROTTLE_TTL_MS,
      limit: INGEST_THROTTLE_LIMIT,
    });
    expect(appThrottlerOptions[0]).not.toHaveProperty('name');
  });

  it('overrides the `default` profile rather than adding a new one', () => {
    expect(dashboardThrottle).toEqual({
      default: {
        ttl: DASHBOARD_THROTTLE_TTL_MS,
        limit: DASHBOARD_THROTTLE_LIMIT,
      },
    });
  });

  it('gives the dashboard a window long enough for a page load', () => {
    // The two profiles are shaped by different abuse patterns. Ingest is machine
    // traffic at a steady trickle, so a burst is the anomaly and the window is
    // one second. The dashboard is a human opening a page that fires several
    // requests at once and then goes quiet — a per-second limit would punish
    // normal use and leave a slow scrape untouched.
    expect(DASHBOARD_THROTTLE_TTL_MS).toBeGreaterThan(INGEST_THROTTLE_TTL_MS);
    expect(DASHBOARD_THROTTLE_LIMIT).toBeGreaterThan(INGEST_THROTTLE_LIMIT);
  });
});

describe('DashboardThrottle', () => {
  it('overrides the ingest baseline rather than inheriting it', () => {
    // The failure this guards is silent: applying `ThrottlerGuard` without
    // `@Throttle` compiles, looks throttled, and puts the INGEST profile —
    // 10 req/s — on a page a human uses. Reading the reflected metadata proves
    // the composed decorator really writes the dashboard numbers, without
    // needing a database the way the e2e does.
    const limit = Reflect.getMetadata(
      `${THROTTLER_LIMIT}default`,
      ProbeController,
    ) as unknown;
    const ttl = Reflect.getMetadata(
      `${THROTTLER_TTL}default`,
      ProbeController,
    ) as unknown;

    expect(limit).toBe(DASHBOARD_THROTTLE_LIMIT);
    expect(ttl).toBe(DASHBOARD_THROTTLE_TTL_MS);
    expect(limit).not.toBe(INGEST_THROTTLE_LIMIT);
  });
});
