import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { BotAuth } from '../bot/bot-auth.decorator';
import type { Suggestion, SuggestionAuditEntry } from '../db/schema';
import { CreateSuggestionDto } from './dto/create-suggestion.dto';
import { ListSuggestionsDto } from './dto/list-suggestions.dto';
import { DeniedAttemptDto } from './dto/denied-attempt.dto';
import { TransitionSuggestionDto } from './dto/transition-suggestion.dto';
import { SuggestionTextError } from './suggestion-text';
import { type SuggestionPage, SuggestionsStore } from './suggestions.store';
import { UnprocessableSuggestionTextException } from './unprocessable-suggestion-text.exception';

/**
 * The bot→API surface for player suggestions (story S10.2).
 *
 * ## Where "verified server-side" actually happens, and why it is split
 *
 * The staff-role check runs in the **bot**: Discord roles exist only there, and
 * this process cannot see them. What runs here is everything the bot could
 * otherwise be talked into skipping — the state machine, the audit trail, and
 * the authentication of the bot itself as a principal.
 *
 * That split is the honest reading of the requirement. "Server-side" in story
 * S10.2 means "not by hiding a button": the `Ticket-Bot`'s `/configuracoes`
 * responders are protected by nothing but the message being ephemeral, so the
 * protection is positional and evaporates the day someone makes it public. Here
 * the bot checks the role before acting *and* reports the refusals it makes, so
 * the two halves of the decision are both written down.
 *
 * ## Public reads are not here
 *
 * There is no list route and nothing anonymous. Filtering, pagination and
 * hiding internal fields from public readers is story S11.1, which is where the
 * visibility rules get decided. Everything below is behind `@BotAuth()`.
 */
@ApiTags('suggestions')
@Controller('suggestions')
export class SuggestionsController {
  constructor(private readonly store: SuggestionsStore) {}

  @Post()
  @BotAuth()
  @ApiOperation({
    summary: 'Registra uma sugestao nova',
    description:
      'Idempotente por `discord_msg_id`: reenviar a mesma mensagem devolve a ' +
      'sugestao ja gravada, com o texto original preservado.',
  })
  async create(@Body() dto: CreateSuggestionDto): Promise<Suggestion> {
    try {
      return await this.store.create({
        discordMsgId: dto.discord_msg_id,
        author: dto.author,
        text: dto.text,
        createdAt: new Date(dto.created_at),
      });
    } catch (error) {
      // 422, not 400: the payload is well-formed, it is the content that cannot
      // be stored. The bot turns `reason` into the message the player reads, so
      // "too long" and "empty" have to stay distinguishable.
      if (error instanceof SuggestionTextError) {
        throw new UnprocessableSuggestionTextException(error);
      }
      throw error;
    }
  }

  @Get()
  @BotAuth()
  @ApiOperation({
    summary: 'Lista sugestoes, filtradas por estado e paginadas',
    description:
      'Sempre paginada e sempre com `total` — que e o tamanho do conjunto ' +
      'filtrado inteiro, nao o da pagina. Ordenada por data e, em empate, por ' +
      'id: `created_at` guarda a data do evento, entao duas sugestoes podem ' +
      'compartilhar o instante, e uma ordem nao-total faz paginas se ' +
      'sobreporem ou pularem linhas.',
  })
  async list(@Query() query: ListSuggestionsDto): Promise<SuggestionPage> {
    return this.store.list(query);
  }

  @Get(':id')
  @BotAuth()
  @ApiOperation({ summary: 'Uma sugestao pelo id' })
  async findOne(@Param('id', ParseIntPipe) id: number): Promise<Suggestion> {
    const suggestion = await this.store.getById(id);
    if (!suggestion) throw new NotFoundException();
    return suggestion;
  }

  @Patch(':id/status')
  @BotAuth()
  @ApiOperation({
    summary: 'Move a sugestao de estado',
    description:
      'Transicao invalida devolve **409** e o registro nao muda — a tentativa ' +
      'entra na trilha de auditoria como `transition_denied`.',
  })
  async transition(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: TransitionSuggestionDto,
  ): Promise<Suggestion> {
    let outcome;
    try {
      outcome = await this.store.transition({
        id,
        to: dto.to,
        actor: dto.actor,
        command: dto.command,
        actorNickname: dto.actor_nickname,
      });
    } catch (error) {
      // Same mapping as `create`, and it was missing here: approving freezes a
      // nickname, so this route sanitizes player-controlled text too. Without
      // the branch a name that is blank once cleaned came back as a **500**,
      // which tells the bot "the service broke" when the truth is "that name
      // cannot be stored".
      if (error instanceof SuggestionTextError) {
        throw new UnprocessableSuggestionTextException(error);
      }
      throw error;
    }

    if (outcome.ok) return outcome.suggestion;
    if (outcome.reason === 'not_found') throw new NotFoundException();

    throw new ConflictException({
      message: outcome.message,
      current: outcome.current,
      requested: dto.to,
    });
  }

  @Post(':id/denied-attempts')
  @BotAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Registra uma tentativa que o BOT recusou',
    description:
      'O cargo de staff e verificado no bot, porque so ele enxerga os cargos da ' +
      'guild. Sem esta rota a recusa existiria apenas num log do processo do ' +
      'bot, e o requisito da S10.2 e que ela seja consultavel.',
  })
  async recordDenied(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DeniedAttemptDto,
  ): Promise<void> {
    const recorded = await this.store.recordAuthDenied({
      id,
      actor: dto.actor,
      command: dto.command,
      reason: dto.reason,
    });
    if (!recorded) throw new NotFoundException();
  }

  @Get(':id/audit')
  @BotAuth()
  @ApiOperation({
    summary: 'Trilha de auditoria da sugestao, mais recente primeiro',
    description:
      'Inclui as tentativas recusadas. Uma trilha que so guarda o que deu certo ' +
      'nao responde quem andou tentando o que.',
  })
  async audit(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<SuggestionAuditEntry[]> {
    const suggestion = await this.store.getById(id);
    if (!suggestion) throw new NotFoundException();
    return this.store.auditFor(id);
  }
}
