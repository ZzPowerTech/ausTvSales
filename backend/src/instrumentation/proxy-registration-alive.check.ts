import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { HealthCheck } from './health-check.contract';
import type { HealthCheckObservation } from './health-check.store';
import { HealthCheckName } from './health-check.types';
import { PlanDatabase } from './plan-database';

const DEFAULT_MAX_SILENCE_HOURS = 24;
const MS_PER_HOUR = 3_600_000;

/**
 * Is anyone still being registered in `plan_users`? (spec §6.1)
 *
 * ## The check the spec names by table
 *
 * §6.1 words this one as *"nenhum **`plan_users.registered`** novo em 24h"* — it
 * names the table, not an endpoint. That is why ADR-002 exception 2 was extended
 * to `plan_users`: the spec already assumed database access here, and the API
 * genuinely cannot serve it. The proxy records **users** and the backends record
 * **sessions** (§2), so every session-derived metric is structurally empty for
 * the proxy.
 *
 * Re-measured against production on **2026-09-01**, and half the old wording had
 * drifted. `graph?type=uniqueAndNew&server=AusTv` still returns empty arrays for
 * `uniquePlayers` and `newPlayers` — unchanged since 2026-08-23. But
 * `serverOverview?server=AusTv` **no longer returns `numbers: {}`**: it returns
 * fourteen fields, with every session-derived one at **zero** (`sessions: 0`,
 * `total_players: 0`, `playtime: 0`) beside proxy-native ones that are real
 * (`online_players: 19`, `best_peak_players: "37"`).
 *
 * ⚠️ **The substance held and the form got more dangerous.** An absent field is
 * self-evidently absent; a `0` is a number, and this project exists because a
 * collection gap read as zero stayed invisible for months. Nothing here consumes
 * it today — every check iterates `PlanServersConfig.backends()`, which excludes
 * the proxy, and that class exists precisely so this mistake is not repeated —
 * but `serverOverview?server=<proxy>` is now a live source of plausible zeros.
 *
 * ## ⚠️ It does not watch the proxy, and its name says it does
 *
 * The disaster on record is the proxy's Plan collecting nothing from **May to
 * August 2026**, unnoticed for three months. This check was written for that.
 * Measured on 2026-08-31, it cannot see it: `plan_users` holds the **Survival**
 * in this installation — zero proxy players in `plan_user_info`, and eight
 * months of monthly counts matching the `survival` column of `HANDOFF.md` to the
 * row. Through the very outage it was built for, the verified table shows the
 * proxy dead (`Plan morto`) while Survival kept registering 106 players in
 * 2026-06. Registration silence here would have stayed at zero hours.
 *
 * What it *does* watch is real and worth watching: registration on this Plan
 * installation going quiet, which is the Survival's acquisition and the same
 * founding disaster one level down. So it keeps running, and the summaries below
 * say Survival rather than "rede".
 *
 * `HealthCheckName.ProxyRegistrationAlive` is **not** renamed with them: the
 * string is persisted and is the join key of this check's own history. Renaming
 * it would split the series in two and silently reset the alert policy's memory
 * of what the channel was last told. Whether the identifier should change is a
 * decision for the owner, alongside finding an actual proxy-side source.
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
      arrivals = await this.db.registeredPlayers();
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

    if (arrivals.total === null) {
      // The count itself came back unreadable. Says so and nothing more: with
      // the row count unknown, every diagnosis below is unavailable, including
      // the one about the wrong database.
      return [
        {
          checkName: this.name,
          status: 'error',
          detail: {
            summary:
              'Nao foi possivel ler a contagem de plan_users — o driver ou o ' +
              'tipo da coluna devolveu um formato inesperado',
          },
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
      // These three were one branch until 2026-08-30, keyed on
      // `lastRegisteredAt === null`. Both fields run through `toNumber`, which
      // returns null for an empty result **and** for any shape it does not
      // expect — a `Date`, a `bigint`, a `Buffer`, whatever the next driver bump
      // decides a column looks like. `toNumber`'s own docblock names that as the
      // bug that only shows up after a dependency upgrade.
      //
      // Collapsed, an unreadable read told the channel every fifteen minutes
      // that it had "probably found the wrong database", about a perfectly
      // healthy Plan. Alerting on a diagnosis the code never established is
      // worse than not alerting: it sends someone to the wrong system. Three
      // conditions, three verdicts, and only the middle one names a cause.
      return [
        {
          checkName: this.name,
          status: 'error',
          detail: {
            summary:
              `plan_users tem ${arrivals.total} linha(s), mas MAX(registered) ` +
              'nao veio legivel. NAO e o mesmo que tabela vazia; a causa pode ' +
              'ser tipo de coluna, formato do driver ou a propria coluna nula.',
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
      // published without its base, and the base here is every row of
      // `plan_users` — the Survival's players, not the network's.
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
              `Nenhum jogador novo registrado em plan_users ha ${silenceHours}h ` +
              `(limite ${thresholdHours}h) — a coleta do Survival pode ter ` +
              'parado. NAO cobre o proxy: esta tabela guarda o Survival nesta ' +
              'instalacao (medido em 2026-08-31).',
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
          summary: `Ultimo registro em plan_users (Survival) ha ${silenceHours}h`,
        },
      },
    ];
  }
}
