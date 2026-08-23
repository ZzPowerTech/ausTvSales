import { Injectable } from '@nestjs/common';
import type { HealthCheck } from './health-check.contract';
import type { HealthCheckObservation } from './health-check.store';
import { HealthCheckName } from './health-check.types';
import { PlanDatabase, type PlanServerRow } from './plan-database';
import { PlanServersConfig } from './plan-servers.config';

/**
 * Does the Plan catalogue match what we think we are measuring? (spec §6.1)
 *
 * ## What this check actually compares
 *
 * Two lists that must agree, and silently drift apart:
 *
 * - `plan_servers` — every instance Plan has ever registered
 * - `PLAN_SERVERS` — every instance this API is configured to measure
 *
 * A name in the first and not the second is **an instance nobody is watching**:
 * it reports to Plan, it may be serving players, and no check ever looks at it.
 * That is the shape of the SQLite disaster — a Plan instance writing somewhere
 * nobody was reading, invisible for months because nothing compared the two.
 *
 * A name in the second and not the first is the mirror bug: a configured server
 * Plan does not know, which means every check scoped to it is querying a name
 * that cannot resolve. Comparison is **case-sensitive on purpose** — `?server=`
 * is, so `survival` against `Survival` is a real defect that would make every
 * other check fail against that instance, and it surfaces here as a mismatch
 * rather than as a mysterious 403 later.
 *
 * ## What it deliberately does not do
 *
 * The spec words this check as "servidor em `plan_servers` **sem dado recente**".
 * Per-server freshness would need `plan_sessions`, which is **outside** the
 * approved ADR-002 exception 2 — that exception covers `plan_servers` and nothing
 * else. Stretching it unilaterally is exactly the kind of quiet scope creep the
 * numbered-exception table exists to prevent.
 *
 * Freshness for backends is already covered by `plan.collection_alive`. Extending
 * this check to per-server recency needs a new numbered exception, and that is
 * the owner's call, not a decision to smuggle in here.
 *
 * A single global verdict: drift is a property of the pair of lists, not of any
 * one server.
 */
@Injectable()
export class OrphanInstanceCheck implements HealthCheck {
  readonly name = HealthCheckName.OrphanInstance;

  constructor(
    private readonly db: PlanDatabase,
    private readonly servers: PlanServersConfig,
  ) {}

  async run(): Promise<HealthCheckObservation[]> {
    let catalogue: PlanServerRow[];
    try {
      catalogue = await this.db.listServers();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return [this.error(`Nao foi possivel ler plan_servers: ${reason}`)];
    }

    const configured = this.servers.all().map((server) => server.name);

    if (catalogue.length === 0) {
      // Not agreement, and not a pass. An empty catalogue means Plan lost track
      // of every instance — the loudest possible version of the problem this
      // check exists to find.
      return [
        this.verdict('no_data', 'plan_servers nao retornou nenhum servidor', {
          n: configured.length,
        }),
      ];
    }

    if (configured.length === 0) {
      return [
        this.verdict(
          'no_data',
          `PLAN_SERVERS nao esta configurada — ${catalogue.length} instancia(s) ` +
            'no Plan sem nada para comparar',
          { n: catalogue.length },
        ),
      ];
    }

    const known = new Set(configured);
    const registered = new Set(catalogue.map((server) => server.name));

    const unwatched = catalogue
      .map((server) => server.name)
      .filter((name) => !known.has(name))
      .sort();
    const missing = configured.filter((name) => !registered.has(name)).sort();

    if (unwatched.length === 0 && missing.length === 0) {
      return [
        this.verdict(
          'ok',
          `${catalogue.length} instancia(s) no Plan, todas configuradas`,
          { observed: 0, threshold: 0, n: catalogue.length },
        ),
      ];
    }

    const parts: string[] = [];
    if (unwatched.length > 0) {
      parts.push(
        `${unwatched.length} instancia(s) registrada(s) no Plan que ninguem ` +
          `esta observando: ${unwatched.join(', ')}`,
      );
    }
    if (missing.length > 0) {
      parts.push(
        `${missing.length} nome(s) em PLAN_SERVERS que o Plan nao conhece: ` +
          `${missing.join(', ')}`,
      );
    }

    return [
      this.verdict('breached', parts.join(' · '), {
        observed: unwatched.length + missing.length,
        threshold: 0,
        n: catalogue.length,
        context: {
          nao_observadas: unwatched.join(', ') || '—',
          nao_registradas: missing.join(', ') || '—',
        },
      }),
    ];
  }

  private error(summary: string): HealthCheckObservation {
    return { checkName: this.name, status: 'error', detail: { summary } };
  }

  private verdict(
    status: 'ok' | 'breached' | 'no_data',
    summary: string,
    detail: Omit<HealthCheckObservation['detail'], 'summary'>,
  ): HealthCheckObservation {
    return { checkName: this.name, status, detail: { summary, ...detail } };
  }
}
