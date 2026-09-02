import { platformOf, type Platform } from '../instrumentation/platform';
import { toSaoPauloDay } from '../tutorial/tutorial-day';
import type { RetentionPlayer } from './plan-retention';
import {
  horizonLabel,
  RETENTION_HORIZON_DAYS,
  type CohortContamination,
  type CohortRetention,
  type ConfirmedSpan,
  type ContaminatedSpan,
  type RetentionMeasure,
  type StampDay,
} from './retention.types';

const MS_PER_DAY = 86_400_000;

/**
 * A survival share at or above this, on **every** horizon, is not retention.
 *
 * Real cohorts lose people at D1. A cohort that keeps everybody at D1, D7 and
 * D30 alike is the fingerprint of `lastSeenDate` having been written by an
 * import rather than lived by the players — and it is the shape that survives
 * whatever the import did to the timestamps, which is exactly why this guard is
 * independent of the stamp-day detector rather than downstream of it.
 */
const IMPLAUSIBLE_SURVIVAL = 0.99;

/**
 * Below this, the implausibility guard abstains.
 *
 * Three players all surviving is unremarkable; three hundred is not. Without a
 * floor the guard would suppress every genuinely tiny cohort, which is the
 * opposite of the story's rule that small samples are marked and not hidden.
 */
const IMPLAUSIBLE_MIN_COHORT = 20;

/**
 * Pure cohort arithmetic for story S8.2.
 *
 * Separated from the service for the same reason `funnel-math.ts` is: the rules
 * that decide whether a number may be published at all are the part worth
 * testing exhaustively, and they should be testable without a Plan, a database
 * or a Nest module.
 */

/** Month bucket of an epoch, `YYYY-MM` in America/Sao_Paulo. */
export function toSaoPauloMonth(epochMs: number): string | null {
  const day = toSaoPauloDay(epochMs);
  return day === null ? null : day.slice(0, 7);
}

/** Tunables, all injected so the thresholds stay visible at the call site. */
export interface CohortOptions {
  /** Wall clock, epoch ms. Used only to tell staleness from immaturity. */
  evaluatedAt: number;
  /**
   * The most recent `lastSeenDate` in the payload, epoch ms.
   *
   * **This, and not the wall clock, decides whether a horizon is measurable.**
   * Survival is read off `lastSeenDate`; if the dataset stops advancing, the
   * calendar keeps making players "mature" while none of them can be observed
   * surviving, and the ratio collapses towards zero for reasons that have
   * nothing to do with players. Null when the payload carries no usable date.
   */
  dataThrough: number | null;
  /** Days identified as bulk-import stamps, population-wide. */
  stampDays: readonly StampDay[];
  /** Cohorts smaller than this are marked (never hidden). */
  minimumCohortSize: number;
  /**
   * Share of a cohort on a stamp run above which its numbers are suppressed.
   *
   * Suppressed means `null` **with the reason and the evidence**, which is the
   * one disposition `HANDOFF.md` allows: not the 100%, and not silence.
   */
  contaminationMax: number;
}

/**
 * Find runs of adjacent calendar days holding an implausible share of the
 * population's `lastSeenDate`.
 *
 * ## The mechanism, not a date
 *
 * A bulk import writes the same timestamp onto every row it touches. Organic
 * play never concentrates a tenth of a population's last activity on one stretch
 * of days — even a server's final day of life spreads across the players who had
 * already left. So a run above `minShare` is evidence of a write, and the report
 * publishes it with its base so a human can confirm which write.
 *
 * This replaces the hardcoded "cohorts up to 2025-08 are contaminated" boundary
 * that `HANDOFF.md` explicitly refuses: *"a fronteira de 2025-08 é ajuste
 * empírico, não mecanismo"*. A month constant would keep being applied long
 * after it stopped being true, and would miss a second import entirely.
 *
 * ## Why a short run and not a single day — and not a long run either
 *
 * The first version tested each day on its own, and that is not what the
 * `HANDOFF.md` describes: it says `lastSeenDate` is *"idêntico **ou colado** à
 * data da unificação"*. An import that ran across midnight leaves two adjacent
 * days of ~8% each, and a 10% per-day test sees **nothing** — with the output of
 * a missed detection being a cohort published at 100%.
 *
 * The window is capped at {@link MAX_STAMP_RUN_DAYS}, and the cap is not
 * cosmetic: with unbounded runs, a month of ordinary play is one 28-day run
 * holding a third of the population, and every day of it gets flagged as an
 * import. That inverts the detector — it would suppress the healthy data and
 * leave nothing to read. A bulk write happens in minutes; "colado" means one
 * midnight boundary, not a season.
 *
 * @param minShare share of the population above which a run is a stamp, 0..1
 * @param minPopulation below this the detector abstains — on twenty players a
 *   single day is trivially 10% of the sample, and calling that an import would
 *   suppress real cohorts on the strength of noise
 */
