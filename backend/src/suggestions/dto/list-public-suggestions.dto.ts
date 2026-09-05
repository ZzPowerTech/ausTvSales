import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { SUGGESTION_STATUSES, type SuggestionStatus } from '../../db/schema';
import {
  SUGGESTION_PAGE_MAX,
  SUGGESTION_SORTS,
  type SuggestionSort,
} from '../suggestions.store';

/**
 * Page size the public listing uses when the caller does not choose one.
 *
 * Larger than the bot's default of 5, and for a reason that is not taste: five
 * is what fits a Discord embed, and a web list that showed five rows would make
 * the reader page through a backlog one screenful at a time. The **ceiling**
 * stays the store's, so the difference is a default and not a second policy.
 */
export const PUBLIC_SUGGESTION_PAGE_DEFAULT = 20;

/**
 * Query parameters of the public listing (story S11.1, criterion 1).
 *
 * ## Pagination is mandatory, and that is enforced by there being no way off it
 *
 * There is no `all` flag and no way to raise the ceiling: `limit` is capped by
 * {@link SUGGESTION_PAGE_MAX} here and clamped again in the store. The story
 * asks for "pagina obrigatoriamente" and this is what makes it a property of the
 * route rather than of the caller's manners — an anonymous consumer that asks
 * for the whole table gets a page, not a table scan.
 */
export class ListPublicSuggestionsDto {
  @ApiPropertyOptional({
    enum: SUGGESTION_STATUSES,
    description:
      'Filtra por estado. Ausente, devolve todos os estados — o canal de ' +
      'sugestoes do Discord ja e publico, entao o estado de uma sugestao nao e ' +
      'segredo; esconder um deles aqui seria inventar politica que ninguem pediu.',
  })
  @IsOptional()
  @IsIn(SUGGESTION_STATUSES as readonly string[])
  status?: SuggestionStatus;

  @ApiPropertyOptional({
    enum: SUGGESTION_SORTS,
    default: 'recent',
    description:
      '`recent` = mais novas primeiro (data do evento). `votes` = maior saldo ' +
      '`votes_up - votes_down` primeiro. Conjunto fechado: `orderBy` livre numa ' +
      'rota publica vaza nome de coluna e convida a ordenar por algo sem indice.',
  })
  @IsOptional()
  @IsIn(SUGGESTION_SORTS as readonly string[])
  sort?: SuggestionSort;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: SUGGESTION_PAGE_MAX,
    default: PUBLIC_SUGGESTION_PAGE_DEFAULT,
    description: 'Tamanho da pagina. O teto e do servidor e nao negociavel.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SUGGESTION_PAGE_MAX)
  limit?: number = PUBLIC_SUGGESTION_PAGE_DEFAULT;

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
  // Mesmo teto do `ListSuggestionsDto`, pela mesma razao medida na S10.3:
  // `@IsInt()` e `Number.isInteger`, e `Number.isInteger(1e21)` e **true**.
  @Max(Number.MAX_SAFE_INTEGER)
  offset?: number;
}
