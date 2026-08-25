import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { HEALTH_CHECK_STATUSES } from '../../instrumentation/health-check.types';
import type { HealthCheckStatus } from '../../instrumentation/health-check.types';

/**
 * Public shape of the instrumentation-health reads (story S7.1, issue #110).
 *
 * These classes are the **API contract**, deliberately separate from the
 * internal `HealthCheckRecord` even where they look alike. The internal record
 * carries a database id and `Date` objects; the contract carries neither, so a
 * change to the storage layer cannot leak out through a route and no consumer
 * can come to depend on a row id that only means something inside Postgres.
 *
 * They are classes rather than interfaces for one reason: `@ApiProperty` needs a
 * value at runtime. Declaring the contract twice — once for TypeScript, once for
 * the OpenAPI schema — is how documentation drifts from behaviour, and this
 * project has already paid for one comment that described a system nobody read.
 *
 * **Nothing here carries player data.** `detail.context` is contractually
 * limited to server names, windows and build ids.
 */

/**
 * Aggregate verdict of the whole instrumentation layer.
 *
 * Four values, and the two that are neither `ok` nor `degraded` are the point:
 *
 * - `unknown` — no check has ever run. Not healthy, not broken: unmeasured.
 * - `down` — the cycle itself is not alive, or a check could not reach its
 *   source. Both mean "we are not measuring right now", which is the state that
 *   went unnoticed for three months and is the reason this epic exists.
 */
export const INSTRUMENTATION_STATUSES = [
  'ok',
  'degraded',
  'down',
  'unknown',
] as const;

export type InstrumentationStatus = (typeof INSTRUMENTATION_STATUSES)[number];

/** How many checks sit in each verdict right now. */
export class HealthCheckCountsDto {
  @ApiProperty({ example: 6 })
  ok!: number;

  @ApiProperty({ description: 'Rodou e a condicao de alerta foi atingida.' })
  breached!: number;

  @ApiProperty({
    description:
      'Rodou, mas a fonte nao tinha nada para a janela. Nao e zero, e nao e falha.',
  })
  no_data!: number;

  @ApiProperty({ description: 'Nao conseguiu rodar: fonte inalcancavel.' })
  error!: number;
}

/** Cadence of the health cycle, as configured. */
export class InstrumentationScheduleDto {
  @ApiProperty({
    description:
      'False quando HEALTH_CHECK_ENABLED esta desligado — nada esta sendo medido.',
  })
  enabled!: boolean;

  @ApiProperty({ example: 15 })
  intervalMinutes!: number;

  @ApiProperty({
    description:
      'Quanto o veredito mais novo pode envelhecer antes de a camada ser considerada cega.',
    example: 30,
  })
  staleAfterMinutes!: number;
}

/** Aggregate read, shaped small and stable for an uptime probe. */
export class InstrumentationSummaryDto {
  @ApiProperty({ enum: INSTRUMENTATION_STATUSES })
  status!: InstrumentationStatus;

