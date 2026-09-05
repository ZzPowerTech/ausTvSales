import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import type { SuggestionStatus } from '../../db/schema';
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
 * The only states that reach an anonymous reader.
 *
 * ## This is written down elsewhere, and the first draft of this file got it wrong
 *
 * Story S12.3, criterion 1 — the sole planned consumer of this route — says
 * *"Lista `aprovada` e `em_andamento`, paginada, pública sob rate limit"*. The
 * first version of this DTO defaulted to **all five** states and defended it in
 * a comment saying that hiding one would be "inventing policy nobody asked
 * for". Somebody had asked, in writing, one story away.
 *
 * ## Why the rule is right independently of who wrote it down
 *
 * A suggestion in `enviada` has been read by nobody. Publishing it takes text a
 * player typed and republishes it on the server's own domain, indexable, with
 * no human step in between — a phishing link, a named accusation, somebody's
 * address. The write-time sanitizer removes control characters; it has no
 * opinion about meaning. §8 keeps personal data off public surfaces, and the
 * 2026-09-03 exception is explicit about its scope: *"staff que aprova, apelido
 * apenas, nada sobre jogador"*. Content is the door that projection does not
 * close.
 *
 * `recusada` is worse in one way: it is terminal with no re-open, so a
 * suggestion the staff rejected would stay published forever.
 *
 * ## What this deliberately leaves out
 *
 * `concluida` — a suggestion that shipped — is arguably the most worth showing
 * of all, and it is **not** here because S12.3 names two states and this is not
 * the story that gets to widen a public surface. Adding it is one entry in this
 * array and an owner's decision.
 */
export const PUBLIC_SUGGESTION_STATUSES = [
  'aprovada',
  'em_andamento',
] as const satisfies readonly SuggestionStatus[];

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
    enum: PUBLIC_SUGGESTION_STATUSES,
    description:
      'Filtra dentro do conjunto publicavel. Ausente, devolve os dois estados ' +
      'de `PUBLIC_SUGGESTION_STATUSES`. Pedir um estado fora dele e **400**, ' +
      'nao uma lista vazia: "esse estado nao e publico" e uma resposta ' +
      'diferente de "nao ha nenhuma assim".',
  })
  @IsOptional()
  @IsIn(PUBLIC_SUGGESTION_STATUSES)
  status?: (typeof PUBLIC_SUGGESTION_STATUSES)[number];

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
