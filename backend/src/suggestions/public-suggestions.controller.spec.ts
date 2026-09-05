import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import {
  THROTTLER_LIMIT,
  THROTTLER_TTL,
} from '@nestjs/throttler/dist/throttler.constants';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { publicReadThrottle } from '../config/throttling';
import type { Suggestion } from '../db/schema';
import { PUBLIC_SUGGESTION_STATUSES } from './dto/list-public-suggestions.dto';
import { PublicSuggestionsController } from './public-suggestions.controller';
import type { SuggestionsStore } from './suggestions.store';

const STORED: Suggestion = {
  id: 7,
  discordMsgId: '900000000000000001',
  author: '111111111111111111',
  text: 'Colocar mais eventos no Survival',
  votesUp: 12,
  votesDown: 5,
  status: 'aprovada',
  createdAt: new Date('2026-09-01T18:30:00.000Z'),
  updatedAt: new Date('2026-09-02T03:00:00.000Z'),
  assignee: '333333333333333333',
  assigneeNickname: 'Shinigami',
};

function controllerWith(store: Partial<SuggestionsStore>) {
  return new PublicSuggestionsController(store as SuggestionsStore);
}

function metadataOf(method: 'list' | 'findOne'): PropertyDescriptor {
  return Object.getOwnPropertyDescriptor(
    PublicSuggestionsController.prototype,
    method,
  ) as PropertyDescriptor;
}

describe('PublicSuggestionsController', () => {
  describe('composition', () => {
    // Both routes, not one. The listing is the route anyone thinks about; the
    // by-id route is the one that gets a decorator forgotten on it, and it
    // returns the same projection from the same table.
    for (const method of ['list', 'findOne'] as const) {
      it(`marks ${method} public to the session guard`, () => {
        expect(
          Reflect.getMetadata(
            IS_PUBLIC_KEY,
            metadataOf(method).value as object,
          ),
        ).toBe(true);
      });

      it(`rate limits ${method} with the public profile`, () => {
        // The whole control on an anonymous route. `@Throttle` alone is inert
        // metadata and `ThrottlerGuard` alone silently inherits the **ingest**
        // profile, so both are asserted: the guard is present and the profile
        // is this one's.
        //
        // Limit *and* TTL. `BOT_THROTTLE_LIMIT` is also 60, so asserting the
        // limit alone would pass with `@Throttle(botThrottle)` substituted —
        // the test would then be checking that a number did not change rather
        // than that the right profile is applied.
        const descriptor = metadataOf(method).value as object;
        const guards = Reflect.getMetadata(
          GUARDS_METADATA,
          descriptor,
        ) as unknown[];
        const limit = Reflect.getMetadata(
          `${THROTTLER_LIMIT}default`,
          descriptor,
        ) as number | undefined;
        const ttl = Reflect.getMetadata(
          `${THROTTLER_TTL}default`,
          descriptor,
        ) as number | undefined;

        expect(guards).toContain(ThrottlerGuard);
        expect(limit).toBe(publicReadThrottle.default.limit);
        expect(ttl).toBe(publicReadThrottle.default.ttl);
      });
    }
  });

  describe('list', () => {
    it('projects every row and echoes the page the store actually applied', async () => {
      // `limit`/`offset` come back from the store, not from the query: the
      // store clamps, so echoing the request would report a page size that was
      // never used — the silent wrong answer the offset clamp exists to avoid.
      const list = jest.fn().mockResolvedValue({
        items: [STORED],
        total: 137,
        limit: 20,
        offset: 40,
      });
      const controller = controllerWith({ list });

      const page = await controller.list({ limit: 999, offset: 40 });

      expect(page.total).toBe(137);
      expect(page.limit).toBe(20);
      expect(page.offset).toBe(40);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).not.toHaveProperty('author');
    });

    it('passes the filter and the sort through to the store', async () => {
      const list = jest
        .fn()
        .mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
      const controller = controllerWith({ list });

      await controller.list({ status: 'aprovada', sort: 'votes' });

      // Wrapped in an array, not passed through as a scalar: the store's filter
      // takes either, and a requested state has to narrow the publishable set
      // rather than replace the notion of one.
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ status: ['aprovada'], sort: 'votes' }),
      );
    });

    it('asks the store for only the publishable states when none is requested', async () => {
      // The criterion the first version of this controller got wrong: with no
      // `status`, it listed all five states — publishing player text that no
      // member of staff had read yet (S12.3, criterion 1).
      let received: { status?: readonly string[] } | undefined;
      const list = jest.fn((options: { status?: readonly string[] }) => {
        received = options;
        return Promise.resolve({ items: [], total: 0, limit: 20, offset: 0 });
      });
      const controller = controllerWith({
        list: list as unknown as SuggestionsStore['list'],
      });

      await controller.list({});

      expect([...(received?.status ?? [])].sort()).toEqual([
        'aprovada',
        'em_andamento',
      ]);
    });
  });

  describe('findOne', () => {
    it('projects the row rather than returning it', async () => {
      const controller = controllerWith({
        getById: jest.fn().mockResolvedValue(STORED),
      });

      const found = await controller.findOne(7);

      expect(found.id).toBe(7);
      expect(found.approved_by).toBe('Shinigami');
      expect(found).not.toHaveProperty('assignee');
      expect(found).not.toHaveProperty('discordMsgId');
    });

    it('answers 404 for an id that does not exist', async () => {
      const controller = controllerWith({
        getById: jest.fn().mockResolvedValue(null),
      });

      await expect(controller.findOne(999)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('hides a suggestion the staff has not published, with the same 404', async () => {
      // The gate the listing applies has to apply here too, or the detail route
      // becomes an oracle: walk the ids, and every 200 is a suggestion the
      // listing refuses to show.
      const getById = jest
        .fn()
        .mockResolvedValue({ ...STORED, status: 'enviada' });
      const controller = controllerWith({ getById });

      await expect(controller.findOne(7)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('refuses an id outside the int4 range without asking the database', async () => {
      // `ParseIntPipe` accepts `3000000000`; Postgres does not, and the result
      // was a 500 an anonymous caller could mint at will. The store must not be
      // reached at all — being reached is what produced the error.
      const getById = jest.fn();
      const controller = controllerWith({ getById });

      await expect(controller.findOne(3_000_000_000)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(getById).not.toHaveBeenCalled();
    });
  });

  describe('PUBLIC_SUGGESTION_STATUSES', () => {
    it('is exactly what story S12.3 asks the public page to list', () => {
      // Fixed as a value, not as a shape. Widening a public surface should
      // require editing a test that says which states are public and why.
      expect([...PUBLIC_SUGGESTION_STATUSES]).toEqual([
        'aprovada',
        'em_andamento',
      ]);
    });
  });
});