export function detectStampDays(
  players: readonly RetentionPlayer[],
  minShare: number,
  minPopulation: number,
): StampDay[] {
  const population = players.length;
  if (population < minPopulation) {
    return [];
  }

  const byDay = countByLastSeenDay(players);
  const stamps = new Map<string, StampDay>();

  for (const run of shortRuns([...byDay.keys()])) {
    const total = run.reduce((sum, day) => sum + (byDay.get(day) ?? 0), 0);
    const runShare = total / population;
    if (runShare < minShare) {
      continue;
    }
    const label = `${run[0]}..${run[run.length - 1]}`;
    for (const day of run) {
      const n = byDay.get(day) ?? 0;
      const candidate: StampDay = {
        day,
        share: round(n / population, 4),
        n,
        population,
        run: label,
        runShare: round(runShare, 4),
      };
      // Overlapping windows can reach the same day twice; the reader should see
      // it attributed to the strongest run it belongs to, not to whichever the
      // loop happened to visit last.
      const existing = stamps.get(day);
      if (existing === undefined || candidate.runShare > existing.runShare) {
        stamps.set(day, candidate);
      }
    }
  }

  // Biggest run first: when more than one import left a mark, the reader should
  // see the dominant one at the top rather than in calendar order.
  return [...stamps.values()].sort(
    (a, b) => b.runShare - a.runShare || b.n - a.n,
  );
}

/**
 * Build one row per (cohort month × platform).
 *
 * ## Maturity is filtered per player, against the DATA and not the clock
 *
 * A player registered three days ago has had the opportunity to survive one day
 * but not thirty. Dividing the whole cohort by itself at D30 is what makes the
 * current month read `0.0%` — a number that looks like a collapse and is an
 * artefact of the calendar. So each horizon counts only the players who have had
 * `N` days of opportunity, and publishes that count as its own `n`.
 *
 * **Opportunity is bounded by `dataThrough`, not by now.** That correction is
 * the one that matters: with the wall clock, a Plan that stopped collecting
 * three months ago still made every player "mature", and the module published
 * `D30 = 0.0%` over a base of hundreds — a stalled collection dressed as a
 * measurement. It is the failure mode the whole epic exists to remove, and this
 * module had it.
 *
 * A consequence worth stating: the three `n` of one cohort routinely differ, and
 * that is correct. A cohort whose D30 base is empty gets `null` — with
 * `source_stale` when the *data* could not reach that far, and
 * `immature_horizon` when the *calendar* could not. Never a zero.
 */
export function buildCohorts(
  players: readonly RetentionPlayer[],
  options: CohortOptions,
): CohortRetention[] {
  const stampDaySet = new Set(options.stampDays.map((stamp) => stamp.day));
  const groups = new Map<string, RetentionPlayer[]>();

  for (const player of players) {
    const month = toSaoPauloMonth(player.registeredAt);
    if (month === null) {
      // An unusable `registerDate` belongs to no cohort. Dropped rather than
      // guessed — the same rule the tutorial ETL applies to `started-date`.
      continue;
    }
    const key = `${month} ${platformOf(player.uuid)}`;
    const bucket = groups.get(key);
    if (bucket === undefined) {
      groups.set(key, [player]);
    } else {
      bucket.push(player);
    }
  }

  const cohorts: CohortRetention[] = [];

  for (const [key, members] of groups) {
    const [cohort, platform] = key.split(' ') as [string, Platform];
    const contamination = contaminationOf(members, stampDaySet, options);

    const measures = RETENTION_HORIZON_DAYS.map((days) =>
      measure(members, days, options, contamination),
    );

    cohorts.push({
      cohort,
      platform,
      size: members.length,
      belowMinimum: members.length < options.minimumCohortSize,
      contamination,
      measures: suppressImplausible(measures, members.length),
    });
  }

  return cohorts.sort(
    (a, b) =>
      a.cohort.localeCompare(b.cohort) || a.platform.localeCompare(b.platform),
  );
}

