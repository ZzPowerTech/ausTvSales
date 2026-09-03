import { Module } from '@nestjs/common';
import { BotModule } from '../bot/bot.module';
import { SuggestionsController } from './suggestions.controller';
import { SuggestionsStore } from './suggestions.store';

/**
 * Player suggestions (spec §5.3 / §7, stories S10.1 and S10.2).
 *
 * S10.1 built the table and its write contract — the schema, the sanitizer and
 * the single insert that applies it. S10.2 adds the state machine, the audit
 * trail, and the bot-facing surface that drives both.
 *
 * ## Still nothing public
 *
 * Every route is behind `@BotAuth()`. Filtering, pagination, and reads that hide
 * `assignee` and the audit fields from anonymous callers are story S11.1 — that
 * is where the visibility rules get decided, and shipping a public read before
 * then would decide them by accident.
 */
@Module({
  imports: [BotModule],
  controllers: [SuggestionsController],
  providers: [SuggestionsStore],
  exports: [SuggestionsStore],
})
export class SuggestionsModule {}
