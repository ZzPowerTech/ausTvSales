import { resolveTrustProxy } from './trust-proxy';

describe('resolveTrustProxy', () => {
  it('defaults to loopback when unset', () => {
    expect(resolveTrustProxy(undefined)).toBe('loopback');
  });

  it('turns a bare integer into a hop count', () => {
    // The right setting for "one proxy in front", and the one that survives a
    // Docker bridge being renumbered — unlike a hardcoded subnet.
    expect(resolveTrustProxy('1')).toBe(1);
    expect(resolveTrustProxy(' 2 ')).toBe(2);
  });

  it('passes presets, IPs and lists through untouched', () => {
    expect(resolveTrustProxy('loopback')).toBe('loopback');
    expect(resolveTrustProxy('172.27.0.0/16')).toBe('172.27.0.0/16');
    expect(resolveTrustProxy('10.0.0.1,10.0.0.2')).toBe('10.0.0.1,10.0.0.2');
  });

  it('falls back to the default when the variable is present but empty', () => {
    // `TRUST_PROXY=` with no value is a realistic .env shape; before this it
    // resolved to '' and Express got an empty setting instead of 'loopback'.
    expect(resolveTrustProxy('')).toBe('loopback');
    expect(resolveTrustProxy('   ')).toBe('loopback');
  });
});
