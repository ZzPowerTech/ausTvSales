/**
 * Error taxonomy of the Plan HTTP client (story S6.3, ADR-001/ADR-002).
 *
 * The distinctions here are not cosmetic. The instrumentation-health layer has
 * to answer "is the measurement still happening?", and the four failures below
 * demand four different human reactions:
 *
 * - unreachable  → the game VPS or the Plan process is down. Real incident.
 * - auth         → our credential is wrong or expired. Our bug, not an outage.
 * - http         → Plan answered and refused. Usually a bad path or a version skew.
 * - malformed    → Plan answered with something that is not the JSON we expect.
 *
 * Collapsing them into one "Plan failed" would recreate the ADR-006 problem one
 * level down: an alert that fires without telling you which of four unrelated
 * things broke is only marginally better than no alert.
 */

/** Base class so callers can catch every Plan transport failure at once. */
export abstract class PlanApiError extends Error {
  protected constructor(
    message: string,
    /** Whether retrying the exact same request could plausibly succeed. */
    readonly transient: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The Plan webserver could not be reached at all: DNS, refused connection,
 * TLS failure or timeout.
 *
 * This is the failure the epic exists to catch — it is what a dead proxy looks
 * like from here.
 */
export class PlanUnreachableError extends PlanApiError {
  constructor(
    readonly url: string,
    cause?: unknown,
  ) {
    super(`Plan inalcancavel em ${url}`, true, { cause });
  }
}

/**
 * `PLAN_BASE_URL` is not set, so there is no host to ask.
 *
 * Deliberately **not** transient, and deliberately not folded into
 * {@link PlanUnreachableError}. The taxonomy in this file exists to separate
 * "the game VPS is down" from "we are misconfigured", and an unset base URL is
 * squarely the second: no amount of retrying or waiting will make it succeed,
 * and an operator paged for it should be sent to the deploy config, not to the
 * server room.
 */
export class PlanNotConfiguredError extends PlanApiError {
  constructor() {
    super(
      'PLAN_BASE_URL nao configurada — nao ha host do Plan para consultar',
      false,
      undefined,
    );
  }
}

/**
 * Plan answered 401 or 403.
 *
 * Deliberately **not** transient: retrying a rejected credential just burns the
 * schedule. It is also the one failure here that is our own misconfiguration
 * rather than an outage, and the alert must say so — otherwise someone goes
 * looking for a dead server that is actually running fine.
 */
export class PlanAuthError extends PlanApiError {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(
      `Plan recusou a credencial (HTTP ${status}) em ${url} — ` +
        'verifique PLAN_API_TOKEN e a whitelist de IP do Plan',
      false,
      undefined,
    );
  }
}

/** Plan answered with a non-2xx status that is not an auth rejection. */
export class PlanHttpError extends PlanApiError {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly bodyExcerpt: string,
  ) {
    super(
      `Plan respondeu HTTP ${status} em ${url}${
        bodyExcerpt ? `: ${bodyExcerpt}` : ''
      }`,
      // 5xx and 429 are worth one more attempt; 4xx will keep being 4xx.
      status >= 500 || status === 429,
      undefined,
    );
  }
}

/**
 * Plan answered 2xx with a body that is not parseable JSON.
 *
 * In practice this is what an HTML login page looks like when authentication is
 * misconfigured — which is why it is a distinct case and not a generic parse
 * failure buried in a log line.
 */
export class PlanMalformedResponseError extends PlanApiError {
  constructor(
    readonly url: string,
    readonly bodyExcerpt: string,
    cause?: unknown,
  ) {
    super(
      `Plan devolveu corpo nao-JSON em ${url}` +
        `${bodyExcerpt ? `: ${bodyExcerpt}` : ''}`,
      false,
      { cause },
    );
  }
}
