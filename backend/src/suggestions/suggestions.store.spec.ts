import { Test, TestingModule } from '@nestjs/testing';
import { DRIZZLE } from '../db/database.module';
import { SuggestionTextError } from './suggestion-text';
import {
  SUGGESTION_PAGE_DEFAULT,
  SUGGESTION_PAGE_MAX,
  SuggestionsStore,
} from './suggestions.store';

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

describe('SuggestionsStore staff actions', () => {
  /**
   * `transition` runs inside `db.transaction`, so the stub has to hand the
   * callback something that behaves like a transaction handle. Everything the
   * method touches on it — select/for, update, insert — is recorded so the test
   * can assert on *which* statements ran, which is the only way a stub can say
   * anything about "the record was not altered".
   */
  function buildTx(current: unknown[], updated: unknown[]) {
    const selectChain = chain(current);
    const updateChain = chain(updated);
    const insertChain = chain([]);

    const tx = {
      select: jest.fn(() => selectChain.proxy),
      update: jest.fn(() => updateChain.proxy),
      insert: jest.fn(() => insertChain.proxy),
    };

    const db = {
      transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) =>
        fn(tx),
      ),
      select: jest.fn(() => selectChain.proxy),
      insert: jest.fn(() => insertChain.proxy),
    };

    return { db, tx, selectChain, updateChain, insertChain };
  }

  async function storeWith(db: unknown): Promise<SuggestionsStore> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SuggestionsStore, { provide: DRIZZLE, useValue: db }],
    }).compile();
    return module.get(SuggestionsStore);
  }

  const ACTION = {
    id: 1,
    actor: '333333333333333333',
    command: '/sugestao aprovar',
  };

  describe('transition', () => {
    it('locks the row it is about to decide against', async () => {
      // Without `FOR UPDATE` this is check-then-act, and two staff members
      // pressing at once can land `aprovada` and `recusada` on the same
      // suggestion — each legal at the instant it was checked.
      const { db, selectChain } = buildTx(
        [STORED],
        [{ ...STORED, status: 'aprovada' }],
      );
      const store = await storeWith(db);

      await store.transition({ ...ACTION, to: 'aprovada' });

      expect(selectChain.calls.for).toHaveBeenCalledWith('update');
    });

    it('updates and writes a transition audit row on a legal move', async () => {
      const moved = { ...STORED, status: 'aprovada' as const };
      const { db, tx, insertChain } = buildTx([STORED], [moved]);
      const store = await storeWith(db);

      const outcome = await store.transition({ ...ACTION, to: 'aprovada' });

      expect(outcome).toEqual({ ok: true, suggestion: moved });
      expect(tx.update).toHaveBeenCalled();
      const audit = insertChain.calls.values.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(audit).toMatchObject({
        suggestionId: 1,
        actor: ACTION.actor,
        action: 'transition',
        fromStatus: 'enviada',
        toStatus: 'aprovada',
        command: ACTION.command,
      });
      // A move that happened is not a refusal, so it carries no reason.
      expect(audit.reason).toBeUndefined();
    });

    it('refuses an illegal move WITHOUT touching the suggestion', async () => {
      // The literal wording of the acceptance criterion. `update` never being
      // called is the assertion that carries it.
      const { db, tx, insertChain } = buildTx([STORED], []);
      const store = await storeWith(db);

      const outcome = await store.transition({ ...ACTION, to: 'concluida' });

      expect(tx.update).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({
        ok: false,
        reason: 'invalid_transition',
        current: 'enviada',
      });

      const audit = insertChain.calls.values.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(audit).toMatchObject({
        action: 'transition_denied',
        fromStatus: 'enviada',
        toStatus: 'concluida',
        actor: ACTION.actor,
        command: ACTION.command,
      });
      expect(audit.reason).toEqual(expect.stringContaining('aprovada'));
    });

    it('records the refusal even though nothing changed', async () => {
      // A trail that only holds what succeeded cannot answer who has been
      // trying what — which is the reason refusals are in this table at all.
      const { db, tx } = buildTx([STORED], []);
      const store = await storeWith(db);

      await store.transition({ ...ACTION, to: 'concluida' });

      expect(tx.insert).toHaveBeenCalledTimes(1);
    });

    it('reports not_found without writing anything', async () => {
      const { db, tx } = buildTx([], []);
      const store = await storeWith(db);

      const outcome = await store.transition({ ...ACTION, to: 'aprovada' });

      expect(outcome).toEqual({ ok: false, reason: 'not_found' });
      expect(tx.insert).not.toHaveBeenCalled();
      expect(tx.update).not.toHaveBeenCalled();
    });

    it('refuses a no-op transition to the state it is already in', async () => {
      const { db, tx } = buildTx([STORED], []);
      const store = await storeWith(db);

      const outcome = await store.transition({ ...ACTION, to: 'enviada' });

      expect(outcome).toMatchObject({
        ok: false,
        reason: 'invalid_transition',
      });
      expect(tx.update).not.toHaveBeenCalled();
    });
  });

  describe('recordAuthDenied', () => {
    it('writes an auth_denied row against the current state', async () => {
      const { db, insertChain } = buildTx([{ status: 'aprovada' }], []);
      const store = await storeWith(db);

      const recorded = await store.recordAuthDenied({
        ...ACTION,
        reason: 'sem cargo de staff',
      });

      expect(recorded).toBe(true);
      expect(insertChain.calls.values.mock.calls[0][0]).toMatchObject({
        suggestionId: 1,
        actor: ACTION.actor,
        action: 'auth_denied',
        fromStatus: 'aprovada',
        command: ACTION.command,
        reason: 'sem cargo de staff',
      });
    });

    it('writes nothing when the suggestion does not exist', async () => {
      const { db, tx } = buildTx([], []);
      const store = await storeWith(db);

      await expect(
        store.recordAuthDenied({ ...ACTION, reason: 'sem cargo' }),
      ).resolves.toBe(false);
      expect(tx.insert).not.toHaveBeenCalled();
    });
  });
});

