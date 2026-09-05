import type { Suggestion } from '../../db/schema';
import { toPublicSuggestion } from './public-suggestion.dto';

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

describe('toPublicSuggestion', () => {
  it('publishes exactly this set of fields and nothing else', () => {
    // The assertion that carries the criterion. Checking that `author` is
    // absent proves today's leak is closed; checking the **whole key set**
    // proves tomorrow's is too, because a column added to `suggestions` and
    // spread through by a well-meaning edit fails here instead of appearing on
    // a public page. It is the same failure the class doc names, and it needs a
    // test that fails on *addition*, not only on removal.
    expect(Object.keys(toPublicSuggestion(STORED)).sort()).toEqual([
      'approved_by',
      'created_at',
      'id',
      'score',
      'status',
      'text',
      'votes_down',
      'votes_up',
    ]);
  });

  it('keeps the player and the internal ids out of the response', () => {
    const published = JSON.stringify(toPublicSuggestion(STORED));

    // By value, not by key: a rename that kept the data would pass a key check.
    expect(published).not.toContain(STORED.author);
    expect(published).not.toContain(STORED.assignee);
    expect(published).not.toContain(STORED.discordMsgId);
  });

  it('publishes the approver nickname, which is the §8 exception', () => {
    // The one piece of personal data that goes out, by a decision the owner
    // recorded on 2026-09-03. Asserted rather than assumed so that removing it
    // is also a deliberate act.
    expect(toPublicSuggestion(STORED).approved_by).toBe('Shinigami');
  });

  it('reports no approver as null rather than as an empty string', () => {
    const pending = toPublicSuggestion({
      ...STORED,
      status: 'enviada',
      assignee: null,
      assigneeNickname: null,
    });

    expect(pending.approved_by).toBeNull();
  });

  it('computes the score the votes sort ranks by', () => {
    // Same arithmetic as `suggestionScore` in the store. If the two drift, the
    // page shows a number that does not explain the order it is printed in.
    expect(toPublicSuggestion(STORED).score).toBe(7);
  });

  it('serializes the event date, not the write date', () => {
    // `created_at` is when the player posted; `updated_at` moves on every vote.
    // Publishing the latter as a date would be a plausible wrong number, which
    // is the failure mode this table's schema doc exists to prevent.
    expect(toPublicSuggestion(STORED).created_at).toBe(
      '2026-09-01T18:30:00.000Z',
    );
  });
});
