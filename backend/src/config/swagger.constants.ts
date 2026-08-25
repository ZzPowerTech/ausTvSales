/**
 * Names of the OpenAPI security schemes, in a leaf module on purpose.
 *
 * They live apart from `swagger.ts` because the decorators that reference them
 * live in feature modules. `@IngestAuth()` needs `INGEST_SECURITY_SCHEME`, and
 * importing it from `swagger.ts` would drag `SwaggerModule`, `helmet`,
 * `SessionService` and `AllowlistService` into the ingest module's import graph
 * over a string constant.
 *
 * There is no cycle today. There would be one the first time `swagger.ts` needed
 * anything from `ingest/`, and that is a bad way to find out. This file imports
 * nothing, so it can be imported from anywhere.
 */

/** Session cookie scheme — the document's global requirement. */
export const SESSION_SECURITY_SCHEME = 'session';

/**
 * Ingest API-key scheme.
 *
 * The ingest routes are `@Public()` to the session guard but are **not** open:
 * they swap session auth for an IP allowlist plus a shared API key. Documenting
 * them under the global session requirement would be a lie in one direction, and
 * leaving them with the empty requirement the truly public routes carry would be
 * a lie in the other — it would tell a reader that `POST /sales` accepts
 * anonymous writes.
 */
export const INGEST_SECURITY_SCHEME = 'ingest-api-key';