describe('SuggestionsStore.list', () => {
  function buildList(items: unknown[], total: number) {
    const rowsChain = chain(items);
    const countChain = chain([{ value: total }]);
    let call = 0;
    const db = {
      // The store fires the rows query and the count query together; the stub
      // hands back a different chain per call, in that order.
      select: jest.fn(() =>
        call++ === 0 ? rowsChain.proxy : countChain.proxy,
      ),
    };
    return { db, rowsChain, countChain };
  }

  async function storeWith(db: unknown): Promise<SuggestionsStore> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SuggestionsStore, { provide: DRIZZLE, useValue: db }],
    }).compile();
    return module.get(SuggestionsStore);
  }

  it('reports the total of the filtered set, not of the page', async () => {
    // `items.length` as the total would tell the reader the backlog is exactly
    // one page long however long it is.
    const { db } = buildList([STORED], 137);
    const store = await storeWith(db);

    const page = await store.list({ limit: 1 });

    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(137);
  });

  it('orders by date and breaks the tie by id', async () => {
    // `created_at` holds the event date, so two suggestions can share an
    // instant. Without a total order Postgres is free to break the tie
    // differently per query, and pages overlap or skip rows.
    const { db, rowsChain } = buildList([], 0);
    const store = await storeWith(db);

    await store.list({});

    expect(rowsChain.calls.orderBy.mock.calls[0]).toHaveLength(2);
  });

  it('defaults the page size instead of returning everything', async () => {
    const { db } = buildList([], 0);
    const store = await storeWith(db);

    await expect(store.list({})).resolves.toMatchObject({
      limit: SUGGESTION_PAGE_DEFAULT,
      offset: 0,
    });
  });

  it('clamps an oversized limit rather than trusting it', async () => {
    const { db } = buildList([], 0);
    const store = await storeWith(db);

    await expect(store.list({ limit: 10_000 })).resolves.toMatchObject({
      limit: SUGGESTION_PAGE_MAX,
    });
  });

  it('clamps a nonsensical limit or offset', async () => {
    const { db } = buildList([], 0);
    const store = await storeWith(db);

    await expect(store.list({ limit: 0 })).resolves.toMatchObject({ limit: 1 });
    await expect(store.list({ limit: -5 })).resolves.toMatchObject({
      limit: 1,
    });
    await expect(store.list({ offset: -20 })).resolves.toMatchObject({
      offset: 0,
    });
    await expect(store.list({ limit: 2.7 })).resolves.toMatchObject({
      limit: 2,
    });
    await expect(store.list({ limit: Number.NaN })).resolves.toMatchObject({
      limit: SUGGESTION_PAGE_DEFAULT,
    });
  });

  it('applies the same filter to the rows and to the count', async () => {
    // Two queries, one filter. If they ever disagree the listing reports a
    // total that belongs to a different set than the page it is showing.
    const { db, rowsChain, countChain } = buildList([], 0);
    const store = await storeWith(db);

    await store.list({ status: 'aprovada' });

    expect(rowsChain.calls.where).toHaveBeenCalledTimes(1);
    expect(countChain.calls.where).toHaveBeenCalledTimes(1);
    expect(rowsChain.calls.where.mock.calls[0][0]).toEqual(
      countChain.calls.where.mock.calls[0][0],
    );
  });

  it('passes an undefined filter through when no state is asked for', async () => {
    const { db, rowsChain } = buildList([], 0);
    const store = await storeWith(db);

    await store.list({});

    expect(rowsChain.calls.where.mock.calls[0][0]).toBeUndefined();
  });
});
