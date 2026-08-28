import { ConfigService } from '@nestjs/config';
import { PlanApiClient } from './plan-api.client';
import {
  PlanAuthError,
  PlanForbiddenError,
  PlanHttpError,
  PlanMalformedResponseError,
  PlanNotConfiguredError,
  PlanUnreachableError,
} from './plan-api.errors';

/**
 * Config double. Only the keys the client reads are honoured, so a typo in a key
 * name shows up as a failing expectation rather than a silent default.
 */
function configWith(values: Record<string, unknown>): ConfigService {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

/**
 * Read the `RequestInit` of one recorded fetch call.
 *
 * Goes through a declared tuple type rather than indexing the spy directly:
 * `jest.SpyInstance` without generics types `mock.calls` as `any[]`, and reading
 * through it would disable type checking on every assertion built from it.
 */
function initOfCall(mock: jest.SpyInstance, index = 0): RequestInit {
  const calls = mock.mock.calls as unknown as Array<[string, RequestInit]>;
  return calls[index][1];
}

const BASE = { PLAN_BASE_URL: 'http://game.example:25504', PLAN_RETRIES: 0 };

describe('PlanApiClient', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('configuration', () => {
    it('reports itself unconfigured when PLAN_BASE_URL is absent', () => {
      const client = new PlanApiClient(configWith({}));

      expect(client.configured).toBe(false);
    });

    it('fails the request instead of guessing a host when unconfigured', async () => {
      const client = new PlanApiClient(configWith({}));

      // The point of the epic is that a missing source is visible. Returning an
      // empty payload here would let a check report `ok` while measuring nothing.
      await expect(client.getJson('v1/serverOverview')).rejects.toBeInstanceOf(
        PlanNotConfiguredError,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('classifies a missing base URL as permanent, not transient', async () => {
      const client = new PlanApiClient(configWith({}));

      // A runner that backs off on transient failures must not loop forever
      // against a missing env var, and the operator must be pointed at the
      // deploy config rather than at a network incident.
      const error = (await client
        .getJson('v1/serverOverview')
        .catch((e: unknown) => e)) as PlanNotConfiguredError;

      expect(error.transient).toBe(false);
    });

    it('warns at boot when unconfigured, rather than failing silently', () => {
      const client = new PlanApiClient(configWith({}));
      const warn = jest
        .spyOn(client['logger'], 'warn')
        .mockImplementation(() => undefined);

      client.onModuleInit();

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('PLAN_BASE_URL'),
      );
    });

    it('does not log the token at boot', () => {
      const client = new PlanApiClient(
        configWith({ ...BASE, PLAN_API_TOKEN: 'super-secret-value' }),
      );
      const log = jest
        .spyOn(client['logger'], 'log')
        .mockImplementation(() => undefined);

      client.onModuleInit();

      const logged = log.mock.calls.flat().join(' ');
      expect(logged).not.toContain('super-secret-value');
      expect(logged).toContain('com token');
    });
  });

  describe('URL building', () => {
    it('joins base and path without doubling the slash', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));
      const client = new PlanApiClient(
        configWith({ ...BASE, PLAN_BASE_URL: 'http://game.example:25504/' }),
      );

      await client.getJson('/v1/serverOverview');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://game.example:25504/v1/serverOverview',
        expect.anything(),
      );
    });

    it('appends query parameters, encoding them', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));
      const client = new PlanApiClient(configWith(BASE));

      await client.getJson('v1/graph', { type: 'uniqueAndNew' });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://game.example:25504/v1/graph?type=uniqueAndNew',
        expect.anything(),
      );
    });

    it('refuses a path that would escape the configured host', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));
      const client = new PlanApiClient(configWith(BASE));

      // No call site takes user input today, but a builder that can be walked
      // off its own host becomes a vulnerability the moment one does.
      await expect(
        client.getJson('//evil.example/v1/serverOverview'),
      ).rejects.toBeInstanceOf(PlanHttpError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses an absolute URL with its own scheme', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));
      const client = new PlanApiClient(configWith(BASE));

      await expect(
        client.getJson('http://evil.example/v1/serverOverview'),
      ).rejects.toBeInstanceOf(PlanHttpError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('normalises a traversal segment without leaving the host', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));
      const client = new PlanApiClient(configWith(BASE));

      // `..` is harmless here — URL normalisation keeps it on the same origin —
      // so this asserts it is allowed through rather than spuriously rejected.
      await client.getJson('v1/../v1/serverOverview');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://game.example:25504/v1/serverOverview',
        expect.anything(),
      );
    });
  });

  describe('authentication header', () => {
    it('sends a bearer token when configured', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));
      const client = new PlanApiClient(
        configWith({ ...BASE, PLAN_API_TOKEN: 'tok' }),
      );

      await client.getJson('v1/serverOverview');

      const init = initOfCall(fetchMock);
      expect(init.headers).toMatchObject({ Authorization: 'Bearer tok' });
    });

    it('omits the header entirely when no token is configured', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));
      const client = new PlanApiClient(configWith(BASE));

      await client.getJson('v1/serverOverview');

      const init = initOfCall(fetchMock);
      expect(init.headers).not.toHaveProperty('Authorization');
    });
  });

  describe('success', () => {
    it('returns the decoded body', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ servers: [{ name: 'proxy' }] }),
      );
      const client = new PlanApiClient(configWith(BASE));

      await expect(client.getJson('v1/serverOverview')).resolves.toEqual({
        servers: [{ name: 'proxy' }],
      });
    });
  });

  describe('failure classification', () => {
    it('maps HTTP 401 to PlanAuthError and does not retry it', async () => {
      fetchMock.mockResolvedValue(textResponse('denied', 401));
      const client = new PlanApiClient(
        configWith({ ...BASE, PLAN_RETRIES: 3 }),
      );

      await expect(client.getJson('v1/serverOverview')).rejects.toBeInstanceOf(
        PlanAuthError,
      );
      // A rejected credential will not fix itself; retrying only delays the
      // alert and hides that the cause is our own configuration.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('maps HTTP 403 to PlanForbiddenError, not to PlanAuthError', async () => {
      fetchMock.mockResolvedValue(textResponse('denied', 403));
      const client = new PlanApiClient(
        configWith({ ...BASE, PLAN_RETRIES: 3 }),
      );

      const error: unknown = await client
        .getJson('v1/serverOverview')
        .catch((e: unknown) => e);

      // The distinction is the point of the split: this Plan answers 403 for an
      // unknown server name and for a whitelist rejection, neither of which is a
      // credential being wrong. Labelling it `auth` sent the reader to
      // PLAN_API_TOKEN — the one thing that could not be the cause on an
      // instance whose `/v1/whoami` reports `authRequired: false`.
      expect(error).toBeInstanceOf(PlanForbiddenError);
      expect(error).not.toBeInstanceOf(PlanAuthError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('names the 403 candidates instead of asserting one cause', () => {
      const message = new PlanForbiddenError('http://plan:25504/v1/x').message;

      expect(message).toContain('nome de servidor');
      expect(message).toContain('whitelist');
      expect(message).toContain('permissao web');
      // The regression this guards: the old message read "recusou a credencial".
      expect(message).not.toContain('credencial');
    });

    it('maps a 404 to PlanHttpError without retrying', async () => {
      fetchMock.mockResolvedValue(textResponse('not found', 404));
      const client = new PlanApiClient(
        configWith({ ...BASE, PLAN_RETRIES: 2 }),
      );

      await expect(client.getJson('v1/nope')).rejects.toBeInstanceOf(
        PlanHttpError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('retries a 500 and then gives up', async () => {
      fetchMock.mockResolvedValue(textResponse('boom', 500));
      const client = new PlanApiClient(
        configWith({ ...BASE, PLAN_RETRIES: 2 }),
      );

      await expect(client.getJson('v1/serverOverview')).rejects.toBeInstanceOf(
        PlanHttpError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('recovers when a transient failure succeeds on retry', async () => {
      fetchMock
        .mockResolvedValueOnce(textResponse('boom', 503))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
      const client = new PlanApiClient(
        configWith({ ...BASE, PLAN_RETRIES: 1 }),
      );

      await expect(client.getJson('v1/serverOverview')).resolves.toEqual({
        ok: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('maps a rejected fetch to PlanUnreachableError, preserving the cause', async () => {
      const cause = new TypeError('ECONNREFUSED');
      fetchMock.mockRejectedValue(cause);
      const client = new PlanApiClient(configWith(BASE));

      const error = await client
        .getJson('v1/serverOverview')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PlanUnreachableError);
      expect((error as PlanUnreachableError).cause).toBe(cause);
    });

    it('maps a 2xx HTML body to PlanMalformedResponseError', async () => {
      // This is what a misconfigured Plan login page looks like from here, and
      // it must not be mistaken for an outage — the server is up and answering.
      fetchMock.mockResolvedValue(
        textResponse('<html><body>Login</body></html>'),
      );
      const client = new PlanApiClient(configWith(BASE));

      await expect(client.getJson('v1/serverOverview')).rejects.toBeInstanceOf(
        PlanMalformedResponseError,
      );
    });

    it('quotes a bounded excerpt of an unexpected body', async () => {
      fetchMock.mockResolvedValue(textResponse('x'.repeat(5_000), 500));
      const client = new PlanApiClient(configWith(BASE));

      const error = (await client
        .getJson('v1/serverOverview')
        .catch((e: unknown) => e)) as PlanHttpError;

      expect(error.bodyExcerpt.length).toBeLessThanOrEqual(200);
      expect(error.bodyExcerpt.endsWith('...')).toBe(true);
    });

    it('leaves a body at exactly the limit untruncated', async () => {
      fetchMock.mockResolvedValue(textResponse('y'.repeat(200), 500));
      const client = new PlanApiClient(configWith(BASE));

      const error = (await client
        .getJson('v1/serverOverview')
        .catch((e: unknown) => e)) as PlanHttpError;

      expect(error.bodyExcerpt).toBe('y'.repeat(200));
    });

    it('marks 5xx and 429 transient, and 4xx not', () => {
      expect(new PlanHttpError('u', 500, '').transient).toBe(true);
      expect(new PlanHttpError('u', 429, '').transient).toBe(true);
      expect(new PlanHttpError('u', 400, '').transient).toBe(false);
      expect(new PlanAuthError('u').transient).toBe(false);
      expect(new PlanForbiddenError('u').transient).toBe(false);
      expect(new PlanUnreachableError('u').transient).toBe(true);
    });
  });

  describe('timeout', () => {
    it('passes an abort signal so a stalled body cannot hang the scheduler', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));
      const client = new PlanApiClient(
        configWith({ ...BASE, PLAN_TIMEOUT_MS: 1_234 }),
      );

      await client.getJson('v1/serverOverview');

      const init = initOfCall(fetchMock);
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });
  });
});
