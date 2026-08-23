import { Injectable } from '@nestjs/common';
import type { HealthCheck } from './health-check.contract';
import type { HealthCheckObservation } from './health-check.store';
import { HealthCheckName, scopedCheckName } from './health-check.types';
import { PlanApiClient } from './plan-api.client';
import { PlanApiError } from './plan-api.errors';
import { parseServerOverview } from './plan-server-overview';
import { PlanServersConfig, type PlanServer } from './plan-servers.config';

/**
 * Is each backend still recording the players that are on it? (spec §6.1)
 *
 * ## The signal, and why this one
 *
 * The spec words this check as "no new session in 6h on a server that should be
 * online". `/v1/serverOverview` exposes no last-session timestamp, so that exact
 * phrasing is not available — but it does expose something sharper: two numbers
 * that **contradict each other** when collection breaks.
 *
 * - `numbers.online_players` — who is connected right now
 * - `last_7_days.unique_players_day` — distinct players recorded today
 *
 * Players online with zero recorded today is arithmetically impossible while the
 * recorder works. It cannot be explained by a quiet day, an off-peak window or a
 * small server, which is what makes it a better trigger than any threshold on
 * player count: it has no false positive from low activity, the failure mode that
 * would train the team to ignore this channel.
 *
 * This is the shape of the disaster that went unnoticed for three months — the
 * server was up and populated while Plan recorded nothing.
 *
 * ## Backends only
 *
 * Proxies record users, not sessions (spec §2), so every session-derived number
 * is structurally zero on one. Running this check against the AusTV proxy would
 * report a permanent outage that does not exist — a mistake made by hand on
 * 2026-08-23 and caught only by a control query. {@link PlanServersConfig.backends}
 * is what keeps it from being made again in code.
 */
@Injectable()
export class CollectionAliveCheck implements HealthCheck {
  readonly name = HealthCheckName.CollectionAlive;

  constructor(
    private readonly plan: PlanApiClient,
    private readonly servers: PlanServersConfig,
  ) {}

  async run(): Promise<HealthCheckObservation[]> {
    const backends = this.servers.backends();

    // Empty is not a verdict: with nothing configured there is nothing to say,
    // and inventing an `ok` would claim health for a system never looked at.
    return Promise.all(backends.map((server) => this.evaluate(server)));
  }

  private async evaluate(server: PlanServer): Promise<HealthCheckObservation> {
    const checkName = scopedCheckName(this.name, server.name);

    let body: unknown;
    try {
      body = await this.plan.getJson('v1/serverOverview', {
        server: server.name,
      });
    } catch (error) {
      // Reaching Plan is itself part of what this check measures, so a transport
      // failure is a real verdict rather than an exception to bubble up.
      const reason =
        error instanceof PlanApiError ? error.message : String(error);
      return {
        checkName,
        status: 'error',
        detail: {
          summary: `Nao foi possivel consultar o Plan: ${reason}`,
          context: { server: server.name },
        },
      };
    }

    const parsed = parseServerOverview(body);
    if (!parsed.ok) {
      // A Plan upgrade that renames a field lands here, named, instead of
      // silently producing wrong numbers.
      return {
        checkName,
        status: 'error',
        detail: {
          summary: `Resposta do Plan em formato inesperado: ${parsed.reason}`,
          context: { server: server.name },
        },
      };
    }

    const { onlinePlayers } = parsed.value.numbers;
    const { uniquePlayersDay } = parsed.value.last7Days;

    if (onlinePlayers === null || uniquePlayersDay === null) {
      // One of the two sides is missing, so the comparison cannot be made. Not a
      // pass and not a failure — saying `ok` here would be the invented
      // measurement the whole epic exists to prevent.
      return {
        checkName,
        status: 'no_data',
        detail: {
          summary:
            'O Plan nao reportou os dois numeros necessarios para comparar ' +
            '(jogadores online e unicos de hoje)',
          context: {
            server: server.name,
            online_players: onlinePlayers,
            unique_players_day: uniquePlayersDay,
          },
        },
      };
    }

    if (onlinePlayers > 0 && uniquePlayersDay === 0) {
      return {
        checkName,
        status: 'breached',
        detail: {
          summary:
            `${onlinePlayers} jogador(es) online agora, mas 0 unico(s) ` +
            'registrado(s) hoje — a coleta do Plan parou neste servidor',
          observed: uniquePlayersDay,
          threshold: 1,
          // `n` is the population the ratio was taken over. The project forbids
          // publishing a number without its base, and an alert is the worst
          // place to break that.
          n: onlinePlayers,
          context: { server: server.name },
        },
      };
    }

    return {
      checkName,
      status: 'ok',
      detail: {
        summary: `${uniquePlayersDay} unico(s) hoje, ${onlinePlayers} online agora`,
        observed: uniquePlayersDay,
        n: onlinePlayers,
        context: { server: server.name },
      },
    };
  }
}
