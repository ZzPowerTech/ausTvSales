import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { ServiceIpAllowlistService } from './service-ip-allowlist.service';

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
     * Whether a private/loopback source is expected for this principal.
     *
     * For the plugin it is not — it calls from another machine — so a private
     * address means the app is reading the proxy hop instead of the real client.
     * For the Discord bot, which runs on this very VPS, loopback is the normal
     * case and the hint would be noise pointing at a non-problem.
     */
    private readonly expectsPrivateSource = false,
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
   * For a principal that calls from another machine, a private/loopback address
   * here almost never means "a foreign caller was blocked" — it means `trust
   * proxy` does not match how the proxy reaches this process. That is a config
   * mistake whose symptom is legitimate traffic being refused, so the log points
   * at it directly instead of leaving the operator to recognise a
   * bridge-gateway address on their own.
   */
  private proxyHint(ip: string | undefined): string {
    if (
      this.expectsPrivateSource ||
      !ip ||
      !ServiceIpAllowlistService.isPrivateAddress(ip)
    ) {
      return '';
    }
    return (
      ' — endereco privado/loopback: provavelmente o proxy, nao o cliente real.' +
      ' Verifique TRUST_PROXY (logado no boot) e se o proxy envia X-Forwarded-For'
    );
  }
}
