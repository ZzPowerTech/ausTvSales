import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601, IsNotEmpty, IsString, Matches } from 'class-validator';
import { SUGGESTION_TEXT_MAX_CHARS } from '../../db/schema';
import { DISCORD_SNOWFLAKE, DISCORD_SNOWFLAKE_MESSAGE } from './discord-id';

export class CreateSuggestionDto {
  @ApiProperty({
    description:
      'Id da mensagem do Discord de onde a sugestao veio. Chave natural: um ' +
      'reenvio da mesma mensagem devolve a sugestao ja gravada em vez de criar ' +
      'outra.',
  })
  @Matches(DISCORD_SNOWFLAKE, {
    message: `discord_msg_id ${DISCORD_SNOWFLAKE_MESSAGE}`,
  })
  discord_msg_id!: string;

  @ApiProperty({ description: 'Id do autor no Discord. Nunca o nome exibido.' })
  @Matches(DISCORD_SNOWFLAKE, {
    message: `author ${DISCORD_SNOWFLAKE_MESSAGE}`,
  })
  author!: string;

  @ApiProperty({
    description:
      'Texto do jogador, cru. E sanitizado aqui — o chamador nao deve pre-limpar, ' +
      `e acima de ${SUGGESTION_TEXT_MAX_CHARS} caracteres a sugestao e recusada, ` +
      'nunca truncada.',
  })
  @IsString()
  @IsNotEmpty()
  text!: string;

  @ApiProperty({
    description:
      'Quando o jogador postou. NAO e a hora do insert: um bot que reprocessa ' +
      'depois de cair precisa gravar a data do evento.',
    example: '2026-09-01T18:30:00.000Z',
  })
  @IsISO8601()
  created_at!: string;
}
