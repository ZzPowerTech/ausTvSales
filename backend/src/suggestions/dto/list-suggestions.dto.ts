import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { SUGGESTION_STATUSES, type SuggestionStatus } from '../../db/schema';
import {
  SUGGESTION_PAGE_DEFAULT,
  SUGGESTION_PAGE_MAX,
} from '../suggestions.store';

export class ListSuggestionsDto {
  @ApiPropertyOptional({
    enum: SUGGESTION_STATUSES,
    description: 'Filtra por estado. Ausente, devolve todos.',
  })
  @IsOptional()
  @IsIn(SUGGESTION_STATUSES as readonly string[])
  status?: SuggestionStatus;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: SUGGESTION_PAGE_MAX,
    default: SUGGESTION_PAGE_DEFAULT,
    description:
      'Tamanho da pagina. O teto e o do Discord para componentes numa mensagem, ' +
      'que e o unico consumidor hoje.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SUGGESTION_PAGE_MAX)
  limit?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    default: 0,
    description: 'Quantas linhas pular. Paginacao por offset, nao por cursor.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  // `@IsInt()` e `Number.isInteger`, e `Number.isInteger(1e21)` e **true** — um
  // float em notacao exponencial atravessava a validacao inteira. Daqui ele
  // chegava ao Postgres como `1e+21` (`invalid input syntax for type bigint`,
  // 500 numa rota que promete 400) ou, sendo `NaN`, fazia o drizzle omitir o
  // `OFFSET` e devolver a primeira pagina reportando um offset que nao aplicou.
  @Max(Number.MAX_SAFE_INTEGER)
  offset?: number;
}
