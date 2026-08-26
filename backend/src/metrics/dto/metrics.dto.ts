import { ApiProperty } from '@nestjs/swagger';

/**
 * Public contract of the metrics reads (story S7.2, issue #111).
 *
 * ## Plan's schema does not leak through here
 *
 * These classes are the §7 contract, and they are deliberately **not** a
 * pass-through of what `/v1/*` returns. Plan's field names (`new_players_7d`,
 * `session_length_30d_avg`), its mixed value types and its pre-formatted
 * percentages stop at the adapter. That is the whole point of ADR-002: the JSON
 * API is the stable surface *for us*, and a consumer that grew to depend on
 * Plan's spelling would break on a Plan upgrade nobody here controls.
 *
 * ## Every payload can say "I could not measure this"
 *
 * `stale` and `staleSince` travel on every response, and every number is
 * nullable. There is no shape in this file that can express "zero" when the
 * truth is "unknown" — that confusion is the reason this epic exists, and making
 * it unrepresentable in the contract is cheaper than catching it in review
 * forever.
 */

/** A count and the base it was computed from. Never one without the other. */
export class RatioDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 24,
    description: 'Numerador. Null quando o Plan nao mediu.',
  })
  value!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 36,
    description:
      'Base do numerador. O contrato nunca publica razao sem ela — um ' +
      'percentual sem base ja produziu tres conclusoes erradas neste projeto.',
  })
  n!: number | null;
}

/** One time window of playerbase activity. */
export class MetricsWindowDto {
  @ApiProperty({ type: Number, nullable: true, example: 36 })
  newPlayers!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 230 })
  uniquePlayers!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1588 })
  sessions!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 3833062041,
    description:
      'Playtime acumulado na janela, em MILISSEGUNDOS. A unidade esta no nome ' +
      'porque um fator de 1000 silencioso nao e conferivel de olho.',
  })
  playtimeMs!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 2413767,
    description: 'Duracao media de sessao na janela, em milissegundos.',
  })
  sessionLengthAvgMs!: number | null;

  @ApiProperty({
    type: RatioDto,
    description:
      'Novatos que voltaram, sobre novatos da janela. O Plan tambem imprime o ' +
      'percentual pronto; ele e descartado de proposito.',
  })
  newPlayerRetention!: RatioDto;
}

/** Freshness of a payload, carried by every metrics response. */
export class MetricsFreshnessDto {
  @ApiProperty({
    description:
      'True quando o Plan nao respondeu e este corpo veio do ultimo valor ' +
      'guardado. Nunca vem `false` por omissao: se nao houver valor nenhum, a ' +
      'resposta e 503 com `data: null`.',
  })
  stale!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'ISO-8601 de quando ESTE corpo foi buscado do Plan. Junto de `stale`, e o ' +
      'que permite ao consumidor decidir se o numero ainda serve.',
  })
  fetchedAt!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 42,
    description: 'Idade do corpo em segundos, no momento da resposta.',
  })
  ageSeconds!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Por que a busca falhou, quando falhou. Null numa resposta fresca.',
  })
  reason!: string | null;
}

/** Aggregate activity of one server, normalised from `/v1/onlineOverview`. */
export class ServerActivityDto {
  @ApiProperty({ example: 'Survival' })
  server!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'ISO-8601 do instante em que o PLAN gerou os numeros. Diferente de ' +
      '`freshness.fetchedAt`, que e quando NOS buscamos — os dois divergem ' +
      'sempre que o corpo vem do cache.',
  })
  observedAt!: string | null;

  @ApiProperty({ type: MetricsWindowDto })
  last24h!: MetricsWindowDto;

  @ApiProperty({ type: MetricsWindowDto })
  last7d!: MetricsWindowDto;

  @ApiProperty({ type: MetricsWindowDto })
  last30d!: MetricsWindowDto;
}

/** Point-in-time view of one server, normalised from `/v1/serverOverview`. */
export class ServerOverviewDto {
  @ApiProperty({ example: 'Survival' })
  server!: string;

  @ApiProperty({ type: String, nullable: true })
  observedAt!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 8,
    description:
      'Jogadores conectados agora. Null e "o Plan nao informou", nunca ' +
      '"ninguem online" — a distincao e a razao de ser deste epico.',
  })
  onlinePlayers!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 5540 })
  totalPlayers!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 138965 })
  totalSessions!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'ISO-8601 do ultimo pico de jogadores registrado.',
  })
  lastPeakAt!: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 43 })
  newPlayers7d!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 237 })
  uniquePlayers7d!: number | null;

  @ApiProperty({
    type: RatioDto,
    description: 'Retencao de novatos em 7 dias, com a base ao lado.',
  })
  newPlayerRetention7d!: RatioDto;
}

/**
 * Envelope of every metrics response.
 *
 * The **same shape on 200 and on 503**, differing only in `freshness` and in
 * `data` being null. A degraded response that changed shape would force the
 * consumer to parse two contracts and would tempt it to treat the 503 body as
 * unreadable — which is how a usable stale value gets thrown away in favour of
 * an empty page.
 */
export class MetricsEnvelopeDto<T> {
  @ApiProperty({ type: MetricsFreshnessDto })
  freshness!: MetricsFreshnessDto;

  data!: T | null;
}

/** `GET /metrics/servers/:server` */
export class ServerOverviewResponseDto extends MetricsEnvelopeDto<ServerOverviewDto> {
  @ApiProperty({
    type: ServerOverviewDto,
    nullable: true,
    description: 'Null apenas quando o Plan falhou e nao ha valor guardado.',
  })
  declare data: ServerOverviewDto | null;
}

/** `GET /metrics/servers/:server/activity` */
export class ServerActivityResponseDto extends MetricsEnvelopeDto<ServerActivityDto> {
  @ApiProperty({
    type: ServerActivityDto,
    nullable: true,
    description: 'Null apenas quando o Plan falhou e nao ha valor guardado.',
  })
  declare data: ServerActivityDto | null;
}

/** `GET /metrics/servers` — the instances this API is configured to read. */
export class ConfiguredServerDto {
  @ApiProperty({ example: 'Survival' })
  name!: string;

  @ApiProperty({
    description:
      'True para o proxy da rede. Metrica derivada de sessao e ' +
      'estruturalmente vazia nele: proxy grava usuario, backend grava sessao ' +
      '(secao 2 do spec). Ignorar isso ja produziu uma hipotese de incidente ' +
      'que nao existia.',
  })
  proxy!: boolean;
}

export class ConfiguredServersDto {
  @ApiProperty({ type: [ConfiguredServerDto] })
  servers!: ConfiguredServerDto[];
}
