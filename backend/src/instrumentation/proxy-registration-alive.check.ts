import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { HealthCheck } from './health-check.contract';
import type { HealthCheckObservation } from './health-check.store';
import { HealthCheckName } from './health-check.types';
import { PlanDatabase } from './plan-database';

const DEFAULT_MAX_SILENCE_HOURS = 24;
const MS_PER_HOUR = 3_600_000;

/**
 * Is the network still registering anyone? (spec §6.1)
 *
 * ## The check the spec names by table
 *
 * §6.1 words this one as *"nenhum **`plan_users.registered`** novo em 24h"* — it
 * names the table, not an endpoint. That is why ADR-002 exception 2 was extended
 * to `plan_users`: the spec already assumed database access here, and the API
 * genuinely cannot serve it. The proxy records **users** and the backends record
 * **sessions** (§2), so every session-derived endpoint is structurally empty for
 * the proxy — `graph?type=uniqueAndNew` returns empty arrays for it and
 * `serverOverview` returns `numbers: {}`. Verified against production on
 * 2026-08-23.
 *
 * ## The disaster it exists for
 *
 * The proxy's Plan stopped collecting from **May to August 2026** and nobody
 * noticed for three months. Acquisition — the top of the funnel, the number every
 * campaign is judged by — was simply absent, and the dashboards that existed had
 * no way to say so.
 *
 * ## Why silence, not a count
 *
 * The trigger is *how long since the last registration*, never *how many arrived*.
 * A count threshold would fire on a genuinely quiet night and train the team to
 * mute the channel; elapsed silence cannot be explained away by low traffic, and
 * on a server that sees arrivals daily it is unambiguous.
 */
@Injectable()
export class ProxyRegistrationAliveCheck implements HealthCheck {
  readonly name = HealthCheckName.ProxyRegistrationAlive;

  private readonly maxSilenceMs: number;

  constructor(
    private readonly db: PlanDatabase,
    config: ConfigService,
  ) {
    const hours =
      config.get<number>('PROXY_REGISTRATION_MAX_SILENCE_HOURS') ??
      DEFAULT_MAX_SILENCE_HOURS;
    this.maxSilenceMs = hours * MS_PER_HOUR;
  }

  async run(): Promise<HealthCheckObservation[]> {
    let arrivals;
    try {
      arrivals = await this.db.networkArrivals();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return [
        {
          checkName: this.name,
          status: 'error',
          detail: { summary: `Nao foi possivel ler plan_users: ${reason}` },
        },
      ];
    }

    if (arrivals.total === 0) {
      // An empty identity table is not "nobody arrived recently" — it is a
      // network with no history at all, which on a live server means the read
      // found the wrong database. That is §1's founding disaster verbatim: the
      // production Plan on SQLite while the MySQL being queried was half empty.
      //
      // So `error`, not `no_data`: `decideAlerts` suppresses a `no_data` with
      // nothing open on the check as `not_notifiable`, forever, meaning the
      // single verdict that would have named the SQLite disaster is the one that
      // never reaches Discord. `no_data` is for a window that came back empty;
      // an identity table has no window.
      return [
        {
          checkName: this.name,
          status: 'error',
          detail: {
            summary:
              'plan_users nao tem nenhum registro — a leitura provavelmente ' +
              'encontrou o banco errado',
            n: 0,
          },
        },
      ];
    }

    if (arrivals.lastRegisteredAt === null) {
      // Rows exist, but no usable `MAX(registered)`. Deliberately a *different*
      // verdict from the one above, and it names no cause.
      //
      // The two came from the same branch until 2026-08-30, keyed on
      // `lastRegisteredAt === null`, and that was wrong in a way worth spelling
      // out: `total` is a `COUNT(*)` while `lastRegisteredAt` runs through
      // `toNumber`, which returns null for an empty table **and** for any shape
      // it does not expect — a `Date`, a non-numeric string, a driver bump that
      // changes how a BIGINT comes back. `toNumber`'s own docblock names that as
      // the bug that only shows up after a dependency upgrade.
      //
      // Merged, a mysql2 bump would have told the channel every fifteen minutes
      // that the read "probably found the wrong database", about a perfectly
      // healthy Plan, while `n` in the same payload said 5566. Alerting on a
      // diagnosis the code never established is worse than not alerting: it
      // sends someone to the wrong system.
      return [
        {
          checkName: this.name,
          status: 'error',
          detail: {
            summary:
              `plan_users tem ${arrivals.total} linha(s), mas nenhuma data de ` +
              'registro legivel — a coluna mudou de tipo ou o driver mudou de ' +
              'formato. NAO e o mesmo que tabela vazia.',
            n: arrivals.total,
          },
        },
      ];
    }

    const silenceMs = Date.now() - arrivals.lastRegisteredAt;
    const silenceHours = Math.round((silenceMs / MS_PER_HOUR) * 10) / 10;
    const thresholdHours = this.maxSilenceMs / MS_PER_HOUR;

    const common = {
      observed: silenceHours,
      threshold: thresholdHours,
      // The population behind the verdict. The rule is that no number is
      // published without its base, and the base here is the whole network.
      n: arrivals.total,
      context: {
        ultimo_registro: new Date(arrivals.lastRegisteredAt).toISOString(),
      },
    };

    if (silenceMs > this.maxSilenceMs) {
      return [
        {
          checkName: this.name,
          status: 'breached',
          detail: {
            ...common,
            summary:
              `Nenhum jogador novo registrado na rede ha ${silenceHours}h ` +
              `(limite ${thresholdHours}h) — a coleta do proxy pode ter parado`,
          },
        },
      ];
    }

    return [
      {
        checkName: this.name,
        status: 'ok',
        detail: {
          ...common,
          summary: `Ultimo registro de rede ha ${silenceHours}h`,
        },
      },
    ];
  }
}
