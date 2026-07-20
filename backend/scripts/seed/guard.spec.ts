import { assertSeedTargetAllowed, SeedGuardError, type SeedEnv } from './guard';

/**
 * The guard is the one part of the generator whose failure is unrecoverable
 * (spec S5.0 §1.4), so every refusal path is pinned here.
 */
describe('assertSeedTargetAllowed', () => {
  const allowed: SeedEnv = {
    NODE_ENV: 'development',
    SEED_ALLOW: 'true',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/austv_sales_dev',
    SEED_FORBIDDEN_HOSTS: 'db.austv.net',
  };

  it('permite um alvo de desenvolvimento explicitamente liberado', () => {
    expect(() => assertSeedTargetAllowed(allowed)).not.toThrow();
  });

  it('recusa NODE_ENV=production mesmo com SEED_ALLOW=true', () => {
    expect(() =>
      assertSeedTargetAllowed({ ...allowed, NODE_ENV: 'production' }),
    ).toThrow(SeedGuardError);
  });

  it('recusa quando SEED_ALLOW nao esta definido (padrao seguro)', () => {
    const withoutOptIn: SeedEnv = { ...allowed, SEED_ALLOW: undefined };
    expect(() => assertSeedTargetAllowed(withoutOptIn)).toThrow(/SEED_ALLOW/);
  });

  it('recusa SEED_ALLOW com qualquer valor diferente de "true"', () => {
    expect(() =>
      assertSeedTargetAllowed({ ...allowed, SEED_ALLOW: '1' }),
    ).toThrow(SeedGuardError);
    expect(() =>
      assertSeedTargetAllowed({ ...allowed, SEED_ALLOW: 'TRUE' }),
    ).toThrow(SeedGuardError);
  });

  it('recusa host presente em SEED_FORBIDDEN_HOSTS, ignorando caixa e espacos', () => {
    expect(() =>
      assertSeedTargetAllowed({
        ...allowed,
        DATABASE_URL: 'postgresql://user:pass@DB.AusTV.net:5432/austv_sales',
        SEED_FORBIDDEN_HOSTS: ' db.austv.net , outro.host ',
      }),
    ).toThrow(/SEED_FORBIDDEN_HOSTS/);
  });

  it('recusa DATABASE_URL ausente ou malformada', () => {
    const withoutUrl: SeedEnv = { ...allowed, DATABASE_URL: undefined };
    expect(() => assertSeedTargetAllowed(withoutUrl)).toThrow(/DATABASE_URL/);
    expect(() =>
      assertSeedTargetAllowed({ ...allowed, DATABASE_URL: 'nao-e-uma-url' }),
    ).toThrow(/connection string/);
  });
});
