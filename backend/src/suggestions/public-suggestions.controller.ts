import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ParseIntPipe } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { PublicReadThrottle } from '../config/throttling';
import { ListPublicSuggestionsDto } from './dto/list-public-suggestions.dto';
import {
  PublicSuggestionDto,
  PublicSuggestionPageDto,
  toPublicSuggestion,
} from './dto/public-suggestion.dto';
import { SuggestionsStore } from './suggestions.store';

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
 * ## Public means public, and that is a decision with a name
 *
 * `@Public()` opts these routes out of the global deny-by-default session guard.
 * Every other use of it in this repository swaps session auth for something else
 * — an API key, an IP allowlist. This one does not: there is genuinely no
 * principal. What replaces authentication is the projection above (nothing
 * personal about a player leaves) and {@link PublicReadThrottle} (the cost is
 * bounded per client).
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
      'Sempre paginada e sempre com `total`. Nao devolve nenhum campo interno: ' +
      'sem autor, sem responsavel, sem id da mensagem do Discord e sem trilha ' +
      'de auditoria. O unico dado pessoal e o apelido de quem aprovou, por ' +
      'excecao explicita da §8. **O texto sai sanitizado, nao escapado** — quem ' +
      'renderiza ainda precisa escapar para a sintaxe do proprio destino.',
    // Limpa a exigencia global de sessao do documento. Sem isto o OpenAPI
    // descreve como autenticada uma rota que nao e, e o consumidor da loja sai
    // procurando um cookie que nao existe.
    security: [],
  })
  @ApiOkResponse({ type: PublicSuggestionPageDto })
  async list(
    @Query() query: ListPublicSuggestionsDto,
  ): Promise<PublicSuggestionPageDto> {
    const page = await this.store.list(query);
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
      'Mesma projecao da listagem. Id inexistente devolve **404** — e o mesmo ' +
      '404 para qualquer id, porque nao ha nada escondido a distinguir: todas ' +
      'as sugestoes sao publicas, entao "existe mas nao e sua" nao e um estado ' +
      'que esta rota possa estar.',
    security: [],
  })
  @ApiOkResponse({ type: PublicSuggestionDto })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<PublicSuggestionDto> {
    const suggestion = await this.store.getById(id);
    if (!suggestion) throw new NotFoundException();
    return toPublicSuggestion(suggestion);
  }
}
