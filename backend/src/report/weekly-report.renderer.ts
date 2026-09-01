import type { Conversion, StepCount } from '../funnel/funnel.types';
import type {
  CohortRetention,
  RetentionMeasure,
} from '../retention/retention.types';
import type { WeeklyReport } from './weekly-report.types';

/**
 * Discord's cap on one embed description. Exceeding it is a 400, not a trim.
 */
const DESCRIPTION_LIMIT = 4096;

/**
 * Cohort lines the report will print before it starts counting the rest.
 *
 * Twelve is three months × four platforms — the whole grid at the current
 * shape. The cap exists so a future widening (more months, a new platform)
 * cannot silently push the message past Discord's limit, which is how the
 * alerter learned this lesson: the payload that becomes too big to send is
 * exactly the one nobody can afford to lose.
 */
const MAX_COHORT_LINES = 12;

/**
 * Renders a {@link WeeklyReport} as the text that goes to Discord and to the
 * `rendered` column (story S9.2).
 *
 * ## One rendering, two destinations, on purpose
 *
 * What is stored is character-for-character what was sent. Criterion 4 asks for
 * the generated version to be persisted so that "what did we report that week"
 * is answerable later; storing a *different* rendering than the one delivered
 * would answer a question nobody asked.
 *
 * ## Every percentage is printed with its base
 *
 * Enforced by the shape of the inputs rather than by care here: `Conversion` and
 * `RetentionMeasure` are discriminated unions whose measured variant carries
 * `n`, so there is no branch in this file that *could* print a bare ratio.
 *
 * ## The retention label is printed, not implied
 *
 * `lastSeenDate` measures survival interval, not return-on-day-N. The section
 * header says so every week. A Discord message is where a number gets quoted out
 * of context, so the caveat has to be inside the quote.
 */
export function renderWeeklyReport(report: WeeklyReport): string {
  const lines: string[] = [
    `**Relatorio semanal — ${report.from} a ${report.to}**`,
    '',
    ...funnelLines(report),
    '',
    ...retentionLines(report),
    '',
    ...healthLines(report),
  ];

  return clamp(lines.join('\n'), DESCRIPTION_LIMIT);
}

/** The message announcing that the job itself failed (criterion 3). */
export function renderFailure(
  from: string,
  to: string,
  detail: string,
): string {
  return clamp(
    [
      `**Relatorio semanal NAO foi gerado — ${from} a ${to}**`,
      '',
      'O job falhou antes de conseguir montar o conteudo. Isto e um aviso ' +
        'sobre o proprio relatorio, nao sobre a rede do jogo: enquanto ele nao ' +
        'voltar, a ausencia de relatorio semanal deixa de significar "semana ' +
        'sem novidade".',
      '',
      `Motivo: ${detail}`,
    ].join('\n'),
    DESCRIPTION_LIMIT,
  );
}

function funnelLines(report: WeeklyReport): string[] {
  const { bucket, coverage, sources } = report.funnel;
  const coverageOf = new Map(coverage.map((c) => [c.step, c]));

  const lines = ['__Funil da janela__'];

  for (const count of bucket.counts) {
    const days = coverageOf.get(count.step);
    const suffix =
      days === undefined
        ? ''
        : ` _(${days.days}/${days.ofDays} dias com dado)_`;
    lines.push(`• \`${count.step}\` — ${renderCount(count)}${suffix}`);
  }

  lines.push('', '__Conversoes__');
  for (const conversion of bucket.conversions) {
    lines.push(
      `• \`${conversion.from}\` → \`${conversion.to}\` — ${renderConversion(conversion)}`,
    );
  }

  const broken = sources.filter((source) => !source.ok);
  if (broken.length > 0) {
    lines.push(
      '',
      `⚠️ Fonte(s) fora: ${broken
        .map((source) => `\`${source.name}\` (${source.failure ?? 'falha'})`)
        .join(', ')}`,
    );
  }

  return lines;
}

function retentionLines(report: WeeklyReport): string[] {
  const { cohorts, source, from, to, stampDays } = report.retention;

  const lines = [
    `__Retencao por coorte — ${from} a ${to}__`,
    '⚠️ Intervalo de sobrevivencia, **nao** retorno no dia N.',
  ];

  if (!source.ok) {
    lines.push(
      `Sem dados: a fonte respondeu \`${source.failure ?? 'falha'}\`. ` +
        'Isto nao e "nenhuma coorte reteve" — e "nao foi possivel medir".',
    );
    return lines;
  }

  if (cohorts.length === 0) {
    lines.push('Nenhuma coorte no periodo.');
    return lines;
  }

  for (const cohort of cohorts.slice(0, MAX_COHORT_LINES)) {
    lines.push(renderCohort(cohort));
  }

  if (cohorts.length > MAX_COHORT_LINES) {
    lines.push(
      `… e mais ${cohorts.length - MAX_COHORT_LINES} coorte(s) nao exibida(s).`,
    );
  }

  if (stampDays.length > 0) {
    lines.push(
      '',
      `⚠️ Carimbo de importacao detectado em ${stampDays
        .map((stamp) => `${stamp.day} (n=${stamp.n}/${stamp.population})`)
        .join(', ')} — coortes contaminadas saem sem numero, com o motivo.`,
    );
  }

  return lines;
}

