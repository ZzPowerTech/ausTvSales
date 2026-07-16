import { SetMetadata } from '@nestjs/common';

/** Metadata key set by {@link Public} and read by the global session guard. */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opt a route out of the global `SessionAuthGuard`.
 *
 * The guard is deny-by-default (spec §7, S1.4): every route requires a valid
 * session unless it is explicitly annotated with `@Public()`. Keeping the
 * allowlist explicit means a new controller is protected the moment it is added,
 * with no chance of forgetting a guard.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
