import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { SUGGESTION_STATUSES, type SuggestionStatus } from '../../db/schema';

/**
 * A staff member moving one suggestion, from the dashboard (story S11.1).
 *
 * ## One field, and the absences are the design
 *
 * `TransitionSuggestionDto` — the bot's — carries `actor`, `command` and
 * `actor_nickname`. None of them is here, and each is missing for its own
 * reason:
 *
 * - **`actor`** comes from the session. The bot has to send it because the bot
 *   acts on behalf of whoever pressed the button; a dashboard request *is* the
 *   person. Accepting it in the body would let any staff member write somebody
 *   else's id into the audit trail and into the shop's credit line — a
 *   signed confession with a forged signature. With `forbidNonWhitelisted`
 *   already on, sending it is a **400**, so the attempt is refused rather than
 *   ignored.
 * - **`command`** is not the caller's to name either: it is where the action
 *   came from, and from here it always came from the same place.
 * - **`actor_nickname`** is derived from the session too — see the note on the
 *   controller about *which* name the dashboard can credit, because it is not
 *   the same name the bot sends.
 */
export class AdminTransitionSuggestionDto {
  @ApiProperty({
    enum: SUGGESTION_STATUSES,
    description:
      'Estado desejado. Transicao invalida devolve 409 e NAO altera o ' +
      'registro — a tentativa entra na trilha como `transition_denied`.',
  })
  @IsIn(SUGGESTION_STATUSES as readonly string[])
  to!: SuggestionStatus;
}