/**
 * Refuse a cohort that survives at ~100% on every horizon.
 *
 * The independent guard. The stamp detector answers "did an import write these
 * timestamps?"; this answers "is this result possible?", and it holds whatever
 * the import did — including an import that spread its writes widely enough to
 * stay under the stamp threshold, which is the case the first version of this
 * module published as fact.
 *
 * Applied after the measures are computed, on purpose: the bases stay counted,
 * so the payload still says how large the suppressed cohort was.
 */
function suppressImplausible(
  measures: RetentionMeasure[],
  cohortSize: number,
): RetentionMeasure[] {
  if (cohortSize < IMPLAUSIBLE_MIN_COHORT) {
    return measures;
  }

  const measured = measures.filter(
    (m): m is Extract<RetentionMeasure, { percent: number }> =>
      m.percent !== null,
  );
  // Every horizon has to be measured and implausible. A cohort with one
  // measured horizon at 100% is a young cohort, not an artefact.
  if (
    measured.length !== measures.length ||
    !measured.every((m) => m.percent >= IMPLAUSIBLE_SURVIVAL * 100)
  ) {
    return measures;
  }

  return measures.map((m) => ({
    horizon: m.horizon,
    percent: null,
    n: m.percent === null ? m.n : m.n,
    survived: null,
    reason: 'implausible_survival' as const,
    unavailableReason:
      `Esta coorte sobreviveria a ${IMPLAUSIBLE_SURVIVAL * 100}% ou mais em ` +
      'TODOS os horizontes, o que nenhuma coorte real faz — coorte real perde ' +
      'gente ja no D1. E a assinatura de `lastSeenDate` escrito por importacao ' +
      'em vez de vivido pelo jogador, e este teste e independente do detector ' +
      'de carimbo justamente porque uma importacao espalhada o suficiente passa ' +
      'por baixo dele. A base fica publicada; o percentual, nao.',
  }));
}

/**
 * How many consecutive months without evidence a run will bridge.
 *
 * Six. This is a judgement call and is marked as one — there is no mechanism
 * that makes seven wrong and six right. What there is: the production dataset
 * needs **five** (2024-09 through 2025-01 hold not one cohort of twenty, fifteen
 * cohorts, every one at 100%), so six is the smallest round number that covers
 * the one case ever observed with a month to spare.
 *
 * What the cap is actually for is bounding how far an inference may travel with
 * no evidence under it. The bulk write itself takes minutes; the gap has nothing
 * to do with its duration and everything to do with how many players happened to
 * register. Past roughly half a year the population has turned over enough that
 * "the same write" stops being the obvious explanation, and the cost of
 * suppressing a real cohort starts to outweigh the cost of publishing a fake
 * one.
 */
const MAX_SPAN_GAP_MONTHS = 6;

/**
 * What one registration month says about the artefact.
 *
 * `clean` is the one that matters and the one the first version of this detector
 * did not have. A month whose judgeable cohorts all passed — and which holds no
 * failing cohort of its own — is evidence **against** a write covering it, and
 * an inference that walks straight through it is not an inference about a write
 * any more.
 */
type MonthState = 'confirmed' | 'clean' | 'unknown';

