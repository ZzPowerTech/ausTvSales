import type { HelmetOptions } from 'helmet';

/**
 * Response security headers for the API (AusTV Admin S7.2, spec §5.4/§8).
 *
 * ## Why an API needs a CSP at all
 *
 * Almost every response here is JSON consumed by the Angular dashboard, and a
 * `Content-Security-Policy` does nothing for a `fetch()`. The policy exists for
 * the handful of responses a browser may end up *rendering* directly: an Express
 * 404 HTML page, an unhandled-error page, or a JSON body opened straight in a tab
 * with a sniffed content type. Those are exactly the responses that echo a piece
 * of the request back, and they are the cheapest place in the system to turn a
 * reflected-content bug into a non-event.
 *
 * So the policy is the API-shaped one — `default-src 'none'` and nothing
 * allowed — rather than Helmet's default, which is written for a page that
 * actually loads scripts and fonts.
 *
 * ## Cross-origin resource policy tracks the CORS decision
 *
 * `main.ts` only enables CORS when `CORS_ORIGIN` is set, which in practice means
 * development, where the Angular dev server lives on another port. Leaving CORP
 * at `same-origin` there would be a second, invisible gate in front of the one
 * that was deliberately opened, so the two decisions are made from the same
 * input instead of drifting apart.
 *
 * In production the dashboard and the API share `sales.austv.net`, `CORS_ORIGIN`
 * is unset, and CORP stays `same-origin`.
 *
 * ## What is deliberately *not* here
 *
 * No `Access-Control-*` handling (that is `enableCors`), and no rate limiting
 * (that is the throttler). Helmet sets headers; it is not a request filter, and
 * treating it as one is how a team ends up believing it has protection it does
 * not have.
 */
export function securityHeadersOptions(
  corsOrigin: string | undefined,
): HelmetOptions {
  const crossOrigin = Boolean(corsOrigin);

  return {
    contentSecurityPolicy: {
      // `useDefaults: false` on purpose: Helmet's defaults allow `script-src
      // 'self'` and `style-src ... 'unsafe-inline'`, which make sense for an HTML
      // app and are pure surface here. Starting from nothing means every future
      // relaxation has to be written down, which is the point.
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        // Explicit even though `default-src 'none'` already covers it: these
        // three have no fallback to `default-src` in the CSP spec, so omitting
        // them would silently leave framing, `<base>` and form targets open.
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    // Belt and braces with `frame-ancestors` above, for the sake of anything old
    // enough to ignore CSP. Nothing in this API is ever meant to be framed.
    frameguard: { action: 'deny' },
    crossOriginResourcePolicy: {
      policy: crossOrigin ? 'cross-origin' : 'same-origin',
    },
    // A dashboard URL can carry a category or item id in the path. Sending that
    // to whatever the operator clicks next is free information leakage for zero
    // benefit — nothing here needs a referer.
    referrerPolicy: { policy: 'no-referrer' },
  };
}