  @ApiProperty({
    description:
      'True quando QUALQUER check passou da tolerancia, o agendamento esta ' +
      'desligado, ou nada nunca rodou. Vem do check mais VELHO, nunca do mais ' +
      'novo: um irmao que continua escrevendo mascararia o que emudeceu, que e ' +
      'exatamente o caso para o qual este endpoint existe. Fica ao lado de ' +
      '`status`, e nao dentro dele, para que "um check falhou" e "paramos de ' +
      'olhar" sejam distinguiveis sem abrir a lista.',
  })
  stale!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Veredito mais NOVO, em ISO-8601, ou null quando nada nunca rodou. Bom ' +
      'para exibir; nao serve para decidir frescor.',
  })
  lastCheckedAt!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Veredito mais VELHO entre os atuais, em ISO-8601. E o numero que decide ' +
      '`stale`, e a distancia entre ele e `lastCheckedAt` mostra se a camada ' +
      'esta correndo junto ou se algo ficou para tras.',
  })
  oldestCheckedAt!: string | null;

  @ApiProperty({
    description: 'Quantos checks distintos tem veredito gravado.',
  })
  total!: number;

  @ApiProperty({ type: HealthCheckCountsDto })
  counts!: HealthCheckCountsDto;

  @ApiProperty({
    type: [String],
    description:
      'Nomes persistidos de todo check cujo veredito atual nao e `ok`.',
  })
  failing!: string[];

  @ApiProperty({
    type: [String],
    description:
      'Checks cujo veredito atual passou da tolerancia — pararam de rodar, mas ' +
      'a ultima linha continua la. Separado de `failing` de proposito: ' +
      '"mediu e deu ruim" e "parou de medir" pedem acoes diferentes.',
  })
  staleChecks!: string[];

  @ApiProperty({
    type: [String],
    description:
      'Checks registrados que nunca gravaram veredito nenhum. Nao aparecem em ' +
      '`total` nem em `counts` porque nao existe linha deles — e ausencia se le ' +
      'como tudo bem. Mesma forma do proprio check `plan.orphan_instance`: ' +
      'algo que deveria estar reportando e nao esta.',
  })
  missing!: string[];

  @ApiProperty({ type: InstrumentationScheduleDto })
  schedule!: InstrumentationScheduleDto;
}

/** Structured verdict of one execution, as published. */
export class HealthCheckDetailDto {
  @ApiProperty({
    description:
      'Resumo de uma linha, em portugues — o mesmo que vai ao Discord.',
  })
  summary!: string;

  @ApiPropertyOptional({
    description: 'O valor que produziu o veredito, quando o check gera numero.',
  })
  observed?: number;

  @ApiPropertyOptional({
    description: 'Contra o que `observed` foi comparado.',
  })
  threshold?: number;

  @ApiPropertyOptional({
    description:
      'Tamanho da amostra por tras de `observed`. Obrigatorio sempre que ' +
      '`observed` for razao — o contrato nao publica percentual sem base.',
  })
  n?: number;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'Contexto: nome de servidor, janela, ids de build. Nunca dado pessoal.',
  })
  context?: Record<string, string | number | boolean | null>;
}

/** One check's current or historical verdict. */
export class HealthCheckViewDto {
  @ApiProperty({
    example: 'plan.collection_alive:Survival',
    description: 'Nome persistido, com escopo quando o check e por alvo.',
  })
  name!: string;

  @ApiProperty({
    example: 'plan.collection_alive',
    description: 'Nome base do check, sem o sufixo de escopo.',
  })
  check!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Survival',
    description: 'Alvo avaliado, ou null quando o check e global.',
  })
  target!: string | null;

  @ApiProperty({ enum: HEALTH_CHECK_STATUSES })
  status!: HealthCheckStatus;

  @ApiProperty({
    description:
      'True quando ESTE check passou da tolerancia — o veredito continua ' +
      'gravado, mas parou de ser renovado. Sempre false no historico, onde toda ' +
      'linha alem da primeira e velha por definicao.',
  })
  stale!: boolean;

  @ApiProperty({
    description: 'ISO-8601. Carimbado pelo banco, nunca pelo container da API.',
  })
  checkedAt!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'ISO-8601 de quando este veredito virou alerta no Discord; null quando nao virou.',
  })
  alertedAt!: string | null;

  @ApiProperty({ type: HealthCheckDetailDto, nullable: true })
  detail!: HealthCheckDetailDto | null;
}

export class HealthCheckListDto {
  @ApiProperty()
  count!: number;

  @ApiProperty({ type: [HealthCheckViewDto] })
  checks!: HealthCheckViewDto[];
}

export class HealthCheckHistoryDto {
  @ApiProperty({ description: 'O check pedido, ecoado de volta.' })
  name!: string;

  @ApiProperty({
    description:
      'O teto aplicado — para que uma pagina cheia seja distinguivel do fim do historico.',
  })
  limit!: number;

  @ApiProperty()
  count!: number;

  @ApiProperty({
    type: [HealthCheckViewDto],
    description: 'Mais novo primeiro.',
  })
  entries!: HealthCheckViewDto[];
}