/**
 * Find the runs of registration months where the import artefact is proven.
 *
 * ## The defect this closes, measured
 *
 * The first production read of `2024-06..2025-08`, on 2026-09-02, returned 45
 * cohorts. {@link suppressImplausible} caught 21. The remaining 24 published,
 * and **23 of them published 100% at D1, D7 and D30 alike** — the artefact's
 * exact signature, unmarked, over bases of 10 to 19 players.
 *
 * What separated the two groups was not the data. Every suppressed cohort had
 * 20 members or more; every published one had 19 or fewer. The largest
 * published cohort was 19 and the smallest suppressed one was 20 — the split
 * lands exactly on {@link IMPLAUSIBLE_MIN_COHORT}, which means the size floor
 * decided every case by itself.
 *
 * The floor is not wrong. Eleven players all sticking around proves nothing on
 * its own, and a guard without a floor would suppress every genuinely small
 * cohort — the opposite of the story's rule that small samples are marked, not
 * hidden. What is wrong is judging each cohort *in isolation* when the thing
 * being detected is a bulk **write**: a write covers a contiguous range of
 * registrations, so the months around a proven month are the same event.
 *
 * ## Runs, not the interval between the extremes
 *
 * The first version of this function returned `[min(confirmed), max(confirmed)]`
 * and that was unbounded extrapolation dressed as a mechanism: it invoked
 * contiguity as its justification and then never tested contiguity anywhere. Two
 * imports two years apart made one span of two years, and a cohort eleven months
 * from the nearest evidence in either direction was suppressed by it.
 *
 * So a run is grown instead, and stops at a wall:
 *
 * - a **clean** month (see {@link MonthState}) — a healthy judgeable cohort is
 *   evidence against the write, and inference does not cross it;
 * - a gap longer than {@link MAX_SPAN_GAP_MONTHS}.
 *
 * Months inside a run with nothing judgeable in them stay inside it. In
 * production, 2024-09 through 2025-01 are five consecutive such months holding
 * fifteen cohorts at 100% — reading that gap as clean is what published them.
 *
 * @param all cohorts over the WHOLE payload, never a request window. A window
 *   narrow enough to exclude every judgeable cohort would find no span and
 *   publish the artefact in full, which is the failure this exists to prevent.
 */
export function detectContaminatedSpans(
  all: readonly CohortRetention[],
): ConfirmedSpan[] {
  const states = monthStates(all);
  const confirmed = [...states.entries()]
    .filter(([, state]) => state === 'confirmed')
    .map(([month]) => month)
    .sort();

  if (confirmed.length === 0) {
    return [];
  }

  const runs: string[][] = [[confirmed[0]]];
  for (let i = 1; i < confirmed.length; i++) {
    const previous = confirmed[i - 1];
    const next = confirmed[i];
    const gap = monthsBetween(previous, next) - 1;
    const walled =
      gap > MAX_SPAN_GAP_MONTHS || hasCleanMonthBetween(states, previous, next);

    if (walled) {
      runs.push([next]);
    } else {
      runs[runs.length - 1].push(next);
    }
  }

  return runs.map((months) => {
    const from = months[0];
    const to = months[months.length - 1];
    const inside = all.filter(
      (cohort) => cohort.cohort >= from && cohort.cohort <= to,
    );

    return {
      from,
      to,
      confirmedMonths: months,
      confirmedCohorts: inside.filter(judgedImplausible).length,
      judgedCohorts: inside.filter(judgeable).length,
    };
  });
}

/**
 * Suppress the cohorts that inherit a proven span.
 *
 * Deliberately narrow: a cohort is only touched when it falls inside a span
 * **and** already reads at or above {@link IMPLAUSIBLE_SURVIVAL} on every
 * horizon. The size requirement is the only thing relaxed.
 *
 * A consequence worth being explicit about, because "clean cohort" is the wrong
 * way to think about it: a small cohort inside a span that genuinely retained
 * everybody **is** suppressed, because it is indistinguishable from the artefact
 * by construction. What survives untouched is a cohort with a *different shape*
 * — one that lost people, at any horizon, by any amount.
 *
 * @param spans an empty list disables the pass entirely.
 */
