import {
  appThrottlerOptions,
  dashboardThrottle,
  DASHBOARD_THROTTLE_LIMIT,
  DASHBOARD_THROTTLE_TTL_MS,
  INGEST_THROTTLE_LIMIT,
  INGEST_THROTTLE_TTL_MS,
} from './throttling';

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
