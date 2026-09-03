import { Test, TestingModule } from '@nestjs/testing';
import { DRIZZLE } from '../db/database.module';
import { SuggestionTextError } from './suggestion-text';
import { SuggestionsStore } from './suggestions.store';

type StubMock = jest.Mock<unknown, unknown[]>;

/**
 * Chainable stub for Drizzle's fluent builders — same pattern as
 * `tutorial.store.spec.ts`: every method returns the same object, and awaiting
 * it resolves to `result`.
 */
function chain(result: unknown) {
  const target: Record<string, StubMock> = {};
  const proxy: unknown = new Proxy(target, {
    get(_, property: string) {
      if (property === 'then') {
        return (resolve: (value: unknown) => unknown) => resolve(result);
      }
      target[property] ??= jest.fn((): unknown => proxy);
      return target[property];
    },
  });
  return { proxy: proxy as never, calls: target };
}

const POSTED_AT = new Date('2026-09-01T18:30:00.000Z');

const STORED = {
  id: 1,
  discordMsgId: '1234567890',
  author: '111111111111111111',
  text: 'Colocar mais eventos no Survival',
  votesUp: 0,
  votesDown: 0,
  status: 'enviada' as const,
  createdAt: POSTED_AT,
  updatedAt: new Date('2026-09-02T03:00:00.000Z'),
  assignee: null,
};

describe('SuggestionsStore', () => {
  let store: SuggestionsStore;
  let insert: StubMock;
  let select: StubMock;
  let insertChain: ReturnType<typeof chain>;

  async function build(
    inserted: unknown[],
    found: unknown[] = [],
  ): Promise<void> {
    insertChain = chain(inserted);
    insert = jest.fn(() => insertChain.proxy);
    select = jest.fn(() => chain(found).proxy);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SuggestionsStore,
        {
          provide: DRIZZLE,
          useValue: { insert, select },
        },
      ],
    }).compile();

    store = module.get(SuggestionsStore);
  }

  describe('create', () => {
    it('writes the sanitized text, not the raw text', async () => {
      await build([STORED]);

      await store.create({
        discordMsgId: '1234567890',
        author: '111111111111111111',
        text: '  Colocar mais​ eventos no Survival  ',
        createdAt: POSTED_AT,
      });

      const values = insertChain.calls.values.mock.calls[0][0] as {
        text: string;
      };
      expect(values.text).toBe('Colocar mais eventos no Survival');
    });

    it('writes the event date it was given, never the current time', async () => {
      await build([STORED]);

      await store.create({
        discordMsgId: '1234567890',
        author: '111111111111111111',
        text: 'ideia',
        createdAt: POSTED_AT,
      });

      const values = insertChain.calls.values.mock.calls[0][0] as {
        createdAt: Date;
      };
      expect(values.createdAt).toEqual(POSTED_AT);
    });

    it('does not send status or vote counts, leaving the DB defaults to apply', async () => {
      await build([STORED]);

      await store.create({
        discordMsgId: '1234567890',
        author: '111111111111111111',
        text: 'ideia',
        createdAt: POSTED_AT,
      });

      const values = insertChain.calls.values.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(Object.keys(values).sort()).toEqual([
        'author',
        'createdAt',
        'discordMsgId',
        'text',
      ]);
    });

    it('rejects unstorable text without touching the database', async () => {
      await build([STORED]);

      await expect(
        store.create({
          discordMsgId: '1234567890',
          author: '111111111111111111',
          text: '   ',
          createdAt: POSTED_AT,
        }),
      ).rejects.toThrow(SuggestionTextError);

      expect(insert).not.toHaveBeenCalled();
    });

    it('returns the existing row when the same Discord message is replayed', async () => {
      // `onConflictDoNothing` inserts nothing and returns nothing.
      await build([], [STORED]);

      const result = await store.create({
        discordMsgId: '1234567890',
        author: '111111111111111111',
        // A replay carrying different text must not overwrite what the
        // players who voted actually read.
        text: 'texto reescrito',
        createdAt: POSTED_AT,
      });

      expect(result).toEqual(STORED);
      expect(insertChain.calls.onConflictDoNothing).toHaveBeenCalled();
    });

    it('fails loudly when the conflicting row disappears mid-flight', async () => {
      await build([], []);

      await expect(
        store.create({
          discordMsgId: '1234567890',
          author: '111111111111111111',
          text: 'ideia',
          createdAt: POSTED_AT,
        }),
      ).rejects.toThrow('neither inserted nor found');
    });
  });

  describe('getByDiscordMsgId', () => {
    it('returns null when there is no such suggestion', async () => {
      await build([], []);
      await expect(store.getByDiscordMsgId('nope')).resolves.toBeNull();
    });

    it('returns the row when there is one', async () => {
      await build([], [STORED]);
      await expect(store.getByDiscordMsgId('1234567890')).resolves.toEqual(
        STORED,
      );
    });
  });
});