export function applyContaminatedSpans(
  cohorts: readonly CohortRetention[],
  spans: readonly ConfirmedSpan[],
): { cohorts: CohortRetention[]; spans: ContaminatedSpan[] } {
  if (spans.length === 0) {
    return { cohorts: [...cohorts], spans: [] };
  }

  const inherited = spans.map(() => ({ cohorts: 0, players: 0 }));

  const out = cohorts.map((cohort) => {
    // Runs never overlap, so the first match is the only match.
    const index = spans.findIndex(
      (span) => cohort.cohort >= span.from && cohort.cohort <= span.to,
    );

    if (
      index < 0 ||
      judgedImplausible(cohort) ||
      !readsImplausible(cohort.measures)
    ) {
      return cohort;
    }

    inherited[index].cohorts += 1;
    inherited[index].players += cohort.size;

    return {
      ...cohort,
      measures: cohort.measures.map((m): RetentionMeasure => ({
        horizon: m.horizon,
        percent: null,
        // The base survives suppression, here as everywhere: the payload still
        // says how large the cohort whose percentage vanished was.
        n: m.n,
        survived: null,
        reason: 'contaminated_span',
        unavailableReason: spanReason(spans[index]),
      })),
    };
  });

  return {
    cohorts: out,
    spans: spans.map((span, i) => ({
      ...span,
      inheritedCohorts: inherited[i].cohorts,
      inheritedPlayers: inherited[i].players,
    })),
  };
}

/** What each registration month says about the artefact. */
function monthStates(all: readonly CohortRetention[]): Map<string, MonthState> {
  const states = new Map<string, MonthState>();

  for (const cohort of all) {
    // A failing cohort settles the month whatever else it holds. A month can
    // carry a failing cohort AND a healthy one at the same time — production
    // 2025-08 does — and that makes it evidence, not a wall.
    if (judgedImplausible(cohort)) {
      states.set(cohort.cohort, 'confirmed');
      continue;
    }
    if (states.get(cohort.cohort) === 'confirmed') {
      continue;
    }
    if (judgeable(cohort)) {
      states.set(cohort.cohort, 'clean');
    } else if (!states.has(cohort.cohort)) {
      states.set(cohort.cohort, 'unknown');
    }
  }

  return states;
}

/** True when a clean month sits strictly between two confirmed ones. */
function hasCleanMonthBetween(
  states: ReadonlyMap<string, MonthState>,
  from: string,
  to: string,
): boolean {
  for (const [month, state] of states) {
    if (state === 'clean' && month > from && month < to) {
      return true;
    }
  }
  return false;
}

/** Calendar months from `from` to `to`, signed. Both `YYYY-MM`. */
function monthsBetween(from: string, to: string): number {
  const [fromYear, fromMonth] = from.split('-').map(Number);
  const [toYear, toMonth] = to.split('-').map(Number);
  return (toYear - fromYear) * 12 + (toMonth - fromMonth);
}

/**
 * True when {@link suppressImplausible} was able to reach a verdict on this
 * cohort — large enough, and with every horizon actually measured.
 *
 * A cohort of two hundred whose D30 is `immature_horizon` is not a pass and not
 * a failure; it is silence, and counting it either way would misstate the base
 * the suppression reason publishes.
 */
function judgeable(cohort: CohortRetention): boolean {
  // A condemned cohort WAS judgeable — its percentages read `null` precisely
  // because the guard judged it. Testing "every horizon measured" on its own
  // counts exactly zero of them, which made the reason string say "0 de 0" while
  // suppressing twenty-three cohorts.
  return (
    judgedImplausible(cohort) ||
    (cohort.size >= IMPLAUSIBLE_MIN_COHORT &&
      cohort.measures.length > 0 &&
      cohort.measures.every((m) => m.percent !== null))
  );
}

/** True when {@link suppressImplausible} judged this cohort on its own evidence. */
function judgedImplausible(cohort: CohortRetention): boolean {
  return cohort.measures.some(
    (m) => m.percent === null && m.reason === 'implausible_survival',
  );
}

/** True when every horizon is measured and at or above the implausible line. */
function readsImplausible(measures: readonly RetentionMeasure[]): boolean {
  return (
    measures.length > 0 &&
    measures.every(
      (m) => m.percent !== null && m.percent >= IMPLAUSIBLE_SURVIVAL * 100,
    )
  );
}

