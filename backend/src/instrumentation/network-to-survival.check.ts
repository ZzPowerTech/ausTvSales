import { Injectable } from '@nestjs/common';
import type { HealthCheck } from './health-check.contract';
import type { HealthCheckObservation } from './health-check.store';
import { HealthCheckName, scopedCheckName } from './health-check.types';
import { PlanServersConfig } from './plan-servers.config';

/**
 * Why this check publishes no ratio, and has not been able to since it shipped.
 *
 * Long, and deliberately so: it is the only thing this check emits, it lands in
 * `/health/instrumentation` where somebody has to act on it, and the shortest
 * honest version of it is still a paragraph.
 */
export const RATIO_STRUCTURALLY_BLIND =
  'Conversao rede->survival sem fonte para o denominador. O numerador ' +
  '(`serverOverview.last_7_days.new_players`) e do Survival e o denominador ' +
  'usado ate 2026-08-31 (`plan_users`) e a MESMA populacao: o proxy tem zero ' +
  'jogadores em `plan_user_info`, e as contagens mensais de `plan_users` batem ' +
  'linha a linha com a coluna `survival` dos numeros verificados. A razao era ' +
  'Survival dividido por Survival — numerador e denominador se movendo juntos, ' +
  'perto de 100%, e incapaz de cair com a rede inteira fora do ar. Este check ' +
  'reportava `ok` por construcao, e nao por medicao. Enquanto nao existir uma ' +
  'fonte de chegadas no proxy, `no_data` e a unica resposta honesta.';

/**
 * How many of the people who reach the network reach a backend? (spec §6.2)
 *
 * ## ⚠️ It has never been able to answer that, and now says so
 *
 * The check was built in story S6.3 to turn the 2026-08-21 finding — **54% of
 * everyone who connects to the network never reaches survival** — into a
 * continuous signal. It divided `serverOverview.last_7_days.new_players` by the
 * `plan_users` count over the same window.
 *
 * Measured on 2026-08-31: those are the same population. `plan_users` holds the
 * Survival, not the network. Three facts, one conclusion — the proxy (`AusTv`,
 * `is_proxy = 1`) is in the `plan_servers` catalogue with **zero** players in
 * `plan_user_info`; `Survival` is the only server that appears there, with 5575
 * of the 5638 rows; and the monthly counts of `plan_users` are the `survival`
 * column of `HANDOFF.md` to the row, while its `rede` column is roughly double.
 *
 * So the ratio's two sides moved together. It could not fall, which means the
 * `ok` it kept reporting was a property of its own arithmetic. **It would have
 * reported `ok` with the entire network gone** — which is ADR-006's blindness,
 * inside the layer that exists to detect blindness.
 *
 * ## Why `no_data` and not `error`, and not retirement
 *
 * `no_data`, because §6.1's rule is *whose* emptiness it is: `error` is for a
 * source that failed, `no_data` for a window that genuinely came back empty or a
 * comparison missing a side. Nothing here failed — we do not have a source for
 * the denominator, the same category as `PLAN_SERVERS` being unconfigured.
 *
 * **Not retired**, though retiring it was the alternative. Deregistering it
 * would drop it out of the registry that `InstrumentationHealthService` compares
 * against, leaving its old rows in the store to age into `staleChecks` and pin
 * the summary at `down` forever — the opposite of quiet. Kept registered, it
 * writes a fresh verdict every cycle whose entire content is the reason it
 * cannot measure. A check saying "não sei" out loud is the point of the layer.
 *
 * ## ⚠️ `no_data` alone was not enough, and this shipped believing it was
 *
 * That version said here that "`no_data` never notifies, so the channel is not
 * paged". **That is true only from a clean slate**, and review caught it before
 * it ran. Both consumers of a verdict assume a non-`ok` state eventually clears,
 * and this one never does:
 *
 * - `decideAlerts` suppresses a `no_data` as `not_notifiable` only while the
 *   channel is holding nothing about the check. With any open non-`ok` alert —
 *   a past `error` from a MySQL blip that never got a confirmed recovery — it
 *   fell through to `repeat` and delivered once per `reAlertAfterMs`, **forever**,
 *   because the exit is an `ok` record this check can no longer produce. The
 *   per-window budget did not contain it either: `no_data` is the only status it
 *   emits, so every fresh window handed it the free pass.
 * - `resolveStatus` returns `degraded` while any check is `no_data`, so
 *   `/health/instrumentation` could never read `ok` again — and, worse, a second
 *   check going bad no longer moved it.
 *
 * The fix is not in this file: this check is a member of
 * {@link ACCEPTED_BLIND_SPOTS}, which both consumers now consult. That set is
 * where the reasoning lives, and adding a name to it is a decision with a bar.
 *
 * ## What it costs, and what it will take to restore
 *
 * The 54% is no longer watched by anything. That is a real loss and not a
 * downgrade of an existing signal: it was never watched, because this check
 * could not see it. Restoring it needs a count of arrivals **at the proxy** —
 * the old database is one candidate; `/v1/networkMetadata` and `/v1/playersTable`
 * have never been read for this. When one exists, the arithmetic below comes
 * back unchanged from git history: only the denominator was ever wrong.
 */
@Injectable()
export class NetworkToSurvivalCheck implements HealthCheck {
  readonly name = HealthCheckName.NetworkToSurvival;

  constructor(private readonly servers: PlanServersConfig) {}

  run(): Promise<HealthCheckObservation[]> {
    // One observation per backend, exactly as when a ratio was published: the
    // persisted names stay stable, so the history of this check reads as one
    // series that stopped claiming a number rather than as a check that vanished
    // and a different one that appeared.
    //
    // No database read and no HTTP call. There is nothing to ask — the answer
    // does not depend on the game machine's state — and asking anyway would make
    // the Plan pay a request per cycle to produce a constant.
    return Promise.resolve(
      this.servers.backends().map((server) => ({
        checkName: scopedCheckName(this.name, server.name),
        status: 'no_data' as const,
        detail: {
          summary: RATIO_STRUCTURALLY_BLIND,
          // No `n`, and that is the rule rather than an omission: the project
          // forbids a percentage without its base, and this is the same rule at
          // the limit — with no denominator there is no base to publish either.
          context: { server: server.name },
        },
      })),
    );
  }
}
