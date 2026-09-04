import { GUARDS_METADATA } from '@nestjs/common/constants';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { BOT_AUTH_GUARDS } from '../bot/bot-auth.decorator';
import { SuggestionsController } from './suggestions.controller';

/** Every handler this controller declares, by name. */
function handlerNames(): string[] {
  return Object.getOwnPropertyNames(SuggestionsController.prototype).filter(
    (name) => name !== 'constructor',
  );
}

function handler(name: string): object {
  const descriptor = Object.getOwnPropertyDescriptor(
    SuggestionsController.prototype,
    name,
  ) as PropertyDescriptor;
  return descriptor.value as object;
}

function guardsOf(name: string): unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, handler(name)) ??
    []) as unknown[];
}

/**
 * The bot surface, asserted at the controller rather than only over HTTP.
 *
 * The e2e suite proves the vote route refuses a foreign key and a foreign
 * source — but it needs a database, so it runs only in CI. This runs anywhere,
 * and it covers the failure that has actually happened in this repository: a
 * route added to an authenticated controller **without** the decorator, which
 * every existing test stays green for because it tests the other routes.
 *
 * It is written over the whole handler list on purpose. A test naming the
 * routes one by one has to be edited to cover a new one, which is precisely the
 * step someone adding a route in a hurry will skip.
 */
describe('SuggestionsController surface', () => {
  it('puts every route behind the bot guards, in order', () => {
    const names = handlerNames();
    // Guards against the whole assertion passing vacuously if the reflection
    // above ever stops finding handlers.
    expect(names.length).toBeGreaterThanOrEqual(6);

    for (const name of names) {
      expect([name, guardsOf(name)]).toEqual([name, [...BOT_AUTH_GUARDS]]);
    }
  });

  it('exposes the vote tally as an idempotent PUT keyed by message', () => {
    // The verb is part of the contract, not a style choice: the payload is an
    // absolute value (D2), so replaying it must be a no-op. A `POST` would
    // read as "add these votes", which is the semantics the spec rejects.
    expect(Reflect.getMetadata(METHOD_METADATA, handler('setVotes'))).toBe(
      RequestMethod.PUT,
    );
    expect(Reflect.getMetadata(PATH_METADATA, handler('setVotes'))).toBe(
      'by-message/:discordMsgId/votes',
    );
  });
});
