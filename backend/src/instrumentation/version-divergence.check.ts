import { Injectable } from '@nestjs/common';
import type { HealthCheck } from './health-check.contract';
import type { HealthCheckObservation } from './health-check.store';
import { HealthCheckName } from './health-check.types';
import { PlanDatabase, type PlanServerRow } from './plan-database';

/**
 * Are all Plan instances running the same build? (spec §6.1, ADR-005)
 *
 * ADR-005 requires proxy and backends on the **same build** sharing one MySQL,
 * because different builds against a shared schema corrupt it. That is a
 * requirement nobody can see: builds drift when one server is updated and another
 * is not, and the damage shows up later as data that quietly stops making sense.
 *
 * A single global verdict rather than one per server: divergence is a property of
 * the *set*, and naming one instance as "the wrong one" would be arbitrary — the
 * newest is as likely to be the mistake as the oldest.
 *
 * Uses documented exception 2 to ADR-002: `plan_version` exists only in
 * `plan_servers` and no endpoint exposes it.
 */
@Injectable()
export class VersionDivergenceCheck implements HealthCheck {
  readonly name = HealthCheckName.VersionDivergence;

  constructor(private readonly db: PlanDatabase) {}

  async run(): Promise<HealthCheckObservation[]> {
    let servers: PlanServerRow[];
    try {
      servers = await this.db.listServers();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return [
        {
          checkName: this.name,
          status: 'error',
          detail: { summary: `Nao foi possivel ler plan_servers: ${reason}` },
        },
      ];
    }

    if (servers.length === 0) {
      // An empty catalogue is not agreement, and it is not an empty window
      // either. Reporting `ok` here would pass the check precisely when Plan has
      // lost track of every instance — and reporting `no_data` would file that
      // same event under a status `NOTIFIABLE_STATUSES` excludes, so
      // `decideAlerts` would suppress it as `not_notifiable` forever while the
      // row was rewritten every cycle. `error` is what reaches the channel, and
      // it is the accurate word: the source answered with a universe that cannot
      // exist on a live network.
      return [
        {
          checkName: this.name,
          status: 'error',
          detail: {
            summary: 'plan_servers nao retornou nenhum servidor',
            n: 0,
          },
        },
      ];
    }

    const versioned = servers.filter((server) => server.planVersion !== null);
    if (versioned.length < 2) {
      // One instance cannot diverge from itself, and a version Plan never
      // recorded is unknown rather than matching.
      //
      // Stays `no_data` on purpose, unlike the empty catalogue above: here the
      // source answered with real servers and the comparison simply has no base.
      // That is the case the suppression rule was written for.
      return [
        {
          checkName: this.name,
          status: 'no_data',
          detail: {
            summary:
              `Apenas ${versioned.length} de ${servers.length} servidor(es) ` +
              'tem versao registrada — nao ha o que comparar',
            n: servers.length,
          },
        },
      ];
    }

    const versions = new Map<string, string[]>();
    for (const server of versioned) {
      const key = server.planVersion as string;
      versions.set(key, [...(versions.get(key) ?? []), server.name]);
    }

    if (versions.size > 1) {
      return this.buildBreach(versions, servers.length);
    }

    const [version] = [...versions.keys()];
    return [
      {
        checkName: this.name,
        status: 'ok',
        detail: {
          summary: `${versioned.length} instancia(s) na mesma build: ${version}`,
          observed: versions.size,
          threshold: 1,
          n: servers.length,
        },
      },
    ];
  }

  private buildBreach(
    versions: ReadonlyMap<string, string[]>,
    total: number,
  ): HealthCheckObservation[] {
    // Sorted so the message is stable between cycles: an alert whose text
    // reshuffles every run reads as a new incident each time.
    const grouped = [...versions.entries()]
      .map(([version, names]) => `${version}: ${[...names].sort().join(', ')}`)
      .sort();

    return [
      {
        checkName: this.name,
        status: 'breached',
        detail: {
          summary:
            `${versions.size} builds diferentes do Plan no mesmo banco — ` +
            'builds divergentes corrompem o schema compartilhado (ADR-005)',
          observed: versions.size,
          threshold: 1,
          n: total,
          context: { builds: grouped.join(' | ') },
        },
      },
    ];
  }
}
