import { Environment, validateEnv } from './env.validation';

describe('validateEnv', () => {
  it('accepts a valid configuration', () => {
    const result = validateEnv({ NODE_ENV: 'production', PORT: '3000' });

    expect(result.NODE_ENV).toBe(Environment.Production);
    expect(result.PORT).toBe(3000);
  });

  it('defaults NODE_ENV to development when omitted', () => {
    const result = validateEnv({});

    expect(result.NODE_ENV).toBe(Environment.Development);
  });

  it('rejects an unknown NODE_ENV value', () => {
    expect(() => validateEnv({ NODE_ENV: 'staging' })).toThrow();
  });

  it('rejects a PORT outside the valid range', () => {
    expect(() => validateEnv({ NODE_ENV: 'test', PORT: '70000' })).toThrow();
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => validateEnv({ NODE_ENV: 'test', PORT: 'abc' })).toThrow();
  });
});
