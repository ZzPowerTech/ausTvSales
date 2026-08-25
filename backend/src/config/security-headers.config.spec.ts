import {
  HSTS_MAX_AGE_SECONDS,
  securityHeadersOptions,
} from './security-headers.config';

/**
 * Narrow the CSP option shape for assertions.
 *
 * Helmet types a directive value as `null | Iterable<...> | symbol`, so the
 * spread is what actually proves it is a list of strings — casting straight to
 * `string[]` would keep compiling if a directive were ever changed to something
 * else entirely.
 */
function directive(name: string): string[] {
  const csp = securityHeadersOptions().contentSecurityPolicy;
  if (typeof csp !== 'object' || csp === null) {
    throw new Error('contentSecurityPolicy nao foi configurada');
  }

  const value = (csp.directives as Record<string, unknown>)[name];
  if (value === undefined) {
    return [];
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error(`diretiva ${name} nao e uma lista: ${typeof value}`);
  }
  return [...(value as Iterable<unknown>)].map(String);
}

describe('securityHeadersOptions', () => {
  it('locks the CSP down to nothing, for an API that renders nothing', () => {
    expect(directive('default-src')).toEqual(["'none'"]);
  });

  it('spells out the three directives that do not fall back to default-src', () => {
    // `frame-ancestors`, `base-uri` and `form-action` have no fallback in the
    // CSP spec: with only `default-src 'none'` they stay unrestricted, which is
    // the failure mode this assertion exists to keep pinned.
    expect(directive('frame-ancestors')).toEqual(["'none'"]);
    expect(directive('base-uri')).toEqual(["'none'"]);
    expect(directive('form-action')).toEqual(["'none'"]);
  });

  it('does not inherit the browser-app defaults helmet ships with', () => {
    // Helmet's defaults allow `script-src 'self'` and inline styles, which make
    // sense for an HTML app and are pure surface here.
    expect(securityHeadersOptions().contentSecurityPolicy).toMatchObject({
      useDefaults: false,
    });
    expect(directive('script-src')).toEqual([]);
  });

  it('keeps cross-origin-resource-policy at same-origin', () => {
    // CORP is enforced only for `no-cors` requests; every call the dashboard
    // makes is cors-mode, so `same-origin` here does not gate the dev server and
    // relaxing it would only invite cross-origin embedding.
    expect(securityHeadersOptions().crossOriginResourcePolicy).toEqual({
      policy: 'same-origin',
    });
  });

  it('states HSTS instead of inheriting it', () => {
    // The most consequential header shipped here: behind the TLS terminator it
    // is a one-year, subdomain-wide commitment that cannot be withdrawn from
    // anyone who already visited. `preload` stays off — that list is genuinely
    // hard to leave.
    expect(securityHeadersOptions().strictTransportSecurity).toEqual({
      maxAge: HSTS_MAX_AGE_SECONDS,
      includeSubDomains: true,
      preload: false,
    });
  });

  it('denies framing, isolates the browsing context and sends no referer', () => {
    const options = securityHeadersOptions();

    expect(options.frameguard).toEqual({ action: 'deny' });
    expect(options.crossOriginOpenerPolicy).toEqual({ policy: 'same-origin' });
    expect(options.referrerPolicy).toEqual({ policy: 'no-referrer' });
  });
});
