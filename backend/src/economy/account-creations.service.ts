import { Injectable, Logger } from '@nestjs/common';
import type { EconomySourceState } from './economy.types';
import { PaymentsStore, type CreationDay } from './payments.store';

/**
 * R1 — the account-creation series, as a funnel reconciliation source
 * (story S9.1, criterion 9, ADR-007).
 *
 * ## Why this series matters more than it looks
 *
 * It is an **independent arrivals signal**. Every other arrivals number in this
 * system comes from Plan, and Plan is precisely what went dark: the proxy was
 * dead from May to July 2026 and the funnel has nothing at all for those three
 * months. PlayerPoints kept writing a `SET` / `Starting balance` row for every
 * account created, the whole time.
 *
 * So this is the one series that can say what happened during a Plan blackout,
 * which makes it a cross-check on the funnel rather than an economy figure —
 * ADR-007 says so in as many words.
 *
 * ## It counts accounts, not arrivals, and the difference is stated
 *
 * A `SET` row is written when an account first gets a balance. That is close to
 * "a player arrived for the first time" and is **not identical** to it: it says
 * nothing about a returning player, and it depends on PlayerPoints having been
 * loaded at the time. Publishing it as a funnel step would repeat the mistake
 * that made "48 chegadas/mês" — a plugin's own series read as reality. It is
 * offered as reconciliation, and the caveat travels with it.
 */
@Injectable()
export class AccountCreationsService {
  private readonly logger = new Logger(AccountCreationsService.name);

  constructor(private readonly payments: PaymentsStore) {}

  async series(from: string, to: string): Promise<AccountCreationsReport> {
    const source = await this.sourceState();

    if (!source.ok) {
      return {
        from,
        to,
        caveat: ACCOUNT_CREATION_CAVEAT,
        days: null,
        unavailableReason:
          'O ETL do PlayerPoints nunca completou. Uma serie vazia aqui se ' +
          'leria como "ninguem criou conta", que e exatamente a leitura errada ' +
          'que esta serie existe para impedir no funil.',
        sources: [source],
      };
    }

    return {
      from,
      to,
      caveat: ACCOUNT_CREATION_CAVEAT,
      days: await this.payments.creations(from, to),
      sources: [source],
    };
  }

  private async sourceState(): Promise<EconomySourceState> {
    try {
      const last = await this.payments.lastSuccessfulSync();
      return last === null
        ? {
            name: 'player_payments',
            ok: false,
            asOf: null,
            failure: 'never_synced',
          }
        : {
            name: 'player_payments',
            ok: true,
            asOf: last.ranAt.toISOString(),
          };
    } catch (error) {
      this.logger.warn(
        `Procedencia da serie de criacao de conta ilegivel: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        name: 'player_payments',
        ok: false,
        asOf: null,
        failure: 'query_failed',
      };
    }
  }
}

/** What this series is, and what it is not. Carried in every response. */
export const ACCOUNT_CREATION_CAVEAT =
  'Serie de CRIACAO DE CONTA (`SET` / `Starting balance` do PlayerPoints), ' +
  'oferecida como fonte de RECONCILIACAO do funil — nao como degrau dele. Ela ' +
  'e independente do Plan e por isso cobre o apagao do proxy de mai-jul/2026, ' +
  'que o funil nao cobre. Mas ela conta contas, nao chegadas: nao diz nada ' +
  'sobre quem voltou, e depende de o PlayerPoints estar carregado. Tratar uma ' +
  'serie de plugin como realidade e o erro que produziu as "48 chegadas/mes".';

/** A day with no row means nobody created an account, within a covered range. */
export interface AccountCreationsReport {
  from: string;
  to: string;
  caveat: string;
  days: CreationDay[] | null;
  /** Set exactly when `days` is null. */
  unavailableReason?: string;
  sources: EconomySourceState[];
}
