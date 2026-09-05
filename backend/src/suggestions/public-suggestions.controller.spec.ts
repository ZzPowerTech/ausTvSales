import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { THROTTLER_LIMIT } from '@nestjs/throttler/dist/throttler.constants';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { PUBLIC_READ_THROTTLE_LIMIT } from '../config/throttling';
import type { Suggestion } from '../db/schema';
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
        // profile, so both are asserted: the guard is present and the limit is
        // this profile's, not another's.
        const descriptor = metadataOf(method).value as object;
        const guards = Reflect.getMetadata(
          GUARDS_METADATA,
          descriptor,
        ) as unknown[];
        const limit = Reflect.getMetadata(
          `${THROTTLER_LIMIT}default`,
          descriptor,
        ) as number | undefined;

        expect(guards).toContain(ThrottlerGuard);
        expect(limit).toBe(PUBLIC_READ_THROTTLE_LIMIT);
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

      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'aprovada', sort: 'votes' }),
      );
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
  });
});
