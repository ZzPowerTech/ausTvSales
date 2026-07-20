/**
 * Production guard for the synthetic sales generator (spec S5.0 §1.4).
 *
 * This aborts — it never prompts and there is no `--force`. A confirmation
 * prompt protects nobody in the situation that actually causes the damage: the
 * script running inside a pipeline or a background shell, where there is no one
 * to answer. Fail closed, loudly, before a single row is written.
 */
export interface SeedEnv {
  NODE_ENV?: string;
  SEED_ALLOW?: string;
  DATABASE_URL?: string;
  /** Comma-separated hostnames the generator must refuse to touch. */
  SEED_FORBIDDEN_HOSTS?: string;
}

export class SeedGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedGuardError';
  }
}

/** Throws `SeedGuardError` unless the target is unambiguously a dev/test database. */
export function assertSeedTargetAllowed(env: SeedEnv): void {
  if (env.NODE_ENV === 'production') {
    throw new SeedGuardError(
      'Recusando rodar: NODE_ENV=production. O gerador de vendas sinteticas ' +
        'nunca deve tocar producao.',
    );
  }

  // Opt-in explícito e ausente por padrão: nenhum `.env` do projeto define
  // SEED_ALLOW, então o caminho acidental (rodar com o .env de sempre) para aqui.
  if (env.SEED_ALLOW !== 'true') {
    throw new SeedGuardError(
      'Recusando rodar: SEED_ALLOW nao esta definido como "true". Defina ' +
        'SEED_ALLOW=true apenas no ambiente de teste, nunca em um .env versionado.',
    );
  }

  if (!env.DATABASE_URL) {
    throw new SeedGuardError(
      'Recusando rodar: DATABASE_URL nao esta definido.',
    );
  }

  let host: string;
  try {
    host = new URL(env.DATABASE_URL).hostname;
  } catch {
    throw new SeedGuardError(
      'Recusando rodar: DATABASE_URL nao e uma connection string valida.',
    );
  }

  if (!host) {
    throw new SeedGuardError(
      'Recusando rodar: DATABASE_URL nao contem hostname.',
    );
  }

  const forbidden = (env.SEED_FORBIDDEN_HOSTS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  if (forbidden.includes(host.toLowerCase())) {
    throw new SeedGuardError(
      `Recusando rodar: o host "${host}" do DATABASE_URL esta na lista ` +
        'SEED_FORBIDDEN_HOSTS.',
    );
  }
}
