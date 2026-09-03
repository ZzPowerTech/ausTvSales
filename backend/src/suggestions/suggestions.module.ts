import { Module } from '@nestjs/common';
import { SuggestionsStore } from './suggestions.store';

/**
 * Player suggestions (spec §5.3 / §7, story S10.1).
 *
 * ## No controller yet, and that is the story boundary
 *
 * S10.1 is the table and its write contract: the schema, the sanitizer, and the
 * single insert that applies it. The HTTP surface — filtering, pagination,
 * public reads that hide `assignee` and the audit fields, staff writes behind a
 * JWT scope — is story S11.1, and putting a route here now would ship a public
 * read of a table nobody has decided the visibility rules for.
 *
 * The module is registered in `AppModule` regardless, so the store is one
 * injection away for S10.2 and S11.1 rather than a file waiting to be wired.
 */
@Module({
  providers: [SuggestionsStore],
  exports: [SuggestionsStore],
})
export class SuggestionsModule {}
