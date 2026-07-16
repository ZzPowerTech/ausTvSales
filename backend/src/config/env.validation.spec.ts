import { Environment, validateEnv } from './env.validation';

const VALID_DB_URL = 'postgresql://user:pass@localhost:5432/austv_sales';

const VALID_INGEST_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// Minimal set of Discord/session/ingest vars required for a config to validate.
const AUTH_ENV = {
  DISCORD_CLIENT_ID: 'client-id',
  DISCORD_CLIENT_SECRET: 'client-secret',
  DISCORD_REDIRECT_URI: 'https://sales.austv.net/api/auth/discord/callback',
  ALLOWED_DISCORD_IDS: '111111111111111111,222222222222222222',
  SESSION_JWT_SECRET: 'a-session-secret-that-is-long-enough-000000',
  INGEST_API_KEYS: VALID_INGEST_KEY,
};

describe('validateEnv', () => {
  it('accepts a valid configuration', () => {
    const result = validateEnv({
      NODE_ENV: 'production',
      PORT: '3000',
      DATABASE_URL: VALID_DB_URL,
      ...AUTH_ENV,
    });

    expect(result.NODE_ENV).toBe(Environment.Production);
    expect(result.PORT).toBe(3000);
    expect(result.DATABASE_URL).toBe(VALID_DB_URL);
  });

  it('defaults NODE_ENV to development when omitted', () => {
    const result = validateEnv({ DATABASE_URL: VALID_DB_URL, ...AUTH_ENV });

    expect(result.NODE_ENV).toBe(Environment.Development);
  });

  it('rejects an unknown NODE_ENV value', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'staging',
        DATABASE_URL: VALID_DB_URL,
        ...AUTH_ENV,
      }),
    ).toThrow();
  });

  it('rejects a PORT outside the valid range', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'test',
        PORT: '70000',
        DATABASE_URL: VALID_DB_URL,
        ...AUTH_ENV,
      }),
    ).toThrow();
  });

  it('rejects a non-numeric PORT', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'test',
        PORT: 'abc',
        DATABASE_URL: VALID_DB_URL,
        ...AUTH_ENV,
      }),
    ).toThrow();
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => validateEnv({ NODE_ENV: 'test', ...AUTH_ENV })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects a DATABASE_URL that is not a postgres connection string', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'test',
        DATABASE_URL: 'mysql://localhost/db',
        ...AUTH_ENV,
      }),
    ).toThrow(/DATABASE_URL/);
  });

  it('accepts both postgres:// and postgresql:// schemes', () => {
    expect(
      validateEnv({ DATABASE_URL: 'postgres://u:p@h:5432/d', ...AUTH_ENV })
        .DATABASE_URL,
    ).toBe('postgres://u:p@h:5432/d');
  });

  it('rejects a SESSION_JWT_SECRET shorter than 32 chars', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: VALID_DB_URL,
        ...AUTH_ENV,
        SESSION_JWT_SECRET: 'too-short',
      }),
    ).toThrow(/SESSION_JWT_SECRET/);
  });

  it('rejects ALLOWED_DISCORD_IDS that is not a comma-separated id list', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: VALID_DB_URL,
        ...AUTH_ENV,
        ALLOWED_DISCORD_IDS: 'not-an-id',
      }),
    ).toThrow(/ALLOWED_DISCORD_IDS/);
  });

  it('rejects a DISCORD_REDIRECT_URI that is not an absolute URL', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: VALID_DB_URL,
        ...AUTH_ENV,
        DISCORD_REDIRECT_URI: '/relative/path',
      }),
    ).toThrow(/DISCORD_REDIRECT_URI/);
  });

  it('accepts a single 64-char hex INGEST_API_KEYS', () => {
    const result = validateEnv({ DATABASE_URL: VALID_DB_URL, ...AUTH_ENV });
    expect(result.INGEST_API_KEYS).toBe(VALID_INGEST_KEY);
  });

  it('accepts multiple comma-separated INGEST_API_KEYS (rotation window)', () => {
    const two = `${VALID_INGEST_KEY}, ${'a'.repeat(64)}`;
    const result = validateEnv({
      DATABASE_URL: VALID_DB_URL,
      ...AUTH_ENV,
      INGEST_API_KEYS: two,
    });
    expect(result.INGEST_API_KEYS).toBe(two);
  });

  it('rejects a missing INGEST_API_KEYS', () => {
    const withoutIngest: Partial<typeof AUTH_ENV> = { ...AUTH_ENV };
    delete withoutIngest.INGEST_API_KEYS;
    expect(() =>
      validateEnv({ DATABASE_URL: VALID_DB_URL, ...withoutIngest }),
    ).toThrow(/INGEST_API_KEYS/);
  });

  it('rejects an INGEST_API_KEYS key that is not 64 hex chars', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: VALID_DB_URL,
        ...AUTH_ENV,
        INGEST_API_KEYS: 'too-short',
      }),
    ).toThrow(/INGEST_API_KEYS/);
  });

  it('rejects INGEST_API_KEYS with a non-hex character', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: VALID_DB_URL,
        ...AUTH_ENV,
        // 64 chars but 'g' is not a hex digit.
        INGEST_API_KEYS: 'g'.repeat(64),
      }),
    ).toThrow(/INGEST_API_KEYS/);
  });
});
