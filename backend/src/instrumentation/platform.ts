/**
 * Platform of a player, derived from the UUID alone (ADR-003).
 *
 * Validated against 49.302 arquivos with 100% accuracy during the 2026-08-21
 * investigation. **Requires no plugin**, which is why the whole `DataExtension`
 * sprint of the v1 plan was cancelled.
 */
export const Platform = {
  /** Floodgate-issued UUID: prefix `00000000-0000-0000-0009-`. */
  Bedrock: 'bedrock',
  /** UUID version 3 — name-based, what an offline-mode login produces. */
  JavaOffline: 'java_offline',
  /** UUID version 4 — random, issued by Mojang for a premium account. */
  JavaPremium: 'java_premium',
  /** A UUID that matches none of the three rules. Never silently bucketed. */
  Unknown: 'unknown',
} as const;

export type Platform = (typeof Platform)[keyof typeof Platform];

/**
 * Every platform, plus the `all` any-platform filter, for a query DTO.
 *
 * Lives here rather than in a feature's DTO because it is a **property of
 * ADR-003**, not of the funnel: three modules segment by platform now, and the
 * first one to need it happened to be the funnel. Importing a feature's DTO to
 * reuse a constant couples two features through a file that has nothing else to
 * do with either — flagged by review on the retention DTO, and correct.
 *
 * The order is the funnel's original order, kept so the OpenAPI enum does not
 * churn for consumers already reading it.
 */
export const PLATFORM_VALUES = [
  'all',
  Platform.Bedrock,
  Platform.JavaOffline,
  Platform.JavaPremium,
  Platform.Unknown,
] as const;

/** A platform, or `all`. What a query DTO accepts. */
export type PlatformFilterValue = (typeof PLATFORM_VALUES)[number];

/** Floodgate stamps every Bedrock player with this prefix. */
const BEDROCK_PREFIX = '00000000-0000-0000-0009-';

/**
 * Index of the UUID version nibble in the canonical string form.
 *
 * `xxxxxxxx-xxxx-Vxxx-xxxx-xxxxxxxxxxxx` — position 14 zero-based, which is the
 * `SUBSTRING(uuid,15,1)` of ADR-003 written for SQL's 1-based indexing. The two
 * spellings are the same character; the offset difference has bitten people
 * porting this rule before.
 */
const VERSION_INDEX = 14;

/**
 * Classify a player UUID.
 *
 * Order matters: Bedrock is tested first because a Floodgate UUID has `0` in the
 * version position and would otherwise fall through to `unknown`.
 *
 * Anything unrecognised returns {@link Platform.Unknown} rather than being folded
 * into a real bucket. A platform metric that quietly absorbs malformed input is a
 * metric that cannot be trusted to say anything — and this one exists to decide
 * whether bot traffic is inflating acquisition.
 */
export function platformOf(uuid: string | null | undefined): Platform {
  if (typeof uuid !== 'string') {
    return Platform.Unknown;
  }

  const normalised = uuid.trim().toLowerCase();

  if (normalised.startsWith(BEDROCK_PREFIX)) {
    return Platform.Bedrock;
  }

  // Guard the length before indexing: a truncated UUID would otherwise read
  // `undefined` and land in `unknown` by accident rather than by decision.
  if (normalised.length <= VERSION_INDEX) {
    return Platform.Unknown;
  }

  switch (normalised[VERSION_INDEX]) {
    case '3':
      return Platform.JavaOffline;
    case '4':
      return Platform.JavaPremium;
    default:
      return Platform.Unknown;
  }
}