function healthLines(report: WeeklyReport): string[] {
  const summary = report.health.summary;
  const counts = summary.counts;

  const lines = [
    '__Saude da instrumentacao__',
    `• Estado: \`${summary.status}\`${summary.stale ? ' _(veredito velho)_' : ''}`,
    `• Checks: ok=${counts.ok} · breached=${counts.breached} · ` +
      `no_data=${counts.no_data} · error=${counts.error}`,
  ];

  if (!summary.schedule.enabled) {
    lines.push(
      '• ⚠️ **O ciclo de checks esta desligado** — nada esta sendo medido.',
    );
  }

  if (summary.failing.length > 0) {
    lines.push(`• Em falha: ${summary.failing.map(code).join(', ')}`);
  }

  if (summary.staleChecks.length > 0) {
    lines.push(`• Emudeceram: ${summary.staleChecks.map(code).join(', ')}`);
  }

  if (summary.missing.length > 0) {
    lines.push(
      `• Nunca gravaram veredito: ${summary.missing.map(code).join(', ')}`,
    );
  }

  if (summary.blindSpots.length > 0) {
    lines.push(
      `• Pontos cegos aceitos: ${summary.blindSpots.map(code).join(', ')}`,
    );
  }

  return lines;
}

function renderCohort(cohort: CohortRetention): string {
  const marks = [
    cohort.belowMinimum ? '⚠️ amostra pequena' : null,
    cohort.contamination.suspect ? '⚠️ carimbo de importacao' : null,
  ].filter((mark): mark is string => mark !== null);

  const head =
    `• \`${cohort.cohort}\` \`${cohort.platform}\` (n=${cohort.size})` +
    (marks.length > 0 ? ` ${marks.join(' ')}` : '');

  return `${head} — ${cohort.measures.map(renderMeasure).join(' · ')}`;
}

function renderMeasure(measure: RetentionMeasure): string {
  if (measure.percent === null) {
    return `${measure.horizon} — sem dado (${measure.reason})`;
  }
  return `${measure.horizon} ${percent(measure.percent)} (n=${measure.n})`;
}

function renderCount(count: StepCount): string {
  return count.value === null
    ? `sem dado — ${firstSentence(count.unavailableReason)}`
    : String(count.value);
}

function renderConversion(conversion: Conversion): string {
  if (conversion.percent === null) {
    const base = conversion.n === null ? '' : ` (n=${conversion.n})`;
    return `sem dado${base} — ${firstSentence(conversion.unavailableReason)}`;
  }
  return `${percent(conversion.percent)} (n=${conversion.n})`;
}

function percent(value: number): string {
  return `${value.toFixed(1).replace('.', ',')}%`;
}

function code(name: string): string {
  return `\`${name}\``;
}

/**
 * The first sentence of a reason, so a paragraph-long explanation does not eat
 * the message.
 *
 * The full text stays in the API response, which is where someone who wants it
 * will look. Truncating here rather than shortening the constants keeps the
 * HTTP contract complete and the chat message readable.
 */
function firstSentence(reason: string): string {
  const stop = reason.indexOf('. ');
  const first = stop === -1 ? reason : reason.slice(0, stop + 1);
  return clamp(first.trim(), 240);
}

/** Hard-trim with a marker, so a cut is visible instead of silent. */
function clamp(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const marker = '\n… (truncado)';
  return `${text.slice(0, limit - marker.length)}${marker}`;
}
