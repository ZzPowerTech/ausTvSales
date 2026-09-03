import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { SUGGESTION_STATUSES, type SuggestionStatus } from '../../db/schema';
import { DISCORD_SNOWFLAKE, DISCORD_SNOWFLAKE_MESSAGE } from './discord-id';

/** Longest command identifier accepted, so the audit column cannot be a payload. */
export const AUDIT_COMMAND_MAX_CHARS = 120;

/** Discord's own cap for a server nickname, mirrored by the DB check. */
export const ASSIGNEE_NICKNAME_MAX_CHARS = 64;

export class TransitionSuggestionDto {
  @ApiProperty({
    enum: SUGGESTION_STATUSES,
    description:
      'Estado desejado. Transicao invalida devolve 409 e NAO altera o registro.',
  })
  @IsIn(SUGGESTION_STATUSES as readonly string[])
  to!: SuggestionStatus;

  @ApiProperty({
    description:
      'Id do staff que acionou, verificado pelo bot antes da chamada — so o bot ' +
      'enxerga os cargos da guild.',
  })
  @Matches(DISCORD_SNOWFLAKE, { message: `actor ${DISCORD_SNOWFLAKE_MESSAGE}` })
  actor!: string;

  @ApiProperty({
    description:
      'Comando ou custom id do componente que produziu a acao. Vai para a ' +
      'trilha de auditoria: o autor diz quem, o comando diz por onde.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(AUDIT_COMMAND_MAX_CHARS)
  command!: string;

  @ApiPropertyOptional({
    description:
      'Apelido do staff no servidor do Discord, lido pelo bot agora. A ' +
      'transicao que chega em `aprovada` congela isto em `assignee_nickname` — ' +
      'e o congelamento e o ponto: quem se renomear no mes que vem nao reescreve ' +
      'o que a loja disse no mes passado. Obrigatorio na pratica para aprovar; ' +
      'sem ele a sugestao muda de estado e fica sem credito.',
    maxLength: ASSIGNEE_NICKNAME_MAX_CHARS,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(ASSIGNEE_NICKNAME_MAX_CHARS)
  actor_nickname?: string;
}
