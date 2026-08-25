import { ApiProperty } from '@nestjs/swagger';
import { Matches, MaxLength } from 'class-validator';

/**
 * Charset of a persisted check name.
 *
 * Derived from what the system actually writes: the names in `HealthCheckName`
 * are dotted lower-case identifiers, and a per-target check appends
 * `:<server name>` via `scopedCheckName` — Plan server names being things like
 * `AusTv` and `Survival`.
 *
 * The bound is not an injection defence: Drizzle parameterises the query, so a
 * quote in here was never going to reach the planner. It is there so a caller
 * cannot spend a database round trip on a megabyte of junk, and so that a
 * typo comes back as a 400 that names the problem instead of an empty history
 * that looks like "this check never ran".
 */
export const CHECK_NAME_PATTERN = /^[A-Za-z0-9._:-]+$/;

export const MAX_CHECK_NAME_LENGTH = 120;

/** Route parameter of the history endpoint (story S7.1, issue #110). */
export class CheckNameParamDto {
  @ApiProperty({
    example: 'plan.collection_alive:Survival',
    description:
      'Nome persistido do check, com o sufixo de escopo quando houver.',
  })
  @MaxLength(MAX_CHECK_NAME_LENGTH)
  @Matches(CHECK_NAME_PATTERN, {
    message:
      'name must contain only letters, digits, dot, underscore, colon or hyphen',
  })
  name!: string;
}
