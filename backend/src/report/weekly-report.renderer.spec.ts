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
    contamination: { share: 0, n: 0, suspect: false, detectedBy: null },
    measures: [
      {
        horizon: 'D1',
        percent: 61.9,
        n: 42,
        survived: 26,
        belowMinimum: false,
      },
      {
        horizon: 'D7',
        percent: 33.3,
        n: 42,
        survived: 14,
        belowMinimum: false,
      },
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
      contaminatedSpans: [],
      source: {
        name: 'plan_retention',
        ok: true,
        asOf: null,
        dataThrough: '2026-08-31',
        rows: 5565,
        parsed: 0,
        dropped: 0,
        dataFrom: null,
        stale: false,
        ageMs: null,
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

  describe('a cohort that came back blank says why', () => {
    /** A cohort with every horizon suppressed by the span inheritance. */
    function blankCohort(): CohortRetention {
      return cohort({
        cohort: '2025-06',
        size: 12,
        measures: (['D1', 'D7', 'D30'] as const).map((horizon) => ({
          horizon,
          percent: null,
          n: 12,
          survived: null,
          reason: 'contaminated_span' as const,
          unavailableReason: 'Faixa de importacao.',
        })),
      });
    }

    const span = {
      from: '2024-06',
      to: '2025-08',
      confirmedMonths: ['2024-06', '2025-08'],
      confirmedCohorts: 21,
      judgedCohorts: 22,
      inheritedCohorts: 23,
      inheritedPlayers: 327,
    };

    it('names the run when a rendered cohort actually lost its numbers', () => {
      // The production case: `stampDays` is empty and the cohorts are suppressed
      // anyway, so the only explanation the report used to be able to print did
      // not apply to the thing the reader was looking at.
      const text = renderWeeklyReport(
        report({
          retention: {
            ...report().retention,
            from: '2025-06',
            to: '2025-06',
            cohorts: [blankCohort()],
            stampDays: [],
            contaminatedSpans: [span],
          },
        }),
      );

      expect(text).toContain('1 de 1 coorte(s) desta janela');
      expect(text).toContain('2024-06..2025-08');
    });

    it('stays silent when the run has nothing to do with the cohorts shown', () => {
      // THE regression to hold. The runs are dataset-wide and this section shows
      // the last three months, so in production a run is permanently present and
      // permanently irrelevant here. An ungated line would put the same warning
      // in the channel every week for ever, beside cohorts that all have their
      // numbers — a standing false note, which is how an alert channel goes deaf.
      const text = renderWeeklyReport(
        report({
          retention: {
            ...report().retention,
            stampDays: [],
            contaminatedSpans: [span],
          },
        }),
      );

      expect(text).not.toContain('artefato de importacao');
      expect(text).not.toContain('2024-06..2025-08');
    });

    it('omits the run when none of them overlaps the window', () => {
      // The cohort is blank, so the reader is owed the sentence — but naming a
      // run that ended a year before the window would answer a question nobody
      // asked with a date that explains nothing.
      const text = renderWeeklyReport(
        report({
          retention: {
            ...report().retention,
            cohorts: [blankCohort()],
            stampDays: [],
            contaminatedSpans: [{ ...span, from: '2020-01', to: '2020-02' }],
          },
        }),
      );

      expect(text).toContain('1 de 1 coorte(s) desta janela');
      expect(text).not.toContain('2020-01');
    });
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
            parsed: 0,
            dropped: 0,
            dataFrom: null,
            stale: false,
            ageMs: null,
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
              contamination: {
                share: 0.8,
                n: 40,
                suspect: true,
                detectedBy: 'population_stamp',
              },
            }),
          ],
        },
      }),
    );

    expect(text).toContain('coorte pequena');
    expect(text).toContain('carimbo de importacao');
  });

  it('marks the HORIZON whose base is small, not just the cohort', () => {
    // A cohort of 43 publishing `D30: 0%` over five people was unmarked before
    // 2026-09-02: `belowMinimum` looked at the cohort's size and the cohort was
    // large. The mark belongs beside the number it qualifies.
    const text = renderWeeklyReport(
      report({
        retention: {
          ...report().retention,
          cohorts: [
            cohort({
              size: 43,
              belowMinimum: false,
              measures: [
                {
                  horizon: 'D1',
                  percent: 20,
                  n: 43,
                  survived: 9,
                  belowMinimum: false,
                },
                {
                  horizon: 'D30',
                  percent: 0,
                  n: 5,
                  survived: 0,
                  belowMinimum: true,
                },
              ],
            }),
          ],
        },
      }),
    );

    expect(text).toContain('D1 20,0% (n=43)');
    expect(text).toContain('D30 0,0% (n=5 ⚠️ base pequena)');
    expect(text).not.toContain('coorte pequena');
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

  it('escapes markdown in a check name that came from Plan', () => {
    // Per-target check names append the server name from Plan's own catalogue —
    // free-form text this system does not control. A backtick closes the inline
    // code span and can swallow the rest of the health section, including the
    // line saying the measurement cycle is off.
    const base = report();
    const text = renderWeeklyReport({
      ...base,
      health: {
        summary: {
          ...base.health.summary,
          failing: ['plan.collection_alive:Surv`ival'],
        },
      },
    });

    // No code span, and the backtick escaped: the value survives and the
    // message cannot be swallowed by an unbalanced span.
    expect(text).toContain('plan.collection\\_alive:Surv\\`ival');
    expect(text).not.toContain('`plan.collection_alive:Surv`');
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
