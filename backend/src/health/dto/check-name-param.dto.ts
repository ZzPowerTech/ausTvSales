import { ApiProperty } from '@nestjs/swagger';
import { Matches, MaxLength } from 'class-validator';

/**
 * Charset of a persisted check name.
 *
 * The base names in `HealthCheckName` are dotted lower-case identifiers, but a
 * per-target check appends `:<server name>` via `scopedCheckName`, and that
 * suffix is **whatever `PLAN_SERVERS` contains** — free-form configuration with
 * no charset validation of its own.
 *
 * The first version of this pattern was `[A-Za-z0-9._:-]+`, taken from the two
 * names that happen to sit in `.env.example` (`AusTv`, `Survival`). A server
 * called `Survival Renascer` or `Cidade Alfa` — entirely ordinary here — writes
 * a verdict whose history route would then answer `400` forever, and it would be
 * the check the operator most wanted history for. So letters of any script,
 * digits and spaces are allowed.
 *
 * None of this is an injection defence: Drizzle parameterises the query, so a
 * quote was never going to reach the planner. The bound exists so a caller
 * cannot spend a database round trip on a megabyte of junk, and so a typo comes
 * back as a 400 that names the problem instead of an empty history that reads
 * like "this check never ran".
 */
export const CHECK_NAME_PATTERN = /^[\p{L}\p{N} ._:-]+$/u;

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
      'name must contain only letters, digits, spaces, dot, underscore, colon or hyphen',
  })
  name!: string;
}
