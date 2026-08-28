/**
 * Error taxonomy of the Plan HTTP client (story S6.3, ADR-001/ADR-002).
 *
 * The distinctions here are not cosmetic. The instrumentation-health layer has
 * to answer "is the measurement still happening?", and the failures below demand
 * different human reactions:
 *
 * - unreachable  → the game VPS or the Plan process is down. Real incident.
 * - auth (401)   → Plan asked us to log in. Our credential, our bug.
 * - forbidden (403) → Plan reached us and refused. Cause is NOT determined here.
 * - http         → Plan answered and refused. Usually a bad path or a version skew.
 * - malformed    → Plan answered with something that is not the JSON we expect.
 *
 * Collapsing them into one "Plan failed" would recreate the ADR-006 problem one
 * level down: an alert that fires without telling you which of several unrelated
 * things broke is only marginally better than no alert.
 *
 * ## Why 401 and 403 stopped sharing a class (2026-08-27)
 *
 * They were one class, `PlanAuthError`, described as "our credential is wrong or
 * expired. Our bug, not an outage." Against this Plan instance that label is
 * wrong often enough to be dangerous, and the alert carried it:
 *
 * - `/v1/whoami` on the production instance answers `{"authRequired":false}`
 *   (measured 2026-08-26). With authentication off there is no credential to be
 *   wrong, so a 403 cannot mean what the label said.
 * - Plan answers **403 for a server name it does not recognise** — a caller
 *   mistake, not an access problem at all.
 * - Plan's own IP whitelist rejects with 403. On 2026-08-26 every endpoint began
 *   answering 403 to one origin, cause never established.
 *
 * So a 403 has at least three plausible causes and this layer cannot tell them
 * apart from the response alone. The honest contract is to name the observation
 * (Plan refused) and enumerate the candidates, never to assert one. Asserting
 * the wrong cause is worse than a vague alert: it sends whoever is on the other
 * end to the wrong place with confidence. Detail in `HANDOFF.md`.
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
 * Plan answered **401** — it wants a login we did not provide.
 *
 * Narrow on purpose. 401 is the one status where "our credential is wrong or
 * missing" is what the protocol itself says, so the alert may state it. 403 is
 * {@link PlanForbiddenError} and states nothing of the sort.
 *
 * Deliberately **not** transient: retrying a rejected credential just burns the
 * schedule.
 *
 * Note for whoever provisions the credential: Plan authenticates with a
 * **session cookie** obtained from `POST /auth/login`, not with the bearer token
 * this client sends today (read from the instance's own OpenAPI, 2026-08-26).
 * If a 401 ever shows up here, `PLAN_API_TOKEN` in its current shape will not
 * fix it.
 */
export class PlanAuthError extends PlanApiError {
  readonly status = 401;

  constructor(readonly url: string) {
    super(
      `Plan exigiu autenticacao (HTTP 401) em ${url} — o Plan autentica por ` +
        'cookie de sessao (/auth/login), nao pelo bearer que este client envia',
      false,
      undefined,
    );
  }
}

/**
 * Plan answered **403** — it received the request and refused to serve it.
 *
 * ## What this class deliberately does not claim
 *
 * That the credential is wrong. Against the AusTV instance a 403 has at least
 * three unrelated causes, and the response body does not separate them:
 *
 * 1. **The server name is not one Plan knows.** Plan answers 403, not 404, for
 *    an unrecognised `?server=`. This is a caller bug and the cheapest to check.
 * 2. **Plan's application-level IP whitelist rejected the origin.** On
 *    2026-08-26 every endpoint began answering 403 to one machine; the cause was
 *    never established.
 * 3. **A web-permission group denies this principal.** Only possible where
 *    authentication is on, and on this instance `/v1/whoami` reports
 *    `authRequired: false` (measured 2026-08-26).
 *
 * The message enumerates them in the order they are cheapest to rule out. Naming
 * a single cause here would be a guess wearing the clothes of a diagnosis — the
 * previous version asserted "credencial recusada", which under the whitelist
 * hypothesis sends the reader to the one place that is not the problem.
 *
 * Not transient: whatever the cause, the next cycle gets the same answer.
 */
export class PlanForbiddenError extends PlanApiError {
  readonly status = 403;

  constructor(readonly url: string) {
    super(
      `Plan recusou a requisicao (HTTP 403) em ${url} — causas possiveis, da ` +
        'mais barata de descartar para a mais cara: nome de servidor que o Plan ' +
        'nao reconhece, whitelist de IP do Plan (config.yml) recusando esta ' +
        'origem, ou permissao web negada para este chamador',
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
