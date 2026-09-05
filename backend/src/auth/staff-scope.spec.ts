import {
  ExecutionContext,
  ForbiddenException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StaffScopeGuard } from './staff-scope.guard';
import { StaffScopeService } from './staff-scope.service';

const OWNER = '111111111111111111';
const SECOND_OPERATOR = '222222222222222222';

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

function contextFor(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user, method: 'PATCH', url: '/admin/x' }),
    }),
  } as unknown as ExecutionContext;
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('StaffScopeService', () => {
  it('falls back to the dashboard allowlist when no staff list is set', () => {
    // The state on day one, and the reason it is stated out loud: the check
    // currently refuses nobody. A test that asserted only "the owner is staff"
    // would read as though the two sets were already separate.
    const service = new StaffScopeService(
      config({ ALLOWED_DISCORD_IDS: `${OWNER},${SECOND_OPERATOR}` }),
    );

    expect(service.source).toBe('admin_allowlist');
    expect(service.isStaff(OWNER)).toBe(true);
    expect(service.isStaff(SECOND_OPERATOR)).toBe(true);
  });

  it('narrows to the staff list when one is set', () => {
    const service = new StaffScopeService(
      config({
        ALLOWED_DISCORD_IDS: `${OWNER},${SECOND_OPERATOR}`,
        STAFF_DISCORD_IDS: OWNER,
      }),
    );

    expect(service.source).toBe('staff_list');
    expect(service.isStaff(OWNER)).toBe(true);
    // The whole point of the variable: somebody who can sign in and cannot
    // write. Without this case the guard would never have been exercised
    // against a real refusal.
    expect(service.isStaff(SECOND_OPERATOR)).toBe(false);
  });

  it('treats an empty or blank staff list as absent, not as "nobody"', () => {
    // `STAFF_DISCORD_IDS=` in a .env is the ordinary way to write "not
    // configured yet". Reading it as an empty set would lock every staff action
    // out of the dashboard with a 403 nobody could explain.
    for (const blank of ['', '   ', ' , ']) {
      const service = new StaffScopeService(
        config({
          ALLOWED_DISCORD_IDS: OWNER,
          STAFF_DISCORD_IDS: blank,
        }),
      );
      expect(service.source).toBe('admin_allowlist');
      expect(service.isStaff(OWNER)).toBe(true);
    }
  });

  it('ignores whitespace around ids', () => {
    const service = new StaffScopeService(
      config({
        ALLOWED_DISCORD_IDS: OWNER,
        STAFF_DISCORD_IDS: `  ${OWNER} ,  ${SECOND_OPERATOR}  `,
      }),
    );

    expect(service.isStaff(OWNER)).toBe(true);
    expect(service.isStaff(SECOND_OPERATOR)).toBe(true);
  });
});

describe('StaffScopeGuard', () => {
  const guardWith = (values: Record<string, string | undefined>) =>
    new StaffScopeGuard(new StaffScopeService(config(values)));

  it('lets a staff member through', () => {
    const guard = guardWith({
      ALLOWED_DISCORD_IDS: `${OWNER},${SECOND_OPERATOR}`,
      STAFF_DISCORD_IDS: OWNER,
    });

    expect(
      guard.canActivate(contextFor({ discordId: OWNER, username: 'Murilo' })),
    ).toBe(true);
  });

  it('refuses an authenticated user outside the scope with 403, not 401', () => {
    // The distinction is the message the person on the other end reads: 401
    // says "sign in", 403 says "you are signed in and this is not yours". A
    // guard that answered 401 here would send somebody to log in again forever.
    const guard = guardWith({
      ALLOWED_DISCORD_IDS: `${OWNER},${SECOND_OPERATOR}`,
      STAFF_DISCORD_IDS: OWNER,
    });

    expect(() =>
      guard.canActivate(
        contextFor({ discordId: SECOND_OPERATOR, username: 'Outro' }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('refuses rather than allows when there is no user on the request', () => {
    // Unreachable through the HTTP stack today — the global session guard runs
    // first — and asserted because the natural spelling of the mistake
    // (`isStaff(user?.discordId ?? '')`) grants access to an anonymous caller
    // the day this guard lands on a `@Public()` route.
    const guard = guardWith({ ALLOWED_DISCORD_IDS: OWNER });

    expect(() => guard.canActivate(contextFor(undefined))).toThrow(
      UnauthorizedException,
    );
  });
});
