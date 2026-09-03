import { UnprocessableEntityException } from '@nestjs/common';
import type { SuggestionTextError } from './suggestion-text';

/**
 * A suggestion whose text cannot be stored.
 *
 * `422` and not `400`: the payload is well-formed and passed validation — it is
 * the *content* that the sanitizer refuses. The distinction matters to the
 * caller, because a `400` means "the bot sent a bad request" (a bug to fix) and
 * a `422` means "the player wrote something we cannot keep" (a message to show
 * the player).
 *
 * `reason` travels in the body so the bot can choose that message. Without it
 * the bot would have to parse prose to tell "too long" from "empty", and the two
 * need different replies: one asks the player to shorten, the other says nothing
 * was written.
 *
 * The offending text is **not** echoed back. It is player-controlled content on
 * an error path, and error bodies end up in logs.
 */
export class UnprocessableSuggestionTextException extends UnprocessableEntityException {
  constructor(error: SuggestionTextError) {
    super({
      message: error.message,
      reason: error.reason,
    });
  }
}
