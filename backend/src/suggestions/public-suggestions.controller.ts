import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { PublicReadThrottle } from '../config/throttling';
import {
  ListPublicSuggestionsDto,
  PUBLIC_SUGGESTION_STATUSES,
} from './dto/list-public-suggestions.dto';
import {
  PublicSuggestionDto,
  PublicSuggestionPageDto,
  toPublicSuggestion,
} from './dto/public-suggestion.dto';
import { SuggestionsStore } from './suggestions.store';

/**
 * Largest value the `suggestions.id` column can hold.
 *
 * `ParseIntPipe` accepts any run of digits, so `3000000000` reaches drizzle,
 * reaches Postgres, and comes back as `value out of range for type integer` — a
 * **500 on an anonymous route**, obtainable at will. Not a leak (there is no
 * exception filter putting stack traces in the body) but a 5xx anybody can mint
 * at 60 a minute is a false health signal and log noise on demand.
 *
 * Answered with the route's ordinary 404: an id the column cannot hold is an id
 * that identifies nothing, which is exactly what 404 says.
 */
const MAX_SUGGESTION_ID = 2_147_483_647;

/**
 * The anonymous read surface for suggestions (story S11.1).
 *
 * ## A second controller, not a second branch
 *
 * `SuggestionsController` keeps the bot's routes and returns whole rows. This
 * one is a separate class, on a separate path prefix, returning a separate DTO —
 * and the separation is the deliverable, not a stylistic choice. The issue asks
 * to "separar leitura publica de leitura administrativa **desde o contrato**",
 * because the alternative — one handler that hides fields when the caller is
 * anonymous — puts the visibility rule inside a conditional, where the default
 * on a future edit is "show it".
 *
 * Here, publishing a new column takes an edit to {@link toPublicSuggestion}.
 * There is no path by which a row reaches this response without passing through
 * the projection.
 *
 * ## Two gates, and they answer different questions
 *
 * The projection decides **which columns** are public. `PUBLIC_SUGGESTION_STATUSES`
 * decides **which rows** are. The second is not a refinement of the first: a
 * projection cannot help with a phishing link inside `text`, because that is
 * content and not a column. Both routes below apply it — the listing by
 * filtering, the detail route by refusing — since a gate the listing enforces
 * and the detail route does not is not a gate.
 *
 * ## Public means public, and that is a decision with a name
 *
 * `@Public()` opts these routes out of the global deny-by-default session guard.
 * Every other use of it in this repository swaps session auth for something else
 * — an API key, an IP allowlist. This one does not: there is genuinely no
 * principal. What replaces authentication is the projection (nothing personal
 * about a player leaves), the state gate (nothing the staff has not read leaves)
 * and {@link PublicReadThrottle} (the cost is bounded per client).
 *
 * ## Sanitized on write, escaped on render — both, and this end owns only one
 *
 * `text` and `approved_by` were cleaned when they were written (§8, and the
 * `sanitizeSuggestionText` / `sanitizeNickname` pair). This API does **not**
 * escape them, because it cannot: escaping needs to know the target syntax, and
 * the same string is heading for a web page, a Discord embed and whatever the
 * shop renders with. The contract says so in the field descriptions rather than
 * leaving the consumer to assume — an assumption that already produced a real
 * bug in this house, in the `Ticket-Bot`, with player text interpolated raw.
 */
@ApiTags('suggestions')
@Controller('public/suggestions')
export class PublicSuggestionsController {
  constructor(private readonly store: SuggestionsStore) {}

  @Get()
  @Public()
  @PublicReadThrottle()
  @ApiOperation({
    summary: 'Lista publica de sugestoes, filtrada, ordenada e paginada',
    description:
      'Devolve apenas sugestoes `aprovada` e `em_andamento` — o que a staff ja ' +
      'leu (S12.3, criterio 1). Sempre paginada e sempre com `total`. Nao ' +
      'devolve nenhum campo interno: sem autor, sem responsavel, sem id da ' +
      'mensagem do Discord e sem trilha de auditoria. O unico dado pessoal e o ' +
      'apelido de quem aprovou, por excecao explicita da §8. **O texto sai ' +
      'sanitizado, nao escapado** — quem renderiza ainda precisa escapar para a ' +
      'sintaxe do proprio destino.',
    // Limpa a exigencia global de sessao do documento. Sem isto o OpenAPI
    // descreve como autenticada uma rota que nao e, e o consumidor da loja sai
    // procurando um cookie que nao existe.
    security: [],
  })
  @ApiOkResponse({ type: PublicSuggestionPageDto })
  async list(
    @Query() query: ListPublicSuggestionsDto,
  ): Promise<PublicSuggestionPageDto> {
    const page = await this.store.list({
      ...query,
      // One requested state, or the whole publishable set. The DTO has already
      // refused anything outside it, so this cannot widen the surface — it can
      // only narrow it.
      status: query.status ? [query.status] : PUBLIC_SUGGESTION_STATUSES,
    });

    return {
      items: page.items.map(toPublicSuggestion),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    };
  }

  @Get(':id')
  @Public()
  @PublicReadThrottle()
  @ApiOperation({
    summary: 'Uma sugestao pelo id, na projecao publica',
    description:
      'Mesma projecao e o mesmo conjunto de estados da listagem. Id ' +
      'inexistente **ou fora do conjunto publicavel** devolve o mesmo **404**, ' +
      'de proposito: um 404 distinguivel para "existe, mas a staff ainda nao ' +
      'leu" faria desta rota um oraculo que confirma a existencia das sugestoes ' +
      'que a listagem esconde.',
    security: [],
  })
  @ApiOkResponse({ type: PublicSuggestionDto })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<PublicSuggestionDto> {
    if (id < 1 || id > MAX_SUGGESTION_ID) throw new NotFoundException();

    const suggestion = await this.store.getById(id);
    if (!suggestion || !isPublishable(suggestion.status)) {
      throw new NotFoundException();
    }
    return toPublicSuggestion(suggestion);
  }
}

/** Whether a stored state is one an anonymous reader may see. */
function isPublishable(status: string): boolean {
  return (PUBLIC_SUGGESTION_STATUSES as readonly string[]).includes(status);
}
