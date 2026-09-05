import {
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { StaffOnly } from '../auth/staff-scope.guard';
import type { AuthUser } from '../auth/auth.types';
import { DashboardThrottle } from '../config/throttling';
import type { Suggestion, SuggestionAuditEntry } from '../db/schema';
import { AdminTransitionSuggestionDto } from './dto/admin-transition-suggestion.dto';
import { ListSuggestionsDto } from './dto/list-suggestions.dto';
import { SuggestionTextError } from './suggestion-text';
import { type SuggestionPage, SuggestionsStore } from './suggestions.store';
import { UnprocessableSuggestionTextException } from './unprocessable-suggestion-text.exception';

/**
 * How a dashboard action is labelled in the audit trail.
 *
 * The column means "where the action came from", and the bot fills it with a
 * slash command or a component id. There is exactly one origin here, so it is a
 * constant rather than something the caller may name — a caller-supplied origin
 * on the one route that also identifies the caller would let a staff member
 * write their own history.
 */
export const DASHBOARD_AUDIT_COMMAND = 'dashboard:status';

/**
 * The staff-authenticated surface for suggestions (story S11.1, criterion 3).
 *
 * ## Three surfaces, and the split is the deliverable
 *
 * `SuggestionsController` is the **bot** (API key + IP allowlist).
 * `PublicSuggestionsController` is **anybody** (no principal, narrow projection,
 * two states). This one is a **person with a dashboard session who is also
 * staff** — and it is where internal fields live: `assignee`, the whole row, the
 * audit trail.
 *
 * Keeping them apart from the contract is what the issue asks for. The
 * alternative, one controller widening its response for privileged callers, puts
 * the visibility rule inside a conditional whose default on the next edit is
 * "show it".
 *
 * ## Identity comes from the session, never from the body
 *
 * The DTO has one field. `actor`, `command` and the nickname are all derived
 * here, and `forbidNonWhitelisted` turns an attempt to send them into a 400
 * rather than into a silent drop. The property this buys is narrow and worth
 * naming: **a staff member cannot write somebody else's name into the audit
 * trail, or into the credit line the shop publishes.**
 *
 * That is also the honest answer to the DoD's IDOR item. There is no
 * per-resource ownership to check — every staff member may act on every
 * suggestion, by design — so the resource dimension of IDOR does not exist here.
 * What does exist is the *actor* dimension, and it is closed by the actor not
 * being an input.
 *
 * ## ⚠️ The credited name is not the same name the bot sends
 *
 * `assignee_nickname` is documented as the approver's Discord **server
 * nickname**, snapshotted at approval, and the bot can read it because the bot
 * holds a Discord token. This API does not (the S10.2 decision), and the session
 * carries the Discord **username** instead.
 *
 * So an approval made from the dashboard credits the username, and one made
 * from the bot credits the server nickname. Both are "the name that person went
 * by at that moment", both are frozen, and both are sanitized on write — but
 * they are not the same field of the same profile, and a reader comparing two
 * rows cannot tell which is which. Recorded here rather than smoothed over:
 * narrowing it means either giving this API a Discord token or adding a
 * provenance column, and neither is this story's to decide.
 */
@ApiTags('suggestions')
@Controller('admin/suggestions')
export class SuggestionsAdminController {
  constructor(private readonly store: SuggestionsStore) {}

  @Get()
  @DashboardThrottle()
  @ApiOperation({
    summary: 'Lista administrativa — a linha inteira, sem projecao',
    description:
      'Diferente de `GET /public/suggestions` em duas coisas, e as duas ' +
      'importam: devolve **todos** os estados (inclusive `enviada`, que e o que ' +
      'a staff precisa ver para moderar) e devolve os campos internos — autor, ' +
      'responsavel, id da mensagem. Exige sessao; **nao** exige escopo de staff, ' +
      'porque ler nao muda nada e quem entra no dashboard ja passou pelo ' +
      'allowlist.',
  })
  async list(@Query() query: ListSuggestionsDto): Promise<SuggestionPage> {
    return this.store.list(query);
  }

  @Get(':id')
  @DashboardThrottle()
  @ApiOperation({ summary: 'Uma sugestao pelo id, linha inteira' })
  async findOne(@Param('id', ParseIntPipe) id: number): Promise<Suggestion> {
    const suggestion = await this.store.getById(id);
    if (!suggestion) throw new NotFoundException();
    return suggestion;
  }

  @Get(':id/audit')
  @DashboardThrottle()
  @ApiOperation({
    summary: 'Trilha de auditoria da sugestao, mais recente primeiro',
    description:
      'Inclui as tentativas recusadas — pelo bot (`auth_denied`) e pela ' +
      'maquina de estados (`transition_denied`). Uma trilha que so guarda o que ' +
      'deu certo nao responde quem andou tentando o que.',
  })
  async audit(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<SuggestionAuditEntry[]> {
    const suggestion = await this.store.getById(id);
    if (!suggestion) throw new NotFoundException();
    return this.store.auditFor(id);
  }

  @Patch(':id/status')
  @StaffOnly()
  @ApiOperation({
    summary: 'Move a sugestao de estado, como o operador autenticado',
    description:
      'O ator e o dono da sessao — **nao** um campo do corpo, que so tem `to`. ' +
      'Mandar `actor` devolve 400. Transicao invalida devolve 409 e o registro ' +
      'nao muda; a tentativa entra na trilha como `transition_denied`. Aprovar ' +
      'congela o nome de quem aprovou, e este caminho congela o **username do ' +
      'Discord** (esta API nao tem token para ler o apelido do servidor, que e o ' +
      'que o bot manda) — ver o doc da classe.',
  })
  @ApiOkResponse({ description: 'A sugestao no novo estado.' })
  async transition(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AdminTransitionSuggestionDto,
    @CurrentUser() user: AuthUser,
  ): Promise<Suggestion> {
    let outcome;
    try {
      outcome = await this.store.transition({
        id,
        to: dto.to,
        actor: user.discordId,
        command: DASHBOARD_AUDIT_COMMAND,
        // Sent on every transition, not only on approval: the store writes it
        // only when the target is `aprovada`, and deciding *here* which moves
        // deserve a name would be a second copy of that rule.
        actorNickname: user.username,
      });
    } catch (error) {
      // A Discord username that sanitizes to nothing cannot be stored, and that
      // is a 422 about the content rather than a 500 about the service —
      // the same mapping the bot's route makes, and for the same reason.
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
}
