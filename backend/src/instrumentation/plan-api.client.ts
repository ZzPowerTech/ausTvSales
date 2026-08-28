import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PlanApiError,
  PlanAuthError,
  PlanForbiddenError,
  PlanHttpError,
  PlanMalformedResponseError,
  PlanNotConfiguredError,
  PlanUnreachableError,
} from './plan-api.errors';

/** How much of an unexpected body is quoted back in an error message. */
const BODY_EXCERPT_LIMIT = 200;

/** Defaults chosen to be safe against a game VPS, overridable by env. */
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_RETRIES = 1;
const RETRY_BASE_DELAY_MS = 500;

/**
 * Transport for the Plan JSON API (`/v1/*`) — story S6.3, ADR-001 and ADR-002.
 *
 * ## Scope: transport only, on purpose
 *
 * This class performs HTTP and classifies failure. It deliberately does **not**
 * know the shape of any Plan endpoint, and returns `unknown` rather than a
 * typed model per route.
 *
 * That is a direct consequence of a mistake made earlier in this same sprint:
 * story S6.2 was written, estimated and merged against an assumed state of a
 * system nobody had read, and had to be reverted. The response shapes of
 * `/v1/serverOverview` and friends have **not** been observed against the live
 * instance yet. Writing parsers for them now would repeat that error, and a
 * parser that silently mismatches would feed the checks wrong numbers — which
 * is worse than no check at all (ADR-006).
 *
 * The slice that pins each endpoint's shape is the one that can run a request
 * against the real Plan and record the payload.
 *
 * ## Why the base URL may not be `127.0.0.1`
 *
 * ADR-001 puts the NestJS API on the sales VPS consuming Plan on the game VPS
 * over the network. Spec §8 therefore requires the Plan webserver to be
 * reachable off-host, protected by a firewall allowlist plus Plan's own IP
 * whitelist. This contradicts one line of §9 that still says `127.0.0.1`; that
 * contradiction is recorded and unresolved, and does not affect this class
 * either way — the base URL is configuration.
 */
@Injectable()
export class PlanApiClient implements OnModuleInit {
  private readonly logger = new Logger(PlanApiClient.name);

  private readonly baseUrl: string | null;
  private readonly token: string | null;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(config: ConfigService) {
    const raw = config.get<string>('PLAN_BASE_URL')?.trim();
    // Normalising the trailing slash here keeps every call site from caring, and
    // stops `//v1/...` from reaching Plan as a different route.
    this.baseUrl = raw ? raw.replace(/\/+$/, '') : null;
    this.token = config.get<string>('PLAN_API_TOKEN')?.trim() || null;
    this.timeoutMs =
      config.get<number>('PLAN_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS;
    this.retries = config.get<number>('PLAN_RETRIES') ?? DEFAULT_RETRIES;
  }

  onModuleInit(): void {
    if (!this.baseUrl) {
      // Loud, because a health layer that cannot reach its source is exactly the
      // false confidence ADR-006 exists to prevent. Checks degrade to `error`
      // rather than inventing an `ok`.
      this.logger.warn(
        'PLAN_BASE_URL nao configurada — os checks de saude que dependem do ' +
          'Plan vao reportar `error`, nunca `ok`. Configure antes de ligar o ' +
          'agendamento.',
      );
      return;
    }

    // The URL is not a secret (the token is), so logging it is safe, and it is
    // the single most useful line when someone is debugging a 403.
    this.logger.log(
      `Plan API em ${this.baseUrl} ` +
        `(timeout ${this.timeoutMs}ms, ${this.retries} retry) ` +
        `${this.token ? 'com' : 'SEM'} token`,
    );
  }

  /** False when `PLAN_BASE_URL` is unset — callers report `error`, not `ok`. */
  get configured(): boolean {
    return this.baseUrl !== null;
  }

  /**
   * GET a `/v1/*` path and return the decoded JSON body as `unknown`.
   *
   * The caller narrows. `unknown` rather than a generic defaulting to `any` is
   * deliberate: it makes the missing validation a compile-time obligation at
   * every call site instead of an invisible cast.
   *
   * @throws {PlanApiError} one of the four subclasses; never returns a
   *   fabricated empty value, because "no data" and "could not ask" must stay
   *   distinguishable all the way to the Discord message.
   */
  async getJson(
    path: string,
    query?: Readonly<Record<string, string>>,
  ): Promise<unknown> {
    if (!this.baseUrl) {
      // Not `PlanUnreachableError`: that one is transient, and a missing env var
      // is never going to fix itself on a retry. The runner in the next slice
      // branches on `.transient`, so getting this wrong here would make it back
      // off forever against a configuration fault.
      throw new PlanNotConfiguredError();
    }

    const url = this.buildUrl(this.baseUrl, path, query);
    let lastError: PlanApiError | null = null;

    // `<=` because `retries` counts retries, not total attempts: 1 means at most
    // two requests.
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        await delay(RETRY_BASE_DELAY_MS * attempt);
      }

      try {
        return await this.requestOnce(url);
      } catch (error) {
        if (!(error instanceof PlanApiError)) {
          throw error;
        }
        lastError = error;
        if (!error.transient) {
          // A rejected credential or a 404 will not fix itself in 500ms, and
          // retrying only delays the alert.
          throw error;
        }
      }
    }

