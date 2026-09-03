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
    default: 0,
    description: 'Quantas linhas pular. Paginacao por offset, nao por cursor.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
