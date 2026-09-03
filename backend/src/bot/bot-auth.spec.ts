import { ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotApiKeyGuard } from './bot-api-key.guard';
import { BotApiKeyService } from './bot-api-key.service';
import { BotIpAllowlistGuard } from './bot-ip-allowlist.guard';
import { BotIpAllowlistService } from './bot-ip-allowlist.service';

const BOT_KEY =
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const INGEST_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function config(values: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`${key} missing`);
      return value;
    },
  } as unknown as ConfigService;
}

function contextFrom(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/**
 * The bot's principal (story S10.2).
 *
 * The mechanism — scrypt, constant-time comparison, header parsing, address
 * normalization — is shared with ingest and is covered by the ingest specs. What
 * is only true here is the **wiring**: that this principal reads its own
 * variables, that it does not accept the plugin's key, and that it treats a
 * loopback source as normal rather than as a proxy misconfiguration.
 */
describe('bot principal', () => {
  describe('BotApiKeyService', () => {
    it('accepts its own key', async () => {
      const service = new BotApiKeyService(config({ BOT_API_KEYS: BOT_KEY }));
      await expect(service.matches(BOT_KEY)).resolves.toBe(true);
    });

    it('does not accept the ingest key', async () => {
      // The whole reason the key sets are separate: a leaked bot key must not
      // become permission to submit sales, and vice versa.
      const service = new BotApiKeyService(config({ BOT_API_KEYS: BOT_KEY }));
      await expect(service.matches(INGEST_KEY)).resolves.toBe(false);
    });

    it('accepts either key during a rotation window', async () => {
      const service = new BotApiKeyService(
        config({ BOT_API_KEYS: `${BOT_KEY},${INGEST_KEY}` }),
      );
      await expect(service.matches(BOT_KEY)).resolves.toBe(true);
      await expect(service.matches(INGEST_KEY)).resolves.toBe(true);
    });

    it('refuses to boot with an empty key set', () => {
      expect(
        () => new BotApiKeyService(config({ BOT_API_KEYS: ' , ' })),
      ).toThrow(/BOT_API_KEYS/);
    });
  });

  describe('BotApiKeyGuard', () => {
    const guard = () =>
      new BotApiKeyGuard(
        new BotApiKeyService(config({ BOT_API_KEYS: BOT_KEY })),
      );

    it('accepts the key in X-Api-Key', async () => {
      await expect(
        guard().canActivate(
          contextFrom({ headers: { 'x-api-key': BOT_KEY }, method: 'POST' }),
        ),
      ).resolves.toBe(true);
    });

    it('accepts the key as a bearer token', async () => {
      await expect(
        guard().canActivate(
          contextFrom({
            headers: { authorization: `Bearer ${BOT_KEY}` },
            method: 'POST',
          }),
        ),
      ).resolves.toBe(true);
    });

    it('rejects the ingest key with 401', async () => {
      await expect(
        guard().canActivate(
          contextFrom({ headers: { 'x-api-key': INGEST_KEY }, method: 'POST' }),
        ),
      ).rejects.toThrow('Unauthorized');
    });

    it('rejects a request with no key at all', async () => {
      await expect(
        guard().canActivate(contextFrom({ headers: {}, method: 'POST' })),
      ).rejects.toThrow('Unauthorized');
    });
  });

  describe('BotIpAllowlistService', () => {
    it('allows the loopback the co-located bot calls from', () => {
      const service = new BotIpAllowlistService(
        config({ BOT_ALLOWED_IPS: '127.0.0.1' }),
      );
      expect(service.isAllowed('127.0.0.1')).toBe(true);
      // IPv4-mapped IPv6, as a dual-stack socket may report it.
      expect(service.isAllowed('::ffff:127.0.0.1')).toBe(true);
    });

    it('blocks a request that arrived through the proxy', () => {
      // This is what the loopback allowlist actually buys: a call routed via
      // Nginx carries the real client address, so the suggestion routes stay
      // unreachable from the internet even if a location block is added.
      const service = new BotIpAllowlistService(
        config({ BOT_ALLOWED_IPS: '127.0.0.1' }),
      );
      expect(service.isAllowed('203.0.113.7')).toBe(false);
    });

    it('is disabled, and says so, when unconfigured', () => {
      const service = new BotIpAllowlistService(config({}));
      expect(service.enabled).toBe(false);
      expect(service.isAllowed('203.0.113.7')).toBe(true);
    });

    it('refuses to boot on a malformed address', () => {
      expect(
        () =>
          new BotIpAllowlistService(config({ BOT_ALLOWED_IPS: 'localhost' })),
      ).toThrow(/BOT_ALLOWED_IPS/);
    });
  });

  describe('BotIpAllowlistGuard', () => {
    const guard = () =>
      new BotIpAllowlistGuard(
        new BotIpAllowlistService(config({ BOT_ALLOWED_IPS: '127.0.0.1' })),
      );

    it('lets the co-located bot through', () => {
      expect(
        guard().canActivate(
          contextFrom({ ip: '127.0.0.1', method: 'POST', headers: {} }),
        ),
      ).toBe(true);
    });

    it('answers 403, not 401, for a foreign source', () => {
      // Different cause, different fix: the caller is not allowed here at all,
      // regardless of what credential it holds.
      expect(() =>
        guard().canActivate(
          contextFrom({ ip: '203.0.113.7', method: 'POST', headers: {} }),
        ),
      ).toThrow(ForbiddenException);
    });

    it('does not blame TRUST_PROXY when a private source is refused', () => {
      // The ingest guard says "this is probably the proxy, check TRUST_PROXY"
      // for a private address, because the plugin calls from another machine.
      // Here loopback is the normal case, so that hint would be a confident
      // pointer at a non-problem on every refusal.
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      const restricted = new BotIpAllowlistGuard(
        new BotIpAllowlistService(config({ BOT_ALLOWED_IPS: '10.0.0.5' })),
      );

      expect(() =>
        restricted.canActivate(
          contextFrom({ ip: '127.0.0.1', method: 'POST', headers: {} }),
        ),
      ).toThrow(ForbiddenException);

      const messages = warn.mock.calls.map((call) => String(call[0]));
      // It did log the refusal — otherwise "no TRUST_PROXY in the messages"
      // would pass on an empty array and prove nothing.
      expect(messages.join(' ')).toContain('source IP not in allowlist');
      expect(messages.join(' ')).not.toContain('TRUST_PROXY');
      warn.mockRestore();
    });
  });
});
