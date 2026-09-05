import { ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { THROTTLER_LIMIT } from '@nestjs/throttler/dist/throttler.constants';
import { BOT_THROTTLE_LIMIT } from '../config/throttling';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { BOT_AUTH_GUARDS, BotAuth } from './bot-auth.decorator';
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
      // And plain IPv6 loopback, which is what Express reports when the caller
      // resolved `localhost` on a dual-stack host — the natural thing for a
      // co-located bot to write, and the form that used to be refused.
      expect(service.isAllowed('::1')).toBe(true);
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
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      const service = new BotIpAllowlistService(config({}));
      expect(service.enabled).toBe(false);
      expect(service.isAllowed('203.0.113.7')).toBe(true);

      // "says so" was unasserted until 2026-09-05, and the text it was not
      // asserting told the operator to set 127.0.0.1 — the exact guess the
      // .env.example, the guard's hint and this class's own JSDoc all say not to
      // make. This warning is the only one of the four an operator reads *at the
      // moment of deploying*, so it was the one place the instruction was
      // inverted. Pinned as a property: the boot warning must send the reader to
      // measure, never hand them a value to copy.
      const messages = warn.mock.calls.map((call) => String(call[0])).join(' ');
      expect(messages).toContain('DISABLED');
      expect(messages).toContain('MEASURE');
      expect(messages).toContain('ops/deploy/s10-sugestoes.md');
      expect(messages).not.toMatch(/Set BOT_ALLOWED_IPS in production \(127/);
      warn.mockRestore();
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

    it('names the co-located cause on a refused loopback, not the proxy one', () => {
      // The first version of this asserted *silence* — the guard was given a
      // flag that suppressed the hint, on the reasoning that loopback is normal
      // for a co-located caller. That turned off the only diagnostic pointing at
      // the one failure that actually happens here: the configured address not
      // being the one this deployment produces.
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

      const messages = warn.mock.calls.map((call) => String(call[0])).join(' ');
      // It did log the refusal — otherwise the assertions below would pass on an
      // empty array and prove nothing.
      expect(messages).toContain('source IP not in allowlist');
      // Its own hint, naming what a co-located principal gets wrong…
      expect(messages).toContain('BOT_ALLOWED_IPS');
      expect(messages).toContain('gateway da bridge');
      // …and not the plugin's, which blames the proxy for reading the wrong hop.
      expect(messages).not.toContain('nao o cliente real');
      warn.mockRestore();
    });
  });
});

describe('@BotAuth()', () => {
  /**
   * The composition, asserted rather than described.
   *
   * The guard classes above are exercised in isolation, and the e2e suite ran
   * with `BOT_ALLOWED_IPS` unset — so deleting `BotIpAllowlistGuard` from the
   * decorator, or the `@Throttle` beside `ThrottlerGuard`, left the whole suite
   * green. The protection against that was a comment.
   */
  class Probe {
    @BotAuth()
    handler(): void {}
  }

  const descriptor = Object.getOwnPropertyDescriptor(
    Probe.prototype,
    'handler',
  ) as PropertyDescriptor;

  it('applies the allowlist, the throttler and the key guard, in that order', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      descriptor.value as object,
    ) as unknown[];

    expect(guards).toEqual([...BOT_AUTH_GUARDS]);
  });

  it('rejects an unlisted source before the key is ever derived', () => {
    // The allowlist first is the property that keeps arbitrary internet clients
    // away from the scrypt derivation.
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      descriptor.value as object,
    ) as unknown[];

    expect(guards.indexOf(BotIpAllowlistGuard)).toBeLessThan(
      guards.indexOf(BotApiKeyGuard),
    );
  });

  it('carries a throttle profile, not just the guard', () => {
    // `@Throttle` alone is inert metadata and `ThrottlerGuard` alone inherits
    // the ingest profile — 10 req/s on a staff route. Both, or neither works.
    // The key is suffixed with the profile name — `@Throttle({ default: … })`
    // writes `THROTTLER:LIMITdefault`. Read from the constant plus the name, so
    // a rename of the profile fails here instead of silently asserting nothing.
    const limit = Reflect.getMetadata(
      `${THROTTLER_LIMIT}default`,
      descriptor.value as object,
    ) as number | undefined;

    expect(limit).toBe(BOT_THROTTLE_LIMIT);
  });

  it('marks the route public to the session guard', () => {
    // Without `@Public()` the global deny-by-default guard would reject the bot,
    // which has no session — and the route would be documented as needing a
    // dashboard cookie.
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, descriptor.value as object)).toBe(
      true,
    );
  });
});
