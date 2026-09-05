import { ConflictException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { StaffScopeGuard } from '../auth/staff-scope.guard';
import type { AuthUser } from '../auth/auth.types';
import type { Suggestion } from '../db/schema';
import {
  DASHBOARD_AUDIT_COMMAND,
  SuggestionsAdminController,
} from './suggestions-admin.controller';
import type { SuggestionsStore } from './suggestions.store';

const OPERATOR: AuthUser = {
  discordId: '111111111111111111',
  username: 'Murilo',
  avatar: null,
};

const STORED: Suggestion = {
  id: 7,
  discordMsgId: '900000000000000001',
  author: '222222222222222222',
  text: 'Colocar mais eventos no Survival',
  votesUp: 0,
  votesDown: 0,
  status: 'enviada',
  createdAt: new Date('2026-09-01T18:30:00.000Z'),
  updatedAt: new Date('2026-09-02T03:00:00.000Z'),
  assignee: null,
  assigneeNickname: null,
};

function controllerWith(store: Partial<SuggestionsStore>) {
  return new SuggestionsAdminController(store as SuggestionsStore);
}

function guardsOn(method: keyof SuggestionsAdminController): unknown[] {
  const descriptor = Object.getOwnPropertyDescriptor(
    SuggestionsAdminController.prototype,
    method,
  ) as PropertyDescriptor;
  return (Reflect.getMetadata(GUARDS_METADATA, descriptor.value as object) ??
    []) as unknown[];
}

describe('SuggestionsAdminController', () => {
  describe('composition', () => {
    it('puts the staff scope on the write route', () => {
      expect(guardsOn('transition')).toContain(StaffScopeGuard);
    });

    it('rate limits the write route as well as scoping it', () => {
      // A mutating route reachable with a leaked session cookie, at whatever
      // speed the network allows, is the failure `@StaffOnly()` bundles the two
      // decorators to make unrepresentable.
      expect(guardsOn('transition')).toContain(ThrottlerGuard);
    });

    it('does not require the staff scope to read', () => {
      // Deliberate, and asserted so it stays deliberate: reading changes
      // nothing, and everybody with a session already passed the login
      // allowlist. If this ever needs to narrow, it should narrow on purpose.
      for (const method of ['list', 'findOne', 'audit'] as const) {
        expect(guardsOn(method)).not.toContain(StaffScopeGuard);
        expect(guardsOn(method)).toContain(ThrottlerGuard);
      }
    });
  });

  describe('transition', () => {
    it('takes the actor from the session and never from the body', async () => {
      // The property this route exists to have: a staff member cannot write
      // somebody else's id into the audit trail, or into the credit line the
      // shop publishes.
      const transition = jest
        .fn()
        .mockResolvedValue({ ok: true, suggestion: STORED });
      const controller = controllerWith({ transition });

      await controller.transition(7, { to: 'aprovada' }, OPERATOR);

      expect(transition).toHaveBeenCalledWith({
        id: 7,
        to: 'aprovada',
        actor: OPERATOR.discordId,
        command: DASHBOARD_AUDIT_COMMAND,
        actorNickname: OPERATOR.username,
      });
    });

    it('sends the name on every move, letting the store decide when to freeze it', async () => {
      // Deciding here which transitions deserve a name would be a second copy
      // of the store's rule, and two copies of a rule are one rule and one bug
      // waiting.
      const transition = jest
        .fn()
        .mockResolvedValue({ ok: true, suggestion: STORED });
      const controller = controllerWith({ transition });

      await controller.transition(7, { to: 'em_andamento' }, OPERATOR);

      expect(transition).toHaveBeenCalledWith(
        expect.objectContaining({ actorNickname: OPERATOR.username }),
      );
    });

    it('turns a refused transition into 409, carrying the current state', async () => {
      const transition = jest.fn().mockResolvedValue({
        ok: false,
        reason: 'invalid_transition',
        current: 'concluida',
        message: 'uma sugestao concluida nao muda mais de estado',
      });
      const controller = controllerWith({ transition });

      await expect(
        controller.transition(7, { to: 'aprovada' }, OPERATOR),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('turns a missing suggestion into 404', async () => {
      const transition = jest
        .fn()
        .mockResolvedValue({ ok: false, reason: 'not_found' });
      const controller = controllerWith({ transition });

      await expect(
        controller.transition(999, { to: 'aprovada' }, OPERATOR),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('reads', () => {
    it('returns the whole row, internal fields included', async () => {
      // The opposite of the public controller, on purpose: this is where
      // `author` and `assignee` are supposed to be visible.
      const controller = controllerWith({
        getById: jest.fn().mockResolvedValue(STORED),
      });

      const found = await controller.findOne(7);

      expect(found.author).toBe(STORED.author);
      expect(found.discordMsgId).toBe(STORED.discordMsgId);
    });

    it('lists every state, including the ones the public route hides', async () => {
      const list = jest
        .fn()
        .mockResolvedValue({ items: [STORED], total: 1, limit: 5, offset: 0 });
      const controller = controllerWith({ list });

      const page = await controller.list({});

      expect(page.items[0].status).toBe('enviada');
      // No status forced in: moderation needs to see what has not been read.
      expect(list).toHaveBeenCalledWith({});
    });

    it('answers 404 for an audit trail of a suggestion that does not exist', async () => {
      const auditFor = jest.fn();
      const controller = controllerWith({
        getById: jest.fn().mockResolvedValue(null),
        auditFor,
      });

      await expect(controller.audit(999)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      // Not merely the status code: an empty trail and a missing suggestion
      // would otherwise look identical to the caller.
      expect(auditFor).not.toHaveBeenCalled();
    });
  });
});
