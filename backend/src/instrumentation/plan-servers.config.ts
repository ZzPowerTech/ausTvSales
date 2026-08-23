import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** One Plan instance the checks evaluate. */
export interface PlanServer {
  /** Name as Plan knows it — the value of `?server=`. Case matters. */
  name: string;
  /**
   * True for the network proxy.
   *
   * The distinction is not cosmetic: the proxy records **users**, the backends
   * record **sessions** (spec §2). A session-derived metric is structurally zero
   * on a proxy, so a check that ignores this would report a permanent, false
   * outage. That mistake was made by hand against the AusTV proxy on 2026-08-23
   * before the control test caught it, which is why the flag exists.
   */
  proxy: boolean;
}

/**
 * The Plan instances to evaluate, from configuration (story S6.3).
 *
 * ## Why configuration and not discovery
 *
 * Plan exposes no endpoint that lists servers: `/v1/servers` and
 * `/v1/networkOverview` both return **404** on the AusTV instance (verified
 * 2026-08-23). The list does exist in the `plan_servers` table, but ADR-002
 * forbids this API from touching Plan's tables outside the cohort module, so
 * reading it here would need a second documented exception.
 *
 * Configuration is the honest middle: explicit, reviewable, and a server missing
 * from the list is a deploy mistake rather than a silent gap.
 *
 * ## The cost, stated plainly
 *
 * This is exactly why `plan.orphan_instance` — "a server registered in Plan with
 * no recent data" — **cannot** be built here. Detecting an instance nobody
 * configured requires the list nobody exposes. Left unimplemented rather than
 * faked against the configured list, which would only ever check servers we
 * already know about and would report a clean bill of health for the very case
 * the check exists to catch.
 */
@Injectable()
export class PlanServersConfig implements OnModuleInit {
  private readonly logger = new Logger(PlanServersConfig.name);
  private readonly servers: readonly PlanServer[];

  constructor(config: ConfigService) {
    const names = splitList(config.get<string>('PLAN_SERVERS'));
    const proxyName = config.get<string>('PLAN_PROXY_SERVER')?.trim() ?? '';

    this.servers = names.map((name) => ({
      name,
      // Compared case-insensitively so a casing slip in the env does not
      // silently demote the proxy to a backend and produce a permanent false
      // outage on it.
      proxy: name.toLowerCase() === proxyName.toLowerCase(),
    }));
  }

  onModuleInit(): void {
    if (this.servers.length === 0) {
      this.logger.warn(
        'PLAN_SERVERS nao configurada — nenhum check de servidor vai rodar. ' +
          'Configure com os nomes exatos que o Plan usa (ex: AusTv,Survival).',
      );
      return;
    }

    if (!this.servers.some((server) => server.proxy)) {
      // Not fatal, but worth shouting about: without a proxy the network layer
      // of the funnel has no source, and the backend-only view is the exact
      // partial picture that hid the 54% drop-off for years.
      this.logger.warn(
        `PLAN_PROXY_SERVER nao corresponde a nenhum nome em PLAN_SERVERS ` +
          `(${this.names().join(', ')}) — os checks de proxy nao vao rodar.`,
      );
    }

    this.logger.log(
      `Servidores do Plan: ${this.servers
        .map((server) => `${server.name}${server.proxy ? ' (proxy)' : ''}`)
        .join(', ')}`,
    );
  }

  /** Every configured instance. */
  all(): readonly PlanServer[] {
    return this.servers;
  }

  /** Instances that record sessions — everything except the proxy. */
  backends(): readonly PlanServer[] {
    return this.servers.filter((server) => !server.proxy);
  }

  /** The proxy, or null when none is configured. */
  proxy(): PlanServer | null {
    return this.servers.find((server) => server.proxy) ?? null;
  }

  private names(): string[] {
    return this.servers.map((server) => server.name);
  }
}

function splitList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
