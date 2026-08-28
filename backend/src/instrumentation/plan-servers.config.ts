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
 * The Plan instances this API is **expected** to see, from configuration
 * (story S6.3).
 *
 * ## What this list is, and what it is not
 *
 * It is the *declared* inventory: what a deploy says should exist. It is not a
 * discovery mechanism and must never be mistaken for one — a server absent from
 * here is invisible to every check that iterates it.
 *
 * That is precisely why `plan.orphan_instance` does **not** use this list as its
 * source of truth. It reconciles this declared list against the *observed* one
 * from `PlanDatabase.listServers()`, so the instance nobody configured is
 * exactly what it reports. Checking the configured list against itself would
 * certify health for the one case the check exists to catch.
 *
 * ## Correction of 2026-08-26 — this docblock used to claim the opposite
 *
 * It stated that Plan "exposes no endpoint that lists servers", citing 404s on
 * `/v1/servers` and `/v1/networkOverview`, and concluded that
 * `plan.orphan_instance` **could not be built**. Both halves were wrong:
 *
 * - The endpoint exists. It is **`GET /v1/networkMetadata`** — *"metadata about
 *   the network such as list of servers"* — read from the instance's own OpenAPI
 *   at `/docs`. The two names tried on 2026-08-23 were simply the wrong names.
 * - The check was built anyway, over exception 2 of ADR-002 (`plan_servers` by
 *   read-only SQL), and that 404 conclusion is the **justification the exception
 *   was granted on**. The exception therefore lost its stated motive.
 *
 * The motive being gone is not the same as the exception being closeable: nobody
 * has read the body of `/v1/networkMetadata`, so whether it carries
 * `plan_version` per instance — which `plan.version_divergence` needs — is
 * unknown. Reading it is the trigger to revisit. See ADR-002 in the spec and
 * `HANDOFF.md`.
 *
 * The root error is one this project has now made five times: **concluding
 * absence from a search that did not find**, instead of consulting the source
 * that enumerates. It cost an exception to an ADR, opened on the argument that
 * there was no alternative.
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
