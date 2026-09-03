import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { DISCORD_SNOWFLAKE, DISCORD_SNOWFLAKE_MESSAGE } from './discord-id';
import { AUDIT_COMMAND_MAX_CHARS } from './transition-suggestion.dto';

/** Longest refusal reason accepted. */
export const AUDIT_REASON_MAX_CHARS = 300;

/**
 * An attempt the **bot** refused before calling the API — the staff-role check
 * failed. It has to be reported rather than inferred: the roles live in Discord,
 * so this database can never observe the refusal on its own.
 */
export class DeniedAttemptDto {
  @ApiProperty({ description: 'Quem tentou.' })
  @Matches(DISCORD_SNOWFLAKE, { message: `actor ${DISCORD_SNOWFLAKE_MESSAGE}` })
  actor!: string;

  @ApiProperty({ description: 'Comando ou custom id usado na tentativa.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(AUDIT_COMMAND_MAX_CHARS)
  command!: string;

  @ApiProperty({ description: 'Por que o bot recusou.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(AUDIT_REASON_MAX_CHARS)
  reason!: string;
}