function spanReason(span: ConfirmedSpan): string {
  return (
    `Esta coorte tem menos de ${IMPLAUSIBLE_MIN_COHORT} jogadores, entao o ` +
    'teste de implausibilidade se abstem dela sozinha — sobre onze jogadores ' +
    'nenhum resultado prova nada. Mas ela sobrevive a ' +
    `${IMPLAUSIBLE_SURVIVAL * 100}% ou mais em TODOS os horizontes E registra ` +
    `dentro de ${span.from}..${span.to}, onde ${span.confirmedCohorts} de ` +
    `${span.judgedCohorts} coorte(s) grande(s) o bastante para serem julgadas ` +
    'foram reprovadas pelo mesmo teste. Essa faixa nao atravessa nenhum mes ' +
    'cujas coortes julgaveis tenham TODAS passado, nem lacuna maior que ' +
    `${MAX_SPAN_GAP_MONTHS} meses sem evidencia — sem essas duas paredes o ` +
    'intervalo seria extrapolacao, nao inferencia. O artefato vem de escrita ' +
    'em massa, e escrita em massa cobre uma faixa continua de registros: a ' +
    'vizinhanca e a mesma importacao, nao sorte. Julgar so pelo tamanho e o ' +
    'que fazia este modulo publicar 100% de retencao em D30 sobre bases de dez ' +
    'a dezenove jogadores, cercadas por coortes suprimidas. A base fica ' +
    'publicada; o percentual, nao. Ver `contaminatedSpans`.'
  );
}

function contaminationOf(
  members: readonly RetentionPlayer[],
  stampDays: ReadonlySet<string>,
  options: CohortOptions,
): CohortContamination {
  let stamped = 0;
  for (const player of members) {
    const day = toSaoPauloDay(player.lastSeenAt);
    if (day !== null && stampDays.has(day)) {
      stamped++;
    }
  }

  const share = members.length === 0 ? 0 : stamped / members.length;
  // `stamped > 0` is not redundant with the threshold: a `contaminationMax` of 0
  // would otherwise mark every clean cohort as an import artifact and suppress
  // the entire report. A cohort with no stamped player is never suspect,
  // whatever the configuration says.
  const suspect = stamped > 0 && share >= options.contaminationMax;

  return {
    share: round(share, 4),
    n: stamped,
    suspect,
    detectedBy: suspect ? 'population_stamp' : null,
  };
}

/*
 * ## Why there is no second, per-cohort stamp detector
 *
 * There was one, briefly. The review that asked for this hardening noted that a
 * population-wide share is taken over 5.565 rows, so a small old cohort that is
 * entirely imported can sit under the threshold and stay invisible — a real gap.
 * The obvious answer was to repeat the pile-up test inside each cohort.
 *
 * Measured against the existing fixtures, that detector fires on ordinary data:
 * a cohort of forty where twenty players last logged in on the same day is
 * completely normal for a small cohort, and it looks identical to an import at
 * that scale. It suppressed healthy cohorts, which is the failure this module
 * least affords.
 *
 * The gap is closed instead by {@link suppressImplausible}, which asks a
 * different question — not "was this written by an import?" but "is this result
 * possible?" — and needs no threshold about days at all. A fully imported cohort
 * reads ~100% at every horizon whatever the import did to the timestamps, so the
 * guard catches the case the population-wide detector misses, without inventing
 * a way to suppress real data.
 */

function countByLastSeenDay(
  players: readonly RetentionPlayer[],
): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const player of players) {
    const day = toSaoPauloDay(player.lastSeenAt);
    if (day === null) {
      continue;
    }
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  return byDay;
}

/**
 * Longest a stamp run may be, in days.
 *
 * Two. A bulk write takes minutes; the only reason it can touch a second
 * calendar day at all is a midnight boundary, which is exactly the case
 * `HANDOFF.md` means by "colado". Anything longer is a season of ordinary play,
 * and treating it as an import would suppress the healthy data instead of the
 * artefact.
 */
const MAX_STAMP_RUN_DAYS = 2;

