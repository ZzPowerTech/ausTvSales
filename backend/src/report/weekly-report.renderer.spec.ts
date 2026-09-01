import { buildBucket } from '../funnel/funnel-math';
import { Platform } from '../instrumentation/platform';
import type { CohortRetention } from '../retention/retention.types';
import { renderFailure, renderWeeklyReport } from './weekly-report.renderer';
import type { WeeklyReport } from './weekly-report.types';

function cohort(over: Partial<CohortRetention> = {}): CohortRetention {
  return {
    cohort: '2026-08',
    platform: Platform.JavaPremium,
    size: 42,
    belowMinimum: false,
    contamination: { share: 0, n: 0, suspect: false },
    measures: [
      { horizon: 'D1', percent: 61.9, n: 42, survived: 26 },
      { horizon: 'D7', percent: 33.3, n: 42, survived: 14 },
      {
        horizon: 'D30',
        percent: null,
        n: 0,
        survived: null,
        reason: 'immature_horizon',
        unavailableReason: 'Nenhum jogador desta coorte teve 30 dia(s).',
      },
    ],
    ...over,
  };
}

function report(over: Partial<WeeklyReport> = {}): WeeklyReport {
  return {
    from: '2026-08-25',
    to: '2026-08-31',
    generatedAt: '2026-09-01T00:00:00.000Z',
    funnel: {
      bucket: buildBucket('2026-08-25..2026-08-31', {
        network: null,
        survival: 687,
        tutorialEntered: 120,
        tutorialCompleted: 3,
      }),
      coverage: [
        { step: 'rede', days: 0, ofDays: 7 },
        { step: 'survival', days: 7, ofDays: 7 },
        { step: 'tutorial_entrou', days: 7, ofDays: 7 },
        { step: 'tutorial_concluiu', days: 7, ofDays: 7 },
      ],
      sources: [
        { name: 'plan_users', ok: true, asOf: null },
        { name: 'tutorial_daily', ok: true, asOf: null },
      ],
    },
    retention: {
      semantics: 'intervalo de sobrevivencia',
      from: '2026-06',
      to: '2026-08',
      cohorts: [cohort()],
      stampDays: [],
      source: {
        name: 'plan_retention',
        ok: true,
        asOf: null,
        dataThrough: '2026-08-31',
        rows: 5565,
      },
    },
    health: {
      summary: {
        status: 'degraded',
        stale: false,
        lastCheckedAt: null,
        oldestCheckedAt: null,
        total: 7,
        counts: { ok: 5, breached: 0, no_data: 1, error: 1 },
        failing: ['funnel.tutorial_entry_rate'],
        staleChecks: [],
        blindSpots: ['funnel.network_to_survival'],
        missing: [],
        schedule: { enabled: true, intervalMinutes: 15, staleAfterMinutes: 30 },
      },
    },
    ...over,
  };
}

describe('renderWeeklyReport', () => {
  it('prints every percentage with its base', () => {
    const text = renderWeeklyReport(report());

    // survival(687) → tutorial_entrou(120) = 17,5%, and the base travels.
    expect(text).toContain('17,5% (n=687)');
    expect(text).toContain('D1 61,9% (n=42)');
    expect(text).toContain('D7 33,3% (n=42)');
  });

  it('prints the retention label every week, not once in a docblock', () => {
    // A Discord message is where a number gets quoted out of context, so the
    // caveat has to be inside the quote.
    expect(renderWeeklyReport(report())).toContain('nao** retorno no dia N');
  });

  it('says "sem dado" for the rede step instead of a zero', () => {
    const text = renderWeeklyReport(report());

    expect(text).toMatch(/`rede` — sem dado/);
    expect(text).not.toMatch(/`rede` — 0/);
  });

  it('shows day coverage next to every step', () => {
    expect(renderWeeklyReport(report())).toContain('(7/7 dias com dado)');
  });

  it('names a source that is out, rather than showing an empty section', () => {
    const text = renderWeeklyReport(
      report({
        funnel: {
          ...report().funnel,
          sources: [
            {
              name: 'tutorial_daily',
              ok: false,
              asOf: null,
              failure: 'never_synced',
            },
          ],
        },
      }),
    );

    expect(text).toContain('`tutorial_daily` (never_synced)');
  });

  it('distinguishes "could not measure" from "nobody retained"', () => {
    const text = renderWeeklyReport(
      report({
        retention: {
          ...report().retention,
          cohorts: [],
          source: {
            name: 'plan_retention',
            ok: false,
            asOf: null,
            failure: 'unreachable',
            dataThrough: null,
            rows: null,
          },
        },
      }),
    );

    expect(text).toContain('nao foi possivel medir');
    expect(text).not.toContain('Nenhuma coorte no periodo');
  });

  it('marks a small or contaminated cohort instead of hiding it', () => {
    const text = renderWeeklyReport(
      report({
        retention: {
          ...report().retention,
          cohorts: [
            cohort({ size: 4, belowMinimum: true }),
            cohort({
              cohort: '2026-06',
              contamination: { share: 0.8, n: 40, suspect: true },
            }),
          ],
        },
      }),
    );

    expect(text).toContain('amostra pequena');
    expect(text).toContain('carimbo de importacao');
  });

  it('warns loudly when the health cycle is switched off', () => {
    const base = report();
    const text = renderWeeklyReport({
      ...base,
      health: {
        summary: {
          ...base.health.summary,
          schedule: { ...base.health.summary.schedule, enabled: false },
        },
      },
    });

    expect(text).toContain('ciclo de checks esta desligado');
  });

  it('lists failing checks and accepted blind spots separately', () => {
    const text = renderWeeklyReport(report());

    expect(text).toContain('Em falha: `funnel.tutorial_entry_rate`');
    expect(text).toContain(
      'Pontos cegos aceitos: `funnel.network_to_survival`',
    );
  });

  it('stays inside the Discord embed description limit', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      cohort({ cohort: `2026-${String((i % 12) + 1).padStart(2, '0')}` }),
    );

    const text = renderWeeklyReport(
      report({ retention: { ...report().retention, cohorts: many } }),
    );

    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain('coorte(s) nao exibida(s)');
  });
});

describe('renderFailure', () => {
  it('says the job failed, and that silence stops meaning "quiet week"', () => {
    const text = renderFailure('2026-08-25', '2026-08-31', 'motivo curto');

    expect(text).toContain('NAO foi gerado');
    expect(text).toContain('semana sem novidade');
    expect(text).toContain('motivo curto');
  });
});
