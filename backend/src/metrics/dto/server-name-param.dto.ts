import { ApiProperty } from '@nestjs/swagger';
import { Matches, MaxLength } from 'class-validator';

/**
 * Charset of a Plan server name.
 *
 * `PLAN_SERVERS` is free-form configuration, so the names that reach here are
 * whatever the operator wrote — `AusTv`, `Survival`, and plausibly
 * `Survival Renascer`. Letters of any script, digits, spaces and the handful of
 * separators a server name realistically uses.
 *
 * The value never reaches a SQL planner — this module speaks only HTTP to Plan
 * (ADR-002) — so this is not an injection defence. What it does is stop a caller
 * from spending a request on a megabyte of junk, and keep a typo an honest 400
 * instead of a 404 that reads like "that server does not exist".
 *
 * The real gate is `MetricsService.requireConfigured`: a syntactically valid name
 * that is not in `PLAN_SERVERS` never produces a request to Plan.
 */
export const SERVER_NAME_PATTERN = /^[\p{L}\p{N} ._-]+$/u;

export const MAX_SERVER_NAME_LENGTH = 100;

/** Route parameter of the per-server metrics routes (story S7.2, issue #111). */
export class ServerNameParamDto {
  @ApiProperty({
    example: 'Survival',
    description:
      'Nome exatamente como o Plan o grafa. A comparacao com `PLAN_SERVERS` ' +
      'ignora caixa, e o nome configurado e o que segue para o Plan — que ' +
      'diferencia maiuscula no `?server=`.',
  })
  @MaxLength(MAX_SERVER_NAME_LENGTH)
  @Matches(SERVER_NAME_PATTERN, {
    message:
      'server must contain only letters, digits, spaces, dot, underscore or hyphen',
  })
  server!: string;
}