/**
 * Every window of at most {@link MAX_STAMP_RUN_DAYS} consecutive days.
 *
 * Sliding rather than partitioning: a partition of maximal runs would put a
 * boundary between two adjacent stamp days whenever a third day happened to
 * touch one of them, which is the shape the detector exists to see.
 */
function shortRuns(days: readonly string[]): string[][] {
  const sorted = [...days].sort();
  const runs: string[][] = [];

  for (let i = 0; i < sorted.length; i++) {
    const window = [sorted[i]];
    for (
      let j = i + 1;
      j < sorted.length && window.length < MAX_STAMP_RUN_DAYS;
      j++
    ) {
      if (!isNextDay(window[window.length - 1], sorted[j])) {
        break;
      }
      window.push(sorted[j]);
    }
    // The single day is a window in its own right, and so is the pair.
    runs.push([sorted[i]]);
    if (window.length > 1) {
      runs.push(window);
    }
  }

  return runs;
}

/** True when `next` is the calendar day right after `day`. */
function isNextDay(day: string, next: string): boolean {
  // Midday anchor so a DST transition cannot make "+1 day" land on the same or
  // the day after next — the same trick the funnel and the report use.
  const after = Date.parse(`${day}T12:00:00-03:00`) + MS_PER_DAY;
  return toSaoPauloDay(after) === next;
}

function measure(
  members: readonly RetentionPlayer[],
  days: (typeof RETENTION_HORIZON_DAYS)[number],
  options: CohortOptions,
  contamination: CohortContamination,
): RetentionMeasure {
  const horizon = horizonLabel(days);
  const window = days * MS_PER_DAY;

  // Bounded by the data, not by the clock. See `CohortOptions.dataThrough`.
  const observable = options.dataThrough ?? 0;
  const eligible = members.filter(
    (player) => observable - player.registeredAt >= window,
  );

  if (contamination.suspect) {
    return {
      horizon,
      percent: null,
      n: eligible.length,
      survived: null,
      reason: 'import_artifact',
      unavailableReason:
        `${round(contamination.share * 100, 1)}% desta coorte (${contamination.n} ` +
        `de ${members.length}) tem lastSeenDate num intervalo de dias ` +
        'identificado como carimbo de importacao em massa, nao como atividade ' +
        `de jogador (detector: ${contamination.detectedBy ?? 'desconhecido'}). ` +
        'A retencao calculada sobre isso daria perto de 100% por construcao. ' +
        'Os dias detectados estao em `stampDays`, com a base de cada um.',
    };
  }

  if (eligible.length === 0) {
    // Two different absences wearing the same empty base, and telling them apart
    // is the whole point: the calendar has not caught up, or the DATA has not.
    const calendarMature = members.some(
      (player) => options.evaluatedAt - player.registeredAt >= window,
    );

    return calendarMature
      ? {
          horizon,
          percent: null,
          n: 0,
          survived: null,
          reason: 'source_stale',
          unavailableReason:
            `Ja passaram ${days} dia(s) desde o registro desta coorte, mas a ` +
            'fonte parou de avancar antes disso: o `lastSeenDate` mais recente ' +
            'do payload nao alcanca este horizonte. Publicar a divisao aqui ' +
            'daria perto de 0%, que e a coleta parada se passando por medicao — ' +
            'exatamente o apagao de tres meses que este epico existe para nao ' +
            'repetir. Ver `source.dataThrough`.',
        }
      : {
          horizon,
          percent: null,
          n: 0,
          survived: null,
          reason: 'immature_horizon',
          unavailableReason:
            `Nenhum jogador desta coorte teve ${days} dia(s) de oportunidade ` +
            'ate o momento da leitura. Publicar a divisao pela coorte inteira ' +
            'daria 0,0%, que se le como colapso e e so o calendario.',
        };
  }

  const survived = eligible.filter(
    (player) => player.lastSeenAt - player.registeredAt >= window,
  ).length;

  return {
    horizon,
    percent: round((survived / eligible.length) * 100, 1),
    n: eligible.length,
    survived,
  };
}

/** Round to `digits` decimals without the float noise of `toFixed` round-trips. */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
