import { securityHeadersOptions } from './security-headers.config';

/** Narrow the CSP option shape without an `any` cast in every assertion. */
function directives(
  corsOrigin: string | undefined,
): Record<string, readonly string[]> {
  const csp = securityHeadersOptions(corsOrigin).contentSecurityPolicy;
  if (typeof csp !== 'object' || csp === null) {
    throw new Error('contentSecurityPolicy nao foi configurada');
  }
  return csp.directives as Record<string, readonly string[]>;
}

describe('securityHeadersOptions', () => {
  it('locks the CSP down to nothing, for an API that renders nothing', () => {
    expect(directives(undefined)['default-src']).toEqual(["'none'"]);
  });

  it('spells out the three directives that do not fall back to default-src', () => {
    // `frame-ancestors`, `base-uri` and `form-action` have no fallback in the
    // CSP spec: with only `default-src 'none'` they stay unrestricted, which is
    // the failure mode this assertion exists to keep pinned.
    const value = directives(undefined);

    expect(value['frame-ancestors']).toEqual(["'none'"]);
    expect(value['base-uri']).toEqual(["'none'"]);
    expect(value['form-action']).toEqual(["'none'"]);
  });

  it('does not inherit the browser-app defaults helmet ships with', () => {
    // Helmet's defaults allow `script-src 'self'` and inline styles, which make
    // sense for an HTML app and are pure surface here.
    const csp = securityHeadersOptions(undefined).contentSecurityPolicy;
    expect(csp).toMatchObject({ useDefaults: false });
    expect(directives(undefined)['script-src']).toBeUndefined();
  });

  it('relaxes cross-origin-resource-policy exactly when CORS is enabled', () => {
    // The two decisions come from the same input on purpose: `main.ts` enables
    // CORS only when CORS_ORIGIN is set, and a CORP of `same-origin` there would
    // be a second gate silently closing the door the first one opened.
    expect(
      securityHeadersOptions('http://localhost:4200').crossOriginResourcePolicy,
    ).toEqual({ policy: 'cross-origin' });

    expect(securityHeadersOptions(undefined).crossOriginResourcePolicy).toEqual(
      { policy: 'same-origin' },
    );
  });

  it('treats an empty CORS_ORIGIN as no CORS', () => {
    // `CORS_ORIGIN=` with no value is a realistic .env shape, and `main.ts`
    // reads it as falsy and leaves CORS off. CORP must agree.
    expect(securityHeadersOptions('').crossOriginResourcePolicy).toEqual({
      policy: 'same-origin',
    });
  });

  it('denies framing and sends no referer', () => {
    const options = securityHeadersOptions(undefined);

    expect(options.frameguard).toEqual({ action: 'deny' });
    expect(options.referrerPolicy).toEqual({ policy: 'no-referrer' });
  });
});
