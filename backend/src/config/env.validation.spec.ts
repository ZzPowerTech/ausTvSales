import { Environment, validateEnv } from './env.validation';

const VALID_DB_URL = 'postgresql://user:pass@localhost:5432/austv_sales';

describe('validateEnv', () => {
  it('accepts a valid configuration', () => {
    const result = validateEnv({
      NODE_ENV: 'production',
      PORT: '3000',
      DATABASE_URL: VALID_DB_URL,
    });

    expect(result.NODE_ENV).toBe(Environment.Production);
    expect(result.PORT).toBe(3000);
    expect(result.DATABASE_URL).toBe(VALID_DB_URL);
  });

  it('defaults NODE_ENV to development when omitted', () => {
    const result = validateEnv({ DATABASE_URL: VALID_DB_URL });

    expect(result.NODE_ENV).toBe(Environment.Development);
  });

  it('rejects an unknown NODE_ENV value', () => {
    expect(() =>
      validateEnv({ NODE_ENV: 'staging', DATABASE_URL: VALID_DB_URL }),
    ).toThrow();
  });

  it('rejects a PORT outside the valid range', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'test',
        PORT: '70000',
        DATABASE_URL: VALID_DB_URL,
      }),
    ).toThrow();
  });

  it('rejects a non-numeric PORT', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'test',
        PORT: 'abc',
        DATABASE_URL: VALID_DB_URL,
      }),
    ).toThrow();
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => validateEnv({ NODE_ENV: 'test' })).toThrow(/DATABASE_URL/);
  });

  it('rejects a DATABASE_URL that is not a postgres connection string', () => {
    expect(() =>
      validateEnv({ NODE_ENV: 'test', DATABASE_URL: 'mysql://localhost/db' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('accepts both postgres:// and postgresql:// schemes', () => {
    expect(
      validateEnv({ DATABASE_URL: 'postgres://u:p@h:5432/d' }).DATABASE_URL,
    ).toBe('postgres://u:p@h:5432/d');
  });
});
