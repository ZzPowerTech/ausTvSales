import { Module } from '@nestjs/common';
import { BotModule } from '../bot/bot.module';
import { ThrottlingModule } from '../config/throttling';
import { PublicSuggestionsController } from './public-suggestions.controller';
import { SuggestionsController } from './suggestions.controller';
import { SuggestionsStore } from './suggestions.store';

/**
 * Player suggestions (spec §5.3 / §7, stories S10.1 and S10.2).
 *
 * S10.1 built the table and its write contract — the schema, the sanitizer and
 * the single insert that applies it. S10.2 adds the state machine, the audit
 * trail, and the bot-facing surface that drives both.
 *
 * ## S11.1 opened the first anonymous surface in this module
 *
 * {@link PublicSuggestionsController} serves reads with no principal at all,
 * behind a projection that names every published field and a rate limit that
 * bounds the cost. It is a **separate controller on a separate prefix** rather
 * than a flag on the existing one, so "what the public sees" is a list somebody
 * has to edit on purpose. The bot's routes are untouched and still return whole
 * rows behind `@BotAuth()`.
 *
 * `ThrottlingModule` is imported for it. Strictly redundant — `BotModule`
 * already pulls it in transitively and `ThrottlerModule` is `@Global()` — and
 * kept anyway, because a route whose only protection is a rate limit should not
 * depend on an unrelated module continuing to import the thing that provides it.
 */
@Module({
  imports: [BotModule, ThrottlingModule],
  controllers: [SuggestionsController, PublicSuggestionsController],
  providers: [SuggestionsStore],
  exports: [SuggestionsStore],
})
export class SuggestionsModule {}
