import { SUGGESTION_STATUSES, type SuggestionStatus } from '../db/schema';
import {
  ALLOWED_TRANSITIONS,
  canTransition,
  describeRefusal,
} from './suggestion-transitions';

/**
 * The full 5×5 grid, written out.
 *
 * Deriving the expectation from `ALLOWED_TRANSITIONS` would make this test
 * assert that the table equals itself. Every pair is spelled here so that
 * changing the machine forces someone to change this file and say why.
 */
const EXPECTED: Record<SuggestionStatus, readonly SuggestionStatus[]> = {
  enviada: ['aprovada', 'recusada'],
  aprovada: ['em_andamento', 'recusada'],
  em_andamento: ['concluida', 'recusada'],
  concluida: [],
  recusada: [],
};

describe('suggestion transitions', () => {
  describe('canTransition', () => {
    for (const from of SUGGESTION_STATUSES) {
      for (const to of SUGGESTION_STATUSES) {
        const allowed = EXPECTED[from].includes(to);
        it(`${allowed ? 'allows' : 'refuses'} ${from} -> ${to}`, () => {
          expect(canTransition(from, to)).toBe(allowed);
        });
      }
    }
  });

  it('refuses every self-transition', () => {
    // Re-applying the current state is the shape of a double-clicked button.
    // It must not count as a change, or the audit trail fills with events that
    // did not happen.
    for (const status of SUGGESTION_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('never allows going backwards along the happy path', () => {
    const chain: SuggestionStatus[] = [
      'enviada',
      'aprovada',
      'em_andamento',
      'concluida',
    ];
    for (let i = 1; i < chain.length; i++) {
      expect(canTransition(chain[i], chain[i - 1])).toBe(false);
    }
  });

  it('lets staff refuse a suggestion from any open state', () => {
    // The deliberate reading of §5.3: refusal is the way out of the flow, not a
    // step that requires approving first. Most refusals happen on sight.
    expect(canTransition('enviada', 'recusada')).toBe(true);
    expect(canTransition('aprovada', 'recusada')).toBe(true);
    expect(canTransition('em_andamento', 'recusada')).toBe(true);
  });

  it('treats both endings as terminal', () => {
    for (const terminal of ['concluida', 'recusada'] as const) {
      expect(ALLOWED_TRANSITIONS[terminal]).toHaveLength(0);
    }
    // And nothing else is terminal — otherwise a suggestion could get stuck in
    // a state nobody meant to be an ending.
    for (const open of ['enviada', 'aprovada', 'em_andamento'] as const) {
      expect(ALLOWED_TRANSITIONS[open].length).toBeGreaterThan(0);
    }
  });

  it('covers all five states of the spec, with no extras', () => {
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual(
      [...SUGGESTION_STATUSES].sort(),
    );
  });

  describe('describeRefusal', () => {
    it('names what is allowed instead of only saying no', () => {
      expect(describeRefusal('enviada', 'concluida')).toContain('aprovada');
      expect(describeRefusal('enviada', 'concluida')).toContain('recusada');
    });

    it('says a terminal state is terminal', () => {
      expect(describeRefusal('concluida', 'aprovada')).toContain('final');
    });
  });
});
