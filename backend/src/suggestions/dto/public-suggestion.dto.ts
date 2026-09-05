import { ApiProperty } from '@nestjs/swagger';
import { SUGGESTION_STATUSES, type Suggestion } from '../../db/schema';
import type { SuggestionStatus } from '../../db/schema';

/**
 * A suggestion as the public web sees it (story S11.1, criterion 2).
 *
 * ## This is a projection, not a serialization
 *
 * The class exists so that "public" is decided **by listing what goes out**
 * rather than by remembering to strip fields on the way. The issue asks for the
 * two reads to be separated *from the contract*, and the failure it is guarding
 * against is the ordinary one: a column added to `suggestions` next year appears
 * on a public page because a shared DTO passed the row through.
 *
 * {@link toPublicSuggestion} is the only way to build one, and it names every
 * field explicitly. A new column is invisible here until somebody adds it on
 * purpose.
 *
 * ## What is deliberately absent, and why each one
 *
 * - **`author`** — the player's Discord id. §8 allows an identifier *internally*;
 *   it does not put one on a public page. The exception the owner opened on
 *   2026-09-03 covers the approver's nickname and says so in as many words:
 *   "staff who approve, nickname only, nothing about players".
 * - **`assignee`** — the approver's Discord id. The exception publishes the
 *   *name*, which is what credits a person; the id is the internal key and
 *   publishing it would map staff members to accounts for anyone reading.
 * - **`discord_msg_id`** — a deep link to the source message, which displays the
 *   author. Publishing it re-derives the very field two lines above removed, by
 *   a route this API does not control.
 * - **the audit trail** — who tried what, including refusals. Internal by
 *   construction; it has its own route, behind auth.
 * - **`updated_at`** — the column moves on every vote (see the note on
 *   `setVotesByDiscordMsgId`), so publishing it as "last updated" would put a
 *   plausible wrong date on the page. Nobody outside needs the write time.
 */
export class PublicSuggestionDto {
  @ApiProperty({ description: 'Identificador estavel da sugestao.' })
  id!: number;

  @ApiProperty({
    description:
      'Texto escrito pelo jogador, **ja sanitizado na escrita** (controles, ' +
      'invisiveis e bidi removidos). O consumidor AINDA precisa escapar na ' +
      'renderizacao: sanitizar nao sabe a sintaxe do destino (HTML, Markdown do ' +
      'Discord, terminal) e escapar nao desfaz um caractere de controle ja ' +
      'gravado. Sao camadas contra falhas diferentes, nao redundancia (§8).',
  })
  text!: string;

  @ApiProperty({ enum: SUGGESTION_STATUSES })
  status!: SuggestionStatus;

  @ApiProperty({ description: 'Reacoes positivas no card do Discord.' })
  votes_up!: number;

  @ApiProperty({ description: 'Reacoes negativas no card do Discord.' })
  votes_down!: number;

  @ApiProperty({
    description:
      'Saldo `votes_up - votes_down`, que e por onde `sort=votes` ordena. ' +
      'Publicado junto para que a ordem da lista seja verificavel por quem a le, ' +
      'em vez de precisar ser deduzida das duas contagens.',
  })
  score!: number;

  @ApiProperty({
    description:
      'Quando o jogador postou a sugestao — a data do evento, nunca a da ' +
      'gravacao. Em UTC: quem renderiza converte para America/Sao_Paulo.',
  })
  created_at!: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Apelido no Discord de quem aprovou, congelado no momento da aprovacao. ' +
      'E o unico dado pessoal desta resposta, por **excecao explicita** aberta ' +
      'pelo dono em 2026-09-03 (§8) para que a loja credite quem aceitou. ' +
      '`null` enquanto ninguem aprovou. Tambem sanitizado na escrita, e tambem ' +
      'precisa ser escapado na renderizacao.',
  })
  approved_by!: string | null;
}

/**
 * Project one stored suggestion onto the public contract.
 *
 * Field-by-field on purpose — see the class doc. The one computed value is
 * `score`, which mirrors `suggestionScore` in the store so that the number the
 * page shows is the number the ordering used.
 */
export function toPublicSuggestion(row: Suggestion): PublicSuggestionDto {
  return {
    id: row.id,
    text: row.text,
    status: row.status,
    votes_up: row.votesUp,
    votes_down: row.votesDown,
    score: row.votesUp - row.votesDown,
    created_at: row.createdAt.toISOString(),
    approved_by: row.assigneeNickname ?? null,
  };
}

/** One page of the public listing. */
export class PublicSuggestionPageDto {
  @ApiProperty({ type: [PublicSuggestionDto] })
  items!: PublicSuggestionDto[];

  @ApiProperty({
    description:
      'Tamanho do conjunto filtrado inteiro, nao o da pagina. Sem ele um ' +
      'consumidor nao consegue nem desenhar a paginacao nem saber que ela acabou.',
  })
  total!: number;

  @ApiProperty({ description: 'Tamanho da pagina efetivamente aplicado.' })
  limit!: number;

  @ApiProperty({ description: 'Deslocamento efetivamente aplicado.' })
  offset!: number;
}