    // Only reachable when the last attempt failed transiently.
    throw lastError ?? new PlanUnreachableError(url);
  }

  private async requestOnce(url: string): Promise<unknown> {
    let response: Response;

    try {
      response = await fetch(url, {
        method: 'GET',
        headers: this.buildHeaders(),
        // AbortSignal.timeout covers connect *and* body read, which a manual
        // setTimeout around fetch() alone would not: a server that accepts the
        // connection then stalls mid-body would hang the scheduler forever.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      // fetch rejects for DNS, refused connections, TLS and abort alike. To a
      // health check they all mean the same thing: we could not ask.
      throw new PlanUnreachableError(url, cause);
    }

    // Two statuses, two classes, because they carry different information. A
    // 401 is Plan naming its own requirement; a 403 is Plan refusing without
    // saying why, and this layer must not fill in the why.
    if (response.status === 401) {
      throw new PlanAuthError(url);
    }

    if (response.status === 403) {
      throw new PlanForbiddenError(url);
    }

    if (!response.ok) {
      throw new PlanHttpError(
        url,
        response.status,
        await readExcerpt(response),
      );
    }

    const body = await response.text();
    try {
      return JSON.parse(body) as unknown;
    } catch (cause) {
      throw new PlanMalformedResponseError(url, excerpt(body), cause);
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    return headers;
  }

  /**
   * Join base, path and query without letting a caller escape the base URL.
   *
   * `new URL(path, base)` would treat a leading `/` — or a full `http://evil` —
   * as an absolute replacement of the base. No call site takes user input today,
   * but a request builder that can be walked out of its own host is the kind of
   * thing that only becomes a vulnerability after someone reuses it.
   */
  private buildUrl(
    baseUrl: string,
    path: string,
    query?: Readonly<Record<string, string>>,
  ): string {
    // Reject anything that is not a relative path, before building the URL.
    //
    // Stripping the leading slashes below already neutralises the SSRF: a
    // protocol-relative `//evil.example/x` becomes a path on the configured
    // host, not a request to another one. But silently rewriting it produces a
    // confusing 404 from Plan instead of naming the real problem, which is a
    // caller bug. Fail where the mistake is.
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) {
      throw new PlanHttpError(baseUrl, 400, `path invalido: ${path}`);
    }

    const normalised = path.replace(/^\/+/, '');
    const url = new URL(`${baseUrl}/${normalised}`);

    // Belt and braces: a `..` segment normalises away harmlessly, but if any
    // future edit to the lines above lets the origin change, this catches it.
    if (!url.href.startsWith(`${baseUrl}/`)) {
      throw new PlanHttpError(url.href, 400, `path invalido: ${path}`);
    }

    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.href;
  }
}

/** Read a bounded slice of an error body without holding a huge string. */
async function readExcerpt(response: Response): Promise<string> {
  try {
    return excerpt(await response.text());
  } catch {
    return '';
  }
}

function excerpt(body: string): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  // -3 leaves room for the ellipsis itself: the contract is that the excerpt
  // never exceeds BODY_EXCERPT_LIMIT, and the marker counts toward it.
  return collapsed.length <= BODY_EXCERPT_LIMIT
    ? collapsed
    : `${collapsed.slice(0, BODY_EXCERPT_LIMIT - 3)}...`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
