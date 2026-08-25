import type { HelmetOptions } from 'helmet';

/** One year. The value browsers expect for a site that intends to stay on TLS. */
export const HSTS_MAX_AGE_SECONDS = 31_536_000;

/**
 * Response security headers for the API (AusTV Admin S7.2, spec §5.4/§8).
 *
 * ## Why an API needs a CSP at all
 *
 * Almost every response here is JSON consumed by the Angular dashboard, and a
 * `Content-Security-Policy` does nothing for a `fetch()`. The policy exists for
 * the handful of responses a browser may end up *rendering* directly: the
 * `Cannot GET /...` HTML page Express's `finalhandler` returns for an unmatched
 * route (there is no global exception filter, so that path is real), or an
 * unhandled-error page. Those are exactly the responses that echo a piece of the
 * request back, and they are the cheapest place in the system to turn a
 * reflected-content bug into a non-event.
 *
 * So the policy is the API-shaped one — `default-src 'none'` and nothing
 * allowed — rather than Helmet's default, which is written for a page that
 * actually loads scripts and fonts.
 *
 * ## Everything Helmet sends is named here, including the boring ones
 *
 * Helmet applies every default middleware for any key that is *not* passed. The
 * headers below that look redundant are written out precisely because they are
 * not: an option nobody wrote down is an option nobody decided. `strictTransport-
 * Security` is the one that matters — see its own note.
 *
 * ## What is deliberately *not* here
 *
 * - **No `sandbox` directive.** It would harden the rendered-response case a
 *   little further at no cost to JSON, but the OAuth routes answer with 302s and
 *   the resulting documents are Discord's and the SPA's. Nothing in the test
 *   suite exercises that round trip in a real browser, so it stays out until
 *   something can prove it harmless rather than argue it.
 * - **No `Access-Control-*` handling** (that is `enableCors`) and **no rate
 *   limiting** (that is the throttler). Helmet sets headers; it is not a request
 *   filter, and treating it as one is how a team ends up believing it has
 *   protection it does not have.
 */
export function securityHeadersOptions(): HelmetOptions {
  return {
    contentSecurityPolicy: {
      // `useDefaults: false` on purpose: Helmet's defaults allow `script-src
      // 'self'` and `style-src ... 'unsafe-inline'`, which make sense for an HTML
      // app and are pure surface here. Starting from nothing means every future
      // relaxation has to be written down, which is the point.
      //
      // NOTE for the Swagger slice of S7.2: `SwaggerModule.setup()` serves
      // swagger-ui assets plus an inline init script, and this policy blocks all
      // of them — the docs page would render blank. The fix is a second,
      // path-scoped `helmet.contentSecurityPolicy(...)` mounted on the docs route
      // *after* this one (later `setHeader` wins), never a relaxation of the
      // global policy that every other route depends on.
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        // Explicit even though `default-src 'none'` already looks like it covers
        // them: these three have no fallback to `default-src` in the CSP spec, so
        // omitting them would silently leave framing, `<base>` and form targets
        // open.
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    // Belt and braces with `frame-ancestors` above, for the sake of anything old
    // enough to ignore CSP. Nothing in this API is ever meant to be framed.
    frameguard: { action: 'deny' },
    /**
     * HSTS, stated rather than inherited.
     *
     * Behind the Nginx TLS terminator the browser sees https, so this **is**
     * honoured: a one-year commitment on `sales.austv.net` and everything under
     * it, and it cannot be taken back from anyone who already visited. That is
     * the intended posture for this deployment, but it is far too consequential
     * to arrive as a Helmet default that nobody wrote down.
     *
     * `preload: false` deliberately — the preload list is a browser-vendor
     * commitment that is genuinely hard to exit, and nothing here needs it.
     *
     * Emitted over plain http in development too (Helmet does not gate on TLS).
     * Harmless: RFC 6797 §8.1 requires browsers to ignore HSTS over http.
     *
     * The canonical place for this header is the TLS terminator. Keeping a copy
     * here is defence in depth for the case where a request reaches the app by
     * some path that does not pass through Nginx.
     */
    strictTransportSecurity: {
      maxAge: HSTS_MAX_AGE_SECONDS,
      includeSubDomains: true,
      preload: false,
    },
    /**
     * `same-origin`, which is also Helmet's default, kept explicit.
     *
     * Safe here because the only cross-origin navigation this API performs is
     * the Discord OAuth redirect, which is a top-level `Location` on a full-page
     * navigation, not a popup handing back a reference through
     * `window.opener`. Were the login ever reworked into a popup flow, this is
     * the line that would sever it, and it should be found by reading rather
     * than by bisecting.
     */
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    /**
     * `same-origin`, unconditionally — including when CORS is enabled in
     * development.
     *
     * The two are not two gates on the same door. CORP is enforced only for
     * `no-cors` requests (subresource embeds: `<script src>`, `<img>`, `<link>`,
     * media) and for nested navigations under COEP; for `cors`-mode requests the
     * cross-origin-resource-policy check is skipped outright. Every call the
     * Angular dashboard makes goes through `HttpClient`, which is cors-mode, so
     * `same-origin` here does not block the dev server — and relaxing it to
     * `cross-origin` would only announce that anyone may embed these responses
     * as a subresource.
     */
    crossOriginResourcePolicy: { policy: 'same-origin' },
    // A dashboard URL can carry a category or item id in the path. Sending that
    // to whatever the operator clicks next is free information leakage for zero
    // benefit — nothing here needs a referer.
    referrerPolicy: { policy: 'no-referrer' },
  };
}
