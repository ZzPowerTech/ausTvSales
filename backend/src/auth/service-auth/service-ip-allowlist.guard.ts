import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { ServiceIpAllowlistService } from './service-ip-allowlist.service';

/**
 * Hint for a principal that calls from **another machine**: a private address
 * here is almost never a foreign caller being blocked, it is the app reading the
 * proxy hop instead of the real client.
 */
export const PROXY_MISMATCH_HINT =
  'endereco privado/loopback: provavelmente o proxy, nao o cliente real.' +
  ' Verifique TRUST_PROXY (logado no boot) e se o proxy envia X-Forwarded-For';

/**
 * Shared source-IP allowlist guard for the API's service principals.
 *
 * Applied BEFORE the API-key guard by every principal's auth decorator, so a
 * request from an unlisted IP is rejected without the key ever being evaluated —
 * a leaked key is useless off the host that is supposed to hold it, and
 * arbitrary internet clients never reach the scrypt derivation.
 *
 * The client IP comes from `request.ip`, which is only trustworthy because the
 * app sets `trust proxy` to the Nginx hop (see `main.ts`): Express then derives
 * `req.ip` from the proxy-supplied `X-Forwarded-For` and ignores a header forged
 * by a client connecting directly.
 *
 * A rejected request answers `403 Forbidden` — the caller is not allowed to
 * reach this route, regardless of credentials. That distinction matters to the
 * plugin, whose status contract treats 4xx as permanent: a genuinely unlisted
 * source is not retried in a loop, so a misconfiguration surfaces immediately in
 * the go-live check rather than silently draining the queue.
 */
export abstract class ServiceIpAllowlistGuard implements CanActivate {
  protected constructor(
    private readonly allowlist: ServiceIpAllowlistService,
    /** Name of the principal, used only in the rejection log. */
    private readonly principal: string,
    private readonly logger: Logger,
    /**
     * What to add to the log when a **private/loopback** source is refused.
     *
     * There is always something worth saying, which is why this replaced a
     * boolean that suppressed the hint entirely. A private address reaching a
     * principal that calls from another machine means `trust proxy` does not
     * match how the proxy reaches this process; a private address refused for a
     * co-located principal means the configured value is not the one this
     * deployment actually produces. Different causes, same symptom, and neither
     * is helped by silence — the boolean version turned off the only diagnostic
     * pointing at the cause of an incident this repo has already had.
     */
    private readonly privateSourceHint = PROXY_MISMATCH_HINT,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const ip = request.ip;

    if (!this.allowlist.isAllowed(ip)) {
      this.logger.warn(
        `Rejected ${this.principal} request ${request.method} ${request.originalUrl} from ${ip ?? 'unknown'}: source IP not in allowlist${this.proxyHint(ip)}`,
      );
      throw new ForbiddenException();
    }

    return true;
  }

  /**
   * A private/loopback source is almost never a foreign caller being blocked, so
   * the log names the likely cause instead of leaving the operator to recognise
   * a bridge-gateway address on their own. What that cause *is* differs per
   * principal, which is why the text is injected.
   */
  private proxyHint(ip: string | undefined): string {
    if (!ip || !ServiceIpAllowlistService.isPrivateAddress(ip)) {
      return '';
    }
    return ` — ${this.privateSourceHint}`;
  }
}
